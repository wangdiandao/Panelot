/**
 * OAuth 2.1 for remote MCP (docs/development/mcp.md §3): discovery, dynamic client
 * registration, PKCE, launchWebAuthFlow, token exchange & refresh.
 *
 * redirect_uri is fixed to https://<extension-id>.chromiumapp.org/mcp-oauth.
 */

import { normalizeEndpointUrl, validateEndpointUrl } from '../security/endpointUrl';

const MCP_AUTH_PROTOCOL_VERSION = '2025-06-18';

export interface OAuthTokens {
  access: string;
  refresh?: string;
  expiresAt: number;
}

export interface AuthServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  response_types_supported: string[];
  code_challenge_methods_supported: string[];
  token_endpoint_auth_methods_supported?: string[];
}

export interface OAuthCredentialBinding {
  resource: string;
  issuer: string;
}

export interface OAuthDiscoveryOptions {
  resourceMetadataUrl?: string;
  scope?: string;
  preferredIssuer?: string;
  permissionGuard?: OAuthFetchPermissionGuard;
}

export interface OAuthDiscovery {
  metadata: AuthServerMetadata;
  resourceMetadata: {
    resource: string;
    authorization_servers: string[];
    scopes_supported?: string[];
  };
  binding: OAuthCredentialBinding;
  scopes?: string[];
}

export interface OAuthFetchPermissionContext {
  stage: 'resource_metadata' | 'authorization_metadata' | 'registration' | 'token';
  resource: string;
  issuer?: string;
  authorizationServers?: string[];
  scopes?: string[];
}

export type OAuthFetchPermissionGuard = (
  url: URL,
  context: OAuthFetchPermissionContext,
) => Promise<void>;

function oauthEndpoint(raw: string, label: string): string {
  return normalizeEndpointUrl(raw, { label });
}

export function canonicalMcpResource(resourceUrl: string): string {
  const resource = validateEndpointUrl(resourceUrl, { label: 'MCP resource URL' });
  if (resource.pathname === '/' && !resource.search) return resource.origin;
  return resource.toString();
}

function parseAuthServerMetadata(value: unknown, expectedIssuer: string): AuthServerMetadata {
  if (!value || typeof value !== 'object') throw new Error('OAuth 元数据格式无效');
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.issuer !== 'string' ||
    typeof raw.authorization_endpoint !== 'string' ||
    typeof raw.token_endpoint !== 'string'
  ) {
    throw new Error('OAuth 元数据缺少 issuer、authorization_endpoint 或 token_endpoint');
  }
  if (raw.issuer !== expectedIssuer) {
    throw new Error(`OAuth metadata issuer 不匹配：期望 ${expectedIssuer}，实际 ${raw.issuer}`);
  }
  if (raw.registration_endpoint !== undefined && typeof raw.registration_endpoint !== 'string') {
    throw new Error('OAuth registration_endpoint 格式无效');
  }
  if (
    !Array.isArray(raw.response_types_supported) ||
    !raw.response_types_supported.includes('code')
  ) {
    throw new Error('OAuth 授权服务器不支持 authorization code response type');
  }
  if (
    !Array.isArray(raw.code_challenge_methods_supported) ||
    !raw.code_challenge_methods_supported.includes('S256')
  ) {
    throw new Error('OAuth 授权服务器未明确声明 PKCE S256 支持');
  }
  const tokenMethods = Array.isArray(raw.token_endpoint_auth_methods_supported)
    ? raw.token_endpoint_auth_methods_supported.filter(
        (method): method is string => typeof method === 'string',
      )
    : undefined;
  if (tokenMethods && !tokenMethods.includes('none')) {
    throw new Error('OAuth 授权服务器不支持 public client 的 token_endpoint_auth_method none');
  }
  return {
    issuer: validateIssuer(raw.issuer, 'OAuth metadata issuer'),
    authorization_endpoint: oauthEndpoint(
      raw.authorization_endpoint,
      'OAuth authorization endpoint',
    ),
    token_endpoint: oauthEndpoint(raw.token_endpoint, 'OAuth token endpoint'),
    registration_endpoint: raw.registration_endpoint
      ? oauthEndpoint(raw.registration_endpoint, 'OAuth registration endpoint')
      : undefined,
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: tokenMethods,
  };
}

function validateIssuer(raw: string, label: string): string {
  const value = raw.trim();
  const issuer = validateEndpointUrl(value, { label });
  if (issuer.search) throw new Error(`${label} 不能包含 query`);
  return value;
}

