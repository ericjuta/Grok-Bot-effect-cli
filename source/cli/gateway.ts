import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { Context, Effect, Layer, Schedule, Stream } from "effect";

import {
  CLI_GATEWAY_EVENT_CHANNEL,
  GATEWAY_METHOD_PATTERN,
  GROK_BOT_030_GATEWAY_METHODS,
  isKnownService,
} from "./catalog.js";
import {
  CliConfigError,
  CliInputError,
  GatewayResponseError,
  GatewayTransportError,
  type CliFailure,
  type CliRuntimeConfig,
  type GatewayConnection,
} from "./model.js";
import { isGatewayDiscoveryInfo, type GatewayDiscoveryInfo } from "../host/host-discovery.js";
import { getGatewayDiscoveryPath } from "../host/host-paths.js";
import {
  GATEWAY_API_PREFIX,
  GATEWAY_ATTACHMENT_AGENT_ID_HEADER,
  GATEWAY_ATTACHMENT_AGENT_ID_MAX_BYTES,
  GATEWAY_ATTACHMENT_FILENAME_HEADER,
  GATEWAY_ATTACHMENT_FILENAME_MAX_BYTES,
  GATEWAY_ATTACHMENT_UPLOAD_STREAM_CAPABILITY,
  GATEWAY_ATTACHMENT_UPLOAD_STREAM_PATH,
  GATEWAY_AUTH_SCHEME,
  GATEWAY_AVATARS_PATH,
  GATEWAY_EVENTS_PATH,
  GATEWAY_HEALTH_PATH,
  GATEWAY_SLIM_AVATARS_HEADER,
  GATEWAY_TRACEPARENT_HEADER,
} from "../shared/gateway-wire.js";
import { GATEWAY_PREPARE_UPGRADE_PATH } from "../host/gateway-protocol.js";
import { attachmentByteLimitForName } from "../shared/media/attachment-limits.js";

const DEFAULT_TIMEOUT_MS = 90_000;
export const MAX_GATEWAY_JSON_RESPONSE_BYTES = 64 * 1024 * 1024;
export const MAX_GATEWAY_SERVICE_MANIFEST_BYTES = 256 * 1024;
export const MAX_GATEWAY_SERVICE_METHODS = 1_024;
export const MAX_GATEWAY_SERVICE_CAPABILITIES = 256;
export const MAX_GATEWAY_SERVICE_CAPABILITY_BYTES = 128;
export const MAX_GATEWAY_SERVICE_REFRESH_TIMEOUT_MS = 10_000;
const MAX_AVATAR_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_GATEWAY_ERROR_RESPONSE_BYTES = 64 * 1024;
export const MAX_SSE_EVENT_BYTES = 16 * 1024 * 1024;
export const MAX_ACTIVE_SSE_BUFFER_BYTES = 64 * 1024 * 1024;
export const INITIAL_SSE_BUFFER_BYTES = 64 * 1024;
let activeSseBufferBytes = 0;
export function getActiveSseBufferBytes(): number { return activeSseBufferBytes; }
const MAX_DISCOVERY_FILE_BYTES = 64 * 1024;
const MAX_DISCOVERY_HEALTH_BYTES = 64 * 1024;
export const ATTACHMENT_UPLOAD_READ_CHUNK_BYTES = 64 * 1024;
const PRODUCTION_DISCOVERY = join(homedir(), ".grokbot", "gateway.json");
const DEV_DISCOVERY = join(homedir(), ".cursor", "sand-dev", "gateway.json");
const LAB_DISCOVERY = join(homedir(), ".cursor", "sand-lab", "gateway.json");

export interface GatewayEvent {
  readonly channel: string;
  readonly payload: unknown;
}

export interface AvatarResponse {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly etag?: string;
}

export interface GatewayServices {
  readonly protocolVersion: number;
  readonly capabilities: readonly string[];
  readonly methods: readonly string[];
  readonly live: boolean;
}

export interface GatewayInvokeOptions {
  /** Bypass both the compiled and live service allowlists. */
  readonly allowUnknown?: boolean;
}

export interface UploadAttachmentFileOptions {
  readonly filePath: string;
  readonly filename: string;
  readonly agentId?: string;
}

export interface GatewayService {
  readonly connection: Effect.Effect<GatewayConnection, CliConfigError>;
  readonly health: Effect.Effect<unknown, CliFailure>;
  /** Return the cached manifest, discovering it once when absent. */
  readonly services: Effect.Effect<GatewayServices, CliFailure>;
  /** Re-negotiate the live manifest, coalescing overlapping refreshes. */
  readonly refreshServices: Effect.Effect<GatewayServices, CliFailure>;
  readonly prepareUpgrade: Effect.Effect<unknown, CliFailure>;
  readonly invoke: (method: string, args?: unknown, options?: GatewayInvokeOptions) => Effect.Effect<unknown, CliFailure>;
  readonly uploadAttachmentFile: (options: UploadAttachmentFileOptions) => Effect.Effect<unknown, CliFailure>;
  readonly events: (channels?: readonly string[]) => Stream.Stream<GatewayEvent, CliFailure>;
  readonly avatar: (agentId: string) => Effect.Effect<AvatarResponse, CliFailure>;
}

export const Gateway = Context.GenericTag<GatewayService>("@grok-effect-cli/Gateway");

function normalizedBaseUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username.length > 0 || url.password.length > 0) return null;
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function rejectInsecureRemote(baseUrl: string, config: CliRuntimeConfig): CliConfigError | null {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" || isLoopbackHostname(url.hostname) || config.allowInsecureRemote) return null;
  return new CliConfigError({
    code: "CLI_CONFIG",
    message: "Refusing a clear-text non-loopback gateway. Use HTTPS or pass --allow-insecure-remote explicitly.",
  });
}

function displayHost(host: string | undefined): string {
  const value = host?.trim() || "127.0.0.1";
  if (value === "0.0.0.0") return "127.0.0.1";
  if (value === "::" || value === "[::]") return "[::1]";
  if (value.includes(":") && !value.startsWith("[")) return `[${value}]`;
  return value;
}

function discoveryConnection(info: GatewayDiscoveryInfo, path: string, token?: string): GatewayConnection {
  const scheme = info.scheme ?? "http";
  return {
    baseUrl: `${scheme}://${displayHost(info.host)}:${info.port}`,
    source: "discovery",
    discoveryPath: path,
    pid: info.pid,
    startedAt: info.startedAt,
    ...((token ?? info.token) === undefined ? {} : { token: token ?? info.token }),
  };
}

function throwIfDiscoveryReadAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException("The gateway discovery read was aborted.", "AbortError");
}

