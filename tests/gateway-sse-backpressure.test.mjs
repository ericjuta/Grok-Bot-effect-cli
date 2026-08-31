import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-gateway-sse-"));
  const output = path.join(temporary, "gateway-server.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/host/gateway-server.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

class FakeResponse extends EventEmitter {
  destroyed = false;
  headers;
  writes = [];
  failAt;

  constructor(failAt) {
    super();
    this.failAt = failAt;
  }

  writeHead(_status, headers) {
    this.headers = headers;
  }

  write(value) {
    this.writes.push(String(value));
    return this.writes.length !== this.failAt;
  }

  destroy() {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.emit("close");
    return this;
  }
}

class FakeWritableResponse extends Writable {
  headers;
  byteCount = 0;

  writeHead(_status, headers) {
    this.headers = headers;
  }

  _write(chunk, _encoding, callback) {
    this.byteCount += chunk.byteLength;
    callback();
  }
}

test("plain SSE buffers bounded events and resumes after drain", async () => {
  const loaded = await loadModule();
  try {
    const response = new FakeResponse(2);
    let publish;
    let unsubscribes = 0;
    loaded.module.openSseStream(
      { headers: {} },
      response,
      (write) => {
        publish = write;
        return () => { unsubscribes += 1; };
      },
    );
    assert.equal(response.destroyed, false);
    assert.deepEqual(response.writes, ["retry: 1000\n\n"]);

    publish('{"channel":"agents"}');
    assert.equal(response.destroyed, false);
    assert.equal(unsubscribes, 0);
    assert.equal(response.writes.length, 2);

    publish('{"channel":"queued"}');
    assert.equal(response.writes.length, 2);
    response.emit("drain");
    assert.equal(response.writes.length, 3);
    assert.match(response.writes[2], /queued/);

    response.emit("close");
    assert.equal(unsubscribes, 1);
  } finally {
    await loaded.dispose();
  }
});

test("initial SSE backpressure still registers and resumes safely", async () => {
  const loaded = await loadModule();
  try {
    const response = new FakeResponse(1);
    let registrations = 0;
    let unsubscribes = 0;
    loaded.module.openSseStream({ headers: {} }, response, () => {
      registrations += 1;
      return () => { unsubscribes += 1; };
    });
    assert.equal(response.destroyed, false);
    assert.equal(registrations, 1);
    response.emit("drain");
    response.emit("close");
    assert.equal(unsubscribes, 1);
  } finally {
    await loaded.dispose();
  }
});

test("heartbeat backpressure pauses heartbeats without closing the subscription", async () => {
  const loaded = await loadModule();
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  try {
    let heartbeat;
    let cleared = 0;
    globalThis.setInterval = (callback) => {
      heartbeat = callback;
      return { testTimer: true };
    };
    globalThis.clearInterval = () => { cleared += 1; };

    const response = new FakeResponse(2);
    let unsubscribes = 0;
    loaded.module.openSseStream(
      { headers: {} },
      response,
      () => () => { unsubscribes += 1; },
    );
    assert.equal(typeof heartbeat, "function");
    heartbeat();
    assert.equal(response.destroyed, false);
    assert.equal(unsubscribes, 0);
    assert.equal(response.writes.length, 2);
    heartbeat();
    assert.equal(response.writes.length, 2, "heartbeats are skipped while the stream is backpressured");
    response.emit("drain");
    heartbeat();
    assert.equal(response.writes.length, 3);
    response.emit("close");
    assert.equal(unsubscribes, 1);
    assert.equal(cleared, 1);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    await loaded.dispose();
  }
});

test("gzip SSE accepts frames above the writable high-water mark without dropping them", async () => {
  const loaded = await loadModule();
  const previousDisable = process.env[loaded.module.DISABLE_SSE_GZIP_ENV];
  delete process.env[loaded.module.DISABLE_SSE_GZIP_ENV];
  const response = new FakeWritableResponse();
  try {
    let publish;
    let unsubscribes = 0;
    loaded.module.openSseStream(
      { headers: { "accept-encoding": "gzip" } },
      response,
      (write) => {
        publish = write;
        return () => { unsubscribes += 1; };
      },
    );
    assert.equal(response.headers["content-encoding"], "gzip");

    // A frame larger than zlib's writable high-water mark deterministically
    // returns false even with a healthy reader; this is flow control, not loss.
    publish("x".repeat(1024 * 1024));
    assert.equal(response.destroyed, false);
    assert.equal(unsubscribes, 0);
  } finally {
    response.destroy();
    await new Promise((resolve) => setImmediate(resolve));
    if (previousDisable === undefined) delete process.env[loaded.module.DISABLE_SSE_GZIP_ENV];
    else process.env[loaded.module.DISABLE_SSE_GZIP_ENV] = previousDisable;
    await loaded.dispose();
  }
});

test("SSE closes only when its explicit pending-byte bound is exceeded", async () => {
  const loaded = await loadModule();
  try {
    const response = new FakeResponse(2);
    let publish;
    let unsubscribes = 0;
    loaded.module.openSseStream(
      { headers: {} },
      response,
      (write) => {
        publish = write;
        return () => { unsubscribes += 1; };
      },
    );
    publish("first-backpressured-frame");
    publish("x".repeat(loaded.module.MAX_SSE_PENDING_BYTES));
    assert.equal(response.destroyed, true);
    assert.equal(unsubscribes, 1);
  } finally {
    await loaded.dispose();
  }
});
