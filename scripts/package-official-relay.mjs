import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { extractAll, extractFile } from "@electron/asar";
import { build } from "esbuild";

import { packStagedAppWithIntegrity } from "./lib/asar-integrity.mjs";
import { signAppBundleAdHoc } from "./lib/codesign.mjs";
import { buildDir, outputDir, repoRoot } from "./lib/config.mjs";
import {
  officialRelayBundleId,
  officialRelayConnectorReplacement,
  officialRelayDisplayName,
  officialRelayProtocolRegistrationReplacement,
  officialRelaySourceAsarSha256,
  officialRelaySourceBundleId,
  officialRelaySourceExecutableSha256,
  officialRelaySourceMainSha256,
  officialRelaySourceVersion,
  patchOfficialRelayElectronMain,
  sha256,
} from "./lib/official-relay-patch.mjs";
import { capture, run } from "./lib/process.mjs";
import { SYSTEM_TOOLS } from "./lib/system-tools.mjs";

if (process.platform !== "darwin") {
  throw new Error("The official Grok Bot relay copy can only be packaged on macOS.");
}

const sourceApp = path.resolve(process.env.GROK_BOT_OFFICIAL_APP?.trim() || "/Applications/Grok Bot.app");
const configuredOutputName = process.env.GROK_BOT_OFFICIAL_RELAY_OUTPUT_APP?.trim();
const outputName = configuredOutputName ? path.basename(configuredOutputName) : "Grok Bot 0.30 Official Relay.app";
if (path.extname(outputName) !== ".app") throw new Error("Official relay output must be an .app bundle.");
const outputApp = path.join(outputDir, outputName);
if (outputApp === sourceApp) throw new Error("Official relay output must not overwrite the installed stock app.");

const sourceInfoPlist = path.join(sourceApp, "Contents", "Info.plist");
const sourceResources = path.join(sourceApp, "Contents", "Resources");
const sourceAsar = path.join(sourceResources, "app.asar");
const sourceExecutable = path.join(sourceApp, "Contents", "MacOS", "Grok Bot");

await run(SYSTEM_TOOLS.codesign, ["--verify", "--deep", "--strict", sourceApp]);
const [sourceVersion, sourceBundleId, sourceAsarBytes, sourceExecutableBytes] = await Promise.all([
  capture(SYSTEM_TOOLS.plutil, ["-extract", "CFBundleShortVersionString", "raw", sourceInfoPlist]),
  capture(SYSTEM_TOOLS.plutil, ["-extract", "CFBundleIdentifier", "raw", sourceInfoPlist]),
  readFile(sourceAsar),
  readFile(sourceExecutable),
]);
if (sourceVersion !== officialRelaySourceVersion) {
  throw new Error(`Expected official Grok Bot ${officialRelaySourceVersion}, received ${sourceVersion}.`);
}
if (sourceBundleId !== officialRelaySourceBundleId) {
  throw new Error(`Expected official bundle ${officialRelaySourceBundleId}, received ${sourceBundleId}.`);
}
if (sha256(sourceAsarBytes) !== officialRelaySourceAsarSha256) {
  throw new Error("Installed official app.asar does not match the reviewed 0.30.0 relay input.");
}
if (sha256(sourceExecutableBytes) !== officialRelaySourceExecutableSha256) {
  throw new Error("Installed official Electron executable does not match the reviewed 0.30.0 relay input.");
}

const buildRoot = path.join(buildDir, "official-relay");
const stageRoot = path.join(buildRoot, "stage");
await rm(buildRoot, { recursive: true, force: true });
await mkdir(stageRoot, { recursive: true });
extractAll(sourceAsar, stageRoot);
const stagedPackagePath = path.join(stageRoot, "package.json");
const stagedPackage = JSON.parse(await readFile(stagedPackagePath, "utf8"));
if (stagedPackage.version !== officialRelaySourceVersion) {
  throw new Error(`Extracted official package version drifted to ${String(stagedPackage.version)}.`);
}
stagedPackage.productName = officialRelayDisplayName;
await writeFile(stagedPackagePath, `${JSON.stringify(stagedPackage, null, 2)}\n`);

const stagedMain = path.join(stageRoot, "dist", "electron-main", "main.cjs");
const stagedMainSource = await readFile(stagedMain, "utf8");
if (sha256(Buffer.from(stagedMainSource)) !== officialRelaySourceMainSha256) {
  throw new Error("Extracted official Electron main does not match the reviewed 0.30.0 relay input.");
}
await writeFile(stagedMain, patchOfficialRelayElectronMain(stagedMainSource));

