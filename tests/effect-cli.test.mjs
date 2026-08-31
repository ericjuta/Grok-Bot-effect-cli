import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "dist/cli/grok-bot.mjs");
const protocol = "grok-effect-cli/v1";
const startedAt = Date.now();
const requests = [];

let server;
let baseUrl;
let gatewayMethods = ["createAgent", "deleteAgents", "listAgents", "listGatewayServices", "sendPrompt", "setHostSettings", "uploadAttachment"];
let listAgentsAvailable = true;
let gatewayManifestStatus = 200;

function json(res, value, status = 200) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

before(async () => {
  await execFileAsync(process.execPath, [path.join(repoRoot, "scripts/build-cli.mjs")], { cwd: repoRoot });
  server = createServer(async (req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers, body: await body(req) });
    if (req.method === "GET" && req.url === "/health") {
      json(res, { ok: true, pid: process.pid, startedAt, isBusy: false });
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/events")) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      // Split a CRLF event boundary across chunks to cover incremental SSE
      // parsing rather than relying on convenient transport chunking.
      res.write(`data: ${JSON.stringify({ channel: "transcript", payload: { kind: "test-event" } })}\r`);
      setImmediate(() => res.write("\n\r\n"));
      return;
    }
    if (req.method === "POST" && req.url === "/api/listGatewayServices") {
      if (gatewayManifestStatus !== 200) {
        json(res, { error: "manifest temporarily unavailable" }, gatewayManifestStatus);
        return;
      }
      json(res, {
        protocolVersion: 1,
        capabilities: ["gatewayServicesV1"],
        methods: gatewayMethods,
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/listAgents") {
      if (!listAgentsAvailable) {
        json(res, { error: "listAgents removed" }, 404);
        return;
      }
      json(res, [{ id: "agent-one", name: "One" }]);
      return;
    }
    if (req.method === "POST" && req.url === "/api/deleteAgents") {
      json(res, { deleted: true });
      return;
    }
    if (req.method === "POST" && req.url === "/api/createAgent") {
      json(res, { id: "created-agent" });
      return;
    }
    if (req.method === "POST" && req.url === "/api/sendPrompt") {
      json(res, { accepted: true });
      return;
    }
    if (req.method === "POST" && req.url === "/api/setHostSettings") {
      json(res, { updated: true });
      return;
    }
    if (req.method === "POST" && req.url === "/api/uploadAttachment") {
      json(res, { path: "/host/attachments/uploaded" });
      return;
    }
    json(res, { error: `unknown: ${req.url}` }, 404);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server != null) await new Promise((resolve) => server.close(resolve));
});

async function run(args, options = {}) {
  return execFileAsync(process.execPath, [cliPath, "--url", baseUrl, ...args], {
    cwd: repoRoot,
    ...options,
  });
}

test("one-shot service calls use stable JSON envelopes and request correlation", async () => {
  const { stdout, stderr } = await run(["--request-id", "test-request", "service", "list-agents"]);
  assert.equal(stderr, "");
  const result = JSON.parse(stdout);
  assert.deepEqual(result, {
    protocol,
    type: "result",
    id: "test-request",
    command: "service:listAgents",
    ok: true,
    data: [{ id: "agent-one", name: "One" }],
    meta: { service: "listAgents" },
  });
  const request = requests.findLast((item) => item.url === "/api/listAgents");
  assert.equal(request.headers["x-sand-request-id"], "test-request");
  assert.equal(request.body, "{}");
});

test("doctor negotiates the live service manifest without exposing credentials", async () => {
  const { stdout } = await run(["doctor"]);
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.data.ok, true);
  assert.equal(result.data.connection.baseUrl, baseUrl);
  assert.equal(result.data.connection.authenticated, false);
  assert.equal(result.data.services.liveDiscovery, true);
  assert.equal(result.data.services.count, 7);
  assert.equal("token" in result.data.connection, false);
});

test("destructive service aliases require explicit confirmation before dispatch", async () => {
  await assert.rejects(
    run(["service", "delete-agents", "--json", '{"ids":["agent-one"]}']),
    (error) => {
      assert.equal(error.code, 1);
      const result = JSON.parse(error.stdout);
      assert.equal(result.protocol, protocol);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, "INVALID_INPUT");
      assert.match(result.error.message, /--yes/);
      return true;
    },
  );
  assert.equal(requests.some((item) => item.url === "/api/deleteAgents"), false);
});

