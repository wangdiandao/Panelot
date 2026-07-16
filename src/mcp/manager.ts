/**
 * McpManager (docs/07 §1/§4): owns clients, bridges capabilities into the
 * agent (tools→AgentTool, prompts→slash commands, resources→@refs), manages
 * auth (bearer/OAuth with refresh), and connection state.
 */

import { schema, type RuntimeSchema } from '../agent/schema';
import type { AnyAgentTool } from '../agent/tool';
import { McpWorkerClient } from './workerClient';
import {
  discoverAuthServer,
  authorize,
  refreshTokens,
  registerClient,
  type OAuthDiscovery,
  type OAuthFetchPermissionContext,
  type OAuthFetchPermissionGuard,
} from './oauth';
import type {
  McpConnectionState,
  McpOAuthChallenge,
  McpOAuthCredentialBinding,
  McpOAuthFlowResult,
  McpOAuthPermissionApproval,
  McpOAuthPermissionRequired,
  McpOAuthPermissionStage,
  McpServerConfig,
} from './types';
import {
  deleteMcpAccess,
  MCP_SERVERS_KEY,
  listMcpServers,
  protectMcpServer,
  readMcpAccess,
  readMcpBearer,
  readMcpRefresh,
  saveMcpServers,
} from './store';
import { onStorageChange } from '../settings/store';
import type { ContentBlock, ContextBlock } from '../messaging/protocol';
import { normalizeEndpointUrl } from '../security/endpointUrl';
import { HostPermissionBroker, hostPermissionBroker } from '../permissions/hostPermissionBroker';

const MCP_OAUTH_PERMISSION_PLAN_TTL_MS = 5 * 60_000;

interface PermissionStageInput {
  stage: McpOAuthPermissionStage;
  originReasons: { origin: string; reason: string }[];
  summary: McpOAuthPermissionRequired['summary'];
  fingerprint?: unknown;
  planDigest?: string;
  forceReview?: boolean;
  invalidateOnChange?: boolean;
}

export class McpOAuthPermissionRequiredError extends Error {
  constructor(readonly permissionRequired: McpOAuthPermissionRequired) {
    super(`MCP OAuth host permission required: ${permissionRequired.origins.join(', ')}`);
    this.name = 'McpOAuthPermissionRequiredError';
  }
}

export function permissionRequiredFromError(
  error: unknown,
): McpOAuthPermissionRequired | undefined {
  return error instanceof McpOAuthPermissionRequiredError ? error.permissionRequired : undefined;
}

/** json-schema-to-zod would be ideal; a pragmatic passthrough keeps the bridge small.
 *  The raw JSON Schema is forwarded to the provider unchanged (docs/07 §4). */
function schemaToZod(_inputSchema: Record<string, unknown>): RuntimeSchema {
  // We validate loosely here (real validation is server-side); the provider
  // receives the raw JSON Schema via AgentTool.inputSchema, so runtime only
  // needs to enforce the tool-argument object boundary.
  return schema.looseObject({});
}

export class McpManager {
  private clients = new Map<string, McpWorkerClient>();
  private connectAttempts = new Map<string, Promise<void>>();
  private connectionTails = new Map<string, Promise<void>>();
  private configs = new Map<string, McpServerConfig>();
  private states = new Map<string, McpConnectionState>();
  private pendingPermissionPlans = new Map<string, McpOAuthPermissionRequired>();
  onStateChange: (id: string, state: McpConnectionState) => void = () => {};
  /** Notifies when the tool registry should be rebuilt (list_changed). */
  onToolsChanged: () => void = () => {};

  constructor(private readonly permissionBroker: HostPermissionBroker = hostPermissionBroker) {
    onStorageChange(MCP_SERVERS_KEY, () => void this.reconcileStorage());
  }

  async listServers(): Promise<McpServerConfig[]> {
    const servers = await listMcpServers();
    this.configs = new Map(servers.map((server) => [server.id, server]));
    return servers;
  }

  async saveServer(config: McpServerConfig): Promise<void> {
    const servers = await this.listServers();
    const idx = servers.findIndex((s) => s.id === config.id);
    const protectedConfig = await protectMcpServer(config);
    if (idx === -1) servers.push(protectedConfig);
    else servers[idx] = protectedConfig;
    await saveMcpServers(servers);
  }

