import { createHash } from "node:crypto";

import { Cause, Deferred, Effect, Exit, Fiber, Ref, Scope, Stream } from "effect";

import {
  GATEWAY_METHOD_PATTERN,
  GATEWAY_SERVICE_CATALOG,
  findService,
} from "./catalog.js";
import {
  Gateway,
  MAX_ACTIVE_SSE_BUFFER_BYTES,
  MAX_GATEWAY_JSON_RESPONSE_BYTES,
  MAX_SSE_EVENT_BYTES,
} from "./gateway.js";
import {
  CliInputError,
  CLI_PROTOCOL,
  CLI_VERSION,
  errorBody,
  type ErrorBody,
} from "./model.js";
import { jsonStringify } from "./output.js";
import { readBoundedLines } from "./bounded-lines.js";
import { formatGatewaySchemaIssues, validateGatewayJsonSchema } from "./schema-validation.js";

const RPC_PROTOCOL_VERSION = 1 as const;
const MAX_INPUT_FRAME_BYTES = 40 * 1024 * 1024;
const MAX_OUTPUT_FRAME_BYTES = 40 * 1024 * 1024;
const MAX_REQUEST_COUNT = 64;
const MAX_ACTIVE_REQUEST_BYTES = 64 * 1024 * 1024;
export const MAX_ACTIVE_OUTPUT_BYTES = 128 * 1024 * 1024;
export const RPC_REQUEST_OUTPUT_RESERVATION_BYTES = Math.max(
  MAX_OUTPUT_FRAME_BYTES,
  MAX_GATEWAY_JSON_RESPONSE_BYTES,
);
export const MAX_RPC_ACTIVE_REQUESTS = Math.min(
  MAX_REQUEST_COUNT,
  Math.floor(MAX_ACTIVE_OUTPUT_BYTES / RPC_REQUEST_OUTPUT_RESERVATION_BYTES),
);
const MAX_ACTIVE_SUBSCRIPTIONS = 32;
const MAX_SEEN_IDS = 100_000;
const MAX_ID_LENGTH = 256;
const MAX_ERROR_RESPONSE_METHOD_BYTES = 1024;
const CHANNEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

type RequestFiber = Fiber.RuntimeFiber<DispatchSuccess, unknown>;
type SubscriptionFiber = Fiber.RuntimeFiber<void, unknown>;
type SubscriptionEndReason = "cancelled" | "eof" | "error" | "shutdown" | "stream-ended" | "unsubscribed";

interface RpcRequestFrame {
  readonly protocol: typeof CLI_PROTOCOL;
  readonly protocolVersion: typeof RPC_PROTOCOL_VERSION;
  readonly type: "request";
  readonly id: string;
  readonly method: string;
  readonly params?: unknown;
  readonly allowUnknown: boolean;
  readonly frameBytes: number;
}

interface RpcCancelFrame {
  readonly protocol: typeof CLI_PROTOCOL;
  readonly protocolVersion: typeof RPC_PROTOCOL_VERSION;
  readonly type: "cancel";
  readonly id: string;
  readonly targetId: string;
}

interface RpcShutdownFrame {
  readonly protocol: typeof CLI_PROTOCOL;
  readonly protocolVersion: typeof RPC_PROTOCOL_VERSION;
  readonly type: "shutdown";
  readonly id: string;
}

type RpcInputFrame = RpcRequestFrame | RpcCancelFrame | RpcShutdownFrame;

interface DispatchSuccess {
  readonly result: unknown;
  readonly afterTerminal?: Effect.Effect<void>;
}

interface ActiveRequest {
  readonly method: string;
  readonly operation: RequestFiber;
  readonly done: Deferred.Deferred<void>;
  readonly bytes: number;
}

interface ActiveSubscription {
  readonly operation: SubscriptionFiber;
  readonly done: Deferred.Deferred<void>;
  readonly endReason: Ref.Ref<SubscriptionEndReason | null>;
  readonly sequence: Ref.Ref<number>;
}

type RpcErrorPayload = ErrorBody & { readonly dispatchState?: "unknown" };

class RpcOutputError extends Error {
  readonly name = "RpcOutputError";

  constructor(
    readonly code: "OUTPUT_FRAME_TOO_LARGE" | "OUTPUT_SERIALIZATION" | "STDOUT_CLOSED",
    message: string,
  ) {
    super(message);
  }
}