test("known one-shot services reject schema-invalid destructive input before dispatch", async () => {
  const beforeCount = requests.filter((item) => item.url === "/api/deleteAgents").length;
  await assert.rejects(
    run(["service", "delete-agents", "--yes", "--json", '{"ids":"agent-one"}']),
    (error) => {
      assert.equal(error.code, 1);
      const result = JSON.parse(error.stdout);
      assert.equal(result.error.code, "INVALID_INPUT");
      assert.match(result.error.message, /Invalid arguments for deleteAgents/);
      assert.match(result.error.message, /\$\/ids/);
      return true;
    },
  );
  await assert.rejects(
    run(["call", "deleteAgents", "--allow-unknown", "--yes", "--json", '{"ids":"agent-one"}']),
    (error) => {
      assert.equal(JSON.parse(error.stdout).error.code, "INVALID_INPUT");
      return true;
    },
  );
  assert.equal(requests.filter((item) => item.url === "/api/deleteAgents").length, beforeCount);
});

test("ergonomic agent creation requires audited fields and sends a valid origin", async () => {
  const beforeCount = requests.filter((item) => item.url === "/api/createAgent").length;
  await assert.rejects(run(["agent", "create", "--name", "Only a name"]));
  assert.equal(requests.filter((item) => item.url === "/api/createAgent").length, beforeCount);

  const { stdout } = await run([
    "agent",
    "create",
    "--name",
    "CLI agent",
    "--description",
    "Created from the CLI",
  ]);
  assert.equal(JSON.parse(stdout).ok, true);
  const dispatched = requests.findLast((item) => item.url === "/api/createAgent");
  const args = JSON.parse(dispatched.body);
  assert.equal(args.name, "CLI agent");
  assert.equal(args.description, "Created from the CLI");
  assert.equal(args.origin, "user");
});

test("ergonomic provider mutation requires explicit destructive confirmation", async () => {
  const beforeCount = requests.filter((item) => item.url === "/api/setHostSettings").length;
  await assert.rejects(
    run(["provider", "set", "codex"]),
    (error) => {
      const result = JSON.parse(error.stdout);
      assert.equal(result.error.code, "INVALID_INPUT");
      assert.match(result.error.message, /--yes/);
      return true;
    },
  );
  assert.equal(requests.filter((item) => item.url === "/api/setHostSettings").length, beforeCount);

  const { stdout } = await run(["provider", "set", "codex", "--yes"]);
  assert.equal(JSON.parse(stdout).ok, true);
  const dispatched = requests.findLast((item) => item.url === "/api/setHostSettings");
  assert.deepEqual(JSON.parse(dispatched.body), { inferenceProvider: "codex" });
});

