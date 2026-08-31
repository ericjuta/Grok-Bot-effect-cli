import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule() {
  const temporary = await mkdtemp(path.join(repoRoot, ".grok-attachment-base64-"));
  const output = path.join(temporary, "attachments.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/host/extensions/attachments/attachments-service.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    packages: "external",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

test("attachment uploads accept only canonical non-empty base64", async () => {
  const loaded = await loadModule();
  try {
    assert.deepEqual(loaded.module.decodeAttachmentBase64("note.txt", "AQID"), Buffer.from([1, 2, 3]));
    for (const malformed of [undefined, "", "AQI", "AQI=\n", "AQI*", "TR=="]) {
      assert.throws(
        () => loaded.module.decodeAttachmentBase64("note.txt", malformed),
        /canonical base64/,
      );
    }
  } finally {
    await loaded.dispose();
  }
});
