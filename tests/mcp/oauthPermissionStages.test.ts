import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpServerConfig } from '../../src/mcp/types';

const storeMocks = vi.hoisted(() => ({
  deleteMcpAccess: vi.fn(),
  listMcpServers: vi.fn(),
  readMcpAccess: vi.fn(),
  readMcpBearer: vi.fn(),
  readMcpRefresh: vi.fn(),
  saveMcpServers: vi.fn(),
}));

vi.mock('../../src/settings/store', () => ({
  onStorageChange: vi.fn(),
}));

vi.mock('../../src/mcp/store', () => ({
  MCP_SERVERS_KEY: 'mcp_servers',
  deleteMcpAccess: storeMocks.deleteMcpAccess,
  listMcpServers: storeMocks.listMcpServers,
  protectMcpServer: vi.fn(async (config) => config),
  readMcpAccess: storeMocks.readMcpAccess,
  readMcpBearer: storeMocks.readMcpBearer,
  readMcpRefresh: storeMocks.readMcpRefresh,
  saveMcpServers: storeMocks.saveMcpServers,
}));

import { McpManager } from '../../src/mcp/manager';

type PermissionApproval = { stage: string; planDigest: string };
type PermissionRequired = {
  status: 'permission_required';
  stage: string;
  origins: string[];
  planDigest: string;
  expiresAt: number;
  reason: string;
  summary: { resource: string; issuer?: string };
};
type FlowResult = { status: 'complete' } | PermissionRequired;

const resource = 'https://rs.example/mcp';
const issuer = 'https://as.example/tenant';
const resourcePattern = 'https://rs.example/*';
const authorizationPattern = 'https://as.example/*';
const registrationPattern = 'https://register.example/*';
const tokenPattern = 'https://token.example/*';

