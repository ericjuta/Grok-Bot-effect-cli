import { randomUUID } from "node:crypto";
import { BackgroundComposerService } from "../../../packages/proto/generated/aiserver/v1/background_composer_connect.js";
import { DashboardService } from "../../../packages/proto/generated/aiserver/v1/dashboard_connect.js";
import { createSandCursorBackendClient } from "../../../shared/node/cursor-backend/cursor-inference.js";
import { buildWatchResult, CloudAgentCompletionPoller, CloudAgentModelCatalogCache, CloudAgentTeamAdminPolicyCache, resolveSandLimitError, resolveSavedEnvironment, type Clock, type DetailedComposer, type PollingPolicy, type SavedEnvironmentClient } from "./cloud-agent-poll-loop.js";
import { SandCloudAgentDisabledError, SandCloudAgentLaunchError } from "./cloud-agent-launch-error.js";
import { buildCloudAgentConversationAction, buildCloudAgentRequestedModel, buildCloudAgentUserMessage, buildRepoFromRemote, resolveCloudAgentEnvironmentFields, resolveLaunchRepoReference, toStartRepoConfig, type CloudAgentEnvironment, type SavedEnvironment } from "./cloud-agent-request-composition.js";
import type { SandModelCatalogEntry } from "../../../shared/agents/model-catalog.js";
export const MAX_CLOUD_AGENT_FILES = 300;
export const MAX_CLOUD_AGENT_TRANSCRIPT_LINES = 2_000;
export const MAX_CLOUD_AGENT_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
export const MAX_CLOUD_AGENT_TRANSCRIPT_LINE_BYTES = 256 * 1024;
const MAX_CLOUD_AGENT_TRANSCRIPT_VALUE_DEPTH = 24;
const MAX_CLOUD_AGENT_TRANSCRIPT_COLLECTION_ENTRIES = 512;
const MAX_CLOUD_AGENT_TRANSCRIPT_STRING_CHARS = 32_768;
const MAX_CLOUD_AGENT_TRANSCRIPT_MESSAGE_STRING_CHARS = 131_072;
const MAX_CLOUD_AGENT_TRANSCRIPT_NODES = 20_000;
type AnyRecord = Record<string, unknown>;
export interface CloudAgentClient extends SavedEnvironmentClient {
  startBackgroundComposerFromSnapshot(request: AnyRecord): Promise<{ composer?: { bcId?: string } }>;
  getBackgroundComposerInfo(request: AnyRecord, options?: { timeoutMs: number }): Promise<{ composer?: DetailedComposer & { prompt?: { text?: string }; composer?: DetailedComposer["composer"] & { bcId?: string; name?: string; isArchived?: boolean; createdAtMs?: number; prStatus?: unknown }; prs?: readonly { prUrl?: string; branchName?: string; pullNumber?: number; prStatus?: unknown }[] } }>;
  listBackgroundComposers(request: { n: number }): Promise<{ composers: readonly AnyRecord[] }>;
  addAsyncFollowupBackgroundComposer(request: AnyRecord): Promise<{ runId?: string }>;
  pauseBackgroundComposer(request: AnyRecord): Promise<void>; renameBackgroundComposer(request: AnyRecord): Promise<void>; archiveBackgroundComposer(request: AnyRecord): Promise<void>; deleteBackgroundComposer(request: AnyRecord): Promise<void>;
  listBackgroundComposerArtifacts(request: AnyRecord): Promise<{ artifacts: readonly { absolutePath: string; sizeBytes: number | bigint }[] }>;
  getBackgroundComposerConversation(request: AnyRecord): Promise<{ conversation: unknown }>;
  getPullRequestMergeStatus(request: { prUrl: string }): Promise<{ isMerged?: boolean; isClosed?: boolean; isDraft?: boolean; state?: string }>;
  getOptimizedDiffDetails(request: AnyRecord): Promise<{ diff?: { diffs?: readonly { from: string; to: string; added: number; removed: number }[] } }>;
}
export interface DashboardClient { getTeamAdminSettingsOrEmptyIfNotInTeam(request: AnyRecord, options: { timeoutMs: number }): Promise<{ backgroundAgentSettings?: { disableCloudAgentsInSand?: boolean } }>; getTeams(request: { activeOnly: true }): Promise<{ teams: readonly { id: number; name: string; isDirectMember: boolean }[] }> }
export type NormalizedCloudAgentRunStatus = "creating" | "running" | "finished" | "error" | "expired" | "unknown";
export function mapRunStatus(status: unknown): NormalizedCloudAgentRunStatus { if (typeof status === "string") { const value = status.toLowerCase(); return value === "creating" || value === "running" || value === "finished" || value === "error" || value === "expired" ? value : "unknown"; } switch (status) { case 1: return "running"; case 2: return "finished"; case 3: return "error"; case 4: return "creating"; case 5: return "expired"; default: return "unknown"; } }
export function resolvePrUrl(detailed?: DetailedComposer & { prs?: readonly { prUrl?: string }[] }): string { return detailed?.composer?.prUrl || detailed?.prs?.find((pr) => pr.prUrl)?.prUrl || ""; }
export function resolveBranchName(detailed?: DetailedComposer & { prs?: readonly { branchName?: string }[] }): string { return detailed?.composer?.branchName || detailed?.prs?.find((pr) => pr.branchName)?.branchName || ""; }
export type CloudAgentPrState = "none" | "unknown" | "open" | "draft" | "merged" | "closed";
export function mapProtoPrStatus(status: unknown): Exclude<CloudAgentPrState, "none" | "unknown"> | null { switch (status) { case 1: return "open"; case 2: return "draft"; case 3: return "merged"; case 4: return "closed"; default: return null; } }
export function resolvePr(detailed?: DetailedComposer & { composer?: DetailedComposer["composer"] & { prStatus?: unknown } }): { state: CloudAgentPrState; number: number | null } { const url = resolvePrUrl(detailed); const primary = url.length > 0 ? detailed?.prs?.find((pr) => pr.prUrl === url) : detailed?.prs?.find((pr) => pr.pullNumber != null || mapProtoPrStatus(pr.prStatus) != null); const state = mapProtoPrStatus(primary?.prStatus) ?? mapProtoPrStatus(detailed?.composer?.prStatus) ?? (url.length > 0 || primary != null ? "unknown" : "none"); return { state, number: primary?.pullNumber ?? null }; }
export function normalizeDiffPath(raw: string): string { const value = raw.trim(); return value === "/dev/null" ? "" : value; }
export function toFileChange(diff: { from: string; to: string; added: number; removed: number }) { const from = normalizeDiffPath(diff.from), to = normalizeDiffPath(diff.to), path = to || from; return path ? { path, added: diff.added, removed: diff.removed } : null; }
export function cloudAgentUrl(bcId: string): string { return `https://cursor.com/agents/${bcId}`; }
interface TranscriptProjectionState {
  readonly seen: WeakSet<object>;
  nodes: number;
  remainingStringChars: number;
  truncated: boolean;
}

