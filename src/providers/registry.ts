/**
 * ProviderRegistry: connection storage, URL normalization, preset templates,
 * concurrent model fetching (docs/03 §4-6).
 */

import { AnthropicAdapter } from './anthropic';
import { OpenAiAdapter } from './openai';
import type { Connection, ModelEntry, ProviderAdapter, QuirkFlags } from './types';

// ---------------------------------------------------------------------------
// URL normalization (docs/03 §4)
// ---------------------------------------------------------------------------

export function normalizeBaseUrl(raw: string, kind: Connection['kind']): { url: string; hint?: string } {
  let url = raw.trim();
  if (url === '') return { url };

  // Default to https (http allowed for localhost).
  if (!/^https?:\/\//i.test(url)) {
    const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])([:/]|$)/.test(url);
    url = (isLocal ? 'http://' : 'https://') + url;
  }
  // Strip trailing slashes.
  url = url.replace(/\/+$/, '');

  // openai kind usually needs /v1 — hint, don't force (Azure-style paths exist).
  let hint: string | undefined;
  if (kind === 'openai' && !/\/v\d+($|\/)/.test(new URL(url).pathname)) {
    hint = 'OpenAI-compatible endpoints usually end with /v1 — append it if requests fail.';
  }
  return { url, hint };
}

// ---------------------------------------------------------------------------
// Preset templates (docs/03 §4) — one-click fill, user only pastes the key
// ---------------------------------------------------------------------------

export interface ConnectionTemplate {
  name: string;
  kind: Connection['kind'];
  baseUrl: string;
  quirks?: QuirkFlags;
  /** Local endpoints need no key. */
  keyless?: boolean;
  note?: string;
}

export const CONNECTION_TEMPLATES: readonly ConnectionTemplate[] = [
  { name: 'Anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com' },
  { name: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1' },
  {
    name: 'OpenRouter',
    kind: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    note: 'Set HTTP-Referer/X-Title custom headers for app attribution.',
  },
  { name: 'DeepSeek', kind: 'openai', baseUrl: 'https://api.deepseek.com/v1', quirks: { thinkTagReasoning: true } },
  { name: 'Moonshot (Kimi)', kind: 'openai', baseUrl: 'https://api.moonshot.cn/v1' },
  { name: '智谱 GLM', kind: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { name: '阿里百炼 (DashScope)', kind: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { name: 'Ollama (local)', kind: 'openai', baseUrl: 'http://localhost:11434/v1', keyless: true, quirks: { noStreamOptions: true } },
  { name: 'LM Studio (local)', kind: 'openai', baseUrl: 'http://localhost:1234/v1', keyless: true },
  { name: 'Custom', kind: 'openai', baseUrl: '' },
] as const;

// ---------------------------------------------------------------------------
// Known-model capability table (docs/03 §1.2) — conservative fallback beyond it
// ---------------------------------------------------------------------------

interface KnownModel {
  /** Prefix match against the model id. */
  prefix: string;
  toolUse: boolean;
  vision: boolean;
  reasoning?: boolean;
  maxContext?: number;
}

const KNOWN_MODELS: readonly KnownModel[] = [
  { prefix: 'claude-', toolUse: true, vision: true, reasoning: true, maxContext: 200_000 },
  { prefix: 'gpt-5', toolUse: true, vision: true, reasoning: true, maxContext: 272_000 },
  { prefix: 'gpt-4.1', toolUse: true, vision: true, maxContext: 1_000_000 },
  { prefix: 'gpt-4o', toolUse: true, vision: true, maxContext: 128_000 },
  { prefix: 'o3', toolUse: true, vision: true, reasoning: true, maxContext: 200_000 },
  { prefix: 'o4', toolUse: true, vision: true, reasoning: true, maxContext: 200_000 },
  { prefix: 'deepseek-chat', toolUse: true, vision: false, maxContext: 128_000 },
  { prefix: 'deepseek-reasoner', toolUse: true, vision: false, reasoning: true, maxContext: 128_000 },
  { prefix: 'kimi-', toolUse: true, vision: true, maxContext: 128_000 },
  { prefix: 'glm-', toolUse: true, vision: false, maxContext: 128_000 },
  { prefix: 'qwen', toolUse: true, vision: false, maxContext: 131_072 },
  { prefix: 'llama', toolUse: true, vision: false, maxContext: 128_000 },
] as const;

export function inferCapabilities(modelId: string): ModelEntry['capabilities'] {
  const id = modelId.toLowerCase();
  for (const known of KNOWN_MODELS) {
    if (id.startsWith(known.prefix) || id.includes(`/${known.prefix}`)) {
      return {
        toolUse: known.toolUse,
        vision: known.vision,
        reasoning: known.reasoning,
        maxContext: known.maxContext,
      };
    }
  }
  // Conservative default (docs/03 §1.2): assume tool use, no vision.
  return { toolUse: true, vision: false };
}

// ---------------------------------------------------------------------------
// Adapter factory & model fetching
// ---------------------------------------------------------------------------

export function createAdapter(connection: Connection): ProviderAdapter {
  return connection.kind === 'anthropic'
    ? new AnthropicAdapter(connection)
    : new OpenAiAdapter(connection);
}

export interface ModelFetchResult {
  connectionId: string;
  models: ModelEntry[];
  error?: string;
}

/**
 * Fetch models from ALL enabled connections concurrently, each with its own
 * 4s timeout. One failing connection never blocks the others (docs/03 §6 —
 * OpenWebUI's serial-timeout lesson).
 */
export async function fetchAllModels(connections: Connection[]): Promise<ModelFetchResult[]> {
  return Promise.all(
    connections
      .filter((c) => c.enabled)
      .map(async (c): Promise<ModelFetchResult> => {
        // Manual whitelist wins when present.
        if (c.modelIds?.length) {
          return {
            connectionId: c.id,
            models: c.modelIds.map((id) => ({
              connectionId: c.id,
              id,
              capabilities: inferCapabilities(id),
            })),
          };
        }
        try {
          const adapter = createAdapter(c);
          if (!adapter.listModels) return { connectionId: c.id, models: [] };
          const ids = await adapter.listModels();
          return {
            connectionId: c.id,
            models: ids.map((id) => ({ connectionId: c.id, id, capabilities: inferCapabilities(id) })),
          };
        } catch (e) {
          return { connectionId: c.id, models: [], error: (e as Error).message };
        }
      }),
  );
}
