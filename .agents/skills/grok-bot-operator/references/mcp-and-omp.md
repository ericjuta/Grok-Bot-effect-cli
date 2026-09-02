# oh-my-pi, MCP, and persistent RPC

Use MCP when oh-my-pi should choose and call named Grok Bot tools. Use persistent
RPC when a custom TUI owns its own menus, confirmations, subscriptions, and
reconciliation policy.

## oh-my-pi project setup

oh-my-pi discovers project skills from `.agents/skills` at startup. Launch it
from this repository root, restart after changing the skill, and invoke
`/skill:grok-bot-operator` explicitly when you want its full instructions loaded.

The checked-in `.omp/mcp.json` is the shared official relay default and stays
read-only. Its launcher clears inherited direct routes, pins the official relay
discovery file, and rejects explicit route flags before the CLI starts. Copy
`.omp/mcp.unsafe.example.json` into `~/.omp/agent/mcp.json` or another untracked
profile when you need that variant. An equivalent portable project
configuration is:

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "grok-bot": {
      "type": "stdio",
      "command": "grok-bot",
      "args": ["mcp", "--stdio"],
      "requestIdFormat": "string",
      "timeout": 120000
    }
  }
}
```

The user-wide location is `~/.omp/agent/mcp.json`; profiles may override or add
servers. Keep repository config conservative because cloning the project makes
its local command executable by the client. Review changes before sharing.

Without an installed launcher, use an absolute repository path:

```json
{
  "mcpServers": {
    "grok-bot": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/absolute/path/to/Grok-Bot-effect-cli/dist/cli/grok-bot.mjs",
        "mcp",
        "--stdio"
      ],
      "requestIdFormat": "string",
      "timeout": 120000
    }
  }
}
```

Build the launcher first with `npm run cli:build`. Within oh-my-pi, use
`/mcp reload`, `/mcp list`, and `/mcp test grok-bot` after configuration changes.
If setting a gateway timeout in `args`, place the global flag before the
subcommand, for example `['--timeout-ms','110000','mcp','--stdio']`.

## Pick a trust profile

The counts below are compiled projections before the running host's live
manifest is applied.

| Flags | Named tools | Intended use |
| --- | ---: | --- |
| none | 7 | Privacy-safe reads |
| `--include-writes` | 38 | Non-sensitive, non-destructive writes plus default reads |
| `--include-sensitive` | 70 | Private/sensitive reads without mutations |
| `--include-destructive` | 23 | Destructive but non-sensitive operations; rarely useful alone |
| writes + sensitive | 124 | Trusted personal daily profile |
| destructive + sensitive | 101 | Sensitive reads and destructive operations, without ordinary writes |
| writes + destructive | 54 | Non-sensitive mutation surface |
| writes + destructive + sensitive | 155 | All ordinary named actions except human decisions |
| all ordinary + `--unsafe-human-actions` | 185 | Full named human-decision surface |
| previous + `--unsafe-raw` | 186 | Adds one untyped raw gateway tool |

The default seven compiled tools are `countAgents`, `getSearchStatus`,
`isAgentNetworkEnabled`, `isEgressTunnelAvailable`,
`isGlobalSearchEnabled`, `listCloudAgentModels`, and `listGatewayServices`.
During disconnected/static-stock fallback, only the three stock-stable defaults
may remain. With live discovery, `tools/list` is the compiled policy intersected
with the host manifest. Without it, the server intersects the audited stock set;
transient failures retain the last good/stable projection.

For a private, trusted personal session that needs prompts and private reads,
put the full configuration below in an uncommitted user/profile config (the
object under `mcpServers.grok-bot` is the elevated server entry):

```json
{
  "mcpServers": {
    "grok-bot": {
      "type": "stdio",
      "command": "grok-bot",
      "args": ["mcp", "--stdio", "--include-writes", "--include-sensitive"],
      "requestIdFormat": "string",
      "timeout": 120000
    }
  }
}
```

This exposes `sendPrompt` and attachment-path fields but still withholds
destructive and human-decision tools. Avoid committing powerful profiles to a
shared project. Prefer a local OMP profile when elevated access is necessary.

## Understand every boundary

- `--include-writes` exposes non-read actions that are not classified as
  destructive.
- `--include-destructive` exposes destructive and operationally destructive
  actions; it does not imply writes or sensitive access.
- `--include-sensitive` exposes private inputs/outputs and detailed host errors
  and paths; without it those errors are deliberately redacted.
- `--unsafe-human-actions` permits tools that express a person's decision,
  approval, membership, secret submission, publish action, or voice nudge. Use
  it only with all ordinary gates and fresh human intent.
- `--unsafe-raw` adds `grok_gateway_call_unsafe`, bypassing named-tool policy.
  `--allow-unknown-raw` additionally permits methods absent from the catalogue
  and requires `--unsafe-raw`.

Write, destructive, and sensitive gates are independent. Human actions require
all three plus their own flag. For an ordinary missing tool, identify its
minimum gate, reload MCP, and confirm that the live host advertises and entitles
it. Named MCP permanently omits `executeRoutedMcpTool`, `refreshMcp`, and
`setHostSettings` because their scope cannot be represented safely. Prefer an
ergonomic or one-shot `service` call for those three; cross into raw or RPC only
when a persistent integration truly requires it.

Human-decision tools require immediate user confirmation of the exact choice
and target. Never autonomously accept approvals, answer forms, submit secrets,
change room membership, publish, or act on voice calls.

## MCP protocol behavior

The server speaks JSON-RPC 2.0 as newline-delimited stdio and supports protocol
versions `2025-11-25`, `2025-06-18`, `2025-03-26`, and `2024-11-05`.
Initialization comes first. Gateway call failures are returned as
`result.isError: true`; schema and protocol faults are JSON-RPC errors. Handle
both forms.

`tools/list` refreshes on a short cache, polls the live service manifest, and
emits list-changed notifications. Transient discovery failures retain the last
good/stable projection. Reload OMP after changing policy arguments.

Input and output frames default to 40 MiB and hard-cap at 64 MiB; the output
minimum is 2 KiB. Aggregate result reservation makes the effective default
concurrency two. Request IDs are bounded and must not be reused. Cancellation
or EOF interrupts the local client fetch, but does not prove that a dispatched
remote mutation stopped or rolled back. Re-read state before retrying.

Use CLI `attachment upload`, not MCP, for large media.

## Persistent RPC for a custom TUI

```sh
grok-bot rpc --stdio
```

RPC uses newline-delimited `grok-effect-cli/v1` frames with protocol version 1.
It is full-authority: there are no MCP policy flags. The TUI must implement
confirmation, privacy, and post-write reconciliation itself. Parse stdout as
NDJSON only and keep stderr on a separate diagnostics stream.

Every client frame repeats `protocol` and `protocolVersion`, and every ID is
unique for the session. A minimal exchange uses these input frames:

```json
{"protocol":"grok-effect-cli/v1","protocolVersion":1,"type":"request","id":"svc-1","method":"grok.services.list"}
{"protocol":"grok-effect-cli/v1","protocolVersion":1,"type":"request","id":"sub-1","method":"grok.subscribe","params":{"subscriptionId":"turns","channels":["transcript","agents"]}}
{"protocol":"grok-effect-cli/v1","protocolVersion":1,"type":"request","id":"unsub-1","method":"grok.unsubscribe","params":{"subscriptionId":"turns"}}
{"protocol":"grok-effect-cli/v1","protocolVersion":1,"type":"cancel","id":"cancel-1","targetId":"call-1"}
{"protocol":"grok-effect-cli/v1","protocolVersion":1,"type":"shutdown","id":"shutdown-1"}
```

Wait for the initial `type: "ready"` frame before sending. Match terminal
`type: "response"` frames by ID and check `ok`; subscription responses return a
`subscriptionId`, followed by sequence-numbered `type: "event"` frames and one
`type: "subscription-end"`. Shutdown returns its response and a final
`type: "session-end"`. Frames can interleave, so never assume request order.

Built-in methods are:

- `grok.ping`, `grok.health`, and `grok.connection`;
- `grok.services.list` and `grok.services.describe`;
- `grok.call`;
- `grok.subscribe` and `grok.unsubscribe`;
- `grok.cancel`; and
- `grok.shutdown`.

Known gateway service names may also be called directly. Unknown methods need
top-level `allowUnknown: true`. Use unique string IDs no longer than 256 UTF-8
bytes and reconnect before the process reaches its lifetime ID ceiling.

`grok.services.list` returns `liveDiscovery` plus `advertised` on each service:
`true` means currently advertised, `false` means currently absent, and `null`
means availability is unknown under static fallback. When live discovery is
true, retain advertised services. Otherwise show static methods as provisional
and reconcile concrete 404/entitlement errors rather than claiming availability.
Each descriptor includes `risk`, `sensitiveInput`, `sensitiveOutput`, and
`requiresHumanDecision`; never infer the human boundary from risk alone.

RPC fixes frames at 40 MiB, allows at most two active requests and 32
subscriptions, bounds individual SSE events at 16 MiB, and bounds aggregate
buffers at 64 MiB. A cancellation terminal can report dispatch state as
unknown. Treat that as an instruction to query current state, not as success or
rollback evidence.

For a TUI, model the safe flow as:

1. call `grok.services.list` and apply the `liveDiscovery`/`advertised` rules;
2. call `grok.services.describe` before collecting arguments; use a JSON editor
   plus host validation for `partial` or `generic`, never an exact generated form;
3. show risk, sensitivity, human-decision marker, exact target, and payload summary;
4. require explicit confirmation for destructive and human-decision actions;
5. assign a unique request ID and dispatch;
6. subscribe to relevant channels or poll a bounded snapshot; and
7. reconcile after success, timeout, reconnect, cancellation, or unknown state.

The gateway bearer token and discovery record grant broad authority. Never
render them in the TUI, logs, telemetry, transcripts, or crash reports.
