import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAiAdapter, ThinkTagSplitter, toOpenAiMessages } from '../../src/providers/openai';
import { AnthropicAdapter, toAnthropicMessages } from '../../src/providers/anthropic';
import {
  mergeParams,
  ProviderError,
  type Connection,
  type StreamEvent,
} from '../../src/providers/types';
import type { UnifiedMessage } from '../../src/db/sessionContext';
import { buildProviderErrorPresentation } from '../../src/ui/providerErrorPresentation';

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
function sseResponse(frames: string[], status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { 'content-type': 'text/event-stream' } });
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

describe('Provider request redirect policy', () => {
  const adapters = [
    {
      name: 'OpenAI',
      make: () => new OpenAiAdapter(conn()),
      stream: [
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ],
    },
    {
      name: 'Anthropic',
      make: () =>
        new AnthropicAdapter(conn({ kind: 'anthropic', baseUrl: 'https://api.anthropic.com' })),
      stream: [
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ],
    },
  ] as const;

  it.each(adapters)(
    'refuses automatic redirects for $name credentials and content',
    async (test) => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(sseResponse([...test.stream]))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      const adapter = test.make();

      await adapter.stream(baseReq).final();
      await adapter.listModels();

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      for (const [, init] of fetchSpy.mock.calls) {
        expect(init).toEqual(expect.objectContaining({ redirect: 'error' }));
      }
    },
  );
});

