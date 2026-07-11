import { McpClient } from '../../src/mcp/client';

const clients = new Map<string, McpClient>();

function catalog(client: McpClient) {
  return {
    tools: client.tools,
    prompts: client.prompts,
    resources: client.resources,
  };
}

async function handle(message: unknown): Promise<unknown> {
  const request = message as {
    type?: string;
    serverId?: string;
    url?: string;
    authorization?: string | null;
    name?: string;
    args?: unknown;
    uri?: string;
  };
  if (!request.type?.startsWith('panelot.mcpWorker.') || !request.serverId) return undefined;

  try {
    if (request.type === 'panelot.mcpWorker.connect') {
      if (!request.url) throw new Error('MCP worker URL is missing');
      await clients.get(request.serverId)?.close();
      let authorization = request.authorization ?? null;
      const client = new McpClient({
        url: request.url,
        authHeader: async () => authorization,
        onUnauthorized: async () => {
          const response = (await chrome.runtime.sendMessage({
            type: 'panelot.mcpWorkerUnauthorized',
            id: request.serverId,
          })) as { authorization?: string | null } | undefined;
          authorization = response?.authorization ?? null;
          return authorization !== null;
        },
        onCapabilitiesChanged: () => {
          void chrome.runtime
            .sendMessage({
              type: 'panelot.mcpWorker.changed',
              serverId: request.serverId,
              catalog: catalog(client),
            })
            .catch(() => {});
        },
      });
      await client.connect();
      clients.set(request.serverId, client);
      return { ok: true, catalog: catalog(client) };
    }

    const client = clients.get(request.serverId);
    if (!client) throw new Error(`MCP server is not connected: ${request.serverId}`);
    if (request.type === 'panelot.mcpWorker.close') {
      clients.delete(request.serverId);
      await client.close();
      return { ok: true };
    }
    if (request.type === 'panelot.mcpWorker.callTool') {
      if (!request.name) throw new Error('MCP tool name is missing');
      return { ok: true, result: await client.callTool(request.name, request.args) };
    }
    if (request.type === 'panelot.mcpWorker.getPrompt') {
      if (!request.name) throw new Error('MCP prompt name is missing');
      return {
        ok: true,
        result: await client.getPrompt(
          request.name,
          (request.args ?? {}) as Record<string, unknown>,
        ),
      };
    }
    if (request.type === 'panelot.mcpWorker.readResource') {
      if (!request.uri) throw new Error('MCP resource URI is missing');
      return { ok: true, result: await client.readResource(request.uri) };
    }
    return undefined;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const type = (message as { type?: string }).type;
  if (!type?.startsWith('panelot.mcpWorker.') || type === 'panelot.mcpWorker.changed') return;
  void handle(message).then(sendResponse);
  return true;
});
