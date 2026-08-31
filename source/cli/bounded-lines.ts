export interface BoundedLine {
  readonly lineNumber: number;
  readonly bytes?: Uint8Array;
  readonly oversized: boolean;
}

/**
 * Read newline-delimited protocol frames without ever retaining more than the
 * configured number of bytes for one line. Once a line crosses the bound, its
 * remaining bytes are discarded through the next newline and one oversized
 * marker is yielded. This keeps a malformed stdio peer from turning a framing
 * limit into an unbounded allocation before validation runs.
 */
export async function* readBoundedLines(
  input: NodeJS.ReadableStream,
  maxLineBytes: number,
): AsyncGenerator<BoundedLine> {
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes <= 0) {
    throw new RangeError("maxLineBytes must be a positive safe integer.");
  }
  // Large media-capable MCP frames are exceptional. Grow geometrically so an
  // idle stdio server does not reserve its entire (currently 40 MiB) frame
  // allowance before it has received a byte.
  let storage = Buffer.allocUnsafe(Math.min(maxLineBytes, 64 * 1024));
  let size = 0;
  let oversized = false;
  let trailingCr = false;
  let lineNumber = 0;

  const appendByte = (byte: number) => {
    if (oversized) return;
    if (size >= maxLineBytes) {
      size = 0;
      oversized = true;
      return;
    }
    if (size >= storage.byteLength) {
      const grown = Buffer.allocUnsafe(Math.min(maxLineBytes, Math.max(1, storage.byteLength * 2)));
      storage.copy(grown, 0, 0, size);
      storage = grown;
    }
    storage[size] = byte;
    size += 1;
  };

  const finish = (): BoundedLine => {
    lineNumber += 1;
    if (oversized) return { lineNumber, oversized: true };
    return { lineNumber, bytes: Buffer.from(storage.subarray(0, size)), oversized: false };
  };

  const reset = () => {
    size = 0;
    oversized = false;
    trailingCr = false;
  };

  for await (const raw of input) {
    const chunk = raw instanceof Uint8Array
      ? raw
      : Buffer.from(typeof raw === "string" ? raw : String(raw));
    for (let index = 0; index < chunk.byteLength; index += 1) {
      const byte = chunk[index]!;
      if (byte === 10) {
        // A CR immediately before LF is framing, not line content. Deferring a
        // possible CR keeps an exactly-max-sized CRLF frame within the limit,
        // including when the CR and LF arrive in different chunks.
        yield finish();
        reset();
        continue;
      }
      if (trailingCr) appendByte(13);
      trailingCr = byte === 13;
      if (!trailingCr) appendByte(byte);
    }
  }

  // Preserve the prior framing behavior that strips a final CR even when EOF
  // arrives before LF, while still yielding that final (possibly empty) line.
  if (oversized || size > 0 || trailingCr) yield finish();
}
