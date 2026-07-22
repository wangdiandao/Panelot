/**
 * AnthropicAdapter — POST {baseUrl}/v1/messages (docs/development/providers.md §3.2).
 *
 * Event stream: message_start / content_block_start / content_block_delta
 * (text_delta | input_json_delta | thinking_delta) / content_block_stop /
 * message_delta / message_stop — aggregated by content block index.
 *
 * Prompt caching: cache_control ephemeral breakpoints on the tools definition
 * and system prompt (docs/development/providers.md §3.2 + docs/development/prompts.md §1) — in agent loops each turn
 * makes several calls, so cache hits dominate cost.
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
  type Connection,
  type AnthropicThinkingBlock,
  type FinalResult,
  type FinalToolCall,
  type ProviderAdapter,
  type ProviderStream,
  type StreamEvent,
  type StreamRequest,
} from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isBlockIndex(value: unknown): value is number {
  return isTokenCount(value);
}

function mapAnthropicStopReason(reason: string, status: number): FinalResult['stopReason'] {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'max_tokens';
    case 'refusal':
      return 'content_filter';
    case 'pause_turn':
      throw createResponseFormatError(
        'protocol',
        status,
        'pause_turn requires a server-tool continuation loop that Panelot does not support',
        'pause_turn requires an unsupported server-tool continuation',
      );
    default:
      throw createResponseFormatError(
        'protocol',
        status,
        `unsupported stop_reason: ${reason}`,
        'provider returned an unsupported stop_reason',
      );
  }
}

// ---------------------------------------------------------------------------
// Message conversion: UnifiedMessage → Anthropic messages format
// ---------------------------------------------------------------------------

type AnthropicContent =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | AnthropicThinkingBlock
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicContent[];
}

function blocksToAnthropic(blocks: ContentBlock[]): AnthropicContent[] {
  return blocks.map((b) =>
    b.type === 'text'
      ? { type: 'text' as const, text: b.text }
      : {
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: b.mime, data: b.data },
        },
  );
}

export function toAnthropicMessages(messages: UnifiedMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  for (const m of messages) {
    switch (m.role) {
      case 'user':
        out.push({ role: 'user', content: blocksToAnthropic(m.content) });
        break;
      case 'assistant': {
        const content: AnthropicContent[] =
          m.providerState?.kind === 'anthropic'
            ? m.providerState.thinkingBlocks.map((block) => structuredClone(block))
            : [];
        content.push(...blocksToAnthropic(m.content));
        for (const c of m.toolCalls ?? []) {
          content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.params ?? {} });
        }
        if (content.length > 0) out.push({ role: 'assistant', content });
        break;
      }
      case 'tool_result': {
        const resultBlock: AnthropicContent = {
          type: 'tool_result',
          tool_use_id: m.toolCallId,
          content: m.content
            .map((b) => (b.type === 'text' ? b.text : '[image omitted]'))
            .join('\n'),
          ...(m.isError ? { is_error: true } : {}),
        };
        // Anthropic requires tool_result inside a user message; consecutive
        // results merge into one user message.
        const prev = out[out.length - 1];
        if (prev && prev.role === 'user' && prev.content.every((c) => c.type === 'tool_result')) {
          prev.content.push(resultBlock);
        } else {
          out.push({ role: 'user', content: [resultBlock] });
        }
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class AnthropicAdapter implements ProviderAdapter {
  constructor(private connection: Connection) {}

  private headers(apiKey: string): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      // Required for direct calls from extension contexts (docs/development/providers.md §3.2).
      'anthropic-dangerous-direct-browser-access': 'true',
      ...this.connection.customHeaders,
    };
  }

  stream(req: StreamRequest): ProviderStream {
    const keys = createKeyRing(this.connection.apiKeys);

    const body: Record<string, unknown> = {
      model: req.model,
      messages: toAnthropicMessages(req.messages),
      stream: true,
      // Anthropic requires max_tokens; default generously when unset.
      max_tokens: req.params.maxTokens ?? 8192,
      // Advance the cache point through growing conversation history.
      cache_control: { type: 'ephemeral' },
    };
    if (req.system) {
      // Cache breakpoint at the end of the stable system layer (docs/development/prompts.md §1).
      body.system = [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }];
    }
    if (req.tools.length > 0) {
      body.tools = req.tools.map((t, i) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
        // Cache breakpoint on the last tool: tools precede system in the
        // request layout, so this caches the whole tools array.
        ...(i === req.tools.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}),
      }));
      if (this.connection.quirks?.noParallelToolCalls) {
        body.tool_choice = { type: 'auto', disable_parallel_tool_use: true };
      }
    }
    const p = req.params;
    if (p.temperature !== undefined) body.temperature = p.temperature;
    if (p.topP !== undefined) body.top_p = p.topP;
    if (p.stopSequences !== undefined) body.stop_sequences = p.stopSequences;
    if (p.reasoningEffort !== undefined) {
      if (this.connection.quirks?.anthropicManualThinking) {
        const budgets = { low: 2048, medium: 8192, high: 16384 } as const;
        const maxTokens = body.max_tokens as number;
        const answerReserve = 1024;
        if (maxTokens <= answerReserve + 1024) {
          throw createResponseFormatError(
            'protocol',
            400,
            'Anthropic manual thinking needs maxTokens > 2048',
            'not enough maxTokens for manual thinking',
          );
        }
        body.thinking = {
          type: 'enabled',
          budget_tokens: Math.min(budgets[p.reasoningEffort], maxTokens - answerReserve),
        };
      } else {
        body.thinking = { type: 'adaptive' };
        body.output_config = { effort: p.reasoningEffort };
      }
    }

    const url = `${this.connection.baseUrl}/v1/messages`;
    const headers = (k: string) => this.headers(k);
    const maxAttempts = Math.max(4, this.connection.apiKeys.length);

    const textParts: string[] = [];
    const reasoningParts: string[] = [];
    const thinkingBlocks = new Map<number, AnthropicThinkingBlock>();
    // index → partial tool_use block
    const partialBlocks = new Map<number, { id: string; name: string; json: string }>();
    let usage: Usage = { input: 0, output: 0 };
    let stopReason: string | undefined;
    let sawMessageStop = false;
    let finalStopReason: FinalResult['stopReason'] | undefined;
    // Transport keepalives do not prove the provider produced a model response;
    // only shape-valid model lifecycle or data frames do.
    let recognizedFrame = false;

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
        { signal: req.signal, maxAttempts, requestIdHeaders: 'request-id' },
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
        if (sse.terminal === 'done') continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(sse.data);
        } catch {
          continue;
        }
        if (!isRecord(parsed) || typeof parsed.type !== 'string') continue;
        const ev = parsed;

        if (sawMessageStop && ev.type !== 'ping') {
          throw createResponseFormatError(
            'protocol',
            response.status,
            `provider emitted ${ev.type} after message_stop`,
            'provider emitted an event after the final message_stop',
          );
        }

        switch (ev.type) {
          case 'error': {
            if (!isRecord(ev.error)) break;
            if (ev.error.type !== undefined && typeof ev.error.type !== 'string') break;
            if (ev.error.message !== undefined && typeof ev.error.message !== 'string') break;
            throw createProviderFrameError(
              response.status,
              ev.error?.message,
              'provider stream error',
              ev.error?.type,
            );
          }
          case 'message_start': {
            if (!isRecord(ev.message)) break;
            const u = ev.message.usage;
            if (u !== undefined) {
              if (!isRecord(u)) break;
              if (u.input_tokens !== undefined && !isTokenCount(u.input_tokens)) break;
              if (
                u.cache_read_input_tokens !== undefined &&
                !isTokenCount(u.cache_read_input_tokens)
              ) {
                break;
              }
              usage = {
                input: isTokenCount(u.input_tokens) ? u.input_tokens : 0,
                output: 0,
                cacheRead: isTokenCount(u.cache_read_input_tokens)
                  ? u.cache_read_input_tokens
                  : undefined,
              };
            }
            recognizedFrame = true;
            break;
          }
          case 'content_block_start': {
            if (!isBlockIndex(ev.index) || !isRecord(ev.content_block)) break;
            const block = ev.content_block;
            if (block.type === 'tool_use') {
              if (typeof block.id !== 'string' || typeof block.name !== 'string') break;
              partialBlocks.set(ev.index, {
                id: block.id,
                name: block.name,
                json: '',
              });
              yield {
                type: 'tool_call_partial',
                index: ev.index,
                id: block.id,
                name: block.name,
                argsDelta: '',
              };
            } else if (block.type === 'text') {
              if (typeof block.text !== 'string') break;
            } else if (block.type === 'thinking') {
              if (typeof block.thinking !== 'string') break;
              if (block.signature !== undefined && typeof block.signature !== 'string') break;
              thinkingBlocks.set(ev.index, {
                type: 'thinking',
                thinking: block.thinking,
                signature: typeof block.signature === 'string' ? block.signature : '',
              });
              if (block.thinking) {
                reasoningParts.push(block.thinking);
                yield { type: 'reasoning', delta: block.thinking };
              }
            } else if (block.type === 'redacted_thinking') {
              if (typeof block.data !== 'string') break;
              thinkingBlocks.set(ev.index, { type: 'redacted_thinking', data: block.data });
            } else {
              break;
            }
            recognizedFrame = true;
            break;
          }
          case 'content_block_delta': {
            if (!isBlockIndex(ev.index) || !isRecord(ev.delta)) break;
            const d = ev.delta;
            if (d.type === 'text_delta' && typeof d.text === 'string') {
              recognizedFrame = true;
              if (d.text) {
                textParts.push(d.text);
                yield { type: 'text', delta: d.text };
              }
            } else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') {
              const block = thinkingBlocks.get(ev.index);
              if (!block || block.type !== 'thinking') break;
              recognizedFrame = true;
              if (d.thinking) {
                block.thinking += d.thinking;
                reasoningParts.push(d.thinking);
                yield { type: 'reasoning', delta: d.thinking };
              }
            } else if (d.type === 'signature_delta' && typeof d.signature === 'string') {
              const block = thinkingBlocks.get(ev.index);
              if (!block || block.type !== 'thinking') break;
              recognizedFrame = true;
              block.signature += d.signature;
            } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
              const block = partialBlocks.get(ev.index);
              if (!block) break;
              recognizedFrame = true;
              block.json += d.partial_json;
              yield { type: 'tool_call_partial', index: ev.index, argsDelta: d.partial_json };
            }
            break;
          }
          case 'message_delta': {
            if (!isRecord(ev.delta) || !isRecord(ev.usage)) break;
            if (
              ev.delta.stop_reason !== undefined &&
              ev.delta.stop_reason !== null &&
              typeof ev.delta.stop_reason !== 'string'
            ) {
              break;
            }
            if (!isTokenCount(ev.usage.output_tokens)) break;
            recognizedFrame = true;
            if (typeof ev.delta.stop_reason === 'string' && ev.delta.stop_reason) {
              if (stopReason && stopReason !== ev.delta.stop_reason) {
                throw createResponseFormatError(
                  'protocol',
                  response.status,
                  'provider returned conflicting stop_reason values',
                  'provider returned conflicting stop_reason values',
                );
              }
              stopReason = ev.delta.stop_reason;
            }
            usage = { ...usage, output: ev.usage.output_tokens };
            yield { type: 'usage', usage };
            break;
          }
          case 'content_block_stop':
            if (isBlockIndex(ev.index)) recognizedFrame = true;
            break;
          case 'message_stop':
            recognizedFrame = true;
            sawMessageStop = true;
            break;
          case 'ping':
            break;
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
      if (!stopReason) {
        throw createResponseFormatError(
          'protocol',
          response.status,
          'provider stream ended without message_delta.stop_reason',
          'provider stream ended without message_delta.stop_reason',
        );
      }
      if (!sawMessageStop) {
        throw createResponseFormatError(
          'protocol',
          response.status,
          'provider stream ended before message_stop',
          'provider stream ended before message_stop',
        );
      }
      finalStopReason = mapAnthropicStopReason(stopReason, response.status);
    }

    const iterator = run();
    let consumed: Promise<void> | undefined;
    const consumeAll = async () => {
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
        const toolCalls: FinalToolCall[] = [...partialBlocks.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, block]) => {
            const call: FinalToolCall = { id: block.id, name: block.name, params: undefined };
            try {
              call.params = block.json === '' ? {} : JSON.parse(block.json);
            } catch (e) {
              call.parseError = `tool input was not valid JSON: ${(e as Error).message}`;
              call.params = block.json;
            }
            return call;
          });
        const message: ContentBlock[] = [];
        const text = textParts.join('');
        if (text) message.push({ type: 'text', text });
        const reasoning = reasoningParts.join('');
        if (!finalStopReason) {
          throw createResponseFormatError(
            'protocol',
            200,
            'provider stream ended without a final stop reason',
            'provider stream ended without a final stop reason',
          );
        }
        return {
          message,
          reasoning: reasoning || undefined,
          ...(thinkingBlocks.size > 0
            ? {
                providerState: {
                  kind: 'anthropic' as const,
                  thinkingBlocks: [...thinkingBlocks.entries()]
                    .sort(([left], [right]) => left - right)
                    .map(([, block]) => structuredClone(block)),
                },
              }
            : {}),
          toolCalls,
          usage,
          stopReason: finalStopReason,
        };
      },
    };
  }

  async listModels(): Promise<string[]> {
    const keys = createKeyRing(this.connection.apiKeys);
    const signal = AbortSignal.timeout(4000);
    const res = await requestWithRetry(
      keys,
      (apiKey) =>
        fetch(`${this.connection.baseUrl}/v1/models`, {
          redirect: 'error',
          headers: this.headers(apiKey),
          signal,
        }),
      {
        ...modelDiscoveryRetryOptions(this.connection.apiKeys.length),
        signal,
        requestIdHeaders: 'request-id',
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
}