  async removeServer(id: string): Promise<void> {
    await this.disconnect(id);
    const servers = await this.listServers();
    const removed = servers.find((server) => server.id === id);
    if (removed) await deleteMcpAccess(removed);
    await saveMcpServers(servers.filter((s) => s.id !== id));
  }

  getState(id: string): McpConnectionState {
    return this.states.get(id) ?? { status: 'disconnected' };
  }

  private setState(id: string, state: McpConnectionState): void {
    this.states.set(id, state);
    this.onStateChange(id, state);
  }

  // ---- connection ----------------------------------------------------------

  async connect(id: string): Promise<void> {
    const pending = this.connectAttempts.get(id);
    if (pending) return pending;
    const predecessor = this.connectionTails.get(id);
    const attempt = (predecessor ? predecessor.catch(() => undefined) : Promise.resolve()).then(
      () => this.connectCandidate(id),
    );
    this.connectAttempts.set(id, attempt);
    this.connectionTails.set(id, attempt);
    try {
      await attempt;
    } finally {
      if (this.connectAttempts.get(id) === attempt) this.connectAttempts.delete(id);
      if (this.connectionTails.get(id) === attempt) this.connectionTails.delete(id);
    }
  }

  private async connectCandidate(id: string): Promise<void> {
    const servers = await this.listServers();
    const config = servers.find((s) => s.id === id);
    if (!config || !config.enabled) return;
    if (this.clients.has(id)) return;

    this.setState(id, { status: 'connecting' });
    let candidate: McpWorkerClient | undefined;
    try {
      const url = normalizeEndpointUrl(config.url, { label: `MCP 服务器 ${config.name} 的 URL` });
      const resourcePermission = await this.preparePermissionStage(id, undefined, {
        stage: 'resource',
        originReasons: [{ origin: new URL(url).origin, reason: '连接 MCP 资源服务器' }],
        summary: { resource: url },
        fingerprint: ['resource', url],
      });
      if (resourcePermission.required) {
        throw new McpOAuthPermissionRequiredError(resourcePermission.required);
      }
      this.configs.set(id, { ...config, url });
      const client = new McpWorkerClient(config.id, () => {
        if (this.clients.get(config.id) !== client) return;
        this.setState(config.id, { status: 'ready', toolCount: client.tools.length });
        this.onToolsChanged();
      });
      candidate = client;
      await client.connect({
        url,
        authorization: await this.authHeaderFor(config.id),
      });
      this.clients.set(id, client);
      this.setState(id, { status: 'ready', toolCount: client.tools.length });
      this.onToolsChanged();
    } catch (e) {
      if (candidate) await candidate.close().catch(() => undefined);
      const permissionRequired = permissionRequiredFromError(e);
      this.setState(id, {
        status: 'error',
        reason: permissionRequired ? '需要额外主机权限' : attributeError((e as Error).message),
        permissionRequired,
      });
      throw e;
    }
  }

  async disconnect(id: string): Promise<void> {
    const predecessor = this.connectionTails.get(id);
    // A disconnect is a serialization barrier: a later connect must queue after it
    // instead of sharing the older in-flight connection promise.
    this.connectAttempts.delete(id);
    const operation = (predecessor ? predecessor.catch(() => undefined) : Promise.resolve()).then(
      async () => {
        const client = this.clients.get(id);
        this.clients.delete(id);
        try {
          await client?.close();
        } finally {
          this.setState(id, { status: 'disconnected' });
        }
      },
    );
    this.connectionTails.set(id, operation);
    try {
      await operation;
    } finally {
      if (this.connectionTails.get(id) === operation) this.connectionTails.delete(id);
    }
  }

  /** Ensure lazy-connect servers are up before first use (docs/07 §2). */
  async ensureConnected(mode: 'startup' | 'use' = 'use'): Promise<void> {
    const servers = await this.listServers();
    await Promise.all(
      servers
        .filter(
          (server) =>
            server.enabled &&
            !this.clients.has(server.id) &&
            (mode === 'use' || server.connectOnStartup),
        )
        .map((server) => this.connect(server.id).catch(() => {})),
    );
  }

