# Conditional controllers for oh-my-pi and sidecars

Use a controller when the condition is not a native Grok Bot trigger or needs
durable state across observations. This is a process architecture, not another
kind of native routine. If the process exits, its conditions stop being
evaluated.

## Controller contract

Define each rule independently from transport:

```json
{
  "id": "cloud-agent-terminal-v1",
  "enabled": true,
  "signal": {
    "channels": ["agent-activity"],
    "poll": { "service": "watchCloudAgent", "minimumMs": 15000 }
  },
  "scope": { "bcId": "CLOUD_AGENT_ID" },
  "predicate": { "kind": "edge", "from": "nonterminal", "to": "terminal" },
  "action": { "kind": "notify", "service": "live-discovered", "authority": "ordinary-write" },
  "dedupe": { "key": "bcId+terminalRunId+ruleVersion", "ttlMs": 604800000 },
  "expiry": "EXPIRY_RFC3339",
  "recovery": { "maxAttempts": 5, "baseBackoffMs": 1000, "jitter": true }
}
```

That is a design shape, not a gateway service schema. Persist only allowlisted
rule fields; never persist a bearer token, webhook key, raw transcript, or
arbitrary event-supplied method/arguments.

Resolve `live-discovered` to the actual TUI notification surface at startup.
`sendPrompt` is one possible in-app action, not a universal oh-my-pi
notification API.

## State machine

Use these phases:

| Phase | Required behavior |
| --- | --- |
| Discover | Start RPC, wait for ready, list live services, classify risk/privacy/human marker |
| Arm | Subscribe before a causative write when races matter |
| Baseline | Read authoritative snapshots and checkpoint initial predicate state |
| Observe | Treat events as invalidation hints; mark affected scopes dirty |
| Reconcile | Re-read snapshots, especially after gaps or ambiguous mutations |
| Evaluate | Run a pure predicate over old state, new state, and rule config |
| Authorize | Independently check action policy and current human intent |
| Act | Dispatch once with stable operation identity where the API supports it |
| Verify | Read the postcondition; do not equate acceptance with completion |
| Commit | Atomically store new state/dedupe receipt after verified outcome |
| Expire | Disable rule, unsubscribe unused channels, and report final state if useful |

Coalesce invalidations per entity and serialize evaluations for the same rule.
Parallelize independent rules or snapshot reads only when doing so cannot race a
shared mutation.

## Start the RPC bridge

Run:

```sh
grok-bot rpc --stdio
```

Wait for the initial `type:"ready"` frame. Parse stdout as NDJSON, keep stderr
separate, and repeat the protocol fields and a session-unique ID on every frame.

```json
{"protocol":"grok-effect-cli/v1","protocolVersion":1,"type":"request","id":"services-1","method":"grok.services.list"}
{"protocol":"grok-effect-cli/v1","protocolVersion":1,"type":"request","id":"sub-1","method":"grok.subscribe","params":{"subscriptionId":"conditions","channels":["transcript","automations","workflows","agent-activity"]}}
{"protocol":"grok-effect-cli/v1","protocolVersion":1,"type":"request","id":"snapshot-1","method":"getAgentAutomations","params":{"id":"AGENT_ID"}}
{"protocol":"grok-effect-cli/v1","protocolVersion":1,"type":"request","id":"unsub-1","method":"grok.unsubscribe","params":{"subscriptionId":"conditions"}}
{"protocol":"grok-effect-cli/v1","protocolVersion":1,"type":"shutdown","id":"shutdown-1"}
```

Responses and events interleave. Match responses by request ID and events by
subscription ID. Subscription event sequence is local to that subscription and
starts at one; it is not an upstream replay cursor. IDs are nonempty UTF-8 up to
256 bytes and cannot be reused within the process. Current limits allow 32
subscriptions and at most two concurrent requests.

Drain RPC stdout promptly into a bounded internal queue. Do not let a slow
predicate/action handler block SSE intake: the host and CLI enforce bounded
pending frames/buffers and can close an overloaded stream.

MCP tools are useful for model-selected reads/actions but cannot subscribe. An
oh-my-pi extension that wants proactive behavior should own this RPC child and
make MCP calls only inside the resulting deliberate tool loop.

## Subscribe, then snapshot

For a rule that could race its own triggering write:

1. request the subscription;
2. wait for its successful response;
3. read the baseline snapshot;
4. buffer events that arrived between subscription admission and snapshot;
5. apply the snapshot as authority; and
6. mark buffered scopes dirty and reconcile once more.

For observation-only startup, subscription and snapshot can begin together if
the controller still performs the final dirty-scope reconciliation.

The generated
[trigger catalogue](skill://grok-bot-automations/references/trigger-catalog.md)
maps every gateway channel to its best available reconcile read. Several
channels are event-only or versioned. A controller must tolerate fields it does
not recognize and should never generate an exact form from an observed payload.

Where transcript/roster payloads carry `replicaKey`, `epoch`, and `sequence`,
drop duplicates/lower sequences and refresh on an epoch change or sequence gap.
`client-side-tool-v2` has its own per-agent epoch/sequence but no authoritative
gateway snapshot. Most other channels are unstamped snapshots, invalidations,
or telemetry: debounce them, re-read state, and compare canonical snapshots.
`memory` can be a payloadless invalidation, `host-settings` identifies changed
keys rather than authoritative values, and `box-disk-pressure` immediately
emits its current null/soft/hard level on subscription.

## Gap and restart behavior

The upstream SSE feed has no replay ID. The CLI reconnects and emits:

```json
{
  "channel": "grok.gateway",
  "data": { "kind": "reconnected", "possibleGap": true, "attempt": 2 }
}
```

Likewise, `subscription-end` can carry `mayHaveLostEvents:true`. On either:

- mark every rule for the affected channels uncertain;
- do not fire from the last event alone;
- refresh each authoritative snapshot;
- recompute edges from the last committed snapshot;
- apply the rule's explicit gap policy; and
- only then resume action dispatch.

Gap policy must state whether an edge discovered during reconciliation should
fire. For a one-time completion notification, usually yes with a stable entity
version. For a transient “started now” toast, usually no. For a destructive or
human-reserved action, never.

On controller restart, load the last atomic checkpoint, resubscribe, snapshot,
and run the same gap reconciliation. Do not restore a half-written “action in
progress” as either success or failure; query the postcondition.

## Predicate algebra

Build a small, testable evaluator rather than embedding expressions in event
handlers.

| Predicate | State | Fires when |
| --- | --- | --- |
| Level | current value | current is true, subject to cooldown |
| Rising edge | previous boolean/value | false→true or below→at/above |
| Falling edge | previous boolean/value | true→false or above→at/below |
| Changed | previous normalized hash/version | stable value differs |
| Dwell | `firstTrueAt` | continuously true for duration |
| Absence | last-seen timestamp | no qualifying event/state before deadline |
| Count/rate | bounded timestamp deque | count in window crosses threshold |
| Sequence | state + step expiry | ordered events occur within window |
| Hysteresis | mode + enter/exit bounds | enter high at A, return low at B |
| AND | snapshots for all terms | every term is true in one reconciled evaluation |
| OR | snapshots/receipts | first qualifying term, deduped across alternatives |
| Cross-service join | normalized records + join keys | relation across snapshots holds |

Normalize before comparison: sort unordered arrays, omit volatile timestamps,
canonicalize case only where the source semantics allow it, and hash bounded
canonical JSON. Store entity version or provider event ID when available.

Time predicates need monotonic time for in-process durations and wall-clock UTC
for persisted deadlines. A backward/forward wall-clock jump must not accidentally
satisfy dwell or replay an expired action.

## Dedupe, cooldown, and exactly-once honesty

There is no general exactly-once gateway transaction. Model at-least-once
observation and reconcile actions.

Use a dedupe key such as:

```text
ruleId + source + stableEntityId + sourceVersionOrEventId + ruleVersion
```

Keep dedupe state bounded by TTL and count. Separate:

- observation receipt: event/version was seen;
- action intent: controller decided to dispatch;
- action receipt: service accepted or returned;
- postcondition: authoritative state proves the intended outcome.

Commit the observation and action state atomically only after the chosen policy
says it is safe. If the process dies after dispatch but before commit, reconcile
before retrying.

For `sendPrompt`, use a caller-generated stable `clientNonce` and exactly the
same payload on retry. The digest covers agent, prompt, rich text, reply/fork,
and attachments. A changed payload with the same nonce is rejected. Query
`promptAcceptanceStatus` if acceptance is uncertain; acceptance is admission,
not turn completion. `chat send` always uses a fresh nonce and is not a retry
primitive.

Create/import automation and workflow calls have no idempotency key. Snapshot,
dispatch once, and identify the resulting ID before retrying. Updates should use
a stable target ID and full replacement spec. After timeout/cancellation, read
state first because RPC cancellation cannot prove host rollback.

## Action policy

At discovery, cache each live descriptor's:

- `advertised` state;
- `risk`;
- `sensitiveInput` and `sensitiveOutput`;
- `requiresHumanDecision`; and
- input-schema kind.

Refresh discovery after host reconnect/version change. Treat static fallback as
provisional and unknown methods as destructive/sensitive.

Rules may preauthorize a narrow ordinary read/write only when the user's intent
did so. Always require a fresh interactive decision for human-marked methods,
regardless of a broad MCP profile or RPC authority. A controller may notify
about a pending local-tool permission; it must not call
`resolveLocalToolPermission` on its own.

For sensitive results, evaluate in memory, store only minimal derived state, and
redact diagnostics. Keep payload previews bounded and never include secrets in
rule configuration, crash dumps, or traces.

## Feedback-loop prevention

A controller can observe the event caused by its own action. Tag outbound work
with stable metadata when supported:

- RPC request ID and local rule/action ID;
- `clientNonce` for admitted prompts;
- `traceparent` for correlated prompt work; and
- rule version in dedupe state.

Ignore or reconcile events bearing that origin until the expected postcondition
appears. Also set a maximum causal depth and cooldown. Never implement “on any
transcript message, send a prompt” without excluding the controller's own prompt
and resulting agent messages.

## Bounded polling

Use native events first. Poll only for unavailable signals, a hard deadline, or
a bounded snapshot API such as `watchCloudAgent`.

- Pick the largest interval that meets the latency budget.
- Add randomized jitter to fleet-wide polling.
- Never overlap polls for the same entity.
- Back off transient errors; stop or pause after a bounded failure budget.
- Separate “no change” from “could not evaluate.”
- Honor rate limits and server retry hints.
- Expire finite watches and delete their state.

`watchCloudAgent` returns one bounded snapshot; despite its name, the caller
must poll until `terminal:true`. On terminal, read artifacts/transcript only if
needed, act once, and stop.

## Arbitrary webhook bridge

When the reconstructed host needs an external webhook:

1. terminate it in a sidecar on an authenticated endpoint;
2. verify provider signature, timestamp, audience, and replay window before
   reading business fields;
3. reject oversized/unknown content types and parse into an allowlisted event
   model;
4. map a configured rule ID to a fixed agent/action; never accept a service name
   or gateway args from the request;
5. dedupe by provider event ID plus source and rule version;
6. admit only a fixed, locally configured instruction plus opaque allowlisted
   source IDs to a dedicated agent, with a nonce derived from the dedupe key;
7. on uncertainty, query prompt acceptance and transcript before retrying; and
8. return provider-appropriate acknowledgement without claiming the agent turn
   has completed.

Never expose or reuse the Grok gateway bearer as a webhook secret. Treat the
stock automation webhook credential as a different feature with its own URL and
key. `sendPrompt` has no enforced untrusted-provenance field: never interpolate
event-controlled prose, tool names, destinations, arguments, or instructions
into its instruction-bearing prompt. Let the fixed prompt re-read authoritative
state by the validated opaque ID. If the source cannot be re-read, normalize it
to a closed data model outside the model and keep the resulting action at
alert-and-confirm.

## Shutdown and health

On normal shutdown, stop accepting webhook/event work, finish or checkpoint
in-flight evaluations, unsubscribe, send `grok.shutdown`, wait for response and
`session-end`, then terminate. On forced shutdown, mark in-flight actions
unknown so restart reconciles them.

Expose only sanitized health:

- RPC ready/connected;
- subscription count and last sequence;
- last successful snapshot time;
- rules enabled/expired/degraded;
- queue depth and oldest age;
- action successes/failures by coarse code; and
- gap/reconnect count.

Do not expose discovery paths, bearer tokens, webhook keys, sensitive payloads,
or full service responses.
