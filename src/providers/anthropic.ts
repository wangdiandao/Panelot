/**
 * AnthropicAdapter — POST {baseUrl}/v1/messages (docs/03 §3.2).
 *
 * Event stream: message_start / content_block_start / content_block_delta
 * (text_delta | input_json_delta | thinking_delta) / content_block_stop /
 * message_delta / message_stop — aggregated by content block index.
 *
 * Prompt caching: cache_control ephemeral breakpoints on the tools definition
 * and system prompt (docs/03 §3.2 + docs/10 §1) — in agent loops each turn
 * makes several calls, so cache hits dominate cost.
 */

import type { UnifiedMessage } from '../db/sessionContext';
import type { ContentBlock, Usage } from '../messaging/protocol';
import { iterateSse } from './sse';
import { createKeyRing, normalizeHttpError, withRetry } from './http';
import {
  ProviderError,
  type Connection,
  type FinalResult,
  type FinalToolCall,
  type ProviderAdapter,
  type ProviderStream,
  type StreamEvent,
  type StreamRequest,
  type VerifyResult,
} from './types';
import { verifyConnection } from './openai';

// ---------------------------------------------------------------------------
// Message conversion: UnifiedMessage → Anthropic messages format
// ---------------------------------------------------------------------------

type AnthropicContent =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
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
        const content: AnthropicContent[] = blocksToAnthropic(m.content);
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
      // Required for direct calls from extension contexts (docs/03 §3.2).
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
    };
    if (req.system) {
      // Cache breakpoint at the end of the stable system layer (docs/10 §1).
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
    }
    const p = req.params;
    if (p.temperature !== undefined) body.temperature = p.temperature;
    if (p.topP !== undefined) body.top_p = p.topP;
    if (p.stopSequences !== undefined) body.stop_sequences = p.stopSequences;
    if (p.reasoningEffort !== undefined) {
      // Map reasoning effort to a thinking budget (docs/03 §1.4 leaves the
      // mapping to the adapter; unset → no thinking block).
      const budgets = { low: 2048, medium: 8192, high: 16384 } as const;
      const maxTokens = body.max_tokens as number;
      if (maxTokens > 1024) {
        body.thinking = {
          type: 'enabled',
          budget_tokens: Math.min(budgets[p.reasoningEffort], maxTokens - 1),
        };
      }
    }

    const url = `${this.connection.baseUrl}/v1/messages`;
    const headers = (k: string) => this.headers(k);

    const textParts: string[] = [];
    const reasoningParts: string[] = [];
    // index → partial tool_use block
    const partialBlocks = new Map<number, { id: string; name: string; json: string }>();
    let usage: Usage = { input: 0, output: 0 };
    let stopReason = '';

    async function* run(): AsyncGenerator<StreamEvent> {
      const response = await withRetry(
        keys,
        async (apiKey) => {
          let res: Response;
          try {
            res = await fetch(url, {
              method: 'POST',
              headers: headers(apiKey),
              body: JSON.stringify(body),
              signal: req.signal,
            });
          } catch (e) {
            if (e instanceof DOMException && e.name === 'AbortError') throw e;
            throw new ProviderError('network', `fetch failed: ${(e as Error).message}`);
          }
          if (!res.ok) {
            throw normalizeHttpError(
              res.status,
              await res.text().catch(() => ''),
              res.headers.get('retry-after'),
            );
          }
          if (!res.body) throw new ProviderError('protocol', 'response has no body');
          return res;
        },
        { signal: req.signal },
      );

      for await (const sse of iterateSse(response.body!, req.signal)) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(sse.data);
        } catch {
          continue;
        }
        const ev = parsed as {
          type: string;
          index?: number;
          message?: { usage?: { input_tokens?: number; cache_read_input_tokens?: number } };
          content_block?: { type: string; id?: string; name?: string };
          delta?: {
            type?: string;
            text?: string;
            partial_json?: string;
            thinking?: string;
            stop_reason?: string;
          };
          usage?: { output_tokens?: number };
          error?: { type?: string; message?: string };
        };

        switch (ev.type) {
          case 'error':
            throw new ProviderError(
              ev.error?.type === 'overloaded_error' ? 'overloaded' : 'protocol',
              ev.error?.message ?? 'provider stream error',
            );
          case 'message_start': {
            const u = ev.message?.usage;
            if (u) {
              usage = {
                input: u.input_tokens ?? 0,
                output: 0,
                cacheRead: u.cache_read_input_tokens,
              };
            }
            break;
          }
          case 'content_block_start': {
            if (ev.content_block?.type === 'tool_use' && ev.index !== undefined) {
              partialBlocks.set(ev.index, {
                id: ev.content_block.id ?? crypto.randomUUID(),
                name: ev.content_block.name ?? '',
                json: '',
              });
              yield {
                type: 'tool_call_partial',
                index: ev.index,
                id: ev.content_block.id,
                name: ev.content_block.name,
                argsDelta: '',
              };
            }
            break;
          }
          case 'content_block_delta': {
            const d = ev.delta;
            if (!d) break;
            if (d.type === 'text_delta' && d.text) {
              textParts.push(d.text);
              yield { type: 'text', delta: d.text };
            } else if (d.type === 'thinking_delta' && d.thinking) {
              reasoningParts.push(d.thinking);
              yield { type: 'reasoning', delta: d.thinking };
            } else if (
              d.type === 'input_json_delta' &&
              d.partial_json !== undefined &&
              ev.index !== undefined
            ) {
              const block = partialBlocks.get(ev.index);
              if (block) block.json += d.partial_json;
              yield { type: 'tool_call_partial', index: ev.index, argsDelta: d.partial_json };
            }
            break;
          }
          case 'message_delta': {
            if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
            if (ev.usage?.output_tokens !== undefined) {
              usage = { ...usage, output: ev.usage.output_tokens };
              yield { type: 'usage', usage };
            }
            break;
          }
          // content_block_stop / message_stop / ping: no action needed.
        }
      }
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
        const finalStop: FinalResult['stopReason'] =
          stopReason === 'tool_use'
            ? 'tool_use'
            : stopReason === 'max_tokens'
              ? 'max_tokens'
              : stopReason === 'refusal'
                ? 'content_filter'
                : 'end';
        const message: ContentBlock[] = [];
        const text = textParts.join('');
        if (text) message.push({ type: 'text', text });
        const reasoning = reasoningParts.join('');
        return {
          message,
          reasoning: reasoning || undefined,
          toolCalls,
          usage,
          stopReason: finalStop,
        };
      },
    };
  }

  async listModels(): Promise<string[]> {
    const keys = createKeyRing(this.connection.apiKeys);
    const res = await fetch(`${this.connection.baseUrl}/v1/models`, {
      headers: this.headers(keys.current()),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw normalizeHttpError(res.status, await res.text().catch(() => ''), null);
    const json = (await res.json()) as { data?: { id: string }[] };
    return (json.data ?? []).map((m) => m.id);
  }

  async verify(): Promise<VerifyResult> {
    return verifyConnection(this, this.connection);
  }
}