class ShutdownRequested extends Error {
  readonly name = "ShutdownRequested";
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function validId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= MAX_ID_LENGTH;
}

export function defaultRpcSubscriptionId(requestId: string): string {
  const direct = `sub-${requestId}`;
  if (Buffer.byteLength(direct, "utf8") <= MAX_ID_LENGTH) return direct;
  const digest = createHash("sha256").update(requestId, "utf8").digest("hex").slice(0, 32);
  return `sub-sha256-${digest}`;
}

export function canAdmitRpcRequest(activeBytes: number, requestBytes: number): boolean {
  return Number.isSafeInteger(activeBytes)
    && Number.isSafeInteger(requestBytes)
    && activeBytes >= 0
    && requestBytes >= 0
    && activeBytes + requestBytes <= MAX_ACTIVE_REQUEST_BYTES;
}

/**
 * Reserve one maximum-sized terminal response for every active request. A
 * completed operation retains its result while it waits for the serialized
 * stdout writer, so a count-only limit would otherwise permit a multi-GiB
 * result queue even though each individual frame is bounded.
 */
export function canAdmitRpcOutput(activeCount: number): boolean {
  return Number.isSafeInteger(activeCount)
    && activeCount >= 0
    && (activeCount + 1) * RPC_REQUEST_OUTPUT_RESERVATION_BYTES <= MAX_ACTIVE_OUTPUT_BYTES;
}

/** Return the exact number of bytes the stdout writer puts on the wire. */
export function rpcNdjsonOutputFrameBytes(encoded: string): number {
  return Buffer.byteLength(encoded, "utf8") + (encoded.endsWith("\n") ? 0 : 1);
}

export function rpcErrorResponseMethod(method: string): string {
  return Buffer.byteLength(method, "utf8") <= MAX_ERROR_RESPONSE_METHOD_BYTES
    ? method
    : "[oversized RPC method omitted]";
}

function protocolFields() {
  return {
    protocol: CLI_PROTOCOL,
    protocolVersion: RPC_PROTOCOL_VERSION,
  } as const;
}

function parseRequest(bytes: Uint8Array, lineNumber: number): Effect.Effect<RpcInputFrame, CliInputError> {
  return Effect.try({
    try: (): RpcInputFrame => {
      let line: string;
      try {
        line = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new CliInputError({
          code: "INVALID_PROTOCOL",
          message: "NDJSON frames must be valid UTF-8.",
          line: lineNumber,
        });
      }
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch {
        throw new CliInputError({
          code: "INVALID_PROTOCOL",
          message: "Invalid NDJSON JSON frame.",
          line: lineNumber,
        });
      }
      const record = asRecord(value);
      if (record == null) {
        throw new CliInputError({
          code: "INVALID_PROTOCOL",
          message: "Each NDJSON frame must be an object.",
          line: lineNumber,
        });
      }
      if (record.protocol !== CLI_PROTOCOL || record.protocolVersion !== RPC_PROTOCOL_VERSION) {
        throw new CliInputError({
          code: "INVALID_PROTOCOL",
          message: `Each frame must declare protocol '${CLI_PROTOCOL}' and protocolVersion ${RPC_PROTOCOL_VERSION}.`,
          line: lineNumber,
        });
      }
      if (!validId(record.id)) {
        throw new CliInputError({
          code: "INVALID_PROTOCOL",
          message: `Frame id must be a non-empty UTF-8 string no longer than ${MAX_ID_LENGTH} bytes.`,
          line: lineNumber,
        });
      }
      if (record.type === "request") {
        if (typeof record.method !== "string" || record.method.length === 0) {
          throw new CliInputError({
            code: "INVALID_PROTOCOL",
            message: "request.method must be a non-empty string.",
            line: lineNumber,
          });
        }
        if (record.allowUnknown !== undefined && typeof record.allowUnknown !== "boolean") {
          throw new CliInputError({
            code: "INVALID_PROTOCOL",
            message: "request.allowUnknown must be a boolean when present.",
            line: lineNumber,
          });
        }
        const params: unknown = record.params;
        return {
          ...protocolFields(),
          type: "request" as const,
          id: record.id,
          method: record.method,
          ...(params === undefined ? {} : { params }),
          allowUnknown: record.allowUnknown === true,
          frameBytes: bytes.byteLength,
        };
      }
      if (record.type === "cancel") {
        if (!validId(record.targetId)) {
          throw new CliInputError({
            code: "INVALID_PROTOCOL",
            message: "cancel.targetId must be a non-empty string.",
            line: lineNumber,
          });
        }
        return {
          ...protocolFields(),
          type: "cancel" as const,
          id: record.id,
          targetId: record.targetId,
        };
      }
      if (record.type === "shutdown") {
        return {
          ...protocolFields(),
          type: "shutdown" as const,
          id: record.id,
        };
      }
      throw new CliInputError({
        code: "INVALID_PROTOCOL",
        message: "Frame type must be request, cancel, or shutdown.",
        line: lineNumber,
      });
    },
    catch: (error) => error instanceof CliInputError
      ? error
      : new CliInputError({
        code: "INVALID_PROTOCOL",
        message: error instanceof Error ? error.message : String(error),
        line: lineNumber,
      }),
  });
}

