import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";
import { Effect, Fiber } from "effect";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadGatewayModule() {
  const temporary = await mkdtemp(path.join(repoRoot, ".grok-gateway-attachment-stream-"));
  const output = path.join(temporary, "gateway.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/cli/gateway.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    packages: "external",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

const runtimeConfig = (url, values = {}) => ({
  url,
  timeoutMs: 2_000,
  output: "json",
  fullAvatars: false,
  allowInsecureRemote: false,
  ...values,
});

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function closeServer(server) {
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function collectStrings(iterable) {
  const chunks = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

test("attachment base64 encoding carries one and two bytes across arbitrary chunks", async () => {
  const loaded = await loadGatewayModule();
  try {
    const bytes = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    async function* chunks() {
      yield bytes.subarray(0, 1);
      yield bytes.subarray(1, 3);
      yield bytes.subarray(3, 7);
      yield bytes.subarray(7);
    }
    const encoded = await collectStrings(loaded.module.encodeAttachmentBase64Chunks(
      chunks(),
      bytes.byteLength,
      bytes.byteLength,
    ));
    assert.deepEqual(encoded, ["AAEC", "AwQF", "BgcI", "CQ=="]);
    assert.equal(encoded.join(""), bytes.toString("base64"));

    await assert.rejects(
      collectStrings(loaded.module.encodeAttachmentBase64Chunks(chunks(), bytes.byteLength - 1, bytes.byteLength)),
      /changed while it was being uploaded/,
    );
    await assert.rejects(
      collectStrings(loaded.module.encodeAttachmentBase64Chunks(chunks(), bytes.byteLength, bytes.byteLength - 1)),
      /exceeds its 9-byte limit while streaming/,
    );
  } finally {
    await loaded.dispose();
  }
});

test("streamed attachment upload sends exact canonical JSON across file chunk boundaries", async () => {
  const loaded = await loadGatewayModule();
  const temporary = await mkdtemp(path.join(repoRoot, ".grok-stream-upload-wire-"));
  let server;
  try {
    const bytes = Buffer.alloc(loaded.module.ATTACHMENT_UPLOAD_READ_CHUNK_BYTES + 11);
    for (let index = 0; index < bytes.byteLength; index += 1) bytes[index] = index % 251;
    const filePath = path.join(temporary, "source.bin");
    await writeFile(filePath, bytes);
    const filename = "report-\"🌍\".bin";
    const agentId = "agent-one";
    let upload;
    server = createServer(async (request, response) => {
      if (request.method === "POST" && request.url === "/api/listGatewayServices") {
        assert.equal((await requestBody(request)).toString("utf8"), "{}");
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ protocolVersion: 1, capabilities: [], methods: ["listGatewayServices", "uploadAttachment"] }));
        return;
      }
      if (request.method === "POST" && request.url === "/api/uploadAttachment") {
        const body = await requestBody(request);
        upload = { body, headers: request.headers };
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"path":"/host/attachment.bin"}');
        return;
      }
      response.writeHead(404);
      response.end();
    });
    const url = await listen(server);
    const gateway = loaded.module.makeGatewayService(runtimeConfig(url, {
      token: "stream-token",
      requestId: "upload-request",
    }));
    const result = await Effect.runPromise(gateway.uploadAttachmentFile({ filePath, filename, agentId }));

    assert.deepEqual(result, { path: "/host/attachment.bin" });
    const expected = JSON.stringify({ filename, bytesBase64: bytes.toString("base64"), agentId });
    assert.equal(upload.body.toString("utf8"), expected);
    assert.equal(upload.headers.authorization, "Bearer stream-token");
    assert.equal(upload.headers["content-type"], "application/json");
    assert.equal(upload.headers["content-length"], String(Buffer.byteLength(expected)));
    assert.equal(upload.headers["x-sand-request-id"], "upload-request");
  } finally {
    if (server != null) await closeServer(server);
    await rm(temporary, { recursive: true, force: true });
    await loaded.dispose();
  }
});

test("attachment upload preflight rejects empty, non-file, and oversized sources before discovery", async () => {
  const loaded = await loadGatewayModule();
  const temporary = await mkdtemp(path.join(repoRoot, ".grok-stream-upload-preflight-"));
  let server;
  try {
    const empty = path.join(temporary, "empty.txt");
    const directory = path.join(temporary, "directory");
    const oversizedFile = path.join(temporary, "oversized.txt");
    const oversizedVideo = path.join(temporary, "oversized.mp4");
    await writeFile(empty, "");
    await mkdir(directory);
    await writeFile(oversizedFile, "x");
    await truncate(oversizedFile, 25 * 1024 * 1024 + 1);
    await writeFile(oversizedVideo, "x");
    await truncate(oversizedVideo, 200 * 1024 * 1024 + 1);

    let requests = 0;
    server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(500);
      response.end();
    });
    const url = await listen(server);
    const gateway = loaded.module.makeGatewayService(runtimeConfig(url));
    for (const [filePath, filename, pattern] of [
      [empty, "empty.txt", /non-empty regular file/],
      [directory, "directory", /non-empty regular file/],
      [oversizedFile, "large.txt", /26214400-byte limit/],
      [oversizedVideo, "large.mp4", /209715200-byte limit/],
    ]) {
      const result = await Effect.runPromise(
        gateway.uploadAttachmentFile({ filePath, filename }).pipe(Effect.either),
      );
      assert.equal(result._tag, "Left");
      assert.equal(result.left.code, "INVALID_INPUT");
      assert.match(result.left.message, pattern);
    }
    assert.equal(requests, 0);
  } finally {
    if (server != null) await closeServer(server);
    await rm(temporary, { recursive: true, force: true });
    await loaded.dispose();
  }
});