function invalidDiscoveryFile(message: string): Error {
  return new Error(`gateway discovery ${message}`);
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function readBoundedFileText(path: string, maximum: number, signal: AbortSignal): Promise<string> {
  const noFollowFlag = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  let fallbackEntry: Stats | undefined;
  let handle: FileHandle | undefined;
  try {
    throwIfDiscoveryReadAborted(signal);
    // O_NOFOLLOW is not exposed on every Node platform. On those platforms,
    // lstat both sides of open and compare the path entry with the opened
    // descriptor. O_NONBLOCK keeps a raced FIFO/device open from parking the
    // event loop before descriptor validation.
    if (noFollowFlag === 0) {
      fallbackEntry = await lstat(path);
      if (!fallbackEntry.isFile()) throw invalidDiscoveryFile("path must be a regular file");
    }
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | noFollowFlag);
    const descriptor = await handle.stat();
    throwIfDiscoveryReadAborted(signal);
    if (!descriptor.isFile()) throw invalidDiscoveryFile("path must be a regular file");
    if (!Number.isSafeInteger(descriptor.size) || descriptor.size < 0) {
      throw invalidDiscoveryFile("file has an invalid size");
    }
    if (descriptor.size > maximum) throw new Error(`discovery file exceeds ${maximum} bytes`);

    if (fallbackEntry !== undefined) {
      const currentEntry = await lstat(path);
      if (!currentEntry.isFile()
        || !sameFileIdentity(fallbackEntry, currentEntry)
        || !sameFileIdentity(currentEntry, descriptor)) {
        throw invalidDiscoveryFile("path changed while it was being opened");
      }
    }

    // The extra byte detects growth after fstat while retaining a strict cap.
    const storage = Buffer.allocUnsafe(maximum + 1);
    let size = 0;
    while (size <= maximum) {
      throwIfDiscoveryReadAborted(signal);
      const { bytesRead } = await handle.read(storage, size, maximum + 1 - size, size);
      throwIfDiscoveryReadAborted(signal);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > maximum) throw new Error(`discovery file exceeds ${maximum} bytes`);
    return storage.subarray(0, size).toString("utf8");
  } finally {
    if (handle !== undefined) {
      try { await handle.close(); } catch {}
    }
  }
}

function readDiscovery(path: string): Effect.Effect<{ readonly info: GatewayDiscoveryInfo; readonly path: string } | null, CliConfigError> {
  return Effect.tryPromise({
    try: (signal) => readBoundedFileText(path, MAX_DISCOVERY_FILE_BYTES, signal),
    catch: (error) => error,
  }).pipe(
    Effect.flatMap((text) =>
      Effect.try({
        try: () => JSON.parse(text) as unknown,
        catch: () => new CliConfigError({ code: "CLI_CONFIG", message: "Gateway discovery contains invalid JSON.", path }),
      }),
    ),
    Effect.flatMap((value) =>
      isGatewayDiscoveryInfo(value)
        ? Effect.succeed({ info: value, path })
        : Effect.fail(new CliConfigError({ code: "CLI_CONFIG", message: "Gateway discovery has an invalid shape.", path })),
    ),
    Effect.catchAll((error) => {
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
      if (code === "ENOENT" || code === "ENOTDIR") return Effect.succeed(null);
      if (error instanceof CliConfigError) return Effect.fail(error);
      return Effect.fail(new CliConfigError({ code: "CLI_CONFIG", message: `Unable to read gateway discovery: ${error instanceof Error ? error.message : String(error)}`, path }));
    }),
  );
}

export function resolveGatewayConnection(config: CliRuntimeConfig): Effect.Effect<GatewayConnection, CliConfigError> {
  const explicitUrl = config.url?.trim();
  const environmentUrl = process.env.GROK_BOT_GATEWAY_URL?.trim() || process.env.SAND_HOST_GATEWAY_URL?.trim();
  const rawUrl = explicitUrl || environmentUrl;
  const token = config.token
    ?? process.env.GROK_BOT_GATEWAY_TOKEN?.trim()
    ?? process.env.SAND_HOST_GATEWAY_TOKEN?.trim();

  if (rawUrl != null && rawUrl.length > 0) {
    const baseUrl = normalizedBaseUrl(rawUrl);
    if (baseUrl == null) {
      return Effect.fail(new CliConfigError({ code: "CLI_CONFIG", message: "Gateway URL must be an http(s) URL without embedded credentials." }));
    }
    const insecure = rejectInsecureRemote(baseUrl, config);
    if (insecure != null) return Effect.fail(insecure);
    return Effect.succeed({
      baseUrl,
      source: explicitUrl ? "explicit" : "environment",
      ...(token === undefined || token.length === 0 ? {} : { token }),
    });
  }

  const explicitDiscovery = config.discoveryPath?.trim()
    || process.env.GROK_BOT_GATEWAY_DISCOVERY?.trim();
  const candidates = explicitDiscovery
    ? [explicitDiscovery]
    : [...new Set([getGatewayDiscoveryPath(), PRODUCTION_DISCOVERY, DEV_DISCOVERY, LAB_DISCOVERY])];

  return Effect.forEach(candidates, (path) => readDiscovery(path).pipe(
    Effect.catchAll((error) => explicitDiscovery === undefined ? Effect.succeed(null) : Effect.fail(error)),
  ), { concurrency: "unbounded" }).pipe(
    Effect.flatMap((rows) => {
      const found = rows.filter((row): row is NonNullable<typeof row> => row != null)
        .sort((left, right) => right.info.startedAt - left.info.startedAt);
      if (found.length === 0) {
        return Effect.fail(new CliConfigError({
          code: "CLI_CONFIG",
          message: `No Grok Bot gateway was discovered. Start Grok Bot or pass --url. Checked: ${candidates.join(", ")}`,
          ...(explicitDiscovery === undefined ? {} : { path: explicitDiscovery }),
        }));
      }
      return Effect.forEach(found, (row) => {
        const discovered = discoveryConnection(row.info, row.path, token);
        const baseUrl = normalizedBaseUrl(discovered.baseUrl);
        if (baseUrl === null) return Effect.succeed(null);
        const candidate: GatewayConnection = { ...discovered, baseUrl };
        const insecure = rejectInsecureRemote(candidate.baseUrl, config);
        if (insecure != null) return Effect.succeed(null);
        const timeoutMs = Math.min(Math.max(config.timeoutMs, 250), 2_000);
        return makeHeaders(config, candidate, "application/json").pipe(
          Effect.flatMap((headers) => Effect.tryPromise({
            try: async (signal) => {
              const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
              const response = await fetch(`${candidate.baseUrl}${GATEWAY_HEALTH_PATH}`, {
                headers,
                signal: requestSignal,
              });
              if (!response.ok) {
                try {
                  await response.body?.cancel();
                } catch {}
                return null;
              }
              const text = new TextDecoder().decode(
                await readBoundedResponseBytes(response, MAX_DISCOVERY_HEALTH_BYTES, requestSignal),
              );
              const health = JSON.parse(text) as { readonly ok?: unknown; readonly pid?: unknown; readonly startedAt?: unknown };
              return health.ok === true && health.pid === candidate.pid && health.startedAt === candidate.startedAt
                ? candidate
                : null;
            },
            catch: (error) => error,
          }).pipe(Effect.catchAll(() => Effect.succeed(null)))),
        );
      }, { concurrency: "unbounded" }).pipe(
        Effect.flatMap((probed) => {
          const candidate = probed.find((item): item is GatewayConnection => item != null);
          return candidate == null
            ? Effect.fail(new CliConfigError({
              code: "CLI_CONFIG",
              message: `Grok Bot gateway discovery records were stale or unreachable. Start Grok Bot or pass --url. Checked: ${candidates.join(", ")}`,
              ...(explicitDiscovery === undefined ? {} : { path: explicitDiscovery }),
            }))
            : Effect.succeed(candidate);
        }),
      );
    }),
  );
}

