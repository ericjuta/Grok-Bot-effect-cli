import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadCatalog() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-service-catalog-"));
  const output = path.join(temporary, "catalog.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/cli/catalog.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

test("service catalog preserves the exact audited 0.30 and local-extension boundaries", async () => {
  const loaded = await loadCatalog();
  try {
    const {
      GATEWAY_SERVICE_CATALOG,
      GROK_BOT_030_ADDED_GATEWAY_METHODS,
      GROK_BOT_030_GATEWAY_METHODS,
      GROK_BOT_030_REMOVED_GATEWAY_METHODS,
      HUMAN_DECISION_GATEWAY_METHODS,
      LOCAL_EXTENSION_GATEWAY_METHODS,
    } = loaded.module;

    assert.equal(GROK_BOT_030_ADDED_GATEWAY_METHODS.length, 39);
    assert.equal(GROK_BOT_030_REMOVED_GATEWAY_METHODS.length, 14);
    assert.equal(LOCAL_EXTENSION_GATEWAY_METHODS.length, 27);
    assert.equal(GATEWAY_SERVICE_CATALOG.length, 188);
    assert.equal(HUMAN_DECISION_GATEWAY_METHODS.length, 30);
    assert.equal(
      GATEWAY_SERVICE_CATALOG.filter((service) => service.requiresHumanDecision).length,
      HUMAN_DECISION_GATEWAY_METHODS.length,
    );
    assert.equal(GATEWAY_SERVICE_CATALOG.filter((service) => service.grokBot030).length, 147);
    assert.equal(GROK_BOT_030_GATEWAY_METHODS.length, 147);
    assert.deepEqual(
      GROK_BOT_030_GATEWAY_METHODS,
      GATEWAY_SERVICE_CATALOG
        .filter((service) => service.grokBot030)
        .map((service) => service.name),
    );

    const byName = new Map(GATEWAY_SERVICE_CATALOG.map((service) => [service.name, service]));
    const implemented030Additions = GROK_BOT_030_ADDED_GATEWAY_METHODS
      .filter((name) => byName.get(name)?.reconstructedHost === true).length;
    assert.equal(
      GATEWAY_SERVICE_CATALOG.filter((service) => service.reconstructedHost).length,
      122 + LOCAL_EXTENSION_GATEWAY_METHODS.length + implemented030Additions,
    );
    assert.ok(implemented030Additions >= 14);
    for (const name of GROK_BOT_030_ADDED_GATEWAY_METHODS) {
      assert.equal(byName.get(name)?.grokBot030, true, `${name} must be in 0.30`);
    }
    for (const name of GROK_BOT_030_REMOVED_GATEWAY_METHODS) {
      assert.equal(byName.get(name)?.grokBot030, false, `${name} must be legacy-only`);
    }
    for (const name of LOCAL_EXTENSION_GATEWAY_METHODS) {
      assert.equal(byName.get(name)?.reconstructedHost, true, `${name} must be locally implemented`);
      assert.equal(byName.get(name)?.grokBot030, false, `${name} must remain a local extension`);
    }
    for (const name of HUMAN_DECISION_GATEWAY_METHODS) {
      assert.equal(
        byName.get(name)?.requiresHumanDecision,
        true,
        `${name} must remain visibly reserved for a human decision`,
      );
    }
    for (const name of [
      "installMcpEntry",
      "addMcpServer",
      "executeRoutedMcpTool",
      "generateAgentAvatarImage",
      "logoutMcpAccount",
      "installMcpPlugin",
      "launchCloudAgent",
      "refreshMcp",
      "resolveVirtualCardApproval",
      "setBoxSecrets",
      "setHostSettings",
      "updateHostNow",
    ]) {
      assert.equal(byName.get(name)?.risk, "destructive", `${name} must require explicit confirmation`);
    }
    for (const name of ["installMcpEntry", "updateMcpPluginInstall"]) {
      assert.equal(byName.get(name)?.sensitiveInput, true, `${name} accepts credential-like installer values`);
    }
    assert.equal(byName.get("refreshMcp")?.sensitiveInput, true, "legacy MCP multiplexing accepts auth/tool payloads");
    for (const name of ["createRoomFromAgent", "createRoomInvite", "getCloudAgentTranscript", "getMcpPlugin", "listMcpServers"]) {
      assert.equal(byName.get(name)?.sensitiveOutput, true, `${name} returns capability, transcript, or account state`);
    }
    assert.equal(byName.get("joinSharedRoom")?.sensitiveInput, true, "room joins consume bearer capability URLs");
    for (const name of ["getLocalToolPermissionStatus", "getMcpState"]) {
      assert.equal(byName.get(name)?.sensitiveOutput, true, `${name} exposes sensitive host/account state`);
    }
    for (const name of ["uploadAttachment", "setAgentAvatarBytes", "launchCloudAgent", "replyToCloudAgent", "logoutMcpAccount"]) {
      assert.equal(byName.get(name)?.sensitiveInput, true, `${name} accepts private media or prompt content`);
    }
    for (const name of [
      "getTranscript",
      "getAgentTranscript",
      "getAgentTranscriptPage",
      "getAgentTranscriptWindow",
      "getAgentTranscriptTail",
      "getAgentThread",
      "openAgent",
      "openAgentTail",
      "openAgentWindowed",
      "duplicateAgent",
      "deleteAgent",
      "deleteAgents",
      "updateAgent",
      "refreshChannel",
      "createAgentAutomation",
      "updateAgentAutomation",
      "deleteAgentAutomation",
      "setAgentAutomationEnabled",
      "createAgentWorkflow",
      "updateAgentWorkflow",
      "deleteAgentWorkflow",
      "setAgentWorkflowEnabled",
      "importAgentWorkflowText",
      "importAgentWorkflowUrl",
      "portAgentLocalSkills",
      "ensureForeverBox",
      "resetForeverBox",
      "updateForeverBox",
      "prepareBoxForRecreate",
      "connectChannel",
      "disconnectChannel",
      "createSharedRoom",
      "joinSharedRoom",
      "respondToRoomJoinRequest",
      "addOwnAgentToSharedRoom",
      "removeOwnAgentFromSharedRoom",
      "leaveSharedRoom",
      "setGroupMembers",
      "setAgentAvatarBytes",
      "readAttachmentImage",
      "readAttachmentText",
      "readAttachmentChunk",
      "searchMedia",
      "getAgentAvatar",
      "getAgentNotificationAvatar",
      "listCloudAgentArtifacts",
      "watchCloudAgent",
    ]) {
      assert.equal(byName.get(name)?.sensitiveOutput, true, `${name} returns private transcript or media data`);
    }
  } finally {
    await loaded.dispose();
  }
});

test("every gateway descriptor carries a valid, explicit input-schema policy", async () => {
  const loaded = await loadCatalog();
  try {
    const { GATEWAY_SERVICE_CATALOG } = loaded.module;
    const kinds = new Map();
    for (const service of GATEWAY_SERVICE_CATALOG) {
      const schema = service.inputSchema;
      assert.equal(schema?.type, "object", `${service.name} must advertise an object input schema`);
      assert.equal(typeof schema.description, "string", `${service.name} schema needs a description`);
      assert.ok(schema.description.length > 10, `${service.name} schema description must be useful`);
      assert.ok(["exact", "partial", "generic"].includes(service.inputSchemaKind));
      assert.ok(
        schema.additionalProperties === true || schema.additionalProperties === false,
        `${service.name} must explicitly declare its additional-properties policy`,
      );
      for (const key of schema.required ?? []) {
        assert.ok(Object.hasOwn(schema.properties ?? {}, key), `${service.name}.${key} must be declared`);
      }
      if (!service.acceptsInput) {
        assert.equal(service.inputSchemaKind, "exact", `${service.name} no-input contract must be exact`);
        assert.deepEqual(schema.properties, {}, `${service.name} takes no fields`);
        assert.equal(schema.additionalProperties, false, `${service.name} must reject accidental fields`);
      }
      if (service.inputSchemaKind === "exact") assert.equal(schema.additionalProperties, false);
      if (service.inputSchemaKind !== "exact") assert.equal(schema.additionalProperties, true);
      kinds.set(service.inputSchemaKind, (kinds.get(service.inputSchemaKind) ?? 0) + 1);
      assert.doesNotThrow(() => JSON.stringify(schema), `${service.name} schema must be serializable`);
    }
    assert.ok(kinds.get("exact") >= 90, "the reconstructed surface should mostly have exact contracts");
    assert.ok(kinds.get("partial") >= 1, "forwarded nested contracts should be marked partial");
    assert.ok(kinds.get("generic") >= 1, "unproven 0.30 contracts must stay permissive");
  } finally {
    await loaded.dispose();
  }
});

test("core, MCP, diagnostics, Cloud Agent, avatar, interrupt, and transcription contracts are exact", async () => {
  const loaded = await loadCatalog();
  try {
    const { GATEWAY_SERVICE_CATALOG } = loaded.module;
    const byName = new Map(GATEWAY_SERVICE_CATALOG.map((service) => [service.name, service]));
    const exactMethods = [
      "getAgentTranscriptWindow",
      "getAgentThread",
      "sendPrompt",
      "createAgent",
      "getLocalToolPermissionStatus",
      "getMcpPluginLogo",
      "installMcpEntry",
      "updateMcpPluginInstall",
      "setMcpCustomInstructions",
      "listMcpServerTools",
      "toggleMcpToolDisabled",
      "launchCloudAgent",
      "replyToCloudAgent",
      "uploadAttachment",
      "readAttachmentImage",
      "readAttachmentText",
      "readAttachmentChunk",
      "getAgentNotificationAvatar",
      "interruptAgentRun",
      "transcribeAudio",
    ];
    for (const name of exactMethods) {
      assert.equal(byName.get(name)?.inputSchemaKind, "exact", `${name} must not use a generic schema`);
    }

    assert.deepEqual(byName.get("getAgentThread").inputSchema.required, ["id", "rootId"]);
    assert.deepEqual(byName.get("sendPrompt").inputSchema.required, ["prompt", "agentId"]);
    assert.deepEqual(byName.get("createAgent").inputSchema.required, ["name", "description"]);
    assert.deepEqual(byName.get("refreshChannel").inputSchema.required, ["id", "platform"]);
    assert.deepEqual(byName.get("installMcpEntry").inputSchema.required, ["entryId"]);
    assert.deepEqual(byName.get("replyToCloudAgent").inputSchema.required, ["bcId", "prompt"]);
    assert.match(byName.get("watchCloudAgent").description, /status snapshot/i);
    assert.deepEqual(byName.get("transcribeAudio").inputSchema.required, ["audioBase64", "mimeType"]);
    assert.equal(byName.get("transcribeAudio").inputSchema.properties.audioBase64.maxLength, 34_952_536);
    assert.equal(byName.get("uploadAttachment").inputSchema.properties.bytesBase64.maxLength, 279_620_268);
    assert.equal(byName.get("uploadAttachment").inputSchema.anyOf[1].properties.bytesBase64.maxLength, 34_952_536);
    assert.deepEqual(byName.get("getLocalToolPermissionStatus").inputSchema.not, {
      required: ["agentId", "requestId"],
    });

    const unimplemented030 = byName.get("publishBotTemplate");
    assert.equal(unimplemented030.inputSchemaKind, "generic");
    assert.equal(unimplemented030.inputSchema.additionalProperties, true);

    const stock030HostStatus = byName.get("getHostStatus");
    assert.equal(stock030HostStatus.acceptsInput, true, "stock 0.30 accepts a getHostStatus options object");
    assert.equal(stock030HostStatus.inputSchema.type, "object");
    assert.equal(stock030HostStatus.inputSchema.additionalProperties, true);
  } finally {
    await loaded.dispose();
  }
});