  private async reconcileStorage(): Promise<void> {
    const servers = await this.listServers();
    const activeIds = new Set(
      servers.filter((server) => server.enabled).map((server) => server.id),
    );
    await Promise.all(
      [...this.clients.keys()].filter((id) => !activeIds.has(id)).map((id) => this.disconnect(id)),
    );
    await this.ensureConnected('startup');
    this.onToolsChanged();
  }

  // ---- auth ------------------------------------------------------------------

  private async authHeaderFor(id: string): Promise<string | null> {
    const config = (await this.listServers()).find((s) => s.id === id);
    if (!config) return null;
    if (config.auth.kind === 'bearer') return `Bearer ${await readMcpBearer(config)}`;
    if (config.auth.kind === 'oauth') {
      const access = await this.validOAuthToken(config);
      return access ? `Bearer ${access}` : null;
    }
    return null;
  }

  private async validOAuthToken(
    config: McpServerConfig,
    approval?: McpOAuthPermissionApproval,
  ): Promise<string | null> {
    if (config.auth.kind !== 'oauth' || !config.auth.tokens || !config.auth.binding) return null;
    const { tokens } = config.auth;
    try {
      const discovery = await discoverAuthServer(config.url, {
        preferredIssuer: config.auth.binding.issuer,
        permissionGuard: this.discoveryPermissionGuard(config.id, approval),
      });
      const endpointStage = await this.prepareOAuthEndpointStage(
        config.id,
        config,
        discovery,
        approval,
        false,
      );
      if (endpointStage.required) {
        this.setPermissionRequiredState(config.id, endpointStage.required);
        return null;
      }
      if (!sameBinding(config.auth.binding, endpointStage.binding)) return null;
      const access = await readMcpAccess(config.id);
      if (tokens.expiresAt > Date.now() + 30_000 && access) return access;

      const refresh = await readMcpRefresh(config);
      if (refresh && config.auth.clientId) {
        const refreshStage = await this.preparePermissionStage(config.id, approval, {
          stage: 'token_refresh',
          originReasons: [
            {
              origin: new URL(discovery.metadata.token_endpoint).origin,
              reason: '刷新 MCP OAuth access token',
            },
          ],
          summary: oauthSummary(discovery),
          fingerprint: [
            'token_refresh',
            endpointStage.binding.planDigest,
            discovery.metadata.token_endpoint,
          ],
        });
        if (refreshStage.required) {
          this.setPermissionRequiredState(config.id, refreshStage.required);
          return null;
        }
        const fresh = await refreshTokens(
          discovery.metadata.token_endpoint,
          config.auth.clientId,
          refresh,
          discovery.binding.resource,
          this.endpointFetchGuard(
            config.id,
            'token_refresh',
            refreshStage.planDigest,
            oauthSummary(discovery),
          ),
          discovery.binding.issuer,
        );
        await this.persistTokens(config.id, fresh, config.auth.clientId, endpointStage.binding);
        return fresh.access;
      }
      return null;
    } catch (error) {
      const permissionRequired = permissionRequiredFromError(error);
      if (permissionRequired) this.setPermissionRequiredState(config.id, permissionRequired);
      return null;
    }
  }

