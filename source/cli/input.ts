import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";

import { Effect } from "effect";

import { CliInputError } from "./model.js";

export interface JsonInputOptions {
  readonly json?: string;
  readonly file?: string;
  readonly stdin: boolean;
}

const MAX_STDIN_BYTES = 64 * 1024 * 1024;
const JSON_FILE_READ_CHUNK_BYTES = 64 * 1024;

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function readJsonFile(path: string, signal: AbortSignal): Promise<string> {
  // O_NONBLOCK prevents a FIFO/device substituted for an explicit --file from
  // hanging startup. O_NOFOLLOW plus descriptor fstat closes the stat/read
  // swap and symlink boundaries before any content is materialized.
  const noFollowFlag = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  let fallbackEntry: Stats | undefined;
  if (noFollowFlag === 0) {
    fallbackEntry = await lstat(path);
    if (!fallbackEntry.isFile()) throw new Error("JSON input source must be a regular file");
  }
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | noFollowFlag);
  try {
    if (signal.aborted) throw new Error("file read was interrupted");
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("JSON input source must be a regular file");
    if (info.size > MAX_STDIN_BYTES) throw new Error(`file exceeds ${MAX_STDIN_BYTES} bytes`);
    if (fallbackEntry !== undefined) {
      const currentEntry = await lstat(path);
      if (!currentEntry.isFile()
        || !sameFileIdentity(fallbackEntry, currentEntry)
        || !sameFileIdentity(currentEntry, info)) {
        throw new Error("JSON input path changed while it was being opened");
      }
    }

    let storage = Buffer.allocUnsafe(16 * 1024);
    let size = 0;
    while (true) {
      if (signal.aborted) throw new Error("file read was interrupted");
      if (size === MAX_STDIN_BYTES) {
        const probe = Buffer.allocUnsafe(1);
        const { bytesRead } = await handle.read(probe, 0, 1, null);
        if (bytesRead > 0) throw new Error(`file exceeds ${MAX_STDIN_BYTES} bytes`);
        break;
      }
      const desired = Math.min(JSON_FILE_READ_CHUNK_BYTES, MAX_STDIN_BYTES - size);
      if (size + desired > storage.byteLength) {
        const capacity = Math.min(
          MAX_STDIN_BYTES,
          Math.max(size + desired, storage.byteLength * 2),
        );
        const grown = Buffer.allocUnsafe(capacity);
        storage.copy(grown, 0, 0, size);
        storage = grown;
      }
      const { bytesRead } = await handle.read(storage, size, desired, null);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (signal.aborted) throw new Error("file read was interrupted");
    return storage.subarray(0, size).toString("utf8");
  } finally {
    await handle.close();
  }
}

export function readStdinText(): Effect.Effect<string, CliInputError> {
  return Effect.tryPromise({
    try: async (signal) => {
      let storage = Buffer.allocUnsafe(16 * 1024);
      let size = 0;
      const onAbort = () => process.stdin.destroy();
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        for await (const chunk of process.stdin) {
          if (signal.aborted) throw new Error("stdin read was interrupted");
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          const nextSize = size + bytes.byteLength;
          if (nextSize > MAX_STDIN_BYTES) throw new Error(`stdin exceeds ${MAX_STDIN_BYTES} bytes`);
          if (nextSize > storage.byteLength) {
            const grown = Buffer.allocUnsafe(Math.min(
              MAX_STDIN_BYTES,
              Math.max(nextSize, storage.byteLength * 2),
            ));
            storage.copy(grown, 0, 0, size);
            storage = grown;
          }
          bytes.copy(storage, size);
          size = nextSize;
        }
        if (signal.aborted) throw new Error("stdin read was interrupted");
        return storage.subarray(0, size).toString("utf8");
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },
    catch: (error) => new CliInputError({
      code: "INVALID_INPUT",
      message: `Unable to read stdin: ${error instanceof Error ? error.message : String(error)}`,
    }),
  });
}

function parseJson(text: string, source: string): Effect.Effect<unknown, CliInputError> {
  return Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: () => new CliInputError({
      code: "INVALID_INPUT",
      message: `Invalid JSON from ${source}.`,
    }),
  });
}

export function readJsonInput(options: JsonInputOptions): Effect.Effect<unknown, CliInputError> {
  const sources = [options.json === undefined ? null : "--json", options.file === undefined ? null : "--file", options.stdin ? "--stdin" : null]
    .filter((source): source is string => source != null);
  if (sources.length > 1) {
    return Effect.fail(new CliInputError({
      code: "INVALID_INPUT",
      message: `Choose one JSON input source, not ${sources.join(" and ")}.`,
    }));
  }
  if (options.json !== undefined) return parseJson(options.json, "--json");
  if (options.file !== undefined) {
    return Effect.tryPromise({
      try: (signal) => readJsonFile(options.file!, signal),
      catch: (error) => new CliInputError({
        code: "INVALID_INPUT",
        message: `Unable to read ${options.file}: ${error instanceof Error ? error.message : String(error)}`,
      }),
    }).pipe(Effect.flatMap((text) => parseJson(text, options.file!)));
  }
  if (options.stdin) {
    return readStdinText().pipe(
      Effect.flatMap((text) => text.trim().length === 0 ? Effect.succeed({}) : parseJson(text, "stdin")),
    );
  }
  return Effect.succeed({});
}

export function requireJsonObject(value: unknown): Effect.Effect<Readonly<Record<string, unknown>>, CliInputError> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Effect.succeed(value as Readonly<Record<string, unknown>>)
    : Effect.fail(new CliInputError({ code: "INVALID_INPUT", message: "Gateway arguments must be a JSON object." }));
}