test("ergonomic attachment upload streams a local file through the exact gateway method", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-cli-attachment-"));
  try {
    const filePath = path.join(temporary, "local.bin");
    const bytes = Buffer.from([0, 1, 2, 3, 4, 5, 6]);
    await writeFile(filePath, bytes);
    const { stdout } = await run([
      "attachment",
      "upload",
      filePath,
      "--filename",
      "remote.mp4",
      "--agent-id",
      "agent-one",
    ]);
    const result = JSON.parse(stdout);
    assert.equal(result.ok, true);
    assert.equal(result.command, "attachment:upload");
    assert.equal(result.meta.transport, "capability-negotiated-stream");
    const dispatched = requests.findLast((item) => item.url === "/api/uploadAttachment");
    assert.deepEqual(JSON.parse(dispatched.body), {
      filename: "remote.mp4",
      bytesBase64: bytes.toString("base64"),
      agentId: "agent-one",
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("host upgrade preparation requires confirmation before touching the gateway", async () => {
  const beforeCount = requests.length;
  await assert.rejects(
    run(["prepare-upgrade"]),
    (error) => {
      assert.equal(error.code, 1);
      const result = JSON.parse(error.stdout);
      assert.equal(result.error.code, "INVALID_INPUT");
      assert.match(result.error.message, /--yes/);
      return true;
    },
  );
  assert.equal(requests.length, beforeCount);
});

test("event mode emits a subscription result followed by bounded NDJSON events", async () => {
  const { stdout } = await run(["events", "--count", "1", "transcript"]);
  const frames = stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(frames.length, 2);
  assert.equal(frames[0].type, "result");
  assert.equal(frames[1].type, "event");
  assert.equal(frames[1].channel, "transcript");
  assert.deepEqual(frames[1].data, { kind: "test-event" });
});

test("event mode remains compact NDJSON under pretty and raw one-shot preferences", async () => {
  for (const output of ["pretty", "raw"]) {
    const { stdout } = await run(["--output", output, "events", "--count", "1", "transcript"]);
    const lines = stdout.trim().split("\n");
    assert.equal(lines.length, 2, `${output} event mode must emit exactly two lines`);
    const frames = lines.map((line) => JSON.parse(line));
    assert.equal(frames[0].type, "result");
    assert.equal(frames[1].type, "event");
  }
});

test("stdio RPC is versioned, strict, and shuts down cleanly", async () => {
  const child = spawn(process.execPath, [cliPath, "--url", baseUrl, "rpc", "--stdio"], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity, terminal: false });
  const iterator = reader[Symbol.asyncIterator]();
  const frame = (value) => child.stdin.write(`${JSON.stringify({ protocol, protocolVersion: 1, ...value })}\n`);
  const ready = JSON.parse((await iterator.next()).value);
  assert.equal(ready.type, "ready");
  assert.equal(ready.capabilities.maxInputFrameBytes, 40 * 1024 * 1024);
  assert.equal(ready.capabilities.maxOutputFrameBytes, 40 * 1024 * 1024);
  assert.equal(ready.capabilities.maxActiveRequests, 2);
  assert.equal(ready.capabilities.maxActiveRequestBytes, 64 * 1024 * 1024);
  assert.equal(ready.capabilities.maxActiveOutputBytes, 128 * 1024 * 1024);
  assert.equal(ready.capabilities.maxGatewayResponseBytes, 64 * 1024 * 1024);
  assert.equal(ready.capabilities.maxSseEventBytes, 16 * 1024 * 1024);
  assert.equal(ready.capabilities.maxActiveSseBufferBytes, 64 * 1024 * 1024);

  frame({ type: "request", id: "🧪".repeat(65), method: "grok.ping" });
  const oversizedId = JSON.parse((await iterator.next()).value);
  assert.equal(oversizedId.type, "protocol-error");
  assert.equal(oversizedId.id, null);
  assert.match(oversizedId.error.message, /256 bytes/);

  frame({ type: "request", id: "ping-1", method: "grok.ping" });
  const ping = JSON.parse((await iterator.next()).value);
  assert.equal(ping.id, "ping-1");
  assert.equal(ping.ok, true);

  frame({ type: "request", id: "services-1", method: "grok.services.list" });
  const services = JSON.parse((await iterator.next()).value);
  assert.equal(services.id, "services-1");
  assert.equal(services.result.liveDiscovery, true);
  assert.deepEqual(services.result.capabilities, ["gatewayServicesV1"]);
  assert.equal(services.result.services.find((item) => item.name === "listAgents").advertised, true);
  assert.deepEqual(services.result.liveExtras, []);

  frame({ type: "shutdown", id: "shutdown-1" });
  const tail = [];
  while (!tail.some((item) => item.type === "session-end")) {
    const next = await iterator.next();
    if (next.done) break;
    tail.push(JSON.parse(next.value));
  }
  const [code] = await new Promise((resolve) => child.once("close", (...args) => resolve(args)));
  reader.close();
  assert.equal(code, 0);
  assert.ok(tail.some((item) => item.id === "shutdown-1" && item.ok === true));
  assert.equal(tail.at(-1).type, "session-end");
  assert.equal(tail.at(-1).reason, "shutdown");
});

test("RPC open-SSE subscriptions reject duplicates and stop on unsubscribe, shutdown, and EOF", async () => {
  const within = async (promise, message) => {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(message)), 4_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const openSession = async () => {
    const child = spawn(process.execPath, [cliPath, "--url", baseUrl, "rpc", "--stdio"], {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const reader = createInterface({ input: child.stdout, crlfDelay: Infinity, terminal: false });
    const iterator = reader[Symbol.asyncIterator]();
    const next = async () => {
      const value = await within(iterator.next(), "Timed out waiting for RPC subscription frame.");
      if (value.done) throw new Error("RPC stdout ended before the expected subscription frame.");
      return JSON.parse(value.value);
    };
    const send = (value) => child.stdin.write(`${JSON.stringify({ protocol, protocolVersion: 1, ...value })}\n`);
    assert.equal((await next()).type, "ready");
    return { child, reader, next, send };
  };
  const nextMatching = async (session, predicate, maximum = 20) => {
    const observed = [];
    for (let index = 0; index < maximum; index += 1) {
      const frame = await session.next();
      observed.push(frame);
      if (predicate(frame)) return { frame, observed };
    }
    assert.fail(`RPC frame predicate was not met: ${JSON.stringify(observed)}`);
  };

  const explicit = await openSession();
  try {
    explicit.send({
      type: "request",
      id: "subscribe-open",
      method: "grok.subscribe",
      params: { subscriptionId: "open-subscription", channels: ["transcript"] },
    });
    const subscribed = await nextMatching(explicit, (frame) => frame.id === "subscribe-open");
    assert.equal(subscribed.frame.ok, true);
    assert.equal(subscribed.frame.result.subscriptionId, "open-subscription");

    explicit.send({
      type: "request",
      id: "subscribe-duplicate",
      method: "grok.subscribe",
      params: { subscriptionId: "open-subscription", channels: ["transcript"] },
    });
    const duplicate = await nextMatching(explicit, (frame) => frame.id === "subscribe-duplicate");
    assert.equal(duplicate.frame.ok, false);
    assert.equal(duplicate.frame.error.code, "INVALID_INPUT");
    assert.match(duplicate.frame.error.message, /already active/);

    explicit.send({
      type: "request",
      id: "unsubscribe-open",
      method: "grok.unsubscribe",
      params: { subscriptionId: "open-subscription" },
    });
    const untilUnsubscribed = [];
    while (!untilUnsubscribed.some((frame) => frame.id === "unsubscribe-open")
      || !untilUnsubscribed.some((frame) => frame.type === "subscription-end")) {
      untilUnsubscribed.push(await explicit.next());
    }
    const subscriptionEnd = untilUnsubscribed.find((frame) => frame.type === "subscription-end");
    const unsubscribe = untilUnsubscribed.find((frame) => frame.id === "unsubscribe-open");
    assert.equal(subscriptionEnd.subscriptionId, "open-subscription");
    assert.equal(subscriptionEnd.reason, "unsubscribed");
    assert.equal(unsubscribe.ok, true);
    assert.equal(unsubscribe.result.unsubscribed, true);

    const close = new Promise((resolve) => explicit.child.once("close", (code, signal) => resolve({ code, signal })));
    explicit.send({ type: "shutdown", id: "shutdown-after-unsubscribe" });
    const shutdownFrames = [];
    while (!shutdownFrames.some((frame) => frame.type === "session-end")) {
      shutdownFrames.push(await explicit.next());
    }
    const exited = await within(close, "RPC did not exit after shutdown.");
    assert.deepEqual(exited, { code: 0, signal: null });
    assert.ok(shutdownFrames.some((frame) => frame.id === "shutdown-after-unsubscribe" && frame.ok === true));
    assert.equal(shutdownFrames.at(-1).reason, "shutdown");
  } finally {
    explicit.reader.close();
    if (explicit.child.exitCode === null && explicit.child.signalCode === null) explicit.child.kill("SIGKILL");
  }

  const eof = await openSession();
  try {
    eof.send({
      type: "request",
      id: "subscribe-before-eof",
      method: "grok.subscribe",
      params: { subscriptionId: "eof-subscription", channels: ["transcript"] },
    });
    assert.equal((await nextMatching(eof, (frame) => frame.id === "subscribe-before-eof")).frame.ok, true);
    const close = new Promise((resolve) => eof.child.once("close", (code, signal) => resolve({ code, signal })));
    eof.child.stdin.end();
    const tail = [];
    while (!tail.some((frame) => frame.type === "session-end")) tail.push(await eof.next());
    const exited = await within(close, "RPC did not exit after stdin EOF.");
    assert.deepEqual(exited, { code: 0, signal: null });
    assert.ok(tail.some((frame) => frame.type === "subscription-end"
      && frame.subscriptionId === "eof-subscription"
      && frame.reason === "eof"));
    assert.equal(tail.at(-1).reason, "eof");
  } finally {
    eof.reader.close();
    if (eof.child.exitCode === null && eof.child.signalCode === null) eof.child.kill("SIGKILL");
  }
});

test("MCP stdio negotiates with OMP framing and filters tools to the live host", async (t) => {
  const child = spawn(process.execPath, [cliPath, "--url", baseUrl, "mcp", "--stdio"], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity, terminal: false });
  t.after(async () => {
    reader.close();
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.stdin.end();
    const closed = new Promise((resolve) => child.once("close", resolve));
    let timeout;
    const timer = new Promise((resolve) => { timeout = setTimeout(resolve, 1_000, "timeout"); });
    const result = await Promise.race([closed, timer]);
    clearTimeout(timeout);
    if (result === "timeout") child.kill("SIGKILL");
  });
  const iterator = reader[Symbol.asyncIterator]();
  const send = (value) => child.stdin.write(`${JSON.stringify(value)}\n`);

  send({
    jsonrpc: "2.0",
    id: "initialize-1",
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "oh-my-pi", version: "test" },
    },
  });
  const initialized = JSON.parse((await iterator.next()).value);
  assert.equal(initialized.id, "initialize-1");
  assert.equal(initialized.result.protocolVersion, "2025-03-26");
  assert.equal(initialized.result.capabilities.tools.listChanged, true);
  assert.deepEqual(initialized.result.capabilities.experimental.grokBotTransportLimits, {
    maxInputFrameBytes: 40 * 1024 * 1024,
    maxOutputFrameBytes: 40 * 1024 * 1024,
    maxGatewayResponseBytes: 64 * 1024 * 1024,
    maxActiveRequests: 2,
    maxActiveRequestBytes: 64 * 1024 * 1024,
    maxActiveOutputBytes: 128 * 1024 * 1024,
  });

  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  send({ jsonrpc: "2.0", id: "tools-1", method: "tools/list", params: {} });
  const listed = JSON.parse((await iterator.next()).value);
  assert.equal(listed.id, "tools-1");
  assert.deepEqual(listed.result.tools.map((tool) => tool.name).sort(), ["listGatewayServices"]);
  assert.ok(listed.result.tools.every((tool) => tool.annotations.readOnlyHint === true));

  const hiddenDispatches = requests.filter((item) => item.url === "/api/getAuthStatus").length;
  send({
    jsonrpc: "2.0",
    id: "hidden-call-1",
    method: "tools/call",
    params: { name: "getAuthStatus", arguments: {} },
  });
  const hidden = JSON.parse((await iterator.next()).value);
  assert.equal(hidden.id, "hidden-call-1");
  assert.equal(hidden.error.code, -32602);
  assert.match(hidden.error.message, /unknown|unavailable/i);
  assert.equal(requests.filter((item) => item.url === "/api/getAuthStatus").length, hiddenDispatches);

  send({ jsonrpc: "2.0", id: 1.5, method: "ping" });
  const fractionalId = JSON.parse((await iterator.next()).value);
  assert.equal(fractionalId.id, null);
  assert.equal(fractionalId.error.code, -32600);

  send({ jsonrpc: "2.0", id: "tools-1", method: "ping" });
  const reusedId = JSON.parse((await iterator.next()).value);
  assert.equal(reusedId.id, "tools-1");
  assert.equal(reusedId.error.code, -32600);
  assert.match(reusedId.error.message, /may not be reused/);

  child.stdin.end();
  const [code] = await new Promise((resolve) => child.once("close", (...args) => resolve(args)));
  reader.close();
  assert.equal(code, 0);
});

test("MCP refreshes tools/list and emits list_changed without a stale service 404", async () => {
  const child = spawn(process.execPath, [cliPath, "--url", baseUrl, "mcp", "--stdio", "--include-sensitive"], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity, terminal: false });
  const iterator = reader[Symbol.asyncIterator]();
  const send = (value) => child.stdin.write(`${JSON.stringify(value)}\n`);
  try {
    send({
      jsonrpc: "2.0",
      id: "initialize-change",
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    });
    assert.equal(JSON.parse((await iterator.next()).value).id, "initialize-change");
    send({ jsonrpc: "2.0", id: "tools-before", method: "tools/list", params: {} });
    const before = JSON.parse((await iterator.next()).value);
    assert.ok(before.result.tools.some((tool) => tool.name === "listAgents"));

    const listAgentDispatches = requests.filter((item) => item.url === "/api/listAgents").length;
    gatewayMethods = ["createAgent", "deleteAgents", "listGatewayServices", "sendPrompt", "setHostSettings"];
    const changedLine = await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("timed out waiting for proactive tools/list_changed")),
        8_000,
      );
      iterator.next().then(
        (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      );
    });
    const changed = JSON.parse(changedLine.value);
    assert.equal(changed.method, "notifications/tools/list_changed");

    send({
      jsonrpc: "2.0",
      id: "removed-call",
      method: "tools/call",
      params: { name: "listAgents", arguments: {} },
    });
    const removed = JSON.parse((await iterator.next()).value);
    assert.equal(removed.id, "removed-call");
    assert.equal(removed.result.isError, true);

    send({ jsonrpc: "2.0", id: "tools-after", method: "tools/list", params: {} });
    const afterList = JSON.parse((await iterator.next()).value);
    assert.equal(afterList.id, "tools-after");
    assert.equal(afterList.result.tools.some((tool) => tool.name === "listAgents"), false);
    assert.equal(
      requests.filter((item) => item.url === "/api/listAgents").length,
      listAgentDispatches,
      "manifest changes must not require provoking a removed service",
    );

    gatewayManifestStatus = 503;
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    send({ jsonrpc: "2.0", id: "tools-during-outage", method: "tools/list", params: {} });
    const duringOutage = JSON.parse((await iterator.next()).value);
    assert.equal(duringOutage.id, "tools-during-outage");
    assert.equal(duringOutage.result.tools.some((tool) => tool.name === "listAgents"), false);
  } finally {
    gatewayManifestStatus = 200;
    gatewayMethods = ["createAgent", "deleteAgents", "listAgents", "listGatewayServices", "sendPrompt", "setHostSettings", "uploadAttachment"];
    child.stdin.end();
    const [code] = await new Promise((resolve) => child.once("close", (...args) => resolve(args)));
    reader.close();
    assert.equal(code, 0);
  }
});

