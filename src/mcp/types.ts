/**
 * MCP server config & JSON import (docs/07 §2).
 */

export interface McpServerConfig {
  id: string;
  name: string;
  url: string;
  auth:
    | { kind: 'none' }
    | { kind: 'bearer'; token: string }
    | {
        kind: 'oauth';
        clientId?: string;
        scopes?: string[];
        tokens?: { access: string; refresh?: string; expiresAt: number };
      };
  enabled: boolean;
  disabledTools: string[];
  /** false = connect lazily on first use (default, saves resources). */
  connectOnStartup: boolean;
}

export type McpConnectionState =
  | { status: 'disconnected' }
  | { status: 'connecting' }
  | { status: 'ready'; toolCount: number }
  | { status: 'error'; reason: string };

/**
 * Parse a pasted JSON snippet (Claude Code `mcpServers` or Cursor config).
 * Recognizes url / type: http|sse / headers.Authorization (docs/07 §2).
 */
export function parseMcpJson(
  json: string,
): Omit<McpServerConfig, 'id' | 'enabled' | 'disabledTools' | 'connectOnStartup'>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('无效的 JSON');
  }

  // Accept either { mcpServers: {...} } or a bare { name: {...} } map.
  const servers =
    (parsed as { mcpServers?: Record<string, unknown> }).mcpServers ??
    (parsed as Record<string, unknown>);
  if (typeof servers !== 'object' || servers === null) throw new Error('未找到 mcpServers 配置');

  const results: Omit<McpServerConfig, 'id' | 'enabled' | 'disabledTools' | 'connectOnStartup'>[] =
    [];
  for (const [name, raw] of Object.entries(servers)) {
    const entry = raw as {
      url?: string;
      type?: string;
      headers?: Record<string, string>;
      command?: string;
    };
    if (!entry.url) continue; // Local command transports are outside the extension security boundary.
    const authHeader = entry.headers?.Authorization ?? entry.headers?.authorization;
    const bearer = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1];
    results.push({
      name,
      url: entry.url,
      auth: bearer ? { kind: 'bearer', token: bearer } : { kind: 'none' },
    });
  }
  if (results.length === 0)
    throw new Error('未找到含 url 的远端 MCP 服务器（不支持本地 stdio 服务器）');
  return results;
}
