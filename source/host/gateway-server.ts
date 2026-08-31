import { timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { constants as zlibConstants, createGzip, gzip } from "node:zlib";
import { GATEWAY_API_PREFIX, GATEWAY_ATTACHMENT_AGENT_ID_HEADER, GATEWAY_ATTACHMENT_AGENT_ID_MAX_BYTES, GATEWAY_ATTACHMENT_FILENAME_HEADER, GATEWAY_ATTACHMENT_FILENAME_MAX_BYTES, GATEWAY_ATTACHMENT_UPLOAD_STREAM_PATH, GATEWAY_AUTH_SCHEME, GATEWAY_AVATARS_PATH, GATEWAY_EVENTS_PATH, GATEWAY_HEALTH_PATH, GATEWAY_MINT_DEDUPE_HEADER, GATEWAY_SLIM_AVATARS_HEADER, GATEWAY_TRACEPARENT_HEADER } from "../shared/gateway-wire.js";
import { attachmentByteLimitForName } from "../shared/media/attachment-limits.js";
import { GATEWAY_LOCAL_EXEC_REQUESTS_PATH, GATEWAY_LOCAL_EXEC_RESPONSES_PATH } from "../shared/local-exec-gateway.js";
import { parseTraceparent } from "../shared/observability/send-trace.js";
import { GATEWAY_WEBAUTHN_REQUESTS_PATH, GATEWAY_WEBAUTHN_RESPONSES_PATH } from "../shared/webauthn-gateway.js";
import { classifyGatewayCommandError } from "./gateway-command-error.js";
import { GATEWAY_PREPARE_UPGRADE_PATH, SAND_GATEWAY_COMMANDS, SAND_GATEWAY_SLIM_COMMANDS, isLoopbackHost, stripInlineAvatarsFromEvent } from "./gateway-protocol.js";
import { assertValidSandAgentId } from "./storage/agent-paths.js";

export class SandGatewayRequestError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "SandGatewayRequestError";
  }
}
export const GATEWAY_REQUEST_ID_HEADER = "x-sand-request-id"; export const SSE_HEARTBEAT_MS = 15_000; export const MAX_REQUEST_PAYLOAD_BYTES = 64 * 1024 * 1024; export const MAX_BODY_BYTES = MAX_REQUEST_PAYLOAD_BYTES; export const GZIP_MIN_BYTES = 1_400; export const DISABLE_SSE_GZIP_ENV = "SAND_DISABLE_GATEWAY_SSE_GZIP";
export const MAX_ACTIVE_ATTACHMENT_UPLOAD_STREAMS = 2;
export const MAX_SSE_FRAME_BYTES = 16 * 1024 * 1024;
export const MAX_SSE_PENDING_BYTES = 16 * 1024 * 1024;
export const MAX_SSE_PENDING_FRAMES = 1_024;
export function statusForCommandError(error: unknown): number {
  if (error instanceof SandGatewayRequestError) return error.status;
  const name = error instanceof Error ? error.name : "";
  if (name === "SandCloudAgentDisabledError") return 403;
  if (name === "SandAgentLimitError" || name === "SandSkillPublishError") return 409;
  if (name === "AttachmentTooLargeError") return 413;
  if (error instanceof SyntaxError || error instanceof URIError || name === "SandInvalidAgentIdError" || name === "SandAttachmentError" || name === "SandCloudAgentLaunchError") return 400;
  if (error instanceof Error && (/^Malformed\s/.test(error.message) || /^Unsupported channel platform:/.test(error.message))) return 400;
  return 500;
}
export function publicMessageForCommandError(error: unknown): string {
  if (error instanceof SandGatewayRequestError) return error.message;
  const status = statusForCommandError(error);
  if (status === 400) return "invalid gateway request";
  if (status === 413) return "request payload is too large";
  if (status >= 500) return "internal gateway error";
  return "gateway command failed";
}
export async function readBody(req: AsyncIterable<unknown>): Promise<string> { const chunks: Buffer[] = []; let total = 0; for await (const chunk of req) { const buffer = chunk instanceof Buffer ? chunk : Buffer.from(chunk as ArrayBuffer); total += buffer.length; if (total > MAX_BODY_BYTES) throw new SandGatewayRequestError("Request body is too large.", 413); chunks.push(buffer); } return Buffer.concat(chunks).toString("utf8"); }
export function clientAcceptsGzip(req: IncomingMessage): boolean { const header = req.headers["accept-encoding"]; const value = Array.isArray(header) ? header.join(",") : header; return typeof value === "string" && value.toLowerCase().includes("gzip"); }
export function clientWantsSlimAvatars(req: IncomingMessage): boolean { const header = req.headers[GATEWAY_SLIM_AVATARS_HEADER]; return (Array.isArray(header) ? header[0] : header) === "1"; }
export function respondJson(res: ServerResponse, value: unknown, req?: IncomingMessage): void { const raw = Buffer.from(JSON.stringify(value ?? null), "utf8"); const respondRaw = () => { res.writeHead(200, { "content-type": "application/json", "content-length": raw.byteLength, [GATEWAY_MINT_DEDUPE_HEADER]: "1" }); res.end(raw); }; if (req != null && raw.byteLength >= GZIP_MIN_BYTES && clientAcceptsGzip(req)) { gzip(raw, (error, zipped) => { if (res.destroyed || res.writableEnded || res.headersSent) return; if (error != null) return respondRaw(); res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip", "content-length": zipped.byteLength, vary: "Accept-Encoding", [GATEWAY_MINT_DEDUPE_HEADER]: "1" }); res.end(zipped); }); return; } respondRaw(); }
export function respondError(res: ServerResponse, status: number, message: string): void { const body = JSON.stringify({ error: message }); res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) }); res.end(body); }
export function isAuthorized(req: IncomingMessage, expectedToken: string): boolean { const header = req.headers.authorization; if (typeof header !== "string") return false; const prefix = `${GATEWAY_AUTH_SCHEME} `; if (!header.startsWith(prefix)) return false; const provided = Buffer.from(header.slice(prefix.length)); const expected = Buffer.from(expectedToken); return provided.length === expected.length && timingSafeEqual(provided, expected); }
export function hostHeaderHostname(req: IncomingMessage): string | null { const header = req.headers.host; if (typeof header !== "string" || header.length === 0) return null; try { return new URL(`http://${header}`).hostname; } catch { return null; } }
export function rejectUntrustedBrowserRequest(deps: { authToken?: string }, req: IncomingMessage, res: ServerResponse): boolean { if (req.headers.origin !== undefined) { respondError(res, 403, "browser-origin gateway requests are not allowed"); return true; } if (deps.authToken == null) { const hostname = hostHeaderHostname(req); if (hostname == null || !isLoopbackHost(hostname)) { respondError(res, 403, "untrusted gateway host"); return true; } } return false; }
function headerValue(req: IncomingMessage, name: string): string | undefined { const raw = req.headers[name]; const value = Array.isArray(raw) ? raw[0] : raw; return typeof value === "string" && value.length > 0 ? value : undefined; }
function commandTrace(req: IncomingMessage) { const traceparent = headerValue(req, GATEWAY_TRACEPARENT_HEADER); const parsed = parseTraceparent(traceparent); return parsed == null ? {} : { traceparent, traceId: parsed.traceId, spanId: parsed.spanId }; }

export interface GatewayServerDeps {
  readonly api: { getAgentAvatar(...args: any[]): any; [name: string]: (...args: any[]) => any }; readonly subscribe: (listener: (event: any) => void) => () => void; readonly getHealth: () => Record<string, any>; readonly startedAt: number;
  readonly host?: string; readonly port?: number; readonly authToken?: string; readonly tls?: { cert: Buffer; key: Buffer };
  readonly prepareForUpgrade?: () => Promise<unknown>; readonly onCommandError?: (report: Record<string, unknown>) => void; readonly onCommandComplete?: (report: Record<string, unknown>) => void;
  readonly onEventStreamClosed?: () => void; readonly onDesktopContact?: () => void;
  readonly localExec?: { registerProvider(listener: (frame: unknown) => void): () => void; submitResponses(batch: unknown): void };
  readonly webauthn?: { registerProvider(listener: (frame: unknown) => void): () => void; submitResponses(batch: unknown): void };
}

export async function routeCommand(deps: GatewayServerDeps, method: string, body: string, res: ServerResponse, req: IncomingMessage): Promise<void> { if (!Object.hasOwn(SAND_GATEWAY_COMMANDS, method)) return respondError(res, 404, `unknown gateway method: ${method}`); const table = clientWantsSlimAvatars(req) ? SAND_GATEWAY_SLIM_COMMANDS : SAND_GATEWAY_COMMANDS; const handler = (table as Record<string, (api: unknown, body: string) => unknown>)[method]; if (handler == null) return respondError(res, 404, `unknown gateway method: ${method}`); const requestId = headerValue(req, GATEWAY_REQUEST_ID_HEADER); const { traceparent: _parent, ...traceIds } = commandTrace(req); const startedAt = Date.now(); let result: unknown; try { result = await handler(deps.api, body); } catch (error) { if (deps.onCommandError != null && statusForCommandError(error) >= 500) { try { deps.onCommandError({ method, ...classifyGatewayCommandError(error), durationMs: Date.now() - startedAt, requestId, ...traceIds }); } catch {} } throw error; } if (deps.onCommandComplete != null) { try { deps.onCommandComplete({ method, durationMs: Date.now() - startedAt, requestId, ...traceIds }); } catch {} } respondJson(res, result, req); }

export function openSseStream(req: IncomingMessage, res: ServerResponse, register: (write: (data: string) => void) => () => void): void {
  const gzipEnabled = process.env[DISABLE_SSE_GZIP_ENV] !== "1" && clientAcceptsGzip(req);
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", ...(gzipEnabled ? { "content-encoding": "gzip", vary: "Accept-Encoding" } : {}) });
  const zipper = gzipEnabled ? createGzip({ flush: zlibConstants.Z_SYNC_FLUSH }) : null;
  zipper?.pipe(res);
  const sink = zipper ?? res;
  let closed = false;
  let heartbeat: NodeJS.Timeout | undefined;
  let unsubscribe: (() => void) | undefined;
  let waitingForDrain = false;
  let pendingBytes = 0;
  let pendingHead = 0;
  let pending: Array<{ readonly frame: string; readonly bytes: number }> = [];

  const pendingCount = () => pending.length - pendingHead;
  const onDrain = () => {
    waitingForDrain = false;
    flushPending();
  };

  const cleanup = () => {
    if (closed) return;
    closed = true;
    sink.off("drain", onDrain);
    waitingForDrain = false;
    pending = [];
    pendingHead = 0;
    pendingBytes = 0;
    if (heartbeat !== undefined) clearInterval(heartbeat);
    const dispose = unsubscribe;
    unsubscribe = undefined;
    try { dispose?.(); } catch {}
    if (zipper != null) {
      zipper.unpipe(res);
      zipper.destroy();
    }
  };
  const abort = () => {
    cleanup();
    if (!res.destroyed) res.destroy();
  };
  const waitForDrain = () => {
    if (waitingForDrain || closed) return;
    waitingForDrain = true;
    sink.once("drain", onDrain);
  };
  function flushPending(): void {
    while (!closed && !waitingForDrain && pendingHead < pending.length) {
      const item = pending[pendingHead]!;
      pendingHead += 1;
      pendingBytes -= item.bytes;
      try {
        if (!sink.write(item.frame)) waitForDrain();
      } catch {
        abort();
      }
    }
    if (pendingHead === pending.length) {
      pending = [];
      pendingHead = 0;
      pendingBytes = 0;
    } else if (pendingHead >= 256 && pendingHead * 2 >= pending.length) {
      pending = pending.slice(pendingHead);
      pendingHead = 0;
    }
  }
  const writeFrame = (frame: string): boolean => {
    if (closed) return false;
    const bytes = Buffer.byteLength(frame);
    if (bytes > MAX_SSE_FRAME_BYTES) {
      abort();
      return false;
    }
    if (waitingForDrain || pendingCount() > 0) {
      if (pendingCount() >= MAX_SSE_PENDING_FRAMES || pendingBytes + bytes > MAX_SSE_PENDING_BYTES) {
        abort();
        return false;
      }
      pending.push({ frame, bytes });
      pendingBytes += bytes;
      return true;
    }
    try {
      if (!sink.write(frame)) waitForDrain();
      return true;
    } catch {
      abort();
      return false;
    }
  };

  res.once("close", cleanup);
  res.once("error", abort);
  zipper?.once("error", abort);
  if (!writeFrame("retry: 1000\n\n")) return;

  let registered: () => void;
  try {
    registered = register((data) => { writeFrame(`data: ${data}\n\n`); });
  } catch (error) {
    abort();
    throw error;
  }
  // A register implementation may synchronously publish enough events to
  // overflow the bounded pending queue. Dispose it if that closed the stream.
  if (closed) {
    try { registered(); } catch {}
    return;
  }
  unsubscribe = registered;
  heartbeat = setInterval(() => {
    // Heartbeats carry no state and must never crowd out real event frames.
    if (!waitingForDrain && pendingCount() === 0) writeFrame(":ping\n\n");
  }, SSE_HEARTBEAT_MS);
}
export function parseSubscribedChannels(url: URL): Set<string> | undefined { const raw = url.searchParams.get("channels"); if (raw === null) return undefined; const channels = raw.split(",").map((value) => value.trim()).filter(Boolean); return channels.length > 0 ? new Set(channels) : undefined; }
function handleEvents(deps: GatewayServerDeps, req: IncomingMessage, res: ServerResponse, channels?: Set<string>): void { const slim = clientWantsSlimAvatars(req); res.on("close", () => deps.onEventStreamClosed?.()); openSseStream(req, res, (write) => deps.subscribe((event) => { if (channels != null && !channels.has(event.channel)) return; write(JSON.stringify(slim ? stripInlineAvatarsFromEvent(event) : event)); })); }
const DATA_URL_PATTERN = /^data:([a-z0-9.+/-]+);base64,(.*)$/i; const AVATAR_NO_EXECUTE_HEADERS = { "content-disposition": "attachment", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" };
async function handleAvatarImage(deps: GatewayServerDeps, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> { if (req.headers["sec-fetch-site"] === "cross-site") return respondError(res, 403, "cross-site avatar loads are not allowed"); const agentId = decodeURIComponent(url.pathname.slice(GATEWAY_AVATARS_PATH.length + 1)); if (agentId.length === 0) return respondError(res, 404, "missing agent id"); const avatar = await deps.api.getAgentAvatar({ id: agentId }) as { dataUrl?: string | null; version?: string | null }; const match = avatar.dataUrl == null ? null : DATA_URL_PATTERN.exec(avatar.dataUrl); if (avatar.version == null || match?.[1] == null || match[2] == null) return respondError(res, 404, "agent has no avatar"); const requested = url.searchParams.get("v"); if (requested != null && requested !== avatar.version) return respondError(res, 404, "no such avatar version"); const etag = `"${avatar.version}"`; const cache = requested != null ? { "cache-control": "private, max-age=31536000, immutable", etag } : { "cache-control": "no-store", etag }; if (req.headers["if-none-match"] === etag) { res.writeHead(304, cache); res.end(); return; } const bytes = Buffer.from(match[2], "base64"); res.writeHead(200, { ...cache, ...AVATAR_NO_EXECUTE_HEADERS, "content-type": match[1], "content-length": bytes.byteLength }); res.end(bytes); }
function handleBridgeRequests(bridge: GatewayServerDeps["localExec"] | GatewayServerDeps["webauthn"], missing: string, req: IncomingMessage, res: ServerResponse): void { if (bridge == null) return respondError(res, 404, missing); openSseStream(req, res, (write) => bridge.registerProvider((frame) => write(JSON.stringify(frame)))); }
function handleBridgeResponses(bridge: GatewayServerDeps["localExec"] | GatewayServerDeps["webauthn"], missing: string, body: string, res: ServerResponse): void { if (bridge == null) return respondError(res, 404, missing); bridge.submitResponses(body.length > 0 ? JSON.parse(body) : {}); respondJson(res, { ok: true }); }

const activeAttachmentStreams = new WeakMap<GatewayServerDeps, number>();

function exactHeaderValues(req: IncomingMessage, name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index + 1 < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index]?.toLowerCase() === name) values.push(req.rawHeaders[index + 1] ?? "");
  }
  if (values.length > 0) return values;
  const fallback = req.headers[name];
  if (Array.isArray(fallback)) return [...fallback];
  return typeof fallback === "string" ? [fallback] : [];
}

