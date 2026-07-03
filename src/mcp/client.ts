/**
 * McpClient (docs/07 §1): one client per remote server over Streamable HTTP
 * (JSON-RPC 2.0), with SSE fallback for servers that stream responses.
 *
 * Kept dependency-light: a hand-rolled JSON-RPC-over-HTTP client rather than
 * wiring the full @modelcontextprotocol/sdk transport into the service worker
 * (MV3 SW + the SDK's Node assumptions add friction; the wire protocol is
 * small and stable). The `annotations.readOnlyHint` → effects mapping and
 * capability bridging follow the SDK's semantics.
 */

import { SseParser } from '../providers/sse';

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; title?: string };
}

export interface McpPrompt {
  name: string;
  description?: string;
  arguments?: { name: string; description?: string; required?: boolean }[];
}

export interface McpResource {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface McpClientOptions {
  url: string;
  /** Returns the current auth header value, or null. Called per request so
   *  refreshed tokens are picked up. */
  authHeader: () => Promise<string | null>;
  /** Called on 401 to trigger re-auth; returns true if re-auth succeeded. */
  onUnauthorized?: () => Promise<boolean>;
}

const PROTOCOL_VERSION = '2025-06-18';

export class McpClient {
  private nextId = 1;
  private sessionId: string | null = null;
  tools: McpTool[] = [];
  prompts: McpPrompt[] = [];
  resources: McpResource[] = [];

  constructor(private opts: McpClientOptions) {}

  async connect(): Promise<void> {
    await this.rpc('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'Panelot', version: '0.1.0' },
    });
    await this.rpcNotify('notifications/initialized');
    await this.refreshCapabilities();
  }

  async refreshCapabilities(): Promise<void> {
    this.tools = ((await this.rpc('tools/list', {}).catch(() => ({ tools: [] }))) as { tools: McpTool[] }).tools ?? [];
    this.prompts = ((await this.rpc('prompts/list', {}).catch(() => ({ prompts: [] }))) as { prompts: McpPrompt[] }).prompts ?? [];
    this.resources = ((await this.rpc('resources/list', {}).catch(() => ({ resources: [] }))) as { resources: McpResource[] }).resources ?? [];
  }

  async callTool(name: string, args: unknown): Promise<{ content: { type: string; text?: string }[]; isError?: boolean }> {
    return this.rpc('tools/call', { name, arguments: args ?? {} }) as Promise<{ content: { type: string; text?: string }[]; isError?: boolean }>;
  }

  async getPrompt(name: string, args: Record<string, unknown>): Promise<{ messages: { role: string; content: { type: string; text?: string } }[] }> {
    return this.rpc('prompts/get', { name, arguments: args }) as Promise<{ messages: { role: string; content: { type: string; text?: string } }[] }>;
  }

  async readResource(uri: string): Promise<{ contents: { uri: string; text?: string; mimeType?: string }[] }> {
    return this.rpc('resources/read', { uri }) as Promise<{ contents: { uri: string; text?: string; mimeType?: string }[] }>;
  }

  // ---- JSON-RPC over Streamable HTTP ----------------------------------------

  private async rpc(method: string, params: unknown, retried = false): Promise<unknown> {
    const id = this.nextId++;
    const res = await this.post({ jsonrpc: '2.0', id, method, params });

    if (res.status === 401) {
      if (!retried && this.opts.onUnauthorized && (await this.opts.onUnauthorized())) {
        return this.rpc(method, params, true);
      }
      throw new Error('MCP 服务器需要重新授权 (401)');
    }
    if (!res.ok) throw new Error(`MCP ${method} 失败: HTTP ${res.status}`);

    const sessionId = res.headers.get('mcp-session-id');
    if (sessionId) this.sessionId = sessionId;

    const contentType = res.headers.get('content-type') ?? '';
    const message = contentType.includes('text/event-stream')
      ? await this.readSseResponse(res, id)
      : ((await res.json()) as JsonRpcResponse);

    if (message.error) throw new Error(`MCP ${method} 错误: ${message.error.message}`);
    return message.result;
  }

  private async rpcNotify(method: string, params?: unknown): Promise<void> {
    await this.post({ jsonrpc: '2.0', method, params });
  }

  private async post(body: object): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': PROTOCOL_VERSION,
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    const auth = await this.opts.authHeader();
    if (auth) headers.Authorization = auth;
    return fetch(this.opts.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000), // docs/07 §4 tool timeout
    });
  }

  /** Read a single JSON-RPC response from an SSE stream (matched by id). */
  private async readSseResponse(res: Response, id: number): Promise<JsonRpcResponse> {
    if (!res.body) throw new Error('SSE 响应无 body');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const { events } = parser.feed(decoder.decode(value, { stream: true }));
        for (const ev of events) {
          try {
            const msg = JSON.parse(ev.data) as JsonRpcResponse;
            if (msg.id === id) return msg;
          } catch {
            /* skip non-JSON frames */
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
    throw new Error('SSE 流结束但未收到匹配的响应');
  }
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}
