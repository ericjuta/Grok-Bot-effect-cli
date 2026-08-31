import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { createServer } from "node:http";
import { mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";
import { Effect, Fiber, Stream } from "effect";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadGatewayModule() {
  const temporary = await mkdtemp(path.join(repoRoot, ".grok-gateway-bounds-"));
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

function byteStream(...chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(Buffer.from(chunk));
      controller.close();
    },
  });
}

async function collect(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}

const runtimeConfig = (values = {}) => ({
  timeoutMs: 2_000,
  output: "json",
  fullAvatars: false,
  allowInsecureRemote: false,
  ...values,
});

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

async function makeFifo(filePath) {
  await new Promise((resolve, reject) => {
    execFile("mkfifo", [filePath], (error) => error == null ? resolve() : reject(error));
  });
}

async function resolveWithBlockedFifoRescue(effect, fifoPath) {
  let rescue = Promise.resolve();
  const rescueTimer = setTimeout(() => {
    rescue = open(fifoPath, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK)
      .then(async (handle) => {
        try { await handle.writeFile("{}"); }
        finally { await handle.close(); }
      })
      .catch(() => undefined);
  }, 1_500);
  const started = performance.now();
  try {
    const result = await Effect.runPromise(effect);
    return { result, elapsedMs: performance.now() - started };
  } finally {
    clearTimeout(rescueTimer);
    await rescue;
  }
}

test("SSE framing enforces UTF-8 byte bounds before parsing terminated and final events", async () => {
  const loaded = await loadGatewayModule();
  try {
    const exact = 'data: {"channel":"ok","payload":"🌍"}';
    const maximum = Buffer.byteLength(exact);
    const parsed = await collect(loaded.module.parseEventBody(
      byteStream(Buffer.from(exact), Buffer.from("\r"), Buffer.from("\n\r\n")),
      maximum,
    ));
    assert.deepEqual(parsed, [{ channel: "ok", payload: "🌍" }]);

    await assert.rejects(
      collect(loaded.module.parseEventBody(byteStream(`${exact}x\n\n`), maximum)),
      new RegExp(`exceeds ${maximum} bytes`),
    );
    await assert.rejects(
      collect(loaded.module.parseEventBody(byteStream(`${exact}x`), maximum)),
      new RegExp(`exceeds ${maximum} bytes`),
    );
  } finally {
    await loaded.dispose();
  }
});

test("idle SSE subscriptions retain only lazy initial buffers and release the aggregate budget", async () => {
  const loaded = await loadGatewayModule();
  const iterators = [];
  try {
    for (let index = 0; index < 32; index += 1) {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.from(`data: {"channel":"idle","payload":${index}}\n\n`));
        },
      });
      const iterator = loaded.module.parseEventBody(body);
      iterators.push(iterator);
      assert.deepEqual(await iterator.next(), { done: false, value: { channel: "idle", payload: index } });
    }
    assert.equal(
      loaded.module.getActiveSseBufferBytes(),
      32 * loaded.module.INITIAL_SSE_BUFFER_BYTES,
    );
    assert.ok(loaded.module.getActiveSseBufferBytes() < loaded.module.MAX_ACTIVE_SSE_BUFFER_BYTES);
  } finally {
    await Promise.all(iterators.map(iterator => iterator.return()));
    assert.equal(loaded.module.getActiveSseBufferBytes(), 0);
    await loaded.dispose();
  }
});

test("parked parsed events remain charged to the shared SSE buffer budget", async () => {
  const loaded = await loadGatewayModule();
  const iterators = [];
  try {
    const payload = "x".repeat(1024 * 1024);
    for (let index = 0; index < 4; index += 1) {
      const frame = `data: ${JSON.stringify({ channel: "large", payload })}\n\n`;
      const iterator = loaded.module.parseEventBody(byteStream(frame));
      iterators.push(iterator);
      const result = await iterator.next();
      assert.equal(result.done, false);
      assert.equal(result.value.channel, "large");
      assert.equal(result.value.payload.length, payload.length);
    }
    // Each frame crossed 1 MiB, so geometric growth reached a 2 MiB buffer.
    // The generator is paused at yield and must keep that reservation until
    // the consumer advances or closes it.
    assert.equal(loaded.module.getActiveSseBufferBytes(), 4 * 2 * 1024 * 1024);
    assert.ok(loaded.module.getActiveSseBufferBytes() <= loaded.module.MAX_ACTIVE_SSE_BUFFER_BYTES);
  } finally {
    await Promise.all(iterators.map(iterator => iterator.return()));
    assert.equal(loaded.module.getActiveSseBufferBytes(), 0);
    await loaded.dispose();
  }
});