function responseErrorMessage(body: string, fallback: string): string {
  try {
    const parsed = JSON.parse(body) as { readonly error?: unknown };
    if (typeof parsed.error === "string" && parsed.error.length > 0) return parsed.error;
  } catch {}
  const compact = body.trim().slice(0, 4_096);
  return compact.length > 0 ? compact : fallback;
}

function transportFailure(error: unknown, method: string | undefined, url: string): GatewayTransportError {
  const name = error instanceof Error ? error.name : "";
  const timeout = name === "TimeoutError" || name === "AbortError" && /timeout/i.test(error instanceof Error ? error.message : "");
  return new GatewayTransportError({
    code: timeout ? "GATEWAY_TIMEOUT" : "GATEWAY_UNREACHABLE",
    message: timeout
      ? `Grok Bot gateway timed out${method === undefined ? "" : ` during ${method}`}.`
      : `Grok Bot gateway is unreachable${method === undefined ? "" : ` during ${method}`}.`,
    ...(method === undefined ? {} : { method }),
    url,
  });
}

function makeHeaders(
  config: CliRuntimeConfig,
  connection: GatewayConnection,
  accept?: string,
): Effect.Effect<Headers, CliConfigError> {
  return Effect.try({
    try: () => {
      const headers = new Headers();
      if (accept != null) headers.set("accept", accept);
      if (!config.fullAvatars) headers.set(GATEWAY_SLIM_AVATARS_HEADER, "1");
      if (config.traceparent != null) headers.set(GATEWAY_TRACEPARENT_HEADER, config.traceparent);
      if (config.requestId != null) headers.set("x-sand-request-id", config.requestId);
      if (connection.token != null && connection.token.length > 0) {
        headers.set("authorization", `${GATEWAY_AUTH_SCHEME} ${connection.token}`);
      }
      return headers;
    },
    catch: () => new CliConfigError({
      code: "CLI_CONFIG",
      message: "A gateway request header is invalid. Check the token, request id, and trace context values.",
    }),
  });
}

function fetchGatewayStream(
  config: CliRuntimeConfig,
  connection: GatewayConnection,
  path: string,
  init: RequestInit,
  method: string,
): Effect.Effect<Response, GatewayTransportError> {
  const url = `${connection.baseUrl}${path}`;
  const timeoutMs = Number.isFinite(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_TIMEOUT_MS;
  return Effect.tryPromise({
    try: async (signal) => {
      const connectTimeout = new AbortController();
      const timer = setTimeout(() => {
        connectTimeout.abort(new DOMException("Gateway stream connection timed out.", "TimeoutError"));
      }, timeoutMs);
      try {
        return await fetch(url, {
          ...init,
          signal: AbortSignal.any([signal, connectTimeout.signal]),
        });
      } finally {
        clearTimeout(timer);
      }
    },
    catch: (error) => transportFailure(error, method, url),
  });
}

function fetchGateway(
  config: CliRuntimeConfig,
  connection: GatewayConnection,
  path: string,
  init: RequestInit,
  method?: string,
  maximumTimeoutMs?: number,
): Effect.Effect<Response, GatewayTransportError> {
  const url = `${connection.baseUrl}${path}`;
  const configuredTimeoutMs = Number.isFinite(config.timeoutMs) && config.timeoutMs > 0
    ? config.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const timeoutMs = maximumTimeoutMs === undefined
    ? configuredTimeoutMs
    : Math.min(configuredTimeoutMs, maximumTimeoutMs);
  return Effect.tryPromise({
    try: (signal) => fetch(url, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) }),
    catch: (error) => transportFailure(error, method, url),
  });
}

async function readBoundedResponseBytes(
  response: Response,
  maximum: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  let cancellation: Promise<void> | undefined;
  let completed = false;
  const cancel = (reason?: unknown): Promise<void> => {
    cancellation ??= reader.cancel(reason).catch(() => undefined);
    return cancellation;
  };
  const onAbort = () => {
    void cancel(signal.reason);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  const abortError = () => signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The gateway response read was aborted.", "AbortError");
  const declared = response.headers.get("content-length");
  let storage = Buffer.allocUnsafe(Math.min(maximum, 16 * 1024));
  let size = 0;
  try {
    if (signal.aborted) {
      await cancel(signal.reason);
      throw abortError();
    }
    if (declared !== null) {
      const length = Number(declared);
      if (Number.isFinite(length) && length > maximum) {
        await cancel();
        throw new Error(`response exceeds ${maximum} bytes`);
      }
    }
    while (true) {
      const result = await reader.read();
      if (signal.aborted) throw abortError();
      if (result.done) break;
      const chunk = result.value;
      const nextSize = size + chunk.byteLength;
      if (nextSize > maximum) {
        await cancel();
        throw new Error(`response exceeds ${maximum} bytes`);
      }
      if (nextSize > storage.byteLength) {
        const capacity = Math.min(maximum, Math.max(nextSize, Math.max(1, storage.byteLength * 2)));
        const grown = Buffer.allocUnsafe(capacity);
        storage.copy(grown, 0, 0, size);
        storage = grown;
      }
      Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).copy(storage, size);
      size = nextSize;
    }
    completed = true;
    return Buffer.from(storage.subarray(0, size));
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (!completed) await cancel();
    reader.releaseLock();
  }
}

function cancelResponseBody(response: Response): Effect.Effect<void> {
  return Effect.promise(async () => {
    try {
      await response.body?.cancel();
    } catch {}
  });
}