let servers: McpServerConfig[];
let accessSecret: string | null;
let granted: Set<string>;
let tokenOrigin: string;
let fetchCalls: string[];
let launchWebAuthFlow: ReturnType<typeof vi.fn>;
let permissionRequest: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  accessSecret = null;
  granted = new Set([resourcePattern]);
  tokenOrigin = 'https://token.example';
  fetchCalls = [];
  servers = [oauthServer()];

  storeMocks.listMcpServers.mockImplementation(async () => servers);
  storeMocks.readMcpAccess.mockImplementation(async () => accessSecret);
  storeMocks.readMcpRefresh.mockImplementation(async (config: McpServerConfig) =>
    config.auth.kind === 'oauth' ? (config.auth.tokens?.refresh ?? null) : null,
  );
  storeMocks.saveMcpServers.mockImplementation(async (next: McpServerConfig[]) => {
    servers = structuredClone(next);
    const auth = servers[0]?.auth;
    if (auth?.kind === 'oauth' && auth.tokens?.access) accessSecret = auth.tokens.access;
  });
  storeMocks.deleteMcpAccess.mockImplementation(async () => {
    accessSecret = null;
  });

  launchWebAuthFlow = vi.fn(async ({ url }: { url: string }) => {
    const state = new URL(url).searchParams.get('state');
    return `https://panelot-id.chromiumapp.org/mcp-oauth?code=valid-code&state=${state}`;
  });
  permissionRequest = vi.fn(async () => true);
  vi.stubGlobal('chrome', {
    identity: {
      getRedirectURL: vi.fn(() => 'https://panelot-id.chromiumapp.org/mcp-oauth'),
      launchWebAuthFlow,
    },
    permissions: {
      contains: vi.fn(async ({ origins }: { origins?: string[] }) =>
        (origins ?? []).every((origin) => granted.has(origin)),
      ),
      request: permissionRequest,
    },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      fetchCalls.push(url);
      if (url === 'https://rs.example/.well-known/oauth-protected-resource/mcp') {
        return jsonResponse({
          resource,
          authorization_servers: [issuer],
          scopes_supported: ['tools:read'],
        });
      }
      if (url === 'https://as.example/.well-known/oauth-authorization-server/tenant') {
        return jsonResponse({
          issuer,
          authorization_endpoint: 'https://as.example/authorize',
          token_endpoint: `${tokenOrigin}/token`,
          registration_endpoint: 'https://register.example/register',
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        });
      }
      if (url === 'https://register.example/register') {
        return jsonResponse({ client_id: 'registered-client' });
      }
      if (url === `${tokenOrigin}/token`) {
        return jsonResponse({
          access_token: 'fresh-access',
          refresh_token: 'fresh-refresh',
          expires_in: 300,
        });
      }
      return new Response(null, { status: 404 });
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('MCP OAuth staged host permissions', () => {
  it('discovers only authorized origins and requires separate gestures for AS and OAuth endpoints', async () => {
    const manager = new McpManager();

    const authorizationPlan = requirePermissionPlan(await runFlow(manager));
    expect(authorizationPlan).toMatchObject({
      status: 'permission_required',
      stage: 'authorization_server',
      origins: ['https://as.example'],
      summary: { resource, issuer },
    });
    expect(fetchCalls).toEqual(['https://rs.example/.well-known/oauth-protected-resource/mcp']);
    expect(permissionRequest).not.toHaveBeenCalled();

    granted.add(authorizationPattern);
    const endpointPlan = requirePermissionPlan(
      await runFlow(manager, approvalFor(authorizationPlan)),
    );
    expect(endpointPlan).toMatchObject({
      status: 'permission_required',
      stage: 'oauth_endpoints',
      origins: ['https://register.example', 'https://token.example'],
      summary: { resource, issuer },
    });
    expect(fetchCalls).not.toContain('https://register.example/register');
    expect(fetchCalls).not.toContain('https://token.example/token');
    expect(launchWebAuthFlow).not.toHaveBeenCalled();

    granted.add(registrationPattern);
    granted.add(tokenPattern);
    await expect(runFlow(manager, approvalFor(endpointPlan))).resolves.toEqual({
      status: 'complete',
    });
    expect(fetchCalls).toContain('https://register.example/register');
    expect(fetchCalls).toContain('https://token.example/token');
    expect(launchWebAuthFlow).toHaveBeenCalledOnce();
    expect(permissionRequest).not.toHaveBeenCalled();
    expect(servers[0]?.auth).toMatchObject({
      kind: 'oauth',
      clientId: 'registered-client',
      binding: { resource, issuer, planDigest: expect.any(String) },
    });
  });

  it('keeps a denied plan retryable without fetching or granting the missing origin', async () => {
    const manager = new McpManager();
    const plan = requirePermissionPlan(await runFlow(manager));
    const beforeRetry = [...fetchCalls];

    const denied = await runFlow(manager, approvalFor(plan));
    expect(denied).toMatchObject({
      status: 'permission_required',
      stage: 'authorization_server',
      origins: ['https://as.example'],
      planDigest: plan.planDigest,
    });
    expect(fetchCalls).toEqual([
      ...beforeRetry,
      'https://rs.example/.well-known/oauth-protected-resource/mcp',
    ]);
    expect(fetchCalls.some((url) => url.startsWith('https://as.example/'))).toBe(false);
    expect(permissionRequest).not.toHaveBeenCalled();

    granted.add(authorizationPattern);
    await expect(runFlow(manager, approvalFor(plan))).resolves.toMatchObject({
      status: 'permission_required',
      stage: 'oauth_endpoints',
    });
  });

  it('requires a fresh preview when a granted plan is replayed after its TTL', async () => {
    const manager = new McpManager();
    const plan = requirePermissionPlan(await runFlow(manager));
    granted.add(authorizationPattern);
    vi.useFakeTimers();
    vi.setSystemTime(plan.expiresAt + 1);
    const callsBefore = [...fetchCalls];

    const expired = requirePermissionPlan(await runFlow(manager, approvalFor(plan)));

    expect(expired).toMatchObject({
      status: 'permission_required',
      stage: 'authorization_server',
      origins: [],
      reason: 'plan_expired',
    });
    expect(fetchCalls).toEqual([
      ...callsBefore,
      'https://rs.example/.well-known/oauth-protected-resource/mcp',
    ]);
  });

  it('invalidates bound credentials and re-previews when authorization metadata changes', async () => {
    const manager = new McpManager();
    const authorizationPlan = requirePermissionPlan(await runFlow(manager));
    granted.add(authorizationPattern);
    const endpointPlan = requirePermissionPlan(
      await runFlow(manager, approvalFor(authorizationPlan)),
    );
    granted.add(registrationPattern);
    granted.add(tokenPattern);
    await runFlow(manager, approvalFor(endpointPlan));
    expect(accessSecret).toBe('fresh-access');

    tokenOrigin = 'https://new-token.example';
    const changedPlan = requirePermissionPlan(await runFlow(manager));
    expect(changedPlan).toMatchObject({
      status: 'permission_required',
      stage: 'oauth_endpoints',
      origins: ['https://new-token.example'],
      reason: 'plan_changed',
    });
    expect(changedPlan.planDigest).not.toBe(endpointPlan.planDigest);
    expect(accessSecret).toBeNull();
    expect(servers[0]?.auth).toMatchObject({ kind: 'oauth' });
    expect((servers[0]?.auth as { clientId?: string }).clientId).toBeUndefined();
    expect((servers[0]?.auth as { tokens?: unknown }).tokens).toBeUndefined();
  });

  it('reports refresh permission loss as a recoverable token stage before sending the secret', async () => {
    const manager = new McpManager();
    const authorizationPlan = requirePermissionPlan(await runFlow(manager));
    granted.add(authorizationPattern);
    const endpointPlan = requirePermissionPlan(
      await runFlow(manager, approvalFor(authorizationPlan)),
    );
    granted.add(registrationPattern);
    granted.add(tokenPattern);
    await runFlow(manager, approvalFor(endpointPlan));
    const auth = servers[0]?.auth;
    if (!auth || auth.kind !== 'oauth' || !auth.tokens) throw new Error('OAuth fixture missing');
    auth.tokens.expiresAt = 0;
    granted.delete(tokenPattern);
    const tokenCallsBefore = fetchCalls.filter(
      (url) => url === 'https://token.example/token',
    ).length;

    const access = await (
      manager as unknown as {
        validOAuthToken(config: McpServerConfig): Promise<string | null>;
      }
    ).validOAuthToken(servers[0]!);

    expect(access).toBeNull();
    expect(fetchCalls.filter((url) => url === 'https://token.example/token')).toHaveLength(
      tokenCallsBefore,
    );
    expect(manager.getState('server-1')).toMatchObject({
      status: 'error',
      permissionRequired: {
        status: 'permission_required',
        stage: 'token_refresh',
        origins: ['https://token.example'],
      },
    });
  });
});

async function runFlow(manager: McpManager, approval?: PermissionApproval): Promise<FlowResult> {
  return (
    manager as unknown as {
      runOAuthFlow(
        id: string,
        challenge: Record<string, never>,
        approval?: PermissionApproval,
      ): Promise<FlowResult>;
    }
  ).runOAuthFlow('server-1', {}, approval);
}

function approvalFor(result: FlowResult): PermissionApproval {
  if (result.status !== 'permission_required') throw new Error('Expected a permission plan');
  return { stage: result.stage, planDigest: result.planDigest };
}

function requirePermissionPlan(result: FlowResult): PermissionRequired {
  if (result.status !== 'permission_required') throw new Error('Expected a permission plan');
  return result;
}

function oauthServer(): McpServerConfig {
  return {
    id: 'server-1',
    name: 'Staged OAuth MCP',
    url: resource,
    auth: { kind: 'oauth', scopes: ['tools:read'] },
    enabled: true,
    disabledTools: [],
    connectOnStartup: false,
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
