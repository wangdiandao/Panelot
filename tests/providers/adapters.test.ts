import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAiAdapter, ThinkTagSplitter, toOpenAiMessages } from '../../src/providers/openai';
import { AnthropicAdapter, toAnthropicMessages } from '../../src/providers/anthropic';
import { mergeParams, type Connection, type StreamEvent } from '../../src/providers/types';
import type { UnifiedMessage } from '../../src/db/sessionContext';

const conn = (overrides?: Partial<Connection>): Connection => ({
  id: 'c1',
  name: 'test',
  kind: 'openai',
  baseUrl: 'https://api.test.com/v1',
  apiKeys: ['sk-test'],
  enabled: true,
  ...overrides,
});

/** Build a streaming Response from SSE frames. */
function sseResponse(frames: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function mockFetchOnce(response: Response) {
  const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response);
  return spy;
}

afterEach(() => vi.restoreAllMocks());

const baseReq = {
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] as UnifiedMessage[],
  tools: [],
  params: {},
  model: 'test-model',
  signal: new AbortController().signal,
};

describe('OpenAiAdapter streaming', () => {
  it('streams text deltas and aggregates the final message + usage', async () => {
    mockFetchOnce(sseResponse([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n',
      'data: [DONE]\n\n',
    ]));
    const stream = new OpenAiAdapter(conn()).stream(baseReq);
    const events: StreamEvent[] = [];
    for await (const ev of stream) events.push(ev);
    const final = await stream.final();

    expect(events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta)).toEqual(['Hel', 'lo']);
    expect(final.message).toEqual([{ type: 'text', text: 'Hello' }]);
    expect(final.usage).toMatchObject({ input: 10, output: 2 });
    expect(final.stopReason).toBe('end');
  });

  it('aggregates chunked tool_calls by index and parses arguments', async () => {
    mockFetchOnce(sseResponse([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"click","arguments":""}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"ref\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"s1_2\\"}"}}]}}],"finish_reason":"tool_calls"}\n\n',
      'data: [DONE]\n\n',
    ]));
    const stream = new OpenAiAdapter(conn()).stream(baseReq);
    const final = await stream.final(); // final() without manual iteration must drain

    expect(final.toolCalls).toEqual([{ id: 'call_1', name: 'click', params: { ref: 's1_2' } }]);
    expect(final.stopReason).toBe('tool_use');
  });

  it('surfaces malformed tool JSON as parseError for model self-correction', async () => {
    mockFetchOnce(sseResponse([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"click","arguments":"{broken"}}]}}]}\n\n',
      'data: [DONE]\n\n',
    ]));
    const final = await new OpenAiAdapter(conn()).stream(baseReq).final();
    expect(final.toolCalls[0]!.parseError).toMatch(/not valid JSON/);
  });

  it('extracts reasoning from delta.reasoning_content', async () => {
    mockFetchOnce(sseResponse([
      'data: {"choices":[{"delta":{"reasoning_content":"thinking..."}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n',
      'data: [DONE]\n\n',
    ]));
    const final = await new OpenAiAdapter(conn()).stream(baseReq).final();
    expect(final.reasoning).toBe('thinking...');
    expect(final.message).toEqual([{ type: 'text', text: 'answer' }]);
  });

  it('honors quirks in the request payload', async () => {
    const spy = mockFetchOnce(sseResponse(['data: [DONE]\n\n']));
    await new OpenAiAdapter(conn({
      quirks: { noStreamOptions: true, maxTokensField: 'max_completion_tokens' },
    })).stream({ ...baseReq, params: { maxTokens: 100, temperature: 0.5 } }).final();

    const body = JSON.parse(spy.mock.calls[0]![1]!.body as string);
    expect(body.stream_options).toBeUndefined();
    expect(body.max_completion_tokens).toBe(100);
    expect(body.max_tokens).toBeUndefined();
    expect(body.temperature).toBe(0.5);
    expect(body.top_p).toBeUndefined(); // unset → not sent
  });
});

describe('ThinkTagSplitter (quirk: thinkTagReasoning)', () => {
  it('splits <think> content into reasoning, tolerating tag split across deltas', () => {
    const s = new ThinkTagSplitter();
    const parts = ['<thi', 'nk>internal', ' thought</th', 'ink>visible'];
    let text = '';
    let reasoning = '';
    for (const p of parts) {
      const r = s.feed(p);
      text += r.text;
      reasoning += r.reasoning;
    }
    expect(reasoning).toBe('internal thought');
    expect(text).toBe('visible');
  });
});

