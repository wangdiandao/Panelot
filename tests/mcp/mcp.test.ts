import { afterEach, describe, expect, it, vi } from 'vitest';
import packageJson from '../../package.json' with { type: 'json' };
import { parseMcpJson } from '../../src/mcp/types';
import { McpClient } from '../../src/mcp/client';

afterEach(() => vi.restoreAllMocks());

describe('parseMcpJson (docs/07 §2 — Claude Code / Cursor import)', () => {
  it('parses the Claude Code mcpServers shape with a bearer header', () => {
    const json = JSON.stringify({
      mcpServers: {
        github: {
          url: 'https://mcp.github.com/mcp',
          type: 'http',
          headers: { Authorization: 'Bearer ghp_xxx' },
        },
      },
    });
    const parsed = parseMcpJson(json);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      name: 'github',
      url: 'https://mcp.github.com/mcp',
      auth: { kind: 'bearer', token: 'ghp_xxx' },
    });
  });

  it('parses a bare server map and defaults to no auth', () => {
    const parsed = parseMcpJson(
      JSON.stringify({ linear: { url: 'https://mcp.linear.app/sse', type: 'sse' } }),
    );
    expect(parsed[0]).toMatchObject({ name: 'linear', auth: { kind: 'none' } });
  });

  it('skips stdio command-based servers', () => {
    expect(() =>
      parseMcpJson(JSON.stringify({ local: { command: 'node', args: ['server.js'] } })),
    ).toThrow(/远端 MCP/);
  });

  it('rejects invalid JSON', () => {
    expect(() => parseMcpJson('{not json')).toThrow(/JSON/);
  });

  it.each([
    'http://mcp.example.com/mcp',
    'https://user:pass@mcp.example.com/mcp',
    'https://mcp.example.com/mcp#fragment',
  ])('rejects an unsafe remote MCP URL: %s', (url) => {
    expect(() => parseMcpJson(JSON.stringify({ unsafe: { url } }))).toThrow();
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

function initializeResult(id: number | string) {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      serverInfo: { name: 'mock-mcp', version: '1.0.0' },
    },
  };
}

function emptyCapabilityResult(method: string, id: number | string) {
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: [] } };
  if (method === 'prompts/list') return { jsonrpc: '2.0', id, result: { prompts: [] } };
  if (method === 'resources/list') return { jsonrpc: '2.0', id, result: { resources: [] } };
  return { jsonrpc: '2.0', id, result: {} };
}

