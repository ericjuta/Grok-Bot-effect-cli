
import {
  parseCoordinatorAgentThreadRequest,
  parseCoordinatorTranscriptWindowRequest,
} from "../shared/rpc/coordinator.js";
import { ATTACHMENT_BYTE_LIMIT } from "../shared/media/attachment-limits.js";
import { GATEWAY_ATTACHMENT_UPLOAD_STREAM_CAPABILITY } from "../shared/gateway-wire.js";
import { readPngDimensions } from "../shared/media/image-dimensions.js";
import { AVATAR_MAX_BYTES } from "./agents/agent-avatar.js";
import { SandCloudAgentDisabledError, SandCloudAgentLaunchError } from "./extensions/cloud-agents/cloud-agent-launch-error.js";
import { assertValidSandAgentId } from "./storage/agent-paths.js";

export const HOST_CAPABILITIES = [
  "orderedReplicasV1",
  "sendAcceptanceV1",
  "gatewayServicesV1",
  "mcpManagementV1",
  "mcp030CompatibilityV1",
  "cloudAgentsV1",
  "gatewayDiagnosticsV1",
  GATEWAY_ATTACHMENT_UPLOAD_STREAM_CAPABILITY
] as const;
export const CREATE_AGENT_NONCE_LEDGER_CAP = 64;
export const DISABLE_SEND_ACCEPT_RETURN_ENV = "SAND_DISABLE_SEND_ACCEPT_RETURN";

const SAND_AGENT_PURPOSES = new Set(["disk-saver", "plugin-auth"]);
const TEMPLATE_ID_PATTERN = /^[a-z0-9-]{1,64}$/;
const SENSITIVE_GATEWAY_FIELD_NAMES = new Set([
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "authtoken",
  "apitoken",
  "bearertoken",
  "sessiontoken",
  "apikey",
  "clientsecret",
  "password",
  "secret",
  "secrets",
  "credential",
  "credentials",
  "authorization",
  "machineid"
]);
const UNSAFE_RECORD_KEYS = new Set(["__proto__", "prototype", "constructor"]);
export const MCP_PLUGIN_LOGO_DATA_URL_MAX_LENGTH = 700_000;
/** Reconstructed host safety bound; the 0.30 coordinator itself had no audio byte cap. */
export const GATEWAY_TRANSCRIBE_AUDIO_MAX_BYTES = ATTACHMENT_BYTE_LIMIT;
export const GATEWAY_TRANSCRIBE_MIME_TYPE_MAX_LENGTH = 255;
export const GATEWAY_TRANSCRIBE_LANGUAGE_MAX_LENGTH = 64;
export const GATEWAY_AVATAR_MAX_DIMENSION = 4_096;
export const GATEWAY_CLOUD_IMAGE_MAX_ITEMS = 8;
export const GATEWAY_CLOUD_IMAGE_MAX_TOTAL_BYTES = ATTACHMENT_BYTE_LIMIT;
export const GATEWAY_CLOUD_IMAGE_MIME_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp"
]);
export const GATEWAY_ROUTED_MCP_ARGUMENT_MAX_BYTES = 1 * 1024 * 1024;
export const GATEWAY_ROUTED_MCP_SCHEMA_MAX_BYTES = 256 * 1024;
export const GATEWAY_ROUTED_MCP_INLINE_TEXT_MAX_BYTES = 256 * 1024;
export const GATEWAY_ROUTED_MCP_INLINE_IMAGE_MAX_BYTES = 1 * 1024 * 1024;
export const GATEWAY_ROUTED_MCP_INLINE_RESULT_MAX_BYTES = 4 * 1024 * 1024;
export const GATEWAY_ROUTED_MCP_MAX_CONTENT_ITEMS = 128;
export const GATEWAY_JSON_PROJECTION_MAX_DEPTH = 32;
export const GATEWAY_JSON_PROJECTION_MAX_NODES = 20_000;
export const GATEWAY_ROUTED_MCP_JSON_MAX_DEPTH = GATEWAY_JSON_PROJECTION_MAX_DEPTH;
export const GATEWAY_ROUTED_MCP_JSON_MAX_NODES = GATEWAY_JSON_PROJECTION_MAX_NODES;
export const GATEWAY_SERVICE_RESULT_MAX_BYTES = ATTACHMENT_BYTE_LIMIT;
export const GATEWAY_SERVICE_RESULT_OMISSION_ERROR =
  "Gateway service result was omitted because it exceeded safe JSON projection limits.";
export const GATEWAY_ROUTED_MCP_IMAGE_MIME_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp"
]);

type DynamicMethod = (...args: any[]) => any;
export type DynamicGatewayApi = Record<string, any>;

export interface HostGatewayDependencies {
  readonly extensions: {
    api(id: string): DynamicGatewayApi;
  };
  readonly hostEvents: {
    emit(event: unknown): unknown;
  };
  readonly rosterBookkeeping?: {
    readonly latestActiveAgentId: string | null;
  };
  decorateForeverBoxStatus(status: any): any;
  getHealth(): { readonly isBusy: boolean };
  kickstartIfPending(agentId: string): Promise<boolean>;
  requestDiskSaverAudit(agentId: string): Promise<boolean>;
  releaseAgentBox(agentId: string): Promise<void>;
  handleDesktopMcpAuthCompletion(completion: unknown): Promise<void>;
  forgetLocalToolPermission(agentId: string): void;
  readonly now?: () => number;
}

function isSandAgentPurpose(value: unknown): value is string {
  return typeof value === "string" && SAND_AGENT_PURPOSES.has(value);
}

function sanitizeTemplateId(value: unknown): string | undefined {
  return typeof value === "string" && TEMPLATE_ID_PATTERN.test(value)
    ? value
    : undefined;
}

function method(api: DynamicGatewayApi, name: string): DynamicMethod {
  const candidate = api[name];
  if (typeof candidate !== "function") {
    throw new Error(`host extension method is unavailable: ${name}`);
  }
  return candidate.bind(api);
}

function isGatewayRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Linear-time base64 shape check. A repeated-group RegExp can overflow the
 * JavaScript regexp stack on valid attachment-sized payloads. */
function isCanonicalBase64Shape(value: string): boolean {
  if (value.length === 0) return false;
  let unpaddedLength = value.length;
  while (unpaddedLength > 0 && value.charCodeAt(unpaddedLength - 1) === 61) {
    unpaddedLength -= 1;
  }
  const padding = value.length - unpaddedLength;
  if (padding > 2 || unpaddedLength % 4 === 1) return false;
  if (padding > 0 && (value.length % 4 !== 0 || padding !== (4 - unpaddedLength % 4) % 4)) {
    return false;
  }
  for (let index = 0; index < unpaddedLength; index += 1) {
    const code = value.charCodeAt(index);
    if (
      !(code >= 65 && code <= 90) &&
      !(code >= 97 && code <= 122) &&
      !(code >= 48 && code <= 57) &&
      code !== 43 &&
      code !== 47
    ) return false;
  }
  return true;
}

function gatewayArgs(value: unknown, operation: string): Record<string, unknown> {
  if (!isGatewayRecord(value)) {
    throw new Error(`Malformed ${operation} request: expected a JSON object`);
  }
  return value;
}

function firstArgument(
  args: Record<string, unknown>,
  names: readonly string[]
): unknown {
  for (const name of names) {
    if (Object.hasOwn(args, name)) return args[name];
  }
  return undefined;
}

function requiredStringArgument(
  args: Record<string, unknown>,
  names: readonly string[],
  operation: string,
  options?: { readonly allowEmpty?: boolean; readonly trim?: boolean }
): string {
  const value = firstArgument(args, names);
  const trim = options?.trim ?? true;
  if (value == null) {
    throw new Error(`Malformed ${operation} request: '${names[0]}' is required`);
  }
  if (typeof value !== "string") {
    throw new Error(`Malformed ${operation} request: '${names[0]}' must be a string`);
  }
  const normalized = trim ? value.trim() : value;
  if (options?.allowEmpty !== true && normalized.trim().length === 0) {
    throw new Error(`Malformed ${operation} request: '${names[0]}' is required`);
  }
  return normalized;
}

function optionalStringArgument(
  args: Record<string, unknown>,
  names: readonly string[],
  operation: string
): string | undefined {
  const value = firstArgument(args, names);
  if (value == null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`Malformed ${operation} request: '${names[0]}' must be a string`);
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function optionalBooleanArgument(
  args: Record<string, unknown>,
  names: readonly string[],
  operation: string
): boolean | undefined {
  const value = firstArgument(args, names);
  if (value == null) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`Malformed ${operation} request: '${names[0]}' must be a boolean`);
  }
  return value;
}

function optionalPositiveIntegerArgument(
  args: Record<string, unknown>,
  names: readonly string[],
  operation: string,
  maximum = Number.MAX_SAFE_INTEGER
): number | undefined {
  const value = firstArgument(args, names);
  if (value == null) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
    throw new Error(
      `Malformed ${operation} request: '${names[0]}' must be a positive integer no greater than ${maximum}`
    );
  }
  return value as number;
}

function optionalStringMapArgument(
  args: Record<string, unknown>,
  names: readonly string[],
  operation: string
): Record<string, string> | undefined {
  const value = firstArgument(args, names);
  if (value == null) return undefined;
  if (!isGatewayRecord(value)) {
    throw new Error(`Malformed ${operation} request: '${names[0]}' must be an object`);
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (UNSAFE_RECORD_KEYS.has(key) || typeof entry !== "string") {
      throw new Error(
        `Malformed ${operation} request: '${names[0]}' must contain only string values`
      );
    }
    result[key] = entry;
  }
  return result;
}

function requiredStringMapArgument(
  args: Record<string, unknown>,
  names: readonly string[],
  operation: string
): Record<string, string> {
  if (firstArgument(args, names) == null) {
    throw new Error(`Malformed ${operation} request: '${names[0]}' is required`);
  }
  return optionalStringMapArgument(args, names, operation)!;
}

function cloudAgentId(args: Record<string, unknown>, operation: string): string {
  return requiredStringArgument(
    args,
    ["bcId", "bc_id", "agentId", "agent_id", "id"],
    operation
  );
}

function normalizeCloudEnvironment(
  value: unknown,
  operation: string
): Record<string, unknown> | undefined {
  if (value == null) return undefined;
  if (!isGatewayRecord(value)) {
    throw new Error(`Malformed ${operation} request: 'environment' must be an object`);
  }
  const type = requiredStringArgument(value, ["type"], operation);
  if (type === "cloud") return { type };
  const teamId = optionalPositiveIntegerArgument(
    value,
    ["teamId", "team_id"],
    operation
  );
  if (type === "pool") {
    const name = optionalStringArgument(value, ["name"], operation);
    return {
      type,
      ...(name === undefined ? {} : { name }),
      ...(teamId === undefined ? {} : { teamId })
    };
  }
  if (type === "machine") {
    const name = requiredStringArgument(value, ["name"], operation);
    return {
      type,
      name,
      ...(teamId === undefined ? {} : { teamId })
    };
  }
  if (type === "environment") {
    const publicId = optionalStringArgument(
      value,
      ["publicId", "public_id", "id"],
      operation
    );
    const name = optionalStringArgument(value, ["name"], operation);
    if (publicId === undefined && name === undefined) {
      throw new Error(
        `Malformed ${operation} request: a saved environment needs 'publicId' or 'name'`
      );
    }
    return {
      type,
      ...(publicId === undefined ? {} : { publicId }),
      ...(name === undefined ? {} : { name })
    };
  }
  throw new Error(`Malformed ${operation} request: unsupported environment type '${type}'`);
}

