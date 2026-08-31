/** JSON Schema vocabulary used by MCP's tools/list response. */
export type GatewayJsonPrimitive = string | number | boolean | null;

export interface GatewayJsonSchema {
  readonly type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null" | readonly string[];
  readonly title?: string;
  readonly description?: string;
  readonly properties?: Readonly<Record<string, GatewayJsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | GatewayJsonSchema;
  readonly items?: GatewayJsonSchema;
  readonly enum?: readonly GatewayJsonPrimitive[];
  readonly const?: GatewayJsonPrimitive;
  readonly oneOf?: readonly GatewayJsonSchema[];
  readonly anyOf?: readonly GatewayJsonSchema[];
  readonly allOf?: readonly GatewayJsonSchema[];
  readonly not?: GatewayJsonSchema;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems?: boolean;
  readonly pattern?: string;
  readonly format?: string;
  readonly contentEncoding?: string;
  readonly default?: GatewayJsonPrimitive;
}

export interface GatewayInputSchema extends GatewayJsonSchema {
  readonly type: "object";
}

/**
 * exact: canonical accepted fields are fully known and the schema is closed.
 * partial: evidenced fields are described, while additional fields stay open.
 * generic: only the gateway's object-shaped transport contract is known.
 */
export type GatewayInputSchemaKind = "exact" | "partial" | "generic";

export interface GatewayServiceMetadata {
  readonly description: string;
  readonly inputSchema: GatewayInputSchema;
  readonly inputSchemaKind: GatewayInputSchemaKind;
}

const nonEmptyString = (description: string): GatewayJsonSchema => ({
  type: "string",
  minLength: 1,
  description,
});

const stringArray = (description: string): GatewayJsonSchema => ({
  type: "array",
  description,
  items: { type: "string" },
});

const nonEmptyStringArray = (description: string): GatewayJsonSchema => ({
  ...stringArray(description),
  minItems: 1,
});

const stringMap = (description: string): GatewayJsonSchema => ({
  type: "object",
  description,
  additionalProperties: { type: "string" },
});

const closedObject = (
  description: string,
  properties: Readonly<Record<string, GatewayJsonSchema>> = {},
  required: readonly string[] = [],
): GatewayInputSchema => ({
  type: "object",
  description,
  properties,
  ...(required.length === 0 ? {} : { required }),
  additionalProperties: false,
});

const partialObject = (
  description: string,
  properties: Readonly<Record<string, GatewayJsonSchema>>,
  required: readonly string[] = [],
): GatewayInputSchema => ({
  type: "object",
  description,
  properties,
  ...(required.length === 0 ? {} : { required }),
  additionalProperties: true,
});

const agentId = nonEmptyString("Local Grok Bot agent ID.");
const cloudAgentId = nonEmptyString("Cloud Agent ID (bcId).");
const entryId = nonEmptyString("Transcript entry ID.");
const requestId = nonEmptyString("Pending approval request ID.");
const positiveLimit = (maximum: number, description: string): GatewayJsonSchema => ({
  type: "integer",
  minimum: 1,
  maximum,
  description,
});

const agentIdInput = (description: string): GatewayInputSchema => closedObject(
  description,
  { id: agentId },
  ["id"],
);

const cloudAgentIdInput = (description: string): GatewayInputSchema => closedObject(
  description,
  { bcId: cloudAgentId },
  ["bcId"],
);

const profileSchema: GatewayJsonSchema = {
  type: "object",
  description: "Complete local agent profile text and appearance.",
  properties: {
    name: { type: "string", description: "Display name." },
    description: { type: "string", description: "Agent instructions or description." },
    title: { type: "string", description: "Short display title." },
    avatarShape: { type: "string", description: "Avatar shape name." },
    avatarColor: { type: "string", description: "Avatar color name." },
  },
  required: ["name", "description"],
  additionalProperties: false,
};

const transcriptTailProperties = {
  id: agentId,
  beforeSeq: {
    type: "integer",
    description: "Return entries with sequence numbers before this cursor.",
  },
  limit: positiveLimit(5_000, "Maximum number of entries; the host defaults to 500."),
} as const satisfies Readonly<Record<string, GatewayJsonSchema>>;

const messageTargetProperties = {
  agentId,
  entryId,
} as const satisfies Readonly<Record<string, GatewayJsonSchema>>;

const mcpServerId = nonEmptyString("Installed MCP server ID.");
const mcpPluginId = nonEmptyString("MCP plugin or catalog entry ID.");

