/**
 * OpenAIAdapter — POST {baseUrl}/chat/completions (docs/development/providers.md §3.1).
 *
 * Handles the messy reality of "OpenAI-compatible" endpoints via QuirkFlags:
 * stream_options support, <think>-tag reasoning (DeepSeek et al.), max_tokens
 * field naming, system-role support.
 */

import type { UnifiedMessage } from '../db/sessionContext';
import type { ContentBlock, Usage } from '../messaging/protocol';
import { iterateSse } from './sse';
import {
  createKeyRing,
  createProviderFrameError,
  createResponseFormatError,
  modelDiscoveryRetryOptions,
  parseModelListResponse,
  requestWithRetry,
} from './http';
import {
  ProviderError,
  type Connection,
  type FinalResult,
  type FinalToolCall,
  type ProviderAdapter,
  type ProviderStream,
  type StreamEvent,
  type StreamRequest,
  type ToolSchema,
  type VerifyResult,
} from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

// ---------------------------------------------------------------------------
// Message conversion: UnifiedMessage → OpenAI chat format
// ---------------------------------------------------------------------------

type OpenAiMessage =
  | { role: 'system' | 'user'; content: string | OpenAiContentPart[] }
  | {
      role: 'assistant';
      content: string | null;
      reasoning_content?: string;
      tool_calls?: OpenAiToolCall[];
    }
  | { role: 'tool'; tool_call_id: string; content: string };

type OpenAiContentPart =
  { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

function blocksToParts(blocks: ContentBlock[]): string | OpenAiContentPart[] {
  if (blocks.every((b) => b.type === 'text')) {
    return blocks.map((b) => (b as { text: string }).text).join('\n');
  }
  return blocks.map((b) =>
    b.type === 'text'
      ? { type: 'text' as const, text: b.text }
      : { type: 'image_url' as const, image_url: { url: `data:${b.mime};base64,${b.data}` } },
  );
}

function blocksToPlainText(blocks: ContentBlock[]): string {
  return blocks.map((b) => (b.type === 'text' ? b.text : '[image omitted]')).join('\n');
}

export function toOpenAiMessages(
  messages: UnifiedMessage[],
  system: string | undefined,
  quirks: Connection['quirks'],
): OpenAiMessage[] {
  const out: OpenAiMessage[] = [];
  if (system) {
    if (quirks?.noSystemRole) out.push({ role: 'user', content: system });
    else out.push({ role: 'system', content: system });
  }
  for (const m of messages) {
    switch (m.role) {
      case 'user':
        out.push({ role: 'user', content: blocksToParts(m.content) });
        break;
      case 'assistant': {
        const msg: OpenAiMessage = {
          role: 'assistant',
          content: m.content.length > 0 ? blocksToPlainText(m.content) : null,
        };
        // Endpoints that emit native reasoning_content require that exact value
        // on the next request. Inline <think> endpoints keep reasoning in their
        // content protocol and must not receive this provider-specific field.
        if (m.reasoning && !quirks?.thinkTagReasoning) {
          msg.reasoning_content = m.reasoning;
        }
        if (m.toolCalls?.length) {
          msg.tool_calls = m.toolCalls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.params ?? {}) },
          }));
        }
        out.push(msg);
        break;
      }
      case 'tool_result':
        // OpenAI has no isError flag; error semantics live in the text.
        out.push({
          role: 'tool',
          tool_call_id: m.toolCallId,
          content: blocksToPlainText(m.content),
        });
        break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tool-call delta aggregation (docs/development/providers.md §3.1)
// ---------------------------------------------------------------------------

interface PartialToolCall {
  id?: string;
  name?: string;
  args: string;
}

type OpenAiFinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter';

function isOpenAiFinishReason(value: string): value is OpenAiFinishReason {
  return ['stop', 'tool_calls', 'length', 'content_filter'].includes(value);
}

function mapOpenAiFinishReason(reason: OpenAiFinishReason): FinalResult['stopReason'] {
  switch (reason) {
    case 'stop':
      return 'end';
    case 'tool_calls':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'content_filter';
  }
}

export function aggregateToolCalls(partials: Map<number, PartialToolCall>): FinalToolCall[] {
  return [...partials.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, p]) => {
      const call: FinalToolCall = {
        id: p.id ?? crypto.randomUUID(),
        name: p.name ?? '',
        params: undefined,
      };
      try {
        call.params = p.args === '' ? {} : JSON.parse(p.args);
      } catch (e) {
        // Parse failure → surfaced to the model as a tool error (docs/development/agent-engine.md §2).
        call.parseError = `tool call arguments were not valid JSON: ${(e as Error).message}`;
        call.params = p.args;
      }
      return call;
    });
}

// ---------------------------------------------------------------------------
// <think> tag extraction (quirk: thinkTagReasoning)
// ---------------------------------------------------------------------------