function decodeJsonResponse(
  response: Response,
  method?: string,
  maximumBytes = MAX_GATEWAY_JSON_RESPONSE_BYTES,
): Effect.Effect<unknown, GatewayResponseError | GatewayTransportError> {
  return Effect.tryPromise({
    try: async (signal) => new TextDecoder().decode(
      await readBoundedResponseBytes(response, maximumBytes, signal),
    ),
    catch: (error) => new GatewayTransportError({
      code: "GATEWAY_PROTOCOL",
      message: `Failed reading the Grok Bot gateway response: ${error instanceof Error ? error.message : String(error)}`,
      ...(method === undefined ? {} : { method }),
    }),
  }).pipe(
    Effect.flatMap((body): Effect.Effect<unknown, GatewayResponseError | GatewayTransportError> => {
      if (!response.ok) {
        return Effect.fail(new GatewayResponseError({
          code: "GATEWAY_RESPONSE",
          message: responseErrorMessage(body, response.statusText),
          ...(method === undefined ? {} : { method }),
          status: response.status,
          retryable: response.status >= 500 || response.status === 408 || response.status === 429,
        }));
      }
      if (body.length === 0) return Effect.succeed(null);
      return Effect.try({
        try: () => JSON.parse(body) as unknown,
        catch: () => new GatewayTransportError({
          code: "GATEWAY_PROTOCOL",
          message: "Grok Bot gateway returned non-JSON data.",
          ...(method === undefined ? {} : { method }),
        }),
      });
    }),
  );
}

interface PreparedAttachmentFile {
  readonly handle: FileHandle;
  readonly size: number;
  readonly byteLimit: number;
}

function invalidAttachmentInput(message: string): CliInputError {
  return new CliInputError({ code: "INVALID_INPUT", message });
}

function encodeAttachmentMetadata(value: string, maximumBytes: number, label: string): string {
  if (Buffer.byteLength(value, "utf8") > maximumBytes || /[\u0000-\u001f\u007f]/.test(value)) {
    throw invalidAttachmentInput(`${label} is invalid or exceeds its ${maximumBytes}-byte limit.`);
  }
  try { return encodeURIComponent(value); }
  catch { throw invalidAttachmentInput(`${label} contains invalid Unicode.`); }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The attachment upload was aborted.", "AbortError");
}

function validateAttachmentUploadOptions(options: UploadAttachmentFileOptions): Effect.Effect<UploadAttachmentFileOptions, CliInputError> {
  return Effect.try({
    try: () => {
      if (typeof options.filePath !== "string" || options.filePath.trim().length === 0) {
        throw invalidAttachmentInput("Attachment file path is required.");
      }
      if (typeof options.filename !== "string" || options.filename.trim().length === 0) {
        throw invalidAttachmentInput("Attachment filename is required.");
      }
      encodeAttachmentMetadata(options.filename, GATEWAY_ATTACHMENT_FILENAME_MAX_BYTES, "Attachment filename");
      if (options.agentId !== undefined && (typeof options.agentId !== "string" || options.agentId.trim().length === 0)) {
        throw invalidAttachmentInput("Agent id must be a non-empty string when provided.");
      }
      if (options.agentId !== undefined) {
        encodeAttachmentMetadata(options.agentId, GATEWAY_ATTACHMENT_AGENT_ID_MAX_BYTES, "Agent id");
      }
      return options;
    },
    catch: (error) => error instanceof CliInputError
      ? error
      : invalidAttachmentInput("Attachment upload options are invalid."),
  });
}

function prepareAttachmentFile(options: UploadAttachmentFileOptions): Effect.Effect<PreparedAttachmentFile, CliInputError> {
  return Effect.tryPromise({
    try: async (signal) => {
      let handle: FileHandle | undefined;
      try {
        if (signal.aborted) throw abortReason(signal);
        // O_NONBLOCK prevents an attacker-controlled FIFO from hanging the CLI
        // between path validation and descriptor validation. It is inert for a
        // regular file.
        handle = await open(options.filePath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
        const info = await handle.stat();
        if (signal.aborted) throw abortReason(signal);
        if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size <= 0) {
          throw invalidAttachmentInput("Attachment source must be a non-empty regular file.");
        }
        const byteLimit = attachmentByteLimitForName(options.filename);
        if (info.size > byteLimit) {
          throw invalidAttachmentInput(`Attachment file exceeds its ${byteLimit}-byte limit.`);
        }
        return { handle, size: info.size, byteLimit };
      } catch (error) {
        if (handle !== undefined) {
          try {
            await handle.close();
          } catch {}
        }
        throw error;
      }
    },
    catch: (error) => error instanceof CliInputError
      ? error
      : invalidAttachmentInput("Unable to open the attachment source as a regular file."),
  });
}

/**
 * Encode arbitrary binary chunk boundaries as one canonical base64 sequence.
 * Only the current input chunk, its encoded form, and a two-byte carry are held.
 */
export async function* encodeAttachmentBase64Chunks(
  chunks: AsyncIterable<Uint8Array>,
  expectedBytes: number,
  maximumBytes: number,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  let carry = Buffer.alloc(0);
  let total = 0;
  for await (const raw of chunks) {
    if (signal?.aborted === true) throw abortReason(signal);
    const chunk = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
    if (chunk.byteLength === 0) continue;
    const nextTotal = total + chunk.byteLength;
    if (!Number.isSafeInteger(nextTotal) || nextTotal > maximumBytes) {
      throw invalidAttachmentInput(`Attachment file exceeds its ${maximumBytes}-byte limit while streaming.`);
    }
    if (nextTotal > expectedBytes) {
      throw invalidAttachmentInput("Attachment file changed while it was being uploaded.");
    }
    total = nextTotal;

    const combined = carry.byteLength === 0
      ? chunk
      : Buffer.concat([carry, chunk], carry.byteLength + chunk.byteLength);
    const completeBytes = combined.byteLength - combined.byteLength % 3;
    if (completeBytes > 0) yield combined.subarray(0, completeBytes).toString("base64");
    carry = completeBytes === combined.byteLength
      ? Buffer.alloc(0)
      : Buffer.from(combined.subarray(completeBytes));
  }
  if (signal?.aborted === true) throw abortReason(signal);
  if (total !== expectedBytes) {
    throw invalidAttachmentInput("Attachment file changed while it was being uploaded.");
  }
  if (carry.byteLength > 0) yield carry.toString("base64");
}

function attachmentJsonPrefix(filename: string): string {
  return `{"filename":${JSON.stringify(filename)},"bytesBase64":"`;
}

function attachmentJsonSuffix(agentId: string | undefined): string {
  return agentId === undefined
    ? `"}`
    : `","agentId":${JSON.stringify(agentId)}}`;
}

