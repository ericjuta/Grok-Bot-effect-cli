import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";

import { clearGatewayDiscovery, writeGatewayDiscovery } from "../../host/host-discovery.js";
import { getGatewayDiscoveryPath, getSandProductionRootDir } from "../../host/host-paths.js";
import type { GatewayConnection } from "./gateway-descriptor-cache.js";

export const OFFICIAL_CLI_RELAY_TARGET = "official-remote-relay";
export const OFFICIAL_CLI_RELAY_PORT = 18_765;
export const OFFICIAL_CLI_RELAY_RESOLVE_TIMEOUT_MS = 8_000;
export const OFFICIAL_CLI_RELAY_START_TIMEOUT_MS = 5_000;

export interface OfficialCliLoopbackRelayOptions {
  readonly resolveConnection: () => Promise<GatewayConnection>;
  readonly discoveryPath?: string;
  readonly host?: string;
  readonly port?: number;
  readonly token?: string;
  readonly pid?: number;
  readonly startedAt?: number;
  readonly resolveTimeoutMs?: number;
}

export interface OfficialCliLoopbackRelay {
  readonly port: number;
  readonly token: string;
  readonly startedAt: number;
  readonly pid: number;
  readonly discoveryPath: string;
  readonly baseUrl: string;
  publishConnection(connection: GatewayConnection): void;
  dispose(): Promise<void>;
}
export interface OfficialCliRelayRemoteHostConnector {
  connect(): Promise<GatewayConnection>;
  readonly recreate?: (...args: unknown[]) => unknown;
  readonly forceRecreate?: (...args: unknown[]) => unknown;
  readonly issueLocalExecDaemonCredential?: (...args: unknown[]) => unknown;
}

export interface OfficialCliRelayConnectorOptions extends Omit<OfficialCliLoopbackRelayOptions, "resolveConnection"> {
  readonly onRelayReady?: (relay: OfficialCliLoopbackRelay) => void;
  readonly registerShutdown?: (dispose: () => Promise<void>) => void;
  readonly reportFailure?: (error: unknown) => void;
}

export function isLoopbackGatewayUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return (host === "127.0.0.1" || host === "localhost" || host === "::1") && url.port === "1340";
  } catch {
    return true;
  }
}

export function isAuthorizedRelayRequest(header: string | undefined, expectedToken: string): boolean {
  if (header == null || !header.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(expectedToken);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function writeGatewayDiscoverySync(info: Parameters<typeof writeGatewayDiscovery>[0], path: string): void {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = join(parent, `.${basename(path)}.${process.pid}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(info, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function discoveryOwnsRelay(
  value: unknown,
  relay: { readonly pid: number; readonly port: number; readonly startedAt: number },
): boolean {
  if (typeof value !== "object" || value == null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.pid === relay.pid
    && candidate.port === relay.port
    && candidate.startedAt === relay.startedAt
    && candidate.target === OFFICIAL_CLI_RELAY_TARGET;
}

const RELAY_CHILD_SOURCE = `
const { createServer } = require("node:http");
const { timingSafeEqual } = require("node:crypto");
const { Readable } = require("node:stream");

const hop = new Set(["connection","keep-alive","proxy-authenticate","proxy-authorization","te","trailers","transfer-encoding","upgrade","host","content-length","content-encoding"]);
const strip = new Set([...hop, "authorization", "x-anyrun-network-token"]);
const token = process.env.GROK_BOT_OFFICIAL_RELAY_TOKEN;
const port = Number(process.env.GROK_BOT_OFFICIAL_RELAY_PORT);
const host = process.env.GROK_BOT_OFFICIAL_RELAY_HOST || "127.0.0.1";
const pid = Number(process.env.GROK_BOT_OFFICIAL_RELAY_PID);
const startedAt = Number(process.env.GROK_BOT_OFFICIAL_RELAY_STARTED_AT);
const resolveTimeoutMs = Number(process.env.GROK_BOT_OFFICIAL_RELAY_RESOLVE_TIMEOUT_MS || 8000);
const pending = new Map();
let nextId = 1;
let cached = null;

function writeJson(res, status, body) {
  const raw = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json", "content-length": raw.byteLength });
  res.end(raw);
}

function authorized(req) {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function resolveConnection() {
  if (cached != null) return Promise.resolve(cached);
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("official remote connector is not ready"));
    }, Number.isFinite(resolveTimeoutMs) && resolveTimeoutMs > 0 ? resolveTimeoutMs : 8000);
    pending.set(id, { resolve, reject, timer });
    if (typeof process.send === "function") process.send({ type: "resolve", id });
    else reject(new Error("official remote connector is not ready"));
  });
}

