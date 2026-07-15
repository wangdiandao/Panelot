import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverAuthServer, refreshTokens } from '../../src/mcp/oauth';

const runningServers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    runningServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
});

describe('MCP OAuth loopback network discovery', () => {
  it('discovers an independent path issuer and binds a real refresh request to the resource', async () => {
    const authorizationRequests: string[] = [];
    let refreshedResource: string | null = null;
    let authorizationOrigin = '';
    const authorizationServer = await startServer(async (request, response) => {
      authorizationRequests.push(request.url ?? '');
      if (request.url === '/.well-known/oauth-authorization-server/tenant') {
        return sendJson(response, {
          issuer: `${authorizationOrigin}/tenant`,
          authorization_endpoint: `${authorizationOrigin}/tenant/authorize`,
          token_endpoint: `${authorizationOrigin}/tenant/token`,
          registration_endpoint: `${authorizationOrigin}/tenant/register`,
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        });
      }
      if (request.url === '/tenant/token' && request.method === 'POST') {
        const body = new URLSearchParams(await readBody(request));
        refreshedResource = body.get('resource');
        return sendJson(response, { access_token: 'network-access', expires_in: 300 });
      }
      response.writeHead(404).end();
    });
    authorizationOrigin = authorizationServer.origin;

    let resourceOrigin = '';
    const resourceServer = await startServer(async (request, response) => {
      if (request.url === '/.well-known/oauth-protected-resource/team/mcp') {
        return sendJson(response, {
          resource: `${resourceOrigin}/team/mcp`,
          authorization_servers: [`${authorizationOrigin}/tenant`],
          scopes_supported: ['files:read'],
        });
      }
      response.writeHead(404).end();
    });
    resourceOrigin = resourceServer.origin;
    const resource = `${resourceOrigin}/team/mcp`;

    const discovery = await discoverAuthServer(resource);
    expect(discovery).toMatchObject({
      binding: { resource, issuer: `${authorizationOrigin}/tenant` },
      scopes: ['files:read'],
    });
    expect(authorizationRequests).toContain('/.well-known/oauth-authorization-server/tenant');

    await expect(
      refreshTokens(
        discovery.metadata.token_endpoint,
        'network-client',
        'network-refresh',
        resource,
      ),
    ).resolves.toMatchObject({ access: 'network-access', refresh: 'network-refresh' });
    expect(refreshedResource).toBe(resource);
  });

  it('does not follow redirects while fetching protected resource metadata', async () => {
    let redirectTargetHits = 0;
    let origin = '';
    const resourceServer = await startServer(async (request, response) => {
      if (request.url === '/redirect-target') {
        redirectTargetHits++;
        return sendJson(response, {
          resource: `${origin}/team/mcp`,
          authorization_servers: [`${origin}/tenant`],
        });
      }
      if (request.url?.includes('oauth-protected-resource')) {
        response.writeHead(302, { Location: `${origin}/redirect-target` }).end();
        return;
      }
      response.writeHead(404).end();
    });
    origin = resourceServer.origin;

    await expect(discoverAuthServer(`${origin}/team/mcp`)).rejects.toThrow(/保护资源元数据缺失/);
    expect(redirectTargetHits).toBe(0);
  });
});

async function startServer(
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
): Promise<{ origin: string }> {
  const server = createServer((request, response) => {
    void handler(request, response).catch((error: unknown) => {
      response.writeHead(500).end(error instanceof Error ? error.message : String(error));
    });
  });
  runningServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Loopback fixture did not bind');
  return { origin: `http://127.0.0.1:${address.port}` };
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of request) body += chunk.toString();
  return body;
}

function sendJson(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
}
