---
name: grok-bot-operator
description: Operate this repository's Grok Bot Effect CLI, gateway catalogue, event stream, persistent RPC, and oh-my-pi MCP bridge. Use for daily agent, chat, Cloud Agent, media, provider, automation, integration, or troubleshooting tasks that invoke grok-bot; skip implementation-only edits that do not exercise the runtime surface.
---

# Grok Bot Operator

Use the CLI as a client of an already-running Grok Bot host. Do not start a
second desktop/host process, scrape its bearer token, or expose discovery data.

## Establish the command

Work from the repository root. The source build requires Node `>=26.5.0 <27`.
Prefer an already-installed `grok-bot` binary. If dependencies are missing or
stale, run `npm ci`; then build and invoke the repository launcher:

```sh
npm run cli:build
node dist/cli/grok-bot.mjs doctor
```

Use `node dist/cli/grok-bot.mjs` in place of `grok-bot` in later examples. Do
not alter the user's global `PATH` or run `npm link` unless asked.

## Route each task

1. Run `grok-bot doctor` once per session or after connection trouble.
2. Pick the narrowest surface:
   - ergonomic commands for routine agent, chat, media, provider, and health work;
   - `service` for any known catalogue method;
   - MCP for an oh-my-pi or other model-client tool loop;
   - `events` to observe changes;
   - `rpc --stdio` for a persistent custom TUI bridge;
   - `call --allow-unknown` only for a verified method absent from the catalogue.
3. Run `describe-service` before a generic call. Treat `partial` and `generic`
   schemas as discovery aids, not complete contracts; let the live host's
   validation and entitlement errors remain authoritative.
4. When arguments are needed, use at most one explicit JSON source: `--json`,
   `--file`, or `--stdin`. Omit all three for a no-input service. Prefer a
   mode-0600 file or stdin for complex or secret-bearing input.
5. Before a mutation, restate the concrete target and scope. Use `--yes` only
   for the intended destructive operation. Never make destructive, human-action,
   or raw MCP flags persistent merely for convenience.
6. Verify writes by reading the resulting state or observing the relevant event.
   Prompt acceptance is admission/idempotency evidence, not turn completion.
   Treat an unknown method as destructive and sensitive until trusted host or
   source documentation proves otherwise; confirm it outside the CLI first.

## Load only the needed reference

- For daily invocations, lifecycle recipes, output handling, and recovery, read
  [daily workflows](skill://grok-bot-operator/references/daily-workflows.md).
- For oh-my-pi setup, MCP policy gates, JSON-RPC, or a custom TUI bridge, read
  [MCP and OMP](skill://grok-bot-operator/references/mcp-and-omp.md).
- To choose among all 188 audited services, read the generated
  [service catalogue](skill://grok-bot-operator/references/service-catalog.md).

## Preserve these invariants

- Default and pretty one-shot modes return one `grok-effect-cli/v1` envelope.
  Raw mode unwraps successful data but leaves failures enveloped. Events and
  RPC use NDJSON; MCP uses JSON-RPC 2.0 over newline-delimited stdio.
- A `grok.gateway` event with `possibleGap: true` means refresh the relevant
  snapshot; upstream SSE has no replay cursor.
- `sendPrompt` and `chat send` report acceptance only. Watch events or re-read
  the transcript before reporting completion.
- Default MCP exposes only privacy-safe reads. Write, destructive, and
  sensitive gates are independent. Human actions require all three plus
  `--unsafe-human-actions`; unknown raw additionally requires `--unsafe-raw`.
- Named MCP intentionally omits `executeRoutedMcpTool`, `refreshMcp`, and
  `setHostSettings`. Prefer an ergonomic or one-shot `service` call; use a
  deliberately governed raw or RPC integration only when persistence requires it.
- The static union has 188 methods: 147 audited stock 0.30 methods and 166
  reconstructed-host methods with 125 in common. Never imply that all 188 are
  live; 22 are stock-only and availability is negotiated at runtime. When live
  discovery is unavailable, treat the audited stock fallback as provisional.
- Use `attachment upload` before chat for large media. MCP/RPC are not the
  large-video transport.
- oh-my-pi discovers project skills at startup. Restart it after changing this
  skill or its references.

## Keep the generated catalogue current

After editing `source/cli/catalog.ts`, `source/cli/service-metadata.ts`, or the
MCP policy in `source/cli/mcp-stdio.ts`, regenerate and validate the reference:

```sh
node .agents/skills/grok-bot-operator/scripts/render-service-catalog.mjs --write
node .agents/skills/grok-bot-operator/scripts/render-service-catalog.mjs --check
```
