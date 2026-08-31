import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { basename } from "node:path";

import { Args, Command, Options } from "@effect/cli";
import { Cause, Effect, Layer, Option, Redacted, Stream } from "effect";

import {
  CLI_GATEWAY_EVENT_CHANNEL,
  GATEWAY_EVENT_CHANNELS,
  GATEWAY_SERVICE_CATALOG,
  findService,
} from "./catalog.js";
import { Gateway, GatewayLive, type GatewayService } from "./gateway.js";
import { readJsonInput, requireJsonObject, type JsonInputOptions } from "./input.js";
import { CliInputError, CLI_PROTOCOL, CLI_VERSION, errorBody, type CliRuntimeConfig } from "./model.js";
import { CliOutput, CliOutputLive, type CliOutputService } from "./output.js";
import { formatGatewaySchemaIssues, validateGatewayJsonSchema } from "./schema-validation.js";
import { runStdioRpc } from "./stdio-rpc.js";
import {
  DEFAULT_MCP_MAX_MESSAGE_BYTES,
  DEFAULT_MCP_MAX_OUTPUT_MESSAGE_BYTES,
  MAX_MCP_MAX_MESSAGE_BYTES,
  MAX_MCP_MAX_OUTPUT_MESSAGE_BYTES,
  MIN_MCP_MAX_OUTPUT_MESSAGE_BYTES,
  runMcpStdio,
} from "./mcp-stdio.js";
import { SAND_INFERENCE_PROVIDERS } from "../shared/inference-router.js";

const optionalText = (name: string, description: string) => Options.text(name).pipe(
  Options.withDescription(description),
  Options.optional,
);

function missingSubcommand(commandName: string, choices: readonly string[]): Effect.Effect<void> {
  return Effect.sync(() => {
    process.exitCode = 1;
    try {
      process.stderr.write(`${commandName}: missing subcommand. Choose one of: ${choices.join(", ")}.\n`);
    } catch {
      // A closed diagnostic pipe must not turn a usage error into a stack trace.
    }
  });
}

const rootCommand = Command.make("grok-bot", {
  url: optionalText("url", "Explicit Grok Bot gateway base URL."),
  token: Options.redacted("token").pipe(
    Options.withDescription("Gateway bearer token. Prefer GROK_BOT_GATEWAY_TOKEN."),
    Options.optional,
  ),
  discovery: Options.file("discovery").pipe(
    Options.withDescription("Explicit gateway.json discovery path."),
    Options.optional,
  ),
  timeoutMs: Options.integer("timeout-ms").pipe(
    Options.withDescription("Connection/request timeout in milliseconds (default 90000 for media operations)."),
    Options.withDefault(90_000),
  ),
  output: Options.choice("output", ["json", "pretty", "raw"] as const).pipe(
    Options.withAlias("o"),
    Options.withDefault("json" as const),
  ),
  requestId: optionalText("request-id", "Stable request correlation id."),
  traceparent: optionalText("traceparent", "W3C traceparent propagated to the host."),
  fullAvatars: Options.boolean("full-avatars").pipe(
    Options.withDescription("Do not request slim agent summaries."),
  ),
  allowInsecureRemote: Options.boolean("allow-insecure-remote").pipe(
    Options.withDescription("Allow clear-text HTTP to a non-loopback gateway."),
  ),
}, () => missingSubcommand("grok-bot", [
  "health", "doctor", "services", "describe-service", "call", "service", "events", "rpc", "mcp",
  "agent", "chat", "provider", "attachment", "avatar", "prepare-upgrade",
]));

type RootOptions = Effect.Effect.Success<typeof rootCommand>;

