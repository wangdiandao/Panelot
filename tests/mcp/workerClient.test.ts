import { beforeEach, describe, expect, it, vi } from 'vitest';
import { McpWorkerClient } from '../../src/mcp/workerClient';

describe('McpWorkerClient', () => {
  const listeners: ((message: unknown) => void)[] = [];
  const sendMessage = vi.fn();
  const createDocument = vi.fn();

  beforeEach(() => {
    listeners.length = 0;
    sendMessage.mockReset();
    createDocument.mockReset();
    (globalThis as unknown as { chrome: unknown }).chrome = {
      offscreen: {
        hasDocument: async () => false,
        createDocument,
      },
      runtime: {
        onMessage: {
          addListener: (listener: (message: unknown) => void) => listeners.push(listener),
          removeListener: (listener: (message: unknown) => void) => {
            const index = listeners.indexOf(listener);
            if (index >= 0) listeners.splice(index, 1);
          },
        },
        sendMessage,
      },
    };
  });

  it('creates the offscreen worker and mirrors its capability catalog', async () => {
    sendMessage.mockResolvedValue({
      ok: true,
      catalog: {
        tools: [{ name: 'echo', inputSchema: { type: 'object' } }],
        prompts: [],
        resources: [],
      },
    });
    const client = new McpWorkerClient('server-a', () => {});

    await client.connect({ url: 'https://mcp.example/mcp', authorization: 'Bearer token' });

    expect(createDocument).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'mcp-worker.html' }),
    );
    expect(client.tools).toEqual([expect.objectContaining({ name: 'echo' })]);
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'panelot.mcpWorker.connect',
        serverId: 'server-a',
      }),
    );
  });

  it('removes its runtime listener even when remote close fails', async () => {
    sendMessage.mockRejectedValueOnce(new Error('worker unavailable'));
    const client = new McpWorkerClient('server-a', () => {});
    expect(listeners).toHaveLength(1);

    await expect(client.close()).rejects.toThrow('worker unavailable');

    expect(listeners).toHaveLength(0);
  });

  it.each([undefined, null, [], {}, { ok: 'yes' }, { ok: false }])(
    'rejects an invalid or legacy response envelope: %j',
    async (response) => {
      sendMessage.mockResolvedValueOnce(response);
      const client = new McpWorkerClient('server-a', () => {});

      await expect(
        client.connect({ url: 'https://mcp.example/mcp', authorization: null }),
      ).rejects.toThrow(/MCP worker/);
      expect(client.tools).toEqual([]);
    },
  );

  it('rejects a malformed connect catalog without partially updating capabilities', async () => {
    sendMessage.mockResolvedValueOnce({
      ok: true,
      catalog: {
        tools: [
          { name: 'valid', inputSchema: { type: 'object' } },
          { name: 42, inputSchema: { type: 'object' } },
        ],
        prompts: [],
        resources: [],
      },
    });
    const client = new McpWorkerClient('server-a', () => {});

    await expect(
      client.connect({ url: 'https://mcp.example/mcp', authorization: null }),
    ).rejects.toThrow(/catalog\.tools\[1\]\.name/);
    expect(client.tools).toEqual([]);
    expect(client.prompts).toEqual([]);
    expect(client.resources).toEqual([]);
  });

  it('ignores a malformed capability-change event without polluting the existing catalog', async () => {
    const changed = vi.fn();
    sendMessage.mockResolvedValueOnce({
      ok: true,
      catalog: {
        tools: [{ name: 'echo', inputSchema: { type: 'object' } }],
        prompts: [],
        resources: [],
      },
    });
    const client = new McpWorkerClient('server-a', changed);
    await client.connect({ url: 'https://mcp.example/mcp', authorization: null });

    listeners[0]?.({
      type: 'panelot.mcpWorker.changed',
      serverId: 'server-a',
      catalog: { tools: [{ name: 'bad' }], prompts: [], resources: [] },
    });

    expect(client.tools).toEqual([expect.objectContaining({ name: 'echo' })]);
    expect(changed).not.toHaveBeenCalled();
  });

  it('validates operation-specific nested results', async () => {
    const client = new McpWorkerClient('server-a', () => {});
    sendMessage
      .mockResolvedValueOnce({ ok: true, result: { content: [{ type: 42 }] } })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ok: true,
        result: { contents: [{ uri: 'file:///x', blob: 42 }] },
      });

    await expect(client.callTool('echo', {})).rejects.toThrow(/content\[0\]\.type/);
    await expect(client.getPrompt('prompt', {})).rejects.toThrow(/getPrompt result/);
    await expect(client.readResource('file:///x')).rejects.toThrow(/contents\[0\]\.blob/);
  });

  it('accepts the current operation result wire shapes', async () => {
    const client = new McpWorkerClient('server-a', () => {});
    sendMessage
      .mockResolvedValueOnce({
        ok: true,
        result: { content: [{ type: 'text', text: 'done' }], isError: false },
      })
      .mockResolvedValueOnce({
        ok: true,
        result: {
          messages: [{ role: 'user', content: { type: 'text', text: 'prompt body' } }],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        result: { contents: [{ uri: 'file:///x', text: 'resource body' }] },
      });

    await expect(client.callTool('echo', {})).resolves.toEqual({
      content: [{ type: 'text', text: 'done' }],
      isError: false,
    });
    await expect(client.getPrompt('prompt', {})).resolves.toEqual({
      messages: [{ role: 'user', content: { type: 'text', text: 'prompt body' } }],
    });
    await expect(client.readResource('file:///x')).resolves.toEqual({
      contents: [{ uri: 'file:///x', text: 'resource body' }],
    });
  });
});