/** Streaming splitter for inline <think>…</think> reasoning. */
export class ThinkTagSplitter {
  private inThink = false;
  private pending = '';

  /** Returns {text, reasoning} extracted from this delta. */
  feed(delta: string): { text: string; reasoning: string } {
    let input = this.pending + delta;
    this.pending = '';
    let text = '';
    let reasoning = '';

    for (;;) {
      if (this.inThink) {
        const close = input.indexOf('</think>');
        if (close === -1) {
          // Hold back a potential partial closing tag.
          const partial = findPartialTagSuffix(input, '</think>');
          reasoning += input.slice(0, input.length - partial.length);
          this.pending = partial;
          return { text, reasoning };
        }
        reasoning += input.slice(0, close);
        input = input.slice(close + '</think>'.length);
        this.inThink = false;
      } else {
        const open = input.indexOf('<think>');
        if (open === -1) {
          const partial = findPartialTagSuffix(input, '<think>');
          text += input.slice(0, input.length - partial.length);
          this.pending = partial;
          return { text, reasoning };
        }
        text += input.slice(0, open);
        input = input.slice(open + '<think>'.length);
        this.inThink = true;
      }
    }
  }
}

function findPartialTagSuffix(s: string, tag: string): string {
  const max = Math.min(s.length, tag.length - 1);
  for (let len = max; len > 0; len--) {
    if (s.endsWith(tag.slice(0, len))) return s.slice(s.length - len);
  }
  return '';
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class OpenAiAdapter implements ProviderAdapter {
  constructor(private connection: Connection) {}

  private headers(apiKey: string): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      ...this.connection.customHeaders,
    };
  }

  stream(req: StreamRequest): ProviderStream {
    const quirks = this.connection.quirks;
    const keys = createKeyRing(this.connection.apiKeys);

    const body: Record<string, unknown> = {
      model: req.model,
      messages: toOpenAiMessages(req.messages, req.system, quirks),
      stream: true,
    };
    if (!quirks?.noStreamOptions) body.stream_options = { include_usage: true };
    if (req.tools.length > 0) {
      body.tools = req.tools.map((t: ToolSchema) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      if (quirks?.noParallelToolCalls) body.parallel_tool_calls = false;
    }
    // GenParams: unset fields never reach the payload (docs/development/providers.md §1.4).
    const p = req.params;
    if (p.temperature !== undefined) body.temperature = p.temperature;
    if (p.topP !== undefined) body.top_p = p.topP;
    if (p.maxTokens !== undefined) body[quirks?.maxTokensField ?? 'max_tokens'] = p.maxTokens;
    if (p.stopSequences !== undefined) body.stop = p.stopSequences;
    if (p.reasoningEffort !== undefined) body.reasoning_effort = p.reasoningEffort;

    const url = `${this.connection.baseUrl}/chat/completions`;
    const headers = (k: string) => this.headers(k);
    const maxAttempts = Math.max(4, this.connection.apiKeys.length);

    // Aggregation state shared between the iterator and final().
    const textParts: string[] = [];
    const reasoningParts: string[] = [];
    const partialCalls = new Map<number, PartialToolCall>();
    let usage: Usage = { input: 0, output: 0 };
    let finishReason: OpenAiFinishReason | undefined;
    let sawDone = false;
    let recognizedFrame = false;
    const splitter = quirks?.thinkTagReasoning ? new ThinkTagSplitter() : undefined;

    async function* run(): AsyncGenerator<StreamEvent> {
      const response = await requestWithRetry(
        keys,
        (apiKey) =>
          fetch(url, {
            method: 'POST',
            redirect: 'error',
            headers: headers(apiKey),
            body: JSON.stringify(body),
            signal: req.signal,
          }),
        { signal: req.signal, maxAttempts, requestIdHeaders: 'x-request-id' },
      );

      const responseBody = response.body;
      if (!responseBody) {
        throw createResponseFormatError(
          'protocol',
          response.status,
          'response has no body',
          'response has no body',
        );
      }
      for await (const sse of iterateSse(responseBody, req.signal)) {
        if (sse.terminal === 'done') {
          sawDone = true;
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(sse.data);
        } catch {
          continue; // tolerate junk frames from sloppy relays
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
        const chunk = parsed as {
          choices?: {
            delta?: {
              content?: string | null;
              reasoning_content?: string | null;
              tool_calls?: unknown;
              function_call?: unknown;
            };
            finish_reason?: string | null;
          }[];
          usage?: unknown;
          error?: { code?: string | number; type?: string; message?: string };
        };

        if (chunk.error) {
          throw createProviderFrameError(
            response.status,
            chunk.error.message,
            'provider returned error frame',
            chunk.error.code ?? chunk.error.type,
          );
        }
        if (isRecord(chunk.usage)) {
          const promptTokens = chunk.usage.prompt_tokens;
          const completionTokens = chunk.usage.completion_tokens;
          const promptDetails = chunk.usage.prompt_tokens_details;
          const validPromptTokens = promptTokens === undefined || isTokenCount(promptTokens);
          const validCompletionTokens =
            completionTokens === undefined || isTokenCount(completionTokens);
          const validPromptDetails =
            promptDetails === undefined ||
            (isRecord(promptDetails) &&
              (promptDetails.cached_tokens === undefined ||
                isTokenCount(promptDetails.cached_tokens)));
          const hasTokenCount =
            isTokenCount(promptTokens) ||
            isTokenCount(completionTokens) ||
            (isRecord(promptDetails) && isTokenCount(promptDetails.cached_tokens));

          if (hasTokenCount && validPromptTokens && validCompletionTokens && validPromptDetails) {
            recognizedFrame = true;
            usage = {
              input: isTokenCount(promptTokens) ? promptTokens : 0,
              output: isTokenCount(completionTokens) ? completionTokens : 0,
              cacheRead:
                isRecord(promptDetails) && isTokenCount(promptDetails.cached_tokens)
                  ? promptDetails.cached_tokens
                  : undefined,
            };
            yield { type: 'usage', usage };
          }
        }

        const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
        if (!choice || typeof choice !== 'object') continue;
        if (typeof choice.finish_reason === 'string') {
          recognizedFrame = true;
          if (choice.finish_reason) {
            if (!isOpenAiFinishReason(choice.finish_reason)) {
              throw createResponseFormatError(
                'protocol',
                response.status,
                `unsupported finish_reason: ${choice.finish_reason}`,
                'provider returned an unsupported finish_reason',
              );
            }
            if (finishReason && finishReason !== choice.finish_reason) {
              throw createResponseFormatError(
                'protocol',
                response.status,
                'provider returned conflicting finish_reason values',
                'provider returned conflicting finish_reason values',
              );
            }
            finishReason = choice.finish_reason;
          }
        }
        const delta = choice.delta;
        if (!delta || typeof delta !== 'object' || Array.isArray(delta)) continue;

        if (delta.function_call !== undefined) {
          throw createResponseFormatError(
            'protocol',
            response.status,
            'deprecated function_call streaming is not supported',
            'deprecated function_call streaming is not supported',
          );
        }

        if (typeof delta.reasoning_content === 'string') {
          recognizedFrame = true;
          if (delta.reasoning_content !== '') {
            reasoningParts.push(delta.reasoning_content);
            yield { type: 'reasoning', delta: delta.reasoning_content };
          }
        }
        if (typeof delta.content === 'string') {
          recognizedFrame = true;
          if (delta.content !== '') {
            if (splitter) {
              const { text, reasoning } = splitter.feed(delta.content);
              if (reasoning) {
                reasoningParts.push(reasoning);
                yield { type: 'reasoning', delta: reasoning };
              }
              if (text) {
                textParts.push(text);
                yield { type: 'text', delta: text };
              }
            } else {
              textParts.push(delta.content);
              yield { type: 'text', delta: delta.content };
            }
          }
        }
        const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
        for (const candidate of toolCalls) {
          if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
          const tc = candidate as {
            index?: unknown;
            id?: unknown;
            function?: unknown;
          };
          if (typeof tc.index !== 'number' || !Number.isInteger(tc.index)) continue;
          if (tc.id !== undefined && typeof tc.id !== 'string') continue;
          if (
            tc.function !== undefined &&
            (!tc.function || typeof tc.function !== 'object' || Array.isArray(tc.function))
          ) {
            continue;
          }
          const fn = tc.function as { name?: unknown; arguments?: unknown } | undefined;
          if (fn?.name !== undefined && typeof fn.name !== 'string') continue;
          if (fn?.arguments !== undefined && typeof fn.arguments !== 'string') continue;

          recognizedFrame = true;
          const partial = partialCalls.get(tc.index) ?? { args: '' };
          if (tc.id) partial.id = tc.id;
          if (typeof fn?.name === 'string' && fn.name) {
            partial.name = (partial.name ?? '') + fn.name;
          }
          if (typeof fn?.arguments === 'string' && fn.arguments) partial.args += fn.arguments;
          partialCalls.set(tc.index, partial);
          yield {
            type: 'tool_call_partial',
            index: tc.index,
            id: typeof tc.id === 'string' ? tc.id : undefined,
            name: typeof fn?.name === 'string' ? fn.name : undefined,
            argsDelta: typeof fn?.arguments === 'string' ? fn.arguments : '',
          };
        }
      }

      if (!recognizedFrame) {
        throw createResponseFormatError(
          'protocol',
          response.status,
          'provider response contained no recognizable frames',
          'provider response contained no recognizable frames',
        );
      }
      if (!sawDone) {
        throw createResponseFormatError(
          'protocol',
          response.status,
          'provider stream ended before [DONE]',
          'provider stream ended before [DONE]',
        );
      }
      if (!finishReason) {
        throw createResponseFormatError(
          'protocol',
          response.status,
          'provider stream ended without finish_reason',
          'provider stream ended without finish_reason',
        );
      }
    }

    const iterator = run();
    let consumed: Promise<void> | undefined;

    const consumeAll = async () => {
      // Drain remaining events if the caller stopped iterating early.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of iterator) {
        /* drain */
      }
    };

    return {
      [Symbol.asyncIterator]: () => iterator,
      final: async (): Promise<FinalResult> => {
        consumed ??= consumeAll();
        await consumed;
        const toolCalls = aggregateToolCalls(partialCalls);
        if (!finishReason) {
          throw createResponseFormatError(
            'protocol',
            200,
            'provider stream ended without finish_reason',
            'provider stream ended without finish_reason',
          );
        }
        const stopReason = mapOpenAiFinishReason(finishReason);
        const message: ContentBlock[] = [];
        const text = textParts.join('');
        if (text) message.push({ type: 'text', text });
        const reasoning = reasoningParts.join('');
        return { message, reasoning: reasoning || undefined, toolCalls, usage, stopReason };
      },
    };
  }

  async listModels(): Promise<string[]> {
    const keys = createKeyRing(this.connection.apiKeys);
    const signal = AbortSignal.timeout(4000);
    const res = await requestWithRetry(
      keys,
      (apiKey) =>
        fetch(`${this.connection.baseUrl}/models`, {
          redirect: 'error',
          headers: this.headers(apiKey),
          signal,
        }),
      {
        ...modelDiscoveryRetryOptions(this.connection.apiKeys.length),
        signal,
        requestIdHeaders: 'x-request-id',
      },
    );
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw createResponseFormatError(
        'protocol',
        res.status,
        'model list response was not valid JSON',
        'model list response was not valid JSON',
      );
    }
    return parseModelListResponse(json, res.status);
  }

  async verify(): Promise<VerifyResult> {
    return verifyConnection(this, this.connection);
  }
}