describe('McpClient', () => {
  it('performs the initialize handshake then lists capabilities', async () => {
    const calls: string[] = [];
    let initializeRequest: { params?: { clientInfo?: { version?: string } } } | undefined;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      calls.push(body.method);
      if (body.method === 'initialize') {
        initializeRequest = body;
        return jsonResponse(initializeResult(body.id), { 'mcp-session-id': 'sess-1' });
      }
      if (body.method === 'tools/list')
        return jsonResponse({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            tools: [
              {
                name: 'echo',
                inputSchema: { type: 'object' },
                annotations: { readOnlyHint: true },
              },
            ],
          },
        });
      if (body.method === 'prompts/list')
        return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { prompts: [] } });
      if (body.method === 'resources/list')
        return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { resources: [] } });
      return jsonResponse(emptyCapabilityResult(body.method, body.id));
    });

    const client = new McpClient({
      url: 'https://mcp.test/mcp',
      authHeader: async () => 'Bearer t',
    });
    await client.connect();
    expect(calls).toContain('initialize');
    expect(initializeRequest?.params?.clientInfo?.version).toBe(packageJson.version);
    expect(calls).toContain('notifications/initialized');
    expect(client.tools).toHaveLength(1);
    expect(client.tools[0]!.annotations?.readOnlyHint).toBe(true);
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(0);
    for (const [, init] of fetchSpy.mock.calls) {
      expect(init).toEqual(expect.objectContaining({ redirect: 'error' }));
    }
  });

  it('re-authorizes once on 401 then retries', async () => {
    let unauthorizedCalls = 0;
    let receivedChallenge: unknown;
    let firstCall = true;
    const onBeforeFetch = vi.fn(async () => undefined);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      if (body.method === 'initialize' && firstCall) {
        firstCall = false;
        return new Response('unauthorized', {
          status: 401,
          headers: {
            'WWW-Authenticate':
              'Bearer resource_metadata="https://mcp.test/oauth/prm", scope="files:read"',
          },
        });
      }
      if (body.method === 'initialize') return jsonResponse(initializeResult(body.id));
      return jsonResponse(emptyCapabilityResult(body.method, body.id));
    });

    const client = new McpClient({
      url: 'https://mcp.test/mcp',
      authHeader: async () => 'Bearer t',
      onBeforeFetch,
      onUnauthorized: async (challenge) => {
        unauthorizedCalls++;
        receivedChallenge = challenge;
        return true;
      },
    });
    // initialize triggers 401 → reauth → retry succeeds.
    await client.connect();
    expect(unauthorizedCalls).toBe(1);
    expect(receivedChallenge).toEqual({
      resourceMetadataUrl: 'https://mcp.test/oauth/prm',
      scope: 'files:read',
      error: undefined,
    });
    expect(onBeforeFetch).toHaveBeenCalledTimes(fetchSpy.mock.calls.length);
  });

  it('fails closed before network I/O when the host permission preflight rejects', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const client = new McpClient({
      url: 'https://mcp.test/mcp',
      authHeader: async () => null,
      onBeforeFetch: async () => {
        throw new Error('MCP host permission is required');
      },
    });

    await expect(client.connect()).rejects.toThrow(/host permission/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('performs step-up authorization for an insufficient_scope challenge', async () => {
    let firstCall = true;
    const onUnauthorized = vi.fn(async () => true);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      if (body.method === 'initialize' && firstCall) {
        firstCall = false;
        return new Response('forbidden', {
          status: 403,
          headers: {
            'WWW-Authenticate':
              'Bearer error="insufficient_scope", scope="files:write", resource_metadata="https://mcp.test/oauth/prm"',
          },
        });
      }
      if (body.method === 'initialize') return jsonResponse(initializeResult(body.id));
      return jsonResponse(emptyCapabilityResult(body.method, body.id));
    });

    const client = new McpClient({
      url: 'https://mcp.test/mcp',
      authHeader: async () => 'Bearer t',
      onUnauthorized,
    });
    await client.connect();
    expect(onUnauthorized).toHaveBeenCalledWith({
      resourceMetadataUrl: 'https://mcp.test/oauth/prm',
      scope: 'files:write',
      error: 'insufficient_scope',
    });
  });

  it('surfaces JSON-RPC errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      if (body.method === 'initialize') return jsonResponse(initializeResult(body.id));
      if (body.method.endsWith('/list')) {
        return jsonResponse(emptyCapabilityResult(body.method, body.id));
      }
      return jsonResponse({
        jsonrpc: '2.0',
        id: body.id,
        error: { code: -32601, message: 'method not found' },
      });
    });
    const client = new McpClient({ url: 'https://mcp.test/mcp', authHeader: async () => null });
    await client.connect();
    await expect(client.callTool('missing', {})).rejects.toThrow(/method not found/);
  });

  it('reads a JSON-RPC response from an SSE stream', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      const payload =
        body.method === 'initialize'
          ? initializeResult(body.id)
          : body.method.endsWith('/list')
            ? emptyCapabilityResult(body.method, body.id)
            : {
                jsonrpc: '2.0',
                id: body.id,
                result: { content: [{ type: 'text', text: 'streamed' }] },
              };
      const frame = `data: ${JSON.stringify(payload)}\n\n`;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(frame));
          c.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    const client = new McpClient({ url: 'https://mcp.test/mcp', authHeader: async () => null });
    await client.connect();
    const result = await client.callTool('echo', { text: 'hi' });
    expect(result.content[0]!.text).toBe('streamed');
  });

  it('retains the last valid capability category when a refresh temporarily fails', async () => {
    let failTools = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      if (body.method === 'initialize') return jsonResponse(initializeResult(body.id));
      if (body.method === 'tools/list') {
        return failTools
          ? jsonResponse({
              jsonrpc: '2.0',
              id: body.id,
              error: { code: -32603, message: 'temporary catalog failure' },
            })
          : jsonResponse({
              jsonrpc: '2.0',
              id: body.id,
              result: { tools: [{ name: 'stable', inputSchema: { type: 'object' } }] },
            });
      }
      return jsonResponse(emptyCapabilityResult(body.method, body.id));
    });
    const changed = vi.fn();
    const client = new McpClient({
      url: 'https://mcp.test/mcp',
      authHeader: async () => null,
      onCapabilitiesChanged: changed,
    });
    await client.connect();
    failTools = true;

    await client.refreshCapabilities();

    expect(client.tools.map((tool) => tool.name)).toEqual(['stable']);
    expect(changed).toHaveBeenCalled();
  });

  it('does not let an older concurrent capability refresh overwrite a newer catalog', async () => {
    let toolListCalls = 0;
    let resolveStale: ((response: Response) => void) | undefined;
    let staleRequestId: number | string | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      if (body.method === 'initialize') return jsonResponse(initializeResult(body.id));
      if (body.method === 'tools/list') {
        toolListCalls += 1;
        if (toolListCalls === 2) {
          staleRequestId = body.id;
          return new Promise<Response>((resolve) => {
            resolveStale = resolve;
          });
        }
        const name = toolListCalls === 1 ? 'initial' : 'newest';
        return jsonResponse({
          jsonrpc: '2.0',
          id: body.id,
          result: { tools: [{ name, inputSchema: { type: 'object' } }] },
        });
      }
      return jsonResponse(emptyCapabilityResult(body.method, body.id));
    });
    const client = new McpClient({ url: 'https://mcp.test/mcp', authHeader: async () => null });
    await client.connect();

    const stale = client.refreshCapabilities();
    await vi.waitFor(() => expect(toolListCalls).toBe(2));
    await client.refreshCapabilities();
    resolveStale?.(
      jsonResponse({
        jsonrpc: '2.0',
        id: staleRequestId!,
        result: { tools: [{ name: 'stale', inputSchema: { type: 'object' } }] },
      }),
    );
    await stale;

    expect(client.tools.map((tool) => tool.name)).toEqual(['newest']);
  });

  it('does not dispatch a serialized tool call that was cancelled while queued', async () => {
    let releaseFirst: ((value: { content: never[] }) => void) | undefined;
    const callTool = vi.fn(
      () =>
        new Promise<{ content: never[] }>((resolve) => {
          releaseFirst = resolve;
        }),
    );
    const client = new McpClient({ url: 'https://mcp.test/mcp', authHeader: async () => null });
    (client as unknown as { sdk: { callTool: typeof callTool } }).sdk = { callTool };
    const first = client.callTool('first', {}, { threadId: 'thread-1', itemId: 'item-1' });
    await vi.waitFor(() => expect(callTool).toHaveBeenCalledTimes(1));
    const controller = new AbortController();
    const cancelled = client.callTool(
      'cancelled',
      {},
      { threadId: 'thread-1', itemId: 'item-2' },
      controller.signal,
    );

    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    expect(callTool).toHaveBeenCalledTimes(1);
    releaseFirst?.({ content: [] });
    await first;
    expect(callTool).toHaveBeenCalledTimes(1);
  });
});
