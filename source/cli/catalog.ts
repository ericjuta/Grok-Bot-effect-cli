import { SAND_GATEWAY_COMMANDS } from "../host/gateway-protocol.js";
import {
  serviceMetadataForMethod,
  type GatewayInputSchema,
  type GatewayInputSchemaKind,
} from "./service-metadata.js";

export type { GatewayInputSchema, GatewayInputSchemaKind, GatewayJsonSchema } from "./service-metadata.js";

export type ServiceRisk = "read" | "write" | "interactive" | "destructive";

export interface GatewayServiceDescriptor {
  readonly name: string;
  readonly cliName: string;
  readonly group: string;
  readonly description: string;
  readonly acceptsInput: boolean;
  readonly inputSchema: GatewayInputSchema;
  readonly inputSchemaKind: GatewayInputSchemaKind;
  readonly risk: ServiceRisk;
  readonly sensitiveInput: boolean;
  readonly sensitiveOutput: boolean;
  readonly requiresHumanDecision: boolean;
  readonly reconstructedHost: boolean;
  readonly grokBot030: boolean;
  readonly source: "host-gateway";
}

/** Methods added to the public 0.30 desktop gateway after the reconstructed
 * 0.18 baseline. Keeping these in the client manifest lets this CLI target a
 * stock newer Grok Bot even when a method has not been backported locally. */
export const GROK_BOT_030_ADDED_GATEWAY_METHODS = [
  "authenticateMcpServer",
  "createAgentFromTemplate",
  "deleteBotTemplate",
  "discardDraft",
  "dismissUserForm",
  "generateAgentAvatarImage",
  "getAgentNotificationAvatar",
  "getAutomationWebhookCredential",
  "getBotTemplateExportPolicy",
  "getBotTemplateForSourceAgent",
  "getBotTemplateVersion",
  "getEffectiveMcpPlugins",
  "getMcpCatalog",
  "getMcpPluginLogo",
  "getMcpState",
  "getVoiceCall",
  "injectChromeCookies",
  "installMcpEntry",
  "interruptAgentRun",
  "listBotTemplates",
  "listMcpServerTools",
  "nudgeVoiceCall",
  "publishBotTemplate",
  "readVoiceCallAgentContext",
  "readVoiceCallSentMessages",
  "recordVoiceCall",
  "removeMcpAccount",
  "removeMcpServer",
  "renameMcpAccount",
  "resolveVirtualCardApproval",
  "sendDraft",
  "setBotTemplateVisibility",
  "setMcpCustomInstructions",
  "submitUserForm",
  "toggleMcpToolDisabled",
  "transcribeAudio",
  "uninstallMcpPlugin",
  "updateMcpPluginInstall",
  "voteFeedback",
] as const;

export const GROK_BOT_030_REMOVED_GATEWAY_METHODS = [
  "appendConnectorCard",
  "autoUpdateBoxNow",
  "clearBoxStoreNow",
  "deleteAgent",
  "executeRoutedMcpTool",
  "getBoxStoreStatus",
  "isAgentNetworkEnabled",
  "listRoutedMcpTools",
  "prepareBoxForRecreate",
  "resetForeverBox",
  "resumeBoxAfterRecreate",
  "setAgentWorkflowEnabled",
  "setBoxMigrating",
  "snapshotBoxStoreNow",
] as const;

/** Reconstructed-host extensions that are useful to headless clients but are
 * not names declared by the public 0.30 gateway. Keeping this distinction
 * explicit prevents `grokBot030` from accidentally meaning merely "present in
 * our expanded host". */
export const LOCAL_EXTENSION_GATEWAY_METHODS = [
  "addMcpServer",
  "archiveCloudAgent",
  "cancelCloudAgent",
  "deleteCloudAgent",
  "getAuthStatus",
  "getCloudAgent",
  "getCloudAgentTranscript",
  "getLocalToolPermissionStatus",
  "getMcpPlugin",
  "getRuntimeStatus",
  "getSearchStatus",
  "installMcpPlugin",
  "launchCloudAgent",
  "listCloudAgentArtifacts",
  "listCloudAgentModels",
  "listCloudAgents",
  "listGatewayServices",
  "listLocalComputers",
  "listMcpPlugins",
  "listMcpServers",
  "logoutMcpAccount",
  "renameCloudAgent",
  "replyToCloudAgent",
  "restartMcpServers",
  "setMcpInstructions",
  "unarchiveCloudAgent",
  "watchCloudAgent",
] as const;

