import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  authorize,
  canonicalMcpResource,
  discoverAuthServer,
  refreshTokens,
} from '../../src/mcp/oauth';

const redirectUri = 'https://panelot-id.chromiumapp.org/mcp-oauth';
const metadata = {
  issuer: 'https://auth.example.com',
  authorization_endpoint: 'https://auth.example.com/authorize',
  token_endpoint: 'https://auth.example.com/token',
  registration_endpoint: 'https://auth.example.com/register',
  response_types_supported: ['code'],
  code_challenge_methods_supported: ['S256'],
};
const resourceInput = 'https://MCP.Example.com/mcp?tenant=panelot';
const canonicalResource = 'https://mcp.example.com/mcp?tenant=panelot';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('MCP OAuth endpoint policy', () => {
  it('canonicalizes an origin resource without adding a root slash', () => {
    expect(canonicalMcpResource('https://MCP.Example.com')).toBe('https://mcp.example.com');
  });

  it('uses a same-origin 401 resource_metadata URL and the authoritative challenged scope', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://mcp.example.com/oauth/prm') {
        return jsonResponse({
          resource: 'https://mcp.example.com/mcp',
          authorization_servers: ['https://auth.example.com/tenant'],
          scopes_supported: ['fallback:scope'],
        });
      }
      if (url === 'https://auth.example.com/.well-known/oauth-authorization-server/tenant') {
        return jsonResponse({ ...metadata, issuer: 'https://auth.example.com/tenant' });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      discoverAuthServer('https://mcp.example.com/mcp', {
        resourceMetadataUrl: 'https://mcp.example.com/oauth/prm',
        scope: 'files:read files:write',
      }),
    ).resolves.toMatchObject({
      binding: {
        resource: 'https://mcp.example.com/mcp',
        issuer: 'https://auth.example.com/tenant',
      },
      scopes: ['files:read', 'files:write'],
    });
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      'https://mcp.example.com/oauth/prm',
      'https://auth.example.com/.well-known/oauth-authorization-server/tenant',
    ]);
  });

  it('falls back to path-aware PRM and OIDC-only discovery in the required order', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url === 'https://mcp.example.com/.well-known/oauth-protected-resource/team/mcp') {
        return jsonResponse({
          resource: 'https://mcp.example.com/team/mcp',
          authorization_servers: ['https://login.example.com/tenant'],
        });
      }
      if (url === 'https://login.example.com/tenant/.well-known/openid-configuration') {
        return jsonResponse({
          ...metadata,
          issuer: 'https://login.example.com/tenant',
          authorization_endpoint: 'https://login.example.com/tenant/authorize',
          token_endpoint: 'https://login.example.com/tenant/token',
          jwks_uri: 'https://login.example.com/tenant/jwks',
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
        });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(discoverAuthServer('https://mcp.example.com/team/mcp')).resolves.toMatchObject({
      binding: {
        resource: 'https://mcp.example.com/team/mcp',
        issuer: 'https://login.example.com/tenant',
      },
    });
    expect(calls).toEqual([
      'https://mcp.example.com/.well-known/oauth-protected-resource/team/mcp',
      'https://login.example.com/.well-known/oauth-authorization-server/tenant',
      'https://login.example.com/.well-known/openid-configuration/tenant',
      'https://login.example.com/tenant/.well-known/openid-configuration',
    ]);
  });

  it('rejects PRM that identifies a different resource', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          resource: 'https://attacker.example/mcp',
          authorization_servers: ['https://auth.example.com'],
        }),
      ),
    );
    await expect(discoverAuthServer('https://mcp.example.com/mcp')).rejects.toThrow(
      /resource.*不匹配/i,
    );
  });

  it('rejects a cross-origin resource_metadata challenge before fetching it', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      discoverAuthServer('https://mcp.example.com/mcp', {
        resourceMetadataUrl: 'https://attacker.example/prm',
      }),
    ).rejects.toThrow(/resource_metadata.*同源/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects ambiguous authorization_servers without a previously bound issuer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          resource: 'https://mcp.example.com/mcp',
          authorization_servers: ['https://auth-a.example.com', 'https://auth-b.example.com'],
        }),
      ),
    );
    await expect(discoverAuthServer('https://mcp.example.com/mcp')).rejects.toThrow(
      /多个 authorization_servers/,
    );
  });

  it('selects a previously bound issuer when PRM advertises multiple authorization servers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes('oauth-protected-resource')
          ? jsonResponse({
              resource: 'https://mcp.example.com/mcp',
              authorization_servers: ['https://auth-a.example.com', 'https://auth-b.example.com'],
            })
          : jsonResponse({
              ...metadata,
              issuer: 'https://auth-b.example.com',
              authorization_endpoint: 'https://auth-b.example.com/authorize',
              token_endpoint: 'https://auth-b.example.com/token',
            }),
      ),
    );

    await expect(
      discoverAuthServer('https://mcp.example.com/mcp', {
        preferredIssuer: 'https://auth-b.example.com',
      }),
    ).resolves.toMatchObject({ binding: { issuer: 'https://auth-b.example.com' } });
  });

  it('rejects authorization metadata whose issuer differs from the PRM selection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes('oauth-protected-resource')
          ? jsonResponse({
              resource: 'https://mcp.example.com/mcp',
              authorization_servers: ['https://auth.example.com'],
            })
          : jsonResponse({ ...metadata, issuer: 'https://attacker.example.com' }),
      ),
    );
    await expect(discoverAuthServer('https://mcp.example.com/mcp')).rejects.toThrow(
      /issuer.*不匹配/i,
    );
  });

  it('rejects authorization metadata that does not explicitly support S256', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes('oauth-protected-resource')
          ? jsonResponse({
              resource: 'https://mcp.example.com/mcp',
              authorization_servers: ['https://auth.example.com'],
            })
          : jsonResponse({ ...metadata, code_challenge_methods_supported: undefined }),
      ),
    );
    await expect(discoverAuthServer('https://mcp.example.com/mcp')).rejects.toThrow(/S256/);
  });

  it('reports missing authorization server metadata after all standard endpoints fail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes('oauth-protected-resource')
          ? jsonResponse({
              resource: 'https://mcp.example.com/mcp',
              authorization_servers: ['https://auth.example.com/tenant'],
            })
          : new Response(null, { status: 404 }),
      ),
    );
    await expect(discoverAuthServer('https://mcp.example.com/mcp')).rejects.toThrow(
      /授权服务器元数据缺失/,
    );
  });

  it('reports missing protected resource metadata', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 404 })),
    );
    await expect(discoverAuthServer('https://mcp.example.com/mcp')).rejects.toThrow(
      /保护资源元数据缺失/,
    );
  });

  it('rejects insecure endpoints supplied by discovery metadata', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('oauth-protected-resource')
        ? jsonResponse({
            resource: 'https://mcp.example.com/mcp',
            authorization_servers: ['https://auth.example.com'],
          })
        : jsonResponse({ ...metadata, token_endpoint: 'http://auth.example.com/token' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(discoverAuthServer('https://mcp.example.com/mcp')).rejects.toThrow(/HTTPS/);
  });

  it('refuses an authorization response from a different callback origin', async () => {
    vi.stubGlobal('chrome', {
      identity: {
        getRedirectURL: vi.fn(() => redirectUri),
        launchWebAuthFlow: vi.fn(async ({ url }: { url: string }) => {
          const state = new URL(url).searchParams.get('state');
          return `https://attacker.example/callback?code=stolen&state=${state}`;
        }),
      },
    });

    await expect(authorize(metadata, 'client-1', resourceInput, undefined)).rejects.toThrow(
      /回调地址不匹配/,
    );
  });

  it('binds authorization and code exchange to one canonical resource', async () => {
    let authorizationResource: string | null = null;
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({ access_token: 'access-token', refresh_token: 'refresh-token' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('chrome', {
      identity: {
        getRedirectURL: vi.fn(() => redirectUri),
        launchWebAuthFlow: vi.fn(async ({ url }: { url: string }) => {
          const params = new URL(url).searchParams;
          authorizationResource = params.get('resource');
          const state = params.get('state');
          return `${redirectUri}?code=valid-code&state=${state}`;
        }),
      },
    });

    await expect(authorize(metadata, 'client-1', resourceInput, ['tools'])).resolves.toMatchObject({
      access: 'access-token',
      refresh: 'refresh-token',
    });
    expect(authorizationResource).toBe(canonicalResource);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://auth.example.com/token',
      expect.objectContaining({ method: 'POST', redirect: 'error' }),
    );
    const tokenRequest = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(new URLSearchParams(String(tokenRequest.body)).get('resource')).toBe(canonicalResource);
  });

  it('binds refresh requests to the same canonical resource', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ access_token: 'fresh-access' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      refreshTokens('https://auth.example.com/token', 'client-1', 'refresh-secret', resourceInput),
    ).resolves.toMatchObject({ access: 'fresh-access', refresh: 'refresh-secret' });
    const refreshRequest = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(refreshRequest.redirect).toBe('error');
    expect(new URLSearchParams(String(refreshRequest.body)).get('resource')).toBe(
      canonicalResource,
    );
  });

  it('rejects an insecure refresh endpoint before sending the refresh token', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      refreshTokens('http://auth.example.com/token', 'client-1', 'secret', resourceInput),
    ).rejects.toThrow(/HTTPS/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