  /** Full OAuth flow (discovery → DCR → PKCE → token) for the settings page. */
  async runOAuthFlow(
    id: string,
    challenge: McpOAuthChallenge = {},
    approval?: McpOAuthPermissionApproval,
  ): Promise<McpOAuthFlowResult> {
    const servers = await this.listServers();
    const config = servers.find((s) => s.id === id);
    if (!config || config.auth.kind !== 'oauth') throw new Error('not an oauth server');
    try {
      if (approval?.stage === 'token_refresh') {
        const access = await this.validOAuthToken(config, approval);
        if (access) return { status: 'complete' };
        const pending = this.permissionRequiredState(id);
        if (pending) return pending;
      }

      const discovery = await discoverAuthServer(config.url, {
        resourceMetadataUrl: challenge.resourceMetadataUrl,
        scope: challenge.scope,
        preferredIssuer: config.auth.binding?.issuer,
        permissionGuard: this.discoveryPermissionGuard(id, approval, challenge),
      });
      const endpointStage = await this.prepareOAuthEndpointStage(id, config, discovery, approval);
      if (endpointStage.required) {
        this.setPermissionRequiredState(id, endpointStage.required);
        return endpointStage.required;
      }

      const scopes = discovery.scopes ?? config.auth.scopes;
      const fetchGuard = this.endpointFetchGuard(
        id,
        'oauth_endpoints',
        endpointStage.planDigest,
        oauthSummary(discovery),
      );
      const existingClientId = config.auth.clientId;
      if (endpointStage.reuseClient && !existingClientId) {
        throw new Error('Stored OAuth client registration is missing its clientId');
      }
      const clientId = endpointStage.reuseClient
        ? existingClientId
        : await registerClient(discovery.metadata, scopes, fetchGuard, discovery.binding.resource);
      if (!clientId) throw new Error('OAuth client registration did not produce a clientId');
      const tokens = await authorize(
        discovery.metadata,
        clientId,
        discovery.binding.resource,
        scopes,
        fetchGuard,
      );
      await this.persistTokens(id, tokens, clientId, endpointStage.binding);
      this.clearPermissionState(id);
      return { status: 'complete' };
    } catch (error) {
      const permissionRequired = permissionRequiredFromError(error);
      if (permissionRequired) {
        this.setPermissionRequiredState(id, permissionRequired);
        return permissionRequired;
      }
      this.setState(id, {
        status: 'error',
        reason: attributeError(error instanceof Error ? error.message : String(error)),
      });
      throw error;
    }
  }

  async reauthorizeWorker(
    id: string,
    challenge: McpOAuthChallenge = {},
  ): Promise<{
    authorization: string | null;
    permissionRequired?: McpOAuthPermissionRequired;
  }> {
    const config = (await this.listServers()).find((server) => server.id === id);
    if (!config || config.auth.kind !== 'oauth') return { authorization: null };
    try {
      const result = await this.runOAuthFlow(id, challenge);
      if (result.status === 'permission_required') {
        return { authorization: null, permissionRequired: result };
      }
      return { authorization: await this.authHeaderFor(id) };
    } catch {
      return { authorization: null };
    }
  }

  private async persistTokens(
    id: string,
    tokens: { access: string; refresh?: string; expiresAt: number },
    clientId: string,
    binding: McpOAuthCredentialBinding,
  ): Promise<void> {
    const servers = await this.listServers();
    const config = servers.find((s) => s.id === id);
    if (!config || config.auth.kind !== 'oauth') return;
    const hasCredentialResidue = Boolean(
      config.auth.binding || config.auth.tokens || config.auth.clientId,
    );
    if (hasCredentialResidue && !sameBinding(config.auth.binding, binding)) {
      await deleteMcpAccess(config);
    }
    config.auth.tokens = tokens;
    config.auth.clientId = clientId;
    config.auth.binding = binding;
    await saveMcpServers(servers);
  }

  async checkWorkerFetchPermission(id: string, value: string): Promise<McpOAuthFlowResult> {
    const config = (await this.listServers()).find((server) => server.id === id);
    if (!config) throw new Error(`MCP server not found: ${id}`);
    const configured = new URL(
      normalizeEndpointUrl(config.url, { label: `MCP 服务器 ${config.name} 的 URL` }),
    );
    const target = new URL(normalizeEndpointUrl(value, { label: 'MCP worker 请求 URL' }));
    if (target.origin !== configured.origin) {
      throw new Error(`MCP worker 拒绝跨源请求: ${target.origin}`);
    }
    const stage = await this.preparePermissionStage(id, undefined, {
      stage: 'resource',
      originReasons: [{ origin: target.origin, reason: '访问 MCP 资源服务器' }],
      summary: { resource: configured.toString() },
      fingerprint: ['resource', configured.toString()],
    });
    if (stage.required) {
      this.setPermissionRequiredState(id, stage.required);
      return stage.required;
    }
    return { status: 'complete' };
  }