async function* attachmentJsonBody(
  prepared: PreparedAttachmentFile,
  options: UploadAttachmentFileOptions,
  signal: AbortSignal,
): AsyncGenerator<string> {
  yield attachmentJsonPrefix(options.filename);
  const input = prepared.handle.createReadStream({
    autoClose: false,
    highWaterMark: ATTACHMENT_UPLOAD_READ_CHUNK_BYTES,
    start: 0,
    signal,
  });
  try {
    yield* encodeAttachmentBase64Chunks(input, prepared.size, prepared.byteLimit, signal);
    yield attachmentJsonSuffix(options.agentId);
  } finally {
    input.destroy();
  }
}

async function* attachmentRawBody(
  prepared: PreparedAttachmentFile,
  signal: AbortSignal,
): AsyncGenerator<Buffer> {
  const input = prepared.handle.createReadStream({
    autoClose: false,
    highWaterMark: ATTACHMENT_UPLOAD_READ_CHUNK_BYTES,
    start: 0,
    signal,
  });
  let total = 0;
  try {
    for await (const raw of input) {
      if (signal.aborted) throw abortReason(signal);
      const bytes = raw instanceof Buffer
        ? raw
        : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
      const nextTotal = total + bytes.byteLength;
      if (!Number.isSafeInteger(nextTotal) || nextTotal > prepared.byteLimit) {
        throw invalidAttachmentInput(`Attachment file exceeds its ${prepared.byteLimit}-byte limit while streaming.`);
      }
      if (nextTotal > prepared.size) {
        throw invalidAttachmentInput("Attachment file changed while it was being uploaded.");
      }
      total = nextTotal;
      if (bytes.byteLength > 0) yield bytes;
    }
    if (signal.aborted) throw abortReason(signal);
    if (total !== prepared.size) {
      throw invalidAttachmentInput("Attachment file changed while it was being uploaded.");
    }
  } finally {
    input.destroy();
  }
}

function attachmentJsonContentLength(prepared: PreparedAttachmentFile, options: UploadAttachmentFileOptions): number {
  const base64Bytes = Math.ceil(prepared.size / 3) * 4;
  return Buffer.byteLength(attachmentJsonPrefix(options.filename))
    + base64Bytes
    + Buffer.byteLength(attachmentJsonSuffix(options.agentId));
}