describe('OpenAI message conversion', () => {
  it('converts tool results and applies noSystemRole quirk', () => {
    const messages: UnifiedMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [], toolCalls: [{ id: 'c1', name: 'click', params: { ref: 'r' } }] },
      { role: 'tool_result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }], isError: false },
    ];
    const out = toOpenAiMessages(messages, 'SYS', { noSystemRole: true });
    expect(out[0]).toEqual({ role: 'user', content: 'SYS' });
    expect(out[2]).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'c1' }] });
    expect(out[3]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'ok' });
  });
});

describe('AnthropicAdapter streaming', () => {
  const aconn = conn({ kind: 'anthropic', baseUrl: 'https://api.anthropic.com' });

  it('streams text and tool_use blocks, aggregating by block index', async () => {
    mockFetchOnce(sseResponse([
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":20,"cache_read_input_tokens":5}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"I will click."}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_1","name":"click"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"ref\\""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":":\\"s2_1\\"}"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":15}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]));
    const final = await new AnthropicAdapter(aconn).stream(baseReq).final();

    expect(final.message).toEqual([{ type: 'text', text: 'I will click.' }]);
    expect(final.toolCalls).toEqual([{ id: 'tu_1', name: 'click', params: { ref: 's2_1' } }]);
    expect(final.usage).toEqual({ input: 20, output: 15, cacheRead: 5 });
    expect(final.stopReason).toBe('tool_use');
  });

  it('captures thinking deltas as reasoning', async () => {
    mockFetchOnce(sseResponse([
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"done"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]));
    const final = await new AnthropicAdapter(aconn).stream(baseReq).final();
    expect(final.reasoning).toBe('hmm');
  });

  it('sets cache_control breakpoints on system and last tool', async () => {
    const spy = mockFetchOnce(sseResponse(['event: message_stop\ndata: {"type":"message_stop"}\n\n']));
    await new AnthropicAdapter(aconn).stream({
      ...baseReq,
      system: 'KERNEL',
      tools: [
        { name: 't1', description: 'd1', parameters: { type: 'object' } },
        { name: 't2', description: 'd2', parameters: { type: 'object' } },
      ],
    }).final();

    const body = JSON.parse(spy.mock.calls[0]![1]!.body as string);
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(body.tools[0].cache_control).toBeUndefined();
    expect(body.tools[1].cache_control).toEqual({ type: 'ephemeral' });
    const headers = spy.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers['anthropic-dangerous-direct-browser-access']).toBe('true');
  });

  it('maps overloaded_error stream frames to ProviderError overloaded', async () => {
    mockFetchOnce(sseResponse([
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"busy"}}\n\n',
    ]));
    await expect(new AnthropicAdapter(aconn).stream(baseReq).final()).rejects.toMatchObject({ kind: 'overloaded' });
  });
});

describe('Anthropic message conversion', () => {
  it('puts tool_result inside user messages and merges consecutive results', () => {
    const messages: UnifiedMessage[] = [
      { role: 'assistant', content: [], toolCalls: [
        { id: 'a', name: 't1', params: {} },
        { id: 'b', name: 't2', params: {} },
      ] },
      { role: 'tool_result', toolCallId: 'a', content: [{ type: 'text', text: 'r1' }], isError: false },
      { role: 'tool_result', toolCallId: 'b', content: [{ type: 'text', text: 'r2' }], isError: true },
    ];
    const out = toAnthropicMessages(messages);
    expect(out).toHaveLength(2);
    expect(out[1]!.role).toBe('user');
    expect(out[1]!.content).toEqual([
      { type: 'tool_result', tool_use_id: 'a', content: 'r1' },
      { type: 'tool_result', tool_use_id: 'b', content: 'r2', is_error: true },
    ]);
  });
});

describe('mergeParams (docs/03 §1.4)', () => {
  it('merges two layers with overrides winning and undefined skipped', () => {
    expect(mergeParams(
      { temperature: 0.7, maxTokens: 1000 },
      { temperature: 0.2, topP: undefined },
    )).toEqual({ temperature: 0.2, maxTokens: 1000 });
  });
});