  private discoveryPermissionGuard(
    id: string,
    approval?: McpOAuthPermissionApproval,
    challenge: McpOAuthChallenge = {},
  ): OAuthFetchPermissionGuard {
    return async (url, context) => {
      const stage: McpOAuthPermissionStage =
        context.stage === 'resource_metadata' ? 'resource' : 'authorization_server';
      const reason =
        stage === 'resource' ? '读取 MCP 保护资源元数据' : '读取 OAuth 授权服务器元数据';
      const prepared = await this.preparePermissionStage(id, approval, {
        stage,
        originReasons: [{ origin: url.origin, reason }],
        summary: { resource: context.resource, issuer: context.issuer },
        fingerprint: discoveryPermissionFingerprint(stage, context, challenge),
      });
      if (prepared.required) throw new McpOAuthPermissionRequiredError(prepared.required);
    };
  }

  private async prepareOAuthEndpointStage(
    id: string,
    config: McpServerConfig,
    discovery: OAuthDiscovery,
    approval?: McpOAuthPermissionApproval,
    requireEndpointPermissions = true,
  ): Promise<{
    planDigest: string;
    binding: McpOAuthCredentialBinding;
    reuseClient: boolean;
    required?: McpOAuthPermissionRequired;
  }> {
    if (config.auth.kind !== 'oauth') throw new Error('not an oauth server');
    const fingerprint = oauthEndpointFingerprint(discovery);
    const planDigest = await permissionPlanDigest(fingerprint);
    const binding = { ...discovery.binding, planDigest };
    const bindingMatches = sameBinding(config.auth.binding, binding);
    const unboundConfiguredClient = Boolean(
      config.auth.clientId && !config.auth.binding && !config.auth.tokens,
    );
    const reuseClient = Boolean(
      config.auth.clientId && (bindingMatches || unboundConfiguredClient),
    );
    if (!requireEndpointPermissions && bindingMatches) {
      return { planDigest, binding, reuseClient };
    }
    const originReasons = [
      {
        origin: new URL(discovery.metadata.authorization_endpoint).origin,
        reason: '打开 OAuth 授权页面',
      },
      {
        origin: new URL(discovery.metadata.token_endpoint).origin,
        reason: '交换或刷新 MCP OAuth token',
      },
    ];
    if (!reuseClient && discovery.metadata.registration_endpoint) {
      originReasons.push({
        origin: new URL(discovery.metadata.registration_endpoint).origin,
        reason: '动态注册 Panelot OAuth 客户端',
      });
    }
    const prepared = await this.preparePermissionStage(id, approval, {
      stage: 'oauth_endpoints',
      originReasons,
      summary: oauthSummary(discovery),
      planDigest,
      forceReview: Boolean(config.auth.binding && !bindingMatches),
      invalidateOnChange: true,
    });
    return { planDigest, binding, reuseClient, required: prepared.required };
  }

  private endpointFetchGuard(
    id: string,
    stage: 'oauth_endpoints' | 'token_refresh',
    planDigest: string,
    summary: McpOAuthPermissionRequired['summary'],
  ): OAuthFetchPermissionGuard {
    return async (url, context) => {
      const reason = endpointReason(context);
      const prepared = await this.preparePermissionStage(id, undefined, {
        stage,
        originReasons: [{ origin: url.origin, reason }],
        summary,
        planDigest,
      });
      if (prepared.required) throw new McpOAuthPermissionRequiredError(prepared.required);
    };
  }

