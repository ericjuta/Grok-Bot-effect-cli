import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-mcp-policy-"));
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

const names = (tools) => new Set(tools.map((tool) => tool.name));

test("MCP policy keeps reads available and human approvals behind a separate unsafe boundary", async () => {
  const loaded = await loadModule();
  try {
    const defaults = names(loaded.module.makeMcpTools());
    const privateReads = [
      "getTranscript",
      "getAgentTranscript",
      "getAgentTranscriptPage",
      "getAgentTranscriptWindow",
      "getAgentTranscriptTail",
      "getAgentThread",
      "readAttachmentImage",
      "readAttachmentText",
      "readAttachmentChunk",
      "searchMedia",
      "getAgentAvatar",
      "getAgentNotificationAvatar",
      "getCloudAgentTranscript",
      "listCloudAgentArtifacts",
      "watchCloudAgent",
      "getSharingState",
      "listAgents",
      "listAllAutomations",
      "getSubagents",
      "getTrays",
      "getCloudAgentInfo",
      "getHostSettings",
      "getRuntimeStatus",
      "getForeverBoxStatus",
      "promptAcceptanceStatus",
      "getMcpPluginLogo",
      "listBotTemplates",
      "getEffectiveMcpPlugins",
      "listMcpServerTools",
      "skillsCatalog",
    ];
    for (const name of privateReads) assert.ok(!defaults.has(name), `${name} requires the sensitive gate`);
    const sensitiveReads = names(loaded.module.makeMcpTools({ includeSensitive: true }));
    for (const name of privateReads) assert.ok(sensitiveReads.has(name), `${name} is available after sensitive opt-in`);
    assert.ok(!defaults.has("sendPrompt"));
    assert.ok(!defaults.has("getAutomationWebhookCredential"));
    assert.ok(!defaults.has("resolveLocalToolPermission"));
    assert.ok(!defaults.has("refreshMcp"));
    assert.ok(!defaults.has("setHostSettings"));
    assert.ok(!defaults.has("executeRoutedMcpTool"));
    assert.ok(!defaults.has("logoutMcpAccount"));
    assert.ok(!defaults.has("launchCloudAgent"));
    assert.ok(!defaults.has("generateAgentAvatarImage"));

    const writeTools = loaded.module.makeMcpTools({ includeWrites: true });
    const safePrompt = writeTools.find((tool) => tool.name === "sendPrompt");
    assert.ok(safePrompt);
    assert.equal("attachmentPaths" in safePrompt.inputSchema.properties, false);
    assert.equal("attachmentNames" in safePrompt.inputSchema.properties, false);
    assert.equal(names(writeTools).has("launchCloudAgent"), false, "cloud launches require the destructive gate");
    assert.equal(names(writeTools).has("uploadAttachment"), false, "media upload also requires the sensitive gate");
    assert.equal(names(writeTools).has("setAgentAvatarBytes"), false, "avatar bytes also require the sensitive gate");
    const stateReturningWrites = [
      "openAgent",
      "openAgentTail",
      "openAgentWindowed",
      "duplicateAgent",
      "updateAgent",
      "refreshChannel",
      "createAgentAutomation",
      "updateAgentAutomation",
      "setAgentAutomationEnabled",
      "createAgentWorkflow",
      "updateAgentWorkflow",
      "setAgentWorkflowEnabled",
      "importAgentWorkflowText",
      "importAgentWorkflowUrl",
      "portAgentLocalSkills",
      "ensureForeverBox",
      "setGroupMembers",
    ];
    for (const name of stateReturningWrites) {
      assert.equal(names(writeTools).has(name), false, `${name} returns private host state and requires the sensitive gate`);
    }

    const sensitiveWriteTools = loaded.module.makeMcpTools({ includeWrites: true, includeSensitive: true });
    const sensitivePrompt = sensitiveWriteTools.find((tool) => tool.name === "sendPrompt");
    assert.equal(sensitivePrompt.inputSchema.properties.attachmentPaths.type, "array");
    for (const name of stateReturningWrites) {
      assert.equal(names(sensitiveWriteTools).has(name), true, `${name} is available after write and sensitive opt-in`);
    }

    const destructiveWithoutSensitive = names(loaded.module.makeMcpTools({ includeDestructive: true }));
    for (const name of ["deleteAgent", "deleteAgents"]) {
      assert.equal(
        destructiveWithoutSensitive.has(name),
        false,
        `${name} returns a private successor transcript and requires the sensitive gate`,
      );
    }

    const powerful = names(loaded.module.makeMcpTools({
      includeWrites: true,
      includeDestructive: true,
      includeSensitive: true,
    }));
    assert.ok(powerful.has("sendPrompt"));
    assert.ok(powerful.has("getAutomationWebhookCredential"));
    assert.ok(!powerful.has("resolveLocalToolPermission"));
    assert.ok(!powerful.has("refreshMcp"));
    assert.ok(!powerful.has("setHostSettings"));
    assert.ok(!powerful.has("executeRoutedMcpTool"));
    assert.ok(powerful.has("watchCloudAgent"));
    assert.ok(!powerful.has("addMcpServer"));
    assert.ok(!powerful.has("reactToMessage"));
    assert.ok(!powerful.has("createSharedRoom"));
    assert.ok(!powerful.has("addOwnAgentToSharedRoom"));
    assert.ok(!powerful.has("removeOwnAgentFromSharedRoom"));
    assert.ok(!powerful.has("leaveSharedRoom"));
    assert.ok(!powerful.has("nudgeVoiceCall"));
    assert.ok(powerful.has("generateAgentAvatarImage"));
    assert.ok(powerful.has("deleteAgent"));
    assert.ok(powerful.has("deleteAgents"));
    assert.equal(
      powerful.has("logoutMcpAccount"),
      true,
      "logout requires both destructive and sensitive gates, which powerful enables",
    );

    const writesAndSensitive = names(loaded.module.makeMcpTools({
      includeWrites: true,
      includeSensitive: true,
    }));
    assert.ok(!writesAndSensitive.has("logoutMcpAccount"), "logout also requires the destructive gate");

    const human = names(loaded.module.makeMcpTools({
      includeWrites: true,
      includeDestructive: true,
      includeSensitive: true,
      includeHumanActions: true,
    }));
    assert.ok(human.has("resolveLocalToolPermission"));
    assert.ok(!human.has("refreshMcp"));
    assert.ok(!human.has("setHostSettings"));
    assert.ok(!human.has("executeRoutedMcpTool"));
    assert.ok(human.has("watchCloudAgent"));
    assert.ok(human.has("addMcpServer"));
    assert.ok(human.has("reactToMessage"));
    assert.ok(human.has("createSharedRoom"));
    assert.ok(human.has("addOwnAgentToSharedRoom"));
    assert.ok(human.has("removeOwnAgentFromSharedRoom"));
    assert.ok(human.has("leaveSharedRoom"));
    assert.ok(human.has("nudgeVoiceCall"));
  } finally {
    await loaded.dispose();
  }
});