function decodeGatewayImageData(
  value: unknown,
  operation: string,
  maximumBytes = ATTACHMENT_BYTE_LIMIT
): Uint8Array {
  let encoded: string | undefined;
  if (typeof value === "string") {
    encoded = value;
  } else if (Array.isArray(value)) {
    if (!value.every((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 255)) {
      throw new Error(`Malformed ${operation} request: image byte arrays must contain bytes`);
    }
    const bytes = Uint8Array.from(value as number[]);
    if (bytes.byteLength === 0 || bytes.byteLength > maximumBytes) {
      throw new Error(`Malformed ${operation} request: image bytes exceed the remaining ${maximumBytes}-byte aggregate limit`);
    }
    return bytes;
  } else if (isGatewayRecord(value) && value.type === "Buffer") {
    return decodeGatewayImageData(value.data, operation, maximumBytes);
  }
  if (encoded === undefined) {
    throw new Error(
      `Malformed ${operation} request: image data must be base64 or a byte array`
    );
  }
  const dataUrl = /^data:[^;,]+;base64,(.*)$/is.exec(encoded);
  const compact = (dataUrl?.[1] ?? encoded).replace(/\s/g, "");
  const maximumEncodedLength = Math.ceil(maximumBytes / 3) * 4;
  if (compact.length === 0 || !isCanonicalBase64Shape(compact)) {
    throw new Error(`Malformed ${operation} request: image data is not valid base64`);
  }
  if (compact.length > maximumEncodedLength) {
    throw new Error(`Malformed ${operation} request: image bytes exceed the remaining ${maximumBytes}-byte aggregate limit`);
  }
  const bytes = Uint8Array.from(Buffer.from(compact, "base64"));
  if (bytes.byteLength === 0 || bytes.byteLength > maximumBytes) {
    throw new Error(`Malformed ${operation} request: image bytes exceed the remaining ${maximumBytes}-byte aggregate limit`);
  }
  return bytes;
}

export function decodeGatewayTranscriptionAudio(
  value: unknown,
  operation = "transcribeAudio"
): Uint8Array {
  if (typeof value !== "string") {
    throw new Error(
      `Malformed ${operation} request: 'audioBase64' must be a string`
    );
  }
  const compact = value.replace(/\s/g, "");
  const maximumEncodedLength = Math.ceil(
    GATEWAY_TRANSCRIBE_AUDIO_MAX_BYTES / 3
  ) * 4;
  const maximumWrappedLength = maximumEncodedLength +
    Math.ceil(maximumEncodedLength / 76) * 2;
  if (value.length > maximumWrappedLength) {
    throw new Error(
      `Malformed ${operation} request: audio exceeds ${GATEWAY_TRANSCRIBE_AUDIO_MAX_BYTES} bytes`
    );
  }
  if (compact.length === 0) {
    throw new Error(
      `Malformed ${operation} request: 'audioBase64' must decode to non-empty audio`
    );
  }
  if (compact.length > maximumEncodedLength) {
    throw new Error(
      `Malformed ${operation} request: audio exceeds ${GATEWAY_TRANSCRIBE_AUDIO_MAX_BYTES} bytes`
    );
  }
  const match = /^([A-Za-z0-9+/_-]+)(={0,2})$/.exec(compact);
  const unpadded = match?.[1];
  if (unpadded === undefined || unpadded.length % 4 === 1) {
    throw new Error(
      `Malformed ${operation} request: 'audioBase64' is not valid base64`
    );
  }
  const canonicalInput = unpadded.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Uint8Array.from(Buffer.from(compact, "base64"));
  const canonicalDecoded = Buffer.from(bytes)
    .toString("base64")
    .replace(/=+$/u, "");
  if (canonicalDecoded !== canonicalInput) {
    throw new Error(
      `Malformed ${operation} request: 'audioBase64' is not valid base64`
    );
  }
  if (bytes.byteLength === 0) {
    throw new Error(
      `Malformed ${operation} request: 'audioBase64' must decode to non-empty audio`
    );
  }
  if (bytes.byteLength > GATEWAY_TRANSCRIBE_AUDIO_MAX_BYTES) {
    throw new Error(
      `Malformed ${operation} request: audio exceeds ${GATEWAY_TRANSCRIBE_AUDIO_MAX_BYTES} bytes`
    );
  }
  return bytes;
}

function hasWellFormedPngChunks(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 45) return false;
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let chunkIndex = 0;
  while (offset + 12 <= buffer.byteLength) {
    const length = buffer.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > buffer.byteLength) return false;
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    if (chunkIndex === 0 && (type !== "IHDR" || length !== 13)) return false;
    if (type === "IEND") return length === 0 && end === buffer.byteLength;
    offset = end;
    chunkIndex += 1;
  }
  return false;
}

/** Decode the gateway's canonical PNG transport without Buffer's permissive
 * base64 truncation behavior or an unbounded pre-validation allocation. */
export function decodeGatewayAvatarPng(
  value: unknown,
  operation = "setAgentAvatarBytes"
): Uint8Array {
  if (typeof value !== "string") {
    throw new Error(`Malformed ${operation} request: 'pngBase64' must be a base64 string or null`);
  }
  const maximumEncodedLength = Math.ceil(AVATAR_MAX_BYTES / 3) * 4;
  if (value.length === 0 || value.length > maximumEncodedLength) {
    throw new Error(`Malformed ${operation} request: avatar must be non-empty and no larger than ${AVATAR_MAX_BYTES} bytes`);
  }
  const match = /^([A-Za-z0-9+/_-]+)(={0,2})$/.exec(value);
  const unpadded = match?.[1];
  const suppliedPadding = match?.[2] ?? "";
  if (unpadded === undefined
    || unpadded.length % 4 === 1
    || /[+/]/.test(unpadded) && /[-_]/.test(unpadded)) {
    throw new Error(`Malformed ${operation} request: 'pngBase64' is not canonical base64/base64url`);
  }
  const expectedPadding = (4 - unpadded.length % 4) % 4;
  if (suppliedPadding.length > 0 && suppliedPadding.length !== expectedPadding) {
    throw new Error(`Malformed ${operation} request: 'pngBase64' has invalid padding`);
  }
  const canonicalInput = unpadded.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Uint8Array.from(Buffer.from(
    `${canonicalInput}${"=".repeat(expectedPadding)}`,
    "base64"
  ));
  if (Buffer.from(bytes).toString("base64").replace(/=+$/u, "") !== canonicalInput
    || bytes.byteLength === 0
    || bytes.byteLength > AVATAR_MAX_BYTES) {
    throw new Error(`Malformed ${operation} request: 'pngBase64' is not canonical base64/base64url`);
  }
  const dimensions = readPngDimensions(bytes);
  if (dimensions === null || !hasWellFormedPngChunks(bytes)) {
    throw new Error(`Malformed ${operation} request: avatar bytes are not a complete PNG image`);
  }
  if (dimensions.width > GATEWAY_AVATAR_MAX_DIMENSION
    || dimensions.height > GATEWAY_AVATAR_MAX_DIMENSION) {
    throw new Error(`Malformed ${operation} request: avatar dimensions exceed ${GATEWAY_AVATAR_MAX_DIMENSION}px`);
  }
  return bytes;
}

function normalizeCloudImages(
  value: unknown,
  operation: string
): Array<{ data: Uint8Array; path?: string; mimeType?: string }> | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`Malformed ${operation} request: 'images' must be an array`);
  }
  if (value.length > GATEWAY_CLOUD_IMAGE_MAX_ITEMS) {
    throw new Error(
      `Malformed ${operation} request: 'images' accepts at most ${GATEWAY_CLOUD_IMAGE_MAX_ITEMS} items`
    );
  }
  const images: Array<{ data: Uint8Array; path?: string; mimeType?: string }> = [];
  let decodedBytes = 0;
  for (const [index, entry] of value.entries()) {
    if (!isGatewayRecord(entry)) {
      throw new Error(`Malformed ${operation} request: image ${index + 1} must be an object`);
    }
    const encoded = firstArgument(entry, [
      "dataBase64",
      "data_base64",
      "base64",
      "data"
    ]);
    const path = optionalStringArgument(entry, ["path"], operation);
    const mimeType = optionalStringArgument(
      entry,
      ["mimeType", "mime_type"],
      operation
    );
    const dataUrlMimeType = typeof encoded === "string"
      ? /^data:([^;,]+);base64,/i.exec(encoded)?.[1]?.toLowerCase()
      : undefined;
    const normalizedMimeType = mimeType?.toLowerCase();
    if (
      normalizedMimeType !== undefined &&
      dataUrlMimeType !== undefined &&
      normalizedMimeType !== dataUrlMimeType
    ) {
      throw new Error(
        `Malformed ${operation} request: image ${index + 1} MIME type conflicts with its data URL`
      );
    }
    const resolvedMimeType = normalizedMimeType ?? dataUrlMimeType;
    if (
      resolvedMimeType !== undefined &&
      !GATEWAY_CLOUD_IMAGE_MIME_TYPES.has(resolvedMimeType)
    ) {
      throw new Error(
        `Malformed ${operation} request: image ${index + 1} has unsupported MIME type '${resolvedMimeType}'`
      );
    }
    const data = decodeGatewayImageData(
      encoded,
      operation,
      GATEWAY_CLOUD_IMAGE_MAX_TOTAL_BYTES - decodedBytes
    );
    decodedBytes += data.byteLength;
    images.push({
      data,
      ...(path === undefined ? {} : { path }),
      ...(resolvedMimeType === undefined ? {} : { mimeType: resolvedMimeType })
    });
  }
  return images;
}

function normalizeCloudLaunchArgs(value: unknown): Record<string, unknown> {
  const operation = "launchCloudAgent";
  const args = gatewayArgs(value, operation);
  const prompt = requiredStringArgument(args, ["prompt"], operation, { trim: false });
  const repoUrl = optionalStringArgument(args, ["repoUrl", "repo_url"], operation);
  const startingRef = optionalStringArgument(
    args,
    ["startingRef", "starting_ref"],
    operation
  );
  const environment = normalizeCloudEnvironment(args.environment, operation);
  const modelId = optionalStringArgument(
    args,
    ["modelId", "model_id", "model"],
    operation
  );
  const modelParams = optionalStringMapArgument(
    args,
    ["modelParams", "model_params"],
    operation
  );
  const images = normalizeCloudImages(args.images, operation);
  const title = optionalStringArgument(args, ["title", "name"], operation);
  return {
    prompt,
    ...(repoUrl === undefined ? {} : { repoUrl }),
    ...(startingRef === undefined ? {} : { startingRef }),
    ...(environment === undefined ? {} : { environment }),
    ...(modelId === undefined ? {} : { modelId }),
    ...(modelParams === undefined ? {} : { modelParams }),
    ...(images === undefined ? {} : { images }),
    ...(title === undefined ? {} : { title })
  };
}

function normalizeCloudReplyArgs(value: unknown): Record<string, unknown> {
  const operation = "replyToCloudAgent";
  const args = gatewayArgs(value, operation);
  const bcId = cloudAgentId(args, operation);
  const prompt = requiredStringArgument(args, ["prompt"], operation, { trim: false });
  const images = normalizeCloudImages(args.images, operation);
  const interrupt = optionalBooleanArgument(args, ["interrupt"], operation);
  const modelId = optionalStringArgument(
    args,
    ["modelId", "model_id", "model"],
    operation
  );
  const modelParams = optionalStringMapArgument(
    args,
    ["modelParams", "model_params"],
    operation
  );
  return {
    bcId,
    prompt,
    ...(images === undefined ? {} : { images }),
    ...(interrupt === undefined ? {} : { interrupt }),
    ...(modelId === undefined ? {} : { modelId }),
    ...(modelParams === undefined ? {} : { modelParams })
  };
}

function isSensitiveGatewayField(name: string): boolean {
  const normalized = name.replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (normalized === "issecret") return false;
  return SENSITIVE_GATEWAY_FIELD_NAMES.has(normalized) ||
    normalized.endsWith("token") ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("secret") ||
    normalized.includes("secretaccesskey") ||
    normalized.endsWith("privatekey") ||
    normalized.endsWith("password") ||
    normalized.endsWith("credential") ||
    normalized.endsWith("machineid");
}

export function sanitizeMcpPluginLogoResult(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MCP_PLUGIN_LOGO_DATA_URL_MAX_LENGTH
  ) return null;
  const separator = value.indexOf(",");
  if (
    separator < 1 ||
    separator > 128 ||
    !/^data:image\/[a-z0-9.+-]{1,64};base64$/i.test(value.slice(0, separator)) ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value.slice(separator + 1))
  ) return null;
  return value;
}

const OMIT_GATEWAY_JSON_VALUE = Symbol("omit-gateway-json-value");

interface BoundedGatewayJson {
  readonly value: unknown;
  readonly serialized: string;
  readonly byteLength: number;
}

type GatewayJsonProjectionContext = "value" | "schema" | "schema-map";

const GATEWAY_JSON_SCHEMA_FIELDS = new Set(["inputSchema", "outputSchema"]);
const GATEWAY_JSON_SCHEMA_MAP_FIELDS = new Set([
  "$defs",
  "definitions",
  "dependencies",
  "dependentSchemas",
  "patternProperties",
  "properties"
]);
const GATEWAY_JSON_SUBSCHEMA_FIELDS = new Set([
  "additionalItems",
  "additionalProperties",
  "allOf",
  "anyOf",
  "contains",
  "contentSchema",
  "else",
  "if",
  "items",
  "not",
  "oneOf",
  "prefixItems",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties"
]);
const GATEWAY_JSON_SCHEMA_VALUE_ANNOTATIONS = new Set([
  "default",
  "defaultValue",
  "example",
  "examples"
]);