process.on("message", (message) => {
  if (message && message.type === "connection" && message.connection != null) {
    cached = message.connection;
    return;
  }
  const pendingResolve = pending.get(message && message.id);
  if (pendingResolve == null) return;
  pending.delete(message.id);
  clearTimeout(pendingResolve.timer);
  if (message.error) pendingResolve.reject(new Error(message.error));
  else {
    if (message.connection != null) cached = message.connection;
    pendingResolve.resolve(message.connection);
  }
});

const server = createServer((req, res) => {
  void (async () => {
    if (req.headers.origin !== undefined) return writeJson(res, 403, { error: "browser-origin gateway requests are not allowed" });
    if (!authorized(req)) return writeJson(res, 401, { error: "unauthorized" });
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/health") {
      return writeJson(res, 200, { ok: true, pid, startedAt, isBusy: false, source: "official-remote-relay" });
    }
    let connection;
    try { connection = await resolveConnection(); }
    catch { return writeJson(res, 503, { error: "official remote gateway is unavailable" }); }
    let parsed;
    try { parsed = new URL(connection.baseUrl); } catch { return writeJson(res, 503, { error: "official remote relay refuses a loopback gateway" }); }
    const hostname = parsed.hostname.replace(/^\\[|\\]$/g, "").toLowerCase();
    if ((hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1") && parsed.port === "1340") {
      return writeJson(res, 503, { error: "official remote relay refuses a loopback gateway" });
    }
    let upstreamUrl;
    try { upstreamUrl = new URL(req.url ?? "/", parsed); }
    catch { return writeJson(res, 400, { error: "invalid relay request target" }); }
    if (upstreamUrl.origin !== parsed.origin) {
      return writeJson(res, 403, { error: "cross-origin relay request targets are not allowed" });
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value == null || strip.has(name.toLowerCase())) continue;
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    if (connection.token) headers.set("authorization", "Bearer " + connection.token);
    if (connection.headers) for (const [name, value] of Object.entries(connection.headers)) headers.set(name, value);
    const method = req.method ?? "GET";
    const init = { method, headers, redirect: "manual" };
    if (method !== "GET" && method !== "HEAD") {
      init.body = Readable.toWeb(req);
      init.duplex = "half";
    }
    const upstream = await fetch(upstreamUrl, init);
    const responseHeaders = {};
    upstream.headers.forEach((value, name) => { if (!hop.has(name.toLowerCase())) responseHeaders[name] = value; });
    res.writeHead(upstream.status, responseHeaders);
    if (upstream.body == null) return res.end();
    Readable.fromWeb(upstream.body).pipe(res);
  })().catch(() => {
    if (!res.headersSent) writeJson(res, 502, { error: "official remote gateway is unreachable" });
    else res.end();
  });
});

