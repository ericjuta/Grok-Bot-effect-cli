import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { lstat, open, realpath, stat, type FileHandle } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { reanchorSandPath } from "../host-paths.js";

export const CANONICAL_AVATAR_FILENAME = "avatar.png";
export const CONVENTIONAL_AVATAR_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "svg"] as const;
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
export const AVATAR_DATA_URL_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const AVATAR_DATA_URL_CACHE_MAX_ENTRIES = 128;
const AVATAR_SNIFF_BYTES = 1024;
const AVATAR_HASH_CHUNK_BYTES = 64 * 1024;
const CONVENTIONAL_AVATAR_RE = new RegExp(`^avatar\\.(${CONVENTIONAL_AVATAR_EXTENSIONS.join("|")})$`, "i");

export function isConventionalAvatarFilename(name: string): boolean {
  return CONVENTIONAL_AVATAR_RE.test(name);
}

export function conventionalAvatarRank(name: string): number {
  if (name === CANONICAL_AVATAR_FILENAME) return -1;
  const rank = CONVENTIONAL_AVATAR_EXTENSIONS.indexOf(
    extname(name).slice(1).toLowerCase() as typeof CONVENTIONAL_AVATAR_EXTENSIONS[number],
  );
  return rank === -1 ? CONVENTIONAL_AVATAR_EXTENSIONS.length : rank;
}

export function listConventionalAvatarFilenames(agentDir: string): string[] {
  try {
    return readdirSync(agentDir)
      .filter(isConventionalAvatarFilename)
      .sort((a, b) => conventionalAvatarRank(a) - conventionalAvatarRank(b) || a.localeCompare(b));
  } catch {
    return [];
  }
}

export function sniffAvatarMimeType(bytes: Uint8Array): string | null {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.toString("latin1", 0, 6))) return "image/gif";
  if (bytes.length >= 12 && buffer.toString("latin1", 0, 4) === "RIFF" && buffer.toString("latin1", 8, 12) === "WEBP") {
    return "image/webp";
  }
  const head = buffer
    .toString("utf8", 0, Math.min(bytes.length, AVATAR_SNIFF_BYTES))
    .replace(/^\uFEFF/, "")
    .trimStart()
    .toLowerCase();
  return head.startsWith("<") && head.includes("<svg") ? "image/svg+xml" : null;
}