async function metadataFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, { ...init, redirect: 'error' });
}

// ---- PKCE ------------------------------------------------------------------

async function sha256(input: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
}

function base64url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString(bytes = 32): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return base64url(arr.buffer);
}

export async function makePkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomString(32);
  const challenge = base64url(await sha256(verifier));
  return { verifier, challenge };
}

// ---- Discovery -------------------------------------------------------------

export async function discoverAuthServer(
  resourceUrl: string,
  options: OAuthDiscoveryOptions = {},
): Promise<OAuthDiscovery> {
  const resource = canonicalMcpResource(resourceUrl);
  const resourceEndpoint = validateEndpointUrl(resource, { label: 'MCP 服务器 URL' });
  let resourceMetadataUrl: URL | undefined;
  if (options.resourceMetadataUrl) {
    resourceMetadataUrl = validateEndpointUrl(options.resourceMetadataUrl, {
      label: 'OAuth resource_metadata URL',
    });
    if (resourceMetadataUrl.origin !== resourceEndpoint.origin) {
      throw new Error('OAuth resource_metadata URL 必须与 MCP 服务器同源');
    }
  }

  let discovered: {
    resource: string;
    authorization_servers?: string[];
    scopes_supported?: string[];
  };
  try {
    discovered = await discoverProtectedResourceMetadata(
      resource,
      resourceMetadataUrl,
      options.permissionGuard,
    );
  } catch (error) {
    throw new Error(`OAuth 保护资源元数据缺失或无效：${(error as Error).message}`);
  }

  const discoveredResource = canonicalMcpResource(discovered.resource);
  if (discoveredResource !== resource) {
    throw new Error(`OAuth PRM resource 不匹配：期望 ${resource}，实际 ${discoveredResource}`);
  }
  const authorizationServers = discovered.authorization_servers;
  if (!authorizationServers?.length) {
    throw new Error('OAuth 保护资源元数据缺少 authorization_servers');
  }
  const issuer = selectAuthorizationServer(authorizationServers, options.preferredIssuer);
  const challengedScopes = parseScope(options.scope);
  const scopes = challengedScopes ?? discovered.scopes_supported;
  const rawMetadata = await discoverAuthorizationMetadata(issuer, options.permissionGuard, {
    resource,
    authorizationServers,
    scopes,
  });
  if (!rawMetadata) {
    throw new Error(`OAuth 授权服务器元数据缺失：${issuer}`);
  }
  const metadata = parseAuthServerMetadata(rawMetadata, issuer);
  return {
    metadata,
    resourceMetadata: {
      resource,
      authorization_servers: authorizationServers,
      scopes_supported: discovered.scopes_supported,
    },
    binding: { resource, issuer },
    scopes,
  };
}

async function discoverProtectedResourceMetadata(
  resource: string,
  explicitUrl?: URL,
  permissionGuard?: OAuthFetchPermissionGuard,
): Promise<{
  resource: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
}> {
  const urls = explicitUrl ? [explicitUrl] : protectedResourceDiscoveryUrls(resource);
  for (const url of urls) {
    const value = await tryMetadata(url, permissionGuard, {
      stage: 'resource_metadata',
      resource,
    });
    if (!value) continue;
    if (typeof value.resource !== 'string') throw new Error('PRM 缺少 resource');
    if (
      value.authorization_servers !== undefined &&
      (!Array.isArray(value.authorization_servers) ||
        value.authorization_servers.some((server) => typeof server !== 'string'))
    ) {
      throw new Error('PRM authorization_servers 格式无效');
    }
    if (
      value.scopes_supported !== undefined &&
      (!Array.isArray(value.scopes_supported) ||
        value.scopes_supported.some((scope) => typeof scope !== 'string'))
    ) {
      throw new Error('PRM scopes_supported 格式无效');
    }
    return value as {
      resource: string;
      authorization_servers?: string[];
      scopes_supported?: string[];
    };
  }
  throw new Error('Resource server does not expose RFC 9728 metadata');
}

function protectedResourceDiscoveryUrls(resource: string): URL[] {
  const endpoint = new URL(resource);
  const pathname = endpoint.pathname.endsWith('/')
    ? endpoint.pathname.slice(0, -1)
    : endpoint.pathname;
  const pathAware = new URL(
    `/.well-known/oauth-protected-resource${pathname === '/' ? '' : pathname}`,
    endpoint.origin,
  );
  pathAware.search = endpoint.search;
  if (pathname === '' || pathname === '/') return [pathAware];
  return [pathAware, new URL('/.well-known/oauth-protected-resource', endpoint.origin)];
}

