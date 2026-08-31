import { DashboardService } from "../../../packages/proto/generated/aiserver/v1/dashboard_connect.js";
import {
  createAccountMcpWriter,
  fetchAccountMcpServers,
  fetchEffectiveUserPlugins,
  type AccountMcpClient,
  type AccountMcpDependencies,
} from "../../../shared/node/cursor-backend/account-mcp.js";
import {
  createDashboardSandBackendMcpExec,
  type DashboardMcpExecClient,
} from "../../../shared/node/cursor-backend/backend-mcp-exec.js";
import {
  createSandCursorBackendClient,
  getSandInferenceBackendUrl,
} from "../../../shared/node/cursor-backend/cursor-inference.js";
import { SandMcpManager } from "../../../shared/node/mcp/mcp-manager.js";
import {
  createMcpToolsDiscovery,
  SandMcpExecutor,
} from "../../../shared/node/mcp/tools-discovery.js";
import {
  isEffectivePluginInstalled,
  uninstallClearedInstallRecord,
} from "../../../shared/mcp.js";
import type { CapableBox } from "../../box/box-capabilities.js";
import { createSandMcpStateExecutor } from "../../ports/mcp-state-executor.js";
import { createBoxSandMcpExec } from "./box-mcp-exec.js";

export interface McpServerSummary { id: string; name: string; serverIdentifier: string; accountKey: string; rowServerIdentifier?: string; pluginId?: string | null; isTeamServer: boolean; isRequired?: boolean; managedByTeamPluginPolicy?: boolean; status: string; statusDetail?: string; transport: string; command?: string; url?: string; toolCount: number; disabledToolCount?: number; customInstructions: string }
export interface CatalogField { key: string; label: string; placeholder?: string; hint?: string; isRequired?: boolean; isSecret?: boolean; defaultValue?: string }
export interface CatalogPlugin { id: string; name: string; displayName?: string; description?: string; category?: string; homepage?: string; iconUrl?: string; fields?: CatalogField[]; connectors?: Array<{ name: string; description?: string }>; skills?: Array<{ name: string; description?: string; sourceUrl?: string }>; marketplace?: { name: string; displayName: string; ownership: string }; publisher?: { name: string; displayName: string; isUserOwned: boolean } }
export interface EffectivePlugin { pluginId: string; name?: string; displayName?: string; installMode?: string; isEnabled: boolean; hasTeamConfiguredVariables?: boolean }
export interface ServerState { servers: McpServerSummary[] }
export interface PluginSkillsPort { sync(trigger: string): Promise<unknown[]>; status(): unknown; removeLiveReferences?(sourceUrls: readonly string[]): void }

export const MCP_PLUGIN_LOGO_DATA_URL_MAX_LENGTH = 700_000;
export const MCP_PUBLIC_FIELD_MAX_LENGTH = 4_096;

const MCP_SECRET_FIELD_NAME = /(?:^|[_-])(?:access[_-]?token|api[_-]?key|auth(?:orization)?|bearer|client[_-]?secret|credential|password|private[_-]?key|refresh[_-]?token|secret|session[_-]?token|token)(?:$|[_-])/i;
const MCP_SECRET_COMMAND_ARGUMENT = /(?:^|\s)(?:--?)?(?:access[-_]?token|api[-_]?key|auth(?:orization)?|bearer|client[-_]?secret|credential|password|private[-_]?key|refresh[-_]?token|secret|session[-_]?token|token)(?:\s|=|:|$)/i;
const MCP_CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

function boundedPublicString(value: unknown, maximum = MCP_PUBLIC_FIELD_MAX_LENGTH): string | undefined {
  return typeof value === "string" && value.length <= maximum && !MCP_CONTROL_CHARACTER.test(value)
    ? value
    : undefined;
}

