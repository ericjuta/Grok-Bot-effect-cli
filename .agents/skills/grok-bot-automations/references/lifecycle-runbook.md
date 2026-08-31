# Automation lifecycle runbook

This runbook assumes an already-running Grok Bot host and a built/installed
`grok-bot` command. For connection discovery, output envelopes, MCP profiles,
and full RPC policy, read the
[operator skill](skill://grok-bot-operator/SKILL.md).

## Discover before mutation

```sh
grok-bot doctor
grok-bot --output pretty services --group automation
grok-bot --output pretty services --group workflow
grok-bot describe-service create-agent-automation
grok-bot describe-service get-automation-webhook-credential
```

Use `--live-only` only when doctor says live discovery succeeded. With static
fallback, every method is provisional. `partial` and `generic` input schemas are
not complete forms; the current live host remains authoritative.

Resolve the exact local agent ID and snapshot its routines:

```sh
grok-bot agent list
grok-bot service get-agent-automations --json '{"id":"AGENT_ID"}'
```

`getAgentAutomations` returns bare records for one agent and is the preferred
mutation baseline. `listAllAutomations` returns cross-agent envelopes shaped
`{agentId,automation}` and is for inventory:

```sh
grok-bot service list-all-automations
```

## Prepare and preflight a create payload

Save the complete service payload as `automation-create.json` with mode 0600.
This keeps the prompt out of shell history and process arguments. The validator
accepts either a bare spec or this wrapped payload:

```json
{
  "id": "AGENT_ID",
  "spec": {
    "name": "Weekday brief",
    "prompt": "Review overnight changes and report only actionable items. Stay silent otherwise.",
    "trigger": {
      "type": "cron",
      "schedule": "CRON_TZ=Europe/London 30 8 * * 1-5"
    },
    "isEnabled": false
  }
}
```

```sh
chmod 600 automation-create.json
node .agents/skills/grok-bot-automations/scripts/validate-automation-spec.mjs \
  --file automation-create.json
```

The helper runs the reconstructed trigger parser and scheduler, prints the
normalized spec/description and next-run preview, and fails on lossy/invalid
high-risk cases. It does not replace live stock-host validation and rejects the
stock-only webhook trigger. A cron without an inline `CRON_TZ=` or `TZ=` must
be paired with `--time-zone IANA_ZONE`; this makes the preview independent of
the machine running the helper. `--at` is for reproducible tests and historical
diagnosis, not ordinary provisioning.

## Create disabled

Dispatch the already-preflighted protected payload:

```sh
grok-bot service create-agent-automation --file automation-create.json
```

Create returns the current bounded list, not a dedicated created record. Compare
IDs with the baseline, then read again and capture the exact new folder ID.
Names are not unique; retries create suffixed IDs such as `-2`.

Create has no idempotency key. If the call times out or disconnects, do not
repeat it. Read the list and reconcile first.

Reject the creation as unverified if:

- no new ID exists or more than one candidate is ambiguous;
- the normalized trigger is not the intended type/scope;
- group members were dropped or collapsed;
- a CI event disappeared due to missing/invalid `ciBranch`;
- an enabled cron has `nextRunAt:null` or an implausible next time; or
- the connection/backend reports a missing integration.

## Smoke test while paused

Manual run works even when `isEnabled:false`:

```sh
grok-bot service run-agent-automation-now --json \
  '{"id":"AGENT_ID","automationId":"AUTOMATION_ID"}'
```

The service has no completion payload and silently no-ops for a missing ID. It
waits on the host run path, but the CLI can time out first; timeout means unknown
outcome. Re-read and inspect the newest run:

```sh
grok-bot service get-agent-automations --json '{"id":"AGENT_ID"}'
grok-bot service get-agent-transcript-tail --json \
  '{"id":"AGENT_ID","limit":50}'
```

Expected run fields include:

```json
{
  "id": "RUN_ID",
  "trigger": "manual",
  "startedAt": 0,
  "finishedAt": 0,
  "status": "ok",
  "detail": "optional bounded summary"
}
```

`lastRunAt` records run start, not success. Run history keeps only 20 entries.
An `ok` run can still have intentionally produced no message.

A manual smoke run exercises the saved prompt/tool path. It does not prove that
the external listener is connected, that matching/filtering works, or that a
source-specific event context will arrive. End-to-end listener verification
needs a deliberate real event inside the configured scope; do not create one if
that would cause an external side effect the user did not authorize.

## Enable, pause, and resume

```sh
grok-bot service set-agent-automation-enabled --json \
  '{"id":"AGENT_ID","automationId":"AUTOMATION_ID","isEnabled":true}'

grok-bot service set-agent-automation-enabled --json \
  '{"id":"AGENT_ID","automationId":"AUTOMATION_ID","isEnabled":false}'
```

Both return the list and can silently no-op for a missing ID. Re-read the exact
record and verify `isEnabled`. Pausing blocks scheduled/event fires but not a
deliberate manual run.

Prefer pause before repair, incident containment, or retirement. It preserves
history and is reversible.

## Update in place

Update is a complete replacement spec, not a patch. Include `name`, `prompt`,
and `trigger`; omitted `isEnabled` preserves its current value, but including it
makes intent clear.

Save the complete wrapper shown by the live service as
`automation-update.json`:

```json
{
  "id": "AGENT_ID",
  "automationId": "AUTOMATION_ID",
  "spec": {
    "name": "Weekday brief",
    "prompt": "Review overnight changes; report only actionable items and stay silent otherwise.",
    "trigger": {
      "type": "cron",
      "schedule": "CRON_TZ=Europe/London 45 8 * * 1-5"
    },
    "isEnabled": false
  }
}
```

```sh
chmod 600 automation-update.json
node .agents/skills/grok-bot-automations/scripts/validate-automation-spec.mjs \
  --file automation-update.json
grok-bot service update-agent-automation --file automation-update.json
```

Update keeps the folder ID, created/last-run state, notices, and run history.
Invalid or missing-target updates can return an unchanged successful list.
Compare the readback field by field and optionally smoke test again before
re-enabling.

## Delete exactly once

```sh
grok-bot service delete-agent-automation --json \
  '{"id":"AGENT_ID","automationId":"AUTOMATION_ID"}' --yes
```

Deletion recursively removes the folder, configuration, and run history. There
is no trash/undo. Missing IDs are silent no-ops, so read back and prove absence.

For self-expiring prompts, choose whether the useful final state is:

- paused, preserving the run/history for inspection; or
- deleted, performing intended transient cleanup.

Default to pause. A runtime wake includes the routine folder identity, but the
prompt must still verify that identity and the routine-update tool is available.
Use self-delete only when cleanup/history loss was explicitly delegated. Do not
let untrusted event text select the ID to pause or delete.

## Observe lifecycle changes

Use a bounded diagnostic sample:

```sh
grok-bot events --count 20 automations workflows agent-activity
```

Or stream the relevant channels until interrupted:

```sh
grok-bot events automations workflows
```

The `automations` payload is `{agentId,automations}`. On a synthetic
`grok.gateway` reconnect with `possibleGap:true`, immediately re-read the
affected agent; upstream SSE cannot replay missed events.

For a persistent TUI, subscribe through RPC:

```json
{"protocol":"grok-effect-cli/v1","protocolVersion":1,"type":"request","id":"sub-1","method":"grok.subscribe","params":{"subscriptionId":"automation-watch","channels":["automations","workflows"]}}
```

Events can interleave with responses. A subscription end with
`mayHaveLostEvents:true` has the same refresh requirement.

## Listener connection checks

The reconstructed local listener-read surface covers Slack and GitHub:

```sh
grok-bot service get-listener-integrations
```

`getListenerConnectUrl` returns sensitive output. Request only the intended
platform and hand it directly to a private opener or protected UI surface; do
not print or log it. This subshell demonstrates bounded capture and cleanup:

```sh
(
  umask 077
  connect_url_file="$(mktemp "${TMPDIR:-/tmp}/grok-bot-listener-url.XXXXXX")"
  trap 'rm -f "$connect_url_file"' EXIT
  grok-bot --output raw service get-listener-connect-url \
    --json '{"platform":"slack"}' > "$connect_url_file"
  # Feed connect_url_file to the approved private opener here; never cat it.
)
```

These are Cursor account listener connections, not `connectChannel` token
connections. Never ask the user to paste a Slack/GitHub listener token. Saving a
missing integration can surface a connection card.

Teams, Linear, Sentry, and PagerDuty are backend-integration sources and do not
appear in the reconstructed Slack/GitHub listener list. Their absence there does
not invalidate the trigger type; verify through live save/readback and backend
connection feedback.

## Stock 0.30 webhook

On a live stock host that advertises the method and accepts `{type:"webhook"}`:

```sh
(
  umask 077
  credential_file="$(mktemp "${TMPDIR:-/tmp}/grok-bot-webhook.XXXXXX")"
  trap 'rm -f "$credential_file"' EXIT
  grok-bot --output raw service get-automation-webhook-credential --json \
    '{"id":"AGENT_ID","automationId":"AUTOMATION_ID"}' --yes \
    > "$credential_file"
  # Feed credential_file to the approved secret-aware client here.
)
```

The open response requires `url` and `key`, where `key:null` means minting is in
progress. The stock UI polls immediately, then every two seconds, up to 15
attempts. The example redirects the response before it can reach an ordinary
terminal or transcript; replace the temporary file with an approved secret sink
when one exists. Treat the call as destructive/sensitive and avoid blind retry.

Only this invocation envelope is proven:

```text
method: POST
url: credential.url
secret header name: Authorization
secret header value: Bearer <credential.key>
request body: none (the only proven form)
```

Pass the protected credential directly to a secret-aware HTTP client or
mode-0600 request configuration. Do not expand the bearer value in command-line
arguments, shell history, process diagnostics, logs, or TUI fields. No content
type, response, retry, or exactly-once contract is proven.

## Workflows versus automations

A plain workflow is a reusable global skill; a scheduled workflow is projected
into the same per-agent automation store.

Plain workflow:

```json
{
  "id": "AGENT_ID",
  "spec": {
    "name": "Release checklist",
    "description": "Repeatable release verification.",
    "body": "Inspect the diff, run checks, and summarize blockers.",
    "trigger": null,
    "sourceRef": null
  }
}
```

Save that as mode-0600 `workflow-create.json`, then preflight and dispatch it:

```sh
chmod 600 workflow-create.json
node .agents/skills/grok-bot-automations/scripts/validate-automation-spec.mjs \
  --kind workflow --file workflow-create.json
grok-bot service create-agent-workflow --file workflow-create.json
```

Scheduled workflow (cron only):

Save this as mode-0600 `scheduled-workflow-create.json`:

```json
{
  "id": "AGENT_ID",
  "spec": {
    "name": "Scheduled release check",
    "description": "",
    "body": "Check release readiness and report blockers.",
    "trigger": {
      "schedule": "0 9 * * 1-5",
      "isEnabled": false
    },
    "sourceRef": null
  }
}
```

Preflight with the intended zone, then dispatch the same file:

```sh
chmod 600 scheduled-workflow-create.json
node .agents/skills/grok-bot-automations/scripts/validate-automation-spec.mjs \
  --kind workflow --file scheduled-workflow-create.json --time-zone UTC
grok-bot service create-agent-workflow --file scheduled-workflow-create.json
```

Omit `--time-zone` when the workflow schedule contains its own `CRON_TZ=` or
`TZ=` prefix. A plain workflow with `trigger:null` needs no timezone.

After projection, manage enablement through automation services.
`setAgentWorkflowEnabled` is reconstructed/legacy only and controls ordinary
user-workflow invocation; it does not pause the automation projection.

Other important workflow facts:

- workflow update is full replacement;
- event listeners must be created as automations;
- deleting a plain user workflow removes it from the global library and affects
  every assistant, so per-agent disable is safer;
- managed/plugin workflows may refuse delete/update;
- Markdown import discards trigger frontmatter and creates a plain workflow;
- URL import creates a mutable live reference, not a frozen copy; and
- run-now on a plain workflow admits a referenced prompt, while run-now on a
  scheduled projection takes the manual automation path.

Read and verify:

```sh
grok-bot service get-agent-workflows --json '{"id":"AGENT_ID"}'
grok-bot service run-agent-workflow-now --json \
  '{"id":"AGENT_ID","workflowId":"WORKFLOW_ID"}'
grok-bot service delete-agent-workflow --json \
  '{"id":"AGENT_ID","workflowId":"WORKFLOW_ID"}' --yes
```

## Teach a workflow, then schedule deliberately

Teach recording is adjacent to automation: it can produce the managed
`learn-from-demonstration` workflow, which can later inform a saved routine.

```sh
grok-bot service get-teach-recording-status
grok-bot service start-teach-recording --json \
  '{"agentId":"AGENT_ID","entryPoint":"cli"}'
grok-bot events --count 10 teach-recording
grok-bot service stop-teach-recording --json \
  '{"agentId":"AGENT_ID","save":true}' --yes
```

Use `save:false` only for an explicit irreversible discard. Recording requires
the feature gate/private monitor, is globally single-active, and caps at ten
minutes. Save queues a signed recording and idempotently admits a learning
prompt; it does not prove learning completed. Watch transcript/events.

## Failure diagnosis

| Symptom | Evidence to inspect | Likely correction |
| --- | --- | --- |
| Create returned success but no routine | before/after IDs, count 50, normalized spec | fix spec/cap; never blind retry |
| Update/enable/delete changed nothing | exact folder ID and returned list | resolve correct ID; send full spec |
| Cron `nextRunAt:null` | schedule, timezone, search horizon | preflight valid portable cron |
| Re-enabled cron shows odd/past next time | last-run/creation anchor and backend status | let backend reconcile; inspect actual fire |
| Slack channel listener silent | integration, scope, app membership | `/invite @Cursor`; check private visibility |
| GitHub CI listener silent | repo, branch, normalized events | add exact `ciBranch`; distinguish branch CI from PR checks |
| Review listener too narrow | allowlist actor and PR owner | correct both identities or remove allowlist |
| Teams/Linear/Sentry/PD silent | backend connection/write feedback | reconnect account; no local fallback |
| Mixed group partially dead | Slack DM plus backend member | split into separate routines |
| Repeated/combined event output | newest runs, event/coalesced IDs | batch-safe prompt and stable dedupe |
| Run status `ok`, no message | prompt's silent path | expected unless actionable result was required |
| Manual run timed out | runs/transcript after timeout | reconcile; do not retry blindly |
| Background failure has no tray | `.runs`, transcript, automation event | diagnose connector/tool/auth state |
| Same auth failure recurs | prior routine messages/runs | pause and name exact reconnection |
| Many routines paused together | spend guard, unread/runs, auth/readiness | review guard prompt and resume intended IDs |
| State after reconnect is inconsistent | `grok.gateway possibleGap` | refresh snapshots before deciding |

## Spend-guard diagnosis

After three days without opening the chat, the reconstructed guard becomes
eligible when unread messages reach 15 or routine runs since last view reach 20.
If the user does not return or answer for another three days, it disables all
enabled routines for that agent. Choosing keep snoozes the guard for 30 days;
resume restores only the IDs it paused. The current guard counts stored runs by
`startedAt`, so manual runs are included. This is the first explanation to check
when several unrelated routines become disabled at once.
