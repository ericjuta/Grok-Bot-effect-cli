import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule(entry) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-notification-avatar-module-"));
  const output = path.join(temporary, "module.mjs");
  await build({
    entryPoints: [path.join(repoRoot, entry)],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

function createGateway(module, transcript) {
  const inert = {};
  return module.createHostGatewayApi({
    extensions: {
      api(id) {
        return id === "transcript" ? transcript : inert;
      },
    },
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

test("notification avatar returns the exact metadata-only contract", async () => {
  const loaded = await loadModule(
    "source/host/extensions/session/session-profile-files.ts",
  );
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-notification-avatar-data-"));
  try {
    const agentId = "agent-1";
    const agentDir = path.join(root, agentId);
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    await mkdir(agentDir, { recursive: true });
    await writeFile(path.join(agentDir, "profile.json"), JSON.stringify({
      name: "Metadata Bot",
      description: "",
      title: "",
      avatarShape: "leaf",
      avatarColor: "black",
    }));
    await writeFile(path.join(agentDir, "avatar.png"), png);

    const host = {
      getAgentDir: id => path.join(root, id),
      agentExists: () => false,
      withAgentDb: async () => {
        throw new Error("legacy DB fallback should not run for a conventional avatar");
      },
    };
    assert.deepEqual(loaded.module.getAvatarDataUrlCacheUsage(), {
      entries: 0,
      encodedBytes: 0,
      maxEntries: 128,
      maxEncodedBytes: 32 * 1024 * 1024,
    });
    const originalBufferToString = Buffer.prototype.toString;
    let base64Encodings = 0;
    Buffer.prototype.toString = function (...args) {
      if (args[0] === "base64") base64Encodings += 1;
      return originalBufferToString.apply(this, args);
    };
    let result;
    try {
      result = await loaded.module.getAgentNotificationAvatar(host, agentId);
    } finally {
      Buffer.prototype.toString = originalBufferToString;
    }
    assert.deepEqual(result, {
      name: "Metadata Bot",
      shape: "leaf",
      color: "black",
      avatarVersion: createHash("sha256").update(png).digest("hex").slice(0, 16),
      avatarContentType: "image/png",
      avatarByteCount: png.byteLength,
    });
    assert.equal(Object.hasOwn(result, "dataUrl"), false);
    assert.equal(base64Encodings, 0, "metadata-only notification reads must not encode full avatar bytes");
    assert.equal(
      loaded.module.getAvatarDataUrlCacheUsage().entries,
      0,
      "metadata-only notification reads must not populate the data-URL cache",
    );

    const fullAvatar = await loaded.module.getAgentAvatar(host, agentId);
    assert.match(fullAvatar.dataUrl, /^data:image\/png;base64,/);
    assert.equal(
      loaded.module.getAvatarDataUrlCacheUsage().entries,
      1,
      "the cache probe must observe the full-avatar path when it is actually used",
    );
  } finally {
    await Promise.all([
      loaded.dispose(),
      rm(root, { recursive: true, force: true }),
    ]);
  }
});

test("notification avatar fallback shape and color are stable for missing profiles", async () => {
  const loaded = await loadModule(
    "source/host/extensions/session/session-profile-files.ts",
  );
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-notification-avatar-empty-"));
  try {
    const result = await loaded.module.getAgentNotificationAvatar({
      getAgentDir: id => path.join(root, id),
      agentExists: () => false,
      withAgentDb: async () => {
        throw new Error("missing agents must not open a legacy DB");
      },
    }, "agent-1");
    assert.deepEqual(result, {
      name: null,
      shape: "blob",
      color: "cyan",
      avatarVersion: null,
      avatarContentType: null,
      avatarByteCount: null,
    });
  } finally {
    await Promise.all([
      loaded.dispose(),
      rm(root, { recursive: true, force: true }),
    ]);
  }
});

test("gateway publishes and delegates getAgentNotificationAvatar under its exact 0.30 name", async () => {
  const [gatewayApi, protocol] = await Promise.all([
    loadModule("source/host/host-gateway-api.ts"),
    loadModule("source/host/gateway-protocol.ts"),
  ]);
  try {
    const calls = [];
    const expected = {
      name: "Metadata Bot",
      shape: "leaf",
      color: "black",
      avatarVersion: null,
      avatarContentType: null,
      avatarByteCount: null,
    };
    const api = createGateway(gatewayApi.module, {
      getAgentNotificationAvatar(id) {
        calls.push(id);
        return expected;
      },
    });
    const result = await protocol.module.SAND_GATEWAY_COMMANDS
      .getAgentNotificationAvatar(api, JSON.stringify({ id: "agent-1" }));

    assert.strictEqual(result, expected);
    assert.deepEqual(calls, ["agent-1"]);
    for (const id of ["../escape", "/tmp/escape", "agent/escape", "agent\\escape"]) {
      assert.throws(
        () => api.getAgentNotificationAvatar({ id }),
        /Invalid Sand agent id/,
      );
    }
    assert.deepEqual(calls, ["agent-1"]);
    assert.ok(
      protocol.module.SAND_GATEWAY_COMMANDS.listGatewayServices().methods
        .includes("getAgentNotificationAvatar"),
    );
  } finally {
    await Promise.all([gatewayApi.dispose(), protocol.dispose()]);
  }
});