/** Return the UTF-8 byte length of a JSON-encoded string without first
 * allocating that encoded string. Null means the caller's remaining budget
 * was exceeded. */
function boundedJsonStringByteLength(value: string, maximum: number): number | null {
  let bytes = 2; // Opening and closing quotes.
  if (bytes > maximum) return null;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    let increment: number;
    if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 ||
        code === 0x0a || code === 0x0c || code === 0x0d) {
      increment = 2;
    } else if (code <= 0x1f) {
      increment = 6;
    } else if (code <= 0x7f) {
      increment = 1;
    } else if (code <= 0x7ff) {
      increment = 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        increment = 4;
        index += 1;
      } else {
        increment = 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      increment = 6;
    } else {
      increment = 3;
    }
    if (increment > maximum - bytes) return null;
    bytes += increment;
  }
  return bytes;
}

/**
 * Sanitize an untrusted gateway value while bounding every resource that can
 * make the eventual JSON.stringify expensive. The final stringify only sees
 * an acyclic, plain JSON tree already proven to fit all limits.
 */
function boundedSanitizeAndSerializeGatewayJson(
  value: unknown,
  maximumBytes: number,
  rootContext: GatewayJsonProjectionContext = "value"
): BoundedGatewayJson | null {
  let nodes = 0;
  let enumeratedKeys = 0;
  let bytes = 0;
  const seen = new WeakSet<object>();
  const consume = (amount: number): void => {
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > maximumBytes - bytes) {
      throw new Error("gateway JSON byte budget exceeded");
    }
    bytes += amount;
  };
  const consumeString = (entry: string): void => {
    const length = boundedJsonStringByteLength(entry, maximumBytes - bytes);
    if (length == null) throw new Error("gateway JSON byte budget exceeded");
    consume(length);
  };
  const visit = (
    entry: unknown,
    depth: number,
    context: GatewayJsonProjectionContext
  ): unknown | typeof OMIT_GATEWAY_JSON_VALUE => {
    if (++nodes > GATEWAY_JSON_PROJECTION_MAX_NODES || depth > GATEWAY_JSON_PROJECTION_MAX_DEPTH) {
      throw new Error("gateway JSON complexity budget exceeded");
    }
    if (entry === null) {
      consume(4);
      return null;
    }
    switch (typeof entry) {
      case "string":
        consumeString(entry);
        return entry;
      case "boolean":
        consume(entry ? 4 : 5);
        return entry;
      case "number": {
        if (!Number.isFinite(entry)) {
          consume(4);
          return null;
        }
        const normalized = Object.is(entry, -0) ? "0" : String(entry);
        consume(normalized.length);
        return entry;
      }
      case "undefined":
      case "function":
      case "symbol":
      case "bigint":
        return OMIT_GATEWAY_JSON_VALUE;
    }
    if (ArrayBuffer.isView(entry)) {
      const marker = "[binary omitted]";
      consumeString(marker);
      return marker;
    }
    if (seen.has(entry)) {
      const marker = "[Circular]";
      consumeString(marker);
      return marker;
    }
    seen.add(entry);
    try {
      if (Array.isArray(entry)) {
        if (entry.length > GATEWAY_JSON_PROJECTION_MAX_NODES - nodes) {
          throw new Error("gateway JSON node budget exceeded");
        }
        consume(2); // Brackets.
        const safe: unknown[] = [];
        for (let index = 0; index < entry.length; index += 1) {
          if (index > 0) consume(1);
          const item = visit(
            entry[index],
            depth + 1,
            context === "schema-map" ? "schema" : context
          );
          if (item === OMIT_GATEWAY_JSON_VALUE) {
            consume(4);
            safe.push(null);
          } else {
            safe.push(item);
          }
        }
        return safe;
      }
      consume(2); // Braces.
      const safe: Record<string, unknown> = {};
      let properties = 0;
      for (const key in entry) {
        if (++enumeratedKeys > GATEWAY_JSON_PROJECTION_MAX_NODES) {
          throw new Error("gateway JSON key budget exceeded");
        }
        if (!Object.hasOwn(entry, key)) continue;
        // JSON Schema defaults and examples are values, not structural schema
        // metadata. They can contain connector credentials, so omit them
        // without invoking an accessor. Property/definition names with the
        // same spelling remain intact because schema maps use their own
        // projection context.
        if (
          context === "schema" &&
          GATEWAY_JSON_SCHEMA_VALUE_ANNOTATIONS.has(key)
        ) continue;
        // Reject before reading an accessor-backed value. visit() will consume
        // the reserved node once the value has been obtained.
        if (nodes >= GATEWAY_JSON_PROJECTION_MAX_NODES) {
          throw new Error("gateway JSON node budget exceeded");
        }
        const keyBytes = boundedJsonStringByteLength(key, maximumBytes - bytes);
        if (keyBytes == null) throw new Error("gateway JSON byte budget exceeded");
        const childContext: GatewayJsonProjectionContext = context === "schema-map"
          ? "schema"
          : context === "schema"
            ? GATEWAY_JSON_SCHEMA_MAP_FIELDS.has(key)
              ? "schema-map"
              : GATEWAY_JSON_SUBSCHEMA_FIELDS.has(key)
                ? "schema"
                : "value"
            : GATEWAY_JSON_SCHEMA_FIELDS.has(key)
              ? "schema"
              : "value";
        const item = visit(
          context !== "schema-map" && isSensitiveGatewayField(key)
            ? "[REDACTED]"
            : (entry as Record<string, unknown>)[key],
          depth + 1,
          childContext
        );
        if (item === OMIT_GATEWAY_JSON_VALUE) continue;
        if (properties++ > 0) consume(1);
        consume(keyBytes);
        consume(1); // Colon.
        Object.defineProperty(safe, key, {
          value: item,
          enumerable: true,
          configurable: true,
          writable: true
        });
      }
      return safe;
    } finally {
      seen.delete(entry);
    }
  };

  try {
    const safe = visit(value, 0, rootContext);
    if (safe === OMIT_GATEWAY_JSON_VALUE) return null;
    const serialized = JSON.stringify(safe);
    if (serialized === undefined) return null;
    const byteLength = Buffer.byteLength(serialized, "utf8");
    if (byteLength > maximumBytes) return null;
    return { value: safe, serialized, byteLength };
  } catch {
    return null;
  }
}

/** Project every extension-owned value through the same resource-bounded JSON
 * sanitizer used for routed MCP data. Limit failures never leak partial values
 * and remain distinguishable from legitimate null/undefined service results. */
export function sanitizeGatewayServiceResult(value: unknown): unknown {
  if (value === undefined) return undefined;
  const projected = boundedSanitizeAndSerializeGatewayJson(
    value,
    GATEWAY_SERVICE_RESULT_MAX_BYTES
  );
  return projected == null
    ? {
      omitted: true,
      error: GATEWAY_SERVICE_RESULT_OMISSION_ERROR
    }
    : projected.value;
}

function boundedRoutedMcpString(
  value: unknown,
  field: string,
  maximum = 512
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`Malformed executeRoutedMcpTool request: '${field}' is invalid`);
  }
  return value;
}

function jsonByteLength(value: unknown): number | null {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? null : Buffer.byteLength(json, "utf8");
  } catch {
    return null;
  }
}

function validateRoutedMcpJson(
  value: unknown,
  operation: string,
  maximumBytes: number
): void {
  let nodes = 0;
  const seen = new WeakSet<object>();
  const visit = (entry: unknown, depth: number): void => {
    if (
      ++nodes > GATEWAY_ROUTED_MCP_JSON_MAX_NODES ||
      depth > GATEWAY_ROUTED_MCP_JSON_MAX_DEPTH
    ) {
      throw new Error(`Malformed ${operation} request: JSON payload is too complex`);
    }
    if (
      entry == null ||
      typeof entry === "string" ||
      typeof entry === "boolean"
    ) return;
    if (typeof entry === "number") {
      if (!Number.isFinite(entry)) {
        throw new Error(`Malformed ${operation} request: JSON numbers must be finite`);
      }
      return;
    }
    if (typeof entry !== "object" || seen.has(entry)) {
      throw new Error(`Malformed ${operation} request: expected acyclic JSON values`);
    }
    seen.add(entry);
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item, depth + 1);
    } else {
      for (const [key, item] of Object.entries(entry)) {
        if (
          UNSAFE_RECORD_KEYS.has(key) ||
          key.length === 0 ||
          key.length > 512 ||
          /[\u0000-\u001f\u007f]/.test(key)
        ) {
          throw new Error(`Malformed ${operation} request: JSON object key is invalid`);
        }
        visit(item, depth + 1);
      }
    }
    seen.delete(entry);
  };
  visit(value, 0);
  const bytes = jsonByteLength(value);
  if (bytes == null || bytes > maximumBytes) {
    throw new Error(`Malformed ${operation} request: JSON payload is too large or invalid`);
  }
}

interface GatewayRoutedMcpTool {
  readonly name: string;
  readonly providerIdentifier: string;
  readonly toolName: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}

export function projectGatewayRoutedMcpTool(value: unknown): GatewayRoutedMcpTool | null {
  if (!isGatewayRecord(value)) return null;
  let name: string;
  let providerIdentifier: string;
  let toolName: string;
  try {
    name = boundedRoutedMcpString(value.name, "name");
    providerIdentifier = boundedRoutedMcpString(value.providerIdentifier, "providerIdentifier", 1_024);
    toolName = boundedRoutedMcpString(value.toolName, "toolName");
  } catch {
    return null;
  }
  const description = typeof value.description === "string" && value.description.length <= 16_384
    ? value.description
    : undefined;
  const boundedSchema = value.inputSchema === undefined
    ? null
    : boundedSanitizeAndSerializeGatewayJson(
      value.inputSchema,
      GATEWAY_ROUTED_MCP_SCHEMA_MAX_BYTES,
      "schema"
    );
  const inputSchema = boundedSchema?.value;
  return {
    name,
    providerIdentifier,
    toolName,
    ...(description == null ? {} : { description }),
    ...(inputSchema == null ? {} : { inputSchema })
  };
}

type GatewayRoutedMcpSpill = (
  filename: string,
  bytes: Buffer
) => Promise<string | null>;

function routedMcpResultRecord(value: unknown): Record<string, unknown> | null {
  return isGatewayRecord(value) ? value : null;
}

function routedMcpErrorProjection(caseName: string, message: unknown): Record<string, unknown> {
  const raw = typeof message === "string" && message.length > 0
    ? message.slice(0, 16_384)
    : "MCP tool execution failed.";
  const text = raw
    .replace(/\bbearer\s+[a-z0-9._~+/-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(access[_-]?token|api[_-]?key|authorization|client[_-]?secret|credential|password|refresh[_-]?token|secret|session[_-]?token|token)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1=[REDACTED]");
  return { result: { case: caseName, value: { error: text } } };
}

function decodeRoutedMcpImage(value: unknown): Buffer | null {
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value !== "string" || value.length === 0 || value.length > Math.ceil(ATTACHMENT_BYTE_LIMIT * 4 / 3) + 4) return null;
  if (!isCanonicalBase64Shape(value)) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64").replace(/=+$/, "") === value.replace(/=+$/, "")
    ? bytes
    : null;
}

function routedMcpImageExtension(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case "image/gif": return ".gif";
    case "image/jpeg": return ".jpg";
    case "image/png": return ".png";
    case "image/webp": return ".webp";
    default: return ".bin";
  }
}

/**
 * Convert generated MCP protobuf values into a small, JSON-only gateway shape.
 * Oversized content is persisted through the caller-supplied attachment spiller
 * when possible and is otherwise replaced with an explicit omission marker.
 */
