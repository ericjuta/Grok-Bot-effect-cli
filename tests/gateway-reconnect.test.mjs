import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";
import { Effect, Stream } from "effect";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadGatewayModule(temporary) {
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
  return import(`${pathToFileURL(output).href}?${Date.now()}`);
}

function json(response, value, status = 200) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
}

test("event reconnects invalidate cached discovery, endpoint, token, and services", async () => {
  const temporary = await mkdtemp(path.join(repoRoot, ".grok-gateway-reconnect-"));
  const discoveryPath = path.join(temporary, "gateway.json");
  const startedOne = Date.now();
  const startedTwo = startedOne + 1;
  let portTwo;
  let secondEventConnections = 0;

  const serverTwo = createServer((request, response) => {
    if (request.url === "/health") {
      json(response, { ok: true, pid: process.pid, startedAt: startedTwo });
      return;
    }
    assert.equal(request.headers.authorization, "Bearer token-two");
    if (request.method === "POST" && request.url === "/api/listGatewayServices") {
      json(response, {
        protocolVersion: 2,
        capabilities: ["second-host"],
        methods: ["getAuthStatus", "listGatewayServices"],
      });
      return;
    }
    if (request.method === "GET" && request.url?.startsWith("/events")) {
      secondEventConnections += 1;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ channel: "agents", payload: { host: 2 } })}\n\n`);
      return;
    }
    json(response, { error: "unknown route" }, 404);
  });

  let serverOne;
  try {
    portTwo = await listen(serverTwo);
    serverOne = createServer(async (request, response) => {
      if (request.url === "/health") {
        json(response, { ok: true, pid: process.pid, startedAt: startedOne });
        return;
      }
      assert.equal(request.headers.authorization, "Bearer token-one");
      if (request.method === "POST" && request.url === "/api/listGatewayServices") {
        json(response, {
          protocolVersion: 1,
          capabilities: ["first-host"],
          methods: ["listAgents", "listGatewayServices"],
        });
        return;
      }
      if (request.method === "GET" && request.url?.startsWith("/events")) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ channel: "agents", payload: { host: 1 } })}\n\n`);
        await writeFile(discoveryPath, JSON.stringify({
          host: "127.0.0.1",
          port: portTwo,
          pid: process.pid,
          startedAt: startedTwo,
          token: "token-two",
        }), "utf8");
        response.end();
        return;
      }
      json(response, { error: "unknown route" }, 404);
    });
    const portOne = await listen(serverOne);
    await writeFile(discoveryPath, JSON.stringify({
      host: "127.0.0.1",
      port: portOne,
      pid: process.pid,
      startedAt: startedOne,
      token: "token-one",
    }), "utf8");

    const gatewayModule = await loadGatewayModule(temporary);
    const gateway = gatewayModule.makeGatewayService({
      discoveryPath,
      timeoutMs: 2_000,
      output: "json",
      fullAvatars: false,
      allowInsecureRemote: false,
    });

    const firstServices = await Effect.runPromise(gateway.services);
    assert.equal(firstServices.protocolVersion, 1);
    assert.deepEqual(firstServices.methods, ["listAgents", "listGatewayServices"]);

    const collected = await Effect.runPromise(
      gateway.events(["agents"]).pipe(Stream.take(3), Stream.runCollect),
    );
    const events = Array.from(collected);
    assert.deepEqual(events[0], { channel: "agents", payload: { host: 1 } });
    assert.equal(events[1].channel, "grok.gateway");
    assert.deepEqual(events[1].payload, { kind: "reconnected", possibleGap: true, attempt: 2 });
    assert.deepEqual(events[2], { channel: "agents", payload: { host: 2 } });
    assert.equal(secondEventConnections, 1);

    const secondServices = await Effect.runPromise(gateway.services);
    assert.equal(secondServices.protocolVersion, 2);
    assert.deepEqual(secondServices.methods, ["getAuthStatus", "listGatewayServices"]);
  } finally {
    if (serverOne != null) await close(serverOne);
    await close(serverTwo);
    await rm(temporary, { recursive: true, force: true });
  }
});