/** A URL is useful management state, but user-info and credential-like query keys are not. */
export function safeMcpServerUrl(value: unknown): string | undefined {
  const raw = boundedPublicString(value);
  if (raw == null || raw.trim() !== raw) return undefined;
  try {
    const parsed = new URL(raw);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username.length > 0 || parsed.password.length > 0) return undefined;
    for (const key of parsed.searchParams.keys()) if (MCP_SECRET_FIELD_NAME.test(key) || /^(?:code|key|sig|signature)$/i.test(key)) return undefined;
    if (/(?:access[_-]?token|api[_-]?key|authorization|client[_-]?secret|credential|password|private[_-]?key|refresh[_-]?token|secret|session[_-]?token|signature|token)\s*[=:]/i.test(parsed.hash)) return undefined;
    return raw;
  } catch {
    return undefined;
  }
}

/** Command summaries never include env/header maps; also omit secret-bearing argv. */
export function safeMcpServerCommand(value: unknown): string | undefined {
  const command = boundedPublicString(value);
  if (command == null || command.trim() !== command || MCP_SECRET_FIELD_NAME.test(command) || MCP_SECRET_COMMAND_ARGUMENT.test(command)) return undefined;
  if (/(?:^|\s)(?:authorization|proxy-authorization)\s*[:=]/i.test(command) || /\bbearer\s+[a-z0-9._~+/-]+/i.test(command)) return undefined;
  return command;
}

function catalogFieldIsSecret(field: CatalogField): boolean {
  return field.isSecret === true || MCP_SECRET_FIELD_NAME.test(field.key);
}

function safeCatalogFieldHint(field: CatalogField, secret: boolean): string | undefined {
  const hint = boundedPublicString(field.hint);
  if (hint == null || !secret) return hint;
  if (/\bdefaults?(?:\s+to|\s*[:=])|\bdefault\s+value\b/i.test(hint)) {
    return "A configured secret default is hidden.";
  }
  return field.defaultValue != null && field.defaultValue.length > 0
    ? hint.split(field.defaultValue).join("[REDACTED]")
    : hint;
}

