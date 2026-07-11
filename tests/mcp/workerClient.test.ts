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
});