export const GATEWAY_EVENT_CHANNELS = [
  "transcript",
  "client-side-tool-v2",
  "agents",
  "agent-upserted",
  "outline",
  "subagents",
  "async-tasks",
  "automations",
  "workflows",
  "memory",
  "tray",
  "forever-box",
  "teach-recording",
  "mcp-servers",
  "sharing",
  "host-settings",
  "box-disk-pressure",
  "computer-action",
  "agent-activity",
  "mcp-auth",
  "auth-status",
  "local-tool-permission",
] as const;

/** Synthetic channel emitted after an SSE reconnect. Upstream events cannot be
 * replayed, so consumers should treat it as a possible observation gap. */
export const CLI_GATEWAY_EVENT_CHANNEL = "grok.gateway" as const;

/** Actions that express a choice reserved for the human operator. This is
 * separate from risk: a human decision can be an ordinary write, an
 * interactive response, or a destructive mutation. Keeping the marker on the
 * shared descriptor lets CLI/RPC consumers enforce the same boundary as MCP. */
export const HUMAN_DECISION_GATEWAY_METHODS = [
  "addMcpServer",
  "completeMcpOAuth",
  "connectChannel",
  "createSharedRoom",
  "createRoomFromAgent",
  "createRoomInvite",
  "disconnectChannel",
  "dismissUserForm",
  "dismissWidget",
  "recordVoiceCall",
  "reactToMessage",
  "requestWebAuthnCeremony",
  "resolveAutoReviewApproval",
  "resolveLocalToolPermission",
  "resolveVirtualCardApproval",
  "respondToRoomJoinRequest",
  "respondToWidget",
  "sendDraft",
  "setBotTemplateVisibility",
  "submitSecret",
  "submitUserForm",
  "publishBotTemplate",
  "publishSkill",
  "unpublishSkill",
  "voteFeedback",
  "joinSharedRoom",
  "addOwnAgentToSharedRoom",
  "removeOwnAgentFromSharedRoom",
  "leaveSharedRoom",
  "nudgeVoiceCall",
] as const;

const HUMAN_DECISION_METHODS = new Set<string>(HUMAN_DECISION_GATEWAY_METHODS);

const DESTRUCTIVE_PREFIXES = [
  "delete",
  "clear",
  "reset",
  "remove",
  "leave",
  "unpublish",
  "uninstall",
  "disconnect",
  "handBack",
  "stop",
  "cancel",
  "discard",
  "interrupt",
] as const;

const INTERACTIVE_PREFIXES = [
  "respond",
  "resolve",
  "submit",
  "complete",
  "requestWebAuthn",
] as const;

const READ_PREFIXES = [
  "get",
  "list",
  "count",
  "is",
  "read",
  "search",
  "watch",
  "skillsCatalog",
  "promptAcceptanceStatus",
] as const;

const SENSITIVE_METHODS = new Set([
  "addOwnAgentToSharedRoom",
  "addMcpServer",
  "authenticateMcpServer",
  "connectChannel",
  "completeMcpOAuth",
  "executeRoutedMcpTool",
  "createSharedRoom",
  "generateAgentAvatarImage",
  "installMcpEntry",
  "installMcpPlugin",
  "injectChromeCookies",
  "joinSharedRoom",
  "launchCloudAgent",
  "logoutMcpAccount",
  "recordVoiceCall",
  "replyToCloudAgent",
  "refreshMcp",
  "resolveLocalToolPermission",
  "resolveVirtualCardApproval",
  "setBoxSecrets",
  "setAgentAvatarBytes",
  "submitSecret",
  "transcribeAudio",
  "uploadAttachment",
  "updateMcpPluginInstall",
]);

