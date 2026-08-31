import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-host-discovery-module-"));
  const output = path.join(temporary, "module.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/host/host-discovery.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22"
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

function permissions(stats) {
  return stats.mode & 0o777;
}

const first = {
  port: 43101,
  pid: 1001,
  startedAt: 100,
  scheme: "http",
  host: "127.0.0.1",
  token: "first-secret"
};

const second = {
  ...first,
  port: 43102,
  startedAt: 200,
  token: "second-secret"
};

test("default discovery repairs its dedicated directory and creates a 0600 token file", async () => {
  const loaded = await loadModule();
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-host-discovery-default-"));
  const dataRoot = path.join(temporary, "data");
  const previousDataRoot = process.env.SAND_DATA_ROOT;
  try {
    await mkdir(dataRoot, { mode: 0o777 });
    await chmod(dataRoot, 0o777);
    process.env.SAND_DATA_ROOT = dataRoot;

    await loaded.module.writeGatewayDiscovery(first);

    const discoveryPath = path.join(dataRoot, "gateway.json");
    assert.equal(permissions(await stat(dataRoot)), 0o700);
    assert.equal(permissions(await stat(discoveryPath)), 0o600);
    assert.deepEqual(JSON.parse(await readFile(discoveryPath, "utf8")), first);
    assert.deepEqual(await readdir(dataRoot), ["gateway.json"]);
  } finally {
    if (previousDataRoot === undefined) delete process.env.SAND_DATA_ROOT;
    else process.env.SAND_DATA_ROOT = previousDataRoot;
    await Promise.all([
      loaded.dispose(),
      rm(temporary, { recursive: true, force: true })
    ]);
  }
});

test("rewrites replace permissive files privately without chmodding a custom parent", async () => {
  const loaded = await loadModule();
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-host-discovery-rewrite-"));
  const customParent = path.join(temporary, "shared-parent");
  const discoveryPath = path.join(customParent, "gateway.json");
  try {
    await mkdir(customParent, { mode: 0o755 });
    await chmod(customParent, 0o755);
    await writeFile(discoveryPath, "old bearer token", { mode: 0o666 });
    await chmod(discoveryPath, 0o666);

    // Concurrent writers must have distinct, exclusive temporary files. The
    // final rename is last-writer-wins, but it must always leave valid JSON.
    await Promise.all([
      loaded.module.writeGatewayDiscovery(first, discoveryPath),
      loaded.module.writeGatewayDiscovery(second, discoveryPath)
    ]);

    const stored = JSON.parse(await readFile(discoveryPath, "utf8"));
    assert.ok(stored.token === first.token || stored.token === second.token);
    assert.equal(permissions(await stat(discoveryPath)), 0o600);
    assert.equal(permissions(await stat(customParent)), 0o755);
    assert.deepEqual(await readdir(customParent), ["gateway.json"]);
  } finally {
    await Promise.all([
      loaded.dispose(),
      rm(temporary, { recursive: true, force: true })
    ]);
  }
});

test("failed publication removes its exclusive temporary file", async () => {
  const loaded = await loadModule();
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-host-discovery-cleanup-"));
  const customParent = path.join(temporary, "parent");
  const discoveryPath = path.join(customParent, "gateway.json");
  try {
    await mkdir(discoveryPath, { recursive: true });
    await assert.rejects(loaded.module.writeGatewayDiscovery(first, discoveryPath));
    assert.deepEqual(await readdir(customParent), ["gateway.json"]);
  } finally {
    await Promise.all([
      loaded.dispose(),
      rm(temporary, { recursive: true, force: true })
    ]);
  }
});
