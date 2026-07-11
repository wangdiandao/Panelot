/**
 * McpManager (docs/07 §1/§4): owns clients, bridges capabilities into the
 * agent (tools→AgentTool, prompts→slash commands, resources→@refs), manages
 * auth (bearer/OAuth with refresh), and connection state.
 */

import { z } from 'zod';
import type { AnyAgentTool } from '../agent/tool';
import type { McpWorkerClient } from './workerClient';
import { discoverAuthServer, authorize, refreshTokens, registerClient } from './oauth';
import type { McpConnectionState, McpServerConfig } from './types';
import {
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

/** json-schema-to-zod would be ideal; a pragmatic passthrough keeps the bridge small.
 *  The raw JSON Schema is forwarded to the provider unchanged (docs/07 §4). */
function schemaToZod(inputSchema: Record<string, unknown>): z.ZodType {
  // We validate loosely here (real validation is server-side); the provider
  // receives the raw JSON Schema via the AgentTool.parameters → toJSONSchema
  // path, so we wrap in a passthrough object preserving the shape.
  return z.object({}).passthrough().describe(JSON.stringify(inputSchema));
}

export class McpManager {
  private clients = new Map<string, McpWorkerClient>();
  private configs = new Map<string, McpServerConfig>();
  private states = new Map<string, McpConnectionState>();
  onStateChange: (id: string, state: McpConnectionState) => void = () => {};
  /** Notifies when the tool registry should be rebuilt (list_changed). */
  onToolsChanged: () => void = () => {};

  constructor() {
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
    const servers = await this.listServers();
    const config = servers.find((s) => s.id === id);
    if (!config || !config.enabled) return;
    if (this.clients.has(id)) return;

    this.setState(id, { status: 'connecting' });
    try {
      const { McpWorkerClient } = await import('./workerClient');
      const client = new McpWorkerClient(config.id, () => {
        this.setState(config.id, { status: 'ready', toolCount: client.tools.length });
        this.onToolsChanged();
      });
      await client.connect({
        url: config.url,
        authorization: await this.authHeaderFor(config.id),
      });
      this.clients.set(id, client);
      this.setState(id, { status: 'ready', toolCount: client.tools.length });
      this.onToolsChanged();
    } catch (e) {
      this.setState(id, { status: 'error', reason: attributeError((e as Error).message) });
      throw e;
    }
  }

  async disconnect(id: string): Promise<void> {
    const client = this.clients.get(id);
    this.clients.delete(id);
    await client?.close();
    this.setState(id, { status: 'disconnected' });
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

  private async validOAuthToken(config: McpServerConfig): Promise<string | null> {
    if (config.auth.kind !== 'oauth' || !config.auth.tokens) return null;
    const { tokens } = config.auth;
    const access = await readMcpAccess(config.id);
    if (tokens.expiresAt > Date.now() + 30_000 && access) return access;
    // Refresh silently (docs/07 §3).
    const refresh = await readMcpRefresh(config);
    if (refresh && config.auth.clientId) {
      try {
        const meta = await discoverAuthServer(config.url);
        const fresh = await refreshTokens(meta.token_endpoint, config.auth.clientId, refresh);
        await this.persistTokens(config.id, fresh);
        return fresh.access;
      } catch {
        return null;
      }
    }
    return null;
  }

  /** Full OAuth flow (discovery → DCR → PKCE → token) for the settings page. */
  async runOAuthFlow(id: string): Promise<void> {
    const servers = await this.listServers();
    const config = servers.find((s) => s.id === id);
    if (!config || config.auth.kind !== 'oauth') throw new Error('not an oauth server');
    const meta = await discoverAuthServer(config.url);
    const clientId = config.auth.clientId ?? (await registerClient(meta));
    const tokens = await authorize(meta, clientId, config.auth.scopes);
    await this.persistTokens(id, tokens, clientId);
  }

  private async reauth(id: string): Promise<boolean> {
    try {
      await this.runOAuthFlow(id);
      return true;
    } catch {
      this.setState(id, { status: 'error', reason: '需要重新授权' });
      return false;
    }
  }

  async reauthorizeWorker(id: string): Promise<string | null> {
    const config = (await this.listServers()).find((server) => server.id === id);
    if (!config || config.auth.kind !== 'oauth' || !(await this.reauth(id))) return null;
    return this.authHeaderFor(id);
  }

  private async persistTokens(
    id: string,
    tokens: { access: string; refresh?: string; expiresAt: number },
    clientId?: string,
  ): Promise<void> {
    const servers = await this.listServers();
    const config = servers.find((s) => s.id === id);
    if (!config || config.auth.kind !== 'oauth') return;
    config.auth.tokens = tokens;
    if (clientId) config.auth.clientId = clientId;
    await saveMcpServers(servers);
  }

  // ---- capability bridging (docs/07 §4) --------------------------------------

  /** tools → AgentTool[], name = mcp__{serverId}__{tool}. */
  buildTools(): AnyAgentTool[] {
    const out: AnyAgentTool[] = [];
    for (const [serverId, client] of this.clients) {
      const config = this.configs.get(serverId);
      for (const tool of client.tools) {
        if (config?.disabledTools.includes(tool.name)) continue;
        const fqName = `mcp__${serverId}__${tool.name}`;
        // annotations.readOnlyHint → read; unstated defaults to write (docs/07 §4).
        const effects = tool.annotations?.readOnlyHint ? 'read' : 'write';
        out.push({
          name: fqName,
          label: tool.annotations?.title ?? tool.name,
          description: tool.description ?? `MCP tool ${tool.name}`,
          parameters: schemaToZod(tool.inputSchema),
          level: 'mcp',
          effects,
          recovery: effects === 'read' ? 'retry-safe' : 'never-retry',
          resultTrust: 'untrusted',
          resultProvenance: 'mcp',
          inputSchema: tool.inputSchema,
          resolveTarget: async () => ({
            origin: new URL(
              (await this.listServers()).find((server) => server.id === serverId)!.url,
            ).origin,
            serverId,
          }),
          execute: async (_id, params) => {
            const result = await client.callTool(tool.name, params);
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
      for (const resource of client.resources) {
        resources.push({
          serverId,
          uri: resource.uri,
          name: resource.name ?? resource.uri,
          description: resource.description,
          origin: this.configs.get(serverId)
            ? new URL(this.configs.get(serverId)!.url).origin
            : undefined,
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
