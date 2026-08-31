import { Data } from "effect";

export const CLI_PROTOCOL = "grok-effect-cli/v1" as const;
export const CLI_VERSION = "0.1.0" as const;

export type OutputMode = "json" | "pretty" | "raw";

export interface CliRuntimeConfig {
  readonly url?: string;
  readonly token?: string;
  readonly discoveryPath?: string;
  readonly timeoutMs: number;
  readonly output: OutputMode;
  readonly requestId?: string;
  readonly traceparent?: string;
  readonly fullAvatars: boolean;
  /** Permit clear-text HTTP to a non-loopback gateway. */
  readonly allowInsecureRemote: boolean;
}

export interface GatewayConnection {
  readonly baseUrl: string;
  readonly token?: string;
  readonly source: "explicit" | "environment" | "discovery";
  readonly discoveryPath?: string;
  readonly pid?: number;
  readonly startedAt?: number;
}

export class CliConfigError extends Data.TaggedError("CliConfigError")<{
  readonly code: "CLI_CONFIG";
  readonly message: string;
  readonly path?: string;
}> {}

export class CliInputError extends Data.TaggedError("CliInputError")<{
  readonly code: "INVALID_INPUT" | "UNKNOWN_SERVICE" | "INVALID_PROTOCOL";
  readonly message: string;
  readonly line?: number;
}> {}

export class GatewayTransportError extends Data.TaggedError("GatewayTransportError")<{
  readonly code: "GATEWAY_UNREACHABLE" | "GATEWAY_TIMEOUT" | "GATEWAY_PROTOCOL";
  readonly message: string;
  readonly method?: string;
  readonly url?: string;
}> {}

export class GatewayResponseError extends Data.TaggedError("GatewayResponseError")<{
  readonly code: "GATEWAY_RESPONSE";
  readonly message: string;
  readonly method?: string;
  readonly status: number;
  readonly retryable: boolean;
}> {}

export type CliFailure =
  | CliConfigError
  | CliInputError
  | GatewayTransportError
  | GatewayResponseError;

export interface ErrorBody {
  readonly code: string;
  readonly message: string;
  readonly method?: string;
  readonly status?: number;
  readonly retryable?: boolean;
  readonly line?: number;
  readonly path?: string;
}

export function errorBody(error: unknown): ErrorBody {
  if (error instanceof CliConfigError) {
    return { code: error.code, message: error.message, ...(error.path === undefined ? {} : { path: error.path }) };
  }
  if (error instanceof CliInputError) {
    return { code: error.code, message: error.message, ...(error.line === undefined ? {} : { line: error.line }) };
  }
  if (error instanceof GatewayResponseError) {
    return {
      code: error.code,
      message: error.message,
      status: error.status,
      retryable: error.retryable,
      ...(error.method === undefined ? {} : { method: error.method }),
    };
  }
  if (error instanceof GatewayTransportError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.method === undefined ? {} : { method: error.method }),
    };
  }
  return {
    code: "INTERNAL",
    message: error instanceof Error ? error.message : String(error),
  };
}

export interface ResultEnvelope {
  readonly protocol: typeof CLI_PROTOCOL;
  readonly type: "result";
  readonly id: string;
  readonly command: string;
  readonly ok: true;
  readonly data: unknown;
  readonly meta?: Readonly<Record<string, unknown>>;
}

export interface ErrorEnvelope {
  readonly protocol: typeof CLI_PROTOCOL;
  readonly type: "error";
  readonly id: string;
  readonly command: string;
  readonly ok: false;
  readonly error: ErrorBody;
}

export interface EventEnvelope {
  readonly protocol: typeof CLI_PROTOCOL;
  readonly type: "event";
  readonly subscriptionId: string;
  readonly sequence: number;
  readonly at: string;
  readonly channel: string;
  readonly data: unknown;
}

export interface RpcRequest {
  readonly protocol: typeof CLI_PROTOCOL;
  readonly id: string;
  readonly method: string;
  readonly params?: unknown;
}
