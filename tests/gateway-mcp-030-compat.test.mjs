import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule(entry) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-mcp-030-"));
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

function createGateway(module, management) {
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
    mcp: { management }
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
    forgetLocalToolPermission() {}
  });
}

test("0.30 MCP names are advertised with an explicit compatibility capability", async () => {
  const loaded = await loadModule("source/host/gateway-protocol.ts");
  try {
    const discovery = loaded.module.SAND_GATEWAY_COMMANDS.listGatewayServices();
    const expected = [
      "getMcpState",
      "getMcpCatalog",
      "getEffectiveMcpPlugins",
      "getMcpPluginLogo",
      "installMcpEntry",
      "updateMcpPluginInstall",
      "setMcpCustomInstructions",
      "listMcpServerTools",
      "toggleMcpToolDisabled"
    ];
    assert.ok(discovery.capabilities.includes("mcp030CompatibilityV1"));
    for (const name of expected) {
      assert.equal(typeof loaded.module.SAND_GATEWAY_COMMANDS[name], "function");
      assert.ok(discovery.methods.includes(name));
    }
  } finally {
    await loaded.dispose();
  }
});

test("0.30 MCP gateway methods validate aliases and redact management results", async () => {
  const loaded = await loadModule("source/host/host-gateway-api.ts");
  try {
    const calls = [];
    const returned = name => ({
      name,
      accessToken: "token-must-not-leak",
      machine_id: "machine-must-not-leak",
      variables: {
        OPENAI_API_KEY: "value-must-not-leak",
        customSecret: "another-must-not-leak",
        ordinary: "visible"
      },
      field: { isSecret: true }
    });
    const logo = "data:image/png;base64,AQID";
    const management = {
      getState: (...args) => { calls.push(["getState", args]); return returned("state"); },
      getCatalog: (...args) => { calls.push(["getCatalog", args]); return [returned("catalog")]; },
      listEffectivePlugins: (...args) => { calls.push(["listEffectivePlugins", args]); return [returned("effective")]; },
      getPluginLogo: (...args) => { calls.push(["getPluginLogo", args]); return logo; },
      installEntry: (...args) => { calls.push(["installEntry", args]); return returned("install"); },
      updatePluginInstall: (...args) => { calls.push(["updatePluginInstall", args]); return returned("update"); },
      setCustomInstructions: (...args) => { calls.push(["setCustomInstructions", args]); return returned("instructions"); },
      listServerTools: (...args) => { calls.push(["listServerTools", args]); return [returned("tools")]; },
      toggleMcpToolDisabled: (...args) => { calls.push(["toggleMcpToolDisabled", args]); return [returned("toggle")]; }
    };
    const api = createGateway(loaded.module, management);

    const state = await api.getMcpState();
    await api.getMcpCatalog();
    await api.getEffectiveMcpPlugins();
    assert.equal(await api.getMcpPluginLogo({ logo_url: " https://cdn.example/logo.png " }), logo);
    await api.installMcpEntry({
      plugin_id: " plugin.one ",
      variables: { OPENAI_API_KEY: "inbound-secret" },
      has_team_configured_variables: true
    });
    await api.updateMcpPluginInstall({
      entry_id: "plugin.one",
      variables: { endpoint: "https://example.test" }
    });
    await api.setMcpCustomInstructions({
      server_id: "server-one",
      custom_instructions: "  keep surrounding whitespace  "
    });
    await api.listMcpServerTools({ id: "server-one" });
    await api.toggleMcpToolDisabled({ server_id: "server-one", tool_name: "search" });

    assert.deepEqual(calls, [
      ["getState", []],
      ["getCatalog", []],
      ["listEffectivePlugins", []],
      ["getPluginLogo", ["https://cdn.example/logo.png"]],
      ["installEntry", [{
        entryId: "plugin.one",
        values: { OPENAI_API_KEY: "inbound-secret" },
        hasTeamConfiguredVariables: true
      }]],
      ["updatePluginInstall", [{
        pluginId: "plugin.one",
        values: { endpoint: "https://example.test" }
      }]],
      ["setCustomInstructions", [{
        serverId: "server-one",
        instructions: "  keep surrounding whitespace  "
      }]],
      ["listServerTools", ["server-one"]],
      ["toggleMcpToolDisabled", [{ serverId: "server-one", toolName: "search" }]]
    ]);
    assert.equal(state.accessToken, "[REDACTED]");
    assert.equal(state.machine_id, "[REDACTED]");
    assert.equal(state.variables.OPENAI_API_KEY, "[REDACTED]");
    assert.equal(state.variables.customSecret, "[REDACTED]");
    assert.equal(state.variables.ordinary, "visible");
    assert.equal(state.field.isSecret, true);
    assert.doesNotMatch(JSON.stringify(state), /must-not-leak/);
  } finally {
    await loaded.dispose();
  }
});

test("0.30 MCP compatibility rejects malformed values and unsafe logo payloads", async () => {
  const loaded = await loadModule("source/host/host-gateway-api.ts");
  try {
    const management = {
      installEntry: async () => ({}),
      updatePluginInstall: async () => ({}),
      getPluginLogo: async () => "https://example.test/not-inline.png"
    };
    const api = createGateway(loaded.module, management);
    await assert.rejects(
      api.installMcpEntry({ entryId: "plugin", values: { retries: 3 } }),
      /only string values/
    );
    await assert.rejects(
      api.updateMcpPluginInstall({ pluginId: "plugin" }),
      /'values' is required/
    );
    assert.equal(await api.getMcpPluginLogo({ url: "https://example.test/logo.png" }), null);

    management.getPluginLogo = async () =>
      `data:image/png;base64,${"A".repeat(loaded.module.MCP_PLUGIN_LOGO_DATA_URL_MAX_LENGTH)}`;
    assert.equal(await api.getMcpPluginLogo({ url: "https://example.test/logo.png" }), null);
  } finally {
    await loaded.dispose();
  }
});
