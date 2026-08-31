import { Clock, Deferred, Effect, Either, Fiber, Stream } from "effect";

import {
  GATEWAY_METHOD_PATTERN,
  GATEWAY_SERVICE_CATALOG,
  findService,
  type GatewayInputSchema,
  type GatewayServiceDescriptor,
} from "./catalog.js";
import {
  Gateway,
  MAX_GATEWAY_JSON_RESPONSE_BYTES,
  type GatewayServices,
} from "./gateway.js";
import {
  CliInputError,
  CLI_VERSION,
  errorBody,
  type CliFailure,
  type ErrorBody,
} from "./model.js";
import { CliOutput, jsonStringify } from "./output.js";
import { readBoundedLines } from "./bounded-lines.js";
import {
  formatGatewaySchemaIssues,
  isCanonicalBase64,
  validateGatewayJsonSchema,
} from "./schema-validation.js";

const DEFAULT_PROTOCOL_VERSION = "2025-11-25";
const SUPPORTED_LEGACY_PROTOCOL_VERSIONS = new Set([
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
]);
export const DEFAULT_MCP_MAX_MESSAGE_BYTES = 40 * 1024 * 1024;
export const MAX_MCP_MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MCP_MAX_OUTPUT_MESSAGE_BYTES = 40 * 1024 * 1024;
export const MIN_MCP_MAX_OUTPUT_MESSAGE_BYTES = 2 * 1024;
export const MAX_MCP_MAX_OUTPUT_MESSAGE_BYTES = 64 * 1024 * 1024;
export const MAX_MCP_ACTIVE_REQUESTS = 64;
export const MAX_MCP_ACTIVE_REQUEST_BYTES = 64 * 1024 * 1024;
export const MAX_MCP_ACTIVE_OUTPUT_BYTES = 128 * 1024 * 1024;
export const MCP_SERVICE_MANIFEST_REFRESH_TTL_MS = 1_000;
export const MCP_SERVICE_MANIFEST_POLL_INTERVAL_MS = 5_000;
const MAX_SEEN_REQUEST_IDS = 100_000;
const MAX_REQUEST_ID_BYTES = 256;
const MAX_STRUCTURED_CONTENT_BYTES = 256 * 1024;
const RAW_GATEWAY_TOOL = "grok_gateway_call_unsafe";
const LEGACY_SENSITIVE_SERVICES = new Set([
  "completeMcpOAuth",
  "getListenerConnectUrl",
  "injectChromeCookies",
  "logoutMcpAccount",
  "requestWebAuthnCeremony",
  "resolveVirtualCardApproval",
]);
const OPERATIONAL_DESTRUCTIVE_SERVICES = new Set([
  "autoUpdateBoxNow",
  "generateAgentAvatarImage",
  "installMcpEntry",
  "launchCloudAgent",
  "logoutMcpAccount",
  "prepareBoxForRecreate",
  "updateForeverBox",
  "updateHostNow",
  "updateMcpPluginInstall",
]);
// Legacy multiplexer: depending on its body this can execute an arbitrary MCP
// tool or complete an authentication flow. It cannot be represented safely as
// one named MCP tool; callers must cross the conspicuous raw/RPC boundary.
const EXCLUDED_NAMED_MCP_SERVICES = new Set([
  "executeRoutedMcpTool",
  "refreshMcp",
  "setHostSettings",
]);
const HUMAN_DECISION_SERVICES = new Set([
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
]);

type JsonRpcId = string | number;
type AnyFiber = Fiber.RuntimeFiber<unknown, unknown>;
type JsonObject = Readonly<Record<string, unknown>>;

interface ActiveMcpRequest {
  readonly fiber: AnyFiber;
  readonly bytes: number;
  readonly outputBytes: number;
}

interface CachedManifestRefresh {
  readonly expiresAt: number;
  readonly result: Either.Either<GatewayServices, CliFailure>;
}

export function canAdmitMcpRequest(activeBytes: number, requestBytes: number): boolean {
  return Number.isSafeInteger(activeBytes)
    && Number.isSafeInteger(requestBytes)
    && activeBytes >= 0
    && requestBytes >= 0
    && activeBytes + requestBytes <= MAX_MCP_ACTIVE_REQUEST_BYTES;
}

export function canAdmitMcpOutput(activeBytes: number, outputBytes: number): boolean {
  return Number.isSafeInteger(activeBytes)
    && Number.isSafeInteger(outputBytes)
    && activeBytes >= 0
    && outputBytes >= 0
    && activeBytes + outputBytes <= MAX_MCP_ACTIVE_OUTPUT_BYTES;
}

/**
 * Bytes conservatively reserved for an active request's largest retained
 * result. The gateway can materialize a complete JSON response before the MCP
 * projection bounds its wire frame, so a small wire cap must not increase
 * concurrency beyond the upstream materialization budget.
 */
export function mcpOutputReservationBytes(maximumOutputBytes: number): number {
  return Math.max(maximumOutputBytes, MAX_GATEWAY_JSON_RESPONSE_BYTES);
}

/** Effective request concurrency after reserving one bounded upstream result per call. */
export function effectiveMcpActiveRequests(
  maximumOutputBytes: number,
  requestedMaximum = MAX_MCP_ACTIVE_REQUESTS,
): number {
  if (
    !Number.isSafeInteger(maximumOutputBytes)
    || maximumOutputBytes <= 0
    || !Number.isSafeInteger(requestedMaximum)
    || requestedMaximum <= 0
  ) return 0;
  return Math.min(
    MAX_MCP_ACTIVE_REQUESTS,
    requestedMaximum,
    Math.floor(MAX_MCP_ACTIVE_OUTPUT_BYTES / mcpOutputReservationBytes(maximumOutputBytes)),
  );
}