const relayBundle = path.join(stageRoot, "dist", "electron-main", "official-cli-relay.cjs");
await build({
  entryPoints: [path.join(repoRoot, "source", "electron-main", "box", "cli-loopback-relay.ts")],
  outfile: relayBundle,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: false,
  legalComments: "none",
  logLevel: "silent",
});
const relayBundleSource = await readFile(relayBundle, "utf8");
if (!relayBundleSource.includes("wrapRemoteHostConnectorWithOfficialCliRelay")) {
  throw new Error("Official relay bundle does not export the connector wrapper.");
}

await mkdir(outputDir, { recursive: true });
await rm(outputApp, { recursive: true, force: true });
await run(SYSTEM_TOOLS.ditto, [sourceApp, outputApp]);
await run(SYSTEM_TOOLS.xattr, ["-cr", outputApp]);

const outputResources = path.join(outputApp, "Contents", "Resources");
const outputAsar = path.join(outputResources, "app.asar");
const outputUnpacked = `${outputAsar}.unpacked`;
await packStagedAppWithIntegrity({
  stageRoot,
  archivePath: outputAsar,
  unpackedRoot: outputUnpacked,
});

const outputInfoPlist = path.join(outputApp, "Contents", "Info.plist");
await run(SYSTEM_TOOLS.plutil, ["-remove", "ElectronAsarIntegrity", outputInfoPlist]);
await run(SYSTEM_TOOLS.plutil, ["-remove", "CFBundleURLTypes", outputInfoPlist]);
await run(SYSTEM_TOOLS.plutil, ["-replace", "CFBundleIdentifier", "-string", officialRelayBundleId, outputInfoPlist]);
await run(SYSTEM_TOOLS.plutil, ["-replace", "CFBundleDisplayName", "-string", officialRelayDisplayName, outputInfoPlist]);
await rm(path.join(outputApp, "Contents", "_CodeSignature"), { recursive: true, force: true });
await signAppBundleAdHoc(outputApp);
await run(SYSTEM_TOOLS.codesign, ["--verify", "--deep", "--strict", outputApp]);

const [outputVersion, outputBundleId, outputDisplayName, outputAsarBytes, sourceAsarAfter] = await Promise.all([
  capture(SYSTEM_TOOLS.plutil, ["-extract", "CFBundleShortVersionString", "raw", outputInfoPlist]),
  capture(SYSTEM_TOOLS.plutil, ["-extract", "CFBundleIdentifier", "raw", outputInfoPlist]),
  capture(SYSTEM_TOOLS.plutil, ["-extract", "CFBundleDisplayName", "raw", outputInfoPlist]),
  readFile(outputAsar),
  readFile(sourceAsar),
]);
const outputInfo = await capture(SYSTEM_TOOLS.plutil, ["-p", outputInfoPlist]);
if (outputVersion !== officialRelaySourceVersion) throw new Error(`Relay copy version drifted to ${outputVersion}.`);
if (outputBundleId !== officialRelayBundleId) throw new Error(`Relay copy bundle ID drifted to ${outputBundleId}.`);
if (outputDisplayName !== officialRelayDisplayName) throw new Error(`Relay copy display name drifted to ${outputDisplayName}.`);
if (outputInfo.includes("CFBundleURLTypes")) throw new Error("Relay copy must not register the stock deep-link schemes.");
if (sha256(sourceAsarAfter) !== officialRelaySourceAsarSha256) throw new Error("Packaging modified the installed official app.asar.");
if (sha256(outputAsarBytes) === officialRelaySourceAsarSha256) throw new Error("Relay copy still contains the unpatched official app.asar.");
const packagedMain = extractFile(outputAsar, "dist/electron-main/main.cjs").toString("utf8");
if (!packagedMain.includes(officialRelayConnectorReplacement)) throw new Error("Packaged Electron main is missing the relay connector wrapper.");
if (!packagedMain.includes(officialRelayProtocolRegistrationReplacement)) throw new Error("Packaged Electron main still registers the stock deep-link schemes.");
const packagedPackage = JSON.parse(extractFile(outputAsar, "package.json").toString("utf8"));
if (packagedPackage.productName !== officialRelayDisplayName) throw new Error("Packaged relay app did not isolate its Electron profile name.");
const packagedRelay = extractFile(outputAsar, "dist/electron-main/official-cli-relay.cjs").toString("utf8");
if (!packagedRelay.includes("wrapRemoteHostConnectorWithOfficialCliRelay")) throw new Error("Packaged relay module is missing its connector wrapper.");

console.log(`Packaged official relay application: ${outputApp}`);