function uploadAttachmentResponse(
  config: CliRuntimeConfig,
  connection: GatewayConnection,
  headers: Headers,
  prepared: PreparedAttachmentFile,
  options: UploadAttachmentFileOptions,
  rawStream: boolean,
): Effect.Effect<unknown, CliFailure> {
  const method = "uploadAttachment";
  const url = `${connection.baseUrl}${rawStream ? GATEWAY_ATTACHMENT_UPLOAD_STREAM_PATH : `${GATEWAY_API_PREFIX}/${method}`}`;
  const timeoutMs = Number.isFinite(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_TIMEOUT_MS;
  return Effect.tryPromise({
    try: async (effectSignal) => {
      const timeout = new AbortController();
      const timer = setTimeout(() => {
        timeout.abort(new DOMException("Gateway attachment upload timed out.", "TimeoutError"));
      }, timeoutMs);
      const requestSignal = AbortSignal.any([effectSignal, timeout.signal]);
      let bodyFailure: unknown;
      const trackedBody = (async function* () {
        try {
          if (rawStream) yield* attachmentRawBody(prepared, requestSignal);
          else yield* attachmentJsonBody(prepared, options, requestSignal);
        } catch (error) {
          bodyFailure = error;
          throw error;
        }
      })();
      const body = Readable.from(trackedBody, { signal: requestSignal });
      body.once("error", (error) => {
        bodyFailure ??= error;
      });
      headers.set("content-type", rawStream ? "application/octet-stream" : "application/json");
      headers.set("content-length", String(rawStream ? prepared.size : attachmentJsonContentLength(prepared, options)));
      if (rawStream) {
        headers.set(
          GATEWAY_ATTACHMENT_FILENAME_HEADER,
          encodeAttachmentMetadata(options.filename, GATEWAY_ATTACHMENT_FILENAME_MAX_BYTES, "Attachment filename"),
        );
        if (options.agentId !== undefined) {
          headers.set(
            GATEWAY_ATTACHMENT_AGENT_ID_HEADER,
            encodeAttachmentMetadata(options.agentId, GATEWAY_ATTACHMENT_AGENT_ID_MAX_BYTES, "Agent id"),
          );
        }
      }
      try {
        const response = await fetch(url, {
          method: "POST",
          headers,
          body: body as unknown as BodyInit,
          // Node fetch requires this opt-in for a streaming request body.
          duplex: "half",
          signal: requestSignal,
        } as RequestInit & { duplex: "half" });
        let responseBytes: Uint8Array;
        try {
          responseBytes = await readBoundedResponseBytes(
            response,
            response.ok ? MAX_GATEWAY_JSON_RESPONSE_BYTES : MAX_GATEWAY_ERROR_RESPONSE_BYTES,
            requestSignal,
          );
        } catch (error) {
          if (timeout.signal.aborted) throw abortReason(timeout.signal);
          if (effectSignal.aborted) throw abortReason(effectSignal);
          throw new GatewayTransportError({
            code: "GATEWAY_PROTOCOL",
            message: "Failed reading the Grok Bot gateway attachment response within its byte limit.",
            method,
          });
        }
        const responseText = new TextDecoder().decode(responseBytes);
        if (!response.ok) {
          throw new GatewayResponseError({
            code: "GATEWAY_RESPONSE",
            message: responseErrorMessage(responseText, response.statusText),
            method,
            status: response.status,
            retryable: response.status >= 500 || response.status === 408 || response.status === 429,
          });
        }
        if (responseText.length === 0) return null;
        try {
          return JSON.parse(responseText) as unknown;
        } catch {
          throw new GatewayTransportError({
            code: "GATEWAY_PROTOCOL",
            message: "Grok Bot gateway returned non-JSON data.",
            method,
          });
        }
      } catch (error) {
        if (timeout.signal.aborted) throw abortReason(timeout.signal);
        if (effectSignal.aborted) throw abortReason(effectSignal);
        if (bodyFailure !== undefined) throw bodyFailure;
        throw error;
      } finally {
        clearTimeout(timer);
        body.destroy();
      }
    },
    catch: (error) => error instanceof CliConfigError
      || error instanceof CliInputError
      || error instanceof GatewayResponseError
      || error instanceof GatewayTransportError
      ? error
      : transportFailure(error, method, url),
  });
}

function parseEventBlock(block: string): GatewayEvent | null {
  const data = block.split(/\r\n|\r|\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n");
  if (data.length === 0) return null;
  try {
    const parsed = JSON.parse(data) as { readonly channel?: unknown; readonly payload?: unknown };
    return typeof parsed.channel === "string" && parsed.channel.length > 0
      ? { channel: parsed.channel, payload: parsed.payload }
      : null;
  } catch {
    return null;
  }
}

function eventBoundaryLength(storage: Uint8Array, size: number): number {
  if (size >= 4
    && storage[size - 4] === 13
    && storage[size - 3] === 10
    && storage[size - 2] === 13
    && storage[size - 1] === 10) return 4;
  if (size >= 2 && (
    storage[size - 2] === 10 && storage[size - 1] === 10
    || storage[size - 2] === 13 && storage[size - 1] === 13
  )) return 2;
  return 0;
}

function partialEventBoundaryLength(storage: Uint8Array, size: number): number {
  if (size >= 3
    && storage[size - 3] === 13
    && storage[size - 2] === 10
    && storage[size - 1] === 13) return 3;
  if (size >= 2 && storage[size - 2] === 13 && storage[size - 1] === 10) return 2;
  if (size >= 1 && (storage[size - 1] === 13 || storage[size - 1] === 10)) return 1;
  return 0;
}

/** Incrementally parse SSE without retaining more than one bounded event. */
export async function* parseEventBody(
  body: ReadableStream<Uint8Array>,
  maximum = MAX_SSE_EVENT_BYTES,
): AsyncGenerator<GatewayEvent> {
  if (!Number.isSafeInteger(maximum) || maximum <= 0 || maximum > MAX_SSE_EVENT_BYTES) {
    throw new Error(`Gateway SSE event limit must be between 1 and ${MAX_SSE_EVENT_BYTES} bytes.`);
  }
  const maximumStorage = maximum + 4;
  const initialCapacity = Math.min(INITIAL_SSE_BUFFER_BYTES, maximumStorage);
  if (activeSseBufferBytes + initialCapacity > MAX_ACTIVE_SSE_BUFFER_BYTES) {
    throw new Error(`Gateway SSE buffers exceed the ${MAX_ACTIVE_SSE_BUFFER_BYTES}-byte aggregate limit.`);
  }
  let storage = Buffer.allocUnsafe(initialCapacity);
  activeSseBufferBytes += initialCapacity;
  let reservedCapacity = initialCapacity;
  let size = 0;
  const resize = (nextCapacity: number): void => {
    if (nextCapacity === reservedCapacity) return;
    // Reserve the new allocation before releasing the old one so the budget
    // also bounds the resize copy's transient dual-buffer peak.
    if (activeSseBufferBytes + nextCapacity > MAX_ACTIVE_SSE_BUFFER_BYTES) {
      throw new Error(`Gateway SSE buffers exceed the ${MAX_ACTIVE_SSE_BUFFER_BYTES}-byte aggregate limit.`);
    }
    const next = Buffer.allocUnsafe(nextCapacity);
    activeSseBufferBytes += nextCapacity;
    try { storage.copy(next, 0, 0, size); }
    catch (error) {
      activeSseBufferBytes -= nextCapacity;
      throw error;
    }
    activeSseBufferBytes -= reservedCapacity;
    reservedCapacity = nextCapacity;
    storage = next;
  };
  const ensureCapacity = (): void => {
    if (size < storage.byteLength) return;
    if (storage.byteLength >= maximumStorage) {
      throw new Error(`Gateway SSE event exceeds ${maximum} bytes.`);
    }
    resize(Math.min(maximumStorage, Math.max(storage.byteLength * 2, size + 1)));
  };
  try {
    for await (const chunk of body) {
      for (const byte of chunk) {
        ensureCapacity();
        storage[size] = byte;
        size += 1;

        const boundaryLength = eventBoundaryLength(storage, size);
        if (boundaryLength > 0) {
          const eventBytes = size - boundaryLength;
          if (eventBytes > maximum) {
            throw new Error(`Gateway SSE event exceeds ${maximum} bytes.`);
          }
          const event = parseEventBlock(new TextDecoder().decode(storage.subarray(0, eventBytes)));
          size = 0;
          if (event != null) {
            // Keep the raw-buffer reservation while the consumer owns the
            // parsed object. This conservatively charges queued JSON payloads
            // against the same aggregate budget until downstream resumes.
            yield event;
          }
          if (reservedCapacity > initialCapacity
            && activeSseBufferBytes + initialCapacity <= MAX_ACTIVE_SSE_BUFFER_BYTES) {
            resize(initialCapacity);
          }
          continue;
        }

        // Up to three trailing bytes may still become the CRLFCRLF delimiter.
        // Everything before that suffix is definitely event content and must be
        // rejected before a later delimiter could route it through JSON parsing.
        if (size - partialEventBoundaryLength(storage, size) > maximum) {
          throw new Error(`Gateway SSE event exceeds ${maximum} bytes.`);
        }
      }
    }
    if (size > maximum) {
      throw new Error(`Gateway SSE event exceeds ${maximum} bytes.`);
    }
    const event = parseEventBlock(new TextDecoder().decode(storage.subarray(0, size)));
    if (event != null) yield event;
  } finally {
    activeSseBufferBytes -= reservedCapacity;
  }
}

export function makeGatewayService(config: CliRuntimeConfig): GatewayService {
  let cachedConnection: GatewayConnection | undefined;
  let cachedServices: GatewayServices | undefined;
  let serviceRefreshGeneration = 0;
  let lastServiceRefreshFailure: CliFailure | undefined;
  const serviceRefreshMutex = Effect.unsafeMakeSemaphore(1);
  const invalidateConnection = () => Effect.sync(() => {
    cachedConnection = undefined;
    cachedServices = undefined;
    serviceRefreshGeneration += 1;
    lastServiceRefreshFailure = undefined;
  });
  const invalidateServices = () => Effect.sync(() => {
    cachedServices = undefined;
    serviceRefreshGeneration += 1;
    lastServiceRefreshFailure = undefined;
  });
  const invalidateIfStale = (error: CliFailure) => error instanceof GatewayTransportError
    || error instanceof GatewayResponseError && (error.status === 401 || error.status === 403)
    ? invalidateConnection()
    : Effect.void;
  const connection = Effect.suspend(() => cachedConnection === undefined
    ? resolveGatewayConnection(config).pipe(Effect.tap((resolved) => Effect.sync(() => {
      cachedConnection = resolved;
    })))
    : Effect.succeed(cachedConnection));

  const getJson = (path: string, method?: string): Effect.Effect<unknown, CliFailure> =>
    connection.pipe(
      Effect.flatMap((resolved) => makeHeaders(config, resolved, "application/json").pipe(
        Effect.flatMap((headers) => fetchGateway(config, resolved, path, { headers }, method)),
      )),
      Effect.flatMap((response) => decodeJsonResponse(response, method)),
      Effect.tapError(invalidateIfStale),
    );

  const postJson = (
    path: string,
    body: unknown,
    method?: string,
    maximumResponseBytes = MAX_GATEWAY_JSON_RESPONSE_BYTES,
    maximumTimeoutMs?: number,
  ): Effect.Effect<unknown, CliFailure> =>
    Effect.try({
      try: () => {
        const encoded = JSON.stringify(body ?? {});
        if (encoded === undefined) throw new TypeError("JSON.stringify returned undefined");
        return encoded;
      },
      // This boundary is also used by the reusable Gateway service, where a
      // caller can supply values that did not originate in the CLI's JSON
      // parser. Keep cycles, unsupported top-level values, and excessive
      // nesting in the typed error channel so MCP/RPC requests stay correlated.
      catch: () => new CliInputError({
        code: "INVALID_INPUT",
        message: "Gateway arguments are not JSON serializable within the supported nesting limits.",
      }),
    }).pipe(
      Effect.flatMap((encodedBody) => connection.pipe(
        Effect.flatMap((resolved) => makeHeaders(config, resolved, "application/json").pipe(
          Effect.flatMap((headers) => {
            headers.set("content-type", "application/json");
            return fetchGateway(
              config,
              resolved,
              path,
              { method: "POST", headers, body: encodedBody },
              method,
              maximumTimeoutMs,
            );
          }),
        )),
        Effect.flatMap((response) => decodeJsonResponse(response, method, maximumResponseBytes)),
        Effect.tapError(invalidateIfStale),
      )),
    );

  const staticServices: GatewayServices = {
    protocolVersion: 0,
    capabilities: [],
    methods: GROK_BOT_030_GATEWAY_METHODS,
    live: false,
  };
  const discoverServices = postJson(
    `${GATEWAY_API_PREFIX}/listGatewayServices`,
    {},
    "listGatewayServices",
    MAX_GATEWAY_SERVICE_MANIFEST_BYTES,
    MAX_GATEWAY_SERVICE_REFRESH_TIMEOUT_MS,
  ).pipe(
      Effect.flatMap((value) => {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          return Effect.fail(new GatewayTransportError({
            code: "GATEWAY_PROTOCOL",
            message: "Gateway service discovery returned an invalid object.",
            method: "listGatewayServices",
          }));
        }
        const record = value as Readonly<Record<string, unknown>>;
        if (
          !Array.isArray(record.methods)
          || record.methods.length > MAX_GATEWAY_SERVICE_METHODS
          || record.methods.some((item) => typeof item !== "string" || !GATEWAY_METHOD_PATTERN.test(item))
        ) {
          return Effect.fail(new GatewayTransportError({
            code: "GATEWAY_PROTOCOL",
            message: "Gateway service discovery returned an invalid method list.",
            method: "listGatewayServices",
          }));
        }
        if (
          record.capabilities !== undefined
          && (
            !Array.isArray(record.capabilities)
            || record.capabilities.length > MAX_GATEWAY_SERVICE_CAPABILITIES
            || record.capabilities.some((item) => typeof item !== "string"
              || item.length === 0
              || Buffer.byteLength(item, "utf8") > MAX_GATEWAY_SERVICE_CAPABILITY_BYTES
              || /[\u0000-\u001f\u007f]/.test(item))
          )
        ) {
          return Effect.fail(new GatewayTransportError({
            code: "GATEWAY_PROTOCOL",
            message: "Gateway service discovery returned an invalid capability list.",
            method: "listGatewayServices",
          }));
        }
        if (
          record.protocolVersion !== undefined
          && (
            typeof record.protocolVersion !== "number"
            || !Number.isSafeInteger(record.protocolVersion)
            || record.protocolVersion < 0
          )
        ) {
          return Effect.fail(new GatewayTransportError({
            code: "GATEWAY_PROTOCOL",
            message: "Gateway service discovery returned an invalid protocol version.",
            method: "listGatewayServices",
          }));
        }
        const discovered: GatewayServices = {
          protocolVersion: record.protocolVersion ?? 0,
          capabilities: Array.isArray(record.capabilities)
            ? record.capabilities as string[]
            : [],
          methods: [...new Set(record.methods as string[])].sort(),
          live: true,
        };
        return Effect.succeed(discovered);
      }),
      Effect.catchIf(
        (error) => error instanceof GatewayResponseError && error.status === 404,
        () => Effect.succeed(staticServices),
      ),
    );

  // Each caller records the completed generation it observed before waiting
  // for the mutex. If another caller finishes a refresh while this one waits,
  // reuse that exact result (or failure) instead of issuing a duplicate
  // discovery request. A later, non-overlapping caller deliberately performs a
  // fresh negotiation, which lets MCP observe host upgrades without first
  // provoking a stale service 404.
  const refreshServices = Effect.suspend(() => {
    const observedGeneration = serviceRefreshGeneration;
    return serviceRefreshMutex.withPermits(1)(Effect.suspend(() => {
      if (serviceRefreshGeneration !== observedGeneration) {
        if (lastServiceRefreshFailure !== undefined) return Effect.fail(lastServiceRefreshFailure);
        if (cachedServices !== undefined) return Effect.succeed(cachedServices);
      }
      return discoverServices.pipe(
        Effect.tap((discovered) => Effect.sync(() => {
          cachedServices = discovered;
          lastServiceRefreshFailure = undefined;
          serviceRefreshGeneration += 1;
        })),
        Effect.tapError((error) => Effect.sync(() => {
          lastServiceRefreshFailure = error;
          serviceRefreshGeneration += 1;
        })),
      );
    }));
  });

  const services = Effect.suspend(() => {
    if (cachedServices !== undefined) return Effect.succeed(cachedServices);
    return refreshServices;
  });

  return {
    connection,
    health: getJson(GATEWAY_HEALTH_PATH, "health"),
    services,
    refreshServices,
    prepareUpgrade: postJson(GATEWAY_PREPARE_UPGRADE_PATH, {}, "prepareUpgrade"),
    invoke: (method, args = {}, options = {}) => {
      if (!GATEWAY_METHOD_PATTERN.test(method)) {
        return Effect.fail(new CliInputError({ code: "UNKNOWN_SERVICE", message: `Invalid gateway service name: ${method}` }));
      }
      const known = isKnownService(method);
      const allowed = options.allowUnknown === true
        ? Effect.succeed(true)
        : services.pipe(Effect.map((catalog) => catalog.methods.includes(method)
          || known && !catalog.live));
      return allowed.pipe(
        Effect.flatMap((isAllowed) => isAllowed
          ? postJson(`${GATEWAY_API_PREFIX}/${method}`, args, method).pipe(
            Effect.tapError((error) => error instanceof GatewayResponseError && error.status === 404
              ? invalidateServices()
              : Effect.void),
          )
          : Effect.fail(new CliInputError({
            code: "UNKNOWN_SERVICE",
            message: `Gateway service '${method}' is not advertised. Pass --allow-unknown only when you trust the target gateway.`,
          }))),
      );
    },
    uploadAttachmentFile: (options) => validateAttachmentUploadOptions(options).pipe(
      Effect.flatMap((validated) => Effect.acquireUseRelease(
        prepareAttachmentFile(validated),
        (prepared) => services.pipe(
          Effect.flatMap((catalog) => {
            const advertised = catalog.methods.includes("uploadAttachment")
              || isKnownService("uploadAttachment") && !catalog.live;
            if (!advertised) {
              return Effect.fail(new CliInputError({
                code: "UNKNOWN_SERVICE",
                message: "Gateway service 'uploadAttachment' is not advertised.",
              }));
            }
            const rawStream = catalog.capabilities.includes(GATEWAY_ATTACHMENT_UPLOAD_STREAM_CAPABILITY);
            return connection.pipe(
              Effect.flatMap((resolved) => makeHeaders(config, resolved, "application/json").pipe(
                Effect.flatMap((headers) => uploadAttachmentResponse(
                  config,
                  resolved,
                  headers,
                  prepared,
                  validated,
                  rawStream,
                )),
              )),
              Effect.tapError((error) => error instanceof GatewayResponseError && error.status === 404
                ? invalidateServices()
                : Effect.void),
              Effect.tapError(invalidateIfStale),
            );
          }),
        ),
        (prepared) => Effect.promise(async () => {
          try {
            await prepared.handle.close();
          } catch {}
        }),
      )),
    ),
    avatar: (agentId) => {
      if (agentId.length === 0) return Effect.fail(new CliInputError({ code: "INVALID_INPUT", message: "Agent id is required." }));
      return connection.pipe(
        Effect.flatMap((resolved) => makeHeaders(config, resolved).pipe(
          Effect.flatMap((headers) => fetchGateway(
            config,
            resolved,
            `${GATEWAY_AVATARS_PATH}/${encodeURIComponent(agentId)}`,
            { headers },
            "avatar",
          )),
        )),
        Effect.flatMap((response): Effect.Effect<AvatarResponse, GatewayResponseError | GatewayTransportError> => {
          if (!response.ok) {
            return Effect.tryPromise({
              try: async (signal) => new TextDecoder().decode(
                await readBoundedResponseBytes(response, MAX_GATEWAY_ERROR_RESPONSE_BYTES, signal),
              ),
              catch: (error) => new GatewayTransportError({
                code: "GATEWAY_PROTOCOL",
                message: `Failed reading avatar error response: ${error instanceof Error ? error.message : String(error)}`,
                method: "avatar",
              }),
            }).pipe(
              Effect.flatMap((body): Effect.Effect<never, GatewayResponseError | GatewayTransportError> => Effect.fail(new GatewayResponseError({
                code: "GATEWAY_RESPONSE",
                message: responseErrorMessage(body, response.statusText),
                method: "avatar",
                status: response.status,
                retryable: response.status >= 500,
              }))),
            );
          }
          return Effect.tryPromise({
            try: (signal) => readBoundedResponseBytes(response, MAX_AVATAR_RESPONSE_BYTES, signal),
            catch: (error) => new GatewayTransportError({
              code: "GATEWAY_PROTOCOL",
              message: `Failed reading avatar bytes: ${error instanceof Error ? error.message : String(error)}`,
              method: "avatar",
            }),
          }).pipe(Effect.map((bytes): AvatarResponse => {
            const result = {
              bytes,
              contentType: response.headers.get("content-type") ?? "application/octet-stream",
            };
            const etag = response.headers.get("etag");
            return etag === null ? result : { ...result, etag };
          }));
        }),
        Effect.tapError(invalidateIfStale),
      );
    },
    events: (channels) => {
      let connectionAttempt = 0;
      const connectOnce = Stream.suspend(() => {
        connectionAttempt += 1;
        return Stream.unwrapScoped(
          connection.pipe(
            Effect.flatMap((resolved) => {
              const query = channels == null || channels.length === 0
                ? ""
                : `?channels=${encodeURIComponent(channels.join(","))}`;
              return makeHeaders(config, resolved, "text/event-stream").pipe(
                Effect.flatMap((headers) => Effect.acquireRelease(
                  fetchGatewayStream(
                    config,
                    resolved,
                    `${GATEWAY_EVENTS_PATH}${query}`,
                    { headers },
                    "events",
                  ).pipe(
                    Effect.flatMap((response) => {
                      if (!response.ok || response.body == null) {
                        const failure = new GatewayResponseError({
                          code: "GATEWAY_RESPONSE",
                          message: `Gateway event stream failed: HTTP ${response.status}.`,
                          method: "events",
                          status: response.status,
                          retryable: response.status >= 500,
                        });
                        return cancelResponseBody(response).pipe(Effect.zipRight(Effect.fail(failure)));
                      }
                      return Effect.succeed(response);
                    }),
                  ),
                  (response) => cancelResponseBody(response),
                )),
              );
            }),
            Effect.map((response) => {
              const stream = Stream.fromAsyncIterable(
                parseEventBody(response.body!),
                (error) => new GatewayTransportError({
                  code: "GATEWAY_UNREACHABLE",
                  message: `Gateway event stream ended with an error: ${error instanceof Error ? error.message : String(error)}`,
                  method: "events",
                }),
              ).pipe(Stream.concat(Stream.fail(new GatewayTransportError({
                code: "GATEWAY_UNREACHABLE",
                message: "Gateway event stream closed; reconnecting may leave an observation gap.",
                method: "events",
              }))));
              return connectionAttempt <= 1
                ? stream
                : Stream.succeed<GatewayEvent>({
                  channel: CLI_GATEWAY_EVENT_CHANNEL,
                  payload: { kind: "reconnected", possibleGap: true, attempt: connectionAttempt },
                }).pipe(Stream.concat(stream));
            }),
          ),
        );
      });
      const retry = Schedule.spaced("1 second").pipe(Schedule.whileInput((error: CliFailure) =>
        error instanceof GatewayTransportError
        || error instanceof GatewayResponseError && error.retryable));
      return connectOnce.pipe(
        Stream.tapError(() => invalidateConnection()),
        Stream.retry(retry),
      );
    },
  };
}

export function GatewayLive(config: CliRuntimeConfig): Layer.Layer<GatewayService> {
  return Layer.succeed(Gateway, makeGatewayService(config));
}
