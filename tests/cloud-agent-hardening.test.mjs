import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule(entry) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-cloud-hardening-"));
  const output = path.join(temporary, "module.cjs");
  await build({
    entryPoints: [path.join(repoRoot, entry)],
    outfile: output,
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node22"
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

function makeManager(module, { disabled = false, status = "running", exists = true } = {}) {
  let starts = 0;
  let replies = 0;
  let polls = 0;
  let statusReads = 0;
  let policyReads = 0;
  const client = {
    async startBackgroundComposerFromSnapshot() {
      starts += 1;
      return { composer: { bcId: "bc-new" } };
    },
    async addAsyncFollowupBackgroundComposer() {
      replies += 1;
      return { runId: "run-one" };
    },
    async getBackgroundComposerInfo() {
      statusReads += 1;
      return exists ? { composer: { composer: { status } } } : {};
    }
  };
  const dashboard = {
    async getTeamAdminSettingsOrEmptyIfNotInTeam() {
      policyReads += 1;
      return { backgroundAgentSettings: { disableCloudAgentsInSand: disabled } };
    },
    async getTeams() { return { teams: [] }; }
  };
  const manager = new module.SandCloudAgentManager({
    getCursorAccessToken: async () => "token",
    getMachineId: async () => "machine",
    completionPolling: {
      start() {
        polls += 1;
        return { dispose() {} };
      }
    },
    clock: { monotonicNow: () => 0 },
    convertConversationMessagesToTrace: value => value,
    clientForTesting: client,
    dashboardClientForTesting: dashboard,
    modelCatalogForTesting: []
  });
  return {
    manager,
    counts: () => ({ starts, replies, polls, statusReads, policyReads })
  };
}

test("manager awaits and enforces team policy before launch or follow-up", async () => {
  const loaded = await loadModule("source/host/extensions/cloud-agents/cloud-agents-service.ts");
  try {
    const { manager, counts } = makeManager(loaded.module, { disabled: true });
    await assert.rejects(
      manager.launch({
        prompt: "Build it",
        repoUrl: "https://github.com/acme/repo"
      }),
      error => {
        assert.equal(error.name, "SandCloudAgentDisabledError");
        assert.match(error.message, /disabled by your team administrator/);
        return true;
      }
    );
    await assert.rejects(
      manager.reply({ bcId: "bc-one", prompt: "Continue" }),
      error => {
        assert.equal(error.name, "SandCloudAgentDisabledError");
        assert.match(error.message, /disabled by your team administrator/);
        return true;
      }
    );
    assert.deepEqual(counts(), {
      starts: 0,
      replies: 0,
      polls: 0,
      statusReads: 0,
      policyReads: 1
    });
    manager.dispose();
  } finally {
    await loaded.dispose();
  }
});

test("gateway watch status is a single bounded read and starts no completion poller", async () => {
  const loaded = await loadModule("source/host/extensions/cloud-agents/cloud-agents-service.ts");
  try {
    const { manager, counts } = makeManager(loaded.module, { status: "running" });
    const result = await manager.getWatchStatus("bc-one");
    assert.deepEqual(result, {
      status: "running",
      runStatus: "running",
      terminal: false,
      text: "The Cursor agent (bc-one) is running. Poll watchCloudAgent again for current status."
    });
    assert.equal(counts().statusReads, 1);
    assert.equal(counts().polls, 0);
    manager.dispose();
  } finally {
    await loaded.dispose();
  }
});

test("watch status rejects missing agents and session tracking stays bounded", async () => {
  const loaded = await loadModule("source/host/extensions/cloud-agents/cloud-agents-service.ts");
  try {
    const { manager } = makeManager(loaded.module, { exists: false });
    assert.equal(await manager.getWatchStatus("bc-missing"), null);
    assert.equal(manager.launchedIds.has("bc-missing"), false);

    for (let index = 0; index < loaded.module.MAX_TRACKED_CLOUD_AGENT_IDS + 10; index += 1) {
      manager.launchedIds.add(`bc-${index}`);
    }
    assert.equal(manager.launchedIds.size, loaded.module.MAX_TRACKED_CLOUD_AGENT_IDS);
    assert.equal(manager.launchedIds.has("bc-0"), false);
    assert.equal(manager.launchedIds.has(`bc-${loaded.module.MAX_TRACKED_CLOUD_AGENT_IDS + 9}`), true);
    manager.dispose();
  } finally {
    await loaded.dispose();
  }
});

test("Cloud Agent transcript projection returns complete JSONL within line and byte bounds", async () => {
  const loaded = await loadModule("source/host/extensions/cloud-agents/cloud-agents-service.ts");
  try {
    const messages = Array.from(
      { length: loaded.module.MAX_CLOUD_AGENT_TRANSCRIPT_LINES + 5 },
      (_, index) => ({ index, body: index === 0 ? "x".repeat(40_000) : "ok" })
    );
    const result = loaded.module.buildTranscriptJsonl(messages, value => value);
    assert.equal(result.lineCount, loaded.module.MAX_CLOUD_AGENT_TRANSCRIPT_LINES);
    assert.equal(result.totalLineCount, messages.length);
    assert.equal(result.byteCount, Buffer.byteLength(result.jsonl));
    assert.ok(result.byteCount <= loaded.module.MAX_CLOUD_AGENT_TRANSCRIPT_BYTES);
    assert.equal(result.truncated, true);
    assert.deepEqual(result.limits, {
      maxLines: loaded.module.MAX_CLOUD_AGENT_TRANSCRIPT_LINES,
      maxBytes: loaded.module.MAX_CLOUD_AGENT_TRANSCRIPT_BYTES
    });
    for (const line of result.jsonl.trimEnd().split("\n")) JSON.parse(line);

    const byteBounded = loaded.module.buildTranscriptJsonl(
      Array.from({ length: 100 }, (_, index) => ({
        index,
        body: "y".repeat(40_000)
      })),
      value => value
    );
    assert.ok(byteBounded.lineCount < byteBounded.totalLineCount);
    assert.ok(byteBounded.byteCount <= loaded.module.MAX_CLOUD_AGENT_TRANSCRIPT_BYTES);
    assert.equal(byteBounded.truncated, true);

    const wide = Object.fromEntries(
      Array.from({ length: 600 }, (_, index) => [`field${index}`, index])
    );
    const collectionBounded = loaded.module.buildTranscriptJsonl(
      [wide],
      value => value
    );
    assert.equal(collectionBounded.truncated, true);
    assert.equal(
      Object.keys(JSON.parse(collectionBounded.jsonl)).length,
      512
    );
  } finally {
    await loaded.dispose();
  }
});
