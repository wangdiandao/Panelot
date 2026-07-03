import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseMcpJson } from '../../src/mcp/types';
import { McpClient } from '../../src/mcp/client';

afterEach(() => vi.restoreAllMocks());

describe('parseMcpJson (docs/07 §2 — Claude Code / Cursor import)', () => {
  it('parses the Claude Code mcpServers shape with a bearer header', () => {
    const json = JSON.stringify({
      mcpServers: {
        github: { url: 'https://mcp.github.com/mcp', type: 'http', headers: { Authorization: 'Bearer ghp_xxx' } },
      },
    });
    const parsed = parseMcpJson(json);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ name: 'github', url: 'https://mcp.github.com/mcp', auth: { kind: 'bearer', token: 'ghp_xxx' } });
  });

  it('parses a bare server map and defaults to no auth', () => {
    const parsed = parseMcpJson(JSON.stringify({ linear: { url: 'https://mcp.linear.app/sse', type: 'sse' } }));
    expect(parsed[0]).toMatchObject({ name: 'linear', auth: { kind: 'none' } });
  });

  it('skips stdio (command-based) servers — V1 is remote-only', () => {
    expect(() =>
      parseMcpJson(JSON.stringify({ local: { command: 'node', args: ['server.js'] } })),
    ).toThrow(/远端 MCP/);
  });

  it('rejects invalid JSON', () => {
    expect(() => parseMcpJson('{not json')).toThrow(/JSON/);
  });
});

// ---------------------------------------------------------------------------
// McpClient JSON-RPC over HTTP
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('McpClient', () => {
  it('performs the initialize handshake then lists capabilities', async () => {
    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      calls.push(body.method);
      if (body.method === 'initialize') return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { capabilities: {} } }, { 'mcp-session-id': 'sess-1' });
      if (body.method === 'tools/list') return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'echo', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] } });
      if (body.method === 'prompts/list') return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { prompts: [] } });
      if (body.method === 'resources/list') return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { resources: [] } });
      return jsonResponse({ jsonrpc: '2.0', id: body.id, result: {} });
    });

    const client = new McpClient({ url: 'https://mcp.test/mcp', authHeader: async () => 'Bearer t' });
    await client.connect();
    expect(calls).toContain('initialize');
    expect(calls).toContain('notifications/initialized');
    expect(client.tools).toHaveLength(1);
    expect(client.tools[0]!.annotations?.readOnlyHint).toBe(true);
  });

  it('re-authorizes once on 401 then retries', async () => {
    let unauthorizedCalls = 0;
    let firstCall = true;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      if (body.method === 'initialize' && firstCall) {
        firstCall = false;
        return new Response('unauthorized', { status: 401 });
      }
      return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { capabilities: {} } });
    });

    const client = new McpClient({
      url: 'https://mcp.test/mcp',
      authHeader: async () => 'Bearer t',
      onUnauthorized: async () => {
        unauthorizedCalls++;
        return true;
      },
    });
    // initialize triggers 401 → reauth → retry succeeds.
    await client.connect();
    expect(unauthorizedCalls).toBe(1);
  });

  it('surfaces JSON-RPC errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'method not found' } }),
    );
    const client = new McpClient({ url: 'https://mcp.test/mcp', authHeader: async () => null });
    await expect(client.callTool('missing', {})).rejects.toThrow(/method not found/);
  });

  it('reads a JSON-RPC response from an SSE stream', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      const frame = `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'streamed' }] } })}\n\n`;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(frame));
          c.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    const client = new McpClient({ url: 'https://mcp.test/mcp', authHeader: async () => null });
    const result = await client.callTool('echo', { text: 'hi' });
    expect(result.content[0]!.text).toBe('streamed');
  });
});
