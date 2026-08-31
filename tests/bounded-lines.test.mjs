import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-bounded-lines-"));
  const output = path.join(temporary, "bounded-lines.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/cli/bounded-lines.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

test("bounded line framing coalesces tiny chunks and resynchronizes after overflow", async () => {
  const loaded = await loadModule();
  try {
    const chunks = [
      ...Array.from(Buffer.from("12345678\n"), (byte) => Buffer.from([byte])),
      ...Array.from(Buffer.from("too-long-line\nOK\r\n"), (byte) => Buffer.from([byte])),
    ];
    const lines = [];
    for await (const line of loaded.module.readBoundedLines(Readable.from(chunks), 8)) {
      lines.push(line);
    }
    assert.equal(lines.length, 3);
    assert.equal(Buffer.from(lines[0].bytes).toString("utf8"), "12345678");
    assert.equal(lines[1].oversized, true);
    assert.equal(Buffer.from(lines[2].bytes).toString("utf8"), "OK");
  } finally {
    await loaded.dispose();
  }
});

test("a CRLF-framed line may contain exactly the configured maximum bytes", async () => {
  const loaded = await loadModule();
  try {
    const chunks = [Buffer.from("12345678\r"), Buffer.from("\n123456789\r\n")];
    const lines = [];
    for await (const line of loaded.module.readBoundedLines(Readable.from(chunks), 8)) {
      lines.push(line);
    }
    assert.equal(lines.length, 2);
    assert.equal(lines[0].oversized, false);
    assert.equal(Buffer.from(lines[0].bytes).toString("utf8"), "12345678");
    assert.equal(lines[1].oversized, true);
  } finally {
    await loaded.dispose();
  }
});

test("bounded framing rejects invalid limits before reading input", async () => {
  const loaded = await loadModule();
  try {
    await assert.rejects(
      async () => {
        for await (const _line of loaded.module.readBoundedLines(Readable.from([]), 0)) {
          // The generator rejects before yielding.
        }
      },
      /positive safe integer/,
    );
  } finally {
    await loaded.dispose();
  }
});