test("streamed attachment upload honors the live service allowlist", async () => {
  const loaded = await loadGatewayModule();
  const temporary = await mkdtemp(path.join(repoRoot, ".grok-stream-upload-allowlist-"));
  let server;
  try {
    const filePath = path.join(temporary, "payload.txt");
    await writeFile(filePath, "payload");
    let uploadCalls = 0;
    server = createServer(async (request, response) => {
      if (request.url === "/api/listGatewayServices") {
        await requestBody(request);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ protocolVersion: 1, capabilities: [], methods: ["listGatewayServices"] }));
        return;
      }
      if (request.url === "/api/uploadAttachment") uploadCalls += 1;
      response.writeHead(404);
      response.end();
    });
    const url = await listen(server);
    const gateway = loaded.module.makeGatewayService(runtimeConfig(url));
    const result = await Effect.runPromise(
      gateway.uploadAttachmentFile({ filePath, filename: "payload.txt" }).pipe(Effect.either),
    );
    assert.equal(result._tag, "Left");
    assert.equal(result.left.code, "UNKNOWN_SERVICE");
    assert.equal(uploadCalls, 0);
  } finally {
    if (server != null) await closeServer(server);
    await rm(temporary, { recursive: true, force: true });
    await loaded.dispose();
  }
});

test("attachment upload timeout and fiber interruption stop a backpressured request", async () => {
  const loaded = await loadGatewayModule();
  const temporary = await mkdtemp(path.join(repoRoot, ".grok-stream-upload-cancel-"));
  let server;
  try {
    const filePath = path.join(temporary, "payload.mp4");
    await writeFile(filePath, "x");
    await truncate(filePath, 200 * 1024 * 1024);
    let uploadCount = 0;
    let closedCount = 0;
    server = createServer(async (request, response) => {
      if (request.url === "/api/listGatewayServices") {
        await requestBody(request);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ protocolVersion: 1, capabilities: [], methods: ["listGatewayServices", "uploadAttachment"] }));
        return;
      }
      if (request.url === "/api/uploadAttachment") {
        uploadCount += 1;
        let observedClose = false;
        const markClosed = () => {
          if (!observedClose) {
            observedClose = true;
            closedCount += 1;
          }
        };
        request.once("aborted", markClosed);
        request.once("close", () => {
          if (!request.complete) markClosed();
        });
        request.socket.once("close", markClosed);
        request.on("data", () => {
          request.pause();
          const resume = setTimeout(() => request.resume(), 25);
          resume.unref();
        });
        return;
      }
      response.writeHead(404);
      response.end();
    });
    const url = await listen(server);

    const timed = loaded.module.makeGatewayService(runtimeConfig(url, { timeoutMs: 75 }));
    const timedResult = await Effect.runPromise(
      timed.uploadAttachmentFile({ filePath, filename: "payload.mp4" }).pipe(Effect.either),
    );
    assert.equal(timedResult._tag, "Left");
    assert.equal(timedResult.left.code, "GATEWAY_TIMEOUT");
    assert.equal(await waitFor(() => closedCount >= 1), true);

    const interruptible = loaded.module.makeGatewayService(runtimeConfig(url, { timeoutMs: 30_000 }));
    const fiber = Effect.runFork(interruptible.uploadAttachmentFile({ filePath, filename: "payload.mp4" }));
    assert.equal(await waitFor(() => uploadCount >= 2), true);
    await Effect.runPromise(Fiber.interrupt(fiber));
    assert.equal(await waitFor(() => closedCount >= 2), true);
  } finally {
    if (server != null) await closeServer(server);
    await rm(temporary, { recursive: true, force: true });
    await loaded.dispose();
  }
});

test("streamed attachment error responses are bounded and cancelled", async () => {
  const loaded = await loadGatewayModule();
  const temporary = await mkdtemp(path.join(repoRoot, ".grok-stream-upload-error-"));
  let server;
  try {
    const filePath = path.join(temporary, "payload.txt");
    await writeFile(filePath, "payload");
    let errorBodyClosed = false;
    server = createServer(async (request, response) => {
      if (request.url === "/api/listGatewayServices") {
        await requestBody(request);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ protocolVersion: 1, capabilities: [], methods: ["listGatewayServices", "uploadAttachment"] }));
        return;
      }
      if (request.url === "/api/uploadAttachment") {
        await requestBody(request);
        response.writeHead(413, { "content-type": "text/plain" });
        response.write(Buffer.alloc(64 * 1024 + 1, 120));
        const interval = setInterval(() => response.write("x"), 10);
        response.once("close", () => {
          errorBodyClosed = true;
          clearInterval(interval);
        });
        return;
      }
      response.writeHead(404);
      response.end();
    });
    const url = await listen(server);
    const gateway = loaded.module.makeGatewayService(runtimeConfig(url));
    const result = await Effect.runPromise(
      gateway.uploadAttachmentFile({ filePath, filename: "payload.txt" }).pipe(Effect.either),
    );
    assert.equal(result._tag, "Left");
    assert.equal(result.left.code, "GATEWAY_PROTOCOL");
    assert.equal(await waitFor(() => errorBodyClosed), true);
  } finally {
    if (server != null) await closeServer(server);
    await rm(temporary, { recursive: true, force: true });
    await loaded.dispose();
  }
});
