import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

import {
  officialRelayBundleId,
  officialRelayConnectorAnchor,
  officialRelayConnectorReplacement,
  officialRelayDataRootDirname,
  officialRelayDisplayName,
  officialRelayProtocolRegistrationAnchor,
  officialRelayProtocolRegistrationReplacement,
  officialRelaySourceAsarSha256,
  officialRelaySourceBundleId,
  officialRelaySourceExecutableSha256,
  officialRelaySourceMainSha256,
  officialRelaySourceVersion,
  officialRelayUpdaterGuard,
  patchOfficialRelayElectronMain,
} from "../scripts/lib/official-relay-patch.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("official 0.30 relay patch wraps the reviewed connector exactly once", () => {
  const source = `before;${officialRelayConnectorAnchor}middle;${officialRelayProtocolRegistrationAnchor}after;`;
  const patched = patchOfficialRelayElectronMain(source);

  assert.ok(patched.startsWith(officialRelayUpdaterGuard));
  assert.match(patched, /SAND_DATA_ROOT/);
  assert.equal(patched.includes(officialRelayConnectorAnchor), false);
  assert.equal(patched.split(officialRelayConnectorReplacement).length - 1, 1);
  assert.equal(patched.includes(officialRelayProtocolRegistrationAnchor), false);
  assert.equal(patched.split(officialRelayProtocolRegistrationReplacement).length - 1, 1);
  assert.equal(patchOfficialRelayElectronMain(patched), patched);
});

test("official relay patch overrides inherited updater and profile roots", () => {
  const environment = {
    SAND_DISABLE_UPDATES: "0",
    SAND_DATA_ROOT: "/shared-stock-root",
    SAND_USER_DATA_DIR: "/shared-stock-profile",
  };
  runInNewContext(officialRelayUpdaterGuard, {
    process: { env: environment },
    require(specifier) {
      if (specifier === "node:path") return path;
      if (specifier === "node:os") return os;
      throw new Error(`Unexpected module: ${specifier}`);
    },
  });
  assert.equal(environment.SAND_DISABLE_UPDATES, "1");
  assert.equal(environment.SAND_DATA_ROOT, path.join(os.homedir(), officialRelayDataRootDirname));
  assert.equal(environment.SAND_USER_DATA_DIR, path.join(os.homedir(), "Library", "Application Support", officialRelayDisplayName));
});

test("official 0.30 relay patch fails closed when the compiled anchor drifts", () => {
  assert.throws(
    () => patchOfficialRelayElectronMain("no connector here"),
    /anchor must match exactly once; matched 0/,
  );
  assert.throws(
    () => patchOfficialRelayElectronMain(`${officialRelayConnectorAnchor}${officialRelayConnectorAnchor}`),
    /anchor must match exactly once; matched 2/,
  );
  assert.throws(
    () => patchOfficialRelayElectronMain(officialRelayConnectorAnchor),
    /protocol-registration anchor must match exactly once; matched 0/,
  );
  assert.throws(
    () => patchOfficialRelayElectronMain(`${officialRelayConnectorAnchor}${officialRelayProtocolRegistrationAnchor}${officialRelayProtocolRegistrationAnchor}`),
    /protocol-registration anchor must match exactly once; matched 2/,
  );
});

test("official relay package pins the reviewed signed 0.30.0 inputs and separate identity", () => {
  assert.equal(officialRelaySourceVersion, "0.30.0");
  assert.equal(officialRelaySourceBundleId, "com.anysphere.sand");
  assert.equal(officialRelaySourceAsarSha256, "4bbcd2f7af9f54cd1b354bd7b3c8376da569657a80f6560edac9b3280299a394");
  assert.equal(officialRelaySourceExecutableSha256, "36fea5c3526dbf8b5ef91d931915e72827d99716232ddef6793e5f50565f9eda");
  assert.equal(officialRelaySourceMainSha256, "c5189454e56820ef5108a37d9d0a8b27b906243d0f22bbe0cb202bc8f9bff708");
  assert.equal(officialRelayBundleId, "com.anysphere.sand.official-relay");
  assert.equal(officialRelayDisplayName, "Grok Bot 0.30 Official Relay");
  assert.equal(officialRelayDataRootDirname, ".grokbot-official-relay");
});

test("only the isolated 0.30 package owns the official CLI relay", async () => {
  const [reconstructedComposition, relayPackager] = await Promise.all([
    readFile(path.join(repoRoot, "source", "electron-main", "main-production-services.ts"), "utf8"),
    readFile(path.join(repoRoot, "scripts", "package-official-relay.mjs"), "utf8"),
  ]);
  assert.doesNotMatch(reconstructedComposition, /cli-loopback-relay|startOfficialCliLoopbackRelay/);
  assert.match(relayPackager, /cli-loopback-relay\.ts/);
  assert.match(relayPackager, /official-cli-relay\.cjs/);
  assert.match(relayPackager, /\["-remove", "CFBundleURLTypes", outputInfoPlist\]/);
  assert.match(relayPackager, /outputInfo\.includes\("CFBundleURLTypes"\)/);
});
test("official launcher strips inherited direct and discovery routes", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-official-launcher-"));
  const fakeNodeDirectory = path.join(
    temporary,
    ".local",
    "share",
    "fnm",
    "node-versions",
    "v26.5.0",
    "installation",
    "bin",
  );
  const fakeNode = path.join(fakeNodeDirectory, "node");
  await mkdir(fakeNodeDirectory, { recursive: true });
  await writeFile(fakeNode, `#!/bin/sh
printf '%s\\n' \\
  "\${GROK_BOT_GATEWAY_URL-<unset>}" \\
  "\${GROK_BOT_GATEWAY_TOKEN-<unset>}" \\
  "\${GROK_BOT_GATEWAY_NETWORK_TOKEN-<unset>}" \\
  "\${GROK_BOT_GATEWAY_DISCOVERY-<unset>}" \\
  "\${SAND_HOST_GATEWAY_URL-<unset>}" \\
  "\${SAND_HOST_GATEWAY_TOKEN-<unset>}" \\
  "\${SAND_HOST_GATEWAY_NETWORK_TOKEN-<unset>}" \\
  "$1" "$2" "$3"
`);
  await chmod(fakeNode, 0o755);
  try {
    const stdout = execFileSync(path.join(repoRoot, ".omp", "grok-bot-official.sh"), ["mcp", "--stdio"], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: temporary,
        GROK_BOT_GATEWAY_URL: "http://hostile.invalid",
        GROK_BOT_GATEWAY_TOKEN: "hostile",
        GROK_BOT_GATEWAY_NETWORK_TOKEN: "hostile",
        GROK_BOT_GATEWAY_DISCOVERY: "/tmp/hostile-discovery.json",
        SAND_HOST_GATEWAY_URL: "http://hostile.invalid",
        SAND_HOST_GATEWAY_TOKEN: "hostile",
        SAND_HOST_GATEWAY_NETWORK_TOKEN: "hostile",
      },
    });
    const lines = stdout.trimEnd().split("\n");
    assert.deepEqual(lines.slice(0, 7), Array(7).fill("<unset>"));
    assert.equal(lines[7], path.join(repoRoot, "dist", "cli", "grok-bot.mjs"));
    assert.deepEqual(lines.slice(8), ["mcp", "--stdio"]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
