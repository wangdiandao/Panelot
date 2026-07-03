/**
 * McpManager (docs/07 §1/§4): owns clients, bridges capabilities into the
 * agent (tools→AgentTool, prompts→slash commands, resources→@refs), manages
 * auth (bearer/OAuth with refresh), and connection state.
 */

import { z } from 'zod';
import type { AnyAgentTool } from '../agent/tool';
import { fenceUntrusted } from '../prompts/assemble';
import { storageGet, storageSet } from '../settings/store';
import { McpClient } from './client';
import { discoverAuthServer, authorize, refreshTokens, registerClient } from './oauth';
import type { McpConnectionState, McpServerConfig } from './types';

const SERVERS_KEY = 'mcp_servers';

/** json-schema-to-zod would be ideal; a pragmatic passthrough keeps V1 light.
 *  The raw JSON Schema is forwarded to the provider unchanged (docs/07 §4). */
function schemaToZod(inputSchema: Record<string, unknown>): z.ZodType {
  // We validate loosely here (real validation is server-side); the provider
  // receives the raw JSON Schema via the AgentTool.parameters → toJSONSchema
  // path, so we wrap in a passthrough object preserving the shape.
  return z.object({}).passthrough().describe(JSON.stringify(inputSchema));
}

export class McpManager {
  private clients = new Map<string, McpClient>();
  private states = new Map<string, McpConnectionState>();
  onStateChange: (id: string, state: McpConnectionState) => void = () => {};
  /** Notifies when the tool registry should be rebuilt (list_changed). */
  onToolsChanged: () => void = () => {};

  async listServers(): Promise<McpServerConfig[]> {
    return storageGet<McpServerConfig[]>(SERVERS_KEY, []);
  }

  async saveServer(config: McpServerConfig): Promise<void> {
    const servers = await this.listServers();
    const idx = servers.findIndex((s) => s.id === config.id);
    if (idx === -1) servers.push(config);
    else servers[idx] = config;
    await storageSet(SERVERS_KEY, servers);
  }

  async removeServer(id: string): Promise<void> {
    await this.disconnect(id);
    const servers = await this.listServers();
    await storageSet(SERVERS_KEY, servers.filter((s) => s.id !== id));
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
      const client = new McpClient({
        url: config.url,
        authHeader: () => this.authHeaderFor(config.id),
        onUnauthorized: () => this.reauth(config.id),
      });
      await client.connect();
      this.clients.set(id, client);
      this.setState(id, { status: 'ready', toolCount: client.tools.length });
      this.onToolsChanged();
    } catch (e) {
      this.setState(id, { status: 'error', reason: attributeError((e as Error).message) });
      throw e;
    }
  }

  async disconnect(id: string): Promise<void> {
    this.clients.delete(id);
    this.setState(id, { status: 'disconnected' });
  }

  /** Ensure lazy-connect servers are up before first use (docs/07 §2). */
  async ensureConnected(): Promise<void> {
    const servers = await this.listServers();
    await Promise.all(
      servers.filter((s) => s.enabled && !this.clients.has(s.id)).map((s) => this.connect(s.id).catch(() => {})),
    );
  }

  // ---- auth ------------------------------------------------------------------

  private async authHeaderFor(id: string): Promise<string | null> {
    const config = (await this.listServers()).find((s) => s.id === id);
    if (!config) return null;
    if (config.auth.kind === 'bearer') return `Bearer ${config.auth.token}`;
    if (config.auth.kind === 'oauth') {
      const access = await this.validOAuthToken(config);
      return access ? `Bearer ${access}` : null;
    }
    return null;
  }

  private async validOAuthToken(config: McpServerConfig): Promise<string | null> {
    if (config.auth.kind !== 'oauth' || !config.auth.tokens) return null;
    const { tokens } = config.auth;
    if (tokens.expiresAt > Date.now() + 30_000) return tokens.access;
    // Refresh silently (docs/07 §3).
    if (tokens.refresh && config.auth.clientId) {
      try {
        const meta = await discoverAuthServer(config.url);
        const fresh = await refreshTokens(meta.token_endpoint, config.auth.clientId, tokens.refresh);
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

  private async persistTokens(id: string, tokens: { access: string; refresh?: string; expiresAt: number }, clientId?: string): Promise<void> {
    const servers = await this.listServers();
    const config = servers.find((s) => s.id === id);
    if (!config || config.auth.kind !== 'oauth') return;
    config.auth.tokens = tokens;
    if (clientId) config.auth.clientId = clientId;
    await storageSet(SERVERS_KEY, servers);
  }

  // ---- capability bridging (docs/07 §4) --------------------------------------

  /** tools → AgentTool[], name = mcp__{serverId}__{tool}. */
  buildTools(): AnyAgentTool[] {
    const out: AnyAgentTool[] = [];
    for (const [serverId, client] of this.clients) {
      for (const tool of client.tools) {
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
          execute: async (_id, params) => {
            const result = await client.callTool(tool.name, params);
            const text = result.content.map((c) => c.text ?? '').join('\n');
            const fenced = fenceUntrusted(text, `mcp://${serverId}`, fqName);
            if (result.isError) throw new Error(text || 'MCP tool error');
            return { content: [{ type: 'text', text: fenced }] };
          },
        });
      }
    }
    return out;
  }

  /** prompts → slash-command descriptors (docs/07 §4). */
  listPromptCommands(): { command: string; serverId: string; prompt: string; args: { name: string; required?: boolean }[] }[] {
    const out: { command: string; serverId: string; prompt: string; args: { name: string; required?: boolean }[] }[] = [];
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

  async getClient(serverId: string): Promise<McpClient | undefined> {
    return this.clients.get(serverId);
  }
}

function attributeError(message: string): string {
  if (/401|unauthor/i.test(message)) return '需要授权 (401)';
  if (/CORS|host permission/i.test(message)) return 'CORS/权限问题 — 检查 host 权限';
  if (/protocol|version/i.test(message)) return '协议版本不符';
  if (/fetch|network|Failed to fetch/i.test(message)) return '网络不可达';
  return message;
}