test("MCP rejects malformed destructive tool arguments before any gateway POST", async (t) => {
  const beforeCount = requests.filter((item) => item.url === "/api/deleteAgents").length;
  const child = spawn(process.execPath, [
    cliPath,
    "--url",
    baseUrl,
    "mcp",
    "--stdio",
    "--include-destructive",
    "--include-sensitive",
  ], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity, terminal: false });
  const iterator = reader[Symbol.asyncIterator]();
  const send = (value) => child.stdin.write(`${JSON.stringify(value)}\n`);
  const closed = new Promise((resolve) => child.once("close", (...args) => resolve(args)));
  t.after(async () => {
    if (child.exitCode === null) child.stdin.end();
    await closed;
    reader.close();
  });

  send({
    jsonrpc: "2.0",
    id: "initialize-delete",
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } },
  });
  assert.equal(JSON.parse((await iterator.next()).value).id, "initialize-delete");
  send({
    jsonrpc: "2.0",
    id: "invalid-delete",
    method: "tools/call",
    params: { name: "deleteAgents", arguments: { ids: "agent-one" } },
  });
  const rejected = JSON.parse((await iterator.next()).value);
  assert.equal(rejected.id, "invalid-delete");
  assert.equal(rejected.error.code, -32602);
  assert.match(rejected.error.message, /Invalid arguments for deleteAgents/);
  assert.equal(requests.filter((item) => item.url === "/api/deleteAgents").length, beforeCount);

  child.stdin.end();
  const [code] = await closed;
  assert.equal(code, 0);
});

