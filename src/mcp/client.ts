import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { extractWWWAuthenticateParams } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ElicitRequestSchema, type ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import packageJson from '../../package.json' with { type: 'json' };
import type { McpOAuthChallenge } from './types';

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; title?: string };
}

export interface McpPrompt {
  name: string;
  description?: string;
  arguments?: { name: string; description?: string; required?: boolean }[];
}

export interface McpResource {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface McpClientOptions {
  url: string;
  authHeader: () => Promise<string | null>;
  onBeforeFetch?: (url: string) => Promise<void>;
  onUnauthorized?: (challenge: McpOAuthChallenge) => Promise<boolean>;
  onCapabilitiesChanged?: () => void;
  onElicit?: (
    request: { message: string; requestedSchema: Record<string, unknown> },
    context: McpToolCallContext,
  ) => Promise<ElicitResult>;
}

export interface McpToolCallContext {
  threadId: string;
  itemId: string;
}

export class McpClient {
  private sdk: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;
  tools: McpTool[] = [];
  prompts: McpPrompt[] = [];
  resources: McpResource[] = [];
  private activeToolContext: McpToolCallContext | null = null;
  private toolCallTail = Promise.resolve();
  private capabilityRefreshGeneration = 0;

  constructor(private opts: McpClientOptions) {}

  async connect(): Promise<void> {
    const scheduleCapabilityRefresh = () => {
      void this.refreshCapabilities().catch(() => undefined);
    };
    const sdk = new Client(
      { name: 'Panelot', version: packageJson.version },
      {
        capabilities: { elicitation: { form: {} } },
        listChanged: {
          tools: { onChanged: scheduleCapabilityRefresh },
          prompts: { onChanged: scheduleCapabilityRefresh },
          resources: { onChanged: scheduleCapabilityRefresh },
        },
      },
    );
    sdk.setRequestHandler(ElicitRequestSchema, async (request) => {
      if (request.params.mode === 'url' || !this.opts.onElicit || !this.activeToolContext) {
        return { action: 'decline' };
      }
      return this.opts.onElicit(
        {
          message: request.params.message,
          requestedSchema: request.params.requestedSchema as Record<string, unknown>,
        },
        this.activeToolContext,
      );
    });
    const transport = new StreamableHTTPClientTransport(new URL(this.opts.url), {
      fetch: (input, init) => this.fetchWithAuth(input, init),
    });
    try {
      await sdk.connect(transport);
      this.sdk = sdk;
      this.transport = transport;
      await this.refreshCapabilities();
    } catch (error) {
      this.sdk = null;
      this.transport = null;
      await sdk.close().catch(() => undefined);
      throw error;
    }
  }

  async close(): Promise<void> {
    const sdk = this.sdk;
    this.capabilityRefreshGeneration += 1;
    this.sdk = null;
    this.transport = null;
    if (sdk) await sdk.close();
  }

  async refreshCapabilities(): Promise<void> {
    const sdk = this.requireClient();
    const generation = ++this.capabilityRefreshGeneration;
    const [tools, prompts, resources] = await Promise.allSettled([
      sdk.listTools(),
      sdk.listPrompts(),
      sdk.listResources(),
    ]);
    if (this.sdk !== sdk || generation !== this.capabilityRefreshGeneration) return;
    if (tools.status === 'fulfilled') {
      this.tools = tools.value.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as Record<string, unknown>,
        annotations: tool.annotations
          ? {
              readOnlyHint: tool.annotations.readOnlyHint,
              title: tool.annotations.title,
            }
          : undefined,
      }));
    }
    if (prompts.status === 'fulfilled') {
      this.prompts = prompts.value.prompts.map((prompt) => ({
        name: prompt.name,
        description: prompt.description,
        arguments: prompt.arguments,
      }));
    }
    if (resources.status === 'fulfilled') {
      this.resources = resources.value.resources.map((resource) => ({
        uri: resource.uri,
        name: resource.name,
        description: resource.description,
        mimeType: resource.mimeType,
      }));
    }
    if ([tools, prompts, resources].every((result) => result.status === 'rejected')) return;
    this.opts.onCapabilitiesChanged?.();
  }

  async callTool(
    name: string,
    args: unknown,
    context?: McpToolCallContext,
    signal?: AbortSignal,
  ): Promise<{ content: { type: string; text?: string }[]; isError?: boolean }> {
    const previous = this.toolCallTail;
    let release = (): void => undefined;
    this.toolCallTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await waitForTurn(previous, signal);
    } catch (error) {
      void previous.finally(release);
      throw error;
    }
    this.activeToolContext = context ?? null;
    try {
      const result = await this.requireClient().callTool(
        {
          name,
          arguments: (args ?? {}) as Record<string, unknown>,
        },
        undefined,
        { signal },
      );
      return result as { content: { type: string; text?: string }[]; isError?: boolean };
    } finally {
      this.activeToolContext = null;
      release();
    }
  }

  async getPrompt(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ messages: { role: string; content: { type: string; text?: string } }[] }> {
    const promptArguments = Object.fromEntries(
      Object.entries(args).map(([key, value]) => [key, String(value)]),
    );
    return this.requireClient().getPrompt({ name, arguments: promptArguments }) as Promise<{
      messages: { role: string; content: { type: string; text?: string } }[];
    }>;
  }

  async readResource(
    uri: string,
  ): Promise<{ contents: { uri: string; text?: string; blob?: string; mimeType?: string }[] }> {
    return this.requireClient().readResource({ uri }) as Promise<{
      contents: { uri: string; text?: string; blob?: string; mimeType?: string }[];
    }>;
  }

  private requireClient(): Client {
    if (!this.sdk) throw new Error('MCP client is not connected');
    return this.sdk;
  }

  private async fetchWithAuth(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = async () => {
      const url = input instanceof Request ? input.url : String(input);
      await this.opts.onBeforeFetch?.(url);
      const headers = new Headers(init?.headers);
      const authorization = await this.opts.authHeader();
      if (authorization) headers.set('Authorization', authorization);
      return fetch(input, { ...init, headers, redirect: 'error' });
    };
    let response = await request();
    const challenge = extractWWWAuthenticateParams(response);
    const shouldReauthorize =
      response.status === 401 ||
      (response.status === 403 && challenge.error === 'insufficient_scope');
    if (
      shouldReauthorize &&
      this.opts.onUnauthorized &&
      (await this.opts.onUnauthorized({
        resourceMetadataUrl: challenge.resourceMetadataUrl?.toString(),
        scope: challenge.scope,
        error: challenge.error,
      }))
    ) {
      response = await request();
    }
    return response;
  }
}

function waitForTurn(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return previous;
  if (signal.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const onAbort = () => finish(() => reject(new DOMException('aborted', 'AbortError')));
    const finish = (settle: () => void) => {
      signal.removeEventListener('abort', onAbort);
      settle();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void previous.then(
      () => finish(resolve),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}
