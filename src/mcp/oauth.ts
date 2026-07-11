/**
 * OAuth 2.1 for remote MCP (docs/07 §3): discovery, dynamic client
 * registration, PKCE, launchWebAuthFlow, token exchange & refresh.
 *
 * redirect_uri is fixed to https://<extension-id>.chromiumapp.org/mcp-oauth.
 */

export interface OAuthTokens {
  access: string;
  refresh?: string;
  expiresAt: number;
}

interface AuthServerMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
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

export async function discoverAuthServer(resourceUrl: string): Promise<AuthServerMetadata> {
  const base = new URL(resourceUrl);
  const wellKnown = `${base.origin}/.well-known/oauth-authorization-server`;
  const res = await fetch(wellKnown);
  if (!res.ok) throw new Error(`OAuth 发现失败: ${res.status} @ ${wellKnown}`);
  return (await res.json()) as AuthServerMetadata;
}

export function redirectUri(): string {
  // chrome.identity provides the extension's fixed callback origin.
  return chrome.identity.getRedirectURL('mcp-oauth');
}

// ---- Dynamic client registration (DCR) -------------------------------------

export async function registerClient(meta: AuthServerMetadata): Promise<string> {
  if (!meta.registration_endpoint)
    throw new Error('授权服务器不支持动态客户端注册，需手动配置 clientId');
  const res = await fetch(meta.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Panelot',
      redirect_uris: [redirectUri()],
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'none', // public client + PKCE
    }),
  });
  if (!res.ok) throw new Error(`动态客户端注册失败: ${res.status}`);
  const json = (await res.json()) as { client_id: string };
  return json.client_id;
}

// ---- Authorization code flow ----------------------------------------------

export async function authorize(
  meta: AuthServerMetadata,
  clientId: string,
  scopes: string[] | undefined,
): Promise<OAuthTokens> {
  const { verifier, challenge } = await makePkce();
  const state = randomString(16);
  const authUrl = new URL(meta.authorization_endpoint);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri());
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);
  if (scopes?.length) authUrl.searchParams.set('scope', scopes.join(' '));

  const redirect = await chrome.identity.launchWebAuthFlow({
    url: authUrl.toString(),
    interactive: true,
  });
  if (!redirect) throw new Error('授权流程被取消');

  const params = new URL(redirect).searchParams;
  if (params.get('state') !== state) throw new Error('OAuth state 不匹配（可能的 CSRF）');
  const code = params.get('code');
  if (!code) throw new Error(`授权失败: ${params.get('error') ?? '无 code'}`);

  return exchangeCode(meta, clientId, code, verifier);
}

async function exchangeCode(
  meta: AuthServerMetadata,
  clientId: string,
  code: string,
  verifier: string,
): Promise<OAuthTokens> {
  const res = await fetch(meta.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(),
      client_id: clientId,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) throw new Error(`token 交换失败: ${res.status}`);
  return toTokens(await res.json());
}

export async function refreshTokens(
  tokenEndpoint: string,
  clientId: string,
  refresh: string,
): Promise<OAuthTokens> {
  const res = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: clientId,
    }),
  });
  if (!res.ok) throw new Error(`token 刷新失败: ${res.status}`);
  return toTokens(await res.json());
}

function toTokens(json: unknown): OAuthTokens {
  const t = json as { access_token: string; refresh_token?: string; expires_in?: number };
  return {
    access: t.access_token,
    refresh: t.refresh_token,
    expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000,
  };
}
