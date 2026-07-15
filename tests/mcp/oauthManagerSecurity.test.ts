import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  deleteMcpAccess: vi.fn(),
  discoverAuthServer: vi.fn(),
  listMcpServers: vi.fn(),
  readMcpAccess: vi.fn(),
  readMcpBearer: vi.fn(),
  readMcpRefresh: vi.fn(),
  refreshTokens: vi.fn(),
  registerClient: vi.fn(),
  saveMcpServers: vi.fn(),
}));

vi.mock('../../src/settings/store', () => ({
  onStorageChange: vi.fn(),
}));

vi.mock('../../src/mcp/oauth', () => ({
  authorize: mocks.authorize,
  discoverAuthServer: mocks.discoverAuthServer,
  refreshTokens: mocks.refreshTokens,
  registerClient: mocks.registerClient,
}));

vi.mock('../../src/mcp/store', () => ({
  MCP_SERVERS_KEY: 'mcp_servers',
  deleteMcpAccess: mocks.deleteMcpAccess,
  listMcpServers: mocks.listMcpServers,
  protectMcpServer: vi.fn(async (config) => config),
  readMcpAccess: mocks.readMcpAccess,
  readMcpBearer: mocks.readMcpBearer,
  readMcpRefresh: mocks.readMcpRefresh,
  saveMcpServers: mocks.saveMcpServers,
}));

import { McpManager } from '../../src/mcp/manager';
import type { McpServerConfig } from '../../src/mcp/types';

const oldBinding = {
  resource: 'https://mcp.example.com/mcp',
  issuer: 'https://old-auth.example.com',
};
const newBinding = {
  resource: 'https://mcp.example.com/mcp',
  issuer: 'https://new-auth.example.com',
};
const metadata = {
  issuer: newBinding.issuer,
  authorization_endpoint: 'https://new-auth.example.com/authorize',
  token_endpoint: 'https://new-auth.example.com/token',
  registration_endpoint: 'https://new-auth.example.com/register',
  response_types_supported: ['code'],
  code_challenge_methods_supported: ['S256'],
};

let servers: McpServerConfig[];
let deletedBinding: unknown;

beforeEach(() => {
  vi.clearAllMocks();
  deletedBinding = undefined;
  servers = [
    {
      id: 'server-1',
      name: 'Remote MCP',
      url: 'https://mcp.example.com/mcp',
      auth: {
        kind: 'oauth',
        clientId: 'old-client',
        scopes: ['configured:scope'],
        binding: oldBinding,
        tokens: {
          access: '',
          refresh: 'sealed-old-refresh',
          expiresAt: 0,
        },
      },
      enabled: true,
      disabledTools: [],
      connectOnStartup: false,
    },
  ];
  mocks.listMcpServers.mockImplementation(async () => servers);
  mocks.saveMcpServers.mockImplementation(async (next: McpServerConfig[]) => {
    servers = next;
  });
  mocks.deleteMcpAccess.mockImplementation(async (config: McpServerConfig) => {
    deletedBinding =
      config.auth.kind === 'oauth' ? structuredClone(config.auth.binding) : undefined;
  });
  mocks.discoverAuthServer.mockResolvedValue({
    metadata,
    resourceMetadata: {
      resource: newBinding.resource,
      authorization_servers: [newBinding.issuer],
    },
    binding: newBinding,
    scopes: ['challenge:scope'],
  });
  mocks.registerClient.mockResolvedValue('new-client');
  mocks.authorize.mockResolvedValue({
    access: 'new-access',
    refresh: 'new-refresh',
    expiresAt: Date.now() + 3_600_000,
  });
  vi.stubGlobal('chrome', {
    permissions: { contains: vi.fn(async () => true) },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MCP OAuth credential binding', () => {
  it('does not send an old client id to a newly discovered issuer', async () => {
    const manager = new McpManager();
    const preview = await manager.runOAuthFlow('server-1');
    expect(preview).toMatchObject({
      status: 'permission_required',
      stage: 'oauth_endpoints',
      reason: 'plan_changed',
    });
    expect(mocks.deleteMcpAccess).toHaveBeenCalledOnce();
    expect(deletedBinding).toEqual(oldBinding);
    if (preview.status !== 'permission_required') throw new Error('Expected OAuth plan preview');
    await manager.runOAuthFlow(
      'server-1',
      {},
      {
        stage: preview.stage,
        planDigest: preview.planDigest,
      },
    );

    expect(mocks.registerClient).toHaveBeenCalledWith(
      metadata,
      ['challenge:scope'],
      expect.any(Function),
      newBinding.resource,
    );
    expect(mocks.authorize).toHaveBeenCalledWith(
      metadata,
      'new-client',
      newBinding.resource,
      ['challenge:scope'],
      expect.any(Function),
    );
    expect(mocks.authorize).not.toHaveBeenCalledWith(
      expect.anything(),
      'old-client',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(mocks.deleteMcpAccess).toHaveBeenCalledOnce();
    expect(deletedBinding).toEqual(oldBinding);
    expect(servers[0]!.auth).toMatchObject({
      kind: 'oauth',
      clientId: 'new-client',
      binding: newBinding,
      tokens: { refresh: 'new-refresh' },
    });
  });

  it('does not read or refresh an old token after the issuer changes', async () => {
    const manager = new McpManager();
    const access = await (
      manager as unknown as {
        validOAuthToken(config: McpServerConfig): Promise<string | null>;
      }
    ).validOAuthToken(servers[0]!);

    expect(access).toBeNull();
    expect(mocks.readMcpAccess).not.toHaveBeenCalled();
    expect(mocks.readMcpRefresh).not.toHaveBeenCalled();
    expect(mocks.refreshTokens).not.toHaveBeenCalled();
  });

  it('passes a 401 scope challenge to discovery as authoritative input', async () => {
    servers[0]!.auth = { kind: 'oauth', scopes: ['configured:scope'] };
    const manager = new McpManager();
    await manager.runOAuthFlow('server-1', {
      resourceMetadataUrl: 'https://mcp.example.com/oauth/prm',
      scope: 'challenge:scope',
    });

    expect(mocks.discoverAuthServer).toHaveBeenCalledWith(servers[0]!.url, {
      resourceMetadataUrl: 'https://mcp.example.com/oauth/prm',
      scope: 'challenge:scope',
      preferredIssuer: undefined,
      permissionGuard: expect.any(Function),
    });
    expect(mocks.authorize).toHaveBeenCalledWith(
      metadata,
      'new-client',
      newBinding.resource,
      ['challenge:scope'],
      expect.any(Function),
    );
  });
});
