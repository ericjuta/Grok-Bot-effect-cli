import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

async function loadAvatarModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-avatar-bounds-module-"));
  const output = path.join(temporary, "module.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/host/agents/agent-avatar.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

test("oversized legacy avatars are rejected before header sniffing or derivation", async () => {
  const loaded = await loadAvatarModule();
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-avatar-legacy-bound-"));
  try {
    const source = path.join(root, "legacy-avatar.bin");
    const handle = await open(source, "w");
    try {
      await handle.write(pngHeader, 0, pngHeader.length, 0);
      await handle.truncate(loaded.module.AVATAR_MAX_BYTES + 1);
    } finally {
      await handle.close();
    }

    assert.equal(
      loaded.module.resolveDerivedAvatarFilename(root, "legacy-avatar.bin"),
      "legacy-avatar.bin",
    );
    await assert.rejects(access(path.join(root, "avatar.png")), { code: "ENOENT" });
    assert.equal(
      await loaded.module.readAvatarMetadataWithinDir(root, "legacy-avatar.bin"),
      null,
    );
    assert.equal(
      await loaded.module.readValidatedAvatar(root, "legacy-avatar.bin"),
      null,
    );
  } finally {
    await Promise.all([
      loaded.dispose(),
      rm(root, { recursive: true, force: true }),
    ]);
  }
});

test("unknown legacy extensions are derived by a bounded header sniff", async () => {
  const loaded = await loadAvatarModule();
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-avatar-header-sniff-"));
  try {
    await writeFile(path.join(root, "legacy-avatar.bin"), pngHeader);
    assert.equal(
      loaded.module.resolveDerivedAvatarFilename(root, "legacy-avatar.bin"),
      "avatar.png",
    );
    assert.deepEqual(await loaded.module.readAvatarBytesWithinDir(root, "avatar.png"), pngHeader);
  } finally {
    await Promise.all([
      loaded.dispose(),
      rm(root, { recursive: true, force: true }),
    ]);
  }
});

test("avatar reads and legacy derivation reject final-component symlinks", async () => {
  const loaded = await loadAvatarModule();
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-avatar-symlink-"));
  const external = await mkdtemp(path.join(os.tmpdir(), "grok-avatar-external-"));
  try {
    const externalAvatar = path.join(external, "outside.png");
    await writeFile(externalAvatar, pngHeader);
    await symlink(externalAvatar, path.join(root, "avatar.png"));
    assert.equal(await loaded.module.readValidatedAvatar(root, "avatar.png"), null);
    assert.equal(await loaded.module.readAvatarMetadataWithinDir(root, "avatar.png"), null);

    await rm(path.join(root, "avatar.png"));
    await symlink(externalAvatar, path.join(root, "legacy.bin"));
    assert.equal(
      loaded.module.resolveDerivedAvatarFilename(root, "legacy.bin"),
      "legacy.bin",
    );
    await assert.rejects(access(path.join(root, "avatar.png")), { code: "ENOENT" });
  } finally {
    await Promise.all([
      loaded.dispose(),
      rm(root, { recursive: true, force: true }),
      rm(external, { recursive: true, force: true }),
    ]);
  }
});

test("avatar data-URL cache is bounded by encoded bytes as well as entries", async () => {
  const loaded = await loadAvatarModule();
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-avatar-cache-bound-"));
  const agentDirs = [];
  try {
    const avatar = Buffer.alloc(loaded.module.AVATAR_MAX_BYTES);
    pngHeader.copy(avatar);
    for (let index = 0; index < 5; index += 1) {
      const agentDir = path.join(root, `agent-${index}`);
      agentDirs.push(agentDir);
      await mkdir(agentDir);
      await writeFile(path.join(agentDir, "avatar.png"), avatar);
      const result = await loaded.module.readAvatarWithinDir(agentDir, "avatar.png");
      assert.match(result?.dataUrl ?? "", /^data:image\/png;base64,/);
      const usage = loaded.module.getAvatarDataUrlCacheUsage();
      assert.ok(usage.encodedBytes <= usage.maxEncodedBytes);
      assert.ok(usage.entries <= usage.maxEntries);
    }

    const bounded = loaded.module.getAvatarDataUrlCacheUsage();
    assert.ok(bounded.entries < agentDirs.length, "byte pressure should evict an older cache entry");
    assert.ok(bounded.encodedBytes <= 32 * 1024 * 1024);

    for (const agentDir of agentDirs) loaded.module.invalidateAvatarDataUrlCache(agentDir);
    assert.deepEqual(loaded.module.getAvatarDataUrlCacheUsage(), {
      entries: 0,
      encodedBytes: 0,
      maxEntries: 128,
      maxEncodedBytes: 32 * 1024 * 1024,
    });
  } finally {
    await Promise.all([
      loaded.dispose(),
      rm(root, { recursive: true, force: true }),
    ]);
  }
});