const cloudEnvironment: GatewayJsonSchema = {
  description: "Cloud execution environment selection.",
  oneOf: [
    closedObject("A default cloud environment.", { type: { const: "cloud" } }, ["type"]),
    closedObject("A named or team machine pool.", {
      type: { const: "pool" },
      name: { type: "string" },
      teamId: { type: "integer", minimum: 1 },
    }, ["type"]),
    closedObject("A specific machine.", {
      type: { const: "machine" },
      name: nonEmptyString("Machine name."),
      teamId: { type: "integer", minimum: 1 },
    }, ["type", "name"]),
    {
      ...closedObject("A saved environment, selected by publicId or name.", {
        type: { const: "environment" },
        publicId: { type: "string" },
        name: { type: "string" },
      }, ["type"]),
      anyOf: [{ required: ["publicId"] }, { required: ["name"] }],
    },
  ],
};

const MAX_ATTACHMENT_BASE64_LENGTH = 34_952_536;
const MAX_VIDEO_BASE64_LENGTH = 279_620_268;
const VIDEO_ATTACHMENT_EXTENSION_PATTERN = "\\.(?:[mM]4[vV]|[mM][oO][vV]|[mM][pP]4|[oO][gG][vV]|[wW][eE][bB][mM])$";
const base64Payload: GatewayJsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: MAX_ATTACHMENT_BASE64_LENGTH,
  contentEncoding: "base64",
  description: "Base64-encoded bytes (maximum decoded size: 25 MiB).",
};

const videoBase64Payload: GatewayJsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: MAX_VIDEO_BASE64_LENGTH,
  contentEncoding: "base64",
  description: "Base64-encoded supported-video bytes (maximum decoded size: 200 MiB).",
};

const avatarPngBase64: GatewayJsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: 6_990_508,
  contentEncoding: "base64",
  description: "Base64-encoded PNG bytes (maximum decoded size: 5 MiB).",
};

const cloudImages: GatewayJsonSchema = {
  type: "array",
  maxItems: 8,
  description: "Up to 8 images attached to the Cloud Agent prompt (25 MiB decoded aggregate limit).",
  items: closedObject("One image attachment.", {
    dataBase64: base64Payload,
    path: { type: "string", description: "Optional filename or source path." },
    mimeType: {
      type: "string",
      enum: ["image/gif", "image/jpeg", "image/png", "image/webp"],
      description: "Optional supported media type; a data URL can also provide it."
    },
  }, ["dataBase64"]),
};

const cloudReplyProperties = {
  bcId: cloudAgentId,
  prompt: { type: "string", description: "Follow-up prompt; whitespace is preserved." },
  images: cloudImages,
  interrupt: { type: "boolean", description: "Interrupt the current run before sending the follow-up." },
  modelId: { type: "string", description: "Optional model override." },
  modelParams: stringMap("Optional model parameter values."),
} as const satisfies Readonly<Record<string, GatewayJsonSchema>>;

