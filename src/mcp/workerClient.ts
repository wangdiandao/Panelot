import type { McpPrompt, McpResource, McpTool } from './client';
import { validateCrossContextValueSize } from '../messaging/resourceLimits';
import { ensureMcpWorkerDocument } from './offscreenWorker';

interface McpCatalog {
  tools: McpTool[];
  prompts: McpPrompt[];
  resources: McpResource[];
}

const MAX_CATALOG_ENTRIES = 10_000;
const MCP_WORKER_VALUE_LIMITS = {
  maxDepth: 64,
  maxNodes: 100_000,
  maxArrayLength: MAX_CATALOG_ENTRIES,
  maxObjectKeys: 10_000,
  maxStringCodeUnits: 64 * 1_024 * 1_024,
  maxBinaryBytes: 64 * 1_024 * 1_024,
} as const;

interface WorkerSuccessResponse {
  ok: true;
  catalog?: unknown;
  result?: unknown;
}

export class McpWorkerClient {
  tools: McpTool[] = [];
  prompts: McpPrompt[] = [];
  resources: McpResource[] = [];
  private readonly connectionId = crypto.randomUUID();

  private readonly listener = (message: unknown) => {
    if (!isRecord(message)) return;
    if (
      message.type !== 'panelot.mcpWorker.changed' ||
      message.serverId !== this.serverId ||
      message.connectionId !== this.connectionId
    ) {
      return;
    }
    let catalog: McpCatalog;
    try {
      catalog = parseCatalog(message.catalog);
    } catch {
      return;
    }
    this.applyCatalog(catalog);
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
    const response = await this.request({
      type: 'panelot.mcpWorker.connect',
      serverId: this.serverId,
      ...input,
    });
    this.applyCatalog(parseCatalog(response.catalog));
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
    signal?: AbortSignal,
  ): Promise<{ content: { type: string; text?: string }[]; isError?: boolean }> {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const operationId = crypto.randomUUID();
    const response = await abortableRequest(
      this.request({
        type: 'panelot.mcpWorker.callTool',
        serverId: this.serverId,
        operationId,
        name,
        args,
        context,
      }),
      signal,
      () => {
        void chrome.runtime
          .sendMessage({
            type: 'panelot.mcpWorker.cancel',
            serverId: this.serverId,
            connectionId: this.connectionId,
            operationId,
          })
          .catch(() => undefined);
      },
    );
    return parseCallToolResult(response.result);
  }

  async getPrompt(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ messages: { role: string; content: { type: string; text?: string } }[] }> {
    const response = await this.request({
      type: 'panelot.mcpWorker.getPrompt',
      serverId: this.serverId,
      name,
      args,
    });
    return parsePromptResult(response.result);
  }

  async readResource(
    uri: string,
  ): Promise<{ contents: { uri: string; text?: string; blob?: string; mimeType?: string }[] }> {
    const response = await this.request({
      type: 'panelot.mcpWorker.readResource',
      serverId: this.serverId,
      uri,
    });
    return parseResourceResult(response.result);
  }

  private applyCatalog(catalog: McpCatalog): void {
    this.tools = catalog.tools;
    this.prompts = catalog.prompts;
    this.resources = catalog.resources;
  }

  private async request(message: Record<string, unknown>): Promise<WorkerSuccessResponse> {
    return parseWorkerResponse(
      await chrome.runtime.sendMessage({
        ...message,
        serverId: this.serverId,
        connectionId: this.connectionId,
      }),
    );
  }
}

