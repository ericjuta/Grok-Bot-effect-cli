import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { getGatewayDiscoveryPath } from "./host-paths.js";

export interface GatewayDiscoveryInfo {
  readonly port: number;
  readonly pid: number;
  readonly startedAt: number;
  readonly scheme?: "http" | "https";
  readonly host?: string;
  readonly token?: string;
}

export function isGatewayDiscoveryInfo(value: unknown): value is GatewayDiscoveryInfo {
  if (typeof value !== "object" || value == null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.port === "number"
    && Number.isInteger(candidate.port)
    && candidate.port > 0
    && typeof candidate.pid === "number"
    && Number.isInteger(candidate.pid)
    && candidate.pid > 0
    && typeof candidate.startedAt === "number"
    && (candidate.scheme === undefined || candidate.scheme === "http" || candidate.scheme === "https")
    && (candidate.host === undefined || typeof candidate.host === "string")
    && (candidate.token === undefined || typeof candidate.token === "string");
}

export async function writeGatewayDiscovery(info: GatewayDiscoveryInfo, path?: string): Promise<void> {
  if (!isGatewayDiscoveryInfo(info)) throw new TypeError("invalid gateway discovery info");

  const usesDefaultPath = path === undefined;
  const discoveryPath = path ?? getGatewayDiscoveryPath();
  const parent = dirname(discoveryPath);
  await mkdir(parent, { recursive: true, mode: 0o700 });

  // The default parent is Grok Bot's dedicated data directory, so it is safe
  // to repair an existing permissive mode. An explicit custom parent can be a
  // user-owned shared directory and must not be chmodded behind their back.
  if (usesDefaultPath) await chmod(parent, 0o700);

  const temporary = join(
    parent,
    `.${basename(discoveryPath)}.${process.pid}.${randomUUID()}.tmp`
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    // wx prevents following or truncating a pre-existing path. chmod after
    // creation also makes the promised mode independent of the process umask.
    handle = await open(temporary, "wx", 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(JSON.stringify(info, null, 2), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, discoveryPath);
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true });
  }
}

export async function clearGatewayDiscovery(path = getGatewayDiscoveryPath()): Promise<void> {
  await rm(path, { force: true });
}