function runtimeConfig(options: RootOptions): CliRuntimeConfig {
  const token = Option.getOrUndefined(options.token);
  const url = Option.getOrUndefined(options.url);
  const discoveryPath = Option.getOrUndefined(options.discovery);
  const requestId = Option.getOrUndefined(options.requestId);
  const traceparent = Option.getOrUndefined(options.traceparent);
  return {
    timeoutMs: options.timeoutMs,
    output: options.output,
    fullAvatars: options.fullAvatars,
    allowInsecureRemote: options.allowInsecureRemote,
    ...(url === undefined ? {} : { url }),
    ...(token === undefined ? {} : { token: Redacted.value(token) }),
    ...(discoveryPath === undefined ? {} : { discoveryPath }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(traceparent === undefined ? {} : { traceparent }),
  };
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

function withRuntime(
  commandName: string,
  program: Effect.Effect<void, unknown, GatewayService | CliOutputService>,
  options: { readonly protocolStdout?: boolean } = {},
): Effect.Effect<void, never, Command.Command.Context<"grok-bot">> {
  return Effect.gen(function* () {
    const rootOptions = yield* rootCommand;
    const config = runtimeConfig(rootOptions);
    const layer = Layer.merge(GatewayLive(config), CliOutputLive(config));
    const checkedProgram = Number.isSafeInteger(config.timeoutMs) && config.timeoutMs > 0
      ? program
      : Effect.fail(new CliInputError({
        code: "INVALID_INPUT",
        message: "--timeout-ms must be a positive integer.",
      }));
    yield* checkedProgram.pipe(
      Effect.catchAllCause((cause) => Cause.isInterruptedOnly(cause)
        ? Effect.void
        : Effect.gen(function* () {
        process.exitCode = 1;
        const output = yield* CliOutput;
        const error = Option.getOrElse(
          Cause.failureOption(cause),
          () => new Error("Unexpected internal CLI failure."),
        );
        if (options.protocolStdout === true) {
          const body = errorBody(error);
          yield* output.diagnostic(`${commandName}: ${body.code}: ${body.message}`);
        } else {
          yield* output.failure(commandName, error);
        }
      })),
      Effect.provide(layer),
      // A closed stdout/stderr is terminal for a CLI invocation. The output
      // service reports it as a typed error; do not turn that into a runtime
      // defect or an uncaught stack trace while attempting another write.
      Effect.catchAll(() => Effect.sync(() => { process.exitCode = 1; })),
    );
  });
}

function jsonInputConfig() {
  return {
    json: optionalText("json", "Inline JSON object arguments."),
    file: Options.file("file").pipe(
      Options.withDescription("Read JSON object arguments from a file."),
      Options.optional,
    ),
    stdin: Options.boolean("stdin").pipe(
      Options.withDescription("Read JSON object arguments from stdin."),
    ),
    yes: Options.boolean("yes").pipe(
      Options.withAlias("y"),
      Options.withDescription("Confirm a destructive service call."),
    ),
  } as const;
}

function inputOptions(config: {
  readonly json: Option.Option<string>;
  readonly file: Option.Option<string>;
  readonly stdin: boolean;
}): JsonInputOptions {
  const json = Option.getOrUndefined(config.json);
  const file = Option.getOrUndefined(config.file);
  return {
    stdin: config.stdin,
    ...(json === undefined ? {} : { json }),
    ...(file === undefined ? {} : { file }),
  };
}

function requireDestructiveConfirmation(method: string, yes: boolean): Effect.Effect<void, CliInputError> {
  const descriptor = findService(method);
  return descriptor?.risk !== "destructive" || yes
    ? Effect.void
    : Effect.fail(new CliInputError({
      code: "INVALID_INPUT",
      message: `${method} is destructive. Pass --yes to confirm.`,
    }));
}

function validateKnownServiceInput(method: string, args: unknown): Effect.Effect<void, CliInputError> {
  const descriptor = findService(method);
  if (descriptor === undefined) return Effect.void;
  const issues = validateGatewayJsonSchema(descriptor.inputSchema, args);
  return issues.length === 0
    ? Effect.void
    : Effect.fail(new CliInputError({
      code: "INVALID_INPUT",
      message: `Invalid arguments for ${descriptor.name}: ${formatGatewaySchemaIssues(issues)}`,
    }));
}

function callAndPrint(
  commandName: string,
  method: string,
  args: unknown,
  options?: { readonly allowUnknown?: boolean },
): Effect.Effect<void, unknown, GatewayService | CliOutputService> {
  return Effect.gen(function* () {
    // --allow-unknown widens discovery only; catalog-known methods always keep
    // their advertised validation contract.
    yield* validateKnownServiceInput(method, args);
    const gateway = yield* Gateway;
    const output = yield* CliOutput;
    const result = yield* gateway.invoke(method, args, options);
    yield* output.result(commandName, result, { service: method });
  });
}

const healthCommand = Command.make("health", {}, () => withRuntime("health", Effect.gen(function* () {
  const gateway = yield* Gateway;
  const output = yield* CliOutput;
  yield* output.result("health", yield* gateway.health);
}))).pipe(Command.withDescription("Check the headless Grok Bot host."));

const doctorCommand = Command.make("doctor", {}, () => withRuntime("doctor", Effect.gen(function* () {
  const gateway = yield* Gateway;
  const output = yield* CliOutput;
  const connection = yield* gateway.connection;
  const health = yield* gateway.health;
  const services = yield* gateway.services;
  yield* output.result("doctor", {
    ok: true,
    connection: publicConnection(connection),
    health,
    services: {
      protocolVersion: services.protocolVersion,
      capabilities: services.capabilities,
      liveDiscovery: services.live,
      count: services.methods.length,
    },
  });
}))).pipe(Command.withDescription("Validate discovery, authentication, health, and service negotiation."));

const servicesCommand = Command.make("services", {
  group: optionalText("group", "Filter by service group."),
  risk: Options.choice("risk", ["read", "write", "interactive", "destructive"] as const).pipe(Options.optional),
  liveOnly: Options.boolean("live-only"),
}, ({ group, risk, liveOnly }) => withRuntime("services", Effect.gen(function* () {
  const gateway = yield* Gateway;
  const output = yield* CliOutput;
  const advertised = yield* gateway.services.pipe(Effect.catchAll((error) => liveOnly
    ? Effect.fail(error)
    : Effect.succeed({
      protocolVersion: 0,
      capabilities: [] as readonly string[],
      methods: [] as readonly string[],
      live: false,
      discoveryError: errorBody(error).code,
    })));
  const groupValue = Option.getOrUndefined(group);
  const riskValue = Option.getOrUndefined(risk);
  const services = GATEWAY_SERVICE_CATALOG
    .filter((service) => groupValue === undefined || service.group === groupValue)
    .filter((service) => riskValue === undefined || service.risk === riskValue)
    .map((service) => ({
      ...service,
      advertised: advertised.live ? advertised.methods.includes(service.name) : null,
    }))
    .filter((service) => !liveOnly || advertised.live && advertised.methods.includes(service.name));
  const compiled = new Set(GATEWAY_SERVICE_CATALOG.map((service) => service.name));
  const liveExtras = advertised.methods.filter((method) => !compiled.has(method));
  yield* output.result("services", {
    protocolVersion: advertised.protocolVersion,
    capabilities: advertised.capabilities,
    liveDiscovery: advertised.live,
    ...("discoveryError" in advertised ? { discoveryError: advertised.discoveryError } : {}),
    count: services.length,
    services,
    liveExtras,
  });
}))).pipe(Command.withDescription("List compiled 0.18/backport/0.30 gateway coverage and live availability."));

const describeServiceCommand = Command.make("describe-service", {
  service: Args.text({ name: "service" }),
}, ({ service }) => withRuntime("describe-service", Effect.gen(function* () {
  const output = yield* CliOutput;
  const descriptor = findService(service);
  if (descriptor == null) {
    return yield* Effect.fail(new CliInputError({ code: "UNKNOWN_SERVICE", message: `Unknown service: ${service}` }));
  }
  yield* output.result("describe-service", descriptor);
}))).pipe(Command.withDescription("Describe one gateway service."));

const callCommand = Command.make("call", {
  method: Args.text({ name: "method" }),
  input: jsonInputConfig(),
  allowUnknown: Options.boolean("allow-unknown").pipe(
    Options.withDescription("Bypass compiled and live gateway allowlists."),
  ),
}, ({ method, input, allowUnknown }) => withRuntime(`call:${method}`, Effect.gen(function* () {
  yield* requireDestructiveConfirmation(method, input.yes);
  const args = yield* readJsonInput(inputOptions(input)).pipe(Effect.flatMap(requireJsonObject));
  yield* callAndPrint(`call:${method}`, method, args, { allowUnknown });
}))).pipe(Command.withDescription("Invoke a gateway method by camelCase name."));

const serviceCommand = Command.make("service", {
  method: Args.text({ name: "service" }),
  input: jsonInputConfig(),
}, ({ method, input }) => withRuntime(`service:${method}`, Effect.gen(function* () {
  const descriptor = findService(method);
  if (descriptor == null) {
    return yield* Effect.fail(new CliInputError({ code: "UNKNOWN_SERVICE", message: `Unknown service: ${method}` }));
  }
  yield* requireDestructiveConfirmation(descriptor.name, input.yes);
  const args = yield* readJsonInput(inputOptions(input)).pipe(Effect.flatMap(requireJsonObject));
  yield* callAndPrint(`service:${descriptor.name}`, descriptor.name, args);
}))).pipe(Command.withDescription("Invoke any known camelCase or kebab-case service name."));

const eventsCommand = Command.make("events", {
  channels: Args.text({ name: "channel" }).pipe(Args.repeated),
  count: Options.integer("count").pipe(
    Options.withDescription("Stop after this many events; zero streams until interrupted."),
    Options.withDefault(0),
  ),
  allowUnknownChannel: Options.boolean("allow-unknown-channel"),
}, ({ channels, count, allowUnknownChannel }) => withRuntime("events", Effect.gen(function* () {
  if (count < 0) {
    return yield* Effect.fail(new CliInputError({
      code: "INVALID_INPUT",
      message: "--count must be zero or a positive integer.",
    }));
  }
  const invalid = channels.filter((channel) =>
    channel !== CLI_GATEWAY_EVENT_CHANNEL
    && !(GATEWAY_EVENT_CHANNELS as readonly string[]).includes(channel));
  if (!allowUnknownChannel && invalid.length > 0) {
    return yield* Effect.fail(new CliInputError({
      code: "INVALID_INPUT",
      message: `Unknown event channel(s): ${invalid.join(", ")}. Pass --allow-unknown-channel for a newer host.`,
    }));
  }
  const gateway = yield* Gateway;
  const output = yield* CliOutput;
  const subscriptionId = `events-${output.requestId}`;
  // Streaming commands are NDJSON protocols regardless of the one-shot
  // pretty/raw preference, so every frame stays one compact envelope.
  yield* output.envelope({
    protocol: CLI_PROTOCOL,
    type: "result",
    id: output.requestId,
    command: "events",
    ok: true,
    data: { subscriptionId, channels, streaming: true },
  });
  let sequence = 0;
  const stream = count > 0 ? gateway.events(channels).pipe(Stream.take(count)) : gateway.events(channels);
  yield* stream.pipe(Stream.runForEach((event) => output.envelope({
    protocol: CLI_PROTOCOL,
    type: "event",
    subscriptionId,
    sequence: ++sequence,
    at: new Date().toISOString(),
    channel: event.channel,
    data: event.payload,
  })));
}))).pipe(Command.withDescription("Stream gateway events as NDJSON with reconnect-gap notices."));

const rpcCommand = Command.make("rpc", {
  stdio: Options.boolean("stdio").pipe(Options.withDescription("Compatibility flag; RPC always uses stdin/stdout NDJSON framing.")),
}, () => withRuntime("rpc", runStdioRpc, { protocolStdout: true })).pipe(
  Command.withDescription("Run persistent NDJSON RPC with client-side cancellation; host completion depends on service cooperation."),
);

const mcpCommand = Command.make("mcp", {
  stdio: Options.boolean("stdio").pipe(Options.withDescription("Compatibility flag; MCP always uses JSON-RPC over stdin/stdout.")),
  maxMessageBytes: Options.integer("max-message-bytes").pipe(
    Options.withDescription(`Maximum MCP input frame size in bytes (default ${DEFAULT_MCP_MAX_MESSAGE_BYTES}; hard cap ${MAX_MCP_MAX_MESSAGE_BYTES}).`),
    Options.withDefault(DEFAULT_MCP_MAX_MESSAGE_BYTES),
  ),
  maxOutputMessageBytes: Options.integer("max-output-message-bytes").pipe(
    Options.withDescription(`Maximum MCP output frame size in bytes (default ${DEFAULT_MCP_MAX_OUTPUT_MESSAGE_BYTES}; range ${MIN_MCP_MAX_OUTPUT_MESSAGE_BYTES}-${MAX_MCP_MAX_OUTPUT_MESSAGE_BYTES}).`),
    Options.withDefault(DEFAULT_MCP_MAX_OUTPUT_MESSAGE_BYTES),
  ),
  includeWrites: Options.boolean("include-writes").pipe(
    Options.withDescription("Expose non-destructive mutation and interaction services as MCP tools."),
  ),
  includeDestructive: Options.boolean("include-destructive").pipe(
    Options.withDescription("Expose destructive gateway services as MCP tools."),
  ),
  includeSensitive: Options.boolean("include-sensitive").pipe(
    Options.withDescription("Expose tools or fields carrying credentials, private paths, transcripts, sharing details, or media."),
  ),
  unsafeRaw: Options.boolean("unsafe-raw").pipe(
    Options.withDescription("Expose an unrestricted raw gateway-call MCP tool."),
  ),
  allowUnknownRaw: Options.boolean("allow-unknown-raw").pipe(
    Options.withDescription("Let --unsafe-raw call methods absent from the catalog; requires --unsafe-raw."),
  ),
  unsafeHumanActions: Options.boolean("unsafe-human-actions").pipe(
    Options.withDescription("Expose user-decision services; requires all write, destructive, and sensitive gates."),
  ),
}, ({ maxMessageBytes, maxOutputMessageBytes, includeWrites, includeDestructive, includeSensitive, unsafeRaw, allowUnknownRaw, unsafeHumanActions }) => withRuntime("mcp", runMcpStdio({
  maxMessageBytes,
  maxOutputMessageBytes,
  includeWrites,
  includeDestructive,
  includeSensitive,
  exposeRawGatewayCall: unsafeRaw,
  allowUnknownRawMethods: allowUnknownRaw,
  includeHumanActions: unsafeHumanActions,
}), { protocolStdout: true })).pipe(
  Command.withDescription("Run the oh-my-pi-compatible MCP stdio server."),
);

const agentListCommand = Command.make("list", {}, () => withRuntime("agent:list", callAndPrint("agent:list", "listAgents", {})));

const agentCreateCommand = Command.make("create", {
  name: Options.text("name").pipe(Options.withDescription("Agent name.")),
  description: Options.text("description").pipe(Options.withDescription("Agent description.")),
  title: optionalText("title", "Agent title."),
  suppressIntroduction: Options.boolean("suppress-introduction"),
  kickstart: Options.boolean("kickstart"),
}, ({ name, description, title, suppressIntroduction, kickstart }) => withRuntime("agent:create", callAndPrint(
  "agent:create",
  "createAgent",
  {
    clientNonce: randomUUID(),
    name,
    description,
    ...(Option.getOrUndefined(title) === undefined ? {} : { title: Option.getOrUndefined(title) }),
    isIntroductionSuppressed: suppressIntroduction,
    isKickstartRequested: kickstart,
    origin: "user",
  },
)));

const agentTranscriptCommand = Command.make("transcript", {
  agentId: Args.text({ name: "agent-id" }),
}, ({ agentId }) => withRuntime("agent:transcript", callAndPrint("agent:transcript", "getAgentTranscript", { id: agentId })));

const agentDeleteCommand = Command.make("delete", {
  agentId: Args.text({ name: "agent-id" }),
  yes: Options.boolean("yes").pipe(Options.withAlias("y")),
}, ({ agentId, yes }) => withRuntime("agent:delete", Effect.gen(function* () {
  yield* requireDestructiveConfirmation("deleteAgents", yes);
  yield* callAndPrint("agent:delete", "deleteAgents", { ids: [agentId] });
})));

const agentCommand = Command.make("agent", {}, () => missingSubcommand("grok-bot agent", ["list", "create", "transcript", "delete"])).pipe(
  Command.withSubcommands([agentListCommand, agentCreateCommand, agentTranscriptCommand, agentDeleteCommand]),
  Command.withDescription("Ergonomic local-agent lifecycle commands."),
);

const chatSendCommand = Command.make("send", {
  agentId: Args.text({ name: "agent-id" }),
  prompt: Args.text({ name: "prompt" }),
  attachment: Options.text("attachment").pipe(Options.repeated),
  replyTo: optionalText("reply-to", "Transcript entry id being replied to."),
}, ({ agentId, prompt, attachment, replyTo }) => withRuntime("chat:send", Effect.gen(function* () {
  const nonce = randomUUID();
  const gateway = yield* Gateway;
  const output = yield* CliOutput;
  const args = {
    agentId,
    prompt,
    clientNonce: nonce,
    attachmentPaths: attachment,
    ...(Option.getOrUndefined(replyTo) === undefined ? {} : { replyToId: Option.getOrUndefined(replyTo) }),
    composedAtMs: Date.now(),
    enterEpochMs: Date.now(),
  };
  yield* validateKnownServiceInput("sendPrompt", args);
  const result = yield* gateway.invoke("sendPrompt", args);
  yield* output.result("chat:send", { result, clientNonce: nonce }, {
    completion: "acceptance-only",
    hint: "Subscribe to agents/transcript events to observe turn completion.",
  });
})));

const chatAcceptanceCommand = Command.make("acceptance", {
  clientNonce: Args.text({ name: "client-nonce" }),
  accountSlot: Options.text("account-slot").pipe(Options.withDefault("host")),
}, ({ clientNonce, accountSlot }) => withRuntime("chat:acceptance", callAndPrint(
  "chat:acceptance",
  "promptAcceptanceStatus",
  { accountSlot, clientNonce },
)));

const chatCommand = Command.make("chat", {}, () => missingSubcommand("grok-bot chat", ["send", "acceptance"])).pipe(
  Command.withSubcommands([chatSendCommand, chatAcceptanceCommand]),
  Command.withDescription("Send prompts and inspect idempotent acceptance."),
);

const providerStatusCommand = Command.make("status", {}, () => withRuntime("provider:status", Effect.gen(function* () {
  const gateway = yield* Gateway;
  const output = yield* CliOutput;
  yield* validateKnownServiceInput("getHostSettings", {});
  const settings = yield* gateway.invoke("getHostSettings", {});
  const record = typeof settings === "object" && settings !== null ? settings as Record<string, unknown> : {};
  yield* output.result("provider:status", {
    inferenceProvider: record.inferenceProvider,
    inferenceRouterUsage: record.inferenceRouterUsage,
    agentDefaultModel: record.agentDefaultModel,
    computerUseModel: record.computerUseModel,
  });
})));

const providerSetCommand = Command.make("set", {
  provider: Args.choice(SAND_INFERENCE_PROVIDERS.map((provider) => [provider, provider]), { name: "provider" }),
  yes: Options.boolean("yes").pipe(
    Options.withAlias("y"),
    Options.withDescription("Confirm the destructive host-settings mutation."),
  ),
}, ({ provider, yes }) => withRuntime("provider:set", Effect.gen(function* () {
  yield* requireDestructiveConfirmation("setHostSettings", yes);
  yield* callAndPrint("provider:set", "setHostSettings", { inferenceProvider: provider });
})));

const providerCommand = Command.make("provider", {}, () => missingSubcommand("grok-bot provider", ["status", "set"])).pipe(
  Command.withSubcommands([providerStatusCommand, providerSetCommand]),
  Command.withDescription("Inspect or choose the inference provider."),
);

const avatarCommand = Command.make("avatar", {
  agentId: Args.text({ name: "agent-id" }),
  out: Options.text("out").pipe(Options.optional),
  force: Options.boolean("force").pipe(
    Options.withDescription("Replace an existing output file."),
  ),
}, ({ agentId, out, force }) => withRuntime("avatar", Effect.gen(function* () {
  const gateway = yield* Gateway;
  const output = yield* CliOutput;
  const avatar = yield* gateway.avatar(agentId);
  const path = Option.getOrUndefined(out);
  if (path !== undefined) {
    yield* Effect.tryPromise({
      try: () => writeFile(path, avatar.bytes, { flag: force ? "w" : "wx" }),
      catch: (error) => new CliInputError({
        code: "INVALID_INPUT",
        message: typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST"
          ? `Refusing to replace existing avatar output ${path}; pass --force to overwrite it.`
          : `Unable to write avatar to ${path}: ${error instanceof Error ? error.message : String(error)}`,
      }),
    });
    yield* output.result("avatar", { path, bytes: avatar.bytes.byteLength, contentType: avatar.contentType, etag: avatar.etag ?? null });
    return;
  }
  yield* output.result("avatar", avatar);
})));

const attachmentUploadCommand = Command.make("upload", {
  filePath: Args.text({ name: "file" }),
  filename: optionalText("filename", "Filename sent to Grok Bot; defaults to the local basename and determines the media limit."),
  agentId: optionalText("agent-id", "Target local agent ID; omit only when the host has an active fallback agent."),
}, ({ filePath, filename, agentId }) => withRuntime("attachment:upload", Effect.gen(function* () {
  const gateway = yield* Gateway;
  const output = yield* CliOutput;
  const remoteFilename = Option.getOrUndefined(filename) ?? basename(filePath);
  const targetAgentId = Option.getOrUndefined(agentId);
  const result = yield* gateway.uploadAttachmentFile({
    filePath,
    filename: remoteFilename,
    ...(targetAgentId === undefined ? {} : { agentId: targetAgentId }),
  });
  yield* output.result("attachment:upload", result, {
    service: "uploadAttachment",
    filename: remoteFilename,
    transport: "capability-negotiated-stream",
  });
}))).pipe(Command.withDescription("Stream a local file with raw reconstructed-host transport or stock 0.30 JSON fallback (25 MiB, or 200 MiB for supported video extensions)."));

const attachmentCommand = Command.make("attachment", {}, () => missingSubcommand("grok-bot attachment", ["upload"])).pipe(
  Command.withSubcommands([attachmentUploadCommand]),
  Command.withDescription("Upload large local attachment files without retaining their base64 encoding."),
);

const prepareUpgradeCommand = Command.make("prepare-upgrade", {
  yes: Options.boolean("yes").pipe(
    Options.withAlias("y"),
    Options.withDescription("Confirm that the host may be quiesced for upgrade."),
  ),
}, ({ yes }) => withRuntime("prepare-upgrade", Effect.gen(function* () {
  if (!yes) {
    return yield* Effect.fail(new CliInputError({
      code: "INVALID_INPUT",
      message: "prepare-upgrade may quiesce the host. Pass --yes to confirm.",
    }));
  }
  const gateway = yield* Gateway;
  const output = yield* CliOutput;
  yield* output.result("prepare-upgrade", yield* gateway.prepareUpgrade);
})));

export const command = rootCommand.pipe(Command.withSubcommands([
  healthCommand,
  doctorCommand,
  servicesCommand,
  describeServiceCommand,
  callCommand,
  serviceCommand,
  eventsCommand,
  rpcCommand,
  mcpCommand,
  agentCommand,
  chatCommand,
  providerCommand,
  attachmentCommand,
  avatarCommand,
  prepareUpgradeCommand,
]));

export const runCli = Command.run(command, {
  name: "Grok Bot Effect CLI",
  version: CLI_VERSION,
  executable: "grok-bot",
});