export async function projectGatewayRoutedMcpResult(
  value: unknown,
  spill?: GatewayRoutedMcpSpill
): Promise<Record<string, unknown>> {
  const root = routedMcpResultRecord(value);
  const result = routedMcpResultRecord(root?.result);
  const caseName = typeof result?.case === "string" ? result.case : "error";
  const resultValue = routedMcpResultRecord(result?.value);
  if (caseName !== "success") {
    return routedMcpErrorProjection(caseName, resultValue?.error ?? resultValue?.message);
  }

  const projected: Record<string, unknown>[] = [];
  let inlineBytes = 0;
  let sequence = 0;
  const appendProjected = (item: Record<string, unknown>) => {
    if (projected.length < GATEWAY_ROUTED_MCP_MAX_CONTENT_ITEMS) {
      projected.push(item);
      return;
    }
    projected[GATEWAY_ROUTED_MCP_MAX_CONTENT_ITEMS - 1] = {
      content: {
        case: "text",
        value: { text: "Additional MCP output was omitted because the routed result reached its item limit." }
      }
    };
  };
  const appendOmissionMarker = (label: string) => {
    appendProjected({ content: { case: "text", value: { text: `${label} was omitted because it exceeded the routed MCP output limit.` } } });
  };
  const appendSpillMarker = async (bytes: Buffer, extension: string, label: string) => {
    const filename = `mcp-routed-result-${sequence++}${extension}`;
    const path = bytes.byteLength <= ATTACHMENT_BYTE_LIMIT && spill != null
      ? await spill(filename, bytes).catch(() => null)
      : null;
    const text = path == null
      ? `${label} was omitted because it exceeded the routed MCP inline-output limit.`
      : `${label} was saved as an agent attachment at ${path}.`;
    appendProjected({ content: { case: "text", value: { text } } });
  };

  const rawContent = Array.isArray(resultValue?.content) ? resultValue.content : [];
  const contentWasTruncated = rawContent.length > GATEWAY_ROUTED_MCP_MAX_CONTENT_ITEMS;
  const content = rawContent.slice(0, GATEWAY_ROUTED_MCP_MAX_CONTENT_ITEMS);
  for (const rawItem of content) {
    const item = routedMcpResultRecord(rawItem);
    const carrier = routedMcpResultRecord(item?.content);
    const payload = routedMcpResultRecord(carrier?.value);
    if (carrier?.case === "text" && typeof payload?.text === "string") {
      const byteLength = Buffer.byteLength(payload.text, "utf8");
      if (
        byteLength > GATEWAY_ROUTED_MCP_INLINE_TEXT_MAX_BYTES ||
        inlineBytes + byteLength > GATEWAY_ROUTED_MCP_INLINE_RESULT_MAX_BYTES
      ) {
        if (byteLength <= ATTACHMENT_BYTE_LIMIT) {
          await appendSpillMarker(Buffer.from(payload.text, "utf8"), ".txt", "MCP text output");
        } else {
          appendOmissionMarker("MCP text output");
        }
      } else {
        inlineBytes += byteLength;
        appendProjected({ content: { case: "text", value: { text: payload.text } } });
      }
      continue;
    }
    if (carrier?.case === "image") {
      const requestedMimeType = typeof payload?.mimeType === "string"
        ? payload.mimeType.toLowerCase()
        : "";
      const mimeType = GATEWAY_ROUTED_MCP_IMAGE_MIME_TYPES.has(requestedMimeType)
        ? requestedMimeType
        : null;
      const bytes = decodeRoutedMcpImage(payload?.data);
      if (bytes == null || mimeType == null) {
        appendProjected({ content: { case: "text", value: { text: "Invalid MCP image output was omitted." } } });
      } else if (
        bytes.byteLength > GATEWAY_ROUTED_MCP_INLINE_IMAGE_MAX_BYTES ||
        inlineBytes + bytes.byteLength > GATEWAY_ROUTED_MCP_INLINE_RESULT_MAX_BYTES
      ) {
        await appendSpillMarker(bytes, routedMcpImageExtension(mimeType), "MCP image output");
      } else {
        inlineBytes += bytes.byteLength;
        appendProjected({ content: { case: "image", value: { data: bytes.toString("base64"), mimeType } } });
      }
      continue;
    }
    appendProjected({ content: { case: "text", value: { text: "Unsupported MCP content output was omitted." } } });
  }
  if (contentWasTruncated) {
    appendOmissionMarker("Additional MCP content items");
  }

  const structured = resultValue?.structuredContent;
  if (structured !== undefined) {
    let normalized: unknown;
    try {
      normalized = typeof (structured as { toJson?: unknown })?.toJson === "function"
        ? (structured as { toJson(): unknown }).toJson()
        : structured;
    } catch {
      appendOmissionMarker("Invalid MCP structured output");
      return { result: { case: "success", value: { content: projected, isError: resultValue?.isError === true } } };
    }
    const boundedStructured = boundedSanitizeAndSerializeGatewayJson(
      normalized,
      ATTACHMENT_BYTE_LIMIT
    );
    if (
      boundedStructured != null &&
      boundedStructured.byteLength <= GATEWAY_ROUTED_MCP_SCHEMA_MAX_BYTES &&
      inlineBytes + boundedStructured.byteLength <= GATEWAY_ROUTED_MCP_INLINE_RESULT_MAX_BYTES
    ) {
      inlineBytes += boundedStructured.byteLength;
      return { result: { case: "success", value: { content: projected, isError: resultValue?.isError === true, structuredContent: boundedStructured.value } } };
    }
    if (boundedStructured != null) {
      const serialized = Buffer.from(boundedStructured.serialized, "utf8");
      await appendSpillMarker(serialized, ".json", "MCP structured output");
    } else {
      appendOmissionMarker("MCP structured output");
    }
  }
  return { result: { case: "success", value: { content: projected, isError: resultValue?.isError === true } } };
}

const AUTH_RENEWAL_OUTCOMES = new Set(["renewed", "failed"]);
const LOCAL_TOOL_PERMISSIONS = new Set(["always", "ask", "never"]);
const LOCAL_TOOL_ACTIONS = new Set([
  "run-command",
  "send-input",
  "read-file",
  "list-directory",
  "write-file"
]);
const LOCAL_TOOL_REQUEST_STATUSES = new Set([
  "pending",
  "allowed",
  "denied",
  "always",
  "never",
  "expired"
]);
const RUN_QUEUE_LANES = new Set(["user", "agent", "background"]);
const RUN_QUEUE_PHASES = new Set(["running", "interrupted"]);

function boundedString(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.slice(0, maximum);
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? value as number
    : undefined;
}

export interface GatewayAuthRenewalStatus {
  readonly outcome: "renewed" | "failed";
  readonly consecutiveFailures: number;
  readonly durationMs: number;
  readonly errorSummary: string | null;
  readonly isFirstCredential: boolean;
}

/**
 * Auth renewal objects originate next to the credential store. Keep this an
 * explicit allowlist so a future token-bearing field cannot cross the gateway.
 */
export function sanitizeGatewayAuthRenewalEvent(
  value: unknown
): GatewayAuthRenewalStatus | null {
  if (!isGatewayRecord(value) || !AUTH_RENEWAL_OUTCOMES.has(value.outcome as string)) {
    return null;
  }
  const consecutiveFailures = nonNegativeInteger(value.consecutiveFailures);
  const durationMs = nonNegativeNumber(value.durationMs);
  if (consecutiveFailures === undefined || durationMs === undefined) return null;
  return {
    outcome: value.outcome as GatewayAuthRenewalStatus["outcome"],
    consecutiveFailures,
    durationMs,
    errorSummary: boundedString(value.errorSummary, 160) ?? null,
    isFirstCredential: value.isFirstCredential === true
  };
}

export function projectGatewayAuthStatus(
  auth: DynamicGatewayApi,
  renewalEvent?: unknown
): Record<string, unknown> {
  const userFullName = boundedString(method(auth, "getUserFullName")(), 256);
  return {
    ready: method(auth, "peekAccessToken")() != null,
    userFullName: userFullName == null || userFullName.length === 0
      ? null
      : userFullName,
    lastRenewal: sanitizeGatewayAuthRenewalEvent(
      renewalEvent === undefined
        ? method(auth, "getLastRenewalEvent")()
        : renewalEvent
    )
  };
}

export interface GatewayLocalToolRequest {
  readonly id: string;
  readonly agentId: string;
  readonly action: string;
  readonly target: string;
  readonly status: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly description?: string;
}

export function sanitizeGatewayLocalToolRequest(
  value: unknown
): GatewayLocalToolRequest | null {
  if (!isGatewayRecord(value)) return null;
  const id = boundedString(value.id, 256);
  const agentId = boundedString(value.agentId, 256);
  const action = boundedString(value.action, 64);
  const target = boundedString(value.target, 10_000);
  const status = boundedString(value.status, 64);
  const createdAtMs = nonNegativeNumber(value.createdAtMs);
  const expiresAtMs = nonNegativeNumber(value.expiresAtMs);
  if (
    id === undefined || id.length === 0 ||
    agentId === undefined || agentId.length === 0 ||
    action === undefined || !LOCAL_TOOL_ACTIONS.has(action) ||
    target === undefined ||
    status === undefined || !LOCAL_TOOL_REQUEST_STATUSES.has(status) ||
    createdAtMs === undefined || expiresAtMs === undefined
  ) {
    return null;
  }
  const description = boundedString(value.description, 2_000);
  return {
    id,
    agentId,
    action,
    target,
    status,
    createdAtMs,
    expiresAtMs,
    ...(description === undefined ? {} : { description })
  };
}

export interface GatewayLocalToolPermissionEvent {
  readonly type: "created" | "settled";
  readonly request: GatewayLocalToolRequest;
}

export function sanitizeGatewayLocalToolPermissionEvent(
  value: unknown
): GatewayLocalToolPermissionEvent | null {
  if (!isGatewayRecord(value) || (value.type !== "created" && value.type !== "settled")) {
    return null;
  }
  const request = sanitizeGatewayLocalToolRequest(value.request);
  return request === null ? null : { type: value.type, request };
}

function sanitizeRunQueueDiagnostics(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  const rows: Record<string, unknown>[] = [];
  for (const entry of value.slice(0, 500)) {
    if (!isGatewayRecord(entry)) continue;
    const agentId = boundedString(entry.agentId, 256);
    if (agentId === undefined || agentId.length === 0) continue;
    const row: Record<string, unknown> = { agentId };
    for (const key of [
      "depthUser",
      "depthAgent",
      "depthBackground",
      "depthTotal",
      "oldestPendingUserAgeMs",
      "ackAgeMs",
      "ackCoalescedCount"
    ] as const) {
      const number = nonNegativeNumber(entry[key]);
      if (number !== undefined) row[key] = number;
    }
    if (typeof entry.ackOutstanding === "boolean") {
      row.ackOutstanding = entry.ackOutstanding;
    }
    if (isGatewayRecord(entry.active)) {
      const lane = boundedString(entry.active.lane, 32);
      const source = boundedString(entry.active.source, 128);
      const runtimeMs = nonNegativeNumber(entry.active.runtimeMs);
      const phase = boundedString(entry.active.phase, 32);
      if (
        lane !== undefined && RUN_QUEUE_LANES.has(lane) &&
        source !== undefined &&
        runtimeMs !== undefined &&
        phase !== undefined && RUN_QUEUE_PHASES.has(phase)
      ) {
        row.active = { lane, source, runtimeMs, phase };
      }
    }
    rows.push(row);
  }
  return rows;
}

function sanitizeLocalComputers(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  const computers: Record<string, unknown>[] = [];
  for (const entry of value.slice(0, 100)) {
    if (!isGatewayRecord(entry)) continue;
    const id = boundedString(entry.id, 256);
    const label = boundedString(entry.label, 512);
    if (id === undefined || id.length === 0 || label === undefined) continue;
    computers.push({ id, label, connected: entry.connected === true });
  }
  return computers;
}

function sanitizeGatewayTranscript(value: unknown): unknown {
  const safe = sanitizeGatewayServiceResult(value);
  if (!isGatewayRecord(safe) || typeof safe.jsonl !== "string") return safe;
  const trailingNewline = safe.jsonl.endsWith("\n");
  const lines = safe.jsonl.split("\n");
  if (trailingNewline) lines.pop();
  const jsonl = lines.map((line) => {
    try {
      return JSON.stringify(sanitizeGatewayServiceResult(JSON.parse(line)));
    } catch {
      return JSON.stringify({
        redacted: true,
        reason: "unparseable transcript line omitted"
      });
    }
  }).join("\n");
  const sanitizedJsonl = trailingNewline ? `${jsonl}\n` : jsonl;
  return {
    ...safe,
    jsonl: sanitizedJsonl,
    byteCount: Buffer.byteLength(sanitizedJsonl)
  };
}

/**
 * Restores the shipped gateway method table. Each method delegates to the
 * extension that owned the behavior in the artifact; the host layer retains
 * cross-cutting nonce dedupe, telemetry, cleanup, feature gates, and status
 * decoration.
 */