function isPathWithin(dir: string, target: string): boolean {
  const rel = relative(dir, target);
  return rel.length > 0 && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function resolveAvatarPathWithinDir(agentDir: string, candidate: string | null | undefined): string | null {
  const absolute = resolveAvatarCandidatePath(agentDir, candidate);
  if (absolute == null) return null;
  try {
    const file = realpathSync(absolute);
    return isPathWithin(realpathSync(agentDir), file) ? file : null;
  } catch {
    return null;
  }
}

function resolveAvatarCandidatePath(agentDir: string, candidate: string | null | undefined): string | null {
  const trimmed = candidate?.trim();
  if (!trimmed) return null;
  const anchored = isAbsolute(trimmed) ? reanchorSandPath(trimmed) : trimmed;
  const absolute = isAbsolute(anchored) ? anchored : resolve(agentDir, anchored);
  if (!isPathWithin(agentDir, absolute)) return null;
  return absolute;
}

function readAvatarHeaderSync(fileDescriptor: number, size: number): Buffer | null {
  const length = Math.min(size, AVATAR_SNIFF_BYTES);
  const header = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const bytesRead = readSync(fileDescriptor, header, offset, length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return offset === 0 ? null : header.subarray(0, offset);
}

function sameFileIdentity(left: { readonly dev: number | bigint; readonly ino: number | bigint }, right: { readonly dev: number | bigint; readonly ino: number | bigint }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function copyAvatarDescriptorSync(source: number, sourceInfo: ReturnType<typeof fstatSync>, target: string): void {
  const sourceSize = Number(sourceInfo.size);
  if (!Number.isSafeInteger(sourceSize) || sourceSize <= 0 || sourceSize > AVATAR_MAX_BYTES) {
    throw new Error("Legacy avatar has an invalid size.");
  }
  let targetDescriptor: number | undefined;
  let created = false;
  let complete = false;
  try {
    targetDescriptor = openSync(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    created = true;
    const chunk = Buffer.allocUnsafe(Math.min(AVATAR_HASH_CHUNK_BYTES, sourceSize));
    let offset = 0;
    while (offset < sourceSize) {
      const bytesRead = readSync(source, chunk, 0, Math.min(chunk.length, sourceSize - offset), offset);
      if (bytesRead === 0) throw new Error("Legacy avatar changed while it was copied.");
      let written = 0;
      while (written < bytesRead) {
        const count = writeSync(targetDescriptor, chunk, written, bytesRead - written, offset + written);
        if (count === 0) throw new Error("Legacy avatar copy made no progress.");
        written += count;
      }
      offset += bytesRead;
    }
    const finalSource = fstatSync(source);
    const finalTarget = fstatSync(targetDescriptor);
    if (!sameFileIdentity(sourceInfo, finalSource)
      || finalSource.size !== sourceInfo.size
      || finalSource.mtimeMs !== sourceInfo.mtimeMs
      || !finalTarget.isFile()
      || Number(finalTarget.size) !== sourceSize) {
      throw new Error("Legacy avatar changed while it was copied.");
    }
    complete = true;
  } finally {
    if (targetDescriptor != null) {
      try { closeSync(targetDescriptor); } catch {}
    }
    if (created && !complete) {
      try { unlinkSync(target); } catch {}
    }
  }
}

/**
 * Migrates a legacy avatar path to a conventional filename. Legacy files are
 * size-checked through an open descriptor before any content is read, and
 * content sniffing is limited to the same fixed header used by the MIME sniffer.
 */
export function resolveDerivedAvatarFilename(agentDir: string, legacyFieldValue: string | null): string | null {
  const conventional = listConventionalAvatarFilenames(agentDir);
  if (conventional[0] != null) return conventional[0];
  const candidatePath = resolveAvatarCandidatePath(agentDir, legacyFieldValue);
  if (candidatePath == null) return null;
  try {
    if (lstatSync(candidatePath).isSymbolicLink()) return legacyFieldValue;
  } catch {
    return null;
  }
  const source = resolveAvatarPathWithinDir(agentDir, legacyFieldValue);
  if (source == null) return null;

  let fileDescriptor: number | undefined;
  try {
    const expected = statSync(source);
    fileDescriptor = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(fileDescriptor);
    if (!info.isFile() || !sameFileIdentity(expected, info)) return legacyFieldValue;
    if (info.size <= 0 || info.size > AVATAR_MAX_BYTES) return legacyFieldValue;

    const sourceExt = extname(source).slice(1).toLowerCase();
    const mimeExt: Record<string, string> = {
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/webp": "webp",
      "image/gif": "gif",
      "image/svg+xml": "svg",
    };
    const extension = CONVENTIONAL_AVATAR_EXTENSIONS.includes(sourceExt as never)
      ? sourceExt
      : mimeExt[sniffAvatarMimeType(readAvatarHeaderSync(fileDescriptor, info.size) ?? new Uint8Array()) ?? ""];
    if (extension == null) return legacyFieldValue;

    const name = `avatar.${extension}`;
    copyAvatarDescriptorSync(fileDescriptor, info, join(agentDir, name));
    return name;
  } catch {
    return legacyFieldValue;
  } finally {
    if (fileDescriptor != null) {
      try {
        closeSync(fileDescriptor);
      } catch {
        // The operation already has its result; a close failure is not actionable here.
      }
    }
  }
}

interface AvatarStat {
  readonly path: string;
  readonly mtimeMs: number;
  readonly size: number;
}

interface OpenBoundedAvatar extends AvatarStat {
  readonly handle: FileHandle;
}

async function resolveAndStatAvatar(agentDir: string, candidate: string): Promise<AvatarStat | null> {
  const opened = await openBoundedAvatar(agentDir, candidate);
  if (opened == null) return null;
  try {
    return { path: opened.path, mtimeMs: opened.mtimeMs, size: opened.size };
  } catch {
    return null;
  } finally {
    try { await opened.handle.close(); } catch {}
  }
}

async function openBoundedAvatar(agentDir: string, candidate: string): Promise<OpenBoundedAvatar | null> {
  const candidatePath = resolveAvatarCandidatePath(agentDir, candidate);
  if (candidatePath == null) return null;
  let handle: FileHandle | undefined;
  try {
    const candidateInfo = await lstat(candidatePath);
    if (candidateInfo.isSymbolicLink()) return null;
    const [path, root] = await Promise.all([realpath(candidatePath), realpath(agentDir)]);
    if (!isPathWithin(root, path)) return null;
    const expected = await stat(path);
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || !sameFileIdentity(expected, info) || info.size <= 0 || info.size > AVATAR_MAX_BYTES) {
      await handle.close();
      return null;
    }
    return { handle, path, mtimeMs: info.mtimeMs, size: info.size };
  } catch {
    if (handle != null) {
      try {
        await handle.close();
      } catch {
        // Ignore cleanup errors on an already-failed read.
      }
    }
    return null;
  }
}

async function readBoundedAvatarBytes(opened: OpenBoundedAvatar): Promise<{
  bytes: Buffer;
  mtimeMs: number;
  size: number;
} | null> {
  const bytes = Buffer.allocUnsafe(opened.size);
  let offset = 0;
  while (offset < opened.size) {
    const result = await opened.handle.read(bytes, offset, opened.size - offset, offset);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  const finalInfo = await opened.handle.stat();
  if (!finalInfo.isFile() || offset <= 0 || finalInfo.size !== offset || finalInfo.size > AVATAR_MAX_BYTES) {
    return null;
  }
  return {
    bytes: offset === bytes.length ? bytes : bytes.subarray(0, offset),
    mtimeMs: finalInfo.mtimeMs,
    size: offset,
  };
}

async function readBoundedAvatarFile(agentDir: string, candidate: string): Promise<{
  bytes: Buffer;
  mime: string;
  path: string;
  mtimeMs: number;
  size: number;
} | null> {
  const opened = await openBoundedAvatar(agentDir, candidate);
  if (opened == null) return null;
  try {
    const result = await readBoundedAvatarBytes(opened);
    if (result == null) return null;
    const mime = sniffAvatarMimeType(result.bytes);
    return mime == null ? null : { path: opened.path, mime, ...result };
  } catch {
    return null;
  } finally {
    try {
      await opened.handle.close();
    } catch {
      // A completed read remains valid if descriptor cleanup reports an error.
    }
  }
}

export interface AvatarMetadata {
  readonly version: string;
  readonly contentType: string;
  readonly byteCount: number;
}

/**
 * Reads only fixed-size chunks while hashing avatar metadata. No complete byte
 * buffer, base64 value, or data URL is created or inserted into the avatar cache.
 */
export async function readAvatarMetadataWithinDir(
  agentDir: string,
  candidate: string,
): Promise<AvatarMetadata | null> {
  const opened = await openBoundedAvatar(agentDir, candidate);
  if (opened == null) return null;
  try {
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(Math.min(AVATAR_HASH_CHUNK_BYTES, opened.size));
    const header = Buffer.allocUnsafe(Math.min(AVATAR_SNIFF_BYTES, opened.size));
    let offset = 0;
    let headerLength = 0;
    while (offset < opened.size) {
      const length = Math.min(chunk.length, opened.size - offset);
      const result = await opened.handle.read(chunk, 0, length, offset);
      if (result.bytesRead === 0) break;
      const bytes = chunk.subarray(0, result.bytesRead);
      hash.update(bytes);
      if (headerLength < header.length) {
        const copyLength = Math.min(bytes.length, header.length - headerLength);
        bytes.copy(header, headerLength, 0, copyLength);
        headerLength += copyLength;
      }
      offset += result.bytesRead;
    }
    const finalInfo = await opened.handle.stat();
    if (!finalInfo.isFile() || offset <= 0 || finalInfo.size !== offset || finalInfo.size > AVATAR_MAX_BYTES) {
      return null;
    }
    const contentType = sniffAvatarMimeType(header.subarray(0, headerLength));
    if (contentType == null) return null;
    return {
      version: hash.digest("hex").slice(0, 16),
      contentType,
      byteCount: offset,
    };
  } catch {
    return null;
  } finally {
    try {
      await opened.handle.close();
    } catch {
      // A completed metadata result remains valid after a close error.
    }
  }
}

export async function readValidatedAvatar(
  agentDir: string,
  candidate: string,
): Promise<{ bytes: Buffer; mime: string } | null> {
  const avatar = await readBoundedAvatarFile(agentDir, candidate);
  return avatar == null ? null : { bytes: avatar.bytes, mime: avatar.mime };
}

export async function readAvatarBytesWithinDir(agentDir: string, candidate: string): Promise<Buffer | null> {
  return (await readValidatedAvatar(agentDir, candidate))?.bytes ?? null;
}

interface AvatarDataUrlCacheEntry {
  readonly fingerprint: string;
  readonly dataUrl: string;
  readonly version: string;
  readonly encodedBytes: number;
}

const avatarDataUrlCache = new Map<string, AvatarDataUrlCacheEntry>();
let avatarDataUrlCacheBytes = 0;

function deleteAvatarDataUrlCacheEntry(key: string): void {
  const existing = avatarDataUrlCache.get(key);
  if (existing == null) return;
  avatarDataUrlCache.delete(key);
  avatarDataUrlCacheBytes = Math.max(0, avatarDataUrlCacheBytes - existing.encodedBytes);
}

function cacheAvatarDataUrl(key: string, entry: AvatarDataUrlCacheEntry): void {
  deleteAvatarDataUrlCacheEntry(key);
  avatarDataUrlCache.set(key, entry);
  avatarDataUrlCacheBytes += entry.encodedBytes;
  while (
    avatarDataUrlCache.size > AVATAR_DATA_URL_CACHE_MAX_ENTRIES ||
    avatarDataUrlCacheBytes > AVATAR_DATA_URL_CACHE_MAX_BYTES
  ) {
    const oldest = avatarDataUrlCache.keys().next().value;
    if (oldest == null) break;
    deleteAvatarDataUrlCacheEntry(oldest);
  }
}

export interface AvatarDataUrlCacheUsage {
  readonly entries: number;
  readonly encodedBytes: number;
  readonly maxEntries: number;
  readonly maxEncodedBytes: number;
}

export function getAvatarDataUrlCacheUsage(): AvatarDataUrlCacheUsage {
  return {
    entries: avatarDataUrlCache.size,
    encodedBytes: avatarDataUrlCacheBytes,
    maxEntries: AVATAR_DATA_URL_CACHE_MAX_ENTRIES,
    maxEncodedBytes: AVATAR_DATA_URL_CACHE_MAX_BYTES,
  };
}

export async function readAvatarWithinDir(
  agentDir: string,
  candidate: string,
): Promise<{ dataUrl: string; version: string } | null> {
  const initialMeta = await resolveAndStatAvatar(agentDir, candidate);
  if (initialMeta == null) return null;
  const initialKey = `${agentDir}\0${initialMeta.path}`;
  const initialFingerprint = `${initialMeta.mtimeMs}:${initialMeta.size}`;
  const initialCached = avatarDataUrlCache.get(initialKey);
  if (initialCached?.fingerprint === initialFingerprint) {
    avatarDataUrlCache.delete(initialKey);
    avatarDataUrlCache.set(initialKey, initialCached);
    return { dataUrl: initialCached.dataUrl, version: initialCached.version };
  }
  if (initialCached != null) deleteAvatarDataUrlCacheEntry(initialKey);

  const avatar = await readBoundedAvatarFile(agentDir, candidate);
  if (avatar == null) return null;
  const key = `${agentDir}\0${avatar.path}`;
  const fingerprint = `${avatar.mtimeMs}:${avatar.size}`;
  const cached = avatarDataUrlCache.get(key);
  if (cached?.fingerprint === fingerprint) {
    avatarDataUrlCache.delete(key);
    avatarDataUrlCache.set(key, cached);
    return { dataUrl: cached.dataUrl, version: cached.version };
  }
  if (cached != null) deleteAvatarDataUrlCacheEntry(key);

  const dataUrl = `data:${avatar.mime};base64,${avatar.bytes.toString("base64")}`;
  const value: AvatarDataUrlCacheEntry = {
    fingerprint,
    dataUrl,
    version: createHash("sha256").update(avatar.bytes).digest("hex").slice(0, 16),
    encodedBytes: Buffer.byteLength(dataUrl, "utf8"),
  };
  cacheAvatarDataUrl(key, value);
  return { dataUrl: value.dataUrl, version: value.version };
}

export function invalidateAvatarDataUrlCache(agentDir: string): void {
  const prefix = `${agentDir}\0`;
  for (const key of avatarDataUrlCache.keys()) {
    if (key.startsWith(prefix)) deleteAvatarDataUrlCacheEntry(key);
  }
}
