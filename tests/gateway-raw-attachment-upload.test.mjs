import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";
import { Effect } from "effect";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uploadPath = "/api/uploadAttachmentStream";
const filenameHeader = "x-sand-attachment-filename";
const agentHeader = "x-sand-attachment-agent-id";

async function loadModules() {
  const temporary = await mkdtemp(path.join(repoRoot, ".grok-raw-attachment-modules-"));
  const entries = {
    server: path.join(repoRoot, "source/host/gateway-server.ts"),
    attachments: path.join(repoRoot, "source/host/extensions/attachments/attachments-service.ts"),
    gateway: path.join(repoRoot, "source/cli/gateway.ts"),
  };
  await build({
    entryPoints: entries,
    outdir: temporary,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    packages: "external",
  });
  const nonce = Date.now();
  const [server, attachments, gateway] = await Promise.all([
    import(`${pathToFileURL(path.join(temporary, "server.js")).href}?${nonce}`),
    import(`${pathToFileURL(path.join(temporary, "attachments.js")).href}?${nonce}`),
    import(`${pathToFileURL(path.join(temporary, "gateway.js")).href}?${nonce}`),
  ]);
  return { server, attachments, gateway, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

async function waitFor(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  return await predicate();
}

async function temporaryUploads(directory) {
  try { return (await readdir(directory)).filter(name => name.startsWith(".upload-") && name.endsWith(".tmp")); }
  catch { return []; }
}

function rawRequest(baseUrl, { filename, agentId = "agent-one", length, contentType = "application/octet-stream" }, body) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${baseUrl}${uploadPath}`, {
      method: "POST",
      agent: false,
      headers: {
        authorization: "Bearer raw-token",
        "content-type": contentType,
        "content-length": String(length),
        [filenameHeader]: encodeURIComponent(filename),
        [agentHeader]: encodeURIComponent(agentId),
      },
    }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    if (body !== undefined) request.end(body);
    else request.end();
  });
}

function requestWithHeaders(baseUrl, headers, body) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${baseUrl}${uploadPath}`, { method: "POST", agent: false, headers }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end(body);
  });
}

function startHeldUpload(baseUrl, filename, length, agentId = "agent-one") {
  const request = httpRequest(`${baseUrl}${uploadPath}`, {
    method: "POST",
    agent: false,
    headers: {
      authorization: "Bearer raw-token",
      "content-type": "application/octet-stream",
      "content-length": String(length),
      [filenameHeader]: encodeURIComponent(filename),
      [agentHeader]: encodeURIComponent(agentId),
    },
  }, response => response.resume());
  request.on("error", () => {});
  request.write(Buffer.from([1]));
  return request;
}

