import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule(entry) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-gateway-services-"));
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

function createGateway(module, { management, cloudAgents }) {
  const inert = {};
  const extensions = {
    transcript: inert,
    attachments: inert,
    automations: inert,
    "managed-setup": inert,
    settings: inert,
    "local-tool-permission": inert,
    telemetry: { analytics: inert, logs: inert },
    "cross-user-sharing": inert,
    mcp: { management },
    "cloud-agents": cloudAgents
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

test("gateway service discovery is versioned, sorted, and reflects the live allowlist", async () => {
  const loaded = await loadModule("source/host/gateway-protocol.ts");
  try {
    const catalog = loaded.module.SAND_GATEWAY_COMMANDS.listGatewayServices();
    assert.equal(catalog.protocolVersion, 1);
    assert.deepEqual(catalog.methods, [...catalog.methods].sort());
    assert.equal(catalog.methods.length, Object.keys(loaded.module.SAND_GATEWAY_COMMANDS).length);
    assert.ok(catalog.methods.includes("listGatewayServices"));
    assert.ok(catalog.methods.includes("listMcpPlugins"));
    assert.ok(catalog.methods.includes("launchCloudAgent"));
    assert.deepEqual(catalog.capabilities, [
      "gatewayServicesV1",
      "mcpManagementV1",
      "mcp030CompatibilityV1",
      "cloudAgentsV1",
      "gatewayDiagnosticsV1",
      "attachmentUploadStreamV1"
    ]);
  } finally {
    await loaded.dispose();
  }
});

test("MCP gateway methods cover the complete management port and redact credentials", async () => {
  const loaded = await loadModule("source/host/host-gateway-api.ts");
  try {
    const calls = [];
    const names = [
      "listInstalled",
      "listPlugins",
      "getPlugin",
      "install",
      "uninstallPlugin",
      "add",
      "removeServer",
      "setInstructions",
      "restart",
      "authenticate",
      "logoutAccount",
      "renameAccount",
      "removeAccount"
    ];
    const management = Object.fromEntries(names.map(name => [name, (...args) => {
      calls.push({ name, args });
      if (name === "authenticate") {
        return {
          kind: "started",
          serverName: "Custom MCP",
          authorizationUrl: "https://auth.example.test/start",
        };
      }
      return {
        name,
        accessToken: "must-not-leak",
        nested: { refresh_token: "also-must-not-leak" }
      };
    }]));
    const api = createGateway(loaded.module, { management, cloudAgents: {} });

    const first = await api.listMcpServers();
    await api.listMcpPlugins();
    await api.getMcpPlugin({ plugin_id: " plugin.one " });
    await api.installMcpPlugin({ entry_id: "plugin.one", values: { workspace: "one" } });
    await api.uninstallMcpPlugin({ pluginId: "plugin.one" });
    await api.addMcpServer({ name: "custom", config: { command: "node", args: ["server.js"] } });
    await api.removeMcpServer({ server_id: "user-custom" });
    await api.setMcpInstructions({ serverId: "user-custom", instructions: "" });
    await api.restartMcpServers();
    const authResult = await api.authenticateMcpServer({
      server_id: "user-custom",
      account_key: "default",
      requesting_agent_id: "agent-1",
      force_reauth: true
    });
    await api.logoutMcpAccount({ server_id: "user-custom", account_key: "default" });
    await api.renameMcpAccount({
      server_id: "user-custom",
      account_key: "default",
      new_account_key: "work"
    });
    await api.removeMcpAccount({ server_id: "user-custom", account_key: "work" });

    assert.deepEqual(calls.map(call => call.name), names);
    assert.deepEqual(calls.find(call => call.name === "getPlugin").args, ["plugin.one"]);
    assert.deepEqual(calls.find(call => call.name === "install").args, [{
      id: "plugin.one",
      values: { workspace: "one" }
    }]);
    assert.deepEqual(calls.find(call => call.name === "add").args, [{
      name: "custom",
      configJson: JSON.stringify({ command: "node", args: ["server.js"] })
    }]);
    assert.deepEqual(calls.find(call => call.name === "authenticate").args, [
      "user-custom",
      "default",
      "agent-1",
      true
    ]);
    assert.deepEqual(authResult, {
      status: "started",
      serverName: "Custom MCP",
      authorizationUrl: "https://auth.example.test/start",
    });
    assert.equal(Object.hasOwn(authResult, "kind"), false);
    assert.equal(first.accessToken, "[REDACTED]");
    assert.equal(first.nested.refresh_token, "[REDACTED]");
    assert.doesNotMatch(JSON.stringify(first), /must-not-leak/);
  } finally {
    await loaded.dispose();
  }
});

test("Cloud Agent gateway methods normalize CLI JSON and expose the full manager lifecycle", async () => {
  const loaded = await loadModule("source/host/host-gateway-api.ts");
  try {
    const calls = [];
    const launchedIds = new Set();
    const response = name => ({ name, token: "cloud-secret" });
    const cloudAgents = {
      launchedIds,
      list: (...args) => { calls.push({ name: "list", args }); return response("list"); },
      listModels: (...args) => { calls.push({ name: "listModels", args }); return response("listModels"); },
      get: (...args) => { calls.push({ name: "get", args }); return response("get"); },
      getInfo: (...args) => { calls.push({ name: "getInfo", args }); return response("getInfo"); },
      launch: (...args) => { calls.push({ name: "launch", args }); return { bcId: "bc-new", access_token: "cloud-secret" }; },
      getWatchStatus: (...args) => { calls.push({ name: "getWatchStatus", args }); return { status: "running", runStatus: "running", terminal: false }; },
      reply: (...args) => { calls.push({ name: "reply", args }); return response("reply"); },
      cancel: (...args) => { calls.push({ name: "cancel", args }); return response("cancel"); },
      rename: (...args) => { calls.push({ name: "rename", args }); return response("rename"); },
      setArchived: (...args) => { calls.push({ name: "setArchived", args }); return response("setArchived"); },
      delete: (...args) => { calls.push({ name: "delete", args }); return response("delete"); },
      listArtifacts: (...args) => { calls.push({ name: "listArtifacts", args }); return response("listArtifacts"); },
      getTranscriptDump: (...args) => {
        calls.push({ name: "getTranscriptDump", args });
        return {
          status: "finished",
          lineCount: 1,
          jsonl: `${JSON.stringify({ role: "tool", accessToken: "transcript-secret", body: "ok" })}\n`
        };
      }
    };
    const api = createGateway(loaded.module, { management: {}, cloudAgents });

    await api.listCloudAgents({ limit: 40, include_archived: true });
    await api.listCloudAgentModels();
    await api.getCloudAgent({ agent_id: "bc-one" });
    await api.getCloudAgentInfo({ bc_id: "bc-one", include_files: false });
    const launched = await api.launchCloudAgent({
      prompt: "Build it",
      repo_url: "https://github.com/acme/repo",
      starting_ref: "main",
      model: "composer-1",
      model_params: { effort: "high" },
      environment: { type: "machine", name: "builder", team_id: 7 },
      images: [{
        data_base64: "data:image/png;base64,AQID",
        path: "/workspace/image.png"
      }]
    });
    await api.watchCloudAgent({ agent_id: "bc-one", wait_for_restart: true });
    await api.replyToCloudAgent({
      agent_id: "bc-one",
      prompt: "Continue",
      interrupt: true,
      model_id: "composer-1"
    });
    await api.cancelCloudAgent({ id: "bc-one" });
    await api.renameCloudAgent({ bcId: "bc-one", new_name: "Useful name" });
    await api.archiveCloudAgent({ bcId: "bc-one" });
    await api.unarchiveCloudAgent({ bcId: "bc-one" });
    await api.listCloudAgentArtifacts({ bcId: "bc-one" });
    const transcript = await api.getCloudAgentTranscript({ bcId: "bc-one" });
    launchedIds.add("bc-one");
    await api.deleteCloudAgent({ bcId: "bc-one" });

    assert.deepEqual(calls.map(call => call.name), [
      "list",
      "listModels",
      "get",
      "getInfo",
      "launch",
      "getWatchStatus",
      "reply",
      "cancel",
      "rename",
      "setArchived",
      "setArchived",
      "listArtifacts",
      "getTranscriptDump",
      "delete"
    ]);
    assert.deepEqual(calls[0].args, [{ limit: 40, includeArchived: true }]);
    assert.deepEqual(calls.find(call => call.name === "getInfo").args, ["bc-one", false]);
    const launchArgs = calls.find(call => call.name === "launch").args[0];
    assert.equal(launchArgs.repoUrl, "https://github.com/acme/repo");
    assert.deepEqual(launchArgs.environment, { type: "machine", name: "builder", teamId: 7 });
    assert.deepEqual([...launchArgs.images[0].data], [1, 2, 3]);
    assert.equal(launchArgs.images[0].mimeType, "image/png");
    assert.deepEqual(calls.find(call => call.name === "getWatchStatus").args, [
      "bc-one",
      { waitForRestart: true }
    ]);
    assert.deepEqual(calls.filter(call => call.name === "setArchived").map(call => call.args), [
      ["bc-one", true],
      ["bc-one", false]
    ]);
    assert.equal(launched.access_token, "[REDACTED]");
    assert.ok(launchedIds.has("bc-new"));
    assert.ok(!launchedIds.has("bc-one"));
    assert.doesNotMatch(transcript.jsonl, /transcript-secret/);
    assert.match(transcript.jsonl, /\[REDACTED\]/);
    assert.equal(transcript.byteCount, Buffer.byteLength(transcript.jsonl));
  } finally {
    await loaded.dispose();
  }
});

test("watchCloudAgent tracks only agents resolved by the backend", async () => {
  const loaded = await loadModule("source/host/host-gateway-api.ts");
  try {
    const launchedIds = new Set();
    const api = createGateway(loaded.module, {
      management: {},
      cloudAgents: {
        launchedIds,
        async getWatchStatus() { return null; }
      }
    });
    assert.equal(await api.watchCloudAgent({ bcId: "bc-missing" }), null);
    assert.equal(launchedIds.has("bc-missing"), false);
  } finally {
    await loaded.dispose();
  }
});

test("new gateway service methods reject malformed structured input", async () => {
  const loaded = await loadModule("source/host/host-gateway-api.ts");
  try {
    const api = createGateway(loaded.module, {
      management: { install: async () => [] },
      cloudAgents: { launch: async () => ({ bcId: "unreachable" }) }
    });
    await assert.rejects(
      api.installMcpPlugin({ id: "plugin", values: { retry: 3 } }),
      /only string values/
    );
    await assert.rejects(
      api.launchCloudAgent({
        prompt: "x",
        repo_url: "https://github.com/acme/repo",
        images: [{ data_base64: "not base64" }]
      }),
      error => {
        assert.equal(error.name, "SandCloudAgentLaunchError");
        assert.match(error.message, /not valid base64/);
        return true;
      }
    );
    await assert.rejects(
      api.launchCloudAgent({
        prompt: "x",
        images: Array.from({ length: 9 }, () => ({ data_base64: "AQID" }))
      }),
      /at most 8 items/
    );
    await assert.rejects(
      api.launchCloudAgent({
        prompt: "x",
        images: [{ data_base64: "data:image\/svg+xml;base64,AQID" }]
      }),
      /unsupported MIME type 'image\/svg\+xml'/
    );
    await assert.rejects(api.deleteCloudAgent({}), /'bcId' is required/);
  } finally {
    await loaded.dispose();
  }
});

test("Cloud Agent gateway refuses team-disabled launch and reply writes", async () => {
  const loaded = await loadModule("source/host/host-gateway-api.ts");
  try {
    let launches = 0;
    let replies = 0;
    const api = createGateway(loaded.module, {
      management: {},
      cloudAgents: {
        async isDisabledByTeamAdminForWrite() { return true; },
        async launch() { launches += 1; },
        async reply() { replies += 1; }
      }
    });
    await assert.rejects(
      api.launchCloudAgent({ prompt: "x" }),
      error => {
        assert.equal(error.name, "SandCloudAgentDisabledError");
        assert.match(error.message, /disabled by your team administrator/);
        return true;
      }
    );
    await assert.rejects(
      api.replyToCloudAgent({ bcId: "bc-one", prompt: "x" }),
      /disabled by your team administrator/
    );
    assert.equal(launches, 0);
    assert.equal(replies, 0);
  } finally {
    await loaded.dispose();
  }
});

test("Cloud Agent image normalization enforces a decoded aggregate limit", async () => {
  const loaded = await loadModule("source/host/host-gateway-api.ts");
  try {
    const atLimit = Buffer.alloc(loaded.module.GATEWAY_CLOUD_IMAGE_MAX_TOTAL_BYTES)
      .toString("base64");
    const api = createGateway(loaded.module, {
      management: {},
      cloudAgents: { async launch() { throw new Error("must not launch"); } }
    });
    await assert.rejects(
      api.launchCloudAgent({
        prompt: "x",
        images: [
          { dataBase64: atLimit, mimeType: "image/png" },
          {
            data: { type: "Buffer", data: [1] },
            mimeType: "image/png"
          }
        ]
      }),
      /remaining 0-byte aggregate limit/
    );
  } finally {
    await loaded.dispose();
  }
});