function boundedTranscriptValue(
  value: unknown,
  state: TranscriptProjectionState,
  depth = 0
): unknown {
  state.nodes += 1;
  if (state.nodes > MAX_CLOUD_AGENT_TRANSCRIPT_NODES) {
    state.truncated = true;
    return "[truncated: value limit]";
  }
  if (typeof value === "string") {
    const retained = Math.min(
      value.length,
      MAX_CLOUD_AGENT_TRANSCRIPT_STRING_CHARS,
      state.remainingStringChars
    );
    state.remainingStringChars -= retained;
    if (retained === value.length) return value;
    state.truncated = true;
    return `${value.slice(0, retained)}[truncated]`;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (
    value == null ||
    typeof value === "boolean"
  ) return value;
  if (typeof value !== "object") {
    state.truncated = true;
    return `[unsupported ${typeof value}]`;
  }
  if (depth >= MAX_CLOUD_AGENT_TRANSCRIPT_VALUE_DEPTH) {
    state.truncated = true;
    return "[truncated: depth limit]";
  }
  if (state.seen.has(value)) {
    state.truncated = true;
    return "[truncated: circular reference]";
  }
  state.seen.add(value);
  try {
    if (value instanceof Uint8Array) {
      state.truncated = true;
      return `[binary omitted: ${value.byteLength} bytes]`;
    }
    if (Array.isArray(value)) {
      if (value.length > MAX_CLOUD_AGENT_TRANSCRIPT_COLLECTION_ENTRIES) {
        state.truncated = true;
      }
      return value
        .slice(0, MAX_CLOUD_AGENT_TRANSCRIPT_COLLECTION_ENTRIES)
        .map((entry) => boundedTranscriptValue(entry, state, depth + 1));
    }
    const result: Record<string, unknown> = Object.create(null);
    let retainedEntries = 0;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      if (retainedEntries >= MAX_CLOUD_AGENT_TRANSCRIPT_COLLECTION_ENTRIES) {
        state.truncated = true;
        break;
      }
      result[key] = boundedTranscriptValue(
        (value as Record<string, unknown>)[key],
        state,
        depth + 1
      );
      retainedEntries += 1;
    }
    return result;
  } finally {
    state.seen.delete(value);
  }
}

