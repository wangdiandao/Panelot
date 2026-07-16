import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  close: vi.fn(async () => undefined),
  instances: [] as Array<{ connect: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }>,
  listMcpServers: vi.fn(),
}));

vi.mock('../../src/settings/store', () => ({ onStorageChange: vi.fn() }));
vi.mock('../../src/mcp/store', () => ({
  MCP_SERVERS_KEY: 'mcp_servers',
  deleteMcpAccess: vi.fn(),
  listMcpServers: mocks.listMcpServers,
  protectMcpServer: vi.fn(async (config) => config),
  readMcpAccess: vi.fn(),
  readMcpBearer: vi.fn(),
  readMcpRefresh: vi.fn(),
  saveMcpServers: vi.fn(),
}));
vi.mock('../../src/mcp/workerClient', () => ({
  McpWorkerClient: class {
    readonly tools = [];
    readonly prompts = [];
    readonly resources = [];
    readonly connect = vi.fn((config: unknown) => mocks.connect(config));
    readonly close = vi.fn(() => mocks.close());

    constructor() {
      mocks.instances.push(this);
    }
  },
}));

import { McpManager } from '../../src/mcp/manager';

const server = {
  id: 'server-1',
  name: 'Server',
  url: 'https://mcp.example.com/mcp',
  auth: { kind: 'none' as const },
  enabled: true,
  disabledTools: [],
  connectOnStartup: false,
};

const permissionBroker = {
  inspectAll: vi.fn(async (origins: readonly string[]) =>
    origins.map((origin) => ({ origin, pattern: `${origin}/*`, granted: true })),
  ),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.instances.length = 0;
  mocks.listMcpServers.mockResolvedValue([server]);
  mocks.connect.mockResolvedValue(undefined);
});

describe('McpManager connection serialization', () => {
  it('shares one in-flight connection attempt per server', async () => {
    let finish: (() => void) | undefined;
    mocks.connect.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)));
    const manager = new McpManager(permissionBroker as never);

    const first = manager.connect(server.id);
    const second = manager.connect(server.id);
    await vi.waitFor(() => expect(mocks.connect).toHaveBeenCalledOnce());

    expect(mocks.instances).toHaveLength(1);
    finish?.();
    await Promise.all([first, second]);
    expect(manager.getState(server.id)).toEqual({ status: 'ready', toolCount: 0 });
  });

  it('closes a failed candidate and permits a clean retry', async () => {
    mocks.connect.mockRejectedValueOnce(new Error('connect failed'));
    const manager = new McpManager(permissionBroker as never);

    await expect(manager.connect(server.id)).rejects.toThrow('connect failed');
    expect(mocks.instances).toHaveLength(1);
    expect(mocks.instances[0]?.close).toHaveBeenCalledOnce();

    await expect(manager.connect(server.id)).resolves.toBeUndefined();
    expect(mocks.instances).toHaveLength(2);
    expect(mocks.instances[1]?.connect).toHaveBeenCalledOnce();
    expect(manager.getState(server.id)).toEqual({ status: 'ready', toolCount: 0 });
  });

  it('queues a reconnect after an in-flight connect and disconnect barrier', async () => {
    let finishFirstConnect: (() => void) | undefined;
    mocks.connect.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishFirstConnect = resolve)),
    );
    const manager = new McpManager(permissionBroker as never);

    const firstConnect = manager.connect(server.id);
    await vi.waitFor(() => expect(mocks.connect).toHaveBeenCalledOnce());
    const disconnect = manager.disconnect(server.id);
    const reconnect = manager.connect(server.id);

    finishFirstConnect?.();
    await Promise.all([firstConnect, disconnect, reconnect]);

    expect(mocks.instances).toHaveLength(2);
    expect(mocks.instances[0]?.close).toHaveBeenCalledOnce();
    expect(mocks.instances[1]?.connect).toHaveBeenCalledOnce();
    expect(manager.getState(server.id)).toEqual({ status: 'ready', toolCount: 0 });
  });

  it('reports disconnected state even when client cleanup fails', async () => {
    mocks.close.mockRejectedValueOnce(new Error('close failed'));
    const manager = new McpManager(permissionBroker as never);
    await manager.connect(server.id);

    await expect(manager.disconnect(server.id)).rejects.toThrow('close failed');

    expect(manager.getState(server.id)).toEqual({ status: 'disconnected' });
  });
});
