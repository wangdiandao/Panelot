import type { McpPrompt, McpResource, McpTool } from './client';
import { ensureMcpWorkerDocument } from './offscreenWorker';

interface McpCatalog {
  tools: McpTool[];
  prompts: McpPrompt[];
  resources: McpResource[];
}

interface WorkerResponse<T = unknown> {
  ok: boolean;
  error?: string;
  catalog?: McpCatalog;
  result?: T;
}

export class McpWorkerClient {
  tools: McpTool[] = [];
  prompts: McpPrompt[] = [];
  resources: McpResource[] = [];

  private readonly listener = (message: unknown) => {
    const event = message as { type?: string; serverId?: string; catalog?: McpCatalog };
    if (
      event.type !== 'panelot.mcpWorker.changed' ||
      event.serverId !== this.serverId ||
      !event.catalog
    ) {
      return;
    }
    this.applyCatalog(event.catalog);
    this.onCapabilitiesChanged();
  };

  constructor(
    private readonly serverId: string,
    private readonly onCapabilitiesChanged: () => void,
  ) {
    chrome.runtime.onMessage.addListener(this.listener);
  }

  async connect(input: { url: string; authorization: string | null }): Promise<void> {
    await ensureMcpWorkerDocument();
    const response = await this.request<McpCatalog>({
      type: 'panelot.mcpWorker.connect',
      serverId: this.serverId,
      ...input,
    });
    if (response.catalog) this.applyCatalog(response.catalog);
  }

  async close(): Promise<void> {
    try {
      await this.request({ type: 'panelot.mcpWorker.close', serverId: this.serverId });
    } finally {
      chrome.runtime.onMessage.removeListener(this.listener);
    }
  }

  async callTool(
    name: string,
    args: unknown,
    context?: { threadId: string; itemId: string },
  ): Promise<{ content: { type: string; text?: string }[]; isError?: boolean }> {
    const response = await this.request<{
      content: { type: string; text?: string }[];
      isError?: boolean;
    }>({ type: 'panelot.mcpWorker.callTool', serverId: this.serverId, name, args, context });
    return response.result!;
  }

  async getPrompt(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ messages: { role: string; content: { type: string; text?: string } }[] }> {
    const response = await this.request<{
      messages: { role: string; content: { type: string; text?: string } }[];
    }>({ type: 'panelot.mcpWorker.getPrompt', serverId: this.serverId, name, args });
    return response.result!;
  }

  async readResource(
    uri: string,
  ): Promise<{ contents: { uri: string; text?: string; blob?: string; mimeType?: string }[] }> {
    const response = await this.request<{
      contents: { uri: string; text?: string; blob?: string; mimeType?: string }[];
    }>({ type: 'panelot.mcpWorker.readResource', serverId: this.serverId, uri });
    return response.result!;
  }

  private applyCatalog(catalog: McpCatalog): void {
    this.tools = catalog.tools;
    this.prompts = catalog.prompts;
    this.resources = catalog.resources;
  }

  private async request<T = unknown>(message: Record<string, unknown>): Promise<WorkerResponse<T>> {
    const response = (await chrome.runtime.sendMessage(message)) as WorkerResponse<T> | undefined;
    if (!response?.ok) throw new Error(response?.error ?? 'MCP worker did not respond');
    return response;
  }
}