// ---------------------------------------------------------------------------
// Shared verify flow (docs/development/providers.md §6) — used by both adapters
// ---------------------------------------------------------------------------

export async function verifyConnection(
  adapter: ProviderAdapter,
  connection: Connection,
): Promise<VerifyResult> {
  const result: VerifyResult = {
    reachable: false,
    keyValid: false,
    streaming: false,
    toolUse: false,
  };

  // Step 1: GET /models (3s timeout, optional — many relays lack it).
  let models: string[] | undefined;
  if (adapter.listModels) {
    try {
      models = await adapter.listModels();
      result.reachable = true;
      result.models = models;
    } catch (e) {
      if (e instanceof ProviderError && e.kind === 'auth') {
        result.reachable = true;
        result.failure = 'invalid_key';
        result.detail = e.details.upstreamMessage ?? e.message;
        result.details = e.details;
        return result;
      }
      // Unreachable or no /models — fall through to chat probe.
    }
  }

  const probeModel = connection.modelIds?.[0] ?? models?.[0];
  if (!probeModel) {
    if (!result.reachable) {
      result.failure = 'unreachable';
      result.detail = 'no /models endpoint and no manual model list configured';
    }
    return result;
  }

  // Step 2: minimal chat request (max_tokens: 1), streaming.
  try {
    const stream = adapter.stream({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
      tools: [],
      params: { maxTokens: 1 },
      model: probeModel,
      signal: AbortSignal.timeout(10_000),
    });
    await stream.final();
    result.reachable = true;
    result.keyValid = true;
    result.streaming = true;
  } catch (e) {
    if (e instanceof ProviderError) {
      result.reachable = e.kind !== 'network';
      result.failure =
        e.kind === 'auth'
          ? 'invalid_key'
          : e.kind === 'network'
            ? 'unreachable'
            : 'protocol_mismatch';
      result.detail = e.details.upstreamMessage ?? e.message;
      result.details = e.details;
    } else {
      result.failure = 'unreachable';
      result.detail = (e as Error).message;
    }
    return result;
  }

  // Step 3: echo-tool probe for toolUse capability.
  try {
    const stream = adapter.stream({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Call the echo tool with text="hi".' }] },
      ],
      tools: [
        {
          name: 'echo',
          description: 'Echo the given text back.',
          parameters: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
          },
        },
      ],
      params: { maxTokens: 64 },
      model: probeModel,
      signal: AbortSignal.timeout(15_000),
    });
    const final = await stream.final();
    result.toolUse = final.toolCalls.length > 0;
  } catch {
    result.toolUse = false; // tool probe failure is non-fatal
  }

  return result;
}
