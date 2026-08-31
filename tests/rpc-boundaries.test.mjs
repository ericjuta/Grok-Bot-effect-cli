import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadRpc() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-rpc-boundaries-"));
  const output = path.join(temporary, "rpc.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/cli/stdio-rpc.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

test("RPC derives a bounded deterministic subscription id from a maximum-length request id", async () => {
  const loaded = await loadRpc();
  try {
    assert.equal(loaded.module.defaultRpcSubscriptionId("short"), "sub-short");
    const first = loaded.module.defaultRpcSubscriptionId("a".repeat(256));
    const second = loaded.module.defaultRpcSubscriptionId(`${"a".repeat(255)}b`);
    assert.match(first, /^sub-sha256-[0-9a-f]{32}$/);
    assert.ok(first.length <= 256);
    assert.equal(first, loaded.module.defaultRpcSubscriptionId("a".repeat(256)));
    assert.notEqual(first, second);
    assert.match(loaded.module.defaultRpcSubscriptionId("🧪".repeat(64)), /^sub-sha256-/);
  } finally {
    await loaded.dispose();
  }
});

test("RPC size-weighted admission bounds retained input across stalled requests", async () => {
  const loaded = await loadRpc();
  try {
    assert.equal(loaded.module.canAdmitRpcRequest(40 * 1024 * 1024, 24 * 1024 * 1024), true);
    assert.equal(loaded.module.canAdmitRpcRequest(40 * 1024 * 1024, 24 * 1024 * 1024 + 1), false);
  } finally {
    await loaded.dispose();
  }
});

test("RPC output sizing includes the writer-appended LF exactly", async () => {
  const loaded = await loadRpc();
  try {
    assert.equal(loaded.module.rpcNdjsonOutputFrameBytes("{}"), 3);
    assert.equal(loaded.module.rpcNdjsonOutputFrameBytes("{}\n"), 3);
    assert.equal(loaded.module.rpcNdjsonOutputFrameBytes('{"emoji":"🧪"}'), 17);
  } finally {
    await loaded.dispose();
  }
});

test("RPC active requests reserve bounded worst-case output", async () => {
  const loaded = await loadRpc();
  try {
    assert.equal(loaded.module.MAX_ACTIVE_OUTPUT_BYTES, 128 * 1024 * 1024);
    assert.equal(loaded.module.RPC_REQUEST_OUTPUT_RESERVATION_BYTES, 64 * 1024 * 1024);
    assert.equal(loaded.module.MAX_RPC_ACTIVE_REQUESTS, 2);
    assert.equal(loaded.module.canAdmitRpcOutput(0), true);
    assert.equal(loaded.module.canAdmitRpcOutput(1), true);
    assert.equal(loaded.module.canAdmitRpcOutput(2), false);
    assert.equal(loaded.module.canAdmitRpcOutput(3), false);
    assert.equal(loaded.module.canAdmitRpcOutput(-1), false);
    assert.equal(loaded.module.canAdmitRpcOutput(0.5), false);
  } finally {
    await loaded.dispose();
  }
});

test("RPC error fallback omits an oversized echoed method", async () => {
  const loaded = await loadRpc();
  try {
    assert.equal(loaded.module.rpcErrorResponseMethod("grok.ping"), "grok.ping");
    assert.equal(
      loaded.module.rpcErrorResponseMethod("🧪".repeat(257)),
      "[oversized RPC method omitted]",
    );
  } finally {
    await loaded.dispose();
  }
});