function decodedAttachmentHeader(req: IncomingMessage, name: string, maximumBytes: number, required: boolean): string | undefined {
  const values = exactHeaderValues(req, name);
  if (values.length === 0 && !required) return undefined;
  if (values.length !== 1 || values[0]!.length === 0 || Buffer.byteLength(values[0]!, "ascii") > maximumBytes * 3) {
    throw new SandGatewayRequestError("Invalid attachment upload metadata.");
  }
  let decoded: string;
  try { decoded = decodeURIComponent(values[0]!); }
  catch { throw new SandGatewayRequestError("Invalid attachment upload metadata."); }
  if (decoded.length === 0 || Buffer.byteLength(decoded, "utf8") > maximumBytes || /[\u0000-\u001f\u007f]/.test(decoded)) {
    throw new SandGatewayRequestError("Invalid attachment upload metadata.");
  }
  return decoded;
}

function attachmentContentLength(req: IncomingMessage): number {
  if (exactHeaderValues(req, "transfer-encoding").length > 0) {
    throw new SandGatewayRequestError("Attachment uploads require an exact content length.");
  }
  const values = exactHeaderValues(req, "content-length");
  if (values.length !== 1 || !/^[1-9][0-9]*$/.test(values[0]!)) {
    throw new SandGatewayRequestError("Attachment uploads require an exact content length.");
  }
  const length = Number(values[0]);
  if (!Number.isSafeInteger(length)) throw new SandGatewayRequestError("Attachment content length is too large.", 413);
  return length;
}