async function discoverAuthorizationMetadata(
  issuer: string,
  permissionGuard: OAuthFetchPermissionGuard | undefined,
  context: Pick<OAuthFetchPermissionContext, 'resource' | 'authorizationServers' | 'scopes'>,
): Promise<unknown | undefined> {
  for (const url of authorizationDiscoveryUrls(issuer)) {
    const value = await tryMetadata(url, permissionGuard, {
      stage: 'authorization_metadata',
      issuer,
      ...context,
    });
    if (value) return value;
  }
  return undefined;
}

function authorizationDiscoveryUrls(issuer: string): URL[] {
  const endpoint = new URL(issuer);
  const pathname = endpoint.pathname.endsWith('/')
    ? endpoint.pathname.slice(0, -1)
    : endpoint.pathname;
  if (pathname === '' || pathname === '/') {
    return [
      new URL('/.well-known/oauth-authorization-server', endpoint.origin),
      new URL('/.well-known/openid-configuration', endpoint.origin),
    ];
  }
  return [
    new URL(`/.well-known/oauth-authorization-server${pathname}`, endpoint.origin),
    new URL(`/.well-known/openid-configuration${pathname}`, endpoint.origin),
    new URL(`${pathname}/.well-known/openid-configuration`, endpoint.origin),
  ];
}

async function tryMetadata(
  url: URL,
  permissionGuard: OAuthFetchPermissionGuard | undefined,
  context: OAuthFetchPermissionContext,
): Promise<Record<string, unknown> | undefined> {
  let response: Response;
  try {
    await permissionGuard?.(url, context);
    response = await metadataFetch(url, {
      headers: {
        Accept: 'application/json',
        'MCP-Protocol-Version': MCP_AUTH_PROTOCOL_VERSION,
      },
    });
  } catch (error) {
    if (error instanceof TypeError) return undefined;
    throw error;
  }
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status >= 400 && response.status < 500) return undefined;
    throw new Error(`OAuth metadata 请求失败：${response.status} @ ${url}`);
  }
  const value = (await response.json()) as unknown;
  if (!value || typeof value !== 'object') throw new Error(`OAuth metadata 格式无效：${url}`);
  return value as Record<string, unknown>;
}

function selectAuthorizationServer(servers: string[], preferredIssuer?: string): string {
  const validated = servers.map((server) => validateIssuer(server, 'OAuth authorization server'));
  if (validated.length === 1) {
    const onlyServer = validated[0];
    if (onlyServer) return onlyServer;
  }
  if (preferredIssuer) {
    const preferred = validated.find((server) => server === preferredIssuer);
    if (preferred) return preferred;
  }
  throw new Error('OAuth 保护资源声明了多个 authorization_servers，无法安全地自动选择');
}

function parseScope(scope: string | undefined): string[] | undefined {
  if (!scope) return undefined;
  const scopes = [...new Set(scope.split(/\s+/).filter(Boolean))];
  return scopes.length ? scopes : undefined;
}

export function redirectUri(): string {
  // chrome.identity provides the extension's fixed callback origin.
  return chrome.identity.getRedirectURL('mcp-oauth');
}

function validatedRedirectUri(): string {
  return validateEndpointUrl(redirectUri(), {
    label: 'OAuth redirect URI',
    requireHttps: true,
  }).toString();
}

// ---- Dynamic client registration (DCR) -------------------------------------

export async function registerClient(
  meta: AuthServerMetadata,
  scopes?: string[],
  permissionGuard?: OAuthFetchPermissionGuard,
  resource = meta.issuer,
): Promise<string> {
  if (!meta.registration_endpoint)
    throw new Error('授权服务器不支持动态客户端注册，需手动配置 clientId');
  const endpoint = oauthEndpoint(meta.registration_endpoint, 'OAuth registration endpoint');
  await permissionGuard?.(new URL(endpoint), {
    stage: 'registration',
    resource,
    issuer: meta.issuer,
    scopes,
  });
  const res = await fetch(endpoint, {
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Panelot',
      redirect_uris: [validatedRedirectUri()],
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'none', // public client + PKCE
      ...(scopes?.length ? { scope: scopes.join(' ') } : {}),
    }),
  });
  if (!res.ok) throw new Error(`动态客户端注册失败：${res.status}`);
  const json: unknown = await res.json();
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error('OAuth dynamic client registration response must be an object');
  }
  const clientId = (json as Record<string, unknown>).client_id;
  if (typeof clientId !== 'string' || clientId.trim().length === 0 || clientId.length > 4096) {
    throw new Error('OAuth dynamic client registration response must contain a valid client_id');
  }
  return clientId;
}

