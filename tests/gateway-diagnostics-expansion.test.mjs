import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule(entry) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-gateway-diagnostics-"));
  const output = path.join(temporary, "module.mjs");
  await build({
    entryPoints: [path.join(repoRoot, entry)],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22"
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

async function loadHostModule() {
  const temporary = await mkdtemp(path.join(repoRoot, ".grok-host-events-"));
  const output = path.join(temporary, "module.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/host/sand-host.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    packages: "external"
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

function createGateway(module, overrides) {
  const inert = {};
  const extensions = {
    transcript: inert,
    auth: inert,
    attachments: inert,
    automations: inert,
    "content-search": inert,
    "local-exec": inert,
    "managed-setup": inert,
    settings: inert,
    "local-tool-permission": inert,
    telemetry: { analytics: inert, logs: inert },
    "cross-user-sharing": inert,
    "turn-execution": inert,
    mcp: { management: inert },
    "cloud-agents": inert,
    ...overrides
  };
  return module.createHostGatewayApi({
    extensions: {
      api(id) {
        return extensions[id] ?? inert;
      }
    },
    hostEvents: { emit() {} },
    decorateForeverBoxStatus: value => value,
    getHealth: () => ({ isBusy: false }),
    kickstartIfPending: async () => false,
    requestDiskSaverAudit: async () => false,
    releaseAgentBox: async () => {},
    handleDesktopMcpAuthCompletion: async () => {},
    forgetLocalToolPermission() {}
  });
}

test("gateway discovery advertises the bounded diagnostics surface", async () => {
  const loaded = await loadModule("source/host/gateway-protocol.ts");
  try {
    const catalog = loaded.module.SAND_GATEWAY_COMMANDS.listGatewayServices();
    assert.ok(catalog.capabilities.includes("gatewayDiagnosticsV1"));
    for (const name of [
      "getAuthStatus",
      "getRuntimeStatus",
      "listLocalComputers",
      "getLocalToolPermissionStatus",
      "getSearchStatus"
    ]) {
      assert.ok(catalog.methods.includes(name), `${name} is discoverable`);
    }
    assert.deepEqual(catalog.methods, [...catalog.methods].sort());

    let permissionArgs;
    await loaded.module.SAND_GATEWAY_COMMANDS.getLocalToolPermissionStatus({
      getLocalToolPermissionStatus(args) {
        permissionArgs = args;
      }
    }, JSON.stringify({ agent_id: "agent-2" }));
    assert.deepEqual(permissionArgs, { agent_id: "agent-2" });
  } finally {
    await loaded.dispose();
  }
});

test("diagnostic methods project only bounded TUI-safe state", async () => {
  const loaded = await loadModule("source/host/host-gateway-api.ts");
  try {
    const pending = {
      id: "ask-1",
      agentId: "agent-2",
      action: "run-command",
      target: "pwd",
      status: "pending",
      createdAtMs: 10,
      expiresAtMs: 20,
      description: "inspect cwd",
      toolCallId: "PRIVATE_TOOL_CALL",
      resourcePath: "/private/internal"
    };
    const permissionLookups = [];
    const api = createGateway(loaded.module, {
      auth: {
        peekAccessToken: () => "ACCESS_SECRET",
        getUserFullName: () => "Ada Lovelace",
        getLastRenewalEvent: () => ({
          outcome: "failed",
          consecutiveFailures: 2,
          durationMs: 13,
          errorSummary: "HTTP 503",
          isFirstCredential: false,
          accessToken: "EVENT_SECRET",
          machineId: "MACHINE_SECRET"
        }),
        getAccessToken() {
          throw new Error("getAuthStatus must not request a token");
        },
        getMachineId() {
          throw new Error("getAuthStatus must not request a machine id");
        }
      },
      transcript: {
        getActiveAgentId: () => "agent-2",
        isAgentCapReached: async () => true,
        liveRunningAgentIds: () => new Set(["agent-2", "agent-1"]),
        getRunQueueDiagnostics: () => [{
          agentId: "agent-2",
          depthUser: 1,
          depthAgent: 0,
          depthBackground: 0,
          depthTotal: 2,
          ackOutstanding: false,
          ackToken: "QUEUE_SECRET",
          active: {
            lane: "user",
            source: "turn",
            runtimeMs: 9,
            phase: "running",
            secret: "ACTIVE_SECRET"
          }
        }],
        hasAgentsWithRunningSubagents: () => true
      },
      "turn-execution": {
        get canExecute() { return true; },
        isRunReady: async () => false
      },
      "local-exec": {
        userComputers: {
          list: () => [{
            id: "desktop-1",
            label: "Work Mac",
            connected: true,
            localRoot: "/private/root",
            accessToken: "COMPUTER_SECRET"
          }]
        }
      },
      "local-tool-permission": {
        permission: () => "ask",
        blockedReason: () => undefined,
        requiresApproval: () => true,
        getPendingRequestForAgent(agentId) {
          permissionLookups.push(["agent", agentId]);
          return pending;
        },
        getPendingRequestById(requestId) {
          permissionLookups.push(["request", requestId]);
          return pending;
        },
        liveApprovalIds: () => ["approval-1"]
      },
      "content-search": {
        isEnabled: () => true,
        get isSearchReady() { return false; },
        maxMatchesPerAgent: 5,
        maxResults: 50
      }
    });

    const authStatus = await api.getAuthStatus();
    assert.deepEqual(authStatus, {
      ready: true,
      userFullName: "Ada Lovelace",
      lastRenewal: {
        outcome: "failed",
        consecutiveFailures: 2,
        durationMs: 13,
        errorSummary: "HTTP 503",
        isFirstCredential: false
      }
    });
    assert.doesNotMatch(
      JSON.stringify(authStatus),
      /ACCESS_SECRET|EVENT_SECRET|MACHINE_SECRET/
    );

    const runtimeStatus = await api.getRuntimeStatus();
    assert.deepEqual(runtimeStatus, {
      activeAgentId: "agent-2",
      agentCapReached: true,
      runningAgentIds: ["agent-1", "agent-2"],
      runQueue: [{
        agentId: "agent-2",
        depthUser: 1,
        depthAgent: 0,
        depthBackground: 0,
        depthTotal: 2,
        ackOutstanding: false,
        active: {
          lane: "user",
          source: "turn",
          runtimeMs: 9,
          phase: "running"
        }
      }],
      hasRunningSubagents: true,
      canExecute: true,
      runReady: false
    });
    assert.doesNotMatch(JSON.stringify(runtimeStatus), /QUEUE_SECRET|ACTIVE_SECRET/);

    assert.deepEqual(await api.listLocalComputers(), [{
      id: "desktop-1",
      label: "Work Mac",
      connected: true
    }]);

    assert.deepEqual(await api.getLocalToolPermissionStatus({ agentId: "agent-2" }), {
      permission: "ask",
      blockedReason: null,
      requiresApproval: true,
      pendingRequest: {
        id: "ask-1",
        agentId: "agent-2",
        action: "run-command",
        target: "pwd",
        status: "pending",
        createdAtMs: 10,
        expiresAtMs: 20,
        description: "inspect cwd"
      },
      liveApprovalIds: ["approval-1"]
    });
    await api.getLocalToolPermissionStatus({ request_id: "ask-1" });
    assert.deepEqual(permissionLookups, [
      ["agent", "agent-2"],
      ["request", "ask-1"]
    ]);
    assert.throws(
      () => api.getLocalToolPermissionStatus({ agentId: "agent-2", requestId: "ask-1" }),
      /either 'agentId' or 'requestId'/
    );
    assert.throws(
      () => api.getLocalToolPermissionStatus({ agentId: 7 }),
      /'agentId' must be a string/
    );

    assert.deepEqual(await api.getSearchStatus(), {
      enabled: true,
      ready: false,
      maxMatchesPerAgent: 5,
      maxResults: 50
    });
  } finally {
    await loaded.dispose();
  }
});

test("SandHost emits only projected auth and local permission events", async () => {
  const loaded = await loadHostModule();
  try {
    let authListener;
    let permissionListener;
    const extensions = {
      auth: {
        peekAccessToken: () => "ACCESS_SECRET",
        getUserFullName: () => "Ada Lovelace",
        getLastRenewalEvent: () => null,
        subscribeToRenewal(listener) {
          authListener = listener;
          return () => {};
        }
      },
      "local-tool-permission": {
        subscribe(listener) {
          permissionListener = listener;
          return () => {};
        }
      },
      mcp: {},
      "cross-user-sharing": {},
      settings: {}
    };
    const host = new loaded.module.SandHost({ now: () => 100 });
    const events = [];
    host.listeners.add(event => events.push(event));
    host.wireExtensionGatewayEvents({
      api(id) {
        return extensions[id] ?? {};
      }
    });

    authListener({
      outcome: "renewed",
      consecutiveFailures: 0,
      durationMs: 7,
      errorSummary: undefined,
      isFirstCredential: true,
      accessToken: "EVENT_SECRET",
      machineId: "MACHINE_SECRET"
    });
    permissionListener({
      type: "created",
      private: "TOP_SECRET",
      request: {
        id: "ask-1",
        agentId: "agent-2",
        action: "run-command",
        target: "pwd",
        status: "pending",
        createdAtMs: 10,
        expiresAtMs: 20,
        description: "inspect cwd",
        toolCallId: "PRIVATE_TOOL_CALL",
        resourcePath: "/private/internal"
      }
    });

    assert.deepEqual(events, [{
      channel: "auth-status",
      payload: {
        ready: true,
        userFullName: "Ada Lovelace",
        lastRenewal: {
          outcome: "renewed",
          consecutiveFailures: 0,
          durationMs: 7,
          errorSummary: null,
          isFirstCredential: true
        }
      }
    }, {
      channel: "local-tool-permission",
      payload: {
        type: "created",
        request: {
          id: "ask-1",
          agentId: "agent-2",
          action: "run-command",
          target: "pwd",
          status: "pending",
          createdAtMs: 10,
          expiresAtMs: 20,
          description: "inspect cwd"
        }
      }
    }]);
    assert.doesNotMatch(
      JSON.stringify(events),
      /EVENT_SECRET|MACHINE_SECRET|TOP_SECRET|PRIVATE_TOOL_CALL|private\/internal/
    );
  } finally {
    await loaded.dispose();
  }
});