function announce(boundPort) {
  if (typeof process.send === "function") process.send({ type: "listening", port: boundPort });
}
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { reject, timer } of pending.values()) {
    clearTimeout(timer);
    reject(new Error("official CLI relay is shutting down"));
  }
  pending.clear();
  server.close(() => process.exit(0));
  if (typeof server.closeAllConnections === "function") server.closeAllConnections();
  const deadline = setTimeout(() => process.exit(0), 1000);
  deadline.unref();
}
process.once("disconnect", shutdown);
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
server.on("error", (error) => {
  if (error && error.code === "EADDRINUSE" && port !== 0) {
    server.listen(0, host, () => announce(server.address().port));
    return;
  }
  if (typeof process.send === "function") process.send({ type: "error", error: error.message });
  else process.exit(1);
});
server.listen(port, host, () => announce(server.address().port));
`;

export interface OfficialCliRelayChildSupervisor {
  readonly listening: Promise<number>;
  readonly exited: Promise<void>;
  stop(): Promise<void>;
}

export function superviseOfficialCliRelayChild(
  child: ChildProcess,
  startupTimeoutMs = OFFICIAL_CLI_RELAY_START_TIMEOUT_MS,
): OfficialCliRelayChildSupervisor {
  if (!Number.isFinite(startupTimeoutMs) || startupTimeoutMs <= 0) {
    throw new RangeError("Official CLI relay startup timeout must be positive and finite.");
  }

  const { promise: exited, resolve: resolveExited } = Promise.withResolvers<void>();
  let exitSettled = false;
  const finishExit = (): void => {
    if (exitSettled) return;
    exitSettled = true;
    child.off("exit", finishExit);
    child.off("close", finishExit);
    resolveExited();
  };
  child.once("exit", finishExit);
  child.once("close", finishExit);
  if (child.exitCode != null || child.signalCode != null) queueMicrotask(finishExit);

  let stopPromise: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    if (stopPromise != null) return stopPromise;
    stopPromise = (async () => {
      if (child.pid == null || child.exitCode != null || child.signalCode != null) return;
      try { child.kill("SIGTERM"); } catch {}
      const stoppedGracefully = await Promise.race([
        exited.then(() => true),
        wait(1_000, false, { ref: false }),
      ]);
      if (stoppedGracefully || child.exitCode != null || child.signalCode != null) return;
      try { child.kill("SIGKILL"); } catch {}
      await Promise.race([exited, wait(1_000, undefined, { ref: false })]);
      if (!exitSettled && child.exitCode == null && child.signalCode == null) {
        throw new Error(`Official CLI relay child survived SIGKILL (pid ${child.pid}).`);
      }
    })();
    return stopPromise;
  };

  const {
    promise: listening,
    resolve: resolveListening,
    reject: rejectListening,
  } = Promise.withResolvers<number>();
  let startupSettled = false;
  let startupTimer: NodeJS.Timeout | undefined;
  const cleanupStartup = (): void => {
    clearTimeout(startupTimer);
    child.off("message", onMessage);
    child.off("exit", onExit);
  };
  const failStartup = (error: Error): void => {
    if (startupSettled) return;
    startupSettled = true;
    cleanupStartup();
    void stop().then(
      () => rejectListening(error),
      (stopError: unknown) => rejectListening(new Error(`${error.message} ${stopError instanceof Error ? stopError.message : String(stopError)}`)),
    );
  };
  const onMessage = (message: unknown): void => {
    if (typeof message !== "object" || message == null) return;
    const type = Reflect.get(message, "type");
    if (type === "error") {
      const detail = Reflect.get(message, "error");
      failStartup(new Error(typeof detail === "string" && detail.length > 0 ? detail : "Official CLI relay failed to listen."));
      return;
    }
    if (type !== "listening") return;
    const boundPort = Reflect.get(message, "port");
    if (typeof boundPort !== "number" || !Number.isInteger(boundPort) || boundPort <= 0 || boundPort > 65_535) {
      failStartup(new Error("Official CLI relay returned an invalid listening port."));
      return;
    }
    if (startupSettled) return;
    startupSettled = true;
    cleanupStartup();
    resolveListening(boundPort);
  };
  const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    const detail = code != null ? `code ${code}` : signal != null ? `signal ${signal}` : "unknown status";
    failStartup(new Error(`Official CLI relay child exited before listening (${detail}).`));
  };
  const onError = (error: Error): void => {
    failStartup(new Error(`Official CLI relay child failed before listening: ${error.message}`));
  };

  child.on("message", onMessage);
  child.once("exit", onExit);
  child.on("error", onError);
  void exited.then(() => child.off("error", onError));
  startupTimer = setTimeout(() => {
    failStartup(new Error(`Official CLI relay child did not report listening within ${startupTimeoutMs}ms.`));
  }, startupTimeoutMs);
  if (child.exitCode != null || child.signalCode != null) queueMicrotask(() => onExit(child.exitCode, child.signalCode));

  return { listening, exited, stop };
}

export async function startOfficialCliLoopbackRelay(
  options: OfficialCliLoopbackRelayOptions,
): Promise<OfficialCliLoopbackRelay> {
  const token = options.token ?? randomBytes(32).toString("hex");
  if (token.length === 0) throw new Error("Official CLI relay token must not be empty.");
  const pid = options.pid ?? process.pid;
  const startedAt = options.startedAt ?? Date.now();
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? OFFICIAL_CLI_RELAY_PORT;
  const discoveryPath = options.discoveryPath ?? getGatewayDiscoveryPath();
  const extraDiscoveryPaths = options.discoveryPath == null
    ? [...new Set([join(getSandProductionRootDir(), "gateway.json")].filter((path) => path !== discoveryPath))]
    : [];

  const resolveTimeoutMs = options.resolveTimeoutMs ?? OFFICIAL_CLI_RELAY_RESOLVE_TIMEOUT_MS;
  const child: ChildProcess = spawn(process.execPath, ["--eval", RELAY_CHILD_SOURCE], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      GROK_BOT_OFFICIAL_RELAY_TOKEN: token,
      GROK_BOT_OFFICIAL_RELAY_PORT: String(port),
      GROK_BOT_OFFICIAL_RELAY_HOST: host,
      GROK_BOT_OFFICIAL_RELAY_PID: String(pid),
      GROK_BOT_OFFICIAL_RELAY_STARTED_AT: String(startedAt),
      GROK_BOT_OFFICIAL_RELAY_RESOLVE_TIMEOUT_MS: String(resolveTimeoutMs),
    },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  const supervisor = superviseOfficialCliRelayChild(child);
  const boundPort = await supervisor.listening;
  child.on("message", (message: { readonly type?: string; readonly id?: number; readonly error?: string }) => {
    if (message.type !== "resolve") return;
    void options.resolveConnection().then(
      (connection) => child.send({ id: message.id, connection }),
      (error: unknown) => child.send({
        id: message.id,
        error: error instanceof Error ? error.message : "official remote gateway is unavailable",
      }),
    );
  });

  const discovery = {
    port: boundPort,
    pid,
    startedAt,
    scheme: "http" as const,
    host,
    token,
    target: OFFICIAL_CLI_RELAY_TARGET,
  };
  const publishDiscovery = (): void => {
    writeGatewayDiscoverySync(discovery, discoveryPath);
    for (const extraPath of extraDiscoveryPaths) {
      writeGatewayDiscoverySync(discovery, extraPath);
    }
  };
  console.log(`[sand] official CLI relay listening on http://${host}:${boundPort} (auth required; discovery unpublished until official connect)`);
  let disposePromise: Promise<void> | undefined;
  const dispose = (): Promise<void> => {
    if (disposePromise != null) return disposePromise;
    disposePromise = (async () => {
      let stopError: unknown;
      try {
        await supervisor.stop();
      } catch (error) {
        stopError = error;
      }
      try {
        const stored = JSON.parse(await readFile(discoveryPath, "utf8")) as unknown;
        if (discoveryOwnsRelay(stored, { pid, port: boundPort, startedAt })) {
          await clearGatewayDiscovery(discoveryPath);
        }
        for (const extraPath of extraDiscoveryPaths) {
          try {
            const extra = JSON.parse(await readFile(extraPath, "utf8")) as unknown;
            if (discoveryOwnsRelay(extra, { pid, port: boundPort, startedAt })) {
              await clearGatewayDiscovery(extraPath);
            }
          } catch {}
        }
      } catch {}
      if (stopError !== undefined) throw stopError;
    })();
    return disposePromise;
  };

  return {
    port: boundPort,
    token,
    startedAt,
    pid,
    discoveryPath,
    baseUrl: `http://${host}:${boundPort}`,
    publishConnection(connection: GatewayConnection) {
      if (isLoopbackGatewayUrl(connection.baseUrl)) return;
      if (child.connected) child.send({ type: "connection", connection });
      publishDiscovery();
    },
    dispose,
  };
}
export function wrapRemoteHostConnectorWithOfficialCliRelay<T extends OfficialCliRelayRemoteHostConnector>(
  connector: T,
  options: OfficialCliRelayConnectorOptions = {},
): T {
  const { onRelayReady, registerShutdown, reportFailure, ...relayOptions } = options;
  const report = reportFailure ?? ((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[sand] official CLI relay failed: ${message}`);
  });
  let relayPromise: Promise<OfficialCliLoopbackRelay> | undefined;
  const ensureRelay = (): Promise<OfficialCliLoopbackRelay> => {
    if (relayPromise != null) return relayPromise;
    const starting = startOfficialCliLoopbackRelay({
      ...relayOptions,
      resolveConnection: () => connector.connect(),
    });
    relayPromise = starting;
    void starting.then(
      (relay) => {
        registerShutdown?.(() => relay.dispose());
        onRelayReady?.(relay);
      },
      (error: unknown) => {
        if (relayPromise === starting) relayPromise = undefined;
        report(error);
      },
    );
    return starting;
  };

  return {
    ...connector,
    async connect() {
      const connection = await connector.connect();
      void ensureRelay().then(
        (relay) => relay.publishConnection(connection),
        () => {},
      );
      return connection;
    },
    ...(connector.recreate == null ? {} : { recreate: connector.recreate.bind(connector) }),
    ...(connector.forceRecreate == null ? {} : { forceRecreate: connector.forceRecreate.bind(connector) }),
    ...(connector.issueLocalExecDaemonCredential == null
      ? {}
      : { issueLocalExecDaemonCredential: connector.issueLocalExecDaemonCredential.bind(connector) }),
  } as T;
}