test("MCP sendPrompt forbids host attachment paths without the sensitive gate", async () => {
  const beforeCount = requests.filter((item) => item.url === "/api/sendPrompt").length;
  const child = spawn(process.execPath, [
    cliPath,
    "--url",
    baseUrl,
    "mcp",
    "--stdio",
    "--include-writes",
  ], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity, terminal: false });
  const iterator = reader[Symbol.asyncIterator]();
  const send = (value) => child.stdin.write(`${JSON.stringify(value)}\n`);

  send({
    jsonrpc: "2.0",
    id: "initialize-prompt",
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } },
  });
  assert.equal(JSON.parse((await iterator.next()).value).id, "initialize-prompt");
  send({
    jsonrpc: "2.0",
    id: "unsafe-prompt-path",
    method: "tools/call",
    params: {
      name: "sendPrompt",
      arguments: {
        agentId: "agent-one",
        prompt: "inspect this",
        attachmentPaths: ["/etc/passwd"],
      },
    },
  });
  const rejected = JSON.parse((await iterator.next()).value);
  assert.equal(rejected.id, "unsafe-prompt-path");
  assert.equal(rejected.error.code, -32602);
  assert.match(rejected.error.message, /attachmentPaths/);
  assert.equal(requests.filter((item) => item.url === "/api/sendPrompt").length, beforeCount);

  child.stdin.end();
  const [code] = await new Promise((resolve) => child.once("close", (...args) => resolve(args)));
  reader.close();
  assert.equal(code, 0);
});

