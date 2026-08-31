import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule(entry) {
  const temporary = await mkdtemp(path.join(repoRoot, ".grok-host-behavior-"));
  const output = path.join(temporary, "module.mjs");
  await build({
    entryPoints: [path.join(repoRoot, entry)],
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

function createGateway(module, { transcript = {}, management = {}, automations = {} } = {}) {
  const inert = {};
  const extensions = {
    transcript,
    mcp: { management },
    automations,
    telemetry: { analytics: inert, logs: inert },
  };
  return module.createHostGatewayApi({
    extensions: { api: id => extensions[id] ?? inert },
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

test("completeMcpOAuth maps the coordinator callback to the backend completion port", async () => {
  const loaded = await loadModule("source/host/host-gateway-api.ts");
  try {
    const calls = [];
    const api = createGateway(loaded.module, {
      management: {
        async completeOAuth(args) {
          calls.push(args);
        },
      },
    });

    assert.equal(await api.completeMcpOAuth({ code: " oauth-code ", state: " state-7 " }), undefined);
    assert.deepEqual(calls, [{ stateId: "state-7", code: "oauth-code" }]);
    await assert.rejects(api.completeMcpOAuth({ state: "state-7" }), /'code' is required/);
    await assert.rejects(api.completeMcpOAuth({ code: "code", state: 7 }), /'state' must be a string/);
  } finally {
    await loaded.dispose();
  }
});

test("refreshChannel reconciles the requested supported platform before returning state", async () => {
  const loaded = await loadModule("source/host/host-gateway-api.ts");
  try {
    const calls = [];
    const view = {
      manifests: [{ platform: "slack" }, { platform: "github" }],
      connections: [{ platform: "slack" }],
    };
    const api = createGateway(loaded.module, {
      automations: {
        async getAgentChannels(id) {
          calls.push(["get", id]);
          return view;
        },
        async reconcileNow() {
          calls.push(["reconcile"]);
        },
      },
    });

    assert.strictEqual(await api.refreshChannel({ id: "agent-9", platform: "slack" }), view);
    assert.deepEqual(calls, [["get", "agent-9"], ["reconcile"], ["get", "agent-9"]]);
    await assert.rejects(
      api.refreshChannel({ id: "agent-9", platform: "email" }),
      /Unsupported channel platform/,
    );
    assert.deepEqual(calls.at(-1), ["get", "agent-9"]);
  } finally {
    await loaded.dispose();
  }
});

test("host MCP management completes OAuth through the real backend-exec boundary", async () => {
  const loaded = await loadModule("source/host/extensions/mcp/mcp-service.ts");
  const hosts = [];
  try {
    const calls = [];
    const host = loaded.module.createHostMcp({
      backendMcpExec: {
        async completeOAuth(args) {
          calls.push(args);
        },
      },
      getMachineId: async () => "machine-1",
      log() {},
    });
    hosts.push(host);
    await host.management.completeOAuth({ stateId: "state-1", code: "code-1" });
    assert.deepEqual(calls, [{ stateId: "state-1", code: "code-1" }]);

    const unavailable = loaded.module.createHostMcp({
      backendMcpExec: {},
      getMachineId: async () => "machine-1",
      log() {},
    });
    hosts.push(unavailable);
    await assert.rejects(
      unavailable.management.completeOAuth({ stateId: "state-1", code: "code-1" }),
      /OAuth completion is unavailable/,
    );
  } finally {
    await Promise.all(hosts.map(host => host.dispose()));
    await loaded.dispose();
  }
});

test("setAgentNotificationsEnabled reaches the transcript notification lifecycle", async () => {
  const loaded = await loadModule("source/host/host-gateway-api.ts");
  try {
    const calls = [];
    const api = createGateway(loaded.module, {
      transcript: {
        async setAgentNotificationsEnabled(id, enabled) {
          calls.push([id, enabled]);
        },
      },
    });

    assert.equal(
      await api.setAgentNotificationsEnabled({ id: " agent-9 ", isEnabled: false }),
      undefined,
    );
    assert.deepEqual(calls, [["agent-9", false]]);
    assert.throws(
      () => api.setAgentNotificationsEnabled({ id: "agent-9", isEnabled: "no" }),
      /'isEnabled' must be a boolean/,
    );
    for (const id of ["../escape", "/tmp/escape", "agent/escape", "agent\\escape"]) {
      assert.throws(
        () => api.setAgentNotificationsEnabled({ id, isEnabled: true }),
        /Invalid Sand agent id/,
      );
    }
    assert.deepEqual(calls, [["agent-9", false]]);
  } finally {
    await loaded.dispose();
  }
});

test("notification enablement persists the live notification gate and emits a roster update", async () => {
  const [lifecycleModule, sessionModule, summariesModule] = await Promise.all([
    loadModule("source/host/extensions/transcript/agent-lifecycle.ts"),
    loadModule("source/host/extensions/session/agent-session.ts"),
    loadModule("source/host/extensions/session/session-summaries.ts"),
  ]);
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-agent-notifications-"));
  try {
    const store = new sessionModule.module.SandAgentSessionStore(root);
    for (const id of ["../escape", "/tmp/escape", "agent/escape", "agent\\escape"]) {
      assert.throws(() => store.getAgentDir(id), /Invalid Sand agent id/);
      assert.throws(() => store.setSessionNotificationsEnabled(id, true), /Invalid Sand agent id/);
    }
    store.setSessionNotificationsEnabled("agent-9", false);
    const settings = JSON.parse(
      await readFile(path.join(root, "agent-9", "settings.json"), "utf8"),
    );
    assert.equal(settings.notifyOnAgentUpdates, false);
    const summary = summariesModule.module.minimalAgentSummary({
      dirName: "agent-9",
      dbPath: path.join(root, "agent-9", "transcript.db"),
    });
    assert.equal(summary.notificationsEnabled, false);
    assert.equal(summary.notifyOnUpdatesEnabled, false);

    const calls = [];
    const lifecycle = new lifecycleModule.module.AgentLifecycle({
      sessionStore: {
        setSessionNotificationsEnabled(id, enabled) {
          calls.push(["persist", id, enabled]);
        },
      },
      roster: {
        async emitAgentUpdate(id) {
          calls.push(["emit", id]);
        },
      },
    });
    await lifecycle.setAgentNotificationsEnabled("agent-9", true);
    assert.deepEqual(calls, [
      ["persist", "agent-9", true],
      ["emit", "agent-9"],
    ]);
  } finally {
    await Promise.all([
      lifecycleModule.dispose(),
      sessionModule.dispose(),
      summariesModule.dispose(),
      rm(root, { recursive: true, force: true }),
    ]);
  }
});