const SENSITIVE_OUTPUT_METHODS = new Set([
  "addOwnAgentToSharedRoom",
  "connectChannel",
  "createAgentAutomation",
  "createAgentWorkflow",
  "createRoomFromAgent",
  "createRoomInvite",
  "createSharedRoom",
  "deleteAgent",
  "deleteAgents",
  "deleteAgentAutomation",
  "deleteAgentWorkflow",
  "disconnectChannel",
  "duplicateAgent",
  "ensureForeverBox",
  "getAuthStatus",
  "getAutomationWebhookCredential",
  "getBotTemplateExportPolicy",
  "getBotTemplateForSourceAgent",
  "getBotTemplateVersion",
  "getBoxSecretsStatus",
  "getBoxStoreStatus",
  "getCloudAgentTranscript",
  "getCloudAgent",
  "getCloudAgentInfo",
  "getEffectiveMcpPlugins",
  "getAgentAutomations",
  "getAgentAvatar",
  "getAgentChannels",
  "getAgentMemories",
  "getAgentNotificationAvatar",
  "getAgentThread",
  "getAgentTranscript",
  "getAgentTranscriptPage",
  "getAgentTranscriptTail",
  "getAgentTranscriptWindow",
  "getAgentWorkflows",
  "getAsyncTasks",
  "getConversationOutline",
  "getForeverBoxStatus",
  "generateAgentAvatarImage",
  "getHostSettings",
  "getHostStatus",
  "getListenerConnectUrl",
  "getListenerIntegrations",
  "getLocalToolPermissionStatus",
  "getMcpPlugin",
  "getMcpPluginLogo",
  "getMcpCatalog",
  "getMcpState",
  "getPluginSyncStatus",
  "getRuntimeStatus",
  "getSharingState",
  "getSkillPublishTargets",
  "getSubagents",
  "getTeachRecordingStatus",
  "getTranscript",
  "getTrays",
  "getVoiceCall",
  "importAgentWorkflowText",
  "importAgentWorkflowUrl",
  "joinSharedRoom",
  "leaveSharedRoom",
  "listBotTemplates",
  "listCloudAgentArtifacts",
  "listCloudAgents",
  "listAgents",
  "listAllAutomations",
  "listBoxMcpServers",
  "listLocalComputers",
  "listMcpPlugins",
  "listMcpServerTools",
  "listMcpServers",
  "listRoutedMcpTools",
  "openAgent",
  "openAgentTail",
  "openAgentWindowed",
  "portAgentLocalSkills",
  "prepareBoxForRecreate",
  "promptAcceptanceStatus",
  "readAttachmentChunk",
  "readAttachmentImage",
  "readAttachmentText",
  "readVoiceCallAgentContext",
  "readVoiceCallSentMessages",
  "refreshChannel",
  "removeOwnAgentFromSharedRoom",
  "resetForeverBox",
  "respondToRoomJoinRequest",
  "searchAgents",
  "searchMedia",
  "setAgentAutomationEnabled",
  "setAgentAvatarBytes",
  "setAgentWorkflowEnabled",
  "setGroupMembers",
  "skillsCatalog",
  "updateAgent",
  "updateAgentAutomation",
  "updateAgentWorkflow",
  "updateForeverBox",
  "watchCloudAgent",
]);

const GROK_BOT_030_NO_INPUT_METHODS = new Set([
  "getBotTemplateExportPolicy",
  "getEffectiveMcpPlugins",
  "getMcpCatalog",
  "getMcpState",
  "listBotTemplates",
]);

/** Public 0.30 accepts an options object even where the reconstructed 0.18
 * wrapper ignores the body. Arity alone therefore cannot describe the union
 * client contract for these overlapping method names. */
const GROK_BOT_030_INPUT_METHOD_OVERRIDES = new Set([
  "getHostStatus",
]);

const GROK_BOT_030_REMOVED = new Set<string>(GROK_BOT_030_REMOVED_GATEWAY_METHODS);
const LOCAL_EXTENSIONS = new Set<string>(LOCAL_EXTENSION_GATEWAY_METHODS);