describe('OpenAiAdapter streaming', () => {
  it('streams text deltas and aggregates the final message + usage', async () => {
    mockFetchOnce(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    const stream = new OpenAiAdapter(conn()).stream(baseReq);
    const events: StreamEvent[] = [];
    for await (const ev of stream) events.push(ev);
    const final = await stream.final();

    expect(
      events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta),
    ).toEqual(['Hel', 'lo']);
    expect(final.message).toEqual([{ type: 'text', text: 'Hello' }]);
    expect(final.usage).toMatchObject({ input: 10, output: 2 });
    expect(final.stopReason).toBe('end');
  });

  it('aggregates chunked tool_calls by index and parses arguments', async () => {
    mockFetchOnce(
      sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"click","arguments":""}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"ref\\":"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"s1_2\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    const stream = new OpenAiAdapter(conn()).stream(baseReq);
    const final = await stream.final(); // final() without manual iteration must drain

    expect(final.toolCalls).toEqual([{ id: 'call_1', name: 'click', params: { ref: 's1_2' } }]);
    expect(final.stopReason).toBe('tool_use');
  });

  it('surfaces malformed tool JSON as parseError for model self-correction', async () => {
    mockFetchOnce(
      sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"click","arguments":"{broken"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    const final = await new OpenAiAdapter(conn()).stream(baseReq).final();
    expect(final.toolCalls[0]!.parseError).toMatch(/not valid JSON/);
  });

  it('extracts reasoning from delta.reasoning_content', async () => {
    mockFetchOnce(
      sseResponse([
        'data: {"choices":[{"delta":{"reasoning_content":"thinking..."}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    const final = await new OpenAiAdapter(conn()).stream(baseReq).final();
    expect(final.reasoning).toBe('thinking...');
    expect(final.message).toEqual([{ type: 'text', text: 'answer' }]);
  });

  it('honors quirks in the request payload', async () => {
    const spy = mockFetchOnce(
      sseResponse([
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    await new OpenAiAdapter(
      conn({
        quirks: { noStreamOptions: true, maxTokensField: 'max_completion_tokens' },
      }),
    )
      .stream({ ...baseReq, params: { maxTokens: 100, temperature: 0.5 } })
      .final();

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
      {
        role: 'assistant',
        content: [],
        toolCalls: [{ id: 'c1', name: 'click', params: { ref: 'r' } }],
      },
      {
        role: 'tool_result',
        toolCallId: 'c1',
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      },
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
    mockFetchOnce(
      sseResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":20,"cache_read_input_tokens":5}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"I will click."}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_1","name":"click"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"ref\\""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":":\\"s2_1\\"}"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":15}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]),
    );
    const final = await new AnthropicAdapter(aconn).stream(baseReq).final();

    expect(final.message).toEqual([{ type: 'text', text: 'I will click.' }]);
    expect(final.toolCalls).toEqual([{ id: 'tu_1', name: 'click', params: { ref: 's2_1' } }]);
    expect(final.usage).toEqual({ input: 20, output: 15, cacheRead: 5 });
    expect(final.stopReason).toBe('tool_use');
  });

  it('captures thinking deltas as reasoning', async () => {
    mockFetchOnce(
      sseResponse([
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"done"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]),
    );
    const final = await new AnthropicAdapter(aconn).stream(baseReq).final();
    expect(final.reasoning).toBe('hmm');
  });

  it('sets cache_control breakpoints on system and last tool', async () => {
    const spy = mockFetchOnce(
      sseResponse([
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":0}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]),
    );
    await new AnthropicAdapter(aconn)
      .stream({
        ...baseReq,
        system: 'KERNEL',
        tools: [
          { name: 't1', description: 'd1', parameters: { type: 'object' } },
          { name: 't2', description: 'd2', parameters: { type: 'object' } },
        ],
      })
      .final();

    const body = JSON.parse(spy.mock.calls[0]![1]!.body as string);
    expect(body.cache_control).toEqual({ type: 'ephemeral' });
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(body.tools[0].cache_control).toBeUndefined();
    expect(body.tools[1].cache_control).toEqual({ type: 'ephemeral' });
    const headers = spy.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers['anthropic-dangerous-direct-browser-access']).toBe('true');
  });

  it('maps overloaded_error stream frames to a non-settings overloaded presentation', async () => {
    mockFetchOnce(
      sseResponse([
        'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"busy"}}\n\n',
      ]),
    );
    const error = (await new AnthropicAdapter(aconn)
      .stream(baseReq)
      .final()
      .catch((caught: unknown) => caught)) as ProviderError;

    expect(error).toMatchObject({
      kind: 'overloaded',
      details: { status: 200, reason: 'upstream_error', upstreamCode: 'overloaded_error' },
    });
    expect(buildProviderErrorPresentation(error)).toMatchObject({
      summaryKey: 'error.reason.upstream_error',
      opensSettings: false,
    });
  });
});

describe('Anthropic message conversion', () => {
  it('puts tool_result inside user messages and merges consecutive results', () => {
    const messages: UnifiedMessage[] = [
      {
        role: 'assistant',
        content: [],
        toolCalls: [
          { id: 'a', name: 't1', params: {} },
          { id: 'b', name: 't2', params: {} },
        ],
      },
      {
        role: 'tool_result',
        toolCallId: 'a',
        content: [{ type: 'text', text: 'r1' }],
        isError: false,
      },
      {
        role: 'tool_result',
        toolCallId: 'b',
        content: [{ type: 'text', text: 'r2' }],
        isError: true,
      },
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

describe('provider verification diagnostics', () => {
  it('preserves OpenAI chat-probe status and upstream details', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: 'deepseek-v4-flash' }] }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { code: 'invalid_request', message: 'invalid tools' } }),
          { status: 400 },
        ),
      );

    await expect(new OpenAiAdapter(conn()).verify()).resolves.toMatchObject({
      failure: 'protocol_mismatch',
      detail: 'invalid tools',
      details: {
        status: 400,
        reason: 'invalid_request',
        upstreamCode: 'invalid_request',
        upstreamMessage: 'invalid tools',
      },
    });
  });

  it('preserves Anthropic chat-probe status and upstream details', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: 'claude-test' }] }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { type: 'invalid_request_error', message: 'invalid tools' } }),
          { status: 400 },
        ),
      );

    await expect(
      new AnthropicAdapter(
        conn({ kind: 'anthropic', baseUrl: 'https://api.anthropic.com' }),
      ).verify(),
    ).resolves.toMatchObject({
      failure: 'protocol_mismatch',
      detail: 'invalid tools',
      details: {
        status: 400,
        reason: 'invalid_request',
        upstreamCode: 'invalid_request_error',
        upstreamMessage: 'invalid tools',
      },
    });
  });

  it('preserves broad invalid-key compatibility while preferring the upstream message', async () => {
    mockFetchOnce(
      new Response(
        JSON.stringify({ error: { code: 'invalid_api_key', message: 'Key was rejected' } }),
        { status: 401 },
      ),
    );

    await expect(new OpenAiAdapter(conn()).verify()).resolves.toMatchObject({
      failure: 'invalid_key',
      detail: 'Key was rejected',
      details: {
        status: 401,
        reason: 'invalid_key',
        upstreamMessage: 'Key was rejected',
      },
    });
  });
});