  private async preparePermissionStage(
    id: string,
    approval: McpOAuthPermissionApproval | undefined,
    input: PermissionStageInput,
  ): Promise<{ planDigest: string; required?: McpOAuthPermissionRequired }> {
    const originReasons = mergeOriginReasons(input.originReasons);
    const statuses = await this.permissionBroker.inspectAll(
      originReasons.map(({ origin }) => origin),
    );
    const missing = new Set(statuses.filter(({ granted }) => !granted).map(({ origin }) => origin));
    const planDigest =
      input.planDigest ??
      (await permissionPlanDigest(
        input.fingerprint ?? [input.stage, input.summary, originReasons],
      ));
    const key = permissionPlanKey(id, input.stage);
    const pending = this.pendingPermissionPlans.get(key);
    let reason: McpOAuthPermissionRequired['reason'] | undefined;

    if (input.forceReview) {
      reason = 'plan_changed';
    } else if (approval?.stage === input.stage) {
      if (!pending || pending.expiresAt <= Date.now()) reason = 'plan_expired';
      else if (pending.planDigest !== approval.planDigest || approval.planDigest !== planDigest) {
        reason = 'plan_changed';
      } else if (missing.size > 0) {
        reason = 'permission_denied';
      }
    } else if (missing.size > 0) {
      reason = 'host_permission_required';
    }

    if (!reason) {
      if (approval?.stage === input.stage) this.pendingPermissionPlans.delete(key);
      return { planDigest };
    }
    if (reason === 'plan_changed' && input.invalidateOnChange) {
      await this.invalidateOAuthCredentials(id);
    }
    const requiredOrigins = [...missing].sort();
    const required: McpOAuthPermissionRequired = {
      status: 'permission_required',
      stage: input.stage,
      origins: requiredOrigins,
      originReasons: originReasons.filter(({ origin }) => missing.has(origin)),
      reason,
      summary: input.summary,
      planDigest,
      expiresAt: Date.now() + MCP_OAUTH_PERMISSION_PLAN_TTL_MS,
    };
    this.pendingPermissionPlans.set(key, required);
    return { planDigest, required };
  }

  private setPermissionRequiredState(id: string, permissionRequired: McpOAuthPermissionRequired) {
    this.setState(id, {
      status: 'error',
      reason: '需要额外主机权限',
      permissionRequired,
    });
  }

  private permissionRequiredState(id: string): McpOAuthPermissionRequired | undefined {
    const state = this.getState(id);
    return state.status === 'error' ? state.permissionRequired : undefined;
  }

  private clearPermissionState(id: string): void {
    const state = this.getState(id);
    if (state.status === 'error' && state.permissionRequired) {
      this.setState(id, { status: 'disconnected' });
    }
  }

  private async invalidateOAuthCredentials(id: string): Promise<void> {
    const servers = await this.listServers();
    const config = servers.find((server) => server.id === id);
    if (!config || config.auth.kind !== 'oauth') return;
    const scopes = config.auth.scopes;
    await deleteMcpAccess(config);
    config.auth = { kind: 'oauth', scopes };
    await saveMcpServers(servers);
  }

  // ---- capability bridging (docs/07 §4) --------------------------------------

  /** tools → AgentTool[], name = mcp__{serverId}__{tool}. */
  buildTools(getThreadId?: () => string): AnyAgentTool[] {
    const out: AnyAgentTool[] = [];
    for (const [serverId, client] of this.clients) {
      const config = this.configs.get(serverId);
      for (const tool of client.tools) {
        if (config?.disabledTools.includes(tool.name)) continue;
        const fqName = `mcp__${serverId}__${tool.name}`;
        const auth = config?.auth;
        out.push({
          name: fqName,
          label: tool.annotations?.title ?? tool.name,
          description: tool.description ?? `MCP tool ${tool.name}`,
          parameters: schemaToZod(tool.inputSchema),
          level: 'mcp',
          effects: 'write',
          recovery: 'never-retry',
          resultTrust: 'untrusted',
          resultProvenance: 'mcp',
          inputSchema: tool.inputSchema,
          executionBinding: {
            kind: 'mcp',
            id: fqName,
            serverId,
            endpoint: config?.url,
            auth:
              auth?.kind === 'bearer'
                ? { kind: 'bearer', credentialRef: `mcp:${serverId}:bearer` }
                : auth?.kind === 'oauth'
                  ? {
                      kind: 'oauth',
                      credentialRef: `mcp:${serverId}:oauth`,
                      resource: auth.binding?.resource,
                      issuer: auth.binding?.issuer,
                      clientId: auth.clientId,
                      scopes: auth.scopes ? [...auth.scopes].sort() : undefined,
                    }
                  : { kind: 'none' },
          },
          resolveTarget: async () => ({
            origin: new URL(await this.serverUrl(serverId)).origin,
            serverId,
          }),
          execute: async (itemId, params) => {
            const result = await client.callTool(
              tool.name,
              params,
              getThreadId ? { threadId: getThreadId(), itemId } : undefined,
            );
            const text = result.content.map((c) => c.text ?? '').join('\n');
            if (result.isError) throw new Error(text || 'MCP tool error');
            return { content: [{ type: 'text', text }] };
          },
        });
      }
    }
    return out;
  }

