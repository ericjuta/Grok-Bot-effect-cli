import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule(entry) {
  const temporary = await mkdtemp(path.join(repoRoot, ".tmp-mcp-host-contracts-"));
  const output = path.join(temporary, "module.mjs");
  await build({
    entryPoints: [path.join(repoRoot, entry)],
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

function createGateway(module, { tools, execute, uploads = [], management = {} }) {
  const inert = {};
  let latestTools = tools;
  const routed = {
    listTools: async () => latestTools,
    createExecutor: (_persistImage, _spillLargeText, auditIdentity) => ({
      execute: async (_ctx, args) => execute(args, auditIdentity)
    })
  };
  const extensions = {
    transcript: { listAgentsSync: () => [{ id: "agent-1" }] },
    attachments: {
      upload: async ({ filename, bytesBase64, agentId }) => {
        uploads.push({ filename, bytes: Buffer.from(bytesBase64, "base64"), agentId });
        return { path: `/sand/agents/${agentId}/attachments/${filename}` };
      }
    },
    automations: inert,
    "managed-setup": inert,
    settings: inert,
    "local-tool-permission": inert,
    telemetry: { analytics: inert, logs: inert },
    "cross-user-sharing": inert,
    mcp: { mcp: routed, management }
  };
  const api = module.createHostGatewayApi({
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
  return { api, setTools(value) { latestTools = value; } };
}

test("MCP catalog fields retain safe exact metadata and never expose secret defaults", async () => {
  const loaded = await loadModule("source/host/extensions/mcp/mcp-service.ts");
  try {
    const fields = loaded.module.toCatalogFields([
      {
        key: "REGION",
        label: "Region",
        placeholder: "us-east-1",
        hint: "Deployment region",
        isRequired: true,
        defaultValue: "us-west-2"
      },
      {
        key: "API_TOKEN",
        label: "API token",
        placeholder: "Paste a token",
        hint: "Required by the connector",
        isSecret: false,
        defaultValue: "must-not-leak"
      },
      {
        key: "PASSWORD",
        label: "Password",
        isSecret: true,
        defaultValue: "also-must-not-leak"
      },
      {
        key: "CLIENT_SECRET",
        label: "Client secret",
        isSecret: true,
        hint: "Defaults to `hint-must-not-leak` when left blank."
      }
    ]);

    assert.deepEqual(fields[0], {
      key: "REGION",
      label: "Region",
      placeholder: "us-east-1",
      hint: "Deployment region",
      isRequired: true,
      isSecret: false,
      defaultValue: "us-west-2"
    });
    assert.deepEqual(fields[1], {
      key: "API_TOKEN",
      label: "API token",
      placeholder: "Paste a token",
      hint: "Required by the connector",
      isRequired: false,
      isSecret: true
    });
    assert.equal(Object.hasOwn(fields[2], "defaultValue"), false);
    assert.equal(fields[3].hint, "A configured secret default is hidden.");
    assert.doesNotMatch(JSON.stringify(fields), /must-not-leak/);
  } finally {
    await loaded.dispose();
  }
});

test("inferred MCP placeholders never copy secret fallbacks into descriptions", async () => {
  const loaded = await loadModule("source/packages/cursor-plugins/mcp-placeholder-variables.ts");
  try {
    const schema = loaded.module.inferMcpPlaceholderVariables({
      mcpServers: {
        search: {
          command: "connector",
          env: {
            API_TOKEN: "${API_TOKEN:-must-not-leak}",
            REGION: "${REGION:-us-west-2}"
          }
        }
      }
    });
    assert.equal(schema.properties.API_TOKEN.writeOnly, true);
    assert.match(schema.properties.API_TOKEN.description, /secret default is hidden/);
    assert.doesNotMatch(schema.properties.API_TOKEN.description, /must-not-leak/);
    assert.match(schema.properties.REGION.description, /us-west-2/);
  } finally {
    await loaded.dispose();
  }
});

test("MCP server state retains row, attribution, and safe transport fields", async () => {
  const loaded = await loadModule("source/host/extensions/mcp/mcp-service.ts");
  try {
    const base = {
      id: "7",
      name: "Search",
      serverIdentifier: "search--work",
      accountKey: "work",
      rowServerIdentifier: "search",
      pluginId: "42",
      isTeamServer: true,
      isRequired: true,
      managedByTeamPluginPolicy: true,
      status: "connected",
      transport: "http",
      toolCount: 3,
      customInstructions: "Prefer recent results"
    };
    assert.deepEqual(loaded.module.toInstalledServer({
      ...base,
      command: "node connector.mjs --mode readonly",
      url: "https://mcp.example.test/sse?region=us"
    }), {
      ...base,
      command: "node connector.mjs --mode readonly",
      url: "https://mcp.example.test/sse?region=us"
    });

    const unsafe = loaded.module.toInstalledServer({
      ...base,
      command: "node connector.mjs --token=must-not-leak",
      url: "https://user:must-not-leak@mcp.example.test/sse",
      statusDetail: "Retry with Authorization: Bearer must-not-leak"
    });
    assert.equal(Object.hasOwn(unsafe, "command"), false);
    assert.equal(Object.hasOwn(unsafe, "url"), false);
    assert.doesNotMatch(JSON.stringify(unsafe), /must-not-leak/);
    const signed = loaded.module.toInstalledServer({
      ...base,
      url: "https://mcp.example.test/sse?signature=must-not-leak"
    });
    assert.equal(Object.hasOwn(signed, "url"), false);
  } finally {
    await loaded.dispose();
  }
});

test("legacy routed MCP execution requires the exact live tuple and audit identity", async () => {
  const loaded = await loadModule("source/host/host-gateway-api.ts");
  try {
    const calls = [];
    const tool = {
      name: "mcp__search__query",
      providerIdentifier: "search--work",
      toolName: "query",
      description: "Search documents",
      inputSchema: { type: "object" }
    };
    const gateway = createGateway(loaded.module, {
      tools: [tool],
      execute: async (args, auditIdentity) => {
        calls.push({ args, auditIdentity });
        return {
          result: {
            case: "success",
            value: {
              content: [{ content: { case: "text", value: { text: "done" } } }],
              isError: false
            }
          }
        };
      }
    });

    const request = {
      ...tool,
      args: { query: "effect ts" },
      toolCallId: "call-1",
      agentId: "agent-1"
    };
    const result = await gateway.api.executeRoutedMcpTool(request);
    assert.equal(result.result.case, "success");
    assert.equal(result.result.value.content[0].content.value.text, "done");
    assert.deepEqual(calls, [{
      args: {
        name: "query",
        toolName: "mcp__search__query",
        providerIdentifier: "search--work",
        args: { query: "effect ts" },
        toolCallId: "call-1"
      },
      auditIdentity: {
        agentId: "agent-1",
        surface: "legacy-gateway",
        toolCallId: "call-1"
      }
    }]);

    await assert.rejects(
      gateway.api.executeRoutedMcpTool({ ...request, providerIdentifier: "search--personal" }),
      /unavailable, disabled, or its identity is stale/
    );
    gateway.setTools([]);
    await assert.rejects(gateway.api.executeRoutedMcpTool(request), /unavailable, disabled/);
    gateway.setTools([tool]);
    await assert.rejects(
      gateway.api.executeRoutedMcpTool({
        ...request,
        args: { value: "x".repeat(loaded.module.GATEWAY_ROUTED_MCP_ARGUMENT_MAX_BYTES) }
      }),
      /JSON payload is too large/
    );
    await assert.rejects(
      gateway.api.executeRoutedMcpTool({ ...request, agentId: "missing-agent" }),
      /existing agent identity/
    );
    assert.equal(calls.length, 1, "rejected identities must never reach the executor");
  } finally {
    await loaded.dispose();
  }
});

test("legacy routed MCP output spills oversized content and bounds inline results", async () => {
  const loaded = await loadModule("source/host/host-gateway-api.ts");
  try {
    const uploads = [];
    const text = "x".repeat(loaded.module.GATEWAY_ROUTED_MCP_INLINE_TEXT_MAX_BYTES + 1);
    const tool = { name: "mcp__files__read", providerIdentifier: "files", toolName: "read" };
    const gateway = createGateway(loaded.module, {
      tools: [tool],
      uploads,
      execute: async () => ({
        result: {
          case: "success",
          value: { content: [{ content: { case: "text", value: { text } } }] }
        }
      })
    });
    const result = await gateway.api.executeRoutedMcpTool({
      ...tool,
      args: {},
      toolCallId: "call-2",
      agentId: "agent-1"
    });
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].agentId, "agent-1");
    assert.equal(uploads[0].bytes.toString("utf8"), text);
    const marker = result.result.value.content[0].content.value.text;
    assert.match(marker, /saved as an agent attachment/);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 4_096);

    const failed = await loaded.module.projectGatewayRoutedMcpResult({
      result: {
        case: "error",
        value: { error: "Connector rejected Bearer must-not-leak" }
      }
    });
    assert.doesNotMatch(JSON.stringify(failed), /must-not-leak/);
    assert.match(failed.result.value.error, /\[REDACTED\]/);

    const many = await loaded.module.projectGatewayRoutedMcpResult({
      result: {
        case: "success",
        value: {
          content: Array.from({ length: 200 }, (_, index) => ({
            content: { case: "text", value: { text: String(index) } }
          }))
        }
      }
    });
    assert.equal(
      many.result.value.content.length,
      loaded.module.GATEWAY_ROUTED_MCP_MAX_CONTENT_ITEMS
    );
    assert.match(many.result.value.content.at(-1).content.value.text, /item limit/);
  } finally {
    await loaded.dispose();
  }
});

test("routed MCP projections bound schemas and structured values before serialization", async () => {
  const loaded = await loadModule("source/host/host-gateway-api.ts");
  try {
    const cyclicArray = [];
    cyclicArray.push(cyclicArray);
    assert.deepEqual(
      loaded.module.sanitizeGatewayServiceResult(cyclicArray),
      ["[Circular]"]
    );

    const cyclicTool = loaded.module.projectGatewayRoutedMcpTool({
      name: "mcp__safe__cycle",
      providerIdentifier: "safe",
      toolName: "cycle",
      inputSchema: cyclicArray
    });
    assert.deepEqual(cyclicTool.inputSchema, ["[Circular]"]);

    let untrustedToJsonCalls = 0;
    const hookTool = loaded.module.projectGatewayRoutedMcpTool({
      name: "mcp__safe__hook",
      providerIdentifier: "safe",
      toolName: "hook",
      inputSchema: {
        type: "object",
        toJSON() {
          untrustedToJsonCalls += 1;
          return { description: "x".repeat(10_000_000) };
        }
      }
    });
    assert.equal(untrustedToJsonCalls, 0, "projection must not invoke untrusted JSON hooks");
    assert.deepEqual(hookTool.inputSchema, { type: "object" });

    let secretAnnotationReads = 0;
    const credentialTool = loaded.module.projectGatewayRoutedMcpTool({
      name: "mcp__safe__credentials",
      providerIdentifier: "safe",
      toolName: "credentials",
      inputSchema: {
        type: "object",
        properties: {
          apiKey: {
            type: "string",
            writeOnly: true,
            get default() {
              secretAnnotationReads += 1;
              return "default-must-not-leak";
            },
            examples: ["example-must-not-leak"]
          },
          password: {
            type: "string",
            example: "password-must-not-leak"
          },
          default: { type: "string" }
        },
        required: ["apiKey", "password"]
      }
    });
    assert.equal(secretAnnotationReads, 0, "schema annotation accessors must not be read");
    assert.deepEqual(credentialTool.inputSchema, {
      type: "object",
      properties: {
        apiKey: { type: "string", writeOnly: true },
        password: { type: "string" },
        default: { type: "string" }
      },
      required: ["apiKey", "password"]
    });
    assert.doesNotMatch(JSON.stringify(credentialTool), /must-not-leak/);

    let deepSchema = { type: "string" };
    for (let depth = 0; depth <= loaded.module.GATEWAY_ROUTED_MCP_JSON_MAX_DEPTH; depth += 1) {
      deepSchema = { nested: deepSchema };
    }
    const boundedTool = loaded.module.projectGatewayRoutedMcpTool({
      name: "mcp__safe__deep",
      providerIdentifier: "safe",
      toolName: "deep",
      inputSchema: deepSchema
    });
    assert.equal(Object.hasOwn(boundedTool, "inputSchema"), false);

    const wideSchema = Array.from(
      { length: loaded.module.GATEWAY_ROUTED_MCP_JSON_MAX_NODES + 1 },
      () => null
    );
    const wideTool = loaded.module.projectGatewayRoutedMcpTool({
      name: "mcp__safe__wide",
      providerIdentifier: "safe",
      toolName: "wide",
      inputSchema: wideSchema
    });
    assert.equal(Object.hasOwn(wideTool, "inputSchema"), false);

    const largeTool = loaded.module.projectGatewayRoutedMcpTool({
      name: "mcp__safe__large",
      providerIdentifier: "safe",
      toolName: "large",
      inputSchema: { description: "x".repeat(loaded.module.GATEWAY_ROUTED_MCP_SCHEMA_MAX_BYTES) }
    });
    assert.equal(Object.hasOwn(largeTool, "inputSchema"), false);

    const cyclicResult = await loaded.module.projectGatewayRoutedMcpResult({
      result: {
        case: "success",
        value: { content: [], structuredContent: cyclicArray }
      }
    });
    assert.deepEqual(cyclicResult.result.value.structuredContent, ["[Circular]"]);

    const deepResult = await loaded.module.projectGatewayRoutedMcpResult({
      result: {
        case: "success",
        value: { content: [], structuredContent: deepSchema }
      }
    });
    assert.equal(Object.hasOwn(deepResult.result.value, "structuredContent"), false);
    assert.match(
      deepResult.result.value.content[0].content.value.text,
      /structured output was omitted/
    );
  } finally {
    await loaded.dispose();
  }
});

test("MCP management tool schemas use bounded general gateway sanitization", async () => {
  const loaded = await loadModule("source/host/host-gateway-api.ts");
  try {
    let managerResult;
    const requestedServerIds = [];
    const gateway = createGateway(loaded.module, {
      tools: [],
      execute: async () => ({}),
      management: {
        listServerTools: async serverId => {
          requestedServerIds.push(serverId);
          return managerResult;
        }
      }
    });
    const list = () => gateway.api.listMcpServerTools({ serverId: "server-7" });
    const omitted = {
      omitted: true,
      error: loaded.module.GATEWAY_SERVICE_RESULT_OMISSION_ERROR
    };

    let secretAnnotationReads = 0;
    managerResult = [{
      name: "credentials",
      accessToken: "manager-token-must-not-leak",
      inputSchema: {
        type: "object",
        properties: {
          apiKey: {
            type: "string",
            get default() {
              secretAnnotationReads += 1;
              return "default-must-not-leak";
            },
            examples: ["example-must-not-leak"]
          },
          password: { type: "string", example: "password-must-not-leak" }
        },
        required: ["apiKey", "password"]
      }
    }];
    const credentialTools = await list();
    assert.equal(secretAnnotationReads, 0, "schema annotation accessors must not be read");
    assert.equal(credentialTools[0].accessToken, "[REDACTED]");
    assert.deepEqual(credentialTools[0].inputSchema, {
      type: "object",
      properties: {
        apiKey: { type: "string" },
        password: { type: "string" }
      },
      required: ["apiKey", "password"]
    });
    assert.doesNotMatch(JSON.stringify(credentialTools), /must-not-leak/);

    const cyclicSchema = Object.assign(
      Object.create({ inheritedMetadata: "inherited-must-not-leak" }),
      { type: "object" }
    );
    cyclicSchema.properties = [cyclicSchema];
    managerResult = [{ name: "cyclic", inputSchema: cyclicSchema, accessToken: "must-not-leak" }];
    const cyclic = await list();
    assert.equal(cyclic[0].accessToken, "[REDACTED]");
    assert.equal(cyclic[0].inputSchema.properties[0], "[Circular]");
    assert.equal(Object.hasOwn(cyclic[0].inputSchema, "inheritedMetadata"), false);
    assert.doesNotMatch(JSON.stringify(cyclic), /must-not-leak/);

    let deepSchema = { type: "string" };
    for (let depth = 0; depth <= loaded.module.GATEWAY_JSON_PROJECTION_MAX_DEPTH; depth += 1) {
      deepSchema = { nested: deepSchema };
    }
    managerResult = [{ name: "deep", inputSchema: deepSchema }];
    assert.deepEqual(await list(), omitted);

    const wideSchema = {};
    for (let index = 0; index <= loaded.module.GATEWAY_JSON_PROJECTION_MAX_NODES; index += 1) {
      wideSchema[`field${index}`] = null;
    }
    managerResult = [{ name: "wide", inputSchema: wideSchema }];
    assert.deepEqual(await list(), omitted);

    managerResult = [{
      name: "large",
      inputSchema: {
        description: "\u0000".repeat(
          Math.floor(loaded.module.GATEWAY_SERVICE_RESULT_MAX_BYTES / 6) + 1
        )
      }
    }];
    assert.deepEqual(await list(), omitted);
    assert.deepEqual(
      requestedServerIds,
      ["server-7", "server-7", "server-7", "server-7", "server-7"]
    );
  } finally {
    await loaded.dispose();
  }
});

test("authenticateMcpServer exposes status, never the host-only kind discriminator", async () => {
  const loaded = await loadModule("source/host/host-gateway-api.ts");
  try {
    const gateway = createGateway(loaded.module, {
      tools: [],
      execute: async () => ({}),
      management: {
        authenticate: async () => ({
          kind: "started",
          status: "must-not-win",
          serverName: "Search",
          authorizationUrl: "https://auth.example.test/start"
        })
      }
    });
    const result = await gateway.api.authenticateMcpServer({ serverId: "7" });
    assert.deepEqual(result, {
      serverName: "Search",
      authorizationUrl: "https://auth.example.test/start",
      status: "started"
    });
    assert.equal(Object.hasOwn(result, "kind"), false);
  } finally {
    await loaded.dispose();
  }
});

test("uploadAttachment validates its gateway envelope before host dispatch", async () => {
  const loaded = await loadModule("source/host/host-gateway-api.ts");
  try {
    const uploads = [];
    const gateway = createGateway(loaded.module, {
      tools: [],
      uploads,
      execute: async () => ({})
    });
    assert.throws(() => gateway.api.uploadAttachment(null), /expected a JSON object/);
    assert.throws(
      () => gateway.api.uploadAttachment({ filename: "note.txt" }),
      /'bytesBase64' is required/
    );
    assert.throws(
      () => gateway.api.uploadAttachment({ filename: " ", bytesBase64: "AQID" }),
      /'filename' is required/
    );
    assert.throws(
      () => gateway.api.uploadAttachment({ filename: "note.txt", bytesBase64: 123 }),
      /non-empty base64 string/
    );
    assert.throws(
      () => gateway.api.uploadAttachment({ filename: "note.txt", bytesBase64: "AQID", agentId: "../agent" }),
      /'agentId' is invalid/
    );
    const inherited = Object.assign(Object.create({ bytesBase64: "AQID" }), {
      filename: "note.txt"
    });
    assert.throws(() => gateway.api.uploadAttachment(inherited), /'bytesBase64' is required/);
    assert.equal(uploads.length, 0);

    const result = await gateway.api.uploadAttachment({
      filename: " note.txt ",
      bytesBase64: "AQID",
      agentId: "agent-1"
    });
    assert.deepEqual(result, {
      path: "/sand/agents/agent-1/attachments/note.txt"
    });
    assert.deepEqual(uploads, [{
      filename: "note.txt",
      bytes: Buffer.from([1, 2, 3]),
      agentId: "agent-1"
    }]);
  } finally {
    await loaded.dispose();
  }
});
