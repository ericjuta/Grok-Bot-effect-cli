import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-gateway-config-"));
  const output = path.join(temporary, "gateway-config.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/host/gateway-config.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

async function loadServerModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-gateway-server-"));
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

test("gateway authentication is mandatory even on loopback", async () => {
  const loaded = await loadModule();
  try {
    let generated = 0;
    const config = loaded.module.resolveGatewayServerConfig({}, () => {
      generated += 1;
      return "generated-loopback-token";
    });
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.authToken, "generated-loopback-token");
    assert.equal(generated, 1);

    const pinned = loaded.module.resolveGatewayServerConfig({
      SAND_GATEWAY_TOKEN: "  pinned-token  ",
      SAND_GATEWAY_REQUIRE_AUTH: "0",
    }, () => {
      throw new Error("pinned token must not be replaced");
    });
    assert.equal(pinned.authToken, "pinned-token");

    assert.throws(
      () => loaded.module.resolveGatewayServerConfig({}, () => ""),
      /empty value/,
    );
  } finally {
    await loaded.dispose();
  }
});

test("health probing crosses the same bearer boundary as gateway commands", async () => {
  const loaded = await loadServerModule();
  const token = "private-health-token";
  const server = await loaded.module.startGatewayServer({
    api: { getAgentAvatar: async () => ({ dataUrl: null, version: null }) },
    subscribe: () => () => {},
    getHealth: () => ({ isBusy: false }),
    startedAt: 123,
    host: "127.0.0.1",
    authToken: token,
  });
  const url = `http://127.0.0.1:${server.port}/health`;
  try {
    const missing = await fetch(url);
    assert.equal(missing.status, 401);
    assert.deepEqual(await missing.json(), { error: "unauthorized" });

    const wrong = await fetch(url, { headers: { authorization: "Bearer wrong" } });
    assert.equal(wrong.status, 401);

    const authorized = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(authorized.status, 200);
    assert.equal((await authorized.json()).ok, true);
  } finally {
    await server.close();
    await loaded.dispose();
  }
});

test("the server refuses to bind without an authentication token", async () => {
  const loaded = await loadServerModule();
  try {
    await assert.rejects(
      loaded.module.startGatewayServer({
        api: { getAgentAvatar: async () => ({ dataUrl: null, version: null }) },
        subscribe: () => () => {},
        getHealth: () => ({ isBusy: false }),
        startedAt: 123,
        host: "127.0.0.1",
      }),
      /authentication token is required/,
    );
  } finally {
    await loaded.dispose();
  }
});

test("malformed gateway requests are client errors without parser or input reflection", async () => {
  const loaded = await loadServerModule();
  const token = "private-command-token";
  const server = await loaded.module.startGatewayServer({
    api: {
      getAgentAvatar: async () => ({ dataUrl: null, version: null }),
      createAgent: async () => {
        throw new Error("createAgent must not run for malformed JSON");
      },
      updateAgent: async () => {
        throw new Error("Malformed updateAgent request: secret-field-value");
      },
    },
    subscribe: () => () => {},
    getHealth: () => ({ isBusy: false }),
    startedAt: 123,
    host: "127.0.0.1",
    authToken: token,
  });
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  try {
    const invalidJson = await fetch(`http://127.0.0.1:${server.port}/api/createAgent`, {
      method: "POST",
      headers,
      body: '{"name":"do-not-reflect-this-secret"',
    });
    assert.equal(invalidJson.status, 400);
    assert.deepEqual(await invalidJson.json(), { error: "invalid gateway request" });

    const invalidShape = await fetch(`http://127.0.0.1:${server.port}/api/updateAgent`, {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(invalidShape.status, 400);
    assert.deepEqual(await invalidShape.json(), { error: "invalid gateway request" });
  } finally {
    await server.close();
    await loaded.dispose();
  }
});

test("gateway error statuses distinguish payload, conflict, and server failures", async () => {
  const loaded = await loadServerModule();
  try {
    assert.equal(loaded.module.statusForCommandError(new loaded.module.SandGatewayRequestError("large", 413)), 413);
    assert.equal(loaded.module.publicMessageForCommandError(new loaded.module.SandGatewayRequestError("large", 413)), "large");
    assert.equal(loaded.module.statusForCommandError(Object.assign(new Error("limit"), { name: "AttachmentTooLargeError" })), 413);
    assert.equal(loaded.module.statusForCommandError(Object.assign(new Error("conflict"), { name: "SandAgentLimitError" })), 409);
    assert.equal(loaded.module.statusForCommandError(Object.assign(new Error("disabled"), { name: "SandCloudAgentDisabledError" })), 403);
    assert.equal(loaded.module.statusForCommandError(Object.assign(new Error("malformed"), { name: "SandCloudAgentLaunchError" })), 400);
    assert.equal(loaded.module.statusForCommandError(new Error("backend secret")), 500);
    assert.equal(loaded.module.publicMessageForCommandError(new Error("backend secret")), "internal gateway error");
  } finally {
    await loaded.dispose();
  }
});