/** Canonical contracts proven by reconstructed method implementations/types. */
const EXACT_INPUT_SCHEMAS = {
  getAgentTranscript: agentIdInput("Read the complete transcript for one local agent."),
  getAgentTranscriptPage: closedObject("Read a time-bounded page of one local agent transcript.", {
    id: agentId,
    beforeSeq: { type: "integer", description: "Optional sequence cursor." },
    sinceMs: { type: "number", description: "Optional inclusive lower timestamp bound." },
    untilMs: { type: "number", description: "Exclusive upper timestamp bound." },
    limit: positiveLimit(5_000, "Maximum number of transcript entries."),
  }, ["id", "untilMs", "limit"]),
  getAgentTranscriptWindow: closedObject("Read a recent transcript window plus thread counts.", {
    id: agentId,
    beforeSeq: { type: "integer", description: "Optional sequence cursor." },
    limit: { type: "number", description: "Optional entry limit; the host defaults to 500." },
  }, ["id"]),
  getAgentTranscriptTail: closedObject("Read the newest transcript entries, returned oldest-to-newest.", transcriptTailProperties, ["id"]),
  getAgentThread: closedObject("Read one reply thread from an agent transcript.", {
    id: agentId,
    rootId: nonEmptyString("Root transcript entry ID."),
  }, ["id", "rootId"]),
  sendPrompt: closedObject("Send a prompt to a local agent. clientNonce makes retries idempotent.", {
    prompt: { type: "string", description: "Prompt text. It may be empty when attachments are present." },
    agentId,
    clientNonce: { type: "string", minLength: 1, description: "Caller-generated idempotency key." },
    traceparent: { type: "string", description: "Optional W3C traceparent." },
    richText: { type: "string", description: "Optional rich-text representation." },
    replyToId: { type: "string", description: "Transcript entry being replied to." },
    isFork: { type: "boolean", description: "Start a fork from replyToId." },
    attachmentPaths: stringArray("Host-local attachment paths."),
    attachmentNames: stringArray("Display names corresponding to attachmentPaths."),
    directAddressedAcceptance: {
      const: true,
      description: "Avoid switching the active UI agent before admission.",
    },
    composedAtMs: { type: "number", description: "Client composition timestamp in Unix milliseconds." },
    enterEpochMs: { type: "number", description: "Client send timestamp in Unix milliseconds." },
    source: {
      type: "string",
      enum: ["desktop", "mobile"],
      description: "Client surface that submitted the prompt.",
    },
  }, ["prompt", "agentId"]),
  promptAcceptanceStatus: closedObject("Look up idempotent prompt admission by account slot and nonce.", {
    accountSlot: nonEmptyString("Gateway account slot; normally 'host'."),
    clientNonce: nonEmptyString("Nonce previously supplied to sendPrompt."),
    agentId,
  }, ["accountSlot", "clientNonce"]),
  respondToWidget: closedObject("Answer a pending transcript widget.", {
    ...messageTargetProperties,
    value: nonEmptyString("Widget answer value."),
  }, ["agentId", "entryId", "value"]),
  dismissWidget: closedObject("Dismiss a pending transcript widget without answering it.", messageTargetProperties, ["agentId", "entryId"]),
  submitSecret: closedObject("Submit a secret to a pending transcript secret request.", {
    ...messageTargetProperties,
    value: nonEmptyString("Secret value. This is credential-bearing input."),
  }, ["agentId", "entryId", "value"]),
  reactToMessage: closedObject("Toggle an emoji reaction on a transcript entry.", {
    ...messageTargetProperties,
    emoji: nonEmptyString("Emoji reaction."),
  }, ["agentId", "entryId", "emoji"]),
  resolveAutoReviewApproval: closedObject("Resolve a pending auto-review approval as the human operator.", {
    agentId,
    entryId,
    requestId,
    resolution: { type: "string", enum: ["approved", "denied", "always"] },
    approvalPlatform: {
      type: "string",
      enum: ["desktop", "ios", "android"],
      description: "Client platform that approved or denied the request.",
    },
    approvedCommand: {
      type: "string",
      description: "Command text approved by the operator, when available.",
    },
  }, ["agentId", "entryId", "requestId", "resolution"]),
  resolveLocalToolPermission: closedObject("Resolve a pending local-computer tool permission request as the human operator.", {
    agentId,
    entryId,
    requestId,
    resolution: { type: "string", enum: ["allow-once", "deny", "always", "never"] },
  }, ["agentId", "entryId", "requestId", "resolution"]),

  searchAgents: closedObject("Search indexed local-agent conversations.", {
    query: nonEmptyString("Search query."),
    limit: positiveLimit(500, "Maximum results."),
  }, ["query"]),
  searchMedia: closedObject("Search indexed media attached to local-agent conversations.", {
    query: nonEmptyString("Search query."),
    limit: positiveLimit(500, "Maximum results."),
  }, ["query"]),
  createAgent: closedObject("Create and activate a local agent.", {
    name: { type: "string", description: "Display name." },
    description: { type: "string", description: "Agent instructions or description." },
    title: { type: "string", description: "Short display title." },
    avatarShape: { type: "string" },
    avatarColor: { type: "string" },
    origin: { type: "string", enum: ["user", "dev"], description: "Creation source label." },
    clientNonce: { type: "string", description: "Caller-generated idempotency key." },
    isIntroductionSuppressed: { type: "boolean" },
    isKickstartRequested: { type: "boolean" },
    purpose: { type: "string", enum: ["disk-saver", "plugin-auth"] },
    templateId: { type: "string" },
    supportsTemporalHarness: { type: "boolean" },
  }, ["name", "description"]),
  createGroup: closedObject("Create a local group agent.", {
    name: { type: "string" },
    description: { type: "string" },
    memberAgentIds: stringArray("Initial local-agent members."),
  }, ["name", "memberAgentIds"]),
  setGroupMembers: closedObject("Replace a group agent's member list.", {
    id: agentId,
    memberAgentIds: stringArray("Complete replacement member list."),
    requesterAgentId: agentId,
  }, ["id", "memberAgentIds"]),
  updateAgent: closedObject("Replace the editable profile for one local agent.", {
    id: agentId,
    profile: profileSchema,
  }, ["id", "profile"]),
  deleteAgent: agentIdInput("Permanently delete one local agent and associated host state."),
  deleteAgents: closedObject("Permanently delete local agents and associated host state.", {
    ids: nonEmptyStringArray("Local agent IDs to delete."),
  }, ["ids"]),
  duplicateAgent: agentIdInput("Clone one local agent."),
  kickstartAgent: agentIdInput("Start a pending local-agent introduction, if eligible."),
  interruptAgentRun: agentIdInput("Interrupt the active run for one local agent."),
  requestDiskSaverAudit: agentIdInput("Request a disk-saver audit for one eligible agent."),
  setAgentUnread: closedObject("Set a local agent's unread state.", {
    id: agentId,
    isUnread: { type: "boolean" },
    atMs: { type: "number", description: "Optional unread activity timestamp." },
  }, ["id", "isUnread"]),
  setAgentNotifyOnUpdates: closedObject("Enable or disable update notifications for one local agent.", {
    id: agentId,
    isEnabled: { type: "boolean" },
  }, ["id", "isEnabled"]),
  setAgentHiddenFromSidebar: closedObject("Show or hide one local agent in the sidebar.", {
    id: agentId,
    isHidden: { type: "boolean" },
  }, ["id", "isHidden"]),
  openAgent: agentIdInput("Activate one local agent and return its transcript."),
  openAgentWindowed: closedObject("Activate one local agent and return a bounded transcript window.", {
    id: agentId,
    limit: positiveLimit(5_000, "Maximum transcript entries."),
  }, ["id"]),
  openAgentTail: closedObject("Activate one local agent and return its newest transcript entries.", {
    id: agentId,
    limit: positiveLimit(5_000, "Maximum transcript entries."),
  }, ["id"]),
  setWindowFocused: closedObject("Report whether the desktop window is focused.", {
    isFocused: { type: "boolean" },
  }, ["isFocused"]),
  getAgentMemories: agentIdInput("List durable memories for one local agent."),
  deleteAgentMemory: closedObject("Delete one durable memory from a local agent.", {
    id: agentId,
    memoryId: nonEmptyString("Memory ID."),
  }, ["id", "memoryId"]),
  clearAgentMemories: agentIdInput("Delete every durable memory for one local agent."),
  getAgentAutomations: agentIdInput("List automations for one local agent."),
  getAutomationWebhookCredential: closedObject("Read or mint the stock-host webhook credential for one automation.", {
    id: agentId,
    automationId: nonEmptyString("Automation ID."),
  }, ["id", "automationId"]),
  getAgentWorkflows: agentIdInput("List workflows for one local agent."),
  getConversationOutline: agentIdInput("Read the generated conversation outline for one local agent."),
  portAgentLocalSkills: agentIdInput("Import eligible local skills into one agent."),
  getAgentChannels: agentIdInput("List connected channels for one local agent."),
  getSubagents: agentIdInput("List subagents associated with one local agent."),
  getAsyncTasks: agentIdInput("List asynchronous tasks associated with one local agent."),
  setAgentAvatarBytes: closedObject("Set or clear a local agent avatar PNG.", {
    id: agentId,
    pngBase64: {
      anyOf: [avatarPngBase64, { type: "null" }],
      description: "PNG bytes as base64, or null to clear the avatar.",
    },
  }, ["id", "pngBase64"]),
  getAgentAvatar: agentIdInput("Read a local agent avatar data URL and version."),
  getAgentNotificationAvatar: agentIdInput("Read notification-safe avatar metadata; image bytes are not returned."),

  getLocalToolPermissionStatus: {
    ...closedObject("Read local-tool permission state, optionally selecting one pending request.", {
      agentId,
      requestId,
    }),
    not: { required: ["agentId", "requestId"] },
  },

  getMcpPluginLogo: closedObject("Fetch and validate one MCP plugin logo data URL.", {
    url: { type: "string", minLength: 1, format: "uri" },
  }, ["url"]),
  installMcpEntry: closedObject("Install an MCP catalog entry with optional variable values.", {
    entryId: mcpPluginId,
    values: stringMap("Installer variables. Values may contain credentials."),
    hasTeamConfiguredVariables: { type: "boolean" },
  }, ["entryId"]),
  updateMcpPluginInstall: closedObject("Replace variable values for an installed MCP plugin.", {
    pluginId: mcpPluginId,
    values: stringMap("Replacement installer variables. Values may contain credentials."),
  }, ["pluginId", "values"]),
  setMcpCustomInstructions: closedObject("Replace custom instructions for one installed MCP server.", {
    serverId: mcpServerId,
    instructions: { type: "string" },
  }, ["serverId", "instructions"]),
  listMcpServerTools: closedObject("List tools exposed by one installed MCP server.", {
    serverId: mcpServerId,
  }, ["serverId"]),
  toggleMcpToolDisabled: closedObject("Toggle whether one tool is disabled on an installed MCP server.", {
    serverId: mcpServerId,
    toolName: nonEmptyString("Exact MCP tool name."),
  }, ["serverId", "toolName"]),
  getMcpPlugin: closedObject("Read one installed MCP plugin by ID.", {
    pluginId: mcpPluginId,
  }, ["pluginId"]),
  installMcpPlugin: closedObject("Install one MCP plugin with optional variable values.", {
    pluginId: mcpPluginId,
    values: stringMap("Installer variables. Values may contain credentials."),
  }, ["pluginId"]),
  uninstallMcpPlugin: closedObject("Uninstall one MCP plugin.", {
    pluginId: mcpPluginId,
  }, ["pluginId"]),
  addMcpServer: closedObject("Add a custom MCP server configuration.", {
    name: nonEmptyString("Display name for the custom server."),
    configJson: {
      description: "MCP server configuration as a JSON object or serialized JSON string.",
      anyOf: [
        { type: "object", additionalProperties: true },
        { type: "string", minLength: 2 },
      ],
    },
  }, ["name", "configJson"]),
  removeMcpServer: closedObject("Remove one custom MCP server.", {
    serverId: mcpServerId,
  }, ["serverId"]),
  setMcpInstructions: closedObject("Replace instructions for one installed MCP server.", {
    serverId: mcpServerId,
    instructions: { type: "string" },
  }, ["serverId", "instructions"]),
  authenticateMcpServer: closedObject("Start or repeat authentication for one MCP server/account.", {
    serverId: mcpServerId,
    accountKey: { type: "string" },
    requestingAgentId: { type: "string" },
    forceReauth: { type: "boolean" },
    trigger: { type: "string", const: "connector_card" },
  }, ["serverId"]),
  logoutMcpAccount: closedObject("Log out one account from an MCP server.", {
    serverId: mcpServerId,
    accountKey: nonEmptyString("MCP account key."),
  }, ["serverId", "accountKey"]),
  renameMcpAccount: closedObject("Rename one account on an MCP server.", {
    serverId: mcpServerId,
    accountKey: nonEmptyString("Current MCP account key."),
    newAccountKey: nonEmptyString("Replacement MCP account key."),
  }, ["serverId", "accountKey", "newAccountKey"]),
  removeMcpAccount: closedObject("Remove one account from an MCP server.", {
    serverId: mcpServerId,
    accountKey: nonEmptyString("MCP account key."),
  }, ["serverId", "accountKey"]),
  listBoxMcpServers: closedObject("Read status for selected box-side MCP servers.", {
    serverIdentifiers: stringArray("MCP server identifiers."),
  }, ["serverIdentifiers"]),
  executeRoutedMcpTool: closedObject("Execute one routed MCP tool through Grok Bot.", {
    agentId,
    toolName: nonEmptyString("Routed tool display name."),
    name: nonEmptyString("Provider tool name."),
    providerIdentifier: nonEmptyString("MCP provider identifier."),
    args: { type: "object", additionalProperties: true },
    toolCallId: nonEmptyString("Tool-call correlation ID."),
  }, ["agentId", "toolName", "name", "providerIdentifier", "args", "toolCallId"]),

  listCloudAgents: closedObject("List Cloud Agents visible to the configured account.", {
    limit: positiveLimit(500, "Maximum Cloud Agents."),
    includeArchived: { type: "boolean", description: "Include archived Cloud Agents." },
  }),
  getCloudAgent: cloudAgentIdInput("Read one Cloud Agent."),
  getCloudAgentInfo: closedObject("Read detailed Cloud Agent information.", {
    bcId: cloudAgentId,
    includeFiles: { type: "boolean", description: "Include file metadata when supported." },
  }, ["bcId"]),
  launchCloudAgent: closedObject("Launch a Cloud Agent task.", {
    prompt: { type: "string", minLength: 1, description: "Task prompt; whitespace is preserved." },
    repoUrl: { type: "string", format: "uri", description: "Optional repository URL." },
    startingRef: { type: "string", description: "Optional branch, tag, or commit." },
    environment: cloudEnvironment,
    modelId: { type: "string", description: "Optional model override." },
    modelParams: stringMap("Optional model parameter values."),
    images: cloudImages,
    title: { type: "string", description: "Optional task title." },
  }, ["prompt"]),
  watchCloudAgent: closedObject("Read one bounded Cloud Agent status snapshot. Poll until terminal is true.", {
    bcId: cloudAgentId,
    waitForRestart: { type: "boolean", description: "Report waiting_for_restart while the current run remains terminal." },
  }, ["bcId"]),
  replyToCloudAgent: closedObject("Send a follow-up to a Cloud Agent.", cloudReplyProperties, ["bcId", "prompt"]),
  cancelCloudAgent: cloudAgentIdInput("Cancel a Cloud Agent task."),
  renameCloudAgent: closedObject("Rename a Cloud Agent task.", {
    bcId: cloudAgentId,
    title: nonEmptyString("Replacement title."),
  }, ["bcId", "title"]),
  archiveCloudAgent: cloudAgentIdInput("Archive a Cloud Agent task."),
  unarchiveCloudAgent: cloudAgentIdInput("Unarchive a Cloud Agent task."),
  deleteCloudAgent: cloudAgentIdInput("Permanently delete a Cloud Agent task."),
  listCloudAgentArtifacts: cloudAgentIdInput("List artifacts produced by a Cloud Agent."),
  getCloudAgentTranscript: cloudAgentIdInput("Export a bounded, field-name-redacted JSONL transcript with lineCount, totalLineCount, byteCount, truncated, and limits metadata."),

  transcribeAudio: closedObject("Transcribe an audio payload through Grok Bot inference.", {
    audioBase64: base64Payload,
    mimeType: { type: "string", maxLength: 255, description: "Audio MIME type; an empty string defaults to audio/webm." },
    language: { type: "string", minLength: 1, maxLength: 64, description: "Optional language hint." },
  }, ["audioBase64", "mimeType"]),
  connectChannel: closedObject("Connect an external channel to one local agent.", {
    id: agentId,
    platform: nonEmptyString("Channel platform identifier."),
    token: nonEmptyString("Channel authentication token."),
  }, ["id", "platform", "token"]),
  disconnectChannel: closedObject("Disconnect an external channel from one local agent.", {
    id: agentId,
    platform: nonEmptyString("Channel platform identifier."),
  }, ["id", "platform"]),
  refreshChannel: closedObject("Refresh external-channel state for one local agent.", {
    id: agentId,
    platform: nonEmptyString("Channel platform identifier."),
  }, ["id", "platform"]),
  getListenerConnectUrl: closedObject("Create an authenticated listener connection URL.", {
    platform: nonEmptyString("Listener platform identifier."),
  }, ["platform"]),

  uploadAttachment: {
    ...closedObject("Upload attachment bytes for an agent. Non-video files accept 25 MiB; .m4v, .mov, .mp4, .ogv, and .webm accept 200 MiB.", {
      agentId,
      filename: nonEmptyString("Original attachment filename; the extension selects the decoded byte limit."),
      bytesBase64: videoBase64Payload,
    }, ["filename", "bytesBase64"]),
    anyOf: [
      {
        properties: {
          filename: { type: "string", pattern: VIDEO_ATTACHMENT_EXTENSION_PATTERN },
          bytesBase64: videoBase64Payload,
        },
        required: ["filename", "bytesBase64"],
      },
      {
        properties: {
          filename: { type: "string", not: { pattern: VIDEO_ATTACHMENT_EXTENSION_PATTERN } },
          bytesBase64: base64Payload,
        },
        required: ["filename", "bytesBase64"],
      },
    ],
  },
  readAttachmentImage: closedObject("Read an agent-owned image attachment.", {
    path: nonEmptyString("Host attachment path."),
  }, ["path"]),
  readAttachmentText: closedObject("Read a text preview from an agent attachment.", {
    agentId,
    path: nonEmptyString("Host attachment path."),
  }, ["path"]),
  readAttachmentChunk: closedObject("Read a bounded byte range from an agent attachment.", {
    agentId,
    path: nonEmptyString("Host attachment path."),
    offset: {
      type: "integer",
      minimum: 0,
      description: "Zero-based byte offset.",
    },
    length: {
      type: "integer",
      minimum: 0,
      maximum: 8 * 1024 * 1024,
      description: "Requested byte count; zero returns metadata only.",
    },
    videoPlayback: {
      type: "boolean",
      description: "Use the video-playback read path.",
    },
  }, ["path", "offset", "length"]),
} as const satisfies Readonly<Record<string, GatewayInputSchema>>;

