# Daily Grok Bot workflows

Use these recipes from the repository root. Global flags such as `--url`,
`--token`, `--timeout-ms`, and `--output` must precede the subcommand.

## Start with discovery

```sh
grok-bot doctor
grok-bot --output pretty services
grok-bot --output pretty services --group agent --risk read
grok-bot --output pretty describe-service get-agent-transcript
```

Inspect `.data.services.liveDiscovery` in the doctor envelope. Only add
`--live-only` when it is `true`. A stock host may lack `listGatewayServices`;
then descriptors have `advertised: null`, `--live-only` correctly yields no
rows, and the audited stock catalogue is provisional until each call succeeds
or returns an authoritative 404/entitlement error.

The CLI is client-only. It expects a running host and authenticates even for
loopback health. Prefer environment or discovery-file authentication to
`--token`, because command-line tokens leak into shell history and process
listings. Cleartext non-loopback HTTP is rejected unless the caller crosses the
explicit insecure-remote boundary; use TLS instead.

Connection precedence is explicit `--url`/`--token`, then
`GROK_BOT_GATEWAY_URL`/`GROK_BOT_GATEWAY_TOKEN`, then legacy Sand variables,
then explicit or automatic discovery. Discovery validates both the recorded PID
and process start time. A stale record is rejected intentionally.

## Choose the surface

| Need | Surface | Why |
| --- | --- | --- |
| Health, agents, prompts, files, avatars, provider | Ergonomic command | Small stable interface and useful defaults |
| Any known gateway method | `service <camel-or-kebab>` | Catalogue lookup, schema validation, and risk confirmation |
| Read-only inspection in an agent loop | MCP default | Privacy-safe named tools only |
| Repeated requests and subscriptions from a TUI | `rpc --stdio` | Persistent full-authority transport with explicit client policy |
| Changes as they happen | `events` | Reconnecting, sequence-numbered stream |
| Verified future/experimental method | `call <camelCase> --allow-unknown` | Conspicuous escape hatch; treat unknown risk as destructive and sensitive |

Use `describe-service` before `service`. `describe-service` and `service` accept
camelCase or generated kebab-case. `services` lists and filters descriptors; it
does not take a service-name argument. The lower-level `call` command expects
the case-sensitive camelCase host name.

For an unknown method, trusted host/source documentation must establish its
payload and effects. Obtain explicit confirmation as though it were destructive
and sensitive before dispatch; `--yes` cannot add catalogue protection because
the risk is unknown.

```sh
grok-bot service get-host-status
grok-bot service get-agent-memories --json '{"id":"agent-1"}'
printf '%s\n' '{"id":"agent-1"}' | grok-bot service get-agent-memories --stdin
grok-bot service install-mcp-plugin --file ./private/install.json --yes
```

`--json`, `--file`, and `--stdin` are mutually exclusive. Use at most one when
arguments are needed; omit all three for a no-input service. The value must be
a JSON object. A file input is bounded and checked as a non-symlink regular
file; make secret-bearing files mode 0600 and remove them through the user's
normal secure workflow when finished.

## Local agents and chat

```sh
grok-bot agent list
grok-bot agent create \
  --name Researcher \
  --description 'Investigate regressions' \
  --suppress-introduction
grok-bot agent transcript AGENT_ID
```

Observe a turn in one terminal:

```sh
grok-bot events transcript agents agent-activity
```

Send in another:

```sh
grok-bot chat send AGENT_ID 'Inspect the failing test'
grok-bot chat send AGENT_ID 'Follow this branch' --reply-to ENTRY_ID
grok-bot chat acceptance CLIENT_NONCE --account-slot host
```

The send result contains `.data.clientNonce` and marks completion as
`acceptance-only`. Acceptance confirms admission/idempotency, not that the agent
finished. For defensible completion tracking:

1. capture a transcript-tail baseline, then start the `transcript` and `agents`
   watcher before sending; when advertised, also capture reconstructed-only
   `getRuntimeStatus`, otherwise use the `agent list`/`listAgents` roster;
2. retain the returned nonce and require its nonce-bearing user entry to appear;
3. observe the target agent enter and then leave `runningAgentIds`, or use the
   roster's running-turn state/equivalent terminal lifecycle, accounting for
   queued work; if the host exposes no reliable terminal marker, do not promote
   the result beyond accepted/queued solely because a transcript event arrived;