function acquireAttachmentStream(deps: GatewayServerDeps): boolean {
  const active = activeAttachmentStreams.get(deps) ?? 0;
  if (active >= MAX_ACTIVE_ATTACHMENT_UPLOAD_STREAMS) return false;
  activeAttachmentStreams.set(deps, active + 1);
  return true;
}

function releaseAttachmentStream(deps: GatewayServerDeps): void {
  const active = activeAttachmentStreams.get(deps) ?? 1;
  if (active <= 1) activeAttachmentStreams.delete(deps);
  else activeAttachmentStreams.set(deps, active - 1);
}

export async function handleAttachmentUploadStream(deps: GatewayServerDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (deps.authToken == null) return respondError(res, 401, "attachment streaming requires gateway authentication");
  const contentTypes = exactHeaderValues(req, "content-type");
  if (contentTypes.length !== 1 || contentTypes[0]!.trim().toLowerCase() !== "application/octet-stream") {
    throw new SandGatewayRequestError("Attachment uploads require application/octet-stream.");
  }
  if (exactHeaderValues(req, "content-encoding").length > 0) {
    throw new SandGatewayRequestError("Attachment uploads do not accept content encoding.");
  }
  const filename = decodedAttachmentHeader(req, GATEWAY_ATTACHMENT_FILENAME_HEADER, GATEWAY_ATTACHMENT_FILENAME_MAX_BYTES, true)!;
  const agentId = decodedAttachmentHeader(req, GATEWAY_ATTACHMENT_AGENT_ID_HEADER, GATEWAY_ATTACHMENT_AGENT_ID_MAX_BYTES, false);
  if (agentId !== undefined) {
    try { assertValidSandAgentId(agentId); }
    catch { throw new SandGatewayRequestError("Invalid attachment upload metadata."); }
  }
  const expectedBytes = attachmentContentLength(req);
  if (expectedBytes > attachmentByteLimitForName(filename)) {
    throw new SandGatewayRequestError("Attachment content length is too large.", 413);
  }
  if (!acquireAttachmentStream(deps)) {
    res.setHeader("connection", "close");
    res.once("finish", () => req.socket.destroy());
    return respondError(res, 429, "too many active attachment uploads");
  }

  const upload = deps.api.uploadAttachmentStream;
  if (typeof upload !== "function") {
    releaseAttachmentStream(deps);
    throw new SandGatewayRequestError("Attachment streaming is unavailable.", 503);
  }
  const controller = new AbortController();
  const abort = () => { if (!controller.signal.aborted) controller.abort(new DOMException("The attachment upload disconnected.", "AbortError")); };
  const onRequestClose = () => { if (!req.complete) abort(); };
  const onResponseClose = () => { if (!res.writableEnded) abort(); };
  req.once("aborted", abort);
  req.once("close", onRequestClose);
  req.socket.once("close", abort);
  res.once("close", onResponseClose);
  let result: unknown;
  try {
    result = await upload({
      filename,
      expectedBytes,
      chunks: req,
      signal: controller.signal,
      ...(agentId === undefined ? {} : { agentId }),
    });
    if (controller.signal.aborted) throw controller.signal.reason;
  } finally {
    req.off("aborted", abort);
    req.off("close", onRequestClose);
    req.socket.off("close", abort);
    res.off("close", onResponseClose);
    releaseAttachmentStream(deps);
  }
  respondJson(res, result, req);
}