test("MCP parse errors never reflect malformed secret-bearing input", async () => {
  const child = spawn(process.execPath, [cliPath, "--url", baseUrl, "mcp", "--stdio"], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity, terminal: false });
  const iterator = reader[Symbol.asyncIterator]();
  const secret = "DO_NOT_REFLECT_THIS_SECRET_9c7b";
  child.stdin.write(`{"jsonrpc":"2.0","token":"${secret}",]\n`);
  const rejectedLine = (await iterator.next()).value;
  const rejected = JSON.parse(rejectedLine);
  assert.equal(rejected.error.code, -32700);
  assert.equal(rejected.error.message, "Parse error");
  assert.equal("data" in rejected.error, false);
  assert.equal(rejectedLine.includes(secret), false);

  child.stdin.end();
  const [code] = await new Promise((resolve) => child.once("close", (...args) => resolve(args)));
  reader.close();
  assert.equal(code, 0);
});

test("default MCP tool failures do not disclose gateway discovery paths", async () => {
  const temporaryHome = await mkdtemp(path.join(os.tmpdir(), "grok-mcp-private-home-"));
  const child = spawn(process.execPath, [cliPath, "mcp", "--stdio"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: temporaryHome,
      USERPROFILE: temporaryHome,
      GROK_BOT_GATEWAY_URL: "",
      SAND_HOST_GATEWAY_URL: "",
      GROK_BOT_GATEWAY_TOKEN: "",
      SAND_HOST_GATEWAY_TOKEN: "",
      GROK_BOT_GATEWAY_DISCOVERY: "",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity, terminal: false });
  const iterator = reader[Symbol.asyncIterator]();
  const send = (value) => child.stdin.write(`${JSON.stringify(value)}\n`);
  try {
    send({
      jsonrpc: "2.0",
      id: "initialize-private-home",
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    });
    assert.equal(JSON.parse((await iterator.next()).value).id, "initialize-private-home");
    send({
      jsonrpc: "2.0",
      id: "private-failure",
      method: "tools/call",
      params: { name: "countAgents", arguments: {} },
    });
    const line = (await iterator.next()).value;
    const response = JSON.parse(line);
    assert.equal(response.id, "private-failure");
    assert.equal(response.result.isError, true);
    assert.equal(response.result.structuredContent.error.code, "CLI_CONFIG");
    assert.equal(response.result.structuredContent.error.message, "Grok Bot gateway configuration is unavailable.");
    assert.equal("path" in response.result.structuredContent.error, false);
    assert.equal(line.includes(temporaryHome), false);
    assert.equal(line.includes("/.cursor/"), false);
    assert.equal(line.includes("gateway.json"), false);
  } finally {
    child.stdin.end();
    await new Promise((resolve) => child.once("close", resolve));
    reader.close();
    await rm(temporaryHome, { recursive: true, force: true });
  }
});