test("raw attachment capability streams exactly, bounds concurrency, and cleans every temp", async t => {
  const loaded = await loadModules();
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-raw-attachment-"));
  const previousDataRoot = process.env.SAND_DATA_ROOT;
  process.env.SAND_DATA_ROOT = path.join(temporary, "sand");
  const attachmentService = loaded.attachments.createAttachmentsService({ auth: {}, ctx: {}, box: {} });
  const api = {
    getAgentAvatar: async () => ({ dataUrl: null, version: null }),
    uploadAttachmentStream: args => attachmentService.uploadStream(args),
  };
  let server;
  try {
    server = await loaded.server.startGatewayServer({
      api,
      authToken: "raw-token",
      subscribe: () => () => {},
      getHealth: () => ({ isBusy: false, activeAgentId: null, lastBusyAtMs: 0 }),
      startedAt: Date.now(),
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const attachmentsRoot = path.join(process.env.SAND_DATA_ROOT, "agents", "agent-one", "attachments");

    await t.test("CLI selects raw transport and persists exact 0600 content", async () => {
      const bytes = Buffer.alloc(loaded.gateway.ATTACHMENT_UPLOAD_READ_CHUNK_BYTES * 2 + 7);
      for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
      const source = path.join(temporary, "source.bin");
      await writeFile(source, bytes);
      const gateway = loaded.gateway.makeGatewayService({
        url: baseUrl,
        token: "raw-token",
        timeoutMs: 3_000,
        output: "json",
        fullAvatars: false,
        allowInsecureRemote: false,
      });
      const result = await Effect.runPromise(gateway.uploadAttachmentFile({
        filePath: source,
        filename: "report-🌍.bin",
        agentId: "agent-one",
      }));
      const digest = createHash("sha256").update(bytes).digest("hex");
      assert.equal(result.path, path.join(attachmentsRoot, `${digest}.bin`));
      assert.deepEqual(await readFile(result.path), bytes);
      assert.equal((await stat(result.path)).mode & 0o777, 0o600);
      assert.deepEqual(await temporaryUploads(attachmentsRoot), []);
      assert.equal(loaded.server.MAX_BODY_BYTES, 64 * 1024 * 1024);
    });

    await t.test("declared normal and video oversize fail before a temp is opened", async () => {
      assert.equal((await rawRequest(baseUrl, { filename: "large.txt", length: 25 * 1024 * 1024 + 1 })).status, 413);
      assert.equal((await rawRequest(baseUrl, { filename: "large.mp4", length: 200 * 1024 * 1024 + 1 })).status, 413);
      assert.deepEqual(await temporaryUploads(attachmentsRoot), []);
    });

    await t.test("route requires authentication, raw media type, and one exact content length", async () => {
      const metadata = {
        [filenameHeader]: encodeURIComponent("strict.bin"),
        [agentHeader]: encodeURIComponent("agent-one"),
      };
      assert.equal((await requestWithHeaders(baseUrl, {
        ...metadata,
        "content-type": "application/octet-stream",
        "content-length": "1",
      }, Buffer.from([1]))).status, 401);
      assert.equal((await requestWithHeaders(baseUrl, {
        ...metadata,
        authorization: "Bearer raw-token",
        "content-type": "text/plain",
        "content-length": "1",
      }, Buffer.from([1]))).status, 400);
      assert.equal((await requestWithHeaders(baseUrl, {
        ...metadata,
        authorization: "Bearer raw-token",
        "content-type": "application/octet-stream",
      })).status, 400);
      assert.deepEqual(await temporaryUploads(attachmentsRoot), []);
    });

    await t.test("short streams and disconnected requests remove descriptor temps", async () => {
      await assert.rejects(
        attachmentService.uploadStream({
          filename: "short.bin",
          agentId: "agent-one",
          expectedBytes: 2,
          chunks: (async function* () { yield Buffer.from([1]); })(),
        }),
        /ended before its declared content length/,
      );
      assert.deepEqual(await temporaryUploads(attachmentsRoot), []);

      const held = startHeldUpload(baseUrl, "cancel.bin", 1024 * 1024);
      assert.equal(await waitFor(async () => (await temporaryUploads(attachmentsRoot)).length === 1), true);
      held.destroy();
      assert.equal(await waitFor(async () => (await temporaryUploads(attachmentsRoot)).length === 0), true);
    });

    await t.test("only two streams are active and the third receives 429", async () => {
      const first = startHeldUpload(baseUrl, "first.bin", 1024 * 1024);
      const second = startHeldUpload(baseUrl, "second.bin", 1024 * 1024);
      assert.equal(await waitFor(async () => (await temporaryUploads(attachmentsRoot)).length === 2), true);
      const rejected = await rawRequest(baseUrl, { filename: "third.bin", length: 1 }, Buffer.from([3]));
      assert.equal(rejected.status, 429);
      assert.equal((await temporaryUploads(attachmentsRoot)).length, 2);
      first.destroy();
      second.destroy();
      assert.equal(await waitFor(async () => (await temporaryUploads(attachmentsRoot)).length === 0), true);
    });

    await t.test("an existing symlink is never overwritten during atomic finalize", async () => {
      const agentRoot = path.join(process.env.SAND_DATA_ROOT, "agents", "agent-link");
      const targetRoot = path.join(agentRoot, "attachments");
      await mkdir(targetRoot, { recursive: true });
      const bytes = Buffer.from("do not overwrite a symlink target");
      const digest = createHash("sha256").update(bytes).digest("hex");
      const external = path.join(temporary, "external-secret");
      await writeFile(external, "unchanged");
      const collision = path.join(targetRoot, `${digest}.bin`);
      await symlink(external, collision);
      const response = await rawRequest(baseUrl, {
        filename: "collision.bin",
        agentId: "agent-link",
        length: bytes.length,
      }, bytes);
      assert.equal(response.status, 400);
      assert.equal((await lstat(collision)).isSymbolicLink(), true);
      assert.equal((await readFile(external, "utf8")), "unchanged");
      assert.deepEqual(await temporaryUploads(targetRoot), []);
    });

    await t.test("a symlinked agent directory cannot redirect streamed writes", async () => {
      const agentsRoot = path.join(process.env.SAND_DATA_ROOT, "agents");
      const externalAgent = path.join(temporary, "external-agent");
      const externalAttachments = path.join(externalAgent, "attachments");
      await mkdir(externalAttachments, { recursive: true });
      await symlink(externalAgent, path.join(agentsRoot, "agent-escape"), "dir");
      const response = await rawRequest(baseUrl, {
        filename: "escape.bin",
        agentId: "agent-escape",
        length: 3,
      }, Buffer.from([1, 2, 3]));
      assert.equal(response.status, 400);
      assert.deepEqual(await readdir(externalAttachments), []);
    });
  } finally {
    if (server != null) await server.close();
    if (previousDataRoot === undefined) delete process.env.SAND_DATA_ROOT;
    else process.env.SAND_DATA_ROOT = previousDataRoot;
    await Promise.all([loaded.dispose(), rm(temporary, { recursive: true, force: true })]);
  }
});