test("stock service fallback is cached and avatar error bodies are bounded", async () => {
  const loaded = await loadGatewayModule();
  let server;
  try {
    let discoveryCalls = 0;
    server = createServer((request, response) => {
      if (request.method === "POST" && request.url === "/api/listGatewayServices") {
        discoveryCalls += 1;
        response.writeHead(404, { "content-type": "application/json" });
        response.end('{"error":"not found"}');
        return;
      }
      if (request.method === "GET" && request.url === "/avatars/agent-one") {
        response.writeHead(500, { "content-type": "text/plain" });
        response.write(Buffer.alloc(64 * 1024, 97));
        response.end("x");
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const gateway = loaded.module.makeGatewayService({
      ...runtimeConfig(),
      url: `http://127.0.0.1:${server.address().port}`,
    });

    const first = await Effect.runPromise(gateway.services);
    const second = await Effect.runPromise(gateway.services);
    assert.equal(first.live, false);
    assert.strictEqual(second, first);
    assert.equal(discoveryCalls, 1);

    const avatar = await Effect.runPromise(gateway.avatar("agent-one").pipe(Effect.either));
    assert.equal(avatar._tag, "Left");
    assert.equal(avatar.left.code, "GATEWAY_PROTOCOL");
    assert.match(avatar.left.message, /response exceeds 65536 bytes/);
  } finally {
    if (server != null) {
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections?.();
      });
    }
    await loaded.dispose();
  }
});

test("invalid gateway header values fail as typed errors without echoing secrets", async () => {
  const loaded = await loadGatewayModule();
  try {
    for (const invalid of [
      { token: "token-secret\r\nx-injected: yes", marker: "token-secret" },
      { requestId: "request-secret\ninvalid", marker: "request-secret" },
    ]) {
      const gateway = loaded.module.makeGatewayService(runtimeConfig({
        url: "http://127.0.0.1:1",
        ...(invalid.token === undefined ? {} : { token: invalid.token }),
        ...(invalid.requestId === undefined ? {} : { requestId: invalid.requestId }),
      }));
      const result = await Effect.runPromise(gateway.health.pipe(Effect.either));
      assert.equal(result._tag, "Left");
      assert.equal(result.left.code, "CLI_CONFIG");
      assert.doesNotMatch(result.left.message, new RegExp(invalid.marker));
    }
  } finally {
    await loaded.dispose();
  }
});

test("non-serializable gateway arguments fail in the typed channel", async () => {
  const loaded = await loadGatewayModule();
  try {
    const gateway = loaded.module.makeGatewayService(runtimeConfig({
      url: "http://127.0.0.1:1",
    }));
    const argumentsWithCycle = { marker: "must-not-be-reflected" };
    argumentsWithCycle.self = argumentsWithCycle;
    const result = await Effect.runPromise(gateway.invoke(
      "testService",
      argumentsWithCycle,
      { allowUnknown: true },
    ).pipe(Effect.either));
    assert.equal(result._tag, "Left");
    assert.equal(result.left.code, "INVALID_INPUT");
    assert.doesNotMatch(result.left.message, /must-not-be-reflected/);
  } finally {
    await loaded.dispose();
  }
});

test("discovery files and health probes are bounded and cancel oversized bodies", async () => {
  const loaded = await loadGatewayModule();
  const temporary = await mkdtemp(path.join(repoRoot, ".grok-discovery-bounds-"));
  const discoveryPath = path.join(temporary, "gateway.json");
  let server;
  try {
    await writeFile(discoveryPath, Buffer.alloc(64 * 1024 + 1, 120));
    const oversizedFile = await Effect.runPromise(
      loaded.module.resolveGatewayConnection(runtimeConfig({ discoveryPath })).pipe(Effect.either),
    );
    assert.equal(oversizedFile._tag, "Left");
    assert.equal(oversizedFile.left.code, "CLI_CONFIG");
    assert.match(oversizedFile.left.message, /discovery file exceeds 65536 bytes/);

    let healthCancelled = false;
    server = createServer((request, response) => {
      if (request.url !== "/health") {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      const interval = setInterval(() => response.write("x"), 10);
      response.on("close", () => {
        healthCancelled = true;
        clearInterval(interval);
      });
      response.write(Buffer.alloc(64 * 1024 + 1, 120));
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const startedAt = Date.now();
    await writeFile(discoveryPath, JSON.stringify({
      host: "127.0.0.1",
      port: server.address().port,
      pid: process.pid,
      startedAt,
      token: "probe-token",
    }));
    const oversizedHealth = await Effect.runPromise(
      loaded.module.resolveGatewayConnection(runtimeConfig({ discoveryPath })).pipe(Effect.either),
    );
    assert.equal(oversizedHealth._tag, "Left");
    assert.equal(oversizedHealth.left.code, "CLI_CONFIG");
    assert.equal(await waitFor(() => healthCancelled), true);
  } finally {
    if (server != null) {
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections?.();
      });
    }
    await rm(temporary, { recursive: true, force: true });
    await loaded.dispose();
  }
});

test("gateway discovery refuses directories, devices, and symbolic links", {
  skip: process.platform === "win32" ? "POSIX special-file semantics are required" : false,
}, async () => {
  const loaded = await loadGatewayModule();
  const temporary = await mkdtemp(path.join(repoRoot, ".grok-discovery-file-kind-"));
  try {
    const target = path.join(temporary, "target.json");
    const linked = path.join(temporary, "linked.json");
    const directory = path.join(temporary, "directory.json");
    await writeFile(target, "{}");
    await symlink(target, linked);
    await mkdir(directory);

    for (const [candidate, expected] of [
      [directory, /regular file/],
      ["/dev/null", /regular file/],
      [linked, /Unable to read gateway discovery/],
    ]) {
      const result = await Effect.runPromise(
        loaded.module.resolveGatewayConnection(runtimeConfig({ discoveryPath: candidate })).pipe(Effect.either),
      );
      assert.equal(result._tag, "Left");
      assert.equal(result.left.code, "CLI_CONFIG");
      assert.match(result.left.message, expected);
      assert.doesNotMatch(result.left.message, /stale or unreachable/);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
    await loaded.dispose();
  }
});

test("FIFO discovery is rejected promptly while automatic discovery preserves fallback semantics", {
  skip: process.platform === "win32" ? "named filesystem FIFOs are not portable to Windows" : false,
}, async (context) => {
  const temporary = await mkdtemp(path.join(repoRoot, ".grok-discovery-fifo-"));
  const home = path.join(temporary, "home");
  const discoveryDirectory = path.join(home, ".grokbot");
  const discoveryPath = path.join(discoveryDirectory, "gateway.json");
  const fallbackDirectory = path.join(home, ".cursor", "sand-dev");
  const fallbackPath = path.join(fallbackDirectory, "gateway.json");
  const environmentKeys = [
    "HOME",
    "GROK_BOT_GATEWAY_URL",
    "SAND_HOST_GATEWAY_URL",
    "GROK_BOT_GATEWAY_DISCOVERY",
    "SAND_DATA_ROOT",
    "SAND_USER_DATA_DIR",
  ];
  const previousEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]));
  let loaded;
  let server;
  try {
    await mkdir(discoveryDirectory, { recursive: true });
    try {
      await makeFifo(discoveryPath);
    } catch (error) {
      if (error != null && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        context.skip("mkfifo is unavailable on this POSIX host");
        return;
      }
      throw error;
    }
    await mkdir(fallbackDirectory, { recursive: true });
    const startedAt = Date.now();
    server = createServer((request, response) => {
      if (request.url !== "/health") {
        response.writeHead(404);
        response.end();
        return;
      }
      const body = JSON.stringify({ ok: true, pid: process.pid, startedAt });
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      });
      response.end(body);
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    await writeFile(fallbackPath, JSON.stringify({
      host: "127.0.0.1",
      port: server.address().port,
      pid: process.pid,
      startedAt,
      token: "fallback-token",
    }));

    for (const key of environmentKeys) delete process.env[key];
    process.env.HOME = home;
    loaded = await loadGatewayModule();

    const explicit = await resolveWithBlockedFifoRescue(
      loaded.module.resolveGatewayConnection(runtimeConfig({ discoveryPath })).pipe(Effect.either),
      discoveryPath,
    );
    assert.ok(explicit.elapsedMs < 750, `explicit FIFO discovery took ${explicit.elapsedMs}ms`);
    assert.equal(explicit.result._tag, "Left");
    assert.equal(explicit.result.left.code, "CLI_CONFIG");
    assert.match(explicit.result.left.message, /regular file/);
    assert.equal(explicit.result.left.path, discoveryPath);

    const automatic = await resolveWithBlockedFifoRescue(
      loaded.module.resolveGatewayConnection(runtimeConfig()).pipe(Effect.either),
      discoveryPath,
    );
    assert.ok(automatic.elapsedMs < 750, `automatic FIFO discovery took ${automatic.elapsedMs}ms`);
    assert.equal(automatic.result._tag, "Right");
    assert.equal(automatic.result.right.discoveryPath, fallbackPath);
    assert.equal(automatic.result.right.token, "fallback-token");
  } finally {
    for (const [key, value] of previousEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (server !== undefined) {
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections?.();
      });
    }
    if (loaded !== undefined) await loaded.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("interrupting a bounded response read cancels its body reader", async () => {
  const loaded = await loadGatewayModule();
  let server;
  try {
    let avatarCancelled = false;
    server = createServer((request, response) => {
      if (request.url !== "/avatars/slow-agent") {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.write("x");
      const interval = setInterval(() => response.write("x"), 10);
      response.on("close", () => {
        avatarCancelled = true;
        clearInterval(interval);
      });
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const gateway = loaded.module.makeGatewayService(runtimeConfig({
      url: `http://127.0.0.1:${server.address().port}`,
    }));
    const fiber = Effect.runFork(gateway.avatar("slow-agent"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await Effect.runPromise(Fiber.interrupt(fiber));
    assert.equal(await waitFor(() => avatarCancelled), true);
  } finally {
    if (server != null) {
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections?.();
      });
    }
    await loaded.dispose();
  }
});

test("non-successful SSE bodies are cancelled before a retry is opened", async () => {
  const loaded = await loadGatewayModule();
  let server;
  try {
    let calls = 0;
    let firstCancelled = false;
    let retrySawCancellation = false;
    server = createServer((request, response) => {
      if (!request.url?.startsWith("/events")) {
        response.writeHead(404);
        response.end();
        return;
      }
      calls += 1;
      if (calls === 1) {
        response.writeHead(503, { "content-type": "text/plain" });
        response.write("retry");
        const interval = setInterval(() => response.write("."), 10);
        response.on("close", () => {
          firstCancelled = true;
          clearInterval(interval);
        });
        return;
      }
      retrySawCancellation = firstCancelled;
      response.writeHead(400, { "content-type": "text/plain" });
      response.end("stop");
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const gateway = loaded.module.makeGatewayService(runtimeConfig({
      url: `http://127.0.0.1:${server.address().port}`,
    }));
    const outcome = await Effect.runPromise(
      gateway.events().pipe(Stream.runCollect, Effect.either),
    );
    assert.equal(outcome._tag, "Left");
    assert.equal(calls, 2);
    assert.equal(firstCancelled, true);
    assert.equal(retrySawCancellation, true);
  } finally {
    if (server != null) {
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections?.();
      });
    }
    await loaded.dispose();
  }
});

test("an invoked 404 invalidates only the cached service manifest", async () => {
  const loaded = await loadGatewayModule();
  let server;
  try {
    let discoveryCalls = 0;
    server = createServer((request, response) => {
      if (request.method === "POST" && request.url === "/api/listGatewayServices") {
        discoveryCalls += 1;
        const methods = discoveryCalls === 1
          ? ["listAgents", "listGatewayServices"]
          : ["getAuthStatus", "listGatewayServices"];
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ protocolVersion: discoveryCalls, capabilities: [], methods }));
        return;
      }
      if (request.method === "POST" && request.url === "/api/listAgents") {
        response.writeHead(404, { "content-type": "application/json" });
        response.end('{"error":"removed"}');
        return;
      }
      if (request.method === "POST" && request.url === "/api/getAuthStatus") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"authenticated":true}');
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const gateway = loaded.module.makeGatewayService(runtimeConfig({
      url: `http://127.0.0.1:${server.address().port}`,
    }));
    assert.equal((await Effect.runPromise(gateway.services)).protocolVersion, 1);

    const removed = await Effect.runPromise(gateway.invoke("listAgents").pipe(Effect.either));
    assert.equal(removed._tag, "Left");
    assert.equal(removed.left.status, 404);

    assert.deepEqual(await Effect.runPromise(gateway.invoke("getAuthStatus")), { authenticated: true });
    const refreshed = await Effect.runPromise(gateway.services);
    assert.equal(refreshed.protocolVersion, 2);
    assert.equal(discoveryCalls, 2);
  } finally {
    if (server != null) {
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections?.();
      });
    }
    await loaded.dispose();
  }
});

test("explicit service-manifest refreshes preserve caching and coalesce overlap", async () => {
  const loaded = await loadGatewayModule();
  let server;
  let releaseSecond;
  const secondResponseGate = new Promise((resolve) => {
    releaseSecond = resolve;
  });
  try {
    let discoveryCalls = 0;
    server = createServer(async (request, response) => {
      if (request.method === "POST" && request.url === "/api/listGatewayServices") {
        discoveryCalls += 1;
        const call = discoveryCalls;
        if (call === 2) await secondResponseGate;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          protocolVersion: call,
          capabilities: [],
          methods: call === 1
            ? ["listAgents", "listGatewayServices"]
            : ["getAuthStatus", "listGatewayServices"],
        }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const gateway = loaded.module.makeGatewayService(runtimeConfig({
      url: `http://127.0.0.1:${server.address().port}`,
    }));

    assert.equal((await Effect.runPromise(gateway.services)).protocolVersion, 1);
    assert.equal((await Effect.runPromise(gateway.services)).protocolVersion, 1);
    assert.equal(discoveryCalls, 1, "the ordinary accessor must retain its cached manifest");

    const overlapping = Promise.all(Array.from({ length: 8 }, () =>
      Effect.runPromise(gateway.refreshServices)));
    assert.equal(await waitFor(() => discoveryCalls === 2), true);
    await new Promise((resolve) => setImmediate(resolve));
    releaseSecond();
    const refreshed = await overlapping;
    assert.equal(discoveryCalls, 2, "overlapping refreshes must share one gateway request");
    assert.ok(refreshed.every((manifest) => manifest.protocolVersion === 2));
    assert.ok(refreshed.every((manifest) => manifest.methods.includes("getAuthStatus")));

    assert.equal((await Effect.runPromise(gateway.refreshServices)).protocolVersion, 3);
    assert.equal(discoveryCalls, 3, "a later explicit refresh must re-negotiate");
  } finally {
    releaseSecond?.();
    if (server != null) {
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections?.();
      });
    }
    await loaded.dispose();
  }
});

test("service discovery bounds and validates the complete live manifest", async () => {
  const loaded = await loadGatewayModule();
  let server;
  try {
    let mode = "valid";
    server = createServer((request, response) => {
      if (request.method !== "POST" || request.url !== "/api/listGatewayServices") {
        response.writeHead(404);
        response.end();
        return;
      }
      const value = mode === "too-many-methods"
        ? { protocolVersion: 2, capabilities: [], methods: Array.from({ length: 1_025 }, (_, index) => `m${index}`) }
        : mode === "bad-method"
          ? { protocolVersion: 2, capabilities: [], methods: ["listGatewayServices", "not-valid!"] }
          : mode === "bad-capability"
            ? { protocolVersion: 2, capabilities: ["bad\ncapability"], methods: ["listGatewayServices"] }
            : mode === "bad-version"
              ? { protocolVersion: -1, capabilities: [], methods: ["listGatewayServices"] }
              : mode === "oversized"
                ? { protocolVersion: 2, capabilities: [], methods: ["listGatewayServices"], padding: "x".repeat(loaded.module.MAX_GATEWAY_SERVICE_MANIFEST_BYTES) }
                : { protocolVersion: mode === "recovered" ? 3 : 1, capabilities: ["gatewayServicesV1"], methods: ["listAgents", "listGatewayServices"] };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const gateway = loaded.module.makeGatewayService(runtimeConfig({
      url: `http://127.0.0.1:${server.address().port}`,
    }));
    assert.equal((await Effect.runPromise(gateway.services)).protocolVersion, 1);

    for (const invalidMode of ["too-many-methods", "bad-method", "bad-capability", "bad-version"]) {
      mode = invalidMode;
      const outcome = await Effect.runPromise(gateway.refreshServices.pipe(Effect.either));
      assert.equal(outcome._tag, "Left", invalidMode);
      assert.equal(outcome.left.code, "GATEWAY_PROTOCOL", invalidMode);
      assert.equal((await Effect.runPromise(gateway.services)).protocolVersion, 1, `${invalidMode} replaced the cache`);
    }

    mode = "oversized";
    const oversized = await Effect.runPromise(gateway.refreshServices.pipe(Effect.either));
    assert.equal(oversized._tag, "Left");
    assert.equal(oversized.left.code, "GATEWAY_PROTOCOL");

    mode = "recovered";
    const recovered = await Effect.runPromise(gateway.refreshServices);
    assert.equal(recovered.protocolVersion, 3);
    assert.deepEqual(recovered.methods, ["listAgents", "listGatewayServices"]);
  } finally {
    if (server != null) {
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections?.();
      });
    }
    await loaded.dispose();
  }
});