test("direct named NDJSON RPC validates known services before dispatch", async () => {
  const beforeCount = requests.filter((item) => item.url === "/api/deleteAgents").length;
  const child = spawn(process.execPath, [cliPath, "--url", baseUrl, "rpc", "--stdio"], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity, terminal: false });
  const iterator = reader[Symbol.asyncIterator]();
  const ready = JSON.parse((await iterator.next()).value);
  assert.equal(ready.type, "ready");
  child.stdin.write(`${JSON.stringify({
    protocol,
    protocolVersion: 1,
    type: "request",
    id: "invalid-delete-rpc",
    method: "deleteAgents",
    params: { ids: "agent-one" },
  })}\n`);
  const rejected = JSON.parse((await iterator.next()).value);
  assert.equal(rejected.id, "invalid-delete-rpc");
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, "INVALID_INPUT");
  assert.equal(requests.filter((item) => item.url === "/api/deleteAgents").length, beforeCount);

  child.stdin.write(`${JSON.stringify({
    protocol,
    protocolVersion: 1,
    type: "request",
    id: "invalid-delete-grok-call",
    method: "grok.call",
    params: { method: "deleteAgents", args: { ids: "agent-one" } },
  })}\n`);
  const rawKnownRejected = JSON.parse((await iterator.next()).value);
  assert.equal(rawKnownRejected.id, "invalid-delete-grok-call");
  assert.equal(rawKnownRejected.ok, false);
  assert.equal(rawKnownRejected.error.code, "INVALID_INPUT");
  assert.equal(requests.filter((item) => item.url === "/api/deleteAgents").length, beforeCount);

  child.stdin.write(`${JSON.stringify({
    protocol,
    protocolVersion: 1,
    type: "shutdown",
    id: "shutdown-after-invalid",
  })}\n`);
  const shutdown = JSON.parse((await iterator.next()).value);
  assert.equal(shutdown.id, "shutdown-after-invalid");
  const ended = JSON.parse((await iterator.next()).value);
  assert.equal(ended.type, "session-end");
  const [code] = await new Promise((resolve) => child.once("close", (...args) => resolve(args)));
  reader.close();
  assert.equal(code, 0);
});