/** Known fields for legacy forwarding APIs whose nested contracts stay open. */
const PARTIAL_INPUT_SCHEMAS = {
  appendConnectorCard: partialObject("Append a connector card to an agent transcript.", messageTargetProperties),
  setAgentNotificationsEnabled: partialObject("Set notification enablement for an agent.", {
    id: agentId,
    isEnabled: { type: "boolean" },
  }, ["id", "isEnabled"]),
  createAgentAutomation: partialObject("Create an automation for one local agent.", {
    id: agentId,
    spec: { type: "object", additionalProperties: true },
  }, ["id", "spec"]),
  updateAgentAutomation: partialObject("Update one local-agent automation.", {
    id: agentId,
    automationId: nonEmptyString("Automation ID."),
    spec: { type: "object", additionalProperties: true },
  }, ["id", "automationId", "spec"]),
  setAgentAutomationEnabled: partialObject("Enable or pause one local-agent automation.", {
    id: agentId,
    automationId: nonEmptyString("Automation ID."),
    isEnabled: { type: "boolean", description: "Whether the automation should be enabled." },
  }, ["id", "automationId", "isEnabled"]),
  runAgentAutomationNow: partialObject("Run one local-agent automation immediately.", {
    id: agentId,
    automationId: nonEmptyString("Automation ID."),
  }, ["id", "automationId"]),
  deleteAgentAutomation: partialObject("Delete one local-agent automation.", {
    id: agentId,
    automationId: nonEmptyString("Automation ID."),
  }, ["id", "automationId"]),
  createAgentWorkflow: partialObject("Create a workflow for one local agent.", {
    id: agentId,
    spec: { type: "object", additionalProperties: true },
  }, ["id", "spec"]),
  updateAgentWorkflow: partialObject("Update one local-agent workflow.", {
    id: agentId,
    workflowId: nonEmptyString("Workflow ID."),
    spec: { type: "object", additionalProperties: true },
  }, ["id", "workflowId", "spec"]),
  setAgentWorkflowEnabled: partialObject("Enable or pause one local-agent workflow.", {
    id: agentId,
    workflowId: nonEmptyString("Workflow ID."),
    isEnabled: { type: "boolean", description: "Whether the workflow should be enabled." },
  }, ["id", "workflowId", "isEnabled"]),
  runAgentWorkflowNow: partialObject("Run one local-agent workflow immediately.", {
    id: agentId,
    workflowId: nonEmptyString("Workflow ID."),
  }, ["id", "workflowId"]),
  deleteAgentWorkflow: partialObject("Delete one local-agent workflow.", {
    id: agentId,
    workflowId: nonEmptyString("Workflow ID."),
  }, ["id", "workflowId"]),
  importAgentWorkflowText: partialObject("Import a workflow from pasted Markdown.", {
    id: agentId,
    markdown: { type: "string", description: "Markdown workflow source." },
    name: { type: "string", description: "Optional fallback workflow name." },
  }, ["id", "markdown"]),
  importAgentWorkflowUrl: partialObject("Import a live workflow reference from a URL.", {
    id: agentId,
    url: { type: "string", description: "Workflow source URL." },
    name: { type: "string", description: "Optional workflow name override." },
  }, ["id", "url"]),
  startTeachRecording: partialObject("Start a teach-mode recording for one local agent.", {
    agentId,
    entryPoint: { type: "string", description: "Optional recording entry-point label." },
  }, ["agentId"]),
  stopTeachRecording: partialObject("Stop a teach-mode recording and save or discard it.", {
    agentId,
    save: { type: "boolean", description: "Save the recording when true; discard it when false." },
  }, ["agentId", "save"]),
  setHostSettings: partialObject("Patch host settings; omitted fields remain unchanged.", {
    inferenceProvider: { type: "string", description: "Inference provider identifier." },
    localToolPermission: { type: "string", enum: ["always", "ask", "never"] },
    webauthnProxyEnabled: { type: "boolean" },
    userTimeZone: { type: "string" },
    userTimeZoneOverride: { type: "string" },
    pinnedAgentIds: stringArray("Pinned local-agent IDs."),
    hasSeenOnboarding: { type: "boolean" },
  }),
  refreshMcp: partialObject("Restart MCP or route a legacy MCP action.", {
    routedAction: { type: "string", enum: ["list-tools", "execute-tool"] },
    routedArgs: { type: "object", additionalProperties: true },
    completion: { type: "object", additionalProperties: true },
  }),
} as const satisfies Readonly<Record<string, GatewayInputSchema>>;