interface JsonRpcMessage {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly id?: JsonRpcId;
  readonly params?: unknown;
}

interface ParseFailure {
  readonly code: number;
  readonly message: string;
  readonly id: JsonRpcId | null;
  readonly data?: unknown;
}

interface ParseSuccess {
  readonly message: JsonRpcMessage;
}

type ParsedLine = { readonly ok: true; readonly value: ParseSuccess } | { readonly ok: false; readonly error: ParseFailure };

export interface McpToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: GatewayInputSchema;
  readonly annotations: {
    readonly readOnlyHint: boolean;
    readonly destructiveHint: boolean;
    readonly idempotentHint: boolean;
    readonly openWorldHint: boolean;
  };
}

/**
 * Safety controls for the MCP projection of Grok Bot's host gateway.
 *
 * The defaults are read-only and omit credential-bearing services. Mutation,
 * destructive, credential, and raw-call switches are deliberately
 * programmatic so a caller must expose them via equally explicit CLI flags
 * instead of accidentally inheriting an environment variable.
 */
export interface McpStdioOptions {
  readonly serverName?: string;
  readonly serverVersion?: string;
  readonly instructions?: string;
  readonly maxMessageBytes?: number;
  readonly maxOutputMessageBytes?: number;
  readonly maxActiveRequests?: number;
  /** Expose non-destructive mutations and interactive responses. Defaults to read-only. */
  readonly includeWrites?: boolean;
  readonly includeDestructive?: boolean;
  readonly includeSensitive?: boolean;
  readonly exposeRawGatewayCall?: boolean;
  readonly allowUnknownRawMethods?: boolean;
  /** Expose actions that make a decision reserved for the human operator. */
  readonly includeHumanActions?: boolean;
}

class McpRequestError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "McpRequestError";
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function validId(value: unknown): value is JsonRpcId {
  return typeof value === "string"
    ? Buffer.byteLength(value, "utf8") <= MAX_REQUEST_ID_BYTES
    : typeof value === "number" && Number.isSafeInteger(value);
}

function requestKey(id: JsonRpcId): string {
  return `${typeof id}:${String(id)}`;
}

/** Exact NDJSON wire size, including the LF appended by CliOutput. */
export function mcpOutputFrameBytes(message: Readonly<Record<string, unknown>>): number {
  return Buffer.byteLength(jsonStringify(message), "utf8") + 1;
}

/**
 * Select a response which fits the configured NDJSON frame bound. A large or
 * non-serializable response keeps its request id. The 2 KiB minimum is large
 * enough for the fixed fallback even when a valid 256-byte id consists entirely
 * of JSON-escaped control characters.
 */
export function boundMcpOutputMessage(message: JsonObject, maximum: number): JsonObject {
  let code = -32001;
  let fallbackMessage = `MCP response exceeds the ${maximum}-byte output limit.`;
  try {
    if (mcpOutputFrameBytes(message) <= maximum) return message;
  } catch {
    code = -32603;
    fallbackMessage = "MCP response is not JSON serializable.";
  }

  const id = validId(message.id) ? message.id : null;
  const correlated: JsonObject = {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message: fallbackMessage,
    },
  };
  if (mcpOutputFrameBytes(correlated) <= maximum) return correlated;

  const minimal: JsonObject = {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message: code === -32001 ? "MCP response exceeds the output limit." : "MCP response serialization failed.",
    },
  };
  if (mcpOutputFrameBytes(minimal) <= maximum) return minimal;

  // runMcpStdio rejects limits below MIN_MCP_MAX_OUTPUT_MESSAGE_BYTES, so this
  // branch is defensive for direct callers of this exported pure helper.
  return minimal;
}