test("MCP rejects oversized UTF-8 request IDs without retaining or echoing them", async () => {
  const child = spawn(process.execPath, [cliPath, "--url", baseUrl, "mcp", "--stdio"], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity, terminal: false });
  const iterator = reader[Symbol.asyncIterator]();
  const send = (value) => child.stdin.write(`${JSON.stringify(value)}\n`);

  send({
    jsonrpc: "2.0",
    id: "🧪".repeat(65),
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } },
  });
  const rejected = JSON.parse((await iterator.next()).value);
  assert.equal(rejected.id, null);
  assert.equal(rejected.error.code, -32600);
  assert.match(rejected.error.message, /256 bytes/);

  send({
    jsonrpc: "2.0",
    id: Number.MAX_SAFE_INTEGER + 1,
    method: "ping",
  });
  const unsafeNumber = JSON.parse((await iterator.next()).value);
  assert.equal(unsafeNumber.id, null);
  assert.equal(unsafeNumber.error.code, -32600);

  send({
    jsonrpc: "2.0",
    id: Number.MAX_SAFE_INTEGER,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } },
  });
  const initialized = JSON.parse((await iterator.next()).value);
  assert.equal(initialized.id, Number.MAX_SAFE_INTEGER);
  assert.equal(initialized.result.protocolVersion, "2025-03-26");

  child.stdin.end();
  const [code] = await new Promise((resolve) => child.once("close", (...args) => resolve(args)));
  reader.close();
  assert.equal(code, 0);
});

test("stdio protocol startup failures never contaminate stdout with CLI envelopes", async () => {
  for (const args of [
    ["--timeout-ms", "0", "mcp", "--stdio"],
    ["mcp", "--stdio", "--allow-unknown-raw"],
    ["mcp", "--stdio", "--unsafe-human-actions"],
    ["mcp", "--stdio", "--max-output-message-bytes", "2047"],
    ["mcp", "--stdio", "--max-output-message-bytes", String(65 * 1024 * 1024)],
  ]) {
    await assert.rejects(
      run(args),
      (error) => {
        assert.equal(error.code, 1);
        assert.equal(error.stdout, "");
        assert.match(error.stderr, /^mcp: INVALID_INPUT:/);
        return true;
      },
    );
  }
});

test("MCP and RPC exit promptly when stdout closes while stdin remains open", async () => {
  for (const protocolCommand of ["mcp", "rpc"]) {
    const child = spawn(process.execPath, [cliPath, "--url", baseUrl, protocolCommand, "--stdio"], {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdin.on("error", () => {});
    const reader = createInterface({ input: child.stdout, crlfDelay: Infinity, terminal: false });
    const iterator = reader[Symbol.asyncIterator]();
    if (protocolCommand === "mcp") {
      child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: "initialize-before-close",
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } },
      })}\n`);
      assert.equal(JSON.parse((await iterator.next()).value).id, "initialize-before-close");
    } else {
      assert.equal(JSON.parse((await iterator.next()).value).type, "ready");
    }
    reader.close();
    child.stdout.destroy();
    const detachedRequest = protocolCommand === "mcp"
      ? { jsonrpc: "2.0", id: "closed-output", method: "ping" }
      : {
        protocol,
        protocolVersion: 1,
        type: "request",
        id: "closed-output",
        method: "grok.ping",
      };
    child.stdin.write(`${JSON.stringify(detachedRequest)}\n`);

    const exited = await Promise.race([
      new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal }))),
      new Promise((resolve) => setTimeout(() => resolve(null), 4_000)),
    ]);
    if (exited === null) {
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("close", resolve));
      assert.fail(`${protocolCommand} did not exit after terminal stdout failure`);
    }
    assert.equal(exited.signal, null);
    assert.equal(exited.code, 0, `${protocolCommand} should treat terminal stdout closure as a clean session end`);
    assert.doesNotMatch(stderr, /\n\s+at\s|FiberFailure|Unhandled.*EPIPE/i);
  }
});