  /** prompts → slash-command descriptors (docs/07 §4). */
  listPromptCommands(): {
    command: string;
    serverId: string;
    prompt: string;
    args: { name: string; required?: boolean }[];
  }[] {
    const out: {
      command: string;
      serverId: string;
      prompt: string;
      args: { name: string; required?: boolean }[];
    }[] = [];
    for (const [serverId, client] of this.clients) {
      for (const prompt of client.prompts) {
        out.push({
          command: `/${serverId}:${prompt.name}`,
          serverId,
          prompt: prompt.name,
          args: (prompt.arguments ?? []).map((a) => ({ name: a.name, required: a.required })),
        });
      }
    }
    return out;
  }

  async getClient(serverId: string): Promise<McpWorkerClient | undefined> {
    return this.clients.get(serverId);
  }

  describeServer(id: string): {
    state: McpConnectionState;
    tools: { name: string; description?: string; disabled: boolean }[];
    promptCount: number;
    resourceCount: number;
  } {
    const client = this.clients.get(id);
    const config = this.configs.get(id);
    return {
      state: this.getState(id),
      tools: (client?.tools ?? []).map((tool) => ({
        name: tool.name,
        description: tool.description,
        disabled: config?.disabledTools.includes(tool.name) ?? false,
      })),
      promptCount: client?.prompts.length ?? 0,
      resourceCount: client?.resources.length ?? 0,
    };
  }

  listResourceReferences(): {
    serverId: string;
    uri: string;
    name: string;
    description?: string;
    origin?: string;
  }[] {
    const resources: {
      serverId: string;
      uri: string;
      name: string;
      description?: string;
      origin?: string;
    }[] = [];
    for (const [serverId, client] of this.clients) {
      const configuredUrl = this.configs.get(serverId)?.url;
      for (const resource of client.resources) {
        resources.push({
          serverId,
          uri: resource.uri,
          name: resource.name ?? resource.uri,
          description: resource.description,
          origin: configuredUrl ? new URL(configuredUrl).origin : undefined,
        });
      }
    }
    return resources;
  }

  async executePromptCommand(text: string): Promise<ContextBlock | null> {
    const match = /^\/([^:\s]+):([^\s]+)(?:\n([\s\S]*))?$/.exec(text.trim());
    if (!match?.[1] || !match[2]) return null;
    await this.ensureConnected('use');
    const client = this.clients.get(match[1]);
    if (!client || !client.prompts.some((prompt) => prompt.name === match[2])) return null;
    const args: Record<string, string> = {};
    for (const line of (match[3] ?? '').split('\n')) {
      const argument = /^([^:]+):\s*(.*)$/.exec(line.trim());
      if (argument?.[1]) args[argument[1].trim()] = argument[2] ?? '';
    }
    const result = await client.getPrompt(match[2], args);
    const content = result.messages.flatMap((message) =>
      message.content.text
        ? [{ type: 'text' as const, text: `[${message.role}] ${message.content.text}` }]
        : [],
    );
    const config = this.configs.get(match[1]);
    return {
      kind: 'mcp_resource',
      label: `/${match[1]}:${match[2]}`,
      origin: config ? new URL(config.url).origin : undefined,
      trust: 'untrusted',
      provenance: 'mcp',
      sourceRef: `${match[1]}:${match[2]}`,
      content,
    };
  }

  async readResourceContext(serverId: string, uri: string): Promise<ContextBlock> {
    await this.ensureConnected('use');
    const client = this.clients.get(serverId);
    if (!client) throw new Error(`MCP server is not connected: ${serverId}`);
    const resource = client.resources.find((candidate) => candidate.uri === uri);
    if (!resource) throw new Error(`MCP resource not found: ${uri}`);
    const result = await client.readResource(uri);
    const content: ContentBlock[] = [];
    for (const entry of result.contents) {
      if (entry.text !== undefined) {
        content.push({ type: 'text', text: entry.text });
        continue;
      }
      if (entry.blob && entry.mimeType?.startsWith('image/')) {
        content.push({ type: 'image', mime: entry.mimeType, data: entry.blob });
        continue;
      }
      content.push({
        type: 'text',
        text: `[Binary MCP resource omitted: ${entry.mimeType ?? 'application/octet-stream'}]`,
      });
    }
    const config = this.configs.get(serverId);
    return {
      kind: 'mcp_resource',
      label: resource.name ?? uri,
      origin: config ? new URL(config.url).origin : undefined,
      trust: 'untrusted',
      provenance: 'mcp',
      sourceRef: `${serverId}:${uri}`,
      content,
    };
  }

