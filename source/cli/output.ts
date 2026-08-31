import { randomUUID } from "node:crypto";

import { Context, Effect, Layer } from "effect";

import {
  CLI_PROTOCOL,
  errorBody,
  type CliRuntimeConfig,
  type ErrorEnvelope,
  type EventEnvelope,
  type ResultEnvelope,
} from "./model.js";

export interface CliOutputService {
  readonly requestId: string;
  readonly result: (command: string, data: unknown, meta?: Readonly<Record<string, unknown>>) => Effect.Effect<void, Error>;
  readonly failure: (command: string, error: unknown) => Effect.Effect<void, Error>;
  readonly envelope: (value: ResultEnvelope | ErrorEnvelope | EventEnvelope | Readonly<Record<string, unknown>>) => Effect.Effect<void, Error>;
  readonly diagnostic: (message: string) => Effect.Effect<void, Error>;
}

export const CliOutput = Context.GenericTag<CliOutputService>("@grok-effect-cli/Output");

export function jsonStringify(value: unknown, pretty = false): string {
  const encoded = JSON.stringify(value, (_key, item) => {
    if (typeof item === "bigint") return item.toString();
    if (item instanceof Uint8Array) return { encoding: "base64", data: Buffer.from(item).toString("base64") };
    if (item instanceof Error) return { name: item.name, message: item.message };
    return item;
  }, pretty ? 2 : undefined);
  return encoded ?? "null";
}

function safeEnvelopeRequestId(value: string | undefined): string {
  if (value === undefined || Buffer.byteLength(value, "utf8") > 256) return randomUUID();
  try {
    const probe = new Headers();
    probe.set("x-sand-request-id", value);
    return value;
  } catch {
    // The same value will be rejected by the gateway's typed header boundary.
    // Do not reflect a malformed correlation value in an error envelope.
    return randomUUID();
  }
}

function makeWriter(stream: NodeJS.WriteStream): (value: string) => Effect.Effect<void, Error> {
  let tail = Promise.resolve();
  let terminalError: Error | undefined;
  let rejectActive: ((error: Error) => void) | undefined;
  // Keep one permanent listener so an EPIPE event arriving after the write
  // callback cannot become an uncaught process-level error.
  stream.on("error", (error) => {
    terminalError = error;
    rejectActive?.(error);
  });
  return (value) => Effect.tryPromise({
    try: () => {
      const line = value.endsWith("\n") ? value : `${value}\n`;
      const write = () => new Promise<void>((resolve, reject) => {
        if (terminalError !== undefined) {
          reject(terminalError);
          return;
        }
        let settled = false;
        const finish = (error?: Error | null) => {
          if (settled) return;
          settled = true;
          rejectActive = undefined;
          if (error == null) resolve();
          else reject(error);
        };
        rejectActive = (error) => finish(error);
        try {
          stream.write(line, finish);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
      const next = tail.then(write, write);
      tail = next.catch(() => undefined);
      return next;
    },
    catch: (error) => error instanceof Error ? error : new Error(String(error)),
  });
}

export function makeCliOutput(config: CliRuntimeConfig): CliOutputService {
  const requestId = safeEnvelopeRequestId(config.requestId);
  const stdout = makeWriter(process.stdout);
  const stderr = makeWriter(process.stderr);
  const envelope = (value: ResultEnvelope | ErrorEnvelope | EventEnvelope | Readonly<Record<string, unknown>>) =>
    stdout(jsonStringify(value));

  return {
    requestId,
    result: (command, data, meta) => {
      if (config.output === "raw") {
        const value = typeof data === "string" ? data : jsonStringify(data, false);
        return stdout(value);
      }
      const result: ResultEnvelope = {
        protocol: CLI_PROTOCOL,
        type: "result",
        id: requestId,
        command,
        ok: true,
        data,
        ...(meta === undefined ? {} : { meta }),
      };
      return stdout(jsonStringify(result, config.output === "pretty"));
    },
    failure: (command, error) => {
      const failure: ErrorEnvelope = {
        protocol: CLI_PROTOCOL,
        type: "error",
        id: requestId,
        command,
        ok: false,
        error: errorBody(error),
      };
      return stdout(jsonStringify(failure, config.output === "pretty"));
    },
    envelope,
    diagnostic: (message) => stderr(message),
  };
}

export function CliOutputLive(config: CliRuntimeConfig): Layer.Layer<CliOutputService> {
  return Layer.succeed(CliOutput, makeCliOutput(config));
}
