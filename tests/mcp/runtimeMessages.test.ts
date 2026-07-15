import { describe, expect, it, vi } from 'vitest';
import type { McpManager } from '../../src/mcp/manager';
import { handleMcpRuntimeMessage } from '../../src/mcp/runtimeMessages';

describe('MCP runtime message routing', () => {
  it('returns the current server description without reconnecting for a status request', async () => {
    const description = { id: 'server-a', state: 'connected' };
    const manager = {
      describeServer: vi.fn(() => description),
    } as unknown as McpManager;
    const sendResponse = vi.fn();

    handleMcpRuntimeMessage(manager, { type: 'panelot.mcpStatus', id: 'server-a' }, sendResponse);
    await Promise.resolve();

    expect(sendResponse).toHaveBeenCalledWith({ ok: true, description });
  });

  it('reports a successful worker permission check', async () => {
    const manager = {
      checkWorkerFetchPermission: vi.fn(async () => ({ status: 'complete' })),
    } as unknown as McpManager;
    const sendResponse = vi.fn();

    handleMcpRuntimeMessage(
      manager,
      {
        type: 'panelot.mcpWorkerPermissionCheck',
        id: 'server-a',
        url: 'https://mcp.example.com/token',
      },
      sendResponse,
    );
    await Promise.resolve();

    expect(sendResponse).toHaveBeenCalledWith({ allowed: true });
  });

  it('rejects malformed or unknown MCP requests', () => {
    const sendResponse = vi.fn();

    handleMcpRuntimeMessage({} as McpManager, { type: 'panelot.mcpUnknown' }, sendResponse);

    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'Invalid MCP request' });
  });
});