4. re-read the transcript tail and retain non-streaming entries after the
   nonce-bearing prompt; and
5. on timeout, a missed run transition, a silent/awaiting-user turn, or a
   `possibleGap` reconnect, report only accepted/queued until transcript plus
   runtime snapshots support a stronger conclusion.

`chat send` generates a new nonce on every invocation, so blind retry can
duplicate a turn. `--request-id` is correlation, not service idempotency. After
a timeout, reconcile acceptance and transcript before retrying. Integrations
that need retry-safe dispatch should call `service send-prompt` or RPC with a
caller-generated stable `clientNonce` and exactly the same payload.

Useful targeted reads:

```sh
grok-bot service search-agents --json '{"query":"regression","limit":20}'
grok-bot service get-agent-transcript-tail --json '{"id":"AGENT_ID","limit":100}'
grok-bot service get-agent-thread --json '{"id":"AGENT_ID","rootId":"ENTRY_ID"}'
grok-bot service get-runtime-status # reconstructed host, when advertised
grok-bot service get-agent-memories --json '{"id":"AGENT_ID"}'
grok-bot service get-agent-automations --json '{"id":"AGENT_ID"}'
grok-bot service get-agent-workflows --json '{"id":"AGENT_ID"}'
```

Delete only after resolving the exact agent ID and confirming it is disposable:

```sh
grok-bot agent delete AGENT_ID --yes
```

Prefer the modern `deleteAgents` service for batches. `deleteAgent` is a legacy
compatibility method.

## Attachments, avatars, and transcription

Upload first, then pass the returned host-local `.data.path` to chat:

```sh
grok-bot attachment upload ./notes.pdf --agent-id AGENT_ID --filename notes.pdf
grok-bot chat send AGENT_ID 'Review the notes' --attachment HOST_PATH
grok-bot chat send AGENT_ID 'Compare both' \
  --attachment HOST_PATH_ONE \
  --attachment HOST_PATH_TWO
```

For a supported video, increase the client timeout:

```sh
grok-bot --timeout-ms 600000 attachment upload ./demo.mp4 \
  --agent-id AGENT_ID \
  --filename demo.mp4
```

The source must be a nonempty regular file. Ordinary uploads are at most 25 MiB.
Supported `.m4v`, `.mov`, `.mp4`, `.ogv`, and `.webm` videos may be at most
200 MiB when the reconstructed host advertises raw streaming. Stock fallback is
base64 JSON and remains subject to the host request limit. Prefer an explicit
agent ID so ownership is unambiguous.

```sh
grok-bot avatar AGENT_ID --out avatar.png
grok-bot avatar AGENT_ID --out avatar.png --force
grok-bot service transcribe-audio --file ./private/transcribe.json
```

Avatar output refuses to overwrite unless `--force`. Describe the transcription
schema first and keep audio/credentials out of inline JSON.

## Cloud Agents

Start with model and job discovery:

```sh
grok-bot service list-cloud-agent-models
grok-bot service list-cloud-agents \
  --json '{"limit":50,"includeArchived":false}'
```

Launch only after confirming repository, branch, prompt, and account effects:

```sh
grok-bot service launch-cloud-agent \
  --json '{"prompt":"Fix the build","repoUrl":"https://example.invalid/org/repo"}' \
  --yes
```

Then inspect and poll:

```sh
grok-bot service get-cloud-agent --json '{"bcId":"CLOUD_ID"}'
grok-bot service watch-cloud-agent --json '{"bcId":"CLOUD_ID"}'
grok-bot service get-cloud-agent-transcript --json '{"bcId":"CLOUD_ID"}'
grok-bot service reply-to-cloud-agent \
  --json '{"bcId":"CLOUD_ID","prompt":"Continue with the tests"}'
```

`watchCloudAgent` is one bounded, nonblocking snapshot. Poll with backoff until a
terminal state; do not treat one response as a permanent subscription.
`cancelCloudAgent` and `deleteCloudAgent` are destructive and require `--yes`;
archive and unarchive are ordinary writes. Re-read job state after a timeout or
cancellation because transport cancellation does not prove the remote operation
rolled back.