function abortableRequest<T>(
  request: Promise<T>,
  signal: AbortSignal | undefined,
  onAbort: () => void,
): Promise<T> {
  if (!signal) return request;
  return new Promise((resolve, reject) => {
    const abort = () => {
      cleanup();
      onAbort();
      reject(new DOMException('aborted', 'AbortError'));
    };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    void request.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function parseWorkerResponse(value: unknown): WorkerSuccessResponse {
  const budgetIssue = validateCrossContextValueSize(
    value,
    'MCP worker response',
    MCP_WORKER_VALUE_LIMITS,
    { rejectCycles: true },
  );
  if (budgetIssue) throw new Error(budgetIssue);
  if (!isRecord(value) || typeof value.ok !== 'boolean') {
    throw new Error('MCP worker returned an invalid response envelope');
  }
  if (!value.ok) {
    throw new Error(typeof value.error === 'string' ? value.error : 'MCP worker request failed');
  }
  return { ok: true, catalog: value.catalog, result: value.result };
}

function parseCatalog(value: unknown): McpCatalog {
  const budgetIssue = validateCrossContextValueSize(
    value,
    'MCP worker catalog',
    MCP_WORKER_VALUE_LIMITS,
    { rejectCycles: true },
  );
  if (budgetIssue) throw new Error(budgetIssue);
  const catalog = requireRecord(value, 'catalog');
  return {
    tools: requireArray(catalog.tools, 'catalog.tools').map(parseTool),
    prompts: requireArray(catalog.prompts, 'catalog.prompts').map(parsePrompt),
    resources: requireArray(catalog.resources, 'catalog.resources').map(parseResource),
  };
}

function parseTool(value: unknown, index: number): McpTool {
  const tool = requireRecord(value, `catalog.tools[${index}]`);
  const annotations = optionalRecord(tool.annotations, `catalog.tools[${index}].annotations`);
  return {
    name: requireString(tool.name, `catalog.tools[${index}].name`),
    description: optionalString(tool.description, `catalog.tools[${index}].description`),
    inputSchema: requireRecord(tool.inputSchema, `catalog.tools[${index}].inputSchema`),
    annotations: annotations
      ? {
          readOnlyHint: optionalBoolean(
            annotations.readOnlyHint,
            `catalog.tools[${index}].annotations.readOnlyHint`,
          ),
          title: optionalString(annotations.title, `catalog.tools[${index}].annotations.title`),
        }
      : undefined,
  };
}

function parsePrompt(value: unknown, index: number): McpPrompt {
  const prompt = requireRecord(value, `catalog.prompts[${index}]`);
  const rawArguments = prompt.arguments;
  return {
    name: requireString(prompt.name, `catalog.prompts[${index}].name`),
    description: optionalString(prompt.description, `catalog.prompts[${index}].description`),
    arguments:
      rawArguments === undefined
        ? undefined
        : requireArray(rawArguments, `catalog.prompts[${index}].arguments`).map(
            (value, argumentIndex) => {
              const argument = requireRecord(
                value,
                `catalog.prompts[${index}].arguments[${argumentIndex}]`,
              );
              return {
                name: requireString(
                  argument.name,
                  `catalog.prompts[${index}].arguments[${argumentIndex}].name`,
                ),
                description: optionalString(
                  argument.description,
                  `catalog.prompts[${index}].arguments[${argumentIndex}].description`,
                ),
                required: optionalBoolean(
                  argument.required,
                  `catalog.prompts[${index}].arguments[${argumentIndex}].required`,
                ),
              };
            },
          ),
  };
}

function parseResource(value: unknown, index: number): McpResource {
  const resource = requireRecord(value, `catalog.resources[${index}]`);
  return {
    uri: requireString(resource.uri, `catalog.resources[${index}].uri`),
    name: optionalString(resource.name, `catalog.resources[${index}].name`),
    description: optionalString(resource.description, `catalog.resources[${index}].description`),
    mimeType: optionalString(resource.mimeType, `catalog.resources[${index}].mimeType`),
  };
}

function parseCallToolResult(value: unknown): {
  content: { type: string; text?: string }[];
  isError?: boolean;
} {
  const result = requireRecord(value, 'callTool result');
  return {
    content: requireArray(result.content, 'callTool result.content').map((value, index) => {
      const block = requireRecord(value, `callTool result.content[${index}]`);
      return {
        type: requireString(block.type, `callTool result.content[${index}].type`),
        text: optionalString(block.text, `callTool result.content[${index}].text`),
      };
    }),
    isError: optionalBoolean(result.isError, 'callTool result.isError'),
  };
}

function parsePromptResult(value: unknown): {
  messages: { role: string; content: { type: string; text?: string } }[];
} {
  const result = requireRecord(value, 'getPrompt result');
  return {
    messages: requireArray(result.messages, 'getPrompt result.messages').map((value, index) => {
      const message = requireRecord(value, `getPrompt result.messages[${index}]`);
      const content = requireRecord(message.content, `getPrompt result.messages[${index}].content`);
      return {
        role: requireString(message.role, `getPrompt result.messages[${index}].role`),
        content: {
          type: requireString(content.type, `getPrompt result.messages[${index}].content.type`),
          text: optionalString(content.text, `getPrompt result.messages[${index}].content.text`),
        },
      };
    }),
  };
}

function parseResourceResult(value: unknown): {
  contents: { uri: string; text?: string; blob?: string; mimeType?: string }[];
} {
  const result = requireRecord(value, 'readResource result');
  return {
    contents: requireArray(result.contents, 'readResource result.contents').map((value, index) => {
      const content = requireRecord(value, `readResource result.contents[${index}]`);
      return {
        uri: requireString(content.uri, `readResource result.contents[${index}].uri`),
        text: optionalString(content.text, `readResource result.contents[${index}].text`),
        blob: optionalString(content.blob, `readResource result.contents[${index}].blob`),
        mimeType: optionalString(
          content.mimeType,
          `readResource result.contents[${index}].mimeType`,
        ),
      };
    }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`MCP worker ${path} must be an object`);
  return value;
}

function optionalRecord(value: unknown, path: string): Record<string, unknown> | undefined {
  return value === undefined ? undefined : requireRecord(value, path);
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value) || value.length > MAX_CATALOG_ENTRIES) {
    throw new Error(`MCP worker ${path} must be a bounded array`);
  }
  return value;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`MCP worker ${path} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`MCP worker ${path} must be a string`);
  return value;
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`MCP worker ${path} must be a boolean`);
  return value;
}