const DESCRIPTIONS: Readonly<Record<string, string>> = {
  listGatewayServices: "Negotiate the live gateway method manifest and host capability flags.",
  getTranscript: "Read the active local agent transcript.",
  getAgentTranscript: "Read the complete transcript for one local agent.",
  getAgentTranscriptPage: "Read a time-bounded page from one local agent transcript.",
  getAgentTranscriptWindow: "Read a cursor-based transcript window with reply-thread counts.",
  getAgentTranscriptTail: "Read the newest entries from one local agent transcript.",
  getAgentThread: "Read a reply thread rooted at one transcript entry.",
  sendPrompt: "Admit a prompt for a local agent; completion means accepted, not that the turn finished.",
  promptAcceptanceStatus: "Look up whether an idempotent send nonce was accepted.",
  listAgents: "List local agents using avatar-light summaries.",
  countAgents: "Count locally stored agents.",
  getAuthStatus: "Read sanitized authentication readiness without returning credentials.",
  getRuntimeStatus: "Read active-agent and run-queue diagnostics.",
  listLocalComputers: "List sanitized local-computer targets and connection state.",
  getLocalToolPermissionStatus: "Read local-tool permission and pending-request diagnostics.",
  getSearchStatus: "Read local conversation-search readiness and limits.",
  createAgent: "Create and activate a local Grok Bot agent.",
  interruptAgentRun: "Interrupt the currently active run for a local agent.",
  getAgentNotificationAvatar: "Read notification-safe avatar metadata without transferring image bytes.",
  getMcpState: "Read sanitized MCP installation, account, and server state.",
  getMcpCatalog: "List the sanitized MCP catalog available to this account.",
  getEffectiveMcpPlugins: "List the sanitized effective MCP plugin configuration.",
  listMcpServers: "List sanitized installed MCP servers.",
  listMcpPlugins: "List sanitized installed MCP plugins.",
  restartMcpServers: "Restart the local MCP server manager.",
  listCloudAgents: "List Cloud Agent tasks, optionally including archived tasks.",
  listCloudAgentModels: "List models available to Cloud Agents.",
  getCloudAgent: "Read one Cloud Agent task.",
  launchCloudAgent: "Launch a new Cloud Agent task.",
  watchCloudAgent: "Read one Cloud Agent status snapshot; poll until terminal is true.",
  replyToCloudAgent: "Send a follow-up prompt to a Cloud Agent task.",
  getCloudAgentTranscript: "Export bounded, field-name-redacted Cloud Agent JSONL with truncation metadata.",
  transcribeAudio: "Transcribe up to 25 MiB of base64-encoded audio.",
};

function defaultDescription(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}.`;
}

export function serviceMetadataForMethod(
  name: string,
  acceptsInput: boolean,
): GatewayServiceMetadata {
  const description = DESCRIPTIONS[name] ?? defaultDescription(name);
  if (!acceptsInput) {
    return {
      description,
      inputSchema: closedObject(`The ${name} gateway service takes no arguments.`),
      inputSchemaKind: "exact",
    };
  }
  const exact = EXACT_INPUT_SCHEMAS[name as keyof typeof EXACT_INPUT_SCHEMAS];
  if (exact !== undefined) return { description, inputSchema: exact, inputSchemaKind: "exact" };
  const partial = PARTIAL_INPUT_SCHEMAS[name as keyof typeof PARTIAL_INPUT_SCHEMAS];
  if (partial !== undefined) return { description, inputSchema: partial, inputSchemaKind: "partial" };
  return {
    description,
    inputSchema: {
      type: "object",
      description: `Arguments for ${name}. The audited gateway proves an object request but not a stable field-level contract.`,
      additionalProperties: true,
    },
    inputSchemaKind: "generic",
  };
}