export async function handleRequest(deps: GatewayServerDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1"); if (rejectUntrustedBrowserRequest(deps, req, res)) return;
  if (deps.authToken != null && !isAuthorized(req, deps.authToken)) return respondError(res, 401, "unauthorized");
  if (req.method === "GET" && url.pathname === GATEWAY_HEALTH_PATH) { const health = deps.getHealth(); return respondJson(res, { ok: true, pid: process.pid, isBusy: health.isBusy, ...(health.busyOnlyAwaitingApproval === undefined ? {} : { busyOnlyAwaitingApproval: health.busyOnlyAwaitingApproval }), activeAgentId: health.activeAgentId, startedAt: deps.startedAt, lastBusyAtMs: health.lastBusyAtMs }); }
  const events = req.method === "GET" && url.pathname === GATEWAY_EVENTS_PATH; const prepare = req.method === "POST" && url.pathname === GATEWAY_PREPARE_UPGRADE_PATH; const avatar = req.method === "GET" && url.pathname.startsWith(`${GATEWAY_AVATARS_PATH}/`); const localRequests = req.method === "GET" && url.pathname === GATEWAY_LOCAL_EXEC_REQUESTS_PATH; const localResponses = req.method === "POST" && url.pathname === GATEWAY_LOCAL_EXEC_RESPONSES_PATH; const webRequests = req.method === "GET" && url.pathname === GATEWAY_WEBAUTHN_REQUESTS_PATH; const webResponses = req.method === "POST" && url.pathname === GATEWAY_WEBAUTHN_RESPONSES_PATH; const attachmentUpload = req.method === "POST" && url.pathname === GATEWAY_ATTACHMENT_UPLOAD_STREAM_PATH; const command = req.method === "POST" && url.pathname.startsWith(`${GATEWAY_API_PREFIX}/`) && !attachmentUpload;
  if (!(events || prepare || avatar || localRequests || localResponses || webRequests || webResponses || attachmentUpload || command)) return respondError(res, 404, `not found: ${req.method} ${url.pathname}`);
  if ((localRequests || localResponses) && deps.authToken == null) return respondError(res, 401, "local-exec requires gateway authentication"); if ((webRequests || webResponses) && deps.authToken == null) return respondError(res, 401, "webauthn requires gateway authentication");
  if (prepare) return respondJson(res, deps.prepareForUpgrade != null ? await deps.prepareForUpgrade() : { quiescing: false, runningTurns: 0 }); if (localRequests || localResponses) deps.onDesktopContact?.();
  if (localRequests) return handleBridgeRequests(deps.localExec, "local-exec channel not enabled", req, res); if (localResponses) return handleBridgeResponses(deps.localExec, "local-exec channel not enabled", await readBody(req), res); if (webRequests) return handleBridgeRequests(deps.webauthn, "webauthn channel not enabled", req, res); if (webResponses) return handleBridgeResponses(deps.webauthn, "webauthn channel not enabled", await readBody(req), res); if (events) return handleEvents(deps, req, res, parseSubscribedChannels(url)); if (avatar) return handleAvatarImage(deps, req, res, url); if (attachmentUpload) return handleAttachmentUploadStream(deps, req, res);
  return routeCommand(deps, url.pathname.slice(GATEWAY_API_PREFIX.length + 1), await readBody(req), res, req);
}

export async function startGatewayServer(deps: GatewayServerDeps) { if (typeof deps.authToken !== "string" || deps.authToken.length === 0) throw new SandGatewayRequestError("Gateway authentication token is required."); const host = deps.host ?? "127.0.0.1"; const listener = (req: IncomingMessage, res: ServerResponse) => { void handleRequest(deps, req, res).catch((error) => { if (res.destroyed || res.writableEnded) return; if (!res.headersSent) respondError(res, statusForCommandError(error), publicMessageForCommandError(error)); else res.end(); }); }; const server = deps.tls == null ? createHttpServer(listener) : createHttpsServer({ cert: deps.tls.cert, key: deps.tls.key }, listener); await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(deps.port ?? 0, host, () => { server.off("error", reject); resolve(); }); }); const address = server.address(); if (address == null || typeof address === "string") throw new Error("gateway did not bind a TCP address"); return { port: address.port, close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close((error) => error != null ? reject(error) : resolve()); }) }; }
