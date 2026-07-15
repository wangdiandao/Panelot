export interface EndpointUrlOptions {
  label?: string;
  allowImplicitScheme?: boolean;
  stripTrailingSlashes?: boolean;
  requireHttps?: boolean;
}

function hasUserInfoSyntax(value: string): boolean {
  const authority = value.match(/^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i)?.[1];
  return authority?.includes('@') ?? false;
}

function hasExplicitLoopbackHost(value: string): boolean {
  const authority = value.match(/^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i)?.[1]?.toLowerCase();
  if (!authority) return false;
  const host = authority.startsWith('[')
    ? authority.slice(0, authority.indexOf(']') + 1)
    : authority.split(':', 1)[0];
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

export function isLoopbackEndpoint(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

export function normalizeEndpointUrl(raw: string, options: EndpointUrlOptions = {}): string {
  const label = options.label ?? '端点 URL';
  let value = raw.trim();
  if (!value) throw new Error(`${label}不能为空`);

  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
    if (!options.allowImplicitScheme) throw new Error(`${label}必须包含 http:// 或 https://`);
    const local = /^(localhost|127\.0\.0\.1|\[::1\])(?=[:/]|$)/i.test(value);
    value = `${local ? 'http' : 'https'}://${value}`;
  }

  if (hasUserInfoSyntax(value)) throw new Error(`${label}不能包含用户名或密码`);
  if (value.includes('#')) throw new Error(`${label}不能包含 fragment`);

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label}无效`);
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`${label}仅支持 http:// 或 https://`);
  }
  if (parsed.username || parsed.password) throw new Error(`${label}不能包含用户名或密码`);
  if (parsed.hash) throw new Error(`${label}不能包含 fragment`);
  if (options.requireHttps && parsed.protocol !== 'https:') {
    throw new Error(`${label}必须使用 HTTPS`);
  }
  if (
    parsed.protocol === 'http:' &&
    (!isLoopbackEndpoint(parsed) || !hasExplicitLoopbackHost(value))
  ) {
    throw new Error(`${label}仅允许 loopback 地址使用 HTTP，远程地址必须使用 HTTPS`);
  }

  if (options.stripTrailingSlashes) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  }
  let normalized = parsed.toString();
  if (options.stripTrailingSlashes && !parsed.search && parsed.pathname === '/') {
    normalized = parsed.origin;
  } else if (options.stripTrailingSlashes && !parsed.search) {
    normalized = normalized.replace(/\/+$/, '');
  }
  return normalized;
}

export function validateEndpointUrl(raw: string, options: EndpointUrlOptions = {}): URL {
  return new URL(normalizeEndpointUrl(raw, options));
}