  private async serverUrl(serverId: string): Promise<string> {
    const server = (await this.listServers()).find((candidate) => candidate.id === serverId);
    if (!server) throw new Error(`MCP server is no longer configured: ${serverId}`);
    return server.url;
  }
}

function sameBinding(
  left: McpOAuthCredentialBinding | undefined,
  right: McpOAuthCredentialBinding,
): boolean {
  return (
    left?.resource === right.resource &&
    left.issuer === right.issuer &&
    left.planDigest === right.planDigest
  );
}

function permissionPlanKey(id: string, stage: McpOAuthPermissionStage): string {
  return `${id}:${stage}`;
}

async function permissionPlanDigest(value: unknown): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))),
  );
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function discoveryPermissionFingerprint(
  stage: McpOAuthPermissionStage,
  context: OAuthFetchPermissionContext,
  challenge: McpOAuthChallenge,
): unknown {
  return [
    stage,
    context.resource,
    context.issuer ?? '',
    [...(context.authorizationServers ?? [])].sort(),
    [...(context.scopes ?? [])].sort(),
    challenge.resourceMetadataUrl ?? '',
    challenge.scope ?? '',
  ];
}

function oauthEndpointFingerprint(discovery: OAuthDiscovery): unknown {
  return [
    'oauth_endpoints',
    discovery.binding.resource,
    discovery.binding.issuer,
    [...discovery.resourceMetadata.authorization_servers].sort(),
    [...(discovery.resourceMetadata.scopes_supported ?? [])].sort(),
    [...(discovery.scopes ?? [])].sort(),
    discovery.metadata.authorization_endpoint,
    discovery.metadata.token_endpoint,
    discovery.metadata.registration_endpoint ?? '',
  ];
}

function oauthSummary(discovery: OAuthDiscovery): McpOAuthPermissionRequired['summary'] {
  return {
    resource: discovery.binding.resource,
    issuer: discovery.binding.issuer,
    authorizationEndpoint: discovery.metadata.authorization_endpoint,
    tokenEndpoint: discovery.metadata.token_endpoint,
    registrationEndpoint: discovery.metadata.registration_endpoint,
  };
}

function mergeOriginReasons(
  values: { origin: string; reason: string }[],
): { origin: string; reason: string }[] {
  const reasons = new Map<string, Set<string>>();
  for (const value of values) {
    const origin = new URL(value.origin).origin;
    const entries = reasons.get(origin) ?? new Set<string>();
    entries.add(value.reason);
    reasons.set(origin, entries);
  }
  return [...reasons]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([origin, entries]) => ({ origin, reason: [...entries].join('；') }));
}

function endpointReason(context: OAuthFetchPermissionContext): string {
  if (context.stage === 'registration') return '动态注册 Panelot OAuth 客户端';
  if (context.stage === 'token') return '交换或刷新 MCP OAuth token';
  return '访问 MCP OAuth endpoint';
}

function attributeError(message: string): string {
  if (/401|unauthor/i.test(message)) return '需要授权 (401)';
  if (/CORS|host permission/i.test(message)) return 'CORS/权限问题 — 检查 host 权限';
  if (/protocol|version/i.test(message)) return '协议版本不符';
  if (/fetch|network|Failed to fetch/i.test(message)) return '网络不可达';
  return redactDiagnostic(message);
}

function redactDiagnostic(message: string): string {
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [redacted]')
    .replace(/([?&](?:token|key|secret|code)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\b(?:sk|api)[-_][A-Za-z0-9_-]{8,}\b/gi, '[redacted]');
}