export function camelToKebab(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

export function humanizeMethod(value: string): string {
  const words = value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}.`;
}

export function groupForMethod(name: string): string {
  if (/BotTemplate|Marketplace/.test(name)) return "template";
  if (/VoiceCall|transcribeAudio/.test(name)) return "voice";
  if (/Transcript|Prompt|Message|Widget|Acceptance|Thread|Outline|AsyncTasks|Subagents/.test(name)) return "chat";
  if (/Agent/.test(name) && !/Automation|Workflow|CloudAgent/.test(name)) return "agent";
  if (/Automation/.test(name)) return "automation";
  if (/Workflow/.test(name)) return "workflow";
  if (/Mcp/.test(name)) return "mcp";
  if (/Skill/.test(name)) return "skill";
  if (/CloudAgent/.test(name)) return "cloud-agent";
  if (/ForeverBox|BoxStore|HostStatus|HostNow|BoxMigrating|BoxForRecreate|BoxAfterRecreate/.test(name)) return "box";
  if (/Attachment|Media|Avatar/.test(name)) return "media";
  if (/Memory/.test(name)) return "memory";
  if (/Room|Sharing/.test(name)) return "sharing";
  if (/Channel|Listener/.test(name)) return "channel";
  if (/TeachRecording/.test(name)) return "teach";
  if (/Tray/.test(name)) return "tray";
  if (/Settings/.test(name)) return "settings";
  if (/Secret/.test(name)) return "secrets";
  if (/Group|Broadcast/.test(name)) return "group";
  return "system";
}

export function riskForMethod(name: string): ServiceRisk {
  if ([
    "autoUpdateBoxNow",
    "addMcpServer",
    "executeRoutedMcpTool",
    "generateAgentAvatarImage",
    "getAutomationWebhookCredential",
    "installMcpEntry",
    "installMcpPlugin",
    "launchCloudAgent",
    "logoutMcpAccount",
    "prepareBoxForRecreate",
    "publishBotTemplate",
    "publishSkill",
    "refreshMcp",
    "resolveAutoReviewApproval",
    "resolveLocalToolPermission",
    "resolveVirtualCardApproval",
    "setBoxSecrets",
    "setHostSettings",
    "updateForeverBox",
    "updateHostNow",
    "updateMcpPluginInstall",
  ].includes(name)) return "destructive";
  if (DESTRUCTIVE_PREFIXES.some((prefix) => name.startsWith(prefix))) return "destructive";
  if (INTERACTIVE_PREFIXES.some((prefix) => name.startsWith(prefix))) return "interactive";
  if (READ_PREFIXES.some((prefix) => name.startsWith(prefix))) return "read";
  return "write";
}

function isGatewayMethod(value: string): value is keyof typeof SAND_GATEWAY_COMMANDS {
  return Object.hasOwn(SAND_GATEWAY_COMMANDS, value);
}

const RECONSTRUCTED_GATEWAY_METHODS = Object.keys(SAND_GATEWAY_COMMANDS).filter(isGatewayMethod);

export const GATEWAY_METHODS = Object.freeze([...new Set<string>([
  ...RECONSTRUCTED_GATEWAY_METHODS,
  ...GROK_BOT_030_ADDED_GATEWAY_METHODS,
])].sort());

export const GATEWAY_SERVICE_CATALOG: readonly GatewayServiceDescriptor[] = Object.freeze(
  GATEWAY_METHODS.map((name) => {
    const acceptsInput = GROK_BOT_030_INPUT_METHOD_OVERRIDES.has(name)
      || (isGatewayMethod(name)
        ? SAND_GATEWAY_COMMANDS[name].length >= 2
        : !GROK_BOT_030_NO_INPUT_METHODS.has(name));
    const metadata = serviceMetadataForMethod(name, acceptsInput);
    return {
      name,
      cliName: camelToKebab(name),
      group: groupForMethod(name),
      description: metadata.description,
      acceptsInput,
      inputSchema: metadata.inputSchema,
      inputSchemaKind: metadata.inputSchemaKind,
      risk: riskForMethod(name),
      sensitiveInput: SENSITIVE_METHODS.has(name),
      sensitiveOutput: SENSITIVE_OUTPUT_METHODS.has(name),
      requiresHumanDecision: HUMAN_DECISION_METHODS.has(name),
      reconstructedHost: isGatewayMethod(name),
      grokBot030: !GROK_BOT_030_REMOVED.has(name) && !LOCAL_EXTENSIONS.has(name),
      source: "host-gateway" as const,
    };
  }),
);

/** Exact audited public 0.30 gateway manifest. This is intentionally narrower
 * than the union catalog, which also includes legacy and reconstructed-only
 * extensions. */
export const GROK_BOT_030_GATEWAY_METHODS: readonly string[] = Object.freeze(
  GATEWAY_SERVICE_CATALOG
    .filter((service) => service.grokBot030)
    .map((service) => service.name),
);

export function findService(nameOrCliName: string): GatewayServiceDescriptor | undefined {
  return GATEWAY_SERVICE_CATALOG.find(
    (service) => service.name === nameOrCliName || service.cliName === nameOrCliName,
  );
}

export function isKnownService(name: string): boolean {
  return findService(name) !== undefined;
}

export const GATEWAY_METHOD_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,127}$/;
