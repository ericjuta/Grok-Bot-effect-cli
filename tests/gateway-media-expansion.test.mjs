import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule(entry) {
  const temporary = await mkdtemp(path.join(repoRoot, ".grok-gateway-media-"));
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
  return {
    module,
    dispose: () => rm(temporary, { recursive: true, force: true })
  };
}

function createGateway(module, transcribeAudio) {
  const inert = {};
  const extensions = {
    transcript: inert,
    auth: inert,
    attachments: inert,
    automations: inert,
    "content-search": inert,
    inference: { port: { transcribeAudio } },
    "local-exec": inert,
    "managed-setup": inert,
    settings: inert,
    "local-tool-permission": inert,
    telemetry: { analytics: inert, logs: inert },
    "cross-user-sharing": inert,
    "turn-execution": inert,
    mcp: { management: inert },
    "cloud-agents": inert
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

test("0.30 transcribeAudio protocol preserves the exact base64 request/result boundary", async () => {
  const loaded = await loadModule("source/host/gateway-protocol.ts");
  try {
    let received;
    const expected = { text: "hello", transcriptionTimeMs: 17 };
    const result = await loaded.module.SAND_GATEWAY_COMMANDS.transcribeAudio({
      transcribeAudio(args) {
        received = args;
        return expected;
      }
    }, JSON.stringify({
      audioBase64: "AQID",
      mimeType: "audio/webm",
      language: "en-US"
    }));

    assert.deepEqual(received, {
      audioBase64: "AQID",
      mimeType: "audio/webm",
      language: "en-US"
    });
    assert.strictEqual(result, expected);
    const methods = loaded.module.SAND_GATEWAY_COMMANDS.listGatewayServices().methods;
    assert.ok(methods.includes("transcribeAudio"));
    assert.ok(!methods.includes("generateAgentAvatarImage"));
  } finally {
    await loaded.dispose();
  }
});

test("host transcription decodes bounded base64 and delegates only audio bytes", async () => {
  const loaded = await loadModule("source/host/host-gateway-api.ts");
  try {
    const calls = [];
    const api = createGateway(loaded.module, async args => {
      calls.push(args);
      return { text: "bonjour", transcriptionTimeMs: 21 };
    });

    const result = await api.transcribeAudio({
      audioBase64: " -_8=\n",
      mimeType: "audio/webm; codecs=opus",
      language: "fr-CA"
    });
    assert.deepEqual(result, { text: "bonjour", transcriptionTimeMs: 21 });
    assert.equal(calls.length, 1);
    assert.deepEqual([...calls[0].audio], [251, 255]);
    assert.equal(calls[0].mimeType, "audio/webm; codecs=opus");
    assert.equal(calls[0].language, "fr-CA");
    assert.equal(
      loaded.module.GATEWAY_TRANSCRIBE_AUDIO_MAX_BYTES,
      25 * 1024 * 1024
    );

    await assert.rejects(
      api.transcribeAudio({ mimeType: "audio/webm" }),
      /'audioBase64' must be a string/
    );
    await assert.rejects(
      api.transcribeAudio({ audioBase64: "", mimeType: "audio/webm" }),
      /non-empty audio/
    );
    await assert.rejects(
      api.transcribeAudio({ audioBase64: "AB==", mimeType: "audio/webm" }),
      /not valid base64/
    );
    await assert.rejects(
      api.transcribeAudio({ audioBase64: "AQID", mimeType: 42 }),
      /'mimeType' must be a string/
    );

    const defaultMime = createGateway(loaded.module, async args => {
      assert.equal(args.mimeType, "audio/webm");
      return { text: "ok", transcriptionTimeMs: 1 };
    });
    await defaultMime.transcribeAudio({ audioBase64: "AQ==", mimeType: "" });

    const malformedResponse = createGateway(loaded.module, async () => "text");
    await assert.rejects(
      malformedResponse.transcribeAudio({ audioBase64: "AQ==", mimeType: "audio/webm" }),
      /Malformed transcribeAudio response/
    );
  } finally {
    await loaded.dispose();
  }
});

test("transcription manager matches 0.30 MIME, language, timeout, and result rules", async () => {
  const loaded = await loadModule(
    "source/shared/node/cursor-backend/cursor-transcribe.ts"
  );
  try {
    const requests = [];
    const manager = new loaded.module.SandTranscriptionManager({
      getCursorAccessToken: async () => "unused",
      getMachineId: async () => "unused",
      clientForTesting: {
        async transcribeAudio(request) {
          requests.push(request);
          return {
            text: requests.length === 1 ? "hello" : "fallback",
            transcriptionTimeMs: requests.length === 1 ? 321n : 7n
          };
        }
      }
    });
    const input = Uint8Array.from([1, 2, 3]);
    assert.deepEqual(await manager.transcribe({
      audio: input,
      mimeType: "audio/webm; codecs=opus",
      language: " EN-us "
    }), { text: "hello", transcriptionTimeMs: 321 });
    assert.deepEqual([...requests[0].audio], [1, 2, 3]);
    assert.notStrictEqual(requests[0].audio, input);
    assert.equal(requests[0].mimeType, "audio/webm");
    assert.equal(requests[0].language, "en");

    assert.deepEqual(await manager.transcribe({
      audio: Uint8Array.of(4),
      mimeType: "audio/mp4",
      language: "xx-YY"
    }), { text: "fallback", transcriptionTimeMs: 7 });
    assert.equal(requests[1].language, undefined);
    assert.equal(loaded.module.toWhisperLanguageHint("ZH-hant"), "zh");
    assert.equal(loaded.module.toWhisperLanguageHint("xx-YY"), undefined);
    assert.equal(loaded.module.TRANSCRIBE_TIMEOUT_MS, 60_000);

    await assert.rejects(
      manager.transcribe({ audio: new Uint8Array(), mimeType: "audio/webm" }),
      error => error?.name === "SandTranscribeEmptyAudioError"
    );
  } finally {
    await loaded.dispose();
  }
});
