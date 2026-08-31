import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadMcp() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-mcp-schemas-"));
  const output = path.join(temporary, "mcp.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/cli/mcp-stdio.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

test("MCP tools/list projects service-specific schemas and useful descriptions", async () => {
  const loaded = await loadMcp();
  try {
    const tools = loaded.module.makeMcpTools({
      includeWrites: true,
      includeDestructive: true,
      includeSensitive: true,
      includeHumanActions: true,
    });
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    assert.match(byName.get("sendPrompt").description, /accepted, not that the turn finished/i);
    assert.deepEqual(byName.get("sendPrompt").inputSchema.required, ["prompt", "agentId"]);
    assert.equal(byName.get("sendPrompt").inputSchema.properties.clientNonce.type, "string");
    assert.deepEqual(byName.get("sendPrompt").inputSchema.properties.source.enum, ["desktop", "mobile"]);
    assert.equal(
      byName.get("sendPrompt").inputSchema.properties.automationWriteProvenance.const,
      "untrusted",
    );
    assert.equal(byName.get("sendPrompt").inputSchema.properties.directAddressedAcceptance.const, true);
    assert.deepEqual(byName.get("promptAcceptanceStatus").inputSchema.required, ["accountSlot", "clientNonce"]);
    assert.equal(byName.get("promptAcceptanceStatus").inputSchema.properties.agentId.type, "string");

    assert.deepEqual(byName.get("createAgent").inputSchema.required, ["name", "description"]);
    assert.deepEqual(byName.get("createAgent").inputSchema.properties.origin.enum, ["user", "dev"]);
    assert.equal(byName.get("createAgent").inputSchema.properties.supportsTemporalHarness.type, "boolean");
    assert.deepEqual(
      byName.get("resolveAutoReviewApproval").inputSchema.properties.resolution.enum,
      ["approved", "denied", "always"],
    );
    assert.deepEqual(
      byName.get("resolveAutoReviewApproval").inputSchema.properties.approvalPlatform.enum,
      ["desktop", "ios", "android"],
    );
    assert.equal(byName.get("resolveAutoReviewApproval").inputSchema.properties.approvedCommand.type, "string");
    assert.equal(byName.get("setGroupMembers").inputSchema.properties.requesterAgentId.type, "string");
    assert.deepEqual(byName.get("refreshChannel").inputSchema.required, ["id", "platform"]);

    assert.deepEqual(byName.get("uploadAttachment").inputSchema.required, ["filename", "bytesBase64"]);
    assert.equal(byName.get("uploadAttachment").inputSchema.properties.bytesBase64.maxLength, 279_620_268);
    assert.equal(byName.get("uploadAttachment").inputSchema.anyOf[0].properties.bytesBase64.maxLength, 279_620_268);
    assert.equal(byName.get("uploadAttachment").inputSchema.anyOf[1].properties.bytesBase64.maxLength, 34_952_536);
    assert.deepEqual(byName.get("readAttachmentImage").inputSchema.required, ["path"]);
    assert.equal(byName.get("readAttachmentImage").inputSchema.properties.agentId, undefined);
    assert.deepEqual(byName.get("readAttachmentText").inputSchema.required, ["path"]);
    assert.deepEqual(byName.get("readAttachmentChunk").inputSchema.required, ["path", "offset", "length"]);
    assert.equal(byName.get("readAttachmentChunk").inputSchema.properties.videoPlayback.type, "boolean");

    assert.match(byName.get("getCloudAgentTranscript").description, /field-name-redacted/i);

    assert.deepEqual(byName.get("installMcpEntry").inputSchema.required, ["entryId"]);
    assert.equal(
      byName.get("installMcpEntry").inputSchema.properties.values.additionalProperties.type,
      "string",
    );
    assert.deepEqual(byName.get("launchCloudAgent").inputSchema.required, ["prompt"]);
    assert.equal(byName.get("launchCloudAgent").inputSchema.properties.environment.oneOf.length, 4);
    assert.equal(byName.get("launchCloudAgent").inputSchema.properties.images.maxItems, 8);
    assert.deepEqual(
      byName.get("launchCloudAgent").inputSchema.properties.images.items.properties.mimeType.enum,
      ["image/gif", "image/jpeg", "image/png", "image/webp"],
    );
    assert.deepEqual(byName.get("getAgentNotificationAvatar").inputSchema.required, ["id"]);
    assert.deepEqual(byName.get("interruptAgentRun").inputSchema.required, ["id"]);
    assert.deepEqual(byName.get("transcribeAudio").inputSchema.required, ["audioBase64", "mimeType"]);
    assert.equal(byName.get("transcribeAudio").inputSchema.properties.mimeType.maxLength, 255);
    assert.equal(byName.get("transcribeAudio").inputSchema.properties.language.maxLength, 64);
    assert.equal(
      byName.get("setAgentAvatarBytes").inputSchema.properties.pngBase64.anyOf[0].maxLength,
      6_990_508,
    );
  } finally {
    await loaded.dispose();
  }
});

test("sensitive status and installer services stay hidden without explicit MCP opt-in", async () => {
  const loaded = await loadMcp();
  try {
    const defaults = new Set(loaded.module.makeMcpTools().map((tool) => tool.name));
    assert.equal(defaults.has("getMcpState"), false);
    assert.equal(defaults.has("getLocalToolPermissionStatus"), false);
    assert.equal(defaults.has("installMcpEntry"), false);
    assert.equal(defaults.has("updateMcpPluginInstall"), false);

    const sensitiveReads = new Set(loaded.module.makeMcpTools({ includeSensitive: true }).map((tool) => tool.name));
    assert.equal(sensitiveReads.has("getMcpState"), true);
    assert.equal(sensitiveReads.has("getLocalToolPermissionStatus"), true);
    assert.equal(sensitiveReads.has("installMcpEntry"), false, "destructive opt-in is independently required");

    const destructiveWithoutSecrets = new Set(loaded.module.makeMcpTools({
      includeDestructive: true,
    }).map((tool) => tool.name));
    assert.equal(destructiveWithoutSecrets.has("installMcpEntry"), false, "sensitive opt-in is independently required");
  } finally {
    await loaded.dispose();
  }
});

test("MCP frame defaults carry 25 MiB base64 media in both directions", async () => {
  const loaded = await loadMcp();
  try {
    assert.equal(loaded.module.DEFAULT_MCP_MAX_MESSAGE_BYTES, 40 * 1024 * 1024);
    assert.equal(loaded.module.DEFAULT_MCP_MAX_OUTPUT_MESSAGE_BYTES, 40 * 1024 * 1024);
    assert.equal(loaded.module.MIN_MCP_MAX_OUTPUT_MESSAGE_BYTES, 2 * 1024);
    assert.equal(loaded.module.MAX_MCP_MAX_MESSAGE_BYTES, 64 * 1024 * 1024);
    assert.equal(loaded.module.MAX_MCP_MAX_OUTPUT_MESSAGE_BYTES, 64 * 1024 * 1024);
    assert.equal(loaded.module.MAX_MCP_ACTIVE_REQUEST_BYTES, 64 * 1024 * 1024);
    assert.equal(loaded.module.MAX_MCP_ACTIVE_REQUESTS, 64);
    assert.equal(loaded.module.MAX_MCP_ACTIVE_OUTPUT_BYTES, 128 * 1024 * 1024);
    assert.equal(loaded.module.canAdmitMcpRequest(40 * 1024 * 1024, 24 * 1024 * 1024), true);
    assert.equal(loaded.module.canAdmitMcpRequest(40 * 1024 * 1024, 24 * 1024 * 1024 + 1), false);
    assert.equal(loaded.module.canAdmitMcpOutput(40 * 1024 * 1024, 24 * 1024 * 1024), true);
    assert.equal(loaded.module.canAdmitMcpOutput(104 * 1024 * 1024, 24 * 1024 * 1024), true);
    assert.equal(loaded.module.canAdmitMcpOutput(104 * 1024 * 1024, 24 * 1024 * 1024 + 1), false);
    assert.equal(loaded.module.effectiveMcpActiveRequests(40 * 1024 * 1024), 2);
    assert.equal(loaded.module.effectiveMcpActiveRequests(64 * 1024 * 1024), 2);
    assert.equal(loaded.module.effectiveMcpActiveRequests(2 * 1024), 2);
    assert.equal(loaded.module.effectiveMcpActiveRequests(40 * 1024 * 1024, 2), 2);
    assert.equal(loaded.module.effectiveMcpActiveRequests(2 * 1024, 65), 2);
    assert.equal(loaded.module.mcpOutputReservationBytes(2 * 1024), 64 * 1024 * 1024);
    const tools = loaded.module.makeMcpTools({
      includeWrites: true,
      includeSensitive: true,
    });
    const transcribe = tools.find((tool) => tool.name === "transcribeAudio");
    assert.ok(transcribe.inputSchema.properties.audioBase64.maxLength < loaded.module.DEFAULT_MCP_MAX_MESSAGE_BYTES);
    assert.ok(transcribe.inputSchema.properties.audioBase64.maxLength < loaded.module.DEFAULT_MCP_MAX_OUTPUT_MESSAGE_BYTES);
  } finally {
    await loaded.dispose();
  }
});

test("MCP output bounding includes the NDJSON newline and bounds every fallback", async () => {
  const loaded = await loadMcp();
  try {
    const base = { jsonrpc: "2.0", id: "request-1", result: "" };
    const baseBytes = Buffer.byteLength(JSON.stringify(base), "utf8");
    const message = {
      ...base,
      result: "x".repeat(loaded.module.MIN_MCP_MAX_OUTPUT_MESSAGE_BYTES - baseBytes),
    };
    const jsonBytes = Buffer.byteLength(JSON.stringify(message), "utf8");
    assert.equal(jsonBytes, loaded.module.MIN_MCP_MAX_OUTPUT_MESSAGE_BYTES);
    assert.equal(loaded.module.mcpOutputFrameBytes(message), jsonBytes + 1);

    const newlineOverflow = loaded.module.boundMcpOutputMessage(message, jsonBytes);
    assert.equal(newlineOverflow.error.code, -32001, "a JSON body at the cap still exceeds it after LF framing");

    const large = { jsonrpc: "2.0", id: "request-2", result: "x".repeat(1_000) };
    const correlated = loaded.module.boundMcpOutputMessage(
      large,
      loaded.module.MIN_MCP_MAX_OUTPUT_MESSAGE_BYTES,
    );
    assert.equal(correlated.id, "request-2");
    assert.ok(
      loaded.module.mcpOutputFrameBytes(correlated) <= loaded.module.MIN_MCP_MAX_OUTPUT_MESSAGE_BYTES,
    );

    const escapedMaximumId = "\0".repeat(256);
    const escapedIdFallback = loaded.module.boundMcpOutputMessage(
      { ...large, id: escapedMaximumId },
      loaded.module.MIN_MCP_MAX_OUTPUT_MESSAGE_BYTES,
    );
    assert.equal(escapedIdFallback.id, escapedMaximumId, "a bounded fallback must retain every valid request id");
    assert.ok(
      loaded.module.mcpOutputFrameBytes(escapedIdFallback) <= loaded.module.MIN_MCP_MAX_OUTPUT_MESSAGE_BYTES,
    );

    const cyclic = {};
    cyclic.self = cyclic;
    const serializationFailure = loaded.module.boundMcpOutputMessage(
      { jsonrpc: "2.0", id: escapedMaximumId, result: cyclic },
      loaded.module.MIN_MCP_MAX_OUTPUT_MESSAGE_BYTES,
    );
    assert.equal(serializationFailure.id, escapedMaximumId);
    assert.equal(serializationFailure.error.code, -32603);
    assert.equal("data" in serializationFailure.error, false, "serialization exceptions must not be reflected");
    assert.ok(
      loaded.module.mcpOutputFrameBytes(serializationFailure) <= loaded.module.MIN_MCP_MAX_OUTPUT_MESSAGE_BYTES,
    );
  } finally {
    await loaded.dispose();
  }
});

test("MCP failure sanitization hides configuration paths unless sensitive output is enabled", async () => {
  const loaded = await loadMcp();
  try {
    const body = {
      code: "CLI_CONFIG",
      message: "No gateway found; checked /Users/private/.grokbot/gateway.json",
      path: "/Users/private/.grokbot/gateway.json",
    };
    assert.deepEqual(loaded.module.sanitizeMcpFailureBody(body, false), {
      code: "CLI_CONFIG",
      message: "Grok Bot gateway configuration is unavailable.",
    });
    assert.equal(loaded.module.sanitizeMcpFailureBody(body, true), body);

    assert.deepEqual(
      loaded.module.sanitizeMcpFailureBody({ code: "GATEWAY_TIMEOUT", message: "Timed out", path: "/private" }, false),
      { code: "GATEWAY_TIMEOUT", message: "Grok Bot gateway request timed out." },
    );
    assert.deepEqual(
      loaded.module.sanitizeMcpFailureBody({
        code: "GATEWAY_RESPONSE",
        message: "Rejected while reading /Users/private/token-file",
        path: "/Users/private/token-file",
        method: "listAgents",
        status: 500,
        retryable: true,
      }, false),
      {
        code: "GATEWAY_RESPONSE",
        message: "Grok Bot gateway rejected the request.",
        method: "listAgents",
        status: 500,
        retryable: true,
      },
    );
    assert.deepEqual(
      loaded.module.sanitizeMcpFailureBody({
        code: "INTERNAL",
        message: "secret at /private/path",
      }, false),
      { code: "INTERNAL", message: "Gateway tool execution failed." },
    );
  } finally {
    await loaded.dispose();
  }
});

test("image-bearing gateway results become native MCP image content without data-URL duplication", async () => {
  const loaded = await loadMcp();
  try {
    const data = "iVBORw0KGgo=";
    const dataUrl = `data:image/png;base64,${data}`;
    const cases = [
      ["readAttachmentImage", { dataUrl, width: 1, height: 1, unexpected: "do-not-copy" }],
      ["getAgentAvatar", { dataUrl, version: "avatar-v1", unexpected: "do-not-copy" }],
      ["getMcpPluginLogo", dataUrl],
    ];
    for (const [service, value] of cases) {
      const result = loaded.module.projectMcpToolResult(service, value);
      assert.deepEqual(result.content[0], { type: "image", data, mimeType: "image/png" });
      assert.equal(result.structuredContent.mimeType, "image/png");
      assert.equal(result.structuredContent.bytes, 8);
      assert.equal("dataUrl" in result.structuredContent, false);
      const serialized = JSON.stringify(result);
      assert.equal(serialized.includes("data:image/png;base64"), false);
      assert.equal(serialized.includes("do-not-copy"), false);
      assert.equal(serialized.split(data).length - 1, 1, `${service} must carry image base64 exactly once`);
    }
  } finally {
    await loaded.dispose();
  }
});
