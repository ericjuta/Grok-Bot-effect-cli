import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PNG_1X1_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function loadModule() {
  const temporary = await mkdtemp(path.join(repoRoot, ".grok-gateway-avatar-upload-"));
  const output = path.join(temporary, "host-gateway.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/host/host-gateway-api.ts")],
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

function createGateway(module, transcript) {
  const inert = {};
  return module.createHostGatewayApi({
    extensions: { api: id => id === "transcript" ? transcript : inert },
    hostEvents: { emit() {} },
    decorateForeverBoxStatus: value => value,
    getHealth: () => ({ isBusy: false }),
    kickstartIfPending: async () => false,
    requestDiskSaverAudit: async () => false,
    releaseAgentBox: async () => {},
    handleDesktopMcpAuthCompletion: async () => {},
    forgetLocalToolPermission() {},
  });
}

test("avatar gateway accepts only bounded complete PNG base64", async () => {
  const loaded = await loadModule();
  try {
    const expected = Buffer.from(PNG_1X1_BASE64, "base64");
    assert.deepEqual(Buffer.from(loaded.module.decodeGatewayAvatarPng(PNG_1X1_BASE64)), expected);
    const urlSafe = PNG_1X1_BASE64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    assert.deepEqual(Buffer.from(loaded.module.decodeGatewayAvatarPng(urlSafe)), expected);

    assert.throws(() => loaded.module.decodeGatewayAvatarPng("not base64"), /canonical base64/);
    assert.throws(
      () => loaded.module.decodeGatewayAvatarPng(Buffer.from("not a png").toString("base64")),
      /complete PNG/,
    );
    assert.throws(
      () => loaded.module.decodeGatewayAvatarPng(PNG_1X1_BASE64.slice(0, -12)),
      /complete PNG|canonical base64/,
    );

    const hugeDimensions = Buffer.from(expected);
    hugeDimensions.writeUInt32BE(loaded.module.GATEWAY_AVATAR_MAX_DIMENSION + 1, 16);
    assert.throws(
      () => loaded.module.decodeGatewayAvatarPng(hugeDimensions.toString("base64")),
      /dimensions exceed/,
    );
  } finally {
    await loaded.dispose();
  }
});

test("setAgentAvatarBytes validates before delegating and preserves explicit clear", async () => {
  const loaded = await loadModule();
  try {
    const calls = [];
    const api = createGateway(loaded.module, {
      setAgentAvatarBytes(id, bytes) {
        calls.push({ id, bytes });
        return { id };
      },
    });

    assert.deepEqual(await api.setAgentAvatarBytes({ id: "agent-1", pngBase64: PNG_1X1_BASE64 }), { id: "agent-1" });
    assert.deepEqual(Buffer.from(calls[0].bytes), Buffer.from(PNG_1X1_BASE64, "base64"));
    assert.deepEqual(await api.setAgentAvatarBytes({ id: "agent-1", pngBase64: null }), { id: "agent-1" });
    assert.equal(calls[1].bytes, null);

    assert.throws(() => api.setAgentAvatarBytes({ id: "agent-1" }), /pngBase64.*required/);
    assert.throws(() => api.setAgentAvatarBytes({ id: "agent-1", pngBase64: "AAAA" }), /complete PNG/);
    assert.equal(calls.length, 2);
  } finally {
    await loaded.dispose();
  }
});
