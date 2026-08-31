import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";
import { Effect } from "effect";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadInput() {
  const temporary = await mkdtemp(path.join(repoRoot, ".grok-json-input-module-"));
  const output = path.join(temporary, "input.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/cli/input.ts")],
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

const fileInput = (file) => ({ file, stdin: false });

test("JSON --file reads only bounded regular descriptors", async (t) => {
  const loaded = await loadInput();
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-json-input-"));
  try {
    const regular = path.join(temporary, "request.json");
    await writeFile(regular, '{"agentId":"agent-one"}');
    assert.deepEqual(
      await Effect.runPromise(loaded.module.readJsonInput(fileInput(regular))),
      { agentId: "agent-one" },
    );

    const oversized = path.join(temporary, "oversized.json");
    await writeFile(oversized, "{}");
    await truncate(oversized, 64 * 1024 * 1024 + 1);
    const oversizedResult = await Effect.runPromise(
      loaded.module.readJsonInput(fileInput(oversized)).pipe(Effect.either),
    );
    assert.equal(oversizedResult._tag, "Left");
    assert.match(oversizedResult.left.message, /exceeds 67108864 bytes/);

    const link = path.join(temporary, "request-link.json");
    await symlink(regular, link);
    const linkedResult = await Effect.runPromise(
      loaded.module.readJsonInput(fileInput(link)).pipe(Effect.either),
    );
    assert.equal(linkedResult._tag, "Left");

    if (process.platform === "win32") {
      t.diagnostic("FIFO coverage is POSIX-only");
    } else {
      const fifo = path.join(temporary, "request.fifo");
      try {
        await execFileAsync("mkfifo", [fifo]);
      } catch (error) {
        if (error?.code === "ENOENT") {
          t.diagnostic("mkfifo is unavailable; FIFO coverage skipped");
          return;
        }
        throw error;
      }
      const started = Date.now();
      const fifoResult = await Effect.runPromise(
        loaded.module.readJsonInput(fileInput(fifo)).pipe(Effect.either),
      );
      assert.equal(fifoResult._tag, "Left");
      assert.match(fifoResult.left.message, /regular file/);
      assert.ok(Date.now() - started < 1_000, "FIFO rejection must not wait for a writer");
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
    await loaded.dispose();
  }
});
