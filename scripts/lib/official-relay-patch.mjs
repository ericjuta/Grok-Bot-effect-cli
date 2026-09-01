import { createHash } from "node:crypto";

export const officialRelaySourceVersion = "0.30.0";
export const officialRelaySourceBundleId = "com.anysphere.sand";
export const officialRelaySourceAsarSha256 = "4bbcd2f7af9f54cd1b354bd7b3c8376da569657a80f6560edac9b3280299a394";
export const officialRelaySourceExecutableSha256 = "36fea5c3526dbf8b5ef91d931915e72827d99716232ddef6793e5f50565f9eda";
export const officialRelaySourceMainSha256 = "c5189454e56820ef5108a37d9d0a8b27b906243d0f22bbe0cb202bc8f9bff708";
export const officialRelayBundleId = "com.anysphere.sand.official-relay";
export const officialRelayDisplayName = "Grok Bot 0.30 Official Relay";
export const officialRelayDataRootDirname = ".grokbot-official-relay";

export const officialRelayUpdaterGuard = [
  "// Official relay copy guard: keep the narrow relay patch from being replaced by the stock updater.",
  "process.env.SAND_DISABLE_UPDATES = \"1\";",
  `process.env.SAND_DATA_ROOT = require("node:path").join(require("node:os").homedir(), "${officialRelayDataRootDirname}");`,
  `process.env.SAND_USER_DATA_DIR = require("node:path").join(require("node:os").homedir(), "Library", "Application Support", "${officialRelayDisplayName}");`,
  "",
].join("\n");

export const officialRelayConnectorAnchor = "xe=I.wrap(ue.guard(We));S=$vn({connector:xe,";
export const officialRelayConnectorReplacement = "xe=require(\"./official-cli-relay.cjs\").wrapRemoteHostConnectorWithOfficialCliRelay(I.wrap(ue.guard(We)),{registerShutdown:dispose=>{let relayDisposing=!1;Te.app.on(\"before-quit\",event=>{if(relayDisposing)return;relayDisposing=!0;event.preventDefault();void dispose().finally(()=>Te.app.quit())})}});S=$vn({connector:xe,";
export const officialRelayProtocolRegistrationAnchor = "registerProtocolClient:Te.app.isPackaged&&!aye";
export const officialRelayProtocolRegistrationReplacement = "registerProtocolClient:!1";

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function patchOfficialRelayElectronMain(source) {
  if (typeof source !== "string") throw new TypeError("Official relay Electron main must be a string");
  if (source.startsWith(officialRelayUpdaterGuard) && source.includes(officialRelayConnectorReplacement) && source.includes(officialRelayProtocolRegistrationReplacement)) return source;
  const connectorMatches = source.split(officialRelayConnectorAnchor).length - 1;
  if (connectorMatches !== 1) {
    throw new Error(`Official ${officialRelaySourceVersion} relay connector anchor must match exactly once; matched ${connectorMatches}`);
  }
  const protocolMatches = source.split(officialRelayProtocolRegistrationAnchor).length - 1;
  if (protocolMatches !== 1) {
    throw new Error(`Official ${officialRelaySourceVersion} protocol-registration anchor must match exactly once; matched ${protocolMatches}`);
  }
  const patched = source
    .replace(officialRelayConnectorAnchor, officialRelayConnectorReplacement)
    .replace(officialRelayProtocolRegistrationAnchor, officialRelayProtocolRegistrationReplacement);
  return `${officialRelayUpdaterGuard}${patched}`;
}