## Automations, workflows, skills, sharing, channels

These surfaces evolve quickly. Discover, describe, then invoke rather than
memorizing payloads:

```sh
grok-bot --output pretty services --group automation
grok-bot --output pretty services --group workflow
grok-bot --output pretty services --group skill
grok-bot --output pretty services --group sharing
grok-bot --output pretty services --group channel
grok-bot describe-service create-agent-automation
```

Append `--live-only` only when doctor reports live discovery.

Human-facing actions such as approvals, form responses, room membership,
publishing, secrets, and voice nudges need fresh user intent. Never infer a
person, account, room, secret, approval choice, or publish scope from an ID
alone. Verify the resulting snapshot after every mutation.

## Provider, MCP/box operations, and upgrades

```sh
grok-bot provider status
grok-bot provider set codex --yes
grok-bot service get-mcp-state
grok-bot service get-mcp-catalog
grok-bot service list-mcp-servers
grok-bot service list-mcp-server-tools --json '{"serverId":"SERVER_ID"}'
```

Provider choices are `cursor`, `claude-code`, `codex`, and `openrouter`.
Changing provider mutates shared host configuration. MCP installation and auth
payloads can contain secrets; use stdin or a protected file, never shell text.

Restarting MCP servers is an operational write that can interrupt active tool
calls. Confirm the impact, invoke it, then verify state:

```sh
grok-bot service restart-mcp-servers
grok-bot service get-mcp-state
```

`setBoxSecrets` is replace-all, not a patch. Read `getBoxSecretsStatus`, prepare
the complete intended replacement, and confirm the target before invoking it.
Host upgrades can quiesce the process:

```sh
grok-bot prepare-upgrade --yes
```

Do not invoke upgrade preparation as a diagnostic or availability check.

## Events

Use a bounded sample when investigating:

```sh
grok-bot events --count 10 workflows automations
```

`--count 0` streams until interrupted. Known upstream channels are
`transcript`, `client-side-tool-v2`, `agents`, `agent-upserted`, `outline`,
`subagents`, `async-tasks`, `automations`, `workflows`, `memory`, `tray`,
`forever-box`, `teach-recording`, `mcp-servers`, `sharing`, `host-settings`,
`box-disk-pressure`, `computer-action`, `agent-activity`, `mcp-auth`,
`auth-status`, and `local-tool-permission`. `grok.gateway` is synthetic.
Unknown future channels require `--allow-unknown-channel`.

Events begin with a result frame, then emit sequence-numbered event frames. On
reconnect, `grok.gateway` reports `possibleGap: true`; refresh the relevant
agent, workflow, automation, MCP, auth, or settings snapshot.

## Consume output correctly

After argument parsing, default one-shot output writes exactly one compact JSON
envelope and one trailing line feed. Check the process exit status and `.ok`,
then consume `.data`. The envelope includes `protocol: "grok-effect-cli/v1"`,
an ID, command, and either data or structured error.

`--output pretty` formats the same envelope. `--output raw` unwraps successful
data but failures remain structured error envelopes, so default JSON is safer
for automation. Argument/parse failures write a plain diagnostic to stderr,
leave stdout empty, and exit nonzero. Runtime diagnostics remain on stderr.

Use `--request-id` for stable correlation and `--traceparent` for W3C trace
propagation. `--full-avatars` makes results heavier and more privacy-sensitive.

## Recover deliberately

| Symptom | Response |
| --- | --- |
| No discovery | Start/verify the desktop host, or supply an authorized URL/token |
| Stale discovery | Refresh it; PID/start-time rejection protects against process reuse |
| Authentication failure | Refresh the configured token or discovery record |
| Service unavailable | Inspect plain `services`; use `--live-only` only with live discovery, otherwise treat stock fallback as provisional and preserve 404/entitlement errors |
| Timeout | Raise global `--timeout-ms`, then reconcile state before retrying a write |
| Event reconnect | Refresh the affected snapshot because events may have been missed |
| Unknown payload shape | Inspect exact/partial/generic schema and preserve the authoritative host error |

Never print, forward, or commit the bearer token or discovery record. They grant
broad host authority.