function parseLine(line: string, maxMessageBytes: number): ParsedLine {
  if (Buffer.byteLength(line, "utf8") > maxMessageBytes) {
    return {
      ok: false,
      error: {
        code: -32600,
        message: `JSON-RPC message exceeds the ${maxMessageBytes}-byte limit.`,
        id: null,
      },
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    return {
      ok: false,
      error: {
        code: -32700,
        message: "Parse error",
        id: null,
      },
    };
  }

  const record = asRecord(value);
  const candidateId = record != null && Object.hasOwn(record, "id") && validId(record.id)
    ? record.id
    : null;
  if (record == null || record.jsonrpc !== "2.0" || typeof record.method !== "string" || record.method.length === 0) {
    return {
      ok: false,
      error: { code: -32600, message: "Invalid Request", id: candidateId },
    };
  }
  if (Object.hasOwn(record, "id") && !validId(record.id)) {
    return {
      ok: false,
      error: {
        code: -32600,
        message: `Request id must be a safe integer or a UTF-8 string no longer than ${MAX_REQUEST_ID_BYTES} bytes.`,
        id: null,
      },
    };
  }

  return {
    ok: true,
    value: {
      message: {
        jsonrpc: "2.0",
        method: record.method,
        ...(Object.hasOwn(record, "id") ? { id: record.id as JsonRpcId } : {}),
        ...(Object.hasOwn(record, "params") ? { params: record.params } : {}),
      },
    },
  };
}

function isOpenWorld(service: GatewayServiceDescriptor): boolean {
  return service.group === "channel"
    || service.group === "cloud-agent"
    || service.group === "mcp"
    || service.group === "sharing"
    || service.group === "skill"
    || service.name.includes("Attachment")
    || service.name.includes("Url");
}

function isDestructiveService(service: GatewayServiceDescriptor): boolean {
  return service.risk === "destructive" || OPERATIONAL_DESTRUCTIVE_SERVICES.has(service.name);
}

function isSafeService(service: GatewayServiceDescriptor, options: McpStdioOptions): boolean {
  if (EXCLUDED_NAMED_MCP_SERVICES.has(service.name)) return false;
  if (HUMAN_DECISION_SERVICES.has(service.name) && options.includeHumanActions !== true) return false;
  const destructive = isDestructiveService(service);
  if (destructive && options.includeDestructive !== true) return false;
  if (!destructive && service.risk !== "read" && options.includeWrites !== true) return false;
  if ((service.sensitiveInput || service.sensitiveOutput) && options.includeSensitive !== true) return false;
  // These credential and authentication-link services predate the catalog's
  // sensitive-input field.
  if (LEGACY_SENSITIVE_SERVICES.has(service.name) && options.includeSensitive !== true) return false;
  return true;
}

function mcpInputSchema(
  service: GatewayServiceDescriptor,
  options: McpStdioOptions,
): GatewayInputSchema {
  if (service.name !== "sendPrompt" || options.includeSensitive === true) return service.inputSchema;
  const properties = service.inputSchema.properties ?? {};
  const {
    attachmentPaths: _attachmentPaths,
    attachmentNames: _attachmentNames,
    ...safeProperties
  } = properties;
  return {
    ...service.inputSchema,
    properties: safeProperties,
  };
}

function serviceTool(service: GatewayServiceDescriptor, options: McpStdioOptions): McpToolDescriptor {
  const readOnly = service.risk === "read";
  const destructive = isDestructiveService(service);
  return {
    name: service.name,
    description: `${service.description} Grok Bot ${service.group} service; risk: ${destructive ? "destructive" : service.risk}.${service.name === "sendPrompt" && options.includeSensitive !== true ? " Host attachment paths require --include-sensitive and are forbidden in this projection." : ""}`,
    inputSchema: mcpInputSchema(service, options),
    annotations: {
      readOnlyHint: readOnly,
      destructiveHint: destructive,
      idempotentHint: readOnly,
      openWorldHint: isOpenWorld(service),
    },
  };
}

function rawGatewayTool(): McpToolDescriptor {
  return {
    name: RAW_GATEWAY_TOOL,
    description: "UNSAFE: call a Grok Bot gateway method by name. This bypasses the default MCP service safety filter.",
    inputSchema: {
      type: "object",
      properties: {
        method: {
          type: "string",
          description: "Case-sensitive host gateway method name.",
        },
        arguments: {
          type: "object",
          description: "Gateway request body.",
          additionalProperties: true,
        },
      },
      required: ["method"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  };
}

/** Build the exact tools/list projection without contacting the gateway. */
export function makeMcpTools(options: McpStdioOptions = {}): readonly McpToolDescriptor[] {
  const tools = GATEWAY_SERVICE_CATALOG
    .filter((service) => isSafeService(service, options))
    .map((service) => serviceTool(service, options));
  return options.exposeRawGatewayCall === true ? [...tools, rawGatewayTool()] : tools;
}

function encodeToolValue(value: unknown): { readonly text: string; readonly serializable: boolean } {
  try {
    const encoded = JSON.stringify(value, (_key, item) => {
      if (typeof item === "bigint") return item.toString();
      if (item instanceof Uint8Array) {
        return { encoding: "base64", data: Buffer.from(item).toString("base64") };
      }
      if (item instanceof Error) return { name: item.name, message: item.message };
      return item;
    });
    return { text: encoded ?? "null", serializable: true };
  } catch (error) {
    return {
      text: JSON.stringify({
        error: "Gateway result was not JSON serializable.",
        detail: error instanceof Error ? error.message : String(error),
      }),
      serializable: false,
    };
  }
}

const IMAGE_RESULT_SERVICES = new Set([
  "getAgentAvatar",
  "getMcpPluginLogo",
  "readAttachmentImage",
]);

interface ProjectedImageResult {
  readonly data: string;
  readonly mimeType: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

function projectImageResult(serviceName: string | undefined, value: unknown): ProjectedImageResult | null {
  if (serviceName === undefined || !IMAGE_RESULT_SERVICES.has(serviceName)) return null;
  const record = asRecord(value);
  const dataUrl = typeof value === "string"
    ? value
    : typeof record?.dataUrl === "string"
      ? record.dataUrl
      : null;
  if (dataUrl === null) return null;
  const separator = dataUrl.indexOf(",");
  if (separator < 1 || separator > 128) return null;
  const header = /^data:(image\/[a-z0-9.+-]{1,64});base64$/i.exec(dataUrl.slice(0, separator));
  const data = dataUrl.slice(separator + 1);
  if (header?.[1] === undefined || !isCanonicalBase64(data)) return null;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const metadata: Record<string, unknown> = {};
  if (serviceName === "readAttachmentImage" && record !== null) {
    for (const key of ["width", "height"] as const) {
      const dimension = record[key];
      if (dimension === null || typeof dimension === "number"
        && Number.isSafeInteger(dimension) && dimension >= 0 && dimension <= 100_000) {
        metadata[key] = dimension;
      }
    }
  } else if (serviceName === "getAgentAvatar" && record !== null) {
    const version = record.version;
    if (typeof version === "string" && version.length > 0 && version.length <= 256) {
      metadata.version = version;
    }
  }
  metadata.mimeType = header[1].toLowerCase();
  metadata.bytes = data.length / 4 * 3 - padding;
  return {
    data,
    mimeType: header[1].toLowerCase(),
    metadata,
  };
}

export function projectMcpToolResult(
  serviceName: string | undefined,
  value: unknown,
  maximumOutputBytes = DEFAULT_MCP_MAX_OUTPUT_MESSAGE_BYTES,
): JsonObject {
  const image = projectImageResult(serviceName, value);
  if (image !== null) {
    const metadata = encodeToolValue(image.metadata);
    if (
      !metadata.serializable
      || Buffer.byteLength(image.data, "utf8") + Buffer.byteLength(metadata.text, "utf8") + 2_048 > maximumOutputBytes
    ) {
      return {
        isError: true,
        content: [{
          type: "text",
          text: `OUTPUT_TOO_LARGE: Gateway image result exceeds the ${maximumOutputBytes}-byte MCP output budget.`,
        }],
      };
    }
    return {
      content: [
        { type: "image", data: image.data, mimeType: image.mimeType },
        { type: "text", text: metadata.text },
      ],
      structuredContent: image.metadata,
    };
  }

  const encoded = encodeToolValue(value);
  if (!encoded.serializable) {
    return {
      isError: true,
      content: [{ type: "text", text: encoded.text }],
    };
  }
  if (Buffer.byteLength(encoded.text, "utf8") + 2_048 > maximumOutputBytes) {
    return {
      isError: true,
      content: [{
        type: "text",
        text: `OUTPUT_TOO_LARGE: Gateway tool result exceeds the ${maximumOutputBytes}-byte MCP output budget.`,
      }],
    };
  }
  const structured = Buffer.byteLength(encoded.text, "utf8") <= MAX_STRUCTURED_CONTENT_BYTES
    ? asRecord(value)
    : null;
  return {
    content: [{ type: "text", text: encoded.text }],
    ...(structured === null ? {} : { structuredContent: structured }),
  };
}

export function sanitizeMcpFailureBody(body: ErrorBody, includeSensitive: boolean): ErrorBody {
  if (includeSensitive) return body;
  const { path: _path, ...withoutPath } = body;
  const message = (() => {
    switch (withoutPath.code) {
      case "CLI_CONFIG": return "Grok Bot gateway configuration is unavailable.";
      case "GATEWAY_UNREACHABLE": return "Grok Bot gateway is unreachable.";
      case "GATEWAY_TIMEOUT": return "Grok Bot gateway request timed out.";
      case "GATEWAY_PROTOCOL": return "Grok Bot gateway returned an invalid protocol response.";
      case "GATEWAY_RESPONSE": return "Grok Bot gateway rejected the request.";
      case "INVALID_INPUT": return "Gateway request input was rejected.";
      case "UNKNOWN_SERVICE": return "Gateway service is unavailable.";
      case "INVALID_PROTOCOL": return "Gateway protocol input was rejected.";
      default: return "Gateway tool execution failed.";
    }
  })();
  return { ...withoutPath, message };
}

function failedToolResult(error: unknown, includeSensitive: boolean): JsonObject {
  const body = sanitizeMcpFailureBody(errorBody(error), includeSensitive);
  return {
    isError: true,
    content: [{ type: "text", text: `${body.code}: ${body.message}` }],
    structuredContent: { error: body },
  };
}

function responseError(
  error: unknown,
  includeSensitive: boolean,
): { readonly code: number; readonly message: string; readonly data?: unknown } {
  if (error instanceof McpRequestError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.data === undefined ? {} : { data: error.data }),
    };
  }
  const body = sanitizeMcpFailureBody(errorBody(error), includeSensitive);
  return { code: -32603, message: "Internal error", data: body };
}

function requestedProtocolVersion(params: unknown): string {
  const record = asRecord(params);
  const version = record?.protocolVersion;
  if (typeof version !== "string" || version.length === 0 || version.length > 64) {
    throw new McpRequestError(-32602, "initialize requires params.protocolVersion.");
  }
  // This server implements the legacy initialize-based MCP revisions used by
  // OMP. For another revision, respond with the newest supported legacy
  // version so the client can accept it or disconnect per MCP negotiation.
  return SUPPORTED_LEGACY_PROTOCOL_VERSIONS.has(version)
    ? version
    : DEFAULT_PROTOCOL_VERSION;
}

function requestParams(message: JsonRpcMessage): Readonly<Record<string, unknown>> {
  const params = asRecord(message.params ?? {});
  if (params === null) throw new McpRequestError(-32602, `${message.method} params must be an object.`);
  return params;
}

function toolNameAndArguments(message: JsonRpcMessage): {
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
} {
  const params = requestParams(message);
  if (typeof params.name !== "string" || params.name.length === 0) {
    throw new McpRequestError(-32602, "tools/call requires params.name.");
  }
  const args = asRecord(params.arguments ?? {});
  if (args === null) throw new McpRequestError(-32602, "tools/call params.arguments must be an object.");
  return { name: params.name, arguments: args };
}

/**
 * Serve MCP over newline-delimited JSON-RPC 2.0 on stdin/stdout.
 *
 * This effect emits no startup banner and no diagnostics to stdout. Compose it
 * with GatewayLive and CliOutputLive; configure the latter for JSON output.
 * OMP currently handles some aborts only on its client side, so per-request
 * cancellation is best-effort; EOF or interruption of this effect still
 * interrupts every scoped in-flight gateway tool fiber.
 */
export function runMcpStdio(options: McpStdioOptions = {}) {
  return Effect.scoped(Effect.gen(function* () {
    if (options.allowUnknownRawMethods === true && options.exposeRawGatewayCall !== true) {
      return yield* Effect.fail(new CliInputError({
        code: "INVALID_INPUT",
        message: "--allow-unknown-raw requires --unsafe-raw.",
      }));
    }
    if (
      options.includeHumanActions === true
      && (
        options.includeWrites !== true
        || options.includeDestructive !== true
        || options.includeSensitive !== true
      )
    ) {
      return yield* Effect.fail(new CliInputError({
        code: "INVALID_INPUT",
        message: "--unsafe-human-actions requires --include-writes, --include-destructive, and --include-sensitive.",
      }));
    }
    if (
      options.maxMessageBytes !== undefined
      && (
        !Number.isSafeInteger(options.maxMessageBytes)
        || options.maxMessageBytes <= 0
        || options.maxMessageBytes > MAX_MCP_MAX_MESSAGE_BYTES
      )
    ) {
      return yield* Effect.fail(new CliInputError({
        code: "INVALID_INPUT",
        message: `--max-message-bytes must be a positive integer no greater than ${MAX_MCP_MAX_MESSAGE_BYTES}.`,
      }));
    }
    if (
      options.maxOutputMessageBytes !== undefined
      && (
        !Number.isSafeInteger(options.maxOutputMessageBytes)
        || options.maxOutputMessageBytes < MIN_MCP_MAX_OUTPUT_MESSAGE_BYTES
        || options.maxOutputMessageBytes > MAX_MCP_MAX_OUTPUT_MESSAGE_BYTES
      )
    ) {
      return yield* Effect.fail(new CliInputError({
        code: "INVALID_INPUT",
        message: `--max-output-message-bytes must be an integer from ${MIN_MCP_MAX_OUTPUT_MESSAGE_BYTES} through ${MAX_MCP_MAX_OUTPUT_MESSAGE_BYTES}.`,
      }));
    }
    if (
      options.maxActiveRequests !== undefined
      && (
        !Number.isSafeInteger(options.maxActiveRequests)
        || options.maxActiveRequests <= 0
        || options.maxActiveRequests > MAX_MCP_ACTIVE_REQUESTS
      )
    ) {
      return yield* Effect.fail(new CliInputError({
        code: "INVALID_INPUT",
        message: `maxActiveRequests must be an integer from 1 through ${MAX_MCP_ACTIVE_REQUESTS}.`,
      }));
    }
    const gateway = yield* Gateway;
    const output = yield* CliOutput;
    const sessionScope = yield* Effect.scope;
    const manifestRefreshMutex = yield* Effect.makeSemaphore(1);
    let cachedManifestRefresh: CachedManifestRefresh | undefined;
    const replayManifestRefresh = (result: Either.Either<GatewayServices, CliFailure>) =>
      Either.isLeft(result) ? Effect.fail(result.left) : Effect.succeed(result.right);
    const refreshManifest = manifestRefreshMutex.withPermits(1)(Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      if (cachedManifestRefresh !== undefined && now < cachedManifestRefresh.expiresAt) {
        return yield* replayManifestRefresh(cachedManifestRefresh.result);
      }
      // Effect.either keeps ordinary gateway failures cacheable for the short
      // anti-stampede window while leaving interruption and defects uncached.
      // Thus EOF/cancellation releases the permit and a waiter may retry.
      const result = yield* Effect.either(gateway.refreshServices);
      const completedAt = yield* Clock.currentTimeMillis;
      cachedManifestRefresh = {
        result,
        expiresAt: completedAt + MCP_SERVICE_MANIFEST_REFRESH_TTL_MS,
      };
      return yield* replayManifestRefresh(result);
    }));
    const writeMutex = yield* Effect.makeSemaphore(1);
    const terminalOutputFailure = yield* Deferred.make<void>();
    const tools = makeMcpTools(options);
    const toolsByName = new Map(tools.map((tool) => [tool.name, tool] as const));
    const active = new Map<string, ActiveMcpRequest>();
    let activeRequestBytes = 0;
    let activeOutputBytes = 0;
    const seenIds = new Set<string>();
    const maxMessageBytes = Number.isSafeInteger(options.maxMessageBytes) && (options.maxMessageBytes ?? 0) > 0
      ? options.maxMessageBytes!
      : DEFAULT_MCP_MAX_MESSAGE_BYTES;
    const maxOutputMessageBytes = Number.isSafeInteger(options.maxOutputMessageBytes) && (options.maxOutputMessageBytes ?? 0) > 0
      ? options.maxOutputMessageBytes!
      : DEFAULT_MCP_MAX_OUTPUT_MESSAGE_BYTES;
    const requestedMaxActiveRequests = Number.isSafeInteger(options.maxActiveRequests) && (options.maxActiveRequests ?? 0) > 0
      ? options.maxActiveRequests!
      : MAX_MCP_ACTIVE_REQUESTS;
    const maxActiveRequests = effectiveMcpActiveRequests(
      maxOutputMessageBytes,
      requestedMaxActiveRequests,
    );
    let initialized = false;
    let protocolVersion = DEFAULT_PROTOCOL_VERSION;
    let lastToolSignature: string | undefined;

    const markOutputFailed = Deferred.succeed(terminalOutputFailure, undefined).pipe(
      Effect.zipRight(Effect.sync(() => process.stdin.destroy())),
      Effect.ignore,
    );
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const listener = () => {
          Deferred.unsafeDone(terminalOutputFailure, Effect.void);
          process.stdin.destroy();
        };
        process.stdout.on("error", listener);
        return listener;
      }),
      (listener) => Effect.sync(() => process.stdout.off("error", listener)),
    );
    const emit = (message: JsonObject) => writeMutex.withPermits(1)(
      Effect.sync(() => boundMcpOutputMessage(message, maxOutputMessageBytes)).pipe(
        Effect.flatMap(output.envelope),
      ),
    ).pipe(Effect.tapError(() => markOutputFailed));
    const emitResult = (id: JsonRpcId, result: unknown) => emit({ jsonrpc: "2.0", id, result });
    const emitError = (
      id: JsonRpcId | null,
      code: number,
      message: string,
      data?: unknown,
    ) => emit({
      jsonrpc: "2.0",
      id,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    });

    const stableTools = tools.filter((tool) => tool.name === RAW_GATEWAY_TOOL
      || findService(tool.name)?.grokBot030 === true);
    let lastResolvedTools: readonly McpToolDescriptor[] | undefined;
    const toolsForServices = (services: { readonly live: boolean; readonly methods: readonly string[] }) => {
      if (!services.live) return stableTools;
      const advertised = new Set(services.methods);
      return tools.filter((tool) => tool.name === RAW_GATEWAY_TOOL || advertised.has(tool.name));
    };
    const resolveTools = refreshManifest.pipe(
      Effect.map(toolsForServices),
      Effect.tap((listed) => Effect.sync(() => {
        lastResolvedTools = listed;
      })),
      // A disconnected host should not make the MCP server itself
      // undiscoverable. Before the first successful negotiation, retain the
      // audited stable projection. Afterwards retain the last known projection
      // so a transient refresh failure cannot widen a deliberately narrow live
      // manifest or make local extensions flap in and out.
      Effect.catchAll(() => Effect.sync(() => lastResolvedTools ?? stableTools)),
    );
    const toolSignature = (next: readonly McpToolDescriptor[]) =>
      next.map((tool) => tool.name).join("\u0000");
    const publishTools = (next: readonly McpToolDescriptor[]) => Effect.sync(() => {
      lastToolSignature = toolSignature(next);
    });
    const observeTools = (next: readonly McpToolDescriptor[]) => Effect.sync(() => {
      const signature = toolSignature(next);
      const changed = lastToolSignature !== undefined && signature !== lastToolSignature;
      lastToolSignature = signature;
      return changed;
    }).pipe(
      Effect.flatMap((changed) => changed
        ? emit({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })
        : Effect.void),
    );
    let manifestMonitorStarted = false;
    const monitorManifest = Effect.sleep(MCP_SERVICE_MANIFEST_POLL_INTERVAL_MS).pipe(
      Effect.zipRight(resolveTools),
      Effect.flatMap(observeTools),
      Effect.forever,
    );
    const ensureManifestMonitor = Effect.suspend(() => {
      if (manifestMonitorStarted) return Effect.void;
      manifestMonitorStarted = true;
      return Effect.forkIn(monitorManifest, sessionScope).pipe(Effect.asVoid);
    });

    const cancelRequest = (id: JsonRpcId): Effect.Effect<boolean> => Effect.gen(function* () {
      const key = requestKey(id);
      const entry = active.get(key);
      if (entry === undefined) return false;
      active.delete(key);
      activeRequestBytes = Math.max(0, activeRequestBytes - entry.bytes);
      activeOutputBytes = Math.max(0, activeOutputBytes - entry.outputBytes);
      yield* Fiber.interrupt(entry.fiber);
      return true;
    });

    const ensureInitialized = () => {
      if (!initialized) throw new McpRequestError(-32002, "Server not initialized.");
    };

    const callTool = (message: JsonRpcMessage) => Effect.try({
      try: () => {
        ensureInitialized();
        const call = toolNameAndArguments(message);
        const selected = toolsByName.get(call.name);
        if (selected === undefined) {
          throw new McpRequestError(-32602, `Unknown or unavailable Grok Bot tool: ${call.name}`);
        }
        const validationIssues = validateGatewayJsonSchema(selected.inputSchema, call.arguments);
        if (validationIssues.length > 0) {
          throw new McpRequestError(
            -32602,
            `Invalid arguments for ${call.name}: ${formatGatewaySchemaIssues(validationIssues)}`,
            { tool: call.name, issues: validationIssues },
          );
        }
        if (call.name === RAW_GATEWAY_TOOL && options.exposeRawGatewayCall === true) {
          const method = call.arguments.method;
          const args = asRecord(call.arguments.arguments ?? {});
          if (typeof method !== "string" || !GATEWAY_METHOD_PATTERN.test(method)) {
            throw new McpRequestError(-32602, `${RAW_GATEWAY_TOOL} requires a valid arguments.method.`);
          }
          if (args === null) {
            throw new McpRequestError(-32602, `${RAW_GATEWAY_TOOL} arguments.arguments must be an object.`);
          }
          const known = findService(method);
          if (options.allowUnknownRawMethods !== true && known === undefined) {
            throw new McpRequestError(-32602, `Unknown Grok Bot gateway method: ${method}`);
          }
          if (known !== undefined) {
            const knownIssues = validateGatewayJsonSchema(mcpInputSchema(known, options), args);
            if (knownIssues.length > 0) {
              throw new McpRequestError(
                -32602,
                `Invalid arguments for ${known.name}: ${formatGatewaySchemaIssues(knownIssues)}`,
                { tool: RAW_GATEWAY_TOOL, service: known.name, issues: knownIssues },
              );
            }
          }
          return {
            method: known?.name ?? method,
            arguments: args,
            allowUnknown: options.allowUnknownRawMethods === true,
            service: undefined,
          };
        }

        if (call.name === RAW_GATEWAY_TOOL) {
          throw new McpRequestError(-32602, `Unknown or unavailable Grok Bot tool: ${call.name}`);
        }
        const service = findService(selected.name);
        if (service === undefined) {
          throw new McpRequestError(-32602, `Unknown Grok Bot gateway service: ${selected.name}`);
        }
        return {
          method: service.name,
          arguments: service.acceptsInput ? call.arguments : {},
          allowUnknown: false,
          service,
        };
      },
      catch: (error) => error,
    }).pipe(
      Effect.flatMap((call) => {
        const invoke = gateway.invoke(call.method, call.arguments, {
          allowUnknown: call.allowUnknown,
        });
        const result = call.service === undefined
          ? invoke
          : resolveTools.pipe(
            Effect.flatMap((listed) => {
              const observe = observeTools(listed);
              const available = listed.some((tool) => tool.name === call.service.name);
              return observe.pipe(Effect.zipRight(available
                ? invoke
                : Effect.fail(new CliInputError({
                  code: "UNKNOWN_SERVICE",
                  message: `Grok Bot service '${call.service.name}' is unavailable on the target host.`,
                }))));
            }),
          );
        return result.pipe(
          Effect.map((value) => projectMcpToolResult(call.service?.name, value, maxOutputMessageBytes)),
        );
      }),
      Effect.catchIf(
        (error): error is Exclude<typeof error, McpRequestError> => !(error instanceof McpRequestError),
        (error) => Effect.succeed(failedToolResult(error, options.includeSensitive === true)),
      ),
    );

    const dispatch = (message: JsonRpcMessage): Effect.Effect<unknown, unknown> => {
      switch (message.method) {
        case "initialize":
          return Effect.try({
            try: () => {
              protocolVersion = requestedProtocolVersion(message.params);
              initialized = true;
              return {
                protocolVersion,
                capabilities: {
                  tools: { listChanged: true },
                  experimental: {
                    grokBotTransportLimits: {
                      maxInputFrameBytes: maxMessageBytes,
                      maxOutputFrameBytes: maxOutputMessageBytes,
                      maxGatewayResponseBytes: MAX_GATEWAY_JSON_RESPONSE_BYTES,
                      maxActiveRequests,
                      maxActiveRequestBytes: MAX_MCP_ACTIVE_REQUEST_BYTES,
                      maxActiveOutputBytes: MAX_MCP_ACTIVE_OUTPUT_BYTES,
                    },
                  },
                },
                serverInfo: {
                  name: options.serverName ?? "grok-bot-effect-cli",
                  version: options.serverVersion ?? CLI_VERSION,
                },
                instructions: options.instructions
                  ?? `Use these tools to inspect the user's running Grok Bot. Mutating, destructive, and credential-bearing services are hidden unless explicitly enabled by the CLI operator. This session admits at most ${maxActiveRequests} concurrent requests after reserving its bounded upstream/result capacity.`,
              };
            },
            catch: (error) => error,
          });
        case "ping":
          return Effect.succeed({});
        case "tools/list":
          return Effect.try({
            try: () => {
              ensureInitialized();
              const params = requestParams(message);
              if (params.cursor !== undefined && typeof params.cursor !== "string") {
                throw new McpRequestError(-32602, "tools/list params.cursor must be a string.");
              }
            },
            catch: (error) => error,
          }).pipe(
            Effect.flatMap(() => resolveTools.pipe(
              // The response itself publishes a list discovered by this
              // request; a redundant list_changed notification before that
              // response would communicate no additional state.
              Effect.tap(publishTools),
              Effect.tap(() => ensureManifestMonitor),
              Effect.map((listed) => ({ tools: listed })),
            )),
          );
        case "tools/call":
          return callTool(message);
        default:
          return Effect.fail(new McpRequestError(-32601, `Method not found: ${message.method}`));
      }
    };

    const runRequest = (message: JsonRpcMessage & { readonly id: JsonRpcId }) => dispatch(message).pipe(
      Effect.matchEffect({
        onFailure: (error) => {
          const body = responseError(error, options.includeSensitive === true);
          return emitError(message.id, body.code, body.message, body.data);
        },
        onSuccess: (result) => emitResult(message.id, result),
      }),
    );

    const startRequest = (
      message: JsonRpcMessage & { readonly id: JsonRpcId },
      requestBytes: number,
    ) => Effect.gen(function* () {
      const key = requestKey(message.id);
      if (active.has(key)) {
        yield* emitError(message.id, -32600, `Request id is already active: ${String(message.id)}`);
        return;
      }
      if (active.size >= maxActiveRequests) {
        yield* emitError(
          message.id,
          -32000,
          `At most ${maxActiveRequests} MCP requests may be active at once.`,
        );
        return;
      }
      if (!canAdmitMcpRequest(activeRequestBytes, requestBytes)) {
        yield* emitError(
          message.id,
          -32000,
          `Active MCP requests may retain at most ${MAX_MCP_ACTIVE_REQUEST_BYTES} input bytes; wait for an earlier request to finish or cancel it.`,
        );
        return;
      }
      const outputBytes = mcpOutputReservationBytes(maxOutputMessageBytes);
      if (!canAdmitMcpOutput(activeOutputBytes, outputBytes)) {
        yield* emitError(
          message.id,
          -32000,
          `Active MCP requests may reserve at most ${MAX_MCP_ACTIVE_OUTPUT_BYTES} output bytes; wait for an earlier request to finish or cancel it.`,
        );
        return;
      }

      let fiber: AnyFiber | undefined;
      const startGate = yield* Effect.makeLatch(false);
      const task = startGate.whenOpen(runRequest(message)).pipe(
        Effect.ensuring(Effect.sync(() => {
          const current = active.get(key);
          if (fiber !== undefined && current?.fiber === fiber) {
            active.delete(key);
            activeRequestBytes = Math.max(0, activeRequestBytes - current.bytes);
            activeOutputBytes = Math.max(0, activeOutputBytes - current.outputBytes);
          }
        })),
      );
      fiber = yield* Effect.forkScoped(task);
      active.set(key, { fiber, bytes: requestBytes, outputBytes });
      activeRequestBytes += requestBytes;
      activeOutputBytes += outputBytes;
      yield* startGate.open;
    });

    const handleNotification = (message: JsonRpcMessage) => Effect.gen(function* () {
      if (message.method === "notifications/initialized") {
        // No response is allowed for a JSON-RPC notification. The initialize
        // response already made the negotiated session usable.
        return;
      }
      if (message.method === "notifications/cancelled" || message.method === "$/cancelRequest") {
        const params = asRecord(message.params);
        const requestId = params?.requestId ?? params?.id;
        if (validId(requestId)) yield* cancelRequest(requestId);
      }
      // Unknown notifications are ignored as required by JSON-RPC 2.0.
    });

    const handleLine = (line: string, lineBytes: number) => Effect.gen(function* () {
      const parsed = parseLine(line, maxMessageBytes);
      if (!parsed.ok) {
        yield* emitError(
          parsed.error.id,
          parsed.error.code,
          parsed.error.message,
          parsed.error.data,
        );
        return;
      }
      const message = parsed.value.message;
      if (message.id === undefined) {
        yield* handleNotification(message);
        return;
      }
      const key = requestKey(message.id);
      if (seenIds.has(key)) {
        yield* emitError(message.id, -32600, `Request id may not be reused during an MCP session: ${String(message.id)}`);
        return;
      }
      if (seenIds.size >= MAX_SEEN_REQUEST_IDS) {
        yield* emitError(
          message.id,
          -32000,
          `The MCP session reached its ${MAX_SEEN_REQUEST_IDS}-request id bound; reconnect before sending more requests.`,
        );
        return;
      }
      seenIds.add(key);

      // Initialization is processed synchronously so a following
      // notifications/initialized or tools/list line cannot race the session
      // state. Other requests are forked so cancellation and ping remain live.
      if (message.method === "initialize") {
        yield* runRequest(message as JsonRpcMessage & { readonly id: JsonRpcId });
      } else {
        yield* startRequest(message as JsonRpcMessage & { readonly id: JsonRpcId }, lineBytes);
      }
    });

    const input = Stream.fromAsyncIterable(readBoundedLines(process.stdin, maxMessageBytes), (error) => error).pipe(
      Stream.mapEffect((line) => {
        if (line.oversized) {
          return emitError(
            null,
            -32600,
            `JSON-RPC message exceeds the ${maxMessageBytes}-byte limit.`,
            { line: line.lineNumber },
          );
        }
        if (line.bytes == null || line.bytes.byteLength === 0) return Effect.void;
        const lineBytes = line.bytes.byteLength;
        return Effect.try({
          try: () => new TextDecoder("utf-8", { fatal: true }).decode(line.bytes),
          catch: () => new McpRequestError(-32700, "JSON-RPC messages must be valid UTF-8."),
        }).pipe(
          Effect.flatMap((text) => text.trim().length === 0 ? Effect.void : handleLine(text, lineBytes)),
          Effect.catchAll((error) => emitError(null, -32700, error instanceof Error ? error.message : String(error))),
        );
      }),
      Stream.runDrain,
      Effect.catchAll((error) => emitError(
        null,
        -32603,
        "Failed reading MCP stdio input.",
        error instanceof Error ? error.message : String(error),
      )),
    );

    yield* Effect.raceFirst(input, Deferred.await(terminalOutputFailure));

    yield* Effect.forEach(
      [...active.values()],
      (entry) => Fiber.interrupt(entry.fiber),
      { concurrency: "unbounded", discard: true },
    );
    active.clear();
    activeRequestBytes = 0;
    activeOutputBytes = 0;
  }));
}
