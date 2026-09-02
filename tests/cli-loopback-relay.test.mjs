import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const officialBearer = "official-bearer-token-should-never-be-published";
const officialNetwork = "official-network-token-should-never-be-published";

async function loadModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-cli-relay-module-"));
  const output = path.join(temporary, "cli-loopback-relay.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/electron-main/box/cli-loopback-relay.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, modulePath: output, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

function permissions(stats) {
  return stats.mode & 0o777;
}

async function listenUpstream(handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error != null ? reject(error) : resolve());
    }),
  };
}

function requestAbsoluteRelayTarget(port, target) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: target,
      headers: {
        authorization: "Bearer loopback-relay-token",
        "content-type": "application/json",
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("error", reject);
      response.once("end", () => resolve({
        status: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      }));
    });
    request.once("error", reject);
    request.end("{}");
  });
}

async function readRelayPort(child) {
  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  for await (const line of reader) {
    try {
      const message = JSON.parse(line);
      if (typeof message.port === "number") return message.port;
    } catch {}
  }
  throw new Error("Relay parent exited before reporting its port");
}

async function waitForPortToClose(port) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(200) });
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Relay port ${port} remained open after its parent exited`);
}

test("official CLI relay startup resolves only after valid listening IPC", async () => {
  const loaded = await loadModule();
  const child = spawn(process.execPath, [
    "--eval",
    "setTimeout(() => process.send?.({ type: 'listening', port: 43210 }), 1_100); setInterval(() => {}, 1_000);",
  ], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const supervisor = loaded.module.superviseOfficialCliRelayChild(child, 2_000);
  const startedAt = Date.now();
  try {
    assert.equal(await supervisor.listening, 43_210);
    assert.ok(Date.now() - startedAt >= 1_000, "startup resolved before the child acknowledged listening");
  } finally {
    await supervisor.stop();
    await supervisor.exited;
    await loaded.dispose();
  }
});

test("official CLI relay startup rejects timeout and stops the child", async () => {
  const loaded = await loadModule();
  const child = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1_000);"], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const supervisor = loaded.module.superviseOfficialCliRelayChild(child, 50);
  try {
    await assert.rejects(supervisor.listening, /did not report listening within 50ms/);
    await supervisor.exited;
    assert.equal(child.signalCode, "SIGTERM");
  } finally {
    await supervisor.stop();
    await loaded.dispose();
  }
});

test("official CLI relay escalates to SIGKILL when the child ignores SIGTERM", async () => {
  const loaded = await loadModule();
  const child = spawn(process.execPath, [
    "--eval",
    "process.on('SIGTERM', () => {}); process.send?.({ type: 'armed' }); setInterval(() => {}, 1_000);",
  ], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  let supervisor;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("child never armed its SIGTERM handler")), 5_000);
      const settle = (handler) => (...args) => {
        clearTimeout(timer);
        handler(...args);
      };
      child.once("message", settle((message) => {
        if (message?.type === "armed") resolve();
        else reject(new Error(`unexpected child message ${JSON.stringify(message)}`));
      }));
      child.once("error", settle(reject));
      child.once("exit", settle((code, signal) => reject(new Error(`child exited before arming (${code ?? signal})`))));
    });
    supervisor = loaded.module.superviseOfficialCliRelayChild(child, 50);
    await assert.rejects(supervisor.listening, /did not report listening within 50ms/);
    await supervisor.exited;
    assert.equal(child.signalCode, "SIGKILL");
  } finally {
    if (supervisor != null) await supervisor.stop();
    else if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
    await loaded.dispose();
  }
});

test("official CLI relay reports a child that survives SIGKILL", async () => {
  const loaded = await loadModule();
  const kills = [];
  const child = Object.assign(new EventEmitter(), {
    pid: 4242,
    exitCode: null,
    signalCode: null,
    connected: false,
    kill(signal) {
      kills.push(signal);
      return true;
    },
  });
  const supervisor = loaded.module.superviseOfficialCliRelayChild(child, 50);
  try {
    await assert.rejects(
      supervisor.listening,
      /did not report listening within 50ms\. Official CLI relay child survived SIGKILL \(pid 4242\)\./,
    );
    assert.deepEqual(kills, ["SIGTERM", "SIGKILL"]);
    await assert.rejects(supervisor.stop(), /survived SIGKILL \(pid 4242\)/);
  } finally {
    await loaded.dispose();
  }
});

test("official CLI relay startup rejects child errors and pre-listen exits", async (t) => {
  const loaded = await loadModule();
  try {
    await t.test("reported listen error", async () => {
      const child = spawn(process.execPath, [
        "--eval",
        "process.send?.({ type: 'error', error: 'simulated listen failure' }); setInterval(() => {}, 1_000);",
      ], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
      const supervisor = loaded.module.superviseOfficialCliRelayChild(child, 1_000);
      try {
        await assert.rejects(supervisor.listening, /simulated listen failure/);
        await supervisor.exited;
        assert.equal(child.signalCode, "SIGTERM");
      } finally {
        await supervisor.stop();
      }
    });

    await t.test("pre-listen exit", async () => {
      const child = spawn(process.execPath, ["--eval", "process.exit(23);"], {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      const supervisor = loaded.module.superviseOfficialCliRelayChild(child, 1_000);
      try {
        await assert.rejects(supervisor.listening, /exited before listening \(code 23\)/);
        await supervisor.exited;
        assert.equal(child.exitCode, 23);
      } finally {
        await supervisor.stop();
      }
    });

    await t.test("malformed listening acknowledgement", async () => {
      const child = spawn(process.execPath, [
        "--eval",
        "process.send?.({ type: 'listening', port: 0 }); setInterval(() => {}, 1_000);",
      ], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
      const supervisor = loaded.module.superviseOfficialCliRelayChild(child, 1_000);
      try {
        await assert.rejects(supervisor.listening, /invalid listening port/);
        await supervisor.exited;
        assert.equal(child.signalCode, "SIGTERM");
      } finally {
        await supervisor.stop();
      }
    });
  } finally {
    await loaded.dispose();
  }
});

test("official CLI relay does not publish discovery when the child cannot listen", async () => {
  const loaded = await loadModule();
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-cli-relay-startup-failure-"));
  const discoveryPath = path.join(temporary, "gateway.json");
  try {
    await assert.rejects(loaded.module.startOfficialCliLoopbackRelay({
      discoveryPath,
      host: "192.0.2.1",
      port: 0,
      resolveConnection: async () => ({
        baseUrl: "https://example.invalid",
        token: officialBearer,
      }),
    }), /EADDRNOTAVAIL|failed to listen/);
    await assert.rejects(stat(discoveryPath), { code: "ENOENT" });
  } finally {
    await Promise.all([
      loaded.dispose(),
      rm(temporary, { recursive: true, force: true }),
    ]);
  }
});

test("official CLI relay publishes only its own discovery token and forwards official credentials", async () => {
  const loaded = await loadModule();
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-cli-relay-"));
  const discoveryPath = path.join(temporary, "gateway.json");
  const seen = [];
  const upstream = await listenUpstream((req, res) => {
    seen.push({
      url: req.url,
      authorization: req.headers.authorization,
      network: req.headers["x-anyrun-network-token"],
      inboundRelay: req.headers["x-relay-probe"],
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ live: true, methods: ["listAgents"] }));
  });
  let relay;
  try {
    relay = await loaded.module.startOfficialCliLoopbackRelay({
      discoveryPath,
      token: "loopback-relay-token",
      pid: 4242,
      startedAt: 99,
      port: 0,
      resolveConnection: async () => ({
        baseUrl: upstream.baseUrl,
        token: officialBearer,
        headers: { "x-anyrun-network-token": officialNetwork },
      }),
    });
    await assert.rejects(readFile(discoveryPath, "utf8"), { code: "ENOENT" });
    relay.publishConnection({
      baseUrl: upstream.baseUrl,
      token: officialBearer,
      headers: { "x-anyrun-network-token": officialNetwork },
    });

    const stored = JSON.parse(await readFile(discoveryPath, "utf8"));
    assert.equal(permissions(await stat(discoveryPath)), 0o600);
    assert.equal(stored.token, "loopback-relay-token");
    assert.equal(stored.target, "official-remote-relay");
    assert.equal(stored.pid, 4242);
    assert.equal(stored.startedAt, 99);
    const serialized = JSON.stringify(stored);
    assert.equal(serialized.includes(officialBearer), false);
    assert.equal(serialized.includes(officialNetwork), false);

    const denied = await fetch(`${relay.baseUrl}/health`);
    assert.equal(denied.status, 401);

    const health = await fetch(`${relay.baseUrl}/health`, {
      headers: { authorization: "Bearer loopback-relay-token" },
    });
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      ok: true,
      pid: 4242,
      startedAt: 99,
      isBusy: false,
      source: "official-remote-relay",
    });

    const services = await fetch(`${relay.baseUrl}/api/listGatewayServices`, {
      method: "POST",
      headers: {
        authorization: "Bearer loopback-relay-token",
        "content-type": "application/json",
        "x-relay-probe": "from-cli",
      },
      body: "{}",
    });
    assert.equal(services.status, 200);
    assert.deepEqual(await services.json(), { live: true, methods: ["listAgents"] });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].authorization, `Bearer ${officialBearer}`);
    assert.equal(seen[0].network, officialNetwork);
    assert.equal(seen[0].inboundRelay, "from-cli");
  } finally {
    await relay?.dispose();
    await Promise.all([
      loaded.dispose(),
      upstream.close(),
      rm(temporary, { recursive: true, force: true }),
    ]);
  }
});

test("official CLI relay rejects cross-origin absolute request targets before attaching credentials", async () => {
  const loaded = await loadModule();
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-cli-relay-cross-origin-"));
  const discoveryPath = path.join(temporary, "gateway.json");
  const intendedSeen = [];
  const attackerSeen = [];
  const intended = await listenUpstream((req, res) => {
    intendedSeen.push(req.headers);
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const attacker = await listenUpstream((req, res) => {
    attackerSeen.push(req.headers);
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  let relay;
  try {
    relay = await loaded.module.startOfficialCliLoopbackRelay({
      discoveryPath,
      token: "loopback-relay-token",
      port: 0,
      resolveConnection: async () => ({
        baseUrl: intended.baseUrl,
        token: officialBearer,
        headers: { "x-anyrun-network-token": officialNetwork },
      }),
    });
    const response = await requestAbsoluteRelayTarget(relay.port, `${attacker.baseUrl}/steal`);
    assert.equal(response.status, 403);
    assert.deepEqual(response.body, { error: "cross-origin relay request targets are not allowed" });
    assert.equal(intendedSeen.length, 0);
    assert.equal(attackerSeen.length, 0);
  } finally {
    await relay?.dispose();
    await Promise.all([
      loaded.dispose(),
      intended.close(),
      attacker.close(),
      rm(temporary, { recursive: true, force: true }),
    ]);
  }
});

test("official connector wrapper publishes after the stock connector succeeds", async () => {
  const loaded = await loadModule();
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-cli-relay-wrapper-"));
  const discoveryPath = path.join(temporary, "gateway.json");
  const upstream = await listenUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ count: 2 }));
  });
  let relay;
  let registeredShutdown;
  let connectCount = 0;
  let resolveRelay;
  const relayReady = new Promise((resolve) => { resolveRelay = resolve; });
  const connector = {
    async connect() {
      connectCount += 1;
      return {
        baseUrl: upstream.baseUrl,
        token: officialBearer,
        headers: { "x-anyrun-network-token": officialNetwork },
      };
    },
    recreate() {
      return "recreated";
    },
  };
  try {
    const wrapped = loaded.module.wrapRemoteHostConnectorWithOfficialCliRelay(connector, {
      discoveryPath,
      token: "loopback-relay-token",
      pid: 5150,
      startedAt: 123,
      port: 0,
      registerShutdown(dispose) {
        registeredShutdown = dispose;
      },
      onRelayReady(value) {
        relay = value;
        resolveRelay(value);
      },
    });
    const connection = await wrapped.connect();
    assert.equal(connection.baseUrl, upstream.baseUrl);
    assert.equal(wrapped.recreate(), "recreated");
    await relayReady;
    await new Promise((resolve) => setImmediate(resolve));

    const stored = JSON.parse(await readFile(discoveryPath, "utf8"));
    assert.equal(stored.target, "official-remote-relay");
    assert.equal(stored.token, "loopback-relay-token");
    assert.equal(JSON.stringify(stored).includes(officialBearer), false);
    assert.equal(JSON.stringify(stored).includes(officialNetwork), false);

    const response = await fetch(`${relay.baseUrl}/api/countAgents`, {
      method: "POST",
      headers: {
        authorization: "Bearer loopback-relay-token",
        "content-type": "application/json",
      },
      body: "{}",
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { count: 2 });
    assert.equal(connectCount, 1);
    assert.equal(typeof registeredShutdown, "function");
    await registeredShutdown();
    await assert.rejects(fetch(`${relay.baseUrl}/health`));
    await assert.rejects(readFile(discoveryPath, "utf8"), { code: "ENOENT" });
  } finally {
    await relay?.dispose();
    await Promise.all([
      loaded.dispose(),
      upstream.close(),
      rm(temporary, { recursive: true, force: true }),
    ]);
  }
});

test("official CLI relay child exits when its parent process crashes", async () => {
  const loaded = await loadModule();
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-cli-relay-parent-exit-"));
  const discoveryPath = path.join(temporary, "gateway.json");
  const parent = spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    `
      import { pathToFileURL } from "node:url";
      const relayModule = await import(pathToFileURL(process.env.RELAY_MODULE_PATH).href);
      const relay = await relayModule.startOfficialCliLoopbackRelay({
        discoveryPath: process.env.RELAY_DISCOVERY_PATH,
        token: "parent-exit-relay-token",
        port: 0,
        resolveConnection: () => new Promise(() => undefined),
      });
      process.stdout.write(JSON.stringify({ port: relay.port }) + "\\n");
      setInterval(() => undefined, 1_000);
    `,
  ], {
    env: {
      ...process.env,
      RELAY_MODULE_PATH: loaded.modulePath,
      RELAY_DISCOVERY_PATH: discoveryPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const port = await readRelayPort(parent);
    const liveResponse = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(liveResponse.status, 401);
    parent.kill("SIGKILL");
    await new Promise((resolve) => parent.once("exit", resolve));
    await waitForPortToClose(port);
  } finally {
    if (parent.exitCode == null && parent.signalCode == null) parent.kill("SIGKILL");
    await Promise.all([
      loaded.dispose(),
      rm(temporary, { recursive: true, force: true }),
    ]);
  }
});

test("official CLI relay refuses local Docker and other loopback upstreams", async () => {
  const loaded = await loadModule();
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-cli-relay-loopback-"));
  const discoveryPath = path.join(temporary, "gateway.json");
  let relay;
  try {
    relay = await loaded.module.startOfficialCliLoopbackRelay({
      discoveryPath,
      token: "loopback-relay-token",
      port: 0,
      resolveConnection: async () => ({
        baseUrl: "http://127.0.0.1:1340",
        token: officialBearer,
        headers: { "x-anyrun-network-token": officialNetwork },
      }),
    });
    const response = await fetch(`${relay.baseUrl}/api/countAgents`, {
      method: "POST",
      headers: {
        authorization: "Bearer loopback-relay-token",
        "content-type": "application/json",
      },
      body: "{}",
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: "official remote relay refuses a loopback gateway",
    });
    await assert.rejects(readFile(discoveryPath, "utf8"), { code: "ENOENT" });
    relay.publishConnection({
      baseUrl: "http://127.0.0.1:1340",
      token: officialBearer,
      headers: { "x-anyrun-network-token": officialNetwork },
    });
    await assert.rejects(readFile(discoveryPath, "utf8"), { code: "ENOENT" });
  } finally {
    await relay?.dispose();
    await Promise.all([
      loaded.dispose(),
      rm(temporary, { recursive: true, force: true }),
    ]);
  }
});

test("official CLI relay fails fast when the official connector does not answer", async () => {
  const loaded = await loadModule();
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-cli-relay-timeout-"));
  const discoveryPath = path.join(temporary, "gateway.json");
  let relay;
  try {
    relay = await loaded.module.startOfficialCliLoopbackRelay({
      discoveryPath,
      token: "loopback-relay-token",
      port: 0,
      resolveTimeoutMs: 200,
      resolveConnection: () => new Promise(() => undefined),
    });
    const started = Date.now();
    const response = await fetch(`${relay.baseUrl}/api/countAgents`, {
      method: "POST",
      headers: {
        authorization: "Bearer loopback-relay-token",
        "content-type": "application/json",
      },
      body: "{}",
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: "official remote gateway is unavailable",
    });
    assert.ok(Date.now() - started < 2_000);
    await assert.rejects(readFile(discoveryPath, "utf8"), { code: "ENOENT" });
  } finally {
    await relay?.dispose();
    await Promise.all([
      loaded.dispose(),
      rm(temporary, { recursive: true, force: true }),
    ]);
  }
});

test("official CLI relay does not forward decompressed gzip content-encoding", async () => {
  const loaded = await loadModule();
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-cli-relay-gzip-"));
  const discoveryPath = path.join(temporary, "gateway.json");
  const { gzipSync } = await import("node:zlib");
  const payload = Buffer.from(JSON.stringify({ agents: [{ id: "agent-1" }] }));
  const upstream = await listenUpstream((_req, res) => {
    res.writeHead(200, {
      "content-type": "application/json",
      "content-encoding": "gzip",
    });
    res.end(gzipSync(payload));
  });
  let relay;
  try {
    relay = await loaded.module.startOfficialCliLoopbackRelay({
      discoveryPath,
      token: "loopback-relay-token",
      port: 0,
      resolveConnection: async () => ({
        baseUrl: upstream.baseUrl,
        token: officialBearer,
      }),
    });
    const response = await fetch(`${relay.baseUrl}/api/listAgents`, {
      method: "POST",
      headers: {
        authorization: "Bearer loopback-relay-token",
        "content-type": "application/json",
      },
      body: "{}",
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-encoding"), null);
    assert.deepEqual(await response.json(), { agents: [{ id: "agent-1" }] });
  } finally {
    await relay?.dispose();
    await Promise.all([
      loaded.dispose(),
      upstream.close(),
      rm(temporary, { recursive: true, force: true }),
    ]);
  }
});

test("official CLI relay uses a published official connection without waiting on resolve", async () => {
  const loaded = await loadModule();
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-cli-relay-publish-"));
  const discoveryPath = path.join(temporary, "gateway.json");
  const seen = [];
  const upstream = await listenUpstream((req, res) => {
    seen.push(req.headers.authorization);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ count: 3 }));
  });
  let relay;
  try {
    relay = await loaded.module.startOfficialCliLoopbackRelay({
      discoveryPath,
      token: "loopback-relay-token",
      port: 0,
      resolveTimeoutMs: 200,
      resolveConnection: () => new Promise(() => undefined),
    });
    relay.publishConnection({
      baseUrl: upstream.baseUrl,
      token: officialBearer,
      headers: { "x-anyrun-network-token": officialNetwork },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const response = await fetch(`${relay.baseUrl}/api/countAgents`, {
      method: "POST",
      headers: {
        authorization: "Bearer loopback-relay-token",
        "content-type": "application/json",
      },
      body: "{}",
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { count: 3 });
    assert.deepEqual(seen, [`Bearer ${officialBearer}`]);
  } finally {
    await relay?.dispose();
    await Promise.all([
      loaded.dispose(),
      upstream.close(),
      rm(temporary, { recursive: true, force: true }),
    ]);
  }
});