describe('provider response-format diagnostics', () => {
  const adapters = [
    ['OpenAI', () => new OpenAiAdapter(conn())],
    [
      'Anthropic',
      () => new AnthropicAdapter(conn({ kind: 'anthropic', baseUrl: 'https://api.anthropic.com' })),
    ],
  ] as const;

  it.each(adapters)(
    'marks a successful %s response without a body as response_format',
    async (_name, make) => {
      mockFetchOnce(new Response(null, { status: 200 }));

      await expect(make().stream(baseReq).final()).rejects.toMatchObject({
        kind: 'protocol',
        details: {
          status: 200,
          reason: 'response_format',
          upstreamMessage: 'response has no body',
        },
      });
    },
  );

  it('preserves an OpenAI 204 status when the response has no body', async () => {
    mockFetchOnce(new Response(null, { status: 204 }));

    await expect(new OpenAiAdapter(conn()).stream(baseReq).final()).rejects.toMatchObject({
      kind: 'protocol',
      details: {
        status: 204,
        reason: 'response_format',
        upstreamMessage: 'response has no body',
      },
    });
  });

  it('preserves an Anthropic 206 status for an empty readable stream', async () => {
    mockFetchOnce(new Response('', { status: 206 }));

    await expect(
      new AnthropicAdapter(conn({ kind: 'anthropic', baseUrl: 'https://api.anthropic.com' }))
        .stream(baseReq)
        .final(),
    ).rejects.toMatchObject({
      kind: 'protocol',
      details: {
        status: 206,
        reason: 'response_format',
        upstreamMessage: 'provider response contained no recognizable frames',
      },
    });
  });

  it('rejects OpenAI clean EOF after text as an incomplete protocol response', async () => {
    mockFetchOnce(sseResponse(['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'], 206));

    await expect(new OpenAiAdapter(conn()).stream(baseReq).final()).rejects.toMatchObject({
      kind: 'protocol',
      details: {
        status: 206,
        reason: 'response_format',
        upstreamMessage: 'provider stream ended before [DONE]',
      },
    });
  });

  it('requires both OpenAI finish_reason and [DONE]', async () => {
    mockFetchOnce(sseResponse(['data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n']));
    await expect(new OpenAiAdapter(conn()).stream(baseReq).final()).rejects.toMatchObject({
      kind: 'protocol',
      details: { reason: 'response_format' },
    });

    mockFetchOnce(
      sseResponse(['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', 'data: [DONE]\n\n']),
    );
    await expect(new OpenAiAdapter(conn()).stream(baseReq).final()).rejects.toMatchObject({
      kind: 'protocol',
      details: {
        reason: 'response_format',
        upstreamMessage: 'provider stream ended without finish_reason',
      },
    });
  });

  it.each(['future_reason', 'function_call'])(
    'fails closed for unsupported OpenAI finish_reason %s',
    async (finishReason) => {
      mockFetchOnce(
        sseResponse([
          `data: {"choices":[{"delta":{},"finish_reason":"${finishReason}"}]}\n\n`,
          'data: [DONE]\n\n',
        ]),
      );

      await expect(new OpenAiAdapter(conn()).stream(baseReq).final()).rejects.toMatchObject({
        kind: 'protocol',
        details: { reason: 'response_format' },
      });
    },
  );

  it('rejects deprecated OpenAI delta.function_call instead of ignoring it', async () => {
    mockFetchOnce(
      sseResponse([
        'data: {"choices":[{"delta":{"function_call":{"name":"legacy"}}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    );

    await expect(new OpenAiAdapter(conn()).stream(baseReq).final()).rejects.toMatchObject({
      kind: 'protocol',
      details: { reason: 'response_format' },
    });
  });

  it('requires Anthropic stop_reason and message_stop terminal frames', async () => {
    const anthropic = () =>
      new AnthropicAdapter(conn({ kind: 'anthropic', baseUrl: 'https://api.anthropic.com' }));

    mockFetchOnce(
      sseResponse([
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n',
      ]),
    );
    await expect(anthropic().stream(baseReq).final()).rejects.toMatchObject({
      kind: 'protocol',
      details: { upstreamMessage: 'provider stream ended without message_delta.stop_reason' },
    });

    mockFetchOnce(
      sseResponse([
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
      ]),
    );
    await expect(anthropic().stream(baseReq).final()).rejects.toMatchObject({
      kind: 'protocol',
      details: { upstreamMessage: 'provider stream ended before message_stop' },
    });

    mockFetchOnce(sseResponse(['data: {"type":"message_stop"}\n\n']));
    await expect(anthropic().stream(baseReq).final()).rejects.toMatchObject({
      kind: 'protocol',
      details: { upstreamMessage: 'provider stream ended without message_delta.stop_reason' },
    });
  });

  it.each([
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
    'data: {"type":"future_terminal"}\n\n',
    'data: {"type":"message_stop"}\n\n',
  ])('fails closed for a non-ping event after Anthropic message_stop', async (trailingEvent) => {
    mockFetchOnce(
      sseResponse([
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
        'data: {"type":"message_stop"}\n\n',
        trailingEvent,
      ]),
    );

    await expect(
      new AnthropicAdapter(conn({ kind: 'anthropic', baseUrl: 'https://api.anthropic.com' }))
        .stream(baseReq)
        .final(),
    ).rejects.toMatchObject({
      kind: 'protocol',
      details: {
        reason: 'response_format',
        upstreamMessage: expect.stringContaining('after message_stop'),
      },
    });
  });

  it.each(['future_reason', 'pause_turn'])(
    'fails closed for unsupported Anthropic stop_reason %s',
    async (stopReason) => {
      mockFetchOnce(
        sseResponse([
          `data: {"type":"message_delta","delta":{"stop_reason":"${stopReason}"},"usage":{"output_tokens":1}}\n\n`,
          'data: {"type":"message_stop"}\n\n',
        ]),
      );

      await expect(
        new AnthropicAdapter(conn({ kind: 'anthropic', baseUrl: 'https://api.anthropic.com' }))
          .stream(baseReq)
          .final(),
      ).rejects.toMatchObject({ kind: 'protocol', details: { reason: 'response_format' } });
    },
  );

  it('maps Anthropic model_context_window_exceeded to an incomplete max_tokens result', async () => {
    mockFetchOnce(
      sseResponse([
        'data: {"type":"message_delta","delta":{"stop_reason":"model_context_window_exceeded"},"usage":{"output_tokens":4}}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ]),
    );

    await expect(
      new AnthropicAdapter(conn({ kind: 'anthropic', baseUrl: 'https://api.anthropic.com' }))
        .stream(baseReq)
        .final(),
    ).resolves.toMatchObject({ stopReason: 'max_tokens', usage: { output: 4 } });
  });

  it.each(adapters)('rejects an empty readable %s response body', async (_name, make) => {
    mockFetchOnce(new Response('', { status: 200 }));

    await expect(make().stream(baseReq).final()).rejects.toMatchObject({
      kind: 'protocol',
      details: {
        status: 200,
        reason: 'response_format',
        upstreamMessage: 'provider response contained no recognizable frames',
      },
    });
  });

  it.each(adapters)('rejects a non-SSE %s response body', async (_name, make) => {
    mockFetchOnce(new Response('<html>upstream proxy</html>', { status: 200 }));

    await expect(make().stream(baseReq).final()).rejects.toMatchObject({
      details: { reason: 'response_format' },
    });
  });

  it.each(adapters)('rejects malformed JSON-only %s frames', async (_name, make) => {
    mockFetchOnce(sseResponse(['data: {bad json}\n\n']));

    await expect(make().stream(baseReq).final()).rejects.toMatchObject({
      details: { reason: 'response_format' },
    });
  });

  it.each(adapters)('rejects unknown JSON-only %s frames', async (_name, make) => {
    mockFetchOnce(sseResponse(['data: {"unknown":"frame"}\n\n']));

    await expect(make().stream(baseReq).final()).rejects.toMatchObject({
      details: { reason: 'response_format' },
    });
  });

  it.each(adapters)('rejects null JSON-only %s frames as response_format', async (_name, make) => {
    mockFetchOnce(sseResponse(['data: null\n\n']));

    await expect(make().stream(baseReq).final()).rejects.toMatchObject({
      kind: 'protocol',
      details: { reason: 'response_format' },
    });
  });

  it('does not recognize malformed OpenAI usage or delta shapes', async () => {
    mockFetchOnce(
      sseResponse([
        'data: {"usage":"not-an-object"}\n\n',
        'data: {"choices":[{"delta":"not-an-object"}]}\n\n',
      ]),
    );

    await expect(new OpenAiAdapter(conn()).stream(baseReq).final()).rejects.toMatchObject({
      details: { reason: 'response_format' },
    });
  });

  it('rejects malformed-only OpenAI usage frames with the response status', async () => {
    mockFetchOnce(
      sseResponse(
        [
          'data: {"usage":{"prompt_tokens":"3"}}\n\n',
          'data: {"usage":{"completion_tokens":-1}}\n\n',
          'data: {"usage":{"prompt_tokens_details":[]}}\n\n',
          'data: {"usage":{"prompt_tokens_details":null}}\n\n',
          'data: {"usage":{"prompt_tokens_details":{"cached_tokens":1.5}}}\n\n',
        ],
        206,
      ),
    );

    await expect(new OpenAiAdapter(conn()).stream(baseReq).final()).rejects.toMatchObject({
      kind: 'protocol',
      details: { status: 206, reason: 'response_format' },
    });
  });

  it('drops malformed OpenAI usage before a later valid model frame', async () => {
    mockFetchOnce(
      sseResponse([
        'data: {"usage":{"prompt_tokens":99,"completion_tokens":{},"prompt_tokens_details":{"cached_tokens":"7"}}}\n\n',
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    );

    const stream = new OpenAiAdapter(conn()).stream(baseReq);
    const events: StreamEvent[] = [];
    for await (const event of stream) events.push(event);
    const final = await stream.final();

    expect(events).toEqual([{ type: 'text', delta: 'ok' }]);
    expect(final.message).toEqual([{ type: 'text', text: 'ok' }]);
    expect(final.usage).toEqual({ input: 0, output: 0 });
  });

  it('does not recognize an empty OpenAI usage object as a provider frame', async () => {
    mockFetchOnce(sseResponse(['data: {"usage":{}}\n\n'], 206));

    await expect(new OpenAiAdapter(conn()).stream(baseReq).final()).rejects.toMatchObject({
      kind: 'protocol',
      details: { status: 206, reason: 'response_format' },
    });
  });

  it('ignores an empty OpenAI usage object before a later valid frame', async () => {
    mockFetchOnce(
      sseResponse([
        'data: {"usage":{}}\n\n',
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    );

    await expect(new OpenAiAdapter(conn()).stream(baseReq).final()).resolves.toMatchObject({
      message: [{ type: 'text', text: 'ok' }],
      usage: { input: 0, output: 0 },
    });
  });

  it('rejects non-array OpenAI tool calls as response_format with the response status', async () => {
    mockFetchOnce(
      sseResponse(['data: {"choices":[{"delta":{"tool_calls":{"index":0}}}]}\n\n'], 206),
    );

    await expect(new OpenAiAdapter(conn()).stream(baseReq).final()).rejects.toMatchObject({
      kind: 'protocol',
      details: { status: 206, reason: 'response_format' },
    });
  });

  it('rejects malformed OpenAI tool-call entries without leaking a TypeError', async () => {
    mockFetchOnce(
      sseResponse(
        [
          'data: {"choices":[{"delta":{"tool_calls":[null,"bad",[],{"id":"missing-index"},{"index":"0"},{"index":0,"function":"bad"},{"index":1,"function":{"name":3}}]}}]}\n\n',
        ],
        207,
      ),
    );

    await expect(new OpenAiAdapter(conn()).stream(baseReq).final()).rejects.toMatchObject({
      kind: 'protocol',
      details: { status: 207, reason: 'response_format' },
    });
  });

  it('tolerates malformed OpenAI tool calls when a later frame is recognizable', async () => {
    mockFetchOnce(
      sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[null,{"index":0,"function":"bad"}]}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"still works"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    );

    await expect(new OpenAiAdapter(conn()).stream(baseReq).final()).resolves.toMatchObject({
      message: [{ type: 'text', text: 'still works' }],
    });
  });

  it('tolerates OpenAI junk before a recognizable usage-only frame', async () => {
    mockFetchOnce(
      sseResponse([
        'data: {bad json}\n\n',
        'data: {"unknown":"frame"}\n\n',
        'data: {"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    );

    await expect(new OpenAiAdapter(conn()).stream(baseReq).final()).resolves.toMatchObject({
      usage: { input: 3, output: 1 },
    });
  });

  it('tolerates Anthropic junk before recognizable protocol frames', async () => {
    mockFetchOnce(
      sseResponse([
        'data: {bad json}\n\n',
        'data: {"unknown":"frame"}\n\n',
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":0}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]),
    );

    await expect(
      new AnthropicAdapter(conn({ kind: 'anthropic', baseUrl: 'https://api.anthropic.com' }))
        .stream(baseReq)
        .final(),
    ).resolves.toMatchObject({ usage: { input: 3, output: 0 } });
  });

  it('rejects malformed-only Anthropic model frames with the response status', async () => {
    mockFetchOnce(
      sseResponse(
        [
          'data: {"type":"message_start","message":[]}' + '\n\n',
          'data: {"type":"message_start","message":{"usage":{"input_tokens":"3","cache_read_input_tokens":{}}}}' +
            '\n\n',
          'data: {"type":"content_block_start","index":"0","content_block":{"type":"tool_use","id":{},"name":[]}}' +
            '\n\n',
          'data: {"type":"content_block_start","index":0,"content_block":null}' + '\n\n',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":{}}}' +
            '\n\n',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":{}}}' +
            '\n\n',
          'data: {"type":"message_delta","delta":[],"usage":{"output_tokens":[]}}' + '\n\n',
          'data: {"type":"content_block_stop","index":"0"}' + '\n\n',
        ],
        206,
      ),
    );

    await expect(
      new AnthropicAdapter(conn({ kind: 'anthropic', baseUrl: 'https://api.anthropic.com' }))
        .stream(baseReq)
        .final(),
    ).rejects.toMatchObject({
      kind: 'protocol',
      details: { status: 206, reason: 'response_format' },
    });
  });

  it('drops malformed Anthropic values before later valid model frames', async () => {
    mockFetchOnce(
      sseResponse([
        'data: {"type":"content_block_start","index":"0","content_block":{"type":"tool_use","id":{},"name":[]}}' +
          '\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":{}}}' +
          '\n\n',
        'data: {"type":"message_delta","delta":{"stop_reason":[]},"usage":{"output_tokens":{}}}' +
          '\n\n',
        'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tool-1","name":"click"}}' +
          '\n\n',
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"ref\\":\\"s1\\"}"}}' +
          '\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}' +
          '\n\n',
        'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":2}}' +
          '\n\n',
        'data: {"type":"message_stop"}\n\n',
      ]),
    );

    const stream = new AnthropicAdapter(
      conn({ kind: 'anthropic', baseUrl: 'https://api.anthropic.com' }),
    ).stream(baseReq);
    const events: StreamEvent[] = [];
    for await (const event of stream) events.push(event);
    const final = await stream.final();

    expect(events).toEqual([
      { type: 'tool_call_partial', index: 1, id: 'tool-1', name: 'click', argsDelta: '' },
      { type: 'tool_call_partial', index: 1, argsDelta: '{"ref":"s1"}' },
      { type: 'text', delta: 'ok' },
      { type: 'usage', usage: { input: 0, output: 2 } },
    ]);
    expect(final.message).toEqual([{ type: 'text', text: 'ok' }]);
    expect(final.toolCalls).toEqual([{ id: 'tool-1', name: 'click', params: { ref: 's1' } }]);
    expect(final.usage).toEqual({ input: 0, output: 2 });
  });

  it('does not treat an Anthropic ping as a model response', async () => {
    mockFetchOnce(sseResponse(['data: {"type":"ping"}\n\n'], 207));

    await expect(
      new AnthropicAdapter(conn({ kind: 'anthropic', baseUrl: 'https://api.anthropic.com' }))
        .stream(baseReq)
        .final(),
    ).rejects.toMatchObject({
      kind: 'protocol',
      details: { status: 207, reason: 'response_format' },
    });
  });

  it('accepts shape-valid Anthropic message lifecycle frames as an empty model response', async () => {
    mockFetchOnce(
      sseResponse([
        'data: {"type":"message_start","message":{"usage":{"input_tokens":0}}}\n\n',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":0}}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ]),
    );

    await expect(
      new AnthropicAdapter(conn({ kind: 'anthropic', baseUrl: 'https://api.anthropic.com' }))
        .stream(baseReq)
        .final(),
    ).resolves.toMatchObject({ message: [], toolCalls: [], usage: { input: 0, output: 0 } });
  });

  it('keeps an unknown OpenAI provider error frame as response_format and redacts credentials', async () => {
    mockFetchOnce(
      sseResponse([
        'data: {"error":{"code":"bad_frame","message":"api_key=sk-supersecret rejected"}}\n\n',
      ]),
    );

    await expect(new OpenAiAdapter(conn()).stream(baseReq).final()).rejects.toMatchObject({
      kind: 'protocol',
      details: {
        status: 200,
        reason: 'response_format',
        upstreamCode: 'bad_frame',
        upstreamMessage: 'api_key=[REDACTED] rejected',
      },
    });
  });

  it.each([
    {
      name: 'OpenAI invalid key',
      make: () => new OpenAiAdapter(conn()),
      frame:
        'data: {"error":{"code":"invalid_api_key","message":"api_key=sk-supersecret rejected"}}\n\n',
      kind: 'auth',
      reason: 'invalid_key',
    },
    {
      name: 'Anthropic authentication',
      make: () =>
        new AnthropicAdapter(conn({ kind: 'anthropic', baseUrl: 'https://api.anthropic.com' })),
      frame:
        'event: error\ndata: {"type":"error","error":{"type":"authentication_error","message":"Bearer secret-token rejected"}}\n\n',
      kind: 'auth',
      reason: 'invalid_key',
    },
    {
      name: 'OpenAI rate limit',
      make: () => new OpenAiAdapter(conn()),
      frame:
        'data: {"error":{"code":"rate_limit_exceeded","message":"requests are arriving too quickly"}}\n\n',
      kind: 'rate_limit',
      reason: undefined,
    },
    {
      name: 'Anthropic quota limit',
      make: () =>
        new AnthropicAdapter(conn({ kind: 'anthropic', baseUrl: 'https://api.anthropic.com' })),
      frame:
        'event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"credit quota exhausted"}}\n\n',
      kind: 'rate_limit',
      reason: 'quota_exceeded',
    },
    {
      name: 'OpenAI insufficient quota',
      make: () => new OpenAiAdapter(conn()),
      frame:
        'data: {"error":{"code":"insufficient_quota","message":"Current quota exceeded for this account"}}\n\n',
      kind: 'rate_limit',
      reason: 'quota_exceeded',
      upstreamCode: 'insufficient_quota',
      upstreamMessage: 'Current quota exceeded for this account',
    },
    {
      name: 'Anthropic insufficient permissions',
      make: () =>
        new AnthropicAdapter(conn({ kind: 'anthropic', baseUrl: 'https://api.anthropic.com' })),
      frame:
        'event: error\ndata: {"type":"error","error":{"type":"insufficient_permissions","message":"Key lacks access to this model"}}\n\n',
      kind: 'auth',
      reason: 'permission_denied',
      upstreamCode: 'insufficient_permissions',
      upstreamMessage: 'Key lacks access to this model',
    },
  ])(
    'classifies an in-band $name frame without response_format',
    async ({ make, frame, kind, reason, upstreamCode, upstreamMessage }) => {
      mockFetchOnce(sseResponse([frame], 207));

      const error = await make()
        .stream(baseReq)
        .final()
        .catch((caught: unknown) => caught);

      expect(error).toMatchObject({ kind, details: { status: 207 } });
      if (upstreamCode) {
        expect(error).toMatchObject({ details: { upstreamCode, upstreamMessage } });
      }
      if (reason) {
        expect(error).toMatchObject({ details: { reason } });
      } else {
        expect(error).not.toMatchObject({ details: { reason: 'response_format' } });
        expect((error as { details?: { reason?: string } }).details?.reason).toBeUndefined();
      }
    },
  );

  it('classifies OpenAI model and invalid-request error codes', async () => {
    mockFetchOnce(
      sseResponse(
        [
          'data: {"error":{"code":"model_not_found","message":"requested model is unavailable"}}\n\n',
        ],
        208,
      ),
    );

    await expect(new OpenAiAdapter(conn()).stream(baseReq).final()).rejects.toMatchObject({
      kind: 'protocol',
      details: { status: 208, reason: 'model_not_found', upstreamCode: 'model_not_found' },
    });
  });

  it('classifies Anthropic invalid_request_error frames', async () => {
    mockFetchOnce(
      sseResponse(
        [
          'event: error\ndata: {"type":"error","error":{"type":"invalid_request_error","message":"request schema invalid"}}\n\n',
        ],
        209,
      ),
    );

    await expect(
      new AnthropicAdapter(conn({ kind: 'anthropic', baseUrl: 'https://api.anthropic.com' }))
        .stream(baseReq)
        .final(),
    ).rejects.toMatchObject({
      kind: 'protocol',
      details: { status: 209, reason: 'invalid_request', upstreamCode: 'invalid_request_error' },
    });
  });

  it('classifies an Anthropic authentication frame and redacts credentials', async () => {
    mockFetchOnce(
      sseResponse([
        'event: error\ndata: {"type":"error","error":{"type":"authentication_error","message":"Bearer secret-token rejected"}}\n\n',
      ]),
    );

    await expect(
      new AnthropicAdapter(conn({ kind: 'anthropic', baseUrl: 'https://api.anthropic.com' }))
        .stream(baseReq)
        .final(),
    ).rejects.toMatchObject({
      kind: 'auth',
      details: {
        status: 200,
        reason: 'invalid_key',
        upstreamCode: 'authentication_error',
        upstreamMessage: 'Bearer [REDACTED] rejected',
      },
    });
  });
});

describe('mergeParams (docs/03 §1.4)', () => {
  it('merges two layers with overrides winning and undefined skipped', () => {
    expect(
      mergeParams({ temperature: 0.7, maxTokens: 1000 }, { temperature: 0.2, topP: undefined }),
    ).toEqual({ temperature: 0.2, maxTokens: 1000 });
  });
});