export function createHostGatewayApi(
  deps: HostGatewayDependencies
): Record<string, DynamicMethod> {
  const manager = deps.extensions.api("transcript");
  const auth = deps.extensions.api("auth");
  const attachments = deps.extensions.api("attachments");
  const automations = deps.extensions.api("automations");
  const contentSearch = deps.extensions.api("content-search");
  const localExec = deps.extensions.api("local-exec");
  const managedSetup = deps.extensions.api("managed-setup");
  const settings = deps.extensions.api("settings");
  const localToolPermission = deps.extensions.api("local-tool-permission");
  const telemetry = deps.extensions.api("telemetry");
  const sharing = deps.extensions.api("cross-user-sharing");
  const turnExecution = deps.extensions.api("turn-execution");
  const inference = deps.extensions.api("inference");
  const now = deps.now ?? Date.now;
  const createAgentMintsByNonce = new Map<string, Promise<any>>();
  const mcpManagement = () => deps.extensions.api("mcp").management;
  const cloudAgents = () => deps.extensions.api("cloud-agents");

  const assertCloudAgentWritesEnabled = async (
    extension: DynamicGatewayApi,
    operation: "launchCloudAgent" | "replyToCloudAgent"
  ): Promise<void> => {
    const authoritative = extension.isDisabledByTeamAdminForWrite;
    const cached = extension.isDisabledByTeamAdmin;
    const disabled = typeof authoritative === "function"
      ? await authoritative.call(extension)
      : typeof cached === "function"
        ? await cached.call(extension)
        : false;
    if (disabled === true) {
      throw new SandCloudAgentDisabledError(
        `${operation} refused: Cloud Agents are disabled by your team administrator`
      );
    }
  };

  const markActive = (reason: "user_action" | "app_open") => {
    method(telemetry.analytics, "markActive")(reason);
  };

  const mintAgent = async (args: any) => {
    const result = await method(manager, "createAgent")(
      {
        name: args.name,
        description: args.description,
        ...(args.title === undefined ? {} : { title: args.title }),
        ...(args.avatarShape === undefined
          ? {}
          : { avatarShape: args.avatarShape }),
        ...(args.avatarColor === undefined
          ? {}
          : { avatarColor: args.avatarColor })
      },
      args.origin,
      {
        isIntroductionSuppressed: args.isIntroductionSuppressed ?? false,
        isKickstartRequested: args.isKickstartRequested ?? false,
        ...(isSandAgentPurpose(args.purpose)
          ? { purpose: args.purpose }
          : {})
      }
    );
    markActive("user_action");
    const templateId = sanitizeTemplateId(args.templateId);
    method(telemetry.analytics, "trackEvent")("sand.agent.created", {
      agent_id: result.agent.id,
      origin: args.origin ?? "user",
      ...(templateId === undefined ? {} : { template_id: templateId })
    });
    return result;
  };

  const openAgent = async (
    args: any,
    operation: "switchAgent" | "openAgentWindowed" | "openAgentTail"
  ) => {
    markActive("app_open");
    method(telemetry, "noteSandModelExperimentActive")();
    const wasActive = method(manager, "getActiveAgentId")() === args.id;
    const startedAt = now();
    const result = operation === "switchAgent"
      ? await method(manager, operation)(args.id)
      : await method(manager, operation)(args.id, args.limit);
    const entries = operation === "switchAgent" ? result : result.entries;
    method(telemetry.logs, "reportAgentOpen")({
      conversationId: args.id,
      durationMs: now() - startedAt,
      entryCount: entries.length,
      wasActive
    });
    void deps.kickstartIfPending(args.id);
    return result;
  };

  const markSharingAction = async (name: string, args: any) => {
    markActive("user_action");
    return await method(sharing, name)(args);
  };

  const listRoutedMcpTools = async () => {
    const extension = deps.extensions.api("mcp");
    const mcp = extension.mcp;
    const tools = await method(mcp, "listTools")({});
    if (!Array.isArray(tools)) {
      throw new Error("MCP tool discovery returned an invalid result");
    }
    return tools.flatMap((tool: unknown) => {
      const projected = projectGatewayRoutedMcpTool(tool);
      return projected == null ? [] : [projected];
    });
  };
  const executeRoutedMcpTool = async (value: unknown) => {
    const operation = "executeRoutedMcpTool";
    const args = gatewayArgs(value, operation);
    const requested = {
      name: boundedRoutedMcpString(args.name, "name"),
      providerIdentifier: boundedRoutedMcpString(args.providerIdentifier, "providerIdentifier", 1_024),
      toolName: boundedRoutedMcpString(args.toolName, "toolName")
    };
    const agentId = boundedRoutedMcpString(args.agentId, "agentId");
    const toolCallId = boundedRoutedMcpString(args.toolCallId, "toolCallId", 256);
    try {
      assertValidSandAgentId(agentId);
    } catch {
      throw new Error(`Malformed ${operation} request: 'agentId' is invalid`);
    }
    const knownAgents = method(manager, "listAgentsSync")();
    if (!Array.isArray(knownAgents) || !knownAgents.some((agent: unknown) => isGatewayRecord(agent) && agent.id === agentId)) {
      throw new Error("executeRoutedMcpTool requires an existing agent identity");
    }
    const toolArgs = args.args;
    if (!isGatewayRecord(toolArgs)) {
      throw new Error(`Malformed ${operation} request: 'args' must be a JSON object`);
    }
    validateRoutedMcpJson(toolArgs, operation, GATEWAY_ROUTED_MCP_ARGUMENT_MAX_BYTES);

    const mcp = deps.extensions.api("mcp").mcp;
    const current = await method(mcp, "listTools")({});
    if (!Array.isArray(current)) {
      throw new Error("MCP tool discovery returned an invalid result");
    }
    const matches = current.flatMap((tool: unknown) => {
      const projected = projectGatewayRoutedMcpTool(tool);
      return projected != null &&
        projected.name === requested.name &&
        projected.providerIdentifier === requested.providerIdentifier &&
        projected.toolName === requested.toolName
        ? [projected]
        : [];
    });
    if (matches.length !== 1) {
      throw new Error("Requested MCP tool is unavailable, disabled, or its identity is stale");
    }
    const selected = matches[0]!;
    const executor = method(mcp, "createExecutor")(undefined, undefined, {
      agentId,
      surface: "legacy-gateway",
      toolCallId
    });
    const result = await method(executor, "execute")({}, {
      // The generated MCP executor uses `name` for the provider's raw tool name
      // and `toolName` for the collision-safe display identity.
      name: selected.toolName,
      toolName: selected.name,
      providerIdentifier: selected.providerIdentifier,
      args: toolArgs,
      toolCallId
    });
    const upload = attachments.upload;
    const spill: GatewayRoutedMcpSpill | undefined = typeof upload === "function"
      ? async (filename, bytes) => {
          const saved = await upload.call(attachments, {
            filename,
            bytesBase64: bytes.toString("base64"),
            agentId
          });
          return isGatewayRecord(saved) && typeof saved.path === "string" && saved.path.length <= 10_000
            ? saved.path
            : null;
        }
      : undefined;
    return await projectGatewayRoutedMcpResult(result, spill);
  };

  return {
    getTranscript: () => method(manager, "ensureLoaded")(),
    getAgentTranscript: (args: any) =>
      method(manager, "getAgentTranscript")(args.id),
    getAgentTranscriptPage: (args: any) =>
      method(manager, "getAgentTranscriptPage")(args.id, args),
    getAgentTranscriptWindow: (args: unknown) => {
      const request = parseCoordinatorTranscriptWindowRequest(args);
      if (request == null) throw new Error("Malformed getAgentTranscriptWindow request");
      return method(manager, "getAgentTranscriptWindow")(request.id, args);
    },
    getAgentTranscriptTail: (args: any) =>
      method(manager, "getAgentTranscriptTail")(args.id, args),
    getAgentThread: (args: unknown) => {
      const request = parseCoordinatorAgentThreadRequest(args);
      if (request == null) throw new Error("Malformed getAgentThread request");
      return method(manager, "getAgentThread")(request.id, request.rootId);
    },

    sendPrompt: async (args: any) => {
      const agentId =
        (typeof args.agentId === "string" && args.agentId.length > 0
          ? args.agentId
          : undefined) ??
        method(manager, "getActiveAgentId")() ??
        deps.rosterBookkeeping?.latestActiveAgentId ??
        "unknown";
      method(telemetry, "reportMessageSent")({
        ...args,
        agentId,
        isGroupRoom: method(manager, "listAgentsSync")()
          .find((agent: any) => agent.id === agentId)?.isGroup === true
      });
      await method(manager, "sendPrompt")(args.prompt, {
        agentId: args.agentId,
        directAddressedAcceptance: args.directAddressedAcceptance,
        attachmentPaths: args.attachmentPaths ?? [],
        attachmentNames: args.attachmentNames ?? [],
        richText: args.richText,
        replyToId: args.replyToId,
        clientNonce: args.clientNonce,
        isFork: args.isFork,
        traceparent: args.traceparent,
        enterEpochMs: args.enterEpochMs,
        composedAtMs: args.composedAtMs,
        awaitTurn: process.env[DISABLE_SEND_ACCEPT_RETURN_ENV] === "1"
      });
      return { accepted: true };
    },
    promptAcceptanceStatus: (args: any) =>
      method(manager, "promptAcceptanceStatus")(args),
    respondToWidget: (args: any) => {
      markActive("user_action");
      method(telemetry.analytics, "trackEvent")("sand.widget.responded", {
        agent_id: args.agentId
      });
      return method(manager, "respondToWidget")(
        args.entryId,
        args.value,
        args.agentId
      );
    },
    resolveAutoReviewApproval: (args: any) => {
      markActive("user_action");
      return method(
        deps.extensions.api("auto-review"),
        "resolveApproval"
      )(args);
    },
    resolveLocalToolPermission: async (args: any) => {
      markActive("user_action");
      await method(localToolPermission, "resolveAsk")(args);
    },
    dismissWidget: (args: any) => {
      markActive("user_action");
      method(telemetry.analytics, "trackEvent")("sand.widget.dismissed", {
        agent_id: args.agentId
      });
      return method(manager, "dismissWidget")(args);
    },
    submitSecret: (args: any) =>
      method(manager, "submitSecret")(
        args.entryId,
        args.value,
        args.agentId
      ),
    reactToMessage: (args: any) => {
      markActive("user_action");
      method(telemetry.analytics, "trackEvent")("sand.reaction.added", {
        agent_id: args.agentId
      });
      return method(manager, "reactToMessage")(
        args.entryId,
        args.emoji,
        args.agentId
      );
    },
    appendConnectorCard: (args: any) =>
      method(manager, "appendConnectorCard")(args),

    listAgents: () => method(manager, "listAgents")(),
    countAgents: () => method(manager, "countAgentsOnDisk")(),
    getAuthStatus: () => projectGatewayAuthStatus(auth),
    getRuntimeStatus: async () => {
      const running = method(manager, "liveRunningAgentIds")();
      const runningAgentIds = (
        Array.isArray(running) || running instanceof Set
          ? [...running]
          : []
      ).filter((value): value is string => typeof value === "string")
        .slice(0, 500)
        .map(value => value.slice(0, 256))
        .sort();
      const [agentCapReached, runReady] = await Promise.all([
        method(manager, "isAgentCapReached")(),
        method(turnExecution, "isRunReady")()
      ]);
      const activeAgentId = boundedString(
        method(manager, "getActiveAgentId")(),
        256
      );
      return {
        activeAgentId: activeAgentId ?? null,
        agentCapReached: agentCapReached === true,
        runningAgentIds,
        runQueue: sanitizeRunQueueDiagnostics(
          method(manager, "getRunQueueDiagnostics")()
        ),
        hasRunningSubagents:
          method(manager, "hasAgentsWithRunningSubagents")() === true,
        canExecute: turnExecution.canExecute === true,
        runReady: runReady === true
      };
    },
    listLocalComputers: async () =>
      sanitizeLocalComputers(
        await method(localExec.userComputers, "list")()
      ),
    getLocalToolPermissionStatus: (value: unknown = {}) => {
      const operation = "getLocalToolPermissionStatus";
      const args = gatewayArgs(value, operation);
      const agentId = optionalStringArgument(
        args,
        ["agentId", "agent_id"],
        operation
      );
      const requestId = optionalStringArgument(
        args,
        ["requestId", "request_id", "id"],
        operation
      );
      if (agentId !== undefined && requestId !== undefined) {
        throw new Error(
          `Malformed ${operation} request: provide either 'agentId' or 'requestId', not both`
        );
      }
      const pending = requestId !== undefined
        ? method(localToolPermission, "getPendingRequestById")(requestId)
        : agentId !== undefined
          ? method(localToolPermission, "getPendingRequestForAgent")(agentId)
          : undefined;
      const permission = method(localToolPermission, "permission")();
      const blockedReason = boundedString(
        method(localToolPermission, "blockedReason")(),
        2_000
      );
      const liveApprovalIds = method(localToolPermission, "liveApprovalIds")();
      return {
        permission: typeof permission === "string" &&
            LOCAL_TOOL_PERMISSIONS.has(permission)
          ? permission
          : null,
        blockedReason: blockedReason ?? null,
        requiresApproval:
          method(localToolPermission, "requiresApproval")() === true,
        pendingRequest: sanitizeGatewayLocalToolRequest(pending),
        liveApprovalIds: Array.isArray(liveApprovalIds)
          ? liveApprovalIds
              .filter((entry): entry is string => typeof entry === "string")
              .slice(0, 500)
              .map(entry => entry.slice(0, 256))
          : []
      };
    },
    getSearchStatus: async () => ({
      enabled: await method(contentSearch, "isEnabled")() === true,
      ready: contentSearch.isSearchReady === true,
      maxMatchesPerAgent:
        nonNegativeInteger(contentSearch.maxMatchesPerAgent) ?? null,
      maxResults: nonNegativeInteger(contentSearch.maxResults) ?? null
    }),
    searchAgents: async (args: any) =>
      await method(contentSearch, "isEnabled")()
        ? method(manager, "searchAgents")(args.query, args.limit)
        : [],
    searchMedia: async (args: any) =>
      await method(contentSearch, "isEnabled")()
        ? method(manager, "searchMedia")(args.query, args.limit)
        : [],
    createAgent: (args: any) => {
      const nonce = args.clientNonce;
      if (nonce == null || nonce.length === 0) return mintAgent(args);
      const pending = createAgentMintsByNonce.get(nonce);
      if (pending != null) return pending;

      const minted = mintAgent(args);
      createAgentMintsByNonce.set(nonce, minted);
      void minted.catch(() => createAgentMintsByNonce.delete(nonce));
      for (const oldest of createAgentMintsByNonce.keys()) {
        if (createAgentMintsByNonce.size <= CREATE_AGENT_NONCE_LEDGER_CAP) break;
        createAgentMintsByNonce.delete(oldest);
      }
      return minted;
    },
    kickstartAgent: async (args: any) => ({
      isIntroductionInFlight: await deps.kickstartIfPending(args.id)
    }),
    interruptAgentRun: (value: unknown = {}) => {
      const operation = "interruptAgentRun";
      const args = gatewayArgs(value, operation);
      const id = requiredStringArgument(args, ["id"], operation);
      assertValidSandAgentId(id);
      markActive("user_action");
      return method(manager, "interruptAgentRun")(id);
    },
    requestDiskSaverAudit: async (args: any) => ({
      isAuditInFlight: await deps.requestDiskSaverAudit(args.id)
    }),
    createGroup: (args: any) => method(manager, "createGroup")({
      name: args.name,
      description: args.description,
      memberIds: args.memberAgentIds
    }),
    setGroupMembers: (args: any) =>
      method(manager, "setGroupMembers")(args.id, args.memberAgentIds),
    updateAgent: (args: any) =>
      method(manager, "updateAgent")(args.id, args.profile),
    deleteAgent: async (args: any) => {
      await method(sharing, "noteAgentDeleted")(args.id);
      const result = await method(manager, "deleteAgent")(args.id);
      method(deps.extensions.api("session"), "forgetHandoff")(args.id);
      await method(automations, "deleteAgentSchedules")(args.id).catch(
        () => undefined
      );
      await deps.releaseAgentBox(args.id);
      deps.hostEvents.emit({
        kind: "notification-agent-forgotten",
        agentId: args.id
      });
      deps.forgetLocalToolPermission(args.id);
      return result;
    },
    deleteAgents: async (args: any) => {
      for (const id of args.ids) {
        await method(sharing, "noteAgentDeleted")(id);
      }
      const result = await method(manager, "deleteAgents")(args.ids);
      for (const id of args.ids) {
        method(deps.extensions.api("session"), "forgetHandoff")(id);
        await method(automations, "deleteAgentSchedules")(id).catch(
          () => undefined
        );
        await deps.releaseAgentBox(id);
        deps.hostEvents.emit({
          kind: "notification-agent-forgotten",
          agentId: id
        });
        deps.forgetLocalToolPermission(id);
      }
      return result;
    },
    duplicateAgent: (args: any) => method(manager, "cloneAgent")(args.id),
    setAgentUnread: (args: any) =>
      method(manager, "setAgentUnread")(args.id, args.isUnread, args.atMs),
    setAgentNotificationsEnabled: (value: unknown) => {
      const operation = "setAgentNotificationsEnabled";
      const args = gatewayArgs(value, operation);
      const id = requiredStringArgument(args, ["id"], operation);
      assertValidSandAgentId(id);
      const enabled = firstArgument(args, ["isEnabled", "is_enabled"]);
      if (typeof enabled !== "boolean") {
        throw new Error(
          `Malformed ${operation} request: 'isEnabled' must be a boolean`
        );
      }
      return method(manager, "setAgentNotificationsEnabled")(id, enabled);
    },
    setAgentNotifyOnUpdates: (args: any) =>
      method(manager, "setAgentNotifyOnUpdates")(args.id, args.isEnabled),
    setAgentHiddenFromSidebar: (args: any) =>
      method(manager, "setAgentHiddenFromSidebar")(args.id, args.isHidden),
    openAgent: (args: any) => openAgent(args, "switchAgent"),
    openAgentWindowed: (args: any) => openAgent(args, "openAgentWindowed"),
    openAgentTail: (args: any) => openAgent(args, "openAgentTail"),
    setWindowFocused: (args: any) =>
      method(manager, "setWindowFocused")(args.isFocused),

    getAgentMemories: (args: any) =>
      method(manager, "getAgentMemories")(args.id),
    deleteAgentMemory: (args: any) =>
      method(manager, "deleteAgentMemory")(args.id, args.memoryId),
    clearAgentMemories: (args: any) =>
      method(manager, "clearAgentMemories")(args.id),
    getAgentAutomations: (args: any) =>
      method(manager, "getAgentAutomations")(args.id),
    listAllAutomations: () => method(manager, "listAllAutomations")(),
    isAgentNetworkEnabled: () =>
      method(deps.extensions.api("experiments"), "isAgentNetworkEnabled")(),
    isGlobalSearchEnabled: () =>
      method(contentSearch, "isEnabled")(),
    isEgressTunnelAvailable: async () =>
      process.env.SAND_EGRESS_TUNNEL_ENABLED === "1",

    getSharingState: () => method(sharing, "getSharingState")(),
    createRoomFromAgent: (args: any) =>
      markSharingAction("createRoomFromAgent", args),
    createRoomInvite: (args: any) =>
      markSharingAction("createRoomInvite", args),
    joinSharedRoom: (args: any) => markSharingAction("joinSharedRoom", args),
    respondToRoomJoinRequest: (args: any) =>
      markSharingAction("respondToRoomJoinRequest", args),
    createSharedRoom: (args: any) =>
      markSharingAction("createSharedRoom", args),
    addOwnAgentToSharedRoom: (args: any) =>
      markSharingAction("addOwnAgentToSharedRoom", args),
    removeOwnAgentFromSharedRoom: (args: any) =>
      markSharingAction("removeOwnAgentFromSharedRoom", args),
    setSharedRoomTyping: (args: any) =>
      method(sharing, "setSharedRoomTyping")(args),
    leaveSharedRoom: (args: any) => markSharingAction("leaveSharedRoom", args),

    setAgentAutomationEnabled: (args: any) =>
      method(manager, "setAgentAutomationEnabled")(
        args.id,
        args.automationId,
        args.isEnabled
      ),
    createAgentAutomation: async (args: any) => {
      markActive("user_action");
      const countBefore = (await method(manager, "getAgentAutomations")(
        args.id
      )).length;
      const created = await method(manager, "createAgentAutomation")(
        args.id,
        args.spec
      );
      if (created.length > countBefore) {
        method(telemetry.analytics, "trackEvent")("sand.automation.created", {
          agent_id: args.id,
          trigger_type: args.spec.trigger.type,
          source: "automations_ui"
        });
      }
      return created;
    },
    updateAgentAutomation: (args: any) =>
      method(manager, "updateAgentAutomation")(
        args.id,
        args.automationId,
        args.spec
      ),
    deleteAgentAutomation: (args: any) =>
      method(manager, "deleteAgentAutomation")(args.id, args.automationId),
    runAgentAutomationNow: (args: any) => {
      markActive("user_action");
      return method(manager, "runAgentAutomationNow")(
        args.id,
        args.automationId
      );
    },
    broadcastToAgents: async (args: any) => {
      markActive("user_action");
      const result = await method(manager, "broadcastToAgents")(
        args.targets,
        args.message
      );
      method(telemetry.analytics, "trackEvent")("sand.broadcast.sent", {
        total: result.total,
        scheduled: result.scheduled,
        targets: args.targets === "all" ? "all" : "subset"
      });
      return result;
    },

    getAgentWorkflows: (args: any) =>
      method(manager, "getAgentWorkflows")(args.id),
    createAgentWorkflow: async (args: any) => {
      const isAutomation = args.spec.trigger != null;
      if (isAutomation) markActive("user_action");
      const countBefore = isAutomation
        ? (await method(manager, "getAgentAutomations")(args.id)).length
        : 0;
      const workflows = await method(manager, "createAgentWorkflow")(
        args.id,
        args.spec
      );
      if (isAutomation) {
        const countAfter = (await method(manager, "getAgentAutomations")(
          args.id
        )).length;
        if (countAfter > countBefore) {
          method(telemetry.analytics, "trackEvent")(
            "sand.automation.created",
            {
              agent_id: args.id,
              trigger_type: "cron",
              source: "workflow_ui"
            }
          );
        }
      }
      return workflows;
    },
    updateAgentWorkflow: (args: any) =>
      method(manager, "updateAgentWorkflow")(
        args.id,
        args.workflowId,
        args.spec
      ),
    setAgentWorkflowEnabled: (args: any) =>
      method(manager, "setAgentWorkflowEnabled")(
        args.id,
        args.workflowId,
        args.isEnabled
      ),
    deleteAgentWorkflow: (args: any) =>
      method(manager, "deleteAgentWorkflow")(args.id, args.workflowId),
    runAgentWorkflowNow: (args: any) =>
      method(manager, "runAgentWorkflowNow")(args.id, args.workflowId),
    importAgentWorkflowText: (args: any) =>
      method(manager, "importAgentWorkflowMarkdown")(
        args.id,
        args.markdown,
        args.name
      ),
    importAgentWorkflowUrl: (args: any) =>
      method(manager, "importAgentWorkflowUrl")(args.id, args.url, args.name),
    portAgentLocalSkills: (args: any) =>
      method(manager, "portAgentLocalSkills")(args.id),
    getConversationOutline: (args: any) =>
      method(manager, "getConversationOutline")(args.id),

    skillsCatalog: () => method(managedSetup, "skillsCatalog")(),
    syncPluginSkills: () =>
      method(deps.extensions.api("mcp"), "syncPluginSkills")(),
    getPluginSyncStatus: () =>
      method(deps.extensions.api("mcp"), "pluginSyncStatus")(),
    getSkillPublishTargets: () =>
      method(deps.extensions.api("mcp").skillPublish, "listTargets")(),
    publishSkill: (args: any) =>
      method(deps.extensions.api("mcp").skillPublish, "publish")(args),
    resyncPublishedSkill: (args: any) =>
      method(deps.extensions.api("mcp").skillPublish, "resync")(args),
    unpublishSkill: (args: any) =>
      method(deps.extensions.api("mcp").skillPublish, "unpublish")(args),

    getAgentChannels: (args: any) =>
      method(automations, "getAgentChannels")(args.id),
    connectChannel: async (args: any) => {
      method(manager, "connectChannel")(args.id, args.platform, args.token);
      return method(automations, "getAgentChannels")(args.id);
    },
    disconnectChannel: async (args: any) => {
      method(manager, "disconnectChannel")(args.id, args.platform);
      return method(automations, "getAgentChannels")(args.id);
    },
    refreshChannel: async (value: unknown) => {
      const operation = "refreshChannel";
      const args = gatewayArgs(value, operation);
      const id = requiredStringArgument(args, ["id"], operation);
      const platform = requiredStringArgument(args, ["platform"], operation);
      assertValidSandAgentId(id);
      const current = await method(automations, "getAgentChannels")(id);
      if (isGatewayRecord(current) && Array.isArray(current.manifests)) {
        const supported = current.manifests.some(
          (manifest) => isGatewayRecord(manifest) && manifest.platform === platform
        );
        if (!supported) throw new Error(`Unsupported channel platform: ${platform}`);
      }
      await method(automations, "reconcileNow")();
      return method(automations, "getAgentChannels")(id);
    },
    getListenerIntegrations: () =>
      method(automations, "getListenerIntegrations")(),
    getListenerConnectUrl: async (args: any) => ({
      url: await method(automations, "getListenerConnectUrl")(args.platform)
    }),
    getSubagents: (args: any) => method(manager, "getSubagents")(args.id),
    getAsyncTasks: (args: any) => method(manager, "getAsyncTasks")(args.id),
    setAgentAvatarBytes: (value: unknown) => {
      const operation = "setAgentAvatarBytes";
      const args = gatewayArgs(value, operation);
      const agentId = requiredStringArgument(args, ["id"], operation);
      if (!Object.hasOwn(args, "pngBase64")) {
        throw new Error(`Malformed ${operation} request: 'pngBase64' is required`);
      }
      const encoded = args.pngBase64;
      return method(manager, "setAgentAvatarBytes")(
        agentId,
        encoded === null ? null : decodeGatewayAvatarPng(encoded, operation)
      );
    },
    getAgentAvatar: (args: any) => method(manager, "getAgentAvatar")(args.id),
    getAgentNotificationAvatar: (args: any) => {
      assertValidSandAgentId(args.id);
      return method(manager, "getAgentNotificationAvatar")(args.id);
    },
    transcribeAudio: async (value: unknown) => {
      const operation = "transcribeAudio";
      const args = gatewayArgs(value, operation);
      const audio = decodeGatewayTranscriptionAudio(
        firstArgument(args, ["audioBase64"]),
        operation
      );
      const mimeType = requiredStringArgument(
        args,
        ["mimeType"],
        operation,
        { allowEmpty: true, trim: false }
      );
      const language = optionalStringArgument(args, ["language"], operation);
      if (mimeType.length > GATEWAY_TRANSCRIBE_MIME_TYPE_MAX_LENGTH) {
        throw new Error(
          `Malformed ${operation} request: 'mimeType' exceeds ${GATEWAY_TRANSCRIBE_MIME_TYPE_MAX_LENGTH} characters`
        );
      }
      if (
        language !== undefined &&
        language.length > GATEWAY_TRANSCRIBE_LANGUAGE_MAX_LENGTH
      ) {
        throw new Error(
          `Malformed ${operation} request: 'language' exceeds ${GATEWAY_TRANSCRIBE_LANGUAGE_MAX_LENGTH} characters`
        );
      }
      const result = await method(inference.port, "transcribeAudio")({
        audio,
        mimeType: mimeType.trim().length === 0 ? "audio/webm" : mimeType,
        ...(language === undefined ? {} : { language })
      });
      if (
        !isGatewayRecord(result) ||
        typeof result.text !== "string" ||
        typeof result.transcriptionTimeMs !== "number" ||
        !Number.isFinite(result.transcriptionTimeMs) ||
        result.transcriptionTimeMs < 0
      ) {
        throw new Error("Malformed transcribeAudio response from inference service");
      }
      return {
        text: result.text,
        transcriptionTimeMs: result.transcriptionTimeMs
      };
    },

    getForeverBoxStatus: async (args: any) =>
      deps.decorateForeverBoxStatus(
        await method(deps.extensions.api("forever-box"), "getStatus")(args)
      ),
    getCloudAgentInfo: async (value: unknown) => {
      const operation = "getCloudAgentInfo";
      const args = gatewayArgs(value, operation);
      const includeFiles = optionalBooleanArgument(
        args,
        ["includeFiles", "include_files"],
        operation
      );
      return sanitizeGatewayServiceResult(await method(cloudAgents(), "getInfo")(
        cloudAgentId(args, operation),
        includeFiles
      ));
    },
    ensureForeverBox: async (args: any) =>
      deps.decorateForeverBoxStatus(
        await method(deps.extensions.api("forever-box"), "ensure")(args)
      ),
    resetForeverBox: async (args: any) =>
      deps.decorateForeverBoxStatus(
        await method(deps.extensions.api("forever-box"), "reset")(args)
      ),
    updateForeverBox: async (args: any) =>
      deps.decorateForeverBoxStatus(
        await method(deps.extensions.api("forever-box"), "update")(args)
      ),
    autoUpdateBoxNow: () =>
      method(deps.extensions.api("forever-box"), "autoUpdateNow")(),
    snapshotBoxStoreNow: (args: any) =>
      method(deps.extensions.api("box-store-sync"), "snapshotBoxStoreNow")(
        args
      ),
    getBoxStoreStatus: () =>
      method(deps.extensions.api("box-store-sync"), "getBoxStoreStatus")(),
    clearBoxStoreNow: () =>
      method(deps.extensions.api("box-store-sync"), "clearBoxStoreNow")(),
    updateHostNow: (args: any) =>
      method(deps.extensions.api("host-upgrade"), "updateHostNow")(args),
    getHostStatus: async () => ({
      ...method(deps.extensions.api("host-upgrade"), "getVersionState")(),
      isBusy: deps.getHealth().isBusy,
      capabilities: HOST_CAPABILITIES
    }),
    setBoxMigrating: async (args: any) => {
      method(deps.extensions.api("forever-box"), "setMigrating")({
        migrating: args.migrating === true
      });
      return { ok: true };
    },
    prepareBoxForRecreate: async () => {
      await method(automations, "suspendWakes")();
      return await method(manager, "quiesceForRecreate")();
    },
    resumeBoxAfterRecreate: async (args: any) => {
      method(automations, "resumeWakes")();
      await method(sharing, "resumeAfterRecreate")();
      return await method(manager, "resumeAfterRecreate")(
        args.agentIds ?? [],
        args.pendingWakes
      );
    },
    handBackForeverBox: (args: any) =>
      method(deps.extensions.api("session"), "endHandoff")(
        args.id,
        args.trigger ?? "button"
      ),

    startTeachRecording: (args: any) =>
      method(deps.extensions.api("teach-recording"), "start")(args),
    stopTeachRecording: (args: any) =>
      method(deps.extensions.api("teach-recording"), "stop")(args),
    getTeachRecordingStatus: () =>
      method(deps.extensions.api("teach-recording"), "getStatus")(),
    getTrays: () => method(deps.extensions.api("trays"), "list")(),
    dismissTray: (args: any) =>
      method(deps.extensions.api("trays"), "dismiss")(args),
    clearTrays: () => method(deps.extensions.api("trays"), "clearAll")(),

    // Internal-only hook for gateway-server's authenticated raw upload route.
    // It is deliberately absent from the JSON command table/catalog.
    uploadAttachmentStream: (args: unknown) =>
      method(attachments, "uploadStream")(args),
    uploadAttachment: (value: unknown) => {
      const operation = "uploadAttachment";
      const args = gatewayArgs(value, operation);
      const filename = requiredStringArgument(args, ["filename"], operation);
      if (filename.length > 4_096 || /[\u0000-\u001f\u007f]/.test(filename)) {
        throw new Error(`Malformed ${operation} request: 'filename' is invalid`);
      }
      if (!Object.hasOwn(args, "bytesBase64")) {
        throw new Error(`Malformed ${operation} request: 'bytesBase64' is required`);
      }
      const bytesBase64 = args.bytesBase64;
      if (typeof bytesBase64 !== "string" || bytesBase64.length === 0) {
        throw new Error(`Malformed ${operation} request: 'bytesBase64' must be a non-empty base64 string`);
      }
      let agentId: string | undefined;
      if (Object.hasOwn(args, "agentId")) {
        if (typeof args.agentId !== "string" || args.agentId.trim().length === 0 || args.agentId.length > 512) {
          throw new Error(`Malformed ${operation} request: 'agentId' must be a non-empty string`);
        }
        agentId = args.agentId.trim();
        try {
          assertValidSandAgentId(agentId);
        } catch {
          throw new Error(`Malformed ${operation} request: 'agentId' is invalid`);
        }
      }
      return method(attachments, "upload")({
        filename,
        bytesBase64,
        ...(agentId === undefined ? {} : { agentId })
      });
    },
    readAttachmentImage: (args: any) => method(attachments, "readImage")(args),
    readAttachmentText: (args: any) => method(attachments, "readText")(args),
    readAttachmentChunk: (args: any) => method(attachments, "readChunk")(args),
    getHostSettings: () => method(settings, "getHostSettings")(),
    setHostSettings: (args: any) => {
      const result = method(settings, "setHostSettings")(args);
      if (args.localToolPermission !== undefined) {
        method(localToolPermission, "notePermissionChanged")();
      }
      if (args.webauthnProxyEnabled !== undefined) {
        method(deps.extensions.api("webauthn-proxy"), "applyEnablement")(
          args.webauthnProxyEnabled
        );
      }
      return result;
    },

    refreshMcp: async ({ completion, routedAction, routedArgs }: any) => {
      if (routedAction === "list-tools") return await listRoutedMcpTools();
      if (routedAction === "execute-tool") return await executeRoutedMcpTool(routedArgs);
      if (completion != null) {
        await deps.handleDesktopMcpAuthCompletion(completion);
        return;
      }
      await method(deps.extensions.api("mcp").management, "restart")();
    },
    getMcpState: async () =>
      sanitizeGatewayServiceResult(
        await method(mcpManagement(), "getState")()
      ),
    getMcpCatalog: async () =>
      sanitizeGatewayServiceResult(
        await method(mcpManagement(), "getCatalog")()
      ),
    getEffectiveMcpPlugins: async () =>
      sanitizeGatewayServiceResult(
        await method(mcpManagement(), "listEffectivePlugins")()
      ),
    getMcpPluginLogo: async (value: unknown) => {
      const operation = "getMcpPluginLogo";
      const args = gatewayArgs(value, operation);
      const url = requiredStringArgument(
        args,
        ["url", "logoUrl", "logo_url"],
        operation
      );
      return sanitizeMcpPluginLogoResult(
        await method(mcpManagement(), "getPluginLogo")(url)
      );
    },
    installMcpEntry: async (value: unknown) => {
      const operation = "installMcpEntry";
      const args = gatewayArgs(value, operation);
      const entryId = requiredStringArgument(
        args,
        ["entryId", "entry_id", "pluginId", "plugin_id", "id"],
        operation
      );
      const values = optionalStringMapArgument(
        args,
        ["values", "variables"],
        operation
      );
      const hasTeamConfiguredVariables = optionalBooleanArgument(
        args,
        ["hasTeamConfiguredVariables", "has_team_configured_variables"],
        operation
      );
      return sanitizeGatewayServiceResult(
        await method(mcpManagement(), "installEntry")({
          entryId,
          ...(values === undefined ? {} : { values }),
          ...(hasTeamConfiguredVariables === undefined
            ? {}
            : { hasTeamConfiguredVariables })
        })
      );
    },
    updateMcpPluginInstall: async (value: unknown) => {
      const operation = "updateMcpPluginInstall";
      const args = gatewayArgs(value, operation);
      const pluginId = requiredStringArgument(
        args,
        ["pluginId", "plugin_id", "entryId", "entry_id", "id"],
        operation
      );
      const values = requiredStringMapArgument(
        args,
        ["values", "variables"],
        operation
      );
      return sanitizeGatewayServiceResult(
        await method(mcpManagement(), "updatePluginInstall")({ pluginId, values })
      );
    },
    setMcpCustomInstructions: async (value: unknown) => {
      const operation = "setMcpCustomInstructions";
      const args = gatewayArgs(value, operation);
      const serverId = requiredStringArgument(
        args,
        ["serverId", "server_id", "id"],
        operation
      );
      const instructions = requiredStringArgument(
        args,
        ["instructions", "customInstructions", "custom_instructions"],
        operation,
        { allowEmpty: true, trim: false }
      );
      return sanitizeGatewayServiceResult(
        await method(mcpManagement(), "setCustomInstructions")({
          serverId,
          instructions
        })
      );
    },
    listMcpServerTools: async (value: unknown) => {
      const operation = "listMcpServerTools";
      const args = gatewayArgs(value, operation);
      const serverId = requiredStringArgument(
        args,
        ["serverId", "server_id", "id"],
        operation
      );
      return sanitizeGatewayServiceResult(
        await method(mcpManagement(), "listServerTools")(serverId)
      );
    },
    toggleMcpToolDisabled: async (value: unknown) => {
      const operation = "toggleMcpToolDisabled";
      const args = gatewayArgs(value, operation);
      const serverId = requiredStringArgument(
        args,
        ["serverId", "server_id", "id"],
        operation
      );
      const toolName = requiredStringArgument(
        args,
        ["toolName", "tool_name", "name"],
        operation
      );
      return sanitizeGatewayServiceResult(
        await method(mcpManagement(), "toggleMcpToolDisabled")({
          serverId,
          toolName
        })
      );
    },
    listMcpServers: async () =>
      sanitizeGatewayServiceResult(
        await method(mcpManagement(), "listInstalled")()
      ),
    listMcpPlugins: async () =>
      sanitizeGatewayServiceResult(
        await method(mcpManagement(), "listPlugins")()
      ),
    getMcpPlugin: async (value: unknown) => {
      const operation = "getMcpPlugin";
      const args = gatewayArgs(value, operation);
      const pluginId = requiredStringArgument(
        args,
        ["pluginId", "plugin_id", "id"],
        operation
      );
      return sanitizeGatewayServiceResult(
        await method(mcpManagement(), "getPlugin")(pluginId)
      );
    },
    installMcpPlugin: async (value: unknown) => {
      const operation = "installMcpPlugin";
      const args = gatewayArgs(value, operation);
      const id = requiredStringArgument(
        args,
        ["pluginId", "plugin_id", "entryId", "entry_id", "id"],
        operation
      );
      const values = optionalStringMapArgument(args, ["values"], operation);
      return sanitizeGatewayServiceResult(
        await method(mcpManagement(), "install")({
          id,
          ...(values === undefined ? {} : { values })
        })
      );
    },
    uninstallMcpPlugin: async (value: unknown) => {
      const operation = "uninstallMcpPlugin";
      const args = gatewayArgs(value, operation);
      const pluginId = requiredStringArgument(
        args,
        ["pluginId", "plugin_id", "id"],
        operation
      );
      return sanitizeGatewayServiceResult(
        await method(mcpManagement(), "uninstallPlugin")(pluginId)
      );
    },
    addMcpServer: async (value: unknown) => {
      const operation = "addMcpServer";
      const args = gatewayArgs(value, operation);
      const name = requiredStringArgument(args, ["name"], operation);
      const rawConfig = firstArgument(args, ["configJson", "config_json", "config"]);
      let configJson: string;
      if (typeof rawConfig === "string") {
        configJson = rawConfig;
      } else if (isGatewayRecord(rawConfig)) {
        configJson = JSON.stringify(rawConfig);
      } else {
        throw new Error(
          `Malformed ${operation} request: 'configJson' must be a JSON string or object`
        );
      }
      return sanitizeGatewayServiceResult(
        await method(mcpManagement(), "add")({ name, configJson })
      );
    },
    removeMcpServer: async (value: unknown) => {
      const operation = "removeMcpServer";
      const args = gatewayArgs(value, operation);
      const serverId = requiredStringArgument(
        args,
        ["serverId", "server_id", "id"],
        operation
      );
      return sanitizeGatewayServiceResult(
        await method(mcpManagement(), "removeServer")(serverId)
      );
    },
    setMcpInstructions: async (value: unknown) => {
      const operation = "setMcpInstructions";
      const args = gatewayArgs(value, operation);
      const serverId = requiredStringArgument(
        args,
        ["serverId", "server_id", "id"],
        operation
      );
      const instructions = requiredStringArgument(
        args,
        ["instructions"],
        operation,
        { allowEmpty: true, trim: false }
      );
      return sanitizeGatewayServiceResult(
        await method(mcpManagement(), "setInstructions")({
          serverId,
          instructions
        })
      );
    },
    restartMcpServers: async () =>
      sanitizeGatewayServiceResult(
        await method(mcpManagement(), "restart")()
      ),
    authenticateMcpServer: async (value: unknown) => {
      const operation = "authenticateMcpServer";
      const args = gatewayArgs(value, operation);
      const serverId = requiredStringArgument(
        args,
        ["serverId", "server_id", "id"],
        operation
      );
      const accountKey = optionalStringArgument(
        args,
        ["accountKey", "account_key"],
        operation
      );
      const requestingAgentId = optionalStringArgument(
        args,
        ["requestingAgentId", "requesting_agent_id", "agentId", "agent_id"],
        operation
      );
      const forceReauth = optionalBooleanArgument(
        args,
        ["forceReauth", "force_reauth"],
        operation
      );
      const trigger = optionalStringArgument(args, ["trigger"], operation);
      if (trigger !== undefined && trigger !== "connector_card") {
        throw new Error(
          `Malformed ${operation} request: 'trigger' must be 'connector_card'`
        );
      }
      const authenticate = method(mcpManagement(), "authenticate");
      const authenticateArgs: unknown[] = [
        serverId,
        accountKey,
        requestingAgentId,
        forceReauth
      ];
      if (trigger !== undefined) authenticateArgs.push(trigger);
      const sanitized = sanitizeGatewayServiceResult(
        await authenticate(...authenticateArgs)
      );
      if (isGatewayRecord(sanitized) && typeof sanitized.kind === "string") {
        const { kind, status: _legacyStatus, ...rest } = sanitized;
        return { ...rest, status: kind };
      }
      return sanitized;
    },
    logoutMcpAccount: async (value: unknown) => {
      const operation = "logoutMcpAccount";
      const args = gatewayArgs(value, operation);
      const serverId = requiredStringArgument(
        args,
        ["serverId", "server_id", "id"],
        operation
      );
      const accountKey = requiredStringArgument(
        args,
        ["accountKey", "account_key"],
        operation
      );
      return sanitizeGatewayServiceResult(
        await method(mcpManagement(), "logoutAccount")({ serverId, accountKey })
      );
    },
    renameMcpAccount: async (value: unknown) => {
      const operation = "renameMcpAccount";
      const args = gatewayArgs(value, operation);
      const serverId = requiredStringArgument(
        args,
        ["serverId", "server_id", "id"],
        operation
      );
      const accountKey = requiredStringArgument(
        args,
        ["accountKey", "account_key"],
        operation
      );
      const newAccountKey = requiredStringArgument(
        args,
        ["newAccountKey", "new_account_key"],
        operation
      );
      return sanitizeGatewayServiceResult(
        await method(mcpManagement(), "renameAccount")({
          serverId,
          accountKey,
          newAccountKey
        })
      );
    },
    removeMcpAccount: async (value: unknown) => {
      const operation = "removeMcpAccount";
      const args = gatewayArgs(value, operation);
      const serverId = requiredStringArgument(
        args,
        ["serverId", "server_id", "id"],
        operation
      );
      const accountKey = requiredStringArgument(
        args,
        ["accountKey", "account_key"],
        operation
      );
      return sanitizeGatewayServiceResult(
        await method(mcpManagement(), "removeAccount")({ serverId, accountKey })
      );
    },
    listRoutedMcpTools,
    executeRoutedMcpTool,
    listBoxMcpServers: async ({ serverIdentifiers }: any) => {
      const servers = await method(
        deps.extensions.api("mcp"),
        "listBoxServers"
      )(serverIdentifiers);
      return {
        servers: servers.map((server: any) => ({
          serverIdentifier: server.serverIdentifier,
          status: server.status,
          ...(server.statusDetail == null
            ? {}
            : { statusDetail: server.statusDetail }),
          toolCount: server.toolCount
        }))
      };
    },
    listCloudAgents: async (value: unknown) => {
      const operation = "listCloudAgents";
      const args = gatewayArgs(value, operation);
      const limit = optionalPositiveIntegerArgument(
        args,
        ["limit"],
        operation,
        500
      );
      const includeArchived = optionalBooleanArgument(
        args,
        ["includeArchived", "include_archived"],
        operation
      );
      return sanitizeGatewayServiceResult(
        await method(cloudAgents(), "list")({
          ...(limit === undefined ? {} : { limit }),
          ...(includeArchived === undefined ? {} : { includeArchived })
        })
      );
    },
    listCloudAgentModels: async () =>
      sanitizeGatewayServiceResult(
        await method(cloudAgents(), "listModels")()
      ),
    getCloudAgent: async (value: unknown) => {
      const operation = "getCloudAgent";
      const args = gatewayArgs(value, operation);
      return sanitizeGatewayServiceResult(
        await method(cloudAgents(), "get")(cloudAgentId(args, operation))
      );
    },
    launchCloudAgent: async (value: unknown) => {
      const extension = cloudAgents();
      let args: Record<string, unknown>;
      try {
        args = normalizeCloudLaunchArgs(value);
      } catch (error) {
        if (error instanceof SandCloudAgentLaunchError) throw error;
        throw new SandCloudAgentLaunchError(
          error instanceof Error ? error.message : "Malformed launchCloudAgent request"
        );
      }
      await assertCloudAgentWritesEnabled(extension, "launchCloudAgent");
      const result = await method(extension, "launch")(
        args
      );
      if (typeof result?.bcId === "string" && extension.launchedIds instanceof Set) {
        extension.launchedIds.add(result.bcId);
      }
      return sanitizeGatewayServiceResult(result);
    },
    watchCloudAgent: async (value: unknown) => {
      const operation = "watchCloudAgent";
      const args = gatewayArgs(value, operation);
      const id = cloudAgentId(args, operation);
      const waitForRestart = optionalBooleanArgument(
        args,
        ["waitForRestart", "wait_for_restart"],
        operation
      );
      const extension = cloudAgents();
      const status = await method(extension, "getWatchStatus")(
        id,
        waitForRestart === undefined ? undefined : { waitForRestart }
      );
      if (status != null && extension.launchedIds instanceof Set) {
        extension.launchedIds.add(id);
      }
      return sanitizeGatewayServiceResult(status);
    },
    replyToCloudAgent: async (value: unknown) => {
      const extension = cloudAgents();
      let args: Record<string, unknown>;
      try {
        args = normalizeCloudReplyArgs(value);
      } catch (error) {
        if (error instanceof SandCloudAgentLaunchError) throw error;
        throw new SandCloudAgentLaunchError(
          error instanceof Error ? error.message : "Malformed replyToCloudAgent request"
        );
      }
      await assertCloudAgentWritesEnabled(extension, "replyToCloudAgent");
      const result = await method(extension, "reply")(args);
      if (extension.launchedIds instanceof Set) extension.launchedIds.add(args.bcId);
      return sanitizeGatewayServiceResult(result);
    },
    cancelCloudAgent: async (value: unknown) => {
      const operation = "cancelCloudAgent";
      const args = gatewayArgs(value, operation);
      return sanitizeGatewayServiceResult(
        await method(cloudAgents(), "cancel")(cloudAgentId(args, operation))
      );
    },
    renameCloudAgent: async (value: unknown) => {
      const operation = "renameCloudAgent";
      const args = gatewayArgs(value, operation);
      const title = requiredStringArgument(
        args,
        ["title", "newName", "new_name", "name"],
        operation
      );
      return sanitizeGatewayServiceResult(
        await method(cloudAgents(), "rename")(
          cloudAgentId(args, operation),
          title
        )
      );
    },
    archiveCloudAgent: async (value: unknown) => {
      const operation = "archiveCloudAgent";
      const args = gatewayArgs(value, operation);
      return sanitizeGatewayServiceResult(
        await method(cloudAgents(), "setArchived")(
          cloudAgentId(args, operation),
          true
        )
      );
    },
    unarchiveCloudAgent: async (value: unknown) => {
      const operation = "unarchiveCloudAgent";
      const args = gatewayArgs(value, operation);
      return sanitizeGatewayServiceResult(
        await method(cloudAgents(), "setArchived")(
          cloudAgentId(args, operation),
          false
        )
      );
    },
    deleteCloudAgent: async (value: unknown) => {
      const operation = "deleteCloudAgent";
      const args = gatewayArgs(value, operation);
      const id = cloudAgentId(args, operation);
      const extension = cloudAgents();
      const result = await method(extension, "delete")(id);
      if (extension.launchedIds instanceof Set) extension.launchedIds.delete(id);
      return sanitizeGatewayServiceResult(result);
    },
    listCloudAgentArtifacts: async (value: unknown) => {
      const operation = "listCloudAgentArtifacts";
      const args = gatewayArgs(value, operation);
      return sanitizeGatewayServiceResult(
        await method(cloudAgents(), "listArtifacts")(
          cloudAgentId(args, operation)
        )
      );
    },
    getCloudAgentTranscript: async (value: unknown) => {
      const operation = "getCloudAgentTranscript";
      const args = gatewayArgs(value, operation);
      return sanitizeGatewayTranscript(
        await method(cloudAgents(), "getTranscriptDump")({
          bcId: cloudAgentId(args, operation)
        })
      );
    },
    completeMcpOAuth: async (value: unknown) => {
      const operation = "completeMcpOAuth";
      const args = gatewayArgs(value, operation);
      const code = requiredStringArgument(
        args,
        ["code", "authorizationCode", "authorization_code"],
        operation
      );
      const stateId = requiredStringArgument(
        args,
        ["state", "stateId", "state_id"],
        operation
      );
      await method(mcpManagement(), "completeOAuth")({ stateId, code });
    },
    requestWebAuthnCeremony: (args: any) =>
      method(deps.extensions.api("webauthn-proxy"), "requestCeremony")(args),
    setBoxSecrets: ({ secrets }: any) =>
      method(deps.extensions.api("secrets"), "set")({ secrets }),
    getBoxSecretsStatus: () =>
      method(deps.extensions.api("secrets"), "getStatus")()
  };
}