// ---- Authorization code flow ----------------------------------------------

export async function authorize(
  meta: AuthServerMetadata,
  clientId: string,
  resourceUrl: string,
  scopes: string[] | undefined,
  permissionGuard?: OAuthFetchPermissionGuard,
): Promise<OAuthTokens> {
  const { verifier, challenge } = await makePkce();
  const state = randomString(16);
  const resource = canonicalMcpResource(resourceUrl);
  const authUrl = new URL(
    oauthEndpoint(meta.authorization_endpoint, 'OAuth authorization endpoint'),
  );
  const callbackUrl = new URL(validatedRedirectUri());
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', callbackUrl.toString());
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('resource', resource);
  if (scopes?.length) authUrl.searchParams.set('scope', scopes.join(' '));

  const redirect = await chrome.identity.launchWebAuthFlow({
    url: authUrl.toString(),
    interactive: true,
  });
  if (!redirect) throw new Error('授权流程被取消');

  const returned = validateEndpointUrl(redirect, {
    label: 'OAuth redirect 回调',
    requireHttps: true,
  });
  if (returned.origin !== callbackUrl.origin || returned.pathname !== callbackUrl.pathname) {
    throw new Error('OAuth redirect 回调地址不匹配');
  }
  const params = returned.searchParams;
  if (params.get('state') !== state) throw new Error('OAuth state 不匹配（可能的 CSRF）');
  const code = params.get('code');
  if (!code) throw new Error(`授权失败：${params.get('error') ?? '未返回 code'}`);

  return exchangeCode(meta, clientId, code, verifier, resource, permissionGuard);
}

async function exchangeCode(
  meta: AuthServerMetadata,
  clientId: string,
  code: string,
  verifier: string,
  resource: string,
  permissionGuard?: OAuthFetchPermissionGuard,
): Promise<OAuthTokens> {
  const endpoint = oauthEndpoint(meta.token_endpoint, 'OAuth token endpoint');
  await permissionGuard?.(new URL(endpoint), {
    stage: 'token',
    resource,
    issuer: meta.issuer,
  });
  const res = await fetch(endpoint, {
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: validatedRedirectUri(),
      client_id: clientId,
      code_verifier: verifier,
      resource,
    }),
  });
  if (!res.ok) throw new Error(`token 交换失败：${res.status}`);
  return toTokens(await res.json());
}

export async function refreshTokens(
  tokenEndpoint: string,
  clientId: string,
  refresh: string,
  resourceUrl: string,
  permissionGuard?: OAuthFetchPermissionGuard,
  issuer?: string,
): Promise<OAuthTokens> {
  const endpoint = oauthEndpoint(tokenEndpoint, 'OAuth token endpoint');
  const resource = canonicalMcpResource(resourceUrl);
  await permissionGuard?.(new URL(endpoint), {
    stage: 'token',
    resource,
    issuer,
  });
  const res = await fetch(endpoint, {
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: clientId,
      resource,
    }),
  });
  if (!res.ok) throw new Error(`token 刷新失败：${res.status}`);
  const tokens = toTokens(await res.json());
  return tokens.refresh ? tokens : { ...tokens, refresh };
}

function toTokens(json: unknown): OAuthTokens {
  if (!json || typeof json !== 'object') throw new Error('OAuth token 响应格式无效');
  const t = json as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
  if (typeof t.access_token !== 'string' || !t.access_token) {
    throw new Error('OAuth token 响应缺少 access_token');
  }
  if (t.refresh_token !== undefined && typeof t.refresh_token !== 'string') {
    throw new Error('OAuth refresh_token 格式无效');
  }
  const expiresIn =
    typeof t.expires_in === 'number' && Number.isFinite(t.expires_in) && t.expires_in > 0
      ? t.expires_in
      : 3600;
  return {
    access: t.access_token,
    refresh: t.refresh_token,
    expiresAt: Date.now() + expiresIn * 1000,
  };
}