/**
 * Produce a complete-line JSONL projection with deterministic memory and wire
 * bounds. The metadata distinguishes emitted lines from source trace lines;
 * no partial JSON object is ever returned.
 */
export function buildTranscriptJsonl(
  conversation: unknown,
  convert: (conversation: unknown) => readonly unknown[]
) {
  const messages = convert(conversation);
  const totalLineCount = messages.length;
  const lines: string[] = [];
  let byteCount = 0;
  let truncated = totalLineCount > MAX_CLOUD_AGENT_TRANSCRIPT_LINES;
  for (let index = 0; index < Math.min(
    totalLineCount,
    MAX_CLOUD_AGENT_TRANSCRIPT_LINES
  ); index += 1) {
    const state: TranscriptProjectionState = {
      seen: new WeakSet(),
      nodes: 0,
      remainingStringChars: MAX_CLOUD_AGENT_TRANSCRIPT_MESSAGE_STRING_CHARS,
      truncated: false
    };
    let line = JSON.stringify(
      boundedTranscriptValue(messages[index], state)
    );
    if (line === undefined) line = "null";
    let lineBytes = Buffer.byteLength(line) + 1;
    if (lineBytes > MAX_CLOUD_AGENT_TRANSCRIPT_LINE_BYTES) {
      state.truncated = true;
      line = JSON.stringify({
        truncated: true,
        reason: "message exceeded transcript line byte limit",
        messageIndex: index
      });
      lineBytes = Buffer.byteLength(line) + 1;
    }
    if (byteCount + lineBytes > MAX_CLOUD_AGENT_TRANSCRIPT_BYTES) {
      truncated = true;
      break;
    }
    lines.push(line);
    byteCount += lineBytes;
    truncated ||= state.truncated;
  }
  return {
    jsonl: lines.length > 0 ? `${lines.join("\n")}\n` : "",
    lineCount: lines.length,
    totalLineCount,
    byteCount,
    truncated,
    limits: {
      maxLines: MAX_CLOUD_AGENT_TRANSCRIPT_LINES,
      maxBytes: MAX_CLOUD_AGENT_TRANSCRIPT_BYTES
    }
  };
}
export interface SandCloudAgentManagerOptions { readonly getCursorAccessToken: (options?: { readonly backendUrl: string }) => Promise<string>; readonly getMachineId: () => Promise<string>; readonly completionPolling: PollingPolicy; readonly clock: Clock; readonly convertConversationMessagesToTrace: (conversation: unknown) => readonly unknown[]; readonly clientForTesting?: CloudAgentClient; readonly dashboardClientForTesting?: DashboardClient; readonly modelCatalogForTesting?: readonly SandModelCatalogEntry[]; readonly onRequestId?: (id: string) => void }
export const MAX_TRACKED_CLOUD_AGENT_IDS = 1_024;
class BoundedCloudAgentIdSet extends Set<string> {
  override add(value: string): this {
    if (this.has(value)) return this;
    while (this.size >= MAX_TRACKED_CLOUD_AGENT_IDS) {
      const oldest = this.values().next().value as string | undefined;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
    return super.add(value);
  }
}
export class SandCloudAgentManager {
  readonly launchedIds = new BoundedCloudAgentIdSet();
  private client?: CloudAgentClient; private dashboardClient?: DashboardClient; private readonly completionPoller: CloudAgentCompletionPoller; private readonly modelCatalog: CloudAgentModelCatalogCache; private readonly teamAdminPolicy: CloudAgentTeamAdminPolicyCache;
  constructor(private readonly options: SandCloudAgentManagerOptions) { this.completionPoller = new CloudAgentCompletionPoller(options, () => this.getClient()); this.modelCatalog = new CloudAgentModelCatalogCache(options); this.teamAdminPolicy = new CloudAgentTeamAdminPolicyCache({ clock: options.clock, load: async () => (await this.getDashboardClient().getTeamAdminSettingsOrEmptyIfNotInTeam({}, { timeoutMs: 10_000 })).backgroundAgentSettings ?? {} }); }
  isDisabledByTeamAdmin(): boolean { return this.teamAdminPolicy.isDisabledByTeamAdmin(); } async isDisabledByTeamAdminForWrite(): Promise<boolean> { return await this.teamAdminPolicy.readForWrite(); } prefetchTeamAdminPolicy(): void { this.teamAdminPolicy.prefetchTeamAdminPolicy(); } dispose(): void { this.completionPoller.dispose(); } listModels(): Promise<readonly SandModelCatalogEntry[]> { return this.modelCatalog.listModels(); }
  private getClient(): CloudAgentClient { return this.options.clientForTesting ?? (this.client ??= createSandCursorBackendClient(BackgroundComposerService, { getAccessToken: this.options.getCursorAccessToken, getMachineId: this.options.getMachineId, ...(this.options.onRequestId === undefined ? {} : { onRequestId: this.options.onRequestId }) }) as unknown as CloudAgentClient); }
  private getDashboardClient(): DashboardClient { return this.options.dashboardClientForTesting ?? (this.dashboardClient ??= createSandCursorBackendClient(DashboardService, { getAccessToken: this.options.getCursorAccessToken, getMachineId: this.options.getMachineId, ...(this.options.onRequestId === undefined ? {} : { onRequestId: this.options.onRequestId }) }) as unknown as DashboardClient); }
  async resolvePrivateWorkerTeamId(environment?: CloudAgentEnvironment): Promise<number | undefined> { if (environment == null || environment.type === "cloud" || environment.type === "environment") return undefined; if (environment.teamId != null) return environment.teamId; const teams = (await this.getDashboardClient().getTeams({ activeOnly: true })).teams.filter((team) => team.id > 0 && team.isDirectMember); if (teams.length === 1) return teams[0]?.id; if (teams.length === 0) { if (environment.type === "pool") throw new SandCloudAgentLaunchError("A self-hosted pool requires an active team, but this account has none."); return undefined; } throw new SandCloudAgentLaunchError(`This account has multiple active teams. Set environment.team_id to one of: ${teams.map((team) => `${team.name} (${team.id})`).join(", ")}.`); }
  async launch(args: { prompt: string; repoUrl?: string; startingRef?: string; environment?: CloudAgentEnvironment; modelId?: string; modelParams?: Readonly<Record<string, string>>; images?: readonly { data: Uint8Array; path?: string; mimeType?: string }[]; title?: string }) { if (await this.isDisabledByTeamAdminForWrite()) throw new SandCloudAgentDisabledError(); if (args.environment?.type === "machine" && args.startingRef?.trim()) throw new SandCloudAgentLaunchError(`A named private worker runs on its own checkout, so it can't start from '${args.startingRef}'. Omit starting_ref (the worker uses its current branch), or use a cloud or pool environment to start from a specific ref.`); const saved = args.environment?.type === "environment" ? await resolveSavedEnvironment(this.getClient(), { ...(args.environment.publicId === undefined ? {} : { publicId: args.environment.publicId }), ...(args.environment.name === undefined ? {} : { name: args.environment.name }) }) as SavedEnvironment : undefined, repo = buildRepoFromRemote(resolveLaunchRepoReference(args.repoUrl, saved), args.startingRef), requestedModel = buildCloudAgentRequestedModel(args.modelId, args.modelParams), bcId = `bc-${randomUUID()}`, teamId = await this.resolvePrivateWorkerTeamId(args.environment); const request: AnyRecord = { bcId, snapshotNameOrId: repo.sanitizedRepoUrl, devcontainerStartingPoint: { url: repo.httpRepoUrl, ref: repo.baseBranch ?? "", ...(saved == null ? {} : { environmentPublicId: saved.publicId, ...(saved.name.trim() ? { environmentName: saved.name.trim() } : {}), repoConfig: toStartRepoConfig(saved.repoConfig) }) }, snapshotWorkspaceRootPath: "/workspace", returnImmediately: true, repoUrl: repo.httpRepoUrl, source: "grok-bot", autoBranch: true, ...(repo.baseBranch === undefined ? {} : { baseBranch: repo.baseBranch }), autoCreatePr: true, conversationAction: buildCloudAgentConversationAction(buildCloudAgentUserMessage({ prompt: args.prompt, mode: "agent", ...(args.images === undefined ? {} : { images: args.images }) })), startingMessageType: "user-message", addInitialMessageToResponses: true, repositoryInfo: { pathEncryptionKey: "", shouldSyncIndex: false }, ...resolveCloudAgentEnvironmentFields(repo.httpRepoUrl, args.environment), requestedModels: requestedModel == null ? [] : [requestedModel], skills: [], ...(teamId === undefined ? {} : { teamId }), ...(args.title?.trim() ? { name: args.title.trim() } : {}) }; const response = await this.getClient().startBackgroundComposerFromSnapshot(request), id = response.composer?.bcId || bcId; return { bcId: id, url: cloudAgentUrl(id) }; }
  awaitCompletion(bcId: string, options?: { waitForRestart?: boolean }) { return this.completionPoller.awaitCompletion(bcId, options); }
  async getWatchStatus(bcId: string, options?: { waitForRestart?: boolean }) {
    const id = bcId.trim();
    const detailed = (await this.getClient().getBackgroundComposerInfo(
      { bcId: id, includeDiff: false, doNotThrowIfSetupNotFinished: true },
      { timeoutMs: 30_000 }
    )).composer;
    if (detailed?.composer == null) return null;
    const runStatus = mapRunStatus(detailed?.composer?.status);
    if (
      runStatus === "creating" ||
      runStatus === "running" ||
      runStatus === "unknown"
    ) {
      return {
        status: runStatus,
        runStatus,
        terminal: false,
        text: `The Cursor agent (${id}) is ${runStatus}. Poll watchCloudAgent again for current status.`
      };
    }
    if (options?.waitForRestart === true) {
      return {
        status: "waiting_for_restart",
        runStatus,
        terminal: false,
        text: `The Cursor agent (${id}) has not restarted yet. Poll watchCloudAgent again for current status.`
      };
    }
    return {
      ...buildWatchResult(id, runStatus, detailed),
      runStatus,
      terminal: true
    };
  }
  async list(args?: { limit?: number; includeArchived?: boolean }) { const response = await this.getClient().listBackgroundComposers({ n: args?.limit ?? 20 }); return response.composers.filter((composer) => (args?.includeArchived ?? false) || composer.isArchived !== true).map((composer) => ({ bcId: String(composer.bcId ?? ""), name: String(composer.name ?? ""), status: mapRunStatus(composer.status), branchName: String(composer.branchName ?? ""), prUrl: String(composer.prUrl ?? ""), isArchived: composer.isArchived === true, createdAtMs: Number(composer.createdAtMs ?? 0), url: cloudAgentUrl(String(composer.bcId ?? "")) })); }
  async get(bcId: string) { const id = bcId.trim(); if (!id) return null; const detailed = (await this.getClient().getBackgroundComposerInfo({ bcId: id, includeDiff: false, doNotThrowIfSetupNotFinished: true })).composer, composer = detailed?.composer; if (composer == null) return null; return { bcId: id, name: composer.name ?? "", status: mapRunStatus(composer.status), branchName: resolveBranchName(detailed), prUrl: resolvePrUrl(detailed), isArchived: composer.isArchived ?? false, createdAtMs: composer.createdAtMs ?? 0, url: cloudAgentUrl(id), filesChanged: composer.filesChanged ?? 0, linesAdded: composer.linesAdded ?? 0, linesRemoved: composer.linesRemoved ?? 0, error: resolveSandLimitError(detailed) }; }
  async reply(args: { bcId: string; prompt: string; images?: readonly { data: Uint8Array; path?: string; mimeType?: string }[]; interrupt?: boolean; modelId?: string; modelParams?: Readonly<Record<string, string>> }) { if (await this.isDisabledByTeamAdminForWrite()) throw new SandCloudAgentDisabledError(); const requestedModel = buildCloudAgentRequestedModel(args.modelId, args.modelParams), response = await this.getClient().addAsyncFollowupBackgroundComposer({ bcId: args.bcId, followupConversationAction: buildCloudAgentConversationAction(buildCloudAgentUserMessage({ prompt: args.prompt, ...(args.images === undefined ? {} : { images: args.images }) })), synchronous: args.interrupt ?? false, followupSource: "grok-bot", ...(requestedModel == null ? {} : { requestedModel }) }); return { runId: response.runId }; }
  async cancel(bcId: string): Promise<void> { await this.getClient().pauseBackgroundComposer({ bcId, source: "grok-bot" }); } async rename(bcId: string, newName: string): Promise<void> { await this.getClient().renameBackgroundComposer({ bcId, newName }); } async setArchived(bcId: string, archived: boolean): Promise<void> { await this.getClient().archiveBackgroundComposer({ bcId, unarchive: !archived, source: "grok-bot" }); } async delete(bcId: string): Promise<void> { await this.getClient().deleteBackgroundComposer({ bcId }); }
  async listArtifacts(bcId: string) { return (await this.getClient().listBackgroundComposerArtifacts({ bcId })).artifacts.map((artifact) => ({ path: artifact.absolutePath, sizeBytes: Number(artifact.sizeBytes) })); }
  async getTranscriptDump(args: { bcId: string }) { const bcId = args.bcId.trim(); if (!bcId) return null; const response = await this.getClient().getBackgroundComposerConversation({ bcId }), dump = buildTranscriptJsonl(response.conversation, this.options.convertConversationMessagesToTrace); let status = "unknown"; try { status = mapRunStatus((await this.getClient().getBackgroundComposerInfo({ bcId, includeDiff: false, doNotThrowIfSetupNotFinished: true })).composer?.composer?.status); } catch {} return { ...dump, status }; }
  async getInfo(bcId: string, includeFiles = true) { const id = bcId.trim(); if (!id) return null; let response: Awaited<ReturnType<CloudAgentClient["getBackgroundComposerInfo"]>>; try { response = await this.getClient().getBackgroundComposerInfo({ bcId: id, includeDiff: false, doNotThrowIfSetupNotFinished: true }); } catch (error) { const candidate = error as { name?: unknown; code?: unknown }; if (candidate?.name === "ConnectError" && (candidate.code === 5 || candidate.code === 7)) return null; throw error; } const detailed = response.composer, composer = detailed?.composer, filesChanged = composer?.filesChanged ?? 0, pr = resolvePr(detailed), prUrl = resolvePrUrl(detailed); const [files, livePrState] = await Promise.all([includeFiles && filesChanged > 0 ? this.fetchFileChanges(id) : Promise.resolve([]), this.fetchLivePrState(prUrl, pr.state)]); return { bcId: id, status: mapRunStatus(composer?.status), name: composer?.name ?? "", prompt: detailed?.prompt?.text ?? "", branchName: resolveBranchName(detailed), prUrl, prState: livePrState ?? pr.state, prNumber: pr.number, filesChanged, linesAdded: composer?.linesAdded ?? 0, linesRemoved: composer?.linesRemoved ?? 0, files }; }
  async fetchLivePrState(prUrl: string, storedState: string): Promise<string | null> { if (!prUrl || storedState === "merged") return null; try { const value = await this.getClient().getPullRequestMergeStatus({ prUrl }); return value.isMerged ? "merged" : value.isClosed ? "closed" : value.isDraft ? "draft" : value.state === "open" ? "open" : null; } catch { return null; } }
  async fetchFileChanges(bcId: string) { try { const response = await this.getClient().getOptimizedDiffDetails({ bcId, excludeBeforeAfterDiffs: true }), changes: { path: string; added: number; removed: number }[] = []; for (const diff of response.diff?.diffs ?? []) { const change = toFileChange(diff); if (change != null) changes.push(change); if (changes.length >= MAX_CLOUD_AGENT_FILES) break; } return changes; } catch { return []; } }
}
