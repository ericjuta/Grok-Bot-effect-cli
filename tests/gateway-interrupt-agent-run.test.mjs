import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule(entry) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-gateway-interrupt-"));
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

function createGateway(module, transcript, markActive) {
  const inert = {};
  const extensions = {
    transcript,
    telemetry: {
      analytics: { markActive },
      logs: inert
    }
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

test("0.30 interruptAgentRun protocol preserves the exact id/result contract", async () => {
  const loaded = await loadModule("source/host/gateway-protocol.ts");
  try {
    let received;
    const expected = { hadActiveRun: true };
    const result = await loaded.module.SAND_GATEWAY_COMMANDS.interruptAgentRun({
      interruptAgentRun(args) {
        received = args;
        return expected;
      }
    }, JSON.stringify({ id: "agent-7" }));

    assert.deepEqual(received, { id: "agent-7" });
    assert.strictEqual(result, expected);
    assert.ok(
      loaded.module.SAND_GATEWAY_COMMANDS.listGatewayServices().methods
        .includes("interruptAgentRun")
    );
  } finally {
    await loaded.dispose();
  }
});

test("gateway interrupt validates the 0.30 request and marks a user action", async () => {
  const loaded = await loadModule("source/host/host-gateway-api.ts");
  try {
    const calls = [];
    const activeMarks = [];
    const api = createGateway(loaded.module, {
      interruptAgentRun(id) {
        calls.push(id);
        return { hadActiveRun: id === "agent-7" };
      }
    }, reason => activeMarks.push(reason));

    assert.deepEqual(await api.interruptAgentRun({ id: " agent-7 " }), {
      hadActiveRun: true
    });
    assert.deepEqual(calls, ["agent-7"]);
    assert.deepEqual(activeMarks, ["user_action"]);
    assert.throws(() => api.interruptAgentRun({}), /'id' is required/);
    assert.throws(() => api.interruptAgentRun({ id: 7 }), /'id' must be a string/);
  } finally {
    await loaded.dispose();
  }
});

test("runner interrupt cancels direct and group runs and returns hadActiveRun", async () => {
  const loaded = await loadModule(
    "source/host/extensions/transcript/runner-registry.ts"
  );
  try {
    const interruptCalls = [];
    const telemetry = [];
    const registry = new loaded.module.RunnerRegistry({
      runLifecycle: {
        runningAgentIds: () => new Set(["agent-7"])
      },
      telemetry: {
        reportTurnInterrupt(event) {
          telemetry.push(event);
        }
      }
    });
    registry.runners.set("agent-7", {
      interrupt(reason) {
        interruptCalls.push(["direct", reason]);
        return true;
      }
    });
    registry.activeGroupMemberRunners.set("agent-7", {
      interrupt(reason) {
        interruptCalls.push(["group", reason]);
        return true;
      }
    });

    assert.deepEqual(registry.interruptAgentRun("agent-7"), {
      hadActiveRun: true
    });
    assert.deepEqual(interruptCalls, [
      ["group", "user_interrupt"],
      ["direct", "user_interrupt"]
    ]);
    assert.deepEqual(telemetry, [{
      conversationId: "agent-7",
      reason: "user_interrupt",
      hadActiveRun: true,
      wasInFlight: true
    }]);

    assert.deepEqual(registry.interruptAgentRun("idle-agent"), {
      hadActiveRun: false
    });
    assert.deepEqual(telemetry.at(-1), {
      conversationId: "idle-agent",
      reason: "user_interrupt",
      hadActiveRun: false,
      wasInFlight: false
    });
  } finally {
    await loaded.dispose();
  }
});