function safeMcpStatusDetail(value: unknown): string | undefined {
  const detail = boundedPublicString(value, 1_024);
  if (detail == null) return undefined;
  return detail
    .replace(/\bbearer\s+[a-z0-9._~+/-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(access[_-]?token|api[_-]?key|authorization|client[_-]?secret|credential|password|refresh[_-]?token|secret|session[_-]?token|token)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1=[REDACTED]");
}

export function toInstalledServer(summary: McpServerSummary): Record<string, unknown> {
  const rowServerIdentifier = boundedPublicString(summary.rowServerIdentifier);
  const command = safeMcpServerCommand(summary.command);
  const url = safeMcpServerUrl(summary.url);
  const statusDetail = safeMcpStatusDetail(summary.statusDetail);
  return {
    id: summary.id,
    name: summary.name,
    serverIdentifier: summary.serverIdentifier,
    accountKey: summary.accountKey,
    ...(rowServerIdentifier == null ? {} : { rowServerIdentifier }),
    ...(summary.pluginId == null ? {} : { pluginId: summary.pluginId }),
    isTeamServer: summary.isTeamServer,
    ...(summary.isRequired === true ? { isRequired: true } : {}),
    ...(summary.managedByTeamPluginPolicy === true ? { managedByTeamPluginPolicy: true } : {}),
    status: summary.status,
    ...(statusDetail == null ? {} : { statusDetail }),
    transport: summary.transport,
    ...(command == null ? {} : { command }),
    ...(url == null ? {} : { url }),
    toolCount: summary.toolCount,
    ...(summary.disabledToolCount == null ? {} : { disabledToolCount: summary.disabledToolCount }),
    customInstructions: summary.customInstructions
  };
}
export function toInstalledServers(state: ServerState): Record<string, unknown>[] { return state.servers.map(toInstalledServer); }
export function toCatalogFields(fields?: readonly CatalogField[] | null): Record<string, unknown>[] {
  return (fields ?? []).map((field) => {
    const secret = catalogFieldIsSecret(field);
    const placeholder = boundedPublicString(field.placeholder);
    const hint = safeCatalogFieldHint(field, secret);
    const defaultValue = secret ? undefined : boundedPublicString(field.defaultValue);
    return {
      key: field.key,
      label: field.label,
      ...(placeholder == null ? {} : { placeholder }),
      ...(hint == null ? {} : { hint }),
      isRequired: field.isRequired === true,
      isSecret: secret,
      ...(defaultValue == null ? {} : { defaultValue })
    };
  });
}
export function toCatalogPlugin(view: CatalogPlugin): Record<string, unknown> { return { id: view.id, name: view.name, ...(view.displayName == null ? {} : { displayName: view.displayName }), ...(view.description == null ? {} : { description: view.description }), ...(view.category == null ? {} : { category: view.category }), ...(view.homepage == null ? {} : { homepage: view.homepage }), ...(view.iconUrl == null ? {} : { iconUrl: view.iconUrl }), fields: toCatalogFields(view.fields), connectors: (view.connectors ?? []).map(({ name, description }) => ({ name, ...(description == null ? {} : { description }) })), skills: (view.skills ?? []).map(({ name, description, sourceUrl }) => ({ name, ...(description == null ? {} : { description }), ...(sourceUrl == null ? {} : { sourceUrl }) })), ...(view.marketplace == null ? {} : { marketplace: { name: view.marketplace.name, displayName: view.marketplace.displayName, ownership: view.marketplace.ownership } }), ...(view.publisher == null ? {} : { publisher: { name: view.publisher.name, displayName: view.publisher.displayName, isUserOwned: view.publisher.isUserOwned === true } }) }; }
export function toEffectivePlugin(plugin: EffectivePlugin): Record<string, unknown> { return { pluginId: plugin.pluginId, ...(plugin.name == null ? {} : { name: plugin.name }), ...(plugin.displayName == null ? {} : { displayName: plugin.displayName }), ...(plugin.installMode == null ? {} : { installMode: plugin.installMode }), isEnabled: plugin.isEnabled === true, ...(plugin.hasTeamConfiguredVariables === true ? { hasTeamConfiguredVariables: true } : {}) }; }
export function sanitizeMcpPluginLogo(value: unknown): string | null { if (typeof value !== "string" || value.length === 0 || value.length > MCP_PLUGIN_LOGO_DATA_URL_MAX_LENGTH) return null; const separator = value.indexOf(","); if (separator < 1 || separator > 128 || !/^data:image\/[a-z0-9.+-]{1,64};base64$/i.test(value.slice(0, separator)) || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.slice(separator + 1))) return null; return value; }
export function toAuthResult(result: { status: string; serverName: string; authorizationUrl?: string; message?: string }): Record<string, unknown> { if (result.status === "started") return { kind: "started", authorizationUrl: result.authorizationUrl, serverName: result.serverName }; if (result.status === "already-authenticated") return { kind: "already-authenticated", serverName: result.serverName }; if (result.status === "not-configured") return { kind: "not-configured", serverName: result.serverName }; return { kind: result.status, message: result.message, serverName: result.serverName }; }
export function toPluginSummary(view: CatalogPlugin, effectivePlugins: readonly EffectivePlugin[] | null, servers: readonly McpServerSummary[]): Record<string, unknown> {
  const record = effectivePlugins?.find((plugin) => plugin.pluginId === view.id), effective = record != null && isEffectivePluginInstalled(record) ? record : undefined, attributed = servers.find((server) => server.pluginId === view.id), installed = effective != null || record == null && attributed != null;
  return { pluginId: view.id, name: view.name, displayName: view.displayName, description: view.description, category: view.category, isInstalled: installed, ...(installed ? { installMode: effective?.installMode ?? "unknown" } : {}), connectorCount: view.connectors?.length ?? 1, skills: (view.skills ?? []).map(({ name, description }) => ({ name, description })) };
}
export function syncPluginSkillsInBackground(pluginSkills: PluginSkillsPort | undefined, trigger: string): void { void pluginSkills?.sync(trigger).catch(() => {}); }

export interface CreateHostMcpOptions {
  accountConfigProvider?: () => Promise<unknown>;
  accountDisplayConfigProvider?: () => Promise<unknown>;
  accountServersProvider?: () => Promise<unknown>;
  accountMcpWriter?: unknown;
  backendMcpExec: unknown;
  settingsStore?: unknown;
  effectivePluginsProvider?: () => Promise<unknown>;
  boxMcpExec?: unknown;
  getMachineId: () => Promise<string>;
  getAccessToken?: () => Promise<string | null>;
  pluginSkills?: PluginSkillsPort;
  onServersMutated?: () => void;
  onServerAuthenticated?: (completion: unknown) => void;
  onDiscoveryFailed?: (event: Record<string, unknown>) => void;
  onConnectorAuth?: (event: Record<string, unknown>) => void;
  log?: (message: string) => void;
}
interface McpManagerRuntime {
  listServers(): Promise<ServerState>;
  listConnectedBackendTools(): Promise<unknown[]>;
  getCatalog(getAccessToken: () => Promise<string | null>, options?: { forceRefresh?: boolean }): Promise<CatalogPlugin[]>;
  resolvePluginLogo(url: string): Promise<unknown>;
  listEffectivePlugins(): Promise<EffectivePlugin[]>;
  uninstallPlugin(id: string): Promise<{ removed: boolean; reason?: string }>;
  setServerCustomInstructions(args: { serverId: string; instructions: string }): Promise<ServerState>;
  installEntry(args: { entryId: string; values?: Record<string, string>; hasTeamConfiguredVariables?: boolean }, getAccessToken: () => Promise<string | null>): Promise<ServerState>;
  updatePluginInstall(args: { pluginId: string; values: Record<string, string> }, getAccessToken: () => Promise<string | null>): Promise<ServerState>;
  addServer(args: { name: string; configJson: string }): Promise<ServerState>;
  removeServer(id: string): Promise<{ removed: boolean; reason?: string; state: ServerState }>;
  reloadServers(): Promise<ServerState>;
  authenticateServer(serverId: string, accountKey?: string, requestingAgentId?: string | null, forceReauth?: boolean, trigger?: string | null): Promise<{ status: string; serverName: string; authorizationUrl?: string; message?: string }>;
  logoutAccount(serverId: string, accountKey: string): Promise<ServerState>;
  renameAccount(serverId: string, accountKey: string, newAccountKey: string): Promise<ServerState>;
  removeAccount(serverId: string, accountKey: string): Promise<ServerState>;
  listServerTools(serverId: string): Promise<unknown[]>;
  toggleMcpToolDisabled(args: { serverId: string; toolName: string }): Promise<unknown[]>;
  getMcpCustomInstructions(): Promise<string>;
  refreshAccountConfigInBackground(): void;
  noteAuthCompletedElsewhere(serverId: string, accountKey: string): void;
  setAuthCompletionObserver(observer: (completion: unknown) => void): void;
  setSettingsStore(settings: unknown): void;
  setBoxRuntime(runtime: unknown): void;
  definitionSourceView(): unknown;
  lastAccountDisplayConfigView(): unknown;
  settingsStoreView(): unknown;
  dispose(): void | Promise<void>;
}
export function createHostMcp(deps: CreateHostMcpOptions): McpHostPort {
  const log = deps.log ?? ((message: string) => console.log(`[sand:mcp] ${message}`));
  const backendMcpExec = deps.backendMcpExec as {
    completeOAuth?: (args: { stateId: string; code: string }) => Promise<unknown>;
  } | null | undefined;
  const manager = new SandMcpManager({
    includeBuiltins: false,
    accountConfigProvider: deps.accountConfigProvider,
    accountDisplayConfigProvider: deps.accountDisplayConfigProvider,
    accountServersProvider: deps.accountServersProvider,
    accountMcpWriter: deps.accountMcpWriter,
    backendMcpExec: deps.backendMcpExec,
    settingsStore: deps.settingsStore,
    effectivePluginsProvider: deps.effectivePluginsProvider,
    onConnectorAuth: deps.onConnectorAuth,
    getMachineId: deps.getMachineId,
  }) as unknown as McpManagerRuntime;
  const discovery = createMcpToolsDiscovery({
    definitionSource: manager.definitionSourceView(),
    lastAccountDisplayConfig: () => manager.lastAccountDisplayConfigView(),
    settingsStore: () => manager.settingsStoreView(),
    backendMcpExec: deps.backendMcpExec,
  }, {
    ...(deps.boxMcpExec === undefined ? {} : { boxMcpExec: deps.boxMcpExec }),
    ...(deps.onDiscoveryFailed === undefined ? {} : { onDiscoveryFailed: deps.onDiscoveryFailed }),
    ...(deps.onConnectorAuth === undefined ? {} : { onConnectorAuth: deps.onConnectorAuth }),
  });
  manager.setBoxRuntime(discovery);
  const token = deps.getAccessToken ?? (async () => null);
  if (deps.onServerAuthenticated != null) manager.setAuthCompletionObserver(deps.onServerAuthenticated);
  const readEffective = async (): Promise<EffectivePlugin[] | null> => { try { return await manager.listEffectivePlugins(); } catch (error) { log(`effective-plugins read degraded to attributed rows: ${error instanceof Error ? error.message : String(error)}`); return null; } };
  const mutate = async <T>(fn: () => Promise<T>): Promise<T> => { const result = await fn(); deps.onServersMutated?.(); return result; };
  const installEntry = async (args: { entryId: string; values?: Record<string, string>; hasTeamConfiguredVariables?: boolean }) => {
    const request = { entryId: args.entryId, ...(args.values == null ? {} : { values: args.values }), ...(args.hasTeamConfiguredVariables === undefined ? {} : { hasTeamConfiguredVariables: args.hasTeamConfiguredVariables }) };
    const servers = toInstalledServers(await mutate(() => manager.installEntry(request, token)));
    try { const urls = (await manager.getCatalog(token)).find((view) => view.id === args.entryId)?.skills?.flatMap((skill) => skill.sourceUrl == null ? [] : [skill.sourceUrl]) ?? []; deps.pluginSkills?.removeLiveReferences?.(urls); } catch {}
    syncPluginSkillsInBackground(deps.pluginSkills, "install");
    return { servers };
  };
  const management = {
    getState: async () => ({ servers: toInstalledServers(await manager.listServers()) }),
    getCatalog: async () => (await manager.getCatalog(token)).map(toCatalogPlugin),
    listEffectivePlugins: async () => (await manager.listEffectivePlugins()).map(toEffectivePlugin),
    getPluginLogo: async (url: string) => sanitizeMcpPluginLogo(await manager.resolvePluginLogo(url)),
    listInstalled: async () => toInstalledServers(await manager.listServers()),
    listPlugins: async () => { const [views, state, effective] = await Promise.all([manager.getCatalog(token), manager.listServers(), readEffective()]); return views.map((view) => toPluginSummary(view, effective, state.servers)); },
    getPlugin: async (pluginId: string) => {
      let views = await manager.getCatalog(token), view = views.find((entry) => entry.id === pluginId);
      if (view == null) { views = await manager.getCatalog(token, { forceRefresh: true }); view = views.find((entry) => entry.id === pluginId); }
      if (view == null) return null;
      const [state, effective] = await Promise.all([manager.listServers(), readEffective()]);
      return { ...toPluginSummary(view, effective, state.servers), fields: toCatalogFields(view.fields), servers: state.servers.filter((server) => server.pluginId === view.id).map(toInstalledServer) };
    },
    uninstallPlugin: async (pluginId: string) => {
      let urls: string[] = []; try { urls = (await manager.getCatalog(token)).find((view) => view.id === pluginId)?.skills?.flatMap((skill) => skill.sourceUrl == null ? [] : [skill.sourceUrl]) ?? []; } catch {}
      const result = await mutate(() => manager.uninstallPlugin(pluginId));
      if (uninstallClearedInstallRecord(result)) { try { deps.pluginSkills?.removeLiveReferences?.(urls); } catch {} syncPluginSkillsInBackground(deps.pluginSkills, "uninstall"); }
      return { removed: result.removed, ...(result.reason == null ? {} : { reason: result.reason }) };
    },
    setInstructions: async (args: { serverId: string; instructions: string }) => toInstalledServers(await mutate(() => manager.setServerCustomInstructions(args))),
    setCustomInstructions: async (args: { serverId: string; instructions: string }) => ({ servers: toInstalledServers(await mutate(() => manager.setServerCustomInstructions(args))) }),
    install: async (args: { id: string; values?: Record<string, string> }) => (await installEntry({ entryId: args.id, ...(args.values == null ? {} : { values: args.values }) })).servers,
    installEntry,
    updatePluginInstall: async (args: { pluginId: string; values: Record<string, string> }) => ({ servers: toInstalledServers(await mutate(() => manager.updatePluginInstall(args, token))) }),
    add: async (args: { name: string; configJson: string }) => toInstalledServers(await mutate(() => manager.addServer(args))),
    removeServer: async (serverId: string) => { const result = await mutate(() => manager.removeServer(serverId)); return { removed: result.removed, ...(result.reason == null ? {} : { reason: result.reason }), servers: toInstalledServers(result.state) }; },
    restart: async () => toInstalledServers(await mutate(() => manager.reloadServers())),
    authenticate: async (serverId: string, accountKey?: string, requestingAgentId?: string, forceReauth?: boolean, trigger?: string) => { const result = toAuthResult(await manager.authenticateServer(serverId, accountKey, requestingAgentId ?? null, forceReauth, trigger ?? null)); if (result.kind === "started") deps.onServersMutated?.(); return result; },
    logoutAccount: async ({ serverId, accountKey }: { serverId: string; accountKey: string }) => toInstalledServers(await mutate(() => manager.logoutAccount(serverId, accountKey))),
    renameAccount: async ({ serverId, accountKey, newAccountKey }: { serverId: string; accountKey: string; newAccountKey: string }) => toInstalledServers(await mutate(() => manager.renameAccount(serverId, accountKey, newAccountKey))),
    removeAccount: async ({ serverId, accountKey }: { serverId: string; accountKey: string }) => toInstalledServers(await mutate(() => manager.removeAccount(serverId, accountKey))),
    listServerTools: async (serverId: string) => await manager.listServerTools(serverId),
    toggleMcpToolDisabled: async (args: { serverId: string; toolName: string }) => await mutate(() => manager.toggleMcpToolDisabled(args)),
    completeOAuth: async (args: { stateId: string; code: string }): Promise<void> => {
      if (typeof backendMcpExec?.completeOAuth !== "function") {
        throw new Error("host MCP OAuth completion is unavailable");
      }
      await backendMcpExec.completeOAuth(args);
    }
  };
  return {
    mcp: { getTools: (ctx: unknown) => discovery.getToolsForTurnStart(ctx), listTools: async (ctx: unknown) => { const connected = await manager.listConnectedBackendTools(), discovered = await discovery.getTools(ctx), byName = new Map<string, any>(); for (const tool of [...connected, ...discovered] as any[]) if (!byName.has(tool.name)) byName.set(tool.name, tool); return [...byName.values()]; }, createExecutor: (persistImage: unknown, spillLargeText: unknown, auditIdentity: unknown) => new SandMcpExecutor(discovery, persistImage, spillLargeText, auditIdentity), refreshAccountConfig: () => manager.refreshAccountConfigInBackground(), createStateExecutor: () => createSandMcpStateExecutor({ getTools: (ctx: unknown) => discovery.getTools(ctx) }), getCustomInstructions: () => manager.getMcpCustomInstructions(), resolveToolTransport: (id: string) => discovery.resolveProviderTransport(id), resolveNeedsAuthSlot: async (id: string) => { const summary = (await manager.listServers()).servers.find((server: McpServerSummary) => server.serverIdentifier === id && server.status === "needsAuth"); return summary == null ? null : { serverId: summary.id, serverName: summary.name }; } },
    management,
    setSettingsStore: (settings: unknown) => manager.setSettingsStore(settings),
    listBoxServers: (ids, options) => discovery.listBoxServers([...ids], options),
    noteAuthCompletedElsewhere: (serverId, accountKey) => manager.noteAuthCompletedElsewhere(serverId, accountKey),
    setBoxMcpExec: (exec: unknown) => discovery.setBoxMcpExec(exec),
    dispose: () => manager.dispose()
  };
}

export interface McpHostPort { dispose(): void | Promise<void>; listBoxServers(ids: readonly string[], options?: { kickOnly?: boolean }): Promise<Array<{ serverIdentifier: string; status: string; statusDetail?: string; toolCount: number }>>; noteAuthCompletedElsewhere(serverId: string, accountKey: string): void; setSettingsStore?(settings: unknown): void; setBoxMcpExec?(exec: unknown): void; mcp: unknown; management: unknown }
export interface McpHostServiceDeps {
  auth: {
    getAccessToken(args: { backendUrl: string }): Promise<string>;
    getMachineId(): Promise<string>;
  };
  foreverBox: { readonly box: CapableBox };
  settings: unknown;
  log(message: string): void;
  pluginSkills?: PluginSkillsPort;
  onDiscoveryFailed?: (event: Record<string, unknown>) => void;
  onConnectorAuth?: (event: Record<string, unknown>) => void;
}
export class McpHostService {
  readonly authCompletionListeners = new Set<(event: unknown) => void>();
  readonly serversUpdatedListeners = new Set<(event: { servers: unknown[] }) => void>();
  readonly statusFollowUps = new Map<string, Promise<void>>();
  private disposed = false;
  readonly hostMcp: McpHostPort;
  readonly api;
  constructor(readonly deps: McpHostServiceDeps) {
    const accountMcpDeps: AccountMcpDependencies = {
      getAccessToken: (options) => deps.auth.getAccessToken({ backendUrl: options?.backendUrl ?? getSandInferenceBackendUrl() }),
      getMachineId: deps.auth.getMachineId,
      getBackendUrl: getSandInferenceBackendUrl,
      createClient: (credentials) => createSandCursorBackendClient(DashboardService, {
        getAccessToken: (options) => credentials.getAccessToken({ backendUrl: options.backendUrl }),
        getMachineId: credentials.getMachineId,
      }) as unknown as AccountMcpClient,
    };
    const backendMcpExec = createDashboardSandBackendMcpExec({
      getAccessToken: accountMcpDeps.getAccessToken,
      getMachineId: accountMcpDeps.getMachineId,
      createClient: (credentials) => createSandCursorBackendClient(DashboardService, {
        getAccessToken: (options) => credentials.getAccessToken({ backendUrl: options.backendUrl }),
        getMachineId: credentials.getMachineId,
      }) as unknown as DashboardMcpExecClient,
    });
    this.hostMcp = createHostMcp({
      log: deps.log,
      onServerAuthenticated: (completion) => this.emitAuthCompletion(completion),
      onServersMutated: () => this.emitServersUpdated({ servers: [] }),
      ...(deps.pluginSkills == null ? {} : { pluginSkills: deps.pluginSkills }),
      getAccessToken: async () => { try { const token = await deps.auth.getAccessToken({ backendUrl: getSandInferenceBackendUrl() }); return token.length > 0 ? token : null; } catch { return null; } },
      getMachineId: deps.auth.getMachineId,
      accountServersProvider: () => fetchAccountMcpServers(accountMcpDeps),
      accountMcpWriter: createAccountMcpWriter(accountMcpDeps),
      effectivePluginsProvider: () => fetchEffectiveUserPlugins(accountMcpDeps),
      backendMcpExec,
      boxMcpExec: createBoxSandMcpExec(deps.foreverBox.box),
      settingsStore: deps.settings,
      ...(deps.onDiscoveryFailed === undefined ? {} : { onDiscoveryFailed: deps.onDiscoveryFailed }),
      ...(deps.onConnectorAuth === undefined ? {} : { onConnectorAuth: deps.onConnectorAuth }),
    });
    this.api = { mcp: this.hostMcp.mcp, management: this.hostMcp.management, listBoxServers: (ids: readonly string[]) => this.listBoxServers(ids), subscribeToAuthCompletion: (listener: (event: unknown) => void) => { this.authCompletionListeners.add(listener); return () => this.authCompletionListeners.delete(listener); }, noteAuthCompletedElsewhere: (serverId: string, accountKey: string) => this.hostMcp.noteAuthCompletedElsewhere(serverId, accountKey), subscribeToServersUpdated: (listener: (event: { servers: unknown[] }) => void) => { this.serversUpdatedListeners.add(listener); return () => this.serversUpdatedListeners.delete(listener); }, syncPluginSkills: async () => await deps.pluginSkills?.sync("desktop") ?? [], pluginSyncStatus: () => deps.pluginSkills?.status() ?? { authBlocked: [] } };
  }
  setSettingsStore(settings: unknown): void { this.hostMcp.setSettingsStore?.(settings); }
  setBoxMcpExec(exec: unknown): void { this.hostMcp.setBoxMcpExec?.(exec); }
  async dispose(): Promise<void> { if (this.disposed) return; this.disposed = true; this.authCompletionListeners.clear(); this.serversUpdatedListeners.clear(); this.statusFollowUps.clear(); await this.hostMcp.dispose(); }
  async listBoxServers(ids: readonly string[]) { const servers = await this.hostMcp.listBoxServers(ids, { kickOnly: true }); this.scheduleStatusFollowUps(servers); return servers.map(({ serverIdentifier, status, statusDetail, toolCount }) => ({ serverIdentifier, status, ...(statusDetail == null ? {} : { statusDetail }), toolCount })); }
  scheduleStatusFollowUps(servers: readonly { serverIdentifier: string; status: string }[]): void {
    if (this.disposed) return;
    for (const server of servers) {
      if (server.status !== "loading" && server.status !== "error" || this.statusFollowUps.has(server.serverIdentifier)) continue;
      const id = server.serverIdentifier, followUp = (async () => { try { const [updated] = await this.hostMcp.listBoxServers([id]); if (!this.disposed && updated != null) this.emitServersUpdated({ servers: [{ serverIdentifier: updated.serverIdentifier, status: updated.status, ...(updated.statusDetail == null ? {} : { statusDetail: updated.statusDetail }), toolCount: updated.toolCount }] }); } catch (error) { if (!this.disposed) this.deps.log(`[sand:mcp] box MCP status follow-up failed for ${id}: ${error instanceof Error ? error.message : String(error)}`); } finally { this.statusFollowUps.delete(id); } })();
      this.statusFollowUps.set(id, followUp);
    }
  }
  emitAuthCompletion(event: unknown): void { if (!this.disposed) for (const listener of this.authCompletionListeners) listener(event); }
  emitServersUpdated(event: { servers: unknown[] }): void { if (!this.disposed) for (const listener of this.serversUpdatedListeners) listener(event); }
}
export function createMcpService(deps: ConstructorParameters<typeof McpHostService>[0]): McpHostService { return new McpHostService(deps); }