function publicConnection(connection: {
  readonly baseUrl: string;
  readonly source: string;
  readonly discoveryPath?: string;
  readonly pid?: number;
  readonly startedAt?: number;
  readonly token?: string;
}) {
  return {
    baseUrl: connection.baseUrl,
    source: connection.source,
    authenticated: connection.token != null && connection.token.length > 0,
    ...(connection.discoveryPath === undefined ? {} : { discoveryPath: connection.discoveryPath }),
    ...(connection.pid === undefined ? {} : { pid: connection.pid }),
    ...(connection.startedAt === undefined ? {} : { startedAt: connection.startedAt }),
  };
}

function outputErrorBody(error: unknown): RpcErrorPayload {
  if (error instanceof RpcOutputError) return { code: error.code, message: error.message };
  return errorBody(error);
}

interface RpcStdoutWriter {
  readonly write: (value: string) => Effect.Effect<void, RpcOutputError>;
  readonly close: () => void;
}

function makeRpcStdoutWriter(stream: NodeJS.WriteStream): RpcStdoutWriter {
  let terminalError: Error | undefined;
  let rejectActive: ((error: Error) => void) | undefined;
  const onError = (error: Error) => {
    terminalError = error;
    rejectActive?.(error);
  };
  // Keep the listener for the whole RPC session. Node can invoke a successful
  // write callback before emitting a late EPIPE event; removing a per-write
  // listener in that callback leaves the process with an uncaught error.
  stream.on("error", onError);

  return {
    write: (value) => Effect.async<void, RpcOutputError>((resume) => {
      let settled = false;
      const finish = (error?: Error | null) => {
        if (settled) return;
        settled = true;
        rejectActive = undefined;
        resume(error == null
          ? Effect.void
          : Effect.fail(new RpcOutputError("STDOUT_CLOSED", `Unable to write RPC stdout: ${error.message}`)));
      };
      if (terminalError !== undefined) {
        finish(terminalError);
        return;
      }
      rejectActive = (error) => finish(error);
      try {
        stream.write(value.endsWith("\n") ? value : `${value}\n`, finish);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
      return Effect.sync(() => {
        rejectActive = undefined;
      });
    }),
    close: () => {
      rejectActive = undefined;
      stream.off("error", onError);
    },
  };
}

export const runStdioRpc = Effect.scoped(Effect.gen(function* () {
  const gateway = yield* Gateway;
  const stdout = yield* Effect.acquireRelease(
    Effect.sync(() => makeRpcStdoutWriter(process.stdout)),
    (writer) => Effect.sync(writer.close),
  );
  const terminalOutputFailure = yield* Deferred.make<void>();
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
  const outputLock = yield* Effect.makeSemaphore(1);
  const active = yield* Ref.make(new Map<string, ActiveRequest>());
  const subscriptions = yield* Ref.make(new Map<string, ActiveSubscription>());
  const seenIds = yield* Ref.make(new Set<string>());
  const closing = yield* Ref.make(false);
  const sessionState: { endReason: "eof" | "shutdown" } = { endReason: "eof" };

  const emitRaw = (frame: Readonly<Record<string, unknown>>) => outputLock.withPermits(1)(
    Effect.try({
      try: () => jsonStringify(frame),
      catch: (error) => new RpcOutputError(
        "OUTPUT_SERIALIZATION",
        `Unable to serialize an RPC frame: ${error instanceof Error ? error.message : String(error)}`,
      ),
    }).pipe(
      Effect.flatMap((encoded) => rpcNdjsonOutputFrameBytes(encoded) > MAX_OUTPUT_FRAME_BYTES
        ? Effect.fail(new RpcOutputError(
          "OUTPUT_FRAME_TOO_LARGE",
          `RPC output exceeds ${MAX_OUTPUT_FRAME_BYTES} bytes; use a file/artifact-returning service for large payloads.`,
        ))
        : stdout.write(encoded)),
    ),
  ).pipe(
    Effect.tapError((error) => error.code === "STDOUT_CLOSED" ? markOutputFailed : Effect.void),
  );

  const emitProtocolError = (id: string | null, error: unknown) => emitRaw({
    ...protocolFields(),
    type: "protocol-error",
    id,
    ok: false,
    error: outputErrorBody(error),
  });

  const emitResponseErrorBody = (id: string, method: string, body: RpcErrorPayload) => {
    const boundedMethod = rpcErrorResponseMethod(method);
    return emitRaw({
      ...protocolFields(),
      type: "response",
      id,
      method: boundedMethod,
      ok: false,
      error: body,
    }).pipe(
      // A gateway error body can itself be arbitrarily large. Always retain a
      // small terminal response so an oversized success/error does not turn
      // into a silent request with no matching id.
      Effect.catchAll((error) => error.code === "STDOUT_CLOSED"
        ? Effect.fail(error)
        : emitRaw({
          ...protocolFields(),
          type: "response",
          id,
          method: boundedMethod,
          ok: false,
          error: {
            code: error.code,
            message: error.code === "OUTPUT_FRAME_TOO_LARGE"
              ? `RPC response could not fit within the ${MAX_OUTPUT_FRAME_BYTES}-byte NDJSON output limit.`
              : "RPC response could not be serialized as JSON.",
          },
        })),
    );
  };

  const emitResponseError = (id: string, method: string, error: unknown) =>
    emitResponseErrorBody(id, method, outputErrorBody(error));

  const emitResponseSuccess = (id: string, method: string, result: unknown) => emitRaw({
    ...protocolFields(),
    type: "response",
    id,
    method,
    ok: true,
    result,
  }).pipe(
    Effect.catchAll((error) => error.code === "STDOUT_CLOSED"
      ? Effect.fail(error)
      : emitResponseErrorBody(id, method, outputErrorBody(error))),
  );

  const reserveId = (id: string) => Ref.modify(seenIds, (current) => {
    if (current.has(id)) return ["duplicate" as const, current] as const;
    if (current.size >= MAX_SEEN_IDS) return ["full" as const, current] as const;
    // This Set is private to the Ref and no snapshot escapes. Mutating it
    // inside the atomic modify keeps session-id reservation O(1) instead of
    // copying as many as 100,000 prior ids for every frame.
    current.add(id);
    return ["accepted" as const, current] as const;
  });

  const removeActive = (id: string, operation: RequestFiber) => Ref.update(active, (current) => {
    if (current.get(id)?.operation !== operation) return current;
    const next = new Map(current);
    next.delete(id);
    return next;
  });

  const removeSubscription = (id: string, operation: SubscriptionFiber) => Ref.update(subscriptions, (current) => {
    if (current.get(id)?.operation !== operation) return current;
    const next = new Map(current);
    next.delete(id);
    return next;
  });

  const cancelRequest = (targetId: string) => Effect.gen(function* () {
    const entry = (yield* Ref.get(active)).get(targetId);
    if (entry == null) return { cancelled: false, targetId };
    const exit = yield* Fiber.interrupt(entry.operation);
    return {
      cancelled: Exit.isFailure(exit) && Cause.isInterruptedOnly(exit.cause),
      targetId,
      dispatchState: "unknown" as const,
    };
  });

  const stopSubscription = (subscriptionId: string, reason: SubscriptionEndReason) => Effect.gen(function* () {
    const entry = (yield* Ref.get(subscriptions)).get(subscriptionId);
    if (entry == null) return false;
    yield* Ref.set(entry.endReason, reason);
    yield* Fiber.interrupt(entry.operation);
    yield* Deferred.await(entry.done);
    return true;
  });

  const startSubscription = (
    request: RpcRequestFrame,
    subscriptionId: string,
    channels: readonly string[] | undefined,
  ): Effect.Effect<DispatchSuccess, CliInputError, Scope.Scope> => Effect.uninterruptible(Effect.gen(function* () {
    if (yield* Ref.get(closing)) {
      return yield* Effect.fail(new CliInputError({
        code: "INVALID_PROTOCOL",
        message: "The RPC session is shutting down.",
      }));
    }
    const startGate = yield* Deferred.make<void>();
    const done = yield* Deferred.make<void>();
    const endReason = yield* Ref.make<SubscriptionEndReason | null>(null);
    const sequence = yield* Ref.make(0);
    const operation = yield* Deferred.await(startGate).pipe(
      Effect.zipRight(gateway.events(channels).pipe(
        Stream.runForEach((event) => Ref.updateAndGet(sequence, (value) => value + 1).pipe(
          Effect.flatMap((nextSequence) => emitRaw({
            ...protocolFields(),
            type: "event",
            subscriptionId,
            sequence: nextSequence,
            receivedAt: new Date().toISOString(),
            channel: event.channel,
            data: event.payload,
          })),
        )),
      )),
      // The outer setup region is atomic, but this long-lived child must not
      // inherit its uninterruptible status or unsubscribe/EOF can wait forever
      // on an open SSE response body.
      Effect.interruptible,
      Effect.forkScoped,
    );
    const entry: ActiveSubscription = { operation, done, endReason, sequence };
    const admission = yield* Ref.modify(subscriptions, (current) => {
      if (current.has(subscriptionId)) return ["duplicate" as const, current] as const;
      if (current.size >= MAX_ACTIVE_SUBSCRIPTIONS) return ["full" as const, current] as const;
      return ["accepted" as const, new Map(current).set(subscriptionId, entry)] as const;
    });
    if (admission !== "accepted") {
      yield* Fiber.interrupt(operation);
      return yield* Effect.fail(new CliInputError({
        code: "INVALID_INPUT",
        message: admission === "duplicate"
          ? `Subscription id is already active: ${subscriptionId}`
          : `At most ${MAX_ACTIVE_SUBSCRIPTIONS} subscriptions may be active at once.`,
      }));
    }

    const monitor = Fiber.await(operation).pipe(
      Effect.flatMap((exit) => Effect.gen(function* () {
        const requestedReason = yield* Ref.get(endReason);
        const reason = requestedReason
          ?? (Exit.isSuccess(exit) ? "stream-ended" as const : "error" as const);
        const nextSequence = yield* Ref.updateAndGet(sequence, (value) => value + 1);
        yield* emitRaw({
          ...protocolFields(),
          type: "subscription-end",
          subscriptionId,
          sequence: nextSequence,
          reason,
          mayHaveLostEvents: reason === "error" || reason === "stream-ended",
          ...(Exit.isFailure(exit) && !Cause.isInterruptedOnly(exit.cause)
            ? { error: outputErrorBody(Cause.squash(exit.cause)) }
            : {}),
        });
      })),
      Effect.ensuring(removeSubscription(subscriptionId, operation)),
      Effect.ensuring(Deferred.succeed(done, undefined).pipe(Effect.ignore)),
    );
    // The monitor is also forked from the atomic setup region. Restore normal
    // child interruptibility while it awaits the stream and serialized writer.
    yield* Effect.forkScoped(Effect.interruptible(monitor));

    return {
      result: { subscriptionId, channels: channels ?? [] },
      afterTerminal: Deferred.succeed(startGate, undefined).pipe(Effect.asVoid),
    };
  }));

  const dispatch = (request: RpcRequestFrame): Effect.Effect<DispatchSuccess, unknown, Scope.Scope> => {
    const params = request.params === undefined ? {} : asRecord(request.params);
    if (params == null) {
      return Effect.fail(new CliInputError({
        code: "INVALID_INPUT",
        message: `${request.method} params must be an object.`,
      }));
    }
    const succeed = (result: unknown): Effect.Effect<DispatchSuccess> => Effect.succeed({ result });
    switch (request.method) {
      case "grok.ping":
        return succeed({ pong: true, at: new Date().toISOString() });
      case "grok.health":
        return gateway.health.pipe(Effect.map((result) => ({ result })));
      case "grok.connection":
        return gateway.connection.pipe(Effect.map(publicConnection), Effect.map((result) => ({ result })));
      case "grok.services.list":
        return gateway.services.pipe(Effect.map((advertised) => {
          const compiled = new Set(GATEWAY_SERVICE_CATALOG.map((service) => service.name));
          const services = GATEWAY_SERVICE_CATALOG.map((service) => ({
            ...service,
            advertised: advertised.live ? advertised.methods.includes(service.name) : null,
          }));
          return {
            result: {
              protocolVersion: advertised.protocolVersion,
              capabilities: advertised.capabilities,
              liveDiscovery: advertised.live,
              count: services.length,
              services,
              liveExtras: advertised.methods.filter((method) => !compiled.has(method)),
            },
          };
        }));
      case "grok.services.describe": {
        const name = params.name;
        if (typeof name !== "string") {
          return Effect.fail(new CliInputError({
            code: "INVALID_INPUT",
            message: "grok.services.describe needs params.name.",
          }));
        }
        const service = findService(name);
        return service == null
          ? Effect.fail(new CliInputError({ code: "UNKNOWN_SERVICE", message: `Unknown service: ${name}` }))
          : succeed(service);
      }
      case "grok.call": {
        const name = params.method;
        if (typeof name !== "string") {
          return Effect.fail(new CliInputError({
            code: "UNKNOWN_SERVICE",
            message: "grok.call needs params.method.",
          }));
        }
        const known = findService(name);
        if (known == null && (!request.allowUnknown || !GATEWAY_METHOD_PATTERN.test(name))) {
          return Effect.fail(new CliInputError({
            code: "UNKNOWN_SERVICE",
            message: `Unknown service: ${name}. Set request.allowUnknown=true only for a newer trusted gateway.`,
          }));
        }
        const args = params.args ?? {};
        if (known !== undefined) {
          const issues = validateGatewayJsonSchema(known.inputSchema, args);
          if (issues.length > 0) {
            return Effect.fail(new CliInputError({
              code: "INVALID_INPUT",
              message: `Invalid arguments for ${known.name}: ${formatGatewaySchemaIssues(issues)}`,
            }));
          }
        }
        return gateway.invoke(known?.name ?? name, args, {
          allowUnknown: request.allowUnknown,
        }).pipe(Effect.map((result) => ({ result })));
      }
      case "grok.cancel": {
        const targetId = params.targetId ?? params.requestId;
        if (!validId(targetId) || targetId === request.id) {
          return Effect.fail(new CliInputError({
            code: "INVALID_INPUT",
            message: "grok.cancel needs a targetId different from its own request id.",
          }));
        }
        return cancelRequest(targetId).pipe(Effect.map((result) => ({ result })));
      }
      case "grok.subscribe": {
        const requested = params.channels;
        if (requested !== undefined && (!Array.isArray(requested)
          || requested.some((item) => typeof item !== "string" || !CHANNEL_PATTERN.test(item)))) {
          return Effect.fail(new CliInputError({
            code: "INVALID_INPUT",
            message: "grok.subscribe params.channels must be valid channel-name strings.",
          }));
        }
        const subscriptionId = params.subscriptionId === undefined
          ? defaultRpcSubscriptionId(request.id)
          : params.subscriptionId;
        if (!validId(subscriptionId)) {
          return Effect.fail(new CliInputError({
            code: "INVALID_INPUT",
            message: `subscriptionId must be a non-empty UTF-8 string no longer than ${MAX_ID_LENGTH} bytes.`,
          }));
        }
        const channels = requested === undefined
          ? undefined
          : [...new Set(requested as string[])];
        return startSubscription(request, subscriptionId, channels);
      }
      case "grok.unsubscribe": {
        const subscriptionId = params.subscriptionId;
        if (!validId(subscriptionId)) {
          return Effect.fail(new CliInputError({
            code: "INVALID_INPUT",
            message: "grok.unsubscribe needs params.subscriptionId.",
          }));
        }
        return stopSubscription(subscriptionId, "unsubscribed").pipe(
          Effect.map((unsubscribed) => ({ result: { subscriptionId, unsubscribed } })),
        );
      }
      default: {
        const known = findService(request.method);
        if (known == null && (!request.allowUnknown || !GATEWAY_METHOD_PATTERN.test(request.method))) {
          return Effect.fail(new CliInputError({
            code: "UNKNOWN_SERVICE",
            message: `Unknown RPC method: ${request.method}. Set request.allowUnknown=true only for a newer trusted gateway.`,
          }));
        }
        if (known !== undefined) {
          const issues = validateGatewayJsonSchema(known.inputSchema, params);
          if (issues.length > 0) {
            return Effect.fail(new CliInputError({
              code: "INVALID_INPUT",
              message: `Invalid arguments for ${known.name}: ${formatGatewaySchemaIssues(issues)}`,
            }));
          }
        }
        return gateway.invoke(known?.name ?? request.method, params, {
          allowUnknown: request.allowUnknown,
        }).pipe(Effect.map((result) => ({ result })));
      }
    }
  };

  const startRequest = (request: RpcRequestFrame) => Effect.gen(function* () {
    if (yield* Ref.get(closing)) {
      yield* emitResponseErrorBody(request.id, request.method, {
        code: "SHUTTING_DOWN",
        message: "The RPC session is shutting down.",
      });
      return;
    }
    const startGate = yield* Deferred.make<void>();
    const done = yield* Deferred.make<void>();
    const operation = yield* Deferred.await(startGate).pipe(
      Effect.zipRight(dispatch(request)),
      Effect.forkScoped,
    );
    const entry: ActiveRequest = { method: request.method, operation, done, bytes: request.frameBytes };
    const admission = yield* Ref.modify(active, (current) => {
      if (current.size >= MAX_RPC_ACTIVE_REQUESTS) return ["count" as const, current] as const;
      if (!canAdmitRpcOutput(current.size)) return ["output-bytes" as const, current] as const;
      let retainedBytes = 0;
      for (const activeRequest of current.values()) retainedBytes += activeRequest.bytes;
      if (!canAdmitRpcRequest(retainedBytes, request.frameBytes)) {
        return ["bytes" as const, current] as const;
      }
      return ["accepted" as const, new Map(current).set(request.id, entry)] as const;
    });
    if (admission !== "accepted") {
      yield* Fiber.interrupt(operation);
      yield* emitResponseErrorBody(request.id, request.method, {
        code: "TOO_MANY_REQUESTS",
        message: admission === "count"
          ? `At most ${MAX_RPC_ACTIVE_REQUESTS} requests may be active at once after reserving bounded output capacity.`
          : admission === "output-bytes"
          ? `Active RPC requests reserve at most ${MAX_ACTIVE_OUTPUT_BYTES} output bytes; wait for an earlier terminal response or cancel it.`
          : `Active RPC requests may retain at most ${MAX_ACTIVE_REQUEST_BYTES} input bytes; wait for an earlier request to finish or cancel it.`,
        retryable: true,
      });
      return;
    }

    const monitor = Fiber.await(operation).pipe(
      Effect.flatMap((exit) => {
        if (Exit.isSuccess(exit)) {
          return emitResponseSuccess(request.id, request.method, exit.value.result).pipe(
            Effect.zipRight(exit.value.afterTerminal ?? Effect.void),
          );
        }
        if (Cause.isInterruptedOnly(exit.cause)) {
          return emitResponseErrorBody(request.id, request.method, {
            code: "CANCELLED",
            message: "Request cancelled. If a mutating HTTP request was already dispatched, its outcome is unknown.",
            retryable: false,
            dispatchState: "unknown",
          });
        }
        return emitResponseError(request.id, request.method, Cause.squash(exit.cause));
      }),
      Effect.ensuring(removeActive(request.id, operation)),
      Effect.ensuring(Deferred.succeed(done, undefined).pipe(Effect.ignore)),
    );
    yield* Effect.forkScoped(monitor);
    yield* Deferred.succeed(startGate, undefined);
  });

  const handleInput = (frame: RpcInputFrame): Effect.Effect<void, unknown, Scope.Scope> => Effect.gen(function* () {
    const reservation = yield* reserveId(frame.id);
    if (reservation !== "accepted") {
      yield* emitProtocolError(frame.id, new CliInputError({
        code: "INVALID_PROTOCOL",
        message: reservation === "duplicate"
          ? `Frame id may not be reused during a session: ${frame.id}`
          : `The session has reached its ${MAX_SEEN_IDS}-id safety bound; reconnect before sending more requests.`,
      }));
      return;
    }
    if (frame.type === "cancel") {
      if (frame.targetId === frame.id) {
        yield* emitResponseErrorBody(frame.id, "grok.cancel", {
          code: "INVALID_INPUT",
          message: "A cancel frame cannot target its own id.",
        });
        return;
      }
      const result = yield* cancelRequest(frame.targetId);
      yield* emitResponseSuccess(frame.id, "grok.cancel", result);
      return;
    }
    if (frame.type === "shutdown" || frame.method === "grok.shutdown") {
      yield* emitResponseSuccess(frame.id, "grok.shutdown", { shuttingDown: true });
      sessionState.endReason = "shutdown";
      return yield* Effect.fail(new ShutdownRequested());
    }
    yield* startRequest(frame);
  });

  yield* emitRaw({
    ...protocolFields(),
    type: "ready",
    serverVersion: CLI_VERSION,
    pid: process.pid,
    serviceCount: GATEWAY_SERVICE_CATALOG.length,
    capabilities: {
      cancellation: true,
      subscriptions: true,
      shutdown: true,
      strictServiceCatalog: true,
      maxInputFrameBytes: MAX_INPUT_FRAME_BYTES,
      maxOutputFrameBytes: MAX_OUTPUT_FRAME_BYTES,
      maxGatewayResponseBytes: MAX_GATEWAY_JSON_RESPONSE_BYTES,
      maxActiveRequests: MAX_RPC_ACTIVE_REQUESTS,
      maxActiveRequestBytes: MAX_ACTIVE_REQUEST_BYTES,
      maxActiveOutputBytes: MAX_ACTIVE_OUTPUT_BYTES,
      maxActiveSubscriptions: MAX_ACTIVE_SUBSCRIPTIONS,
      maxSseEventBytes: MAX_SSE_EVENT_BYTES,
      maxActiveSseBufferBytes: MAX_ACTIVE_SSE_BUFFER_BYTES,
      maxSessionIds: MAX_SEEN_IDS,
    },
  });

  const input = Stream.fromAsyncIterable(readBoundedLines(process.stdin, MAX_INPUT_FRAME_BYTES), (error) => new CliInputError({
    code: "INVALID_PROTOCOL",
    message: `Failed reading NDJSON: ${error instanceof Error ? error.message : String(error)}`,
  })).pipe(
    Stream.mapEffect((line) => {
      if (line.oversized) {
        return emitProtocolError(null, new CliInputError({
          code: "INVALID_PROTOCOL",
          message: `NDJSON frame ${line.lineNumber} exceeds ${MAX_INPUT_FRAME_BYTES} bytes.`,
          line: line.lineNumber,
        }));
      }
      if (line.bytes == null || line.bytes.byteLength === 0) return Effect.void;
      return parseRequest(line.bytes, line.lineNumber).pipe(
        Effect.matchEffect({
          onFailure: (error) => emitProtocolError(null, error),
          onSuccess: handleInput,
        }),
      );
    }),
    Stream.runDrain,
    Effect.catchIf(
      (error): error is ShutdownRequested => error instanceof ShutdownRequested,
      () => Effect.void,
    ),
  );
  yield* Effect.raceFirst(input, Deferred.await(terminalOutputFailure));

  yield* Ref.set(closing, true);
  const activeAtClose = [...(yield* Ref.get(active)).values()];
  yield* Effect.forEach(activeAtClose, (entry) => Fiber.interrupt(entry.operation), {
    concurrency: "unbounded",
    discard: true,
  });
  yield* Effect.forEach(activeAtClose, (entry) => Deferred.await(entry.done), {
    concurrency: "unbounded",
    discard: true,
  });

  const subscriptionsAtClose = [...(yield* Ref.get(subscriptions)).values()];
  const subscriptionReason = sessionState.endReason === "shutdown" ? "shutdown" as const : "eof" as const;
  yield* Effect.forEach(subscriptionsAtClose, (entry) => Ref.set(entry.endReason, subscriptionReason), {
    concurrency: "unbounded",
    discard: true,
  });
  yield* Effect.forEach(subscriptionsAtClose, (entry) => Fiber.interrupt(entry.operation), {
    concurrency: "unbounded",
    discard: true,
  });
  yield* Effect.forEach(subscriptionsAtClose, (entry) => Deferred.await(entry.done), {
    concurrency: "unbounded",
    discard: true,
  });

  if (!(yield* Deferred.isDone(terminalOutputFailure))) {
    yield* emitRaw({
      ...protocolFields(),
      type: "session-end",
      reason: sessionState.endReason,
    });
  }
}));
