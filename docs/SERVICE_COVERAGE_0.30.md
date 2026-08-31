# Grok Bot service coverage through 0.30

This is the completion ledger for the Effect CLI. It separates three claims
that are easy to conflate:

1. **Client catalog coverage** means the CLI knows the exact public gateway
   method name and can call it on a stock host.
2. **Reconstructed-host coverage** means this repository implements that exact
   method locally.
3. **Default MCP exposure** means the method also passes the MCP safety policy.

A method can satisfy the first without satisfying the other two. Runtime
capability and entitlement errors from the target host remain authoritative.

## Audited release surfaces

The baseline is this repository's reconstructed 0.18 source at commit
`a9f633e09d49a85829b8236331b9e21f7e612634`; working-tree changes were
excluded from the baseline inventory. The target is the public Grok Bot
0.30.0 Windows x64 package. This is a static package audit, not a claim that
every method is enabled for every account.

The audited installer was
`Grok_Bot_0.30.0_Setup.exe` (115,165,088 bytes), downloaded from the
[stable Windows x64 release URL](https://downloads.cursor.com/grokbot/stable/win32-x64/0.30.0/Grok_Bot_0.30.0_Setup.exe).
Its SHA-256 is
`cb1a5ef75b4d3ebeee7e7833ecdd66440e2639864f255e18ec6d5029058e814d`.
The extracted `app.asar` is 31,765,314 bytes with SHA-256
`cb90921d946e51b19bc541089eecc7fbb4210027d766a4e787fe5572eb3a1def`;
its embedded `package.json` reports version `0.30.0` and has SHA-256
`f4539f9949aef49b3250e0ed806604391c883e9a64fc6f514b390e166e05d40d`.

| Surface | 0.18 | 0.30 | Added | Removed |
|---|---:|---:|---:|---:|
| Gateway methods | 122 | 147 | 39 | 14 |
| Renderer coordinator methods | 89 | 122 | 39 | 6 |
| Electron main methods | 121 | 173 | 57 | 5 |
| Gateway event families | 17 | 18 | 2 | 1 |
| `aiserver.v1.GrokBotService` RPCs | 30 | 106 | 76 | 0 |

The following counts are deliberately different measures:

| Measure | Count | Meaning |
|---|---:|---|
| Stock 0.30 gateway catalog | 147 | Every method name declared by the audited public 0.30 gateway |
| Reconstructed-host methods | 166 | 122 reconstructed 0.18 methods, 17 exact-name 0.30 backports, and 27 headless extensions |
| Client union catalog | 188 | 147 stock 0.30 names, 14 removed-0.18 compatibility names, and 27 headless extensions |

Consequently, catalog completeness is not local-runtime completeness. The
client can address all 147 audited stock names when connected to a stock 0.30
host, subject to live availability and entitlement. This reconstructed host
implements 17 of the 39 exact additions and does not fabricate the remaining
22. Each descriptor distinguishes `grokBot030` from `reconstructedHost`; count
invariant tests protect those flags.

A stock host does not need to implement this reconstruction's
`listGatewayServices`: the client falls back to the audited manifest. Future
or experimental names remain reachable only through the explicit
`call NAME --allow-unknown` or per-request RPC opt-in.

## Exact gateway additions: 39 of 39 catalogued

| Reconstructed-host status | Count | Exact 0.30 method names |
|---|---:|---|
| Implemented under the exact name | 17 | `authenticateMcpServer`, `getAgentNotificationAvatar`, `getEffectiveMcpPlugins`, `getMcpCatalog`, `getMcpPluginLogo`, `getMcpState`, `installMcpEntry`, `interruptAgentRun`, `listMcpServerTools`, `removeMcpAccount`, `removeMcpServer`, `renameMcpAccount`, `setMcpCustomInstructions`, `toggleMcpToolDisabled`, `transcribeAudio`, `uninstallMcpPlugin`, `updateMcpPluginInstall` |
| Addressable on stock 0.30; specialized adapter still needed locally | 1 | `generateAgentAvatarImage` |
| Explicit credential/desktop boundary | 2 | `getAutomationWebhookCredential`, `injectChromeCookies` |
| Needs genuine post-0.18 runtime or protocol state | 19 | `createAgentFromTemplate`, `deleteBotTemplate`, `discardDraft`, `dismissUserForm`, `getBotTemplateExportPolicy`, `getBotTemplateForSourceAgent`, `getBotTemplateVersion`, `getVoiceCall`, `listBotTemplates`, `nudgeVoiceCall`, `publishBotTemplate`, `readVoiceCallAgentContext`, `readVoiceCallSentMessages`, `recordVoiceCall`, `resolveVirtualCardApproval`, `sendDraft`, `setBotTemplateVisibility`, `submitUserForm`, `voteFeedback` |

The exact MCP adapters added by this work are announced through the
`mcp030CompatibilityV1` host capability. They validate alternate snake/camel
argument spellings, bound plugin-logo data, and recursively redact credential
fields from returned management state. MCP installation, update, removal,
authentication, account mutation, custom instructions, and tool toggles are
not in the default read-only tool projection.

MCP exposure is intentionally narrower than either catalog. Named tools never
include the open-ended `executeRoutedMcpTool`, `refreshMcp`, or
`setHostSettings` multiplexers, even when write/destructive/sensitive flags are
enabled. One-shot calls and the full-authority NDJSON bridge retain these
methods, and the unsafe raw MCP bridge requires a separate operator opt-in.
The recovered stock 0.30 watch implementation can block for up to five hours.
The reconstructed `watchCloudAgent` extension deliberately provides one
bounded, nonblocking status snapshot instead; it is available as a named MCP
read gated by `--include-sensitive`.

The reconstructed Cloud Agent boundary also awaits the team-admin disable
policy before launch/follow-up writes, limits prompt images to 8 supported
image types and 25 MiB decoded in aggregate, and projects transcript JSONL to
at most 2,000 complete lines / 2 MiB with explicit truncation metadata.

The specialized `attachment upload` command accepts up to 25 MiB for ordinary
files and 200 MiB for supported video extensions (`.m4v`, `.mov`, `.mp4`,
`.ogv`, and `.webm`). It selects a reconstructed-only raw HTTP stream when the
host advertises `attachmentUploadStreamV1`; stock 0.30 and other hosts without
that capability receive an incremental canonical base64 JSON
`uploadAttachment` request. Neither path retains a complete base64 copy in the
CLI, but the fallback remains subject to the target's JSON request limit. The
reconstructed gateway's JSON request cap is 64 MiB, so reaching the complete
200 MiB video limit requires a raw-capable reconstructed host. MCP retains a
64 MiB hard frame ceiling and NDJSON RPC remains fixed at 40 MiB; neither can
carry that envelope.

The remaining specialized adapter was deliberately not faked. Available 0.30
evidence conflicts over whether avatar generation returns a data URL, raw
`{ imageData, mimeType }`, or a persisted attachment record, and generation
can be billable. On a host that advertises it, named MCP therefore requires
both destructive and sensitive gates. The exact notification-avatar adapter is
metadata-only and returns deterministic shape/color plus stored avatar
metadata. Transcription
strictly validates base64/base64url input, caps decoded audio at 25 MiB,
normalizes media/language metadata, preserves the 60-second backend deadline,
and returns `{ text, transcriptionTimeMs }`. `interruptAgentRun` is backed by
the local direct/group runner registries and preserves the exact 0.30
`{ id } -> { hadActiveRun }` contract.

The two credential boundaries are also deliberate. A webhook key could be
minted through an older dashboard RPC, but the result is a new secret. Browser
cookie injection transfers live session credentials and has no sanctioned
headless 0.18 primitive. Neither is a default MCP tool.

## Gateway removals retained for compatibility

The following 14 reconstructed names are absent from the public 0.30 gateway
declaration. The CLI keeps them for 0.18/reconstructed-host compatibility but
marks them as not part of the 0.30 surface:

- `appendConnectorCard`, `autoUpdateBoxNow`, `clearBoxStoreNow`, `deleteAgent`;
- `executeRoutedMcpTool`, `getBoxStoreStatus`, `isAgentNetworkEnabled`,
  `listRoutedMcpTools`;
- `prepareBoxForRecreate`, `resetForeverBox`, `resumeBoxAfterRecreate`,
  `setAgentWorkflowEnabled`, `setBoxMigrating`, `snapshotBoxStoreNow`.

`deleteAgent` has the straightforward 0.30 equivalent
`deleteAgents({ ids: [id] })`. The host-lifecycle operations remain useful to
this reconstruction. Direct routed-MCP execution is not silently remapped,
because doing so could bypass the newer catalog, account, and disabled-tool
policy.

## Events

The raw SSE channel names accepted by the CLI are:

`transcript`, `client-side-tool-v2`, `agents`, `agent-upserted`, `outline`,
`subagents`, `async-tasks`, `automations`, `workflows`, `memory`, `tray`,
`forever-box`, `teach-recording`, `mcp-servers`, `sharing`, `host-settings`,
`box-disk-pressure`, `computer-action`, `agent-activity`, `mcp-auth`,
`auth-status`, and `local-tool-permission`.

The public 0.30 family names map `agents-workflow` to `workflows`,
`agents-automation` to `automations`, `mcp-servers-updated` to `mcp-servers`,
and `mcp-auth-completed` to `mcp-auth`. It adds `agent-activity` and MCP auth;
the older `client-side-tool-v2` family is retained only for compatibility.
This reconstruction additionally emits sanitized auth and local-permission
diagnostic channels. On reconnect, the client emits synthetic channel
`grok.gateway` with `possibleGap: true`, because upstream SSE has no replay
cursor.

## Backend growth inventory

The public `GrokBotService` descriptor grew without removing any of the
original 30 methods:

| Release | RPC count | Main additions |
|---:|---:|---|
| 0.18 | 30 | Reconstructed baseline |
| 0.24 | 47 | Agent/template CRUD, transcript commit/list, upgrade scheduling |
| 0.25 | 74 | Turn control, approvals, user-computer streams, reactions, voice secret |
| 0.26 | 75 | Attachment chunk reads |
| 0.27 | 76 | Template visibility |
| 0.28 | 82 | Slack lifecycle and agent visibility |
| 0.29 | 89 | Internal marketplace administration |
| 0.30 | 106 | Temporal agents, runtime capabilities, public marketplace, virtual cards |

The newer package also contains a separate 37-method `SandBoxService`. It is
mostly a split/alias of sandbox operations already carried by the older
`GrokBotService`; the CLI intentionally exposes one box domain instead of two
duplicate namespaces.

Internal marketplace administration, raw secret issuance, cookie import,
account switching, desktop persistence, and other Electron-only operations
are inventory evidence, not ordinary TUI tools. Public template marketplace
reads and newer interactive workflows cannot be reconstructed faithfully
until their post-0.18 protobuf messages and state machinery are present.

## 0.31 preview observation

The public `0.31.0-pre.14.patch.0` dogfood package still declares 106
`GrokBotService` RPCs. Its coordinator preview adds
`resolveAgentCreation`, `restoreTemporalAgentRouting`, `noteMountedAgent`, and
`getServerAgentRoster`; Electron main adds bot-color preferences and
`stageAttachmentPath`. These are recorded as preview evidence only and are not
claimed as stable CLI contracts.

## Verification boundary

This audit proves that names and descriptors shipped in one public Windows x64
package. It does not prove runtime behavior, cross-platform identity, result
shape for every code path, or that every account, team, experiment, or region
is entitled to invoke every method. The CLI therefore exposes live capability
negotiation, structured host errors, conservative MCP defaults, explicit
destructive confirmation, and a raw unknown-method escape hatch instead of
fabricating successful parity.
