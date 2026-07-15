import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { PanelotDB } from '../../src/db/schema';
import { ThreadTree } from '../../src/db/tree';
import { buildSessionContext } from '../../src/db/sessionContext';
import { runTurn, type GatekeeperCheck, type TurnEnv } from '../../src/agent/loop';
import { ToolRegistry, type AgentTool } from '../../src/agent/tool';
import type { AgentEvent, ApprovalDecision } from '../../src/messaging/protocol';
import type {
  FinalResult,
  ProviderAdapter,
  ProviderStream,
  StreamEvent,
  StreamRequest,
} from '../../src/providers/types';
import { ProviderError, type ProviderErrorKind } from '../../src/providers/types';
import { actionError } from '../../src/tools/action/errors';

// ---------------------------------------------------------------------------
// Mock provider: scripted responses, records every request it receives.
// ---------------------------------------------------------------------------

type ScriptedResponse = Partial<FinalResult> & { streamText?: string[] };

class MockProvider implements ProviderAdapter {
  requests: StreamRequest[] = [];
  private script: ScriptedResponse[] = [];
  private callIndex = 0;

  queue(...responses: ScriptedResponse[]): void {
    this.script.push(...responses);
  }

  stream(req: StreamRequest): ProviderStream {
    this.requests.push(req);
    const scripted = this.script[this.callIndex++] ?? {};
    const events: StreamEvent[] = (scripted.streamText ?? []).map((t) => ({
      type: 'text',
      delta: t,
    }));
    const final: FinalResult = {
      message: scripted.message ?? [{ type: 'text', text: (scripted.streamText ?? []).join('') }],
      toolCalls: scripted.toolCalls ?? [],
      usage: scripted.usage ?? { input: 100, output: 20 },
      stopReason:
        scripted.stopReason ?? ((scripted.toolCalls?.length ?? 0) > 0 ? 'tool_use' : 'end'),
      reasoning: scripted.reasoning,
    };
    async function* gen(): AsyncGenerator<StreamEvent> {
      for (const ev of events) {
        if (req.signal.aborted) throw new DOMException('aborted', 'AbortError');
        yield ev;
      }
    }
    const iterator = gen();
    return {
      [Symbol.asyncIterator]: () => iterator,
      final: async () => {
        if (req.signal.aborted) throw new DOMException('aborted', 'AbortError');
        // drain
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _ of iterator) {
          /* drain */
        }
        return final;
      },
    };
  }

  async verify() {
    return { reachable: true, keyValid: true, streaming: true, toolUse: true };
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const allowAll: GatekeeperCheck = { check: async () => ({ verdict: 'allow' }) };

function makeEchoTool(
  overrides?: Partial<AgentTool<{ text: string }, unknown>>,
): AgentTool<{ text: string }, unknown> {
  return {
    name: 'echo',
    label: 'Echo',
    description: 'Echo text back.',
    parameters: z.object({ text: z.string() }),
    level: 'builtin',
    effects: 'read',
    execute: async (_id, params) => ({ content: [{ type: 'text', text: `echo: ${params.text}` }] }),
    ...overrides,
  };
}

let db: PanelotDB;
let tree: ThreadTree;
let provider: MockProvider;
let tools: ToolRegistry;
let events: AgentEvent[];
let n = 0;

beforeEach(() => {
  db = new PanelotDB(`loop-test-${Date.now()}-${n++}`);
  tree = new ThreadTree(db);
  provider = new MockProvider();
  tools = new ToolRegistry();
  events = [];
});

function makeEnv(overrides?: Partial<TurnEnv>): TurnEnv {
  return {
    tree,
    tools,
    gatekeeper: allowAll,
    requestApproval: async () => ({ kind: 'accept' }),
    emit: (ev) => events.push(ev),
    provider,
    model: 'mock-model',
    systemPrompt: 'SYSTEM',
    params: {},
    ...overrides,
  };
}

const eventTypes = () => events.map((e) => e.type);

// ---------------------------------------------------------------------------

describe('agent loop (docs/04 §2)', () => {
  it('emits structured provider diagnostics on a failed model call', async () => {
    const details = {
      status: 400,
      reason: 'model_not_found' as const,
      upstreamCode: 'model_not_found',
      upstreamMessage: 'Model Not Exist',
      raw: '{"error":"Model Not Exist"}',
    };
    vi.spyOn(provider, 'stream').mockImplementation(() => {
      throw new ProviderError('protocol', 'unexpected HTTP 400', undefined, details);
    });
    const thread = await tree.createThread({});

    await runTurn(makeEnv(), thread.id, { text: 'hello' }).done;

    const errorEvent = events.find((event) => event.type === 'error');
    expect(errorEvent).toMatchObject({
      type: 'error',
      threadId: thread.id,
      code: 'provider_error',
      message: 'unexpected HTTP 400',
      retryable: false,
      errorKind: 'protocol',
      providerDetails: details,
    });
    if (errorEvent?.type === 'error') {
      expect(errorEvent.providerDetails).toEqual(details);
    }
  });

  it('does not attach provider diagnostics to internal model failures', async () => {
    vi.spyOn(provider, 'stream').mockImplementation(() => {
      throw new Error('unexpected internal failure');
    });
    const thread = await tree.createThread({});

    await runTurn(makeEnv(), thread.id, { text: 'hello' }).done;

    const errorEvent = events.find((event) => event.type === 'error');
    expect(errorEvent).toMatchObject({
      type: 'error',
      threadId: thread.id,
      code: 'internal',
      message: 'unexpected internal failure',
      retryable: false,
    });
    expect(errorEvent).not.toHaveProperty('providerDetails');
  });

  it.each<[ProviderErrorKind, boolean]>([
    ['network', true],
    ['rate_limit', true],
    ['overloaded', true],
    ['auth', false],
    ['context_too_long', false],
    ['content_filter', false],
  ])('emits ProviderError %s with retryable=%s', async (kind, retryable) => {
    vi.spyOn(provider, 'stream').mockImplementation(() => {
      throw new ProviderError(kind, `${kind} failure`);
    });
    const thread = await tree.createThread({});

    await runTurn(makeEnv(), thread.id, { text: 'hello' }).done;

    expect(events).toContainEqual(
      expect.objectContaining({ type: 'error', errorKind: kind, retryable }),
    );
  });

  it('runs a text-only turn and preserves the provider end reason', async () => {
    const thread = await tree.createThread({});
    provider.queue({ streamText: ['Hello', ' world'] });

    const handle = runTurn(makeEnv(), thread.id, { text: 'hi' });
    const stop = await handle.done;

    expect(stop).toBe('end');
    // No engine-side user echo: the optimistic client echo is the single
    // visible rendering of the user message (double-display regression).
    expect(eventTypes()).toEqual([
      'turn.start',
      'item.start',
      'item.delta',
      'item.delta',
      'item.complete',
      'token.usage',
      'turn.complete',
    ]);
    const firstItem = events.find((e) => e.type === 'item.start') as { kind: string };
    expect(firstItem.kind).toBe('assistant_message');

    const meta = await tree.getThread(thread.id);
    const ctx = await buildSessionContext(tree, thread.id, meta!.leafId!);
    expect(ctx.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    const complete = events.find((event) => event.type === 'turn.complete');
    expect(complete).toMatchObject({ type: 'turn.complete', stopReason: 'end' });
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: 'turn.complete', stopReason: 'done' }),
    );
    const path = await tree.getPath(thread.id, meta!.leafId!);
    expect(path.find((node) => node.type === 'assistant_message')?.payload).toMatchObject({
      providerStopReason: 'end',
    });
  });

  it.each(['max_tokens', 'content_filter'] as const)(
    'preserves provider %s across persistence, run state, and turn completion',
    async (providerStopReason) => {
      const thread = await tree.createThread({});
      const setRunState = vi.fn(async () => undefined);
      provider.queue({ streamText: ['partial response'], stopReason: providerStopReason });

      const stop = await runTurn(makeEnv({ setRunState }), thread.id, { text: 'hi' }).done;

      expect(stop).toBe(providerStopReason);
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'turn.complete', stopReason: providerStopReason }),
      );
      expect(events).not.toContainEqual(
        expect.objectContaining({ type: 'turn.complete', stopReason: 'done' }),
      );
      expect(setRunState).toHaveBeenLastCalledWith('completed', {
        stopReason: providerStopReason,
      });
      const meta = await tree.getThread(thread.id);
      const path = await tree.getPath(thread.id, meta!.leafId!);
      expect(path.find((node) => node.type === 'assistant_message')?.payload).toMatchObject({
        providerStopReason,
      });
    },
  );

  it('fails closed when tool_use has no tool call to continue', async () => {
    const thread = await tree.createThread({});
    provider.queue({ stopReason: 'tool_use', toolCalls: [] });

    const stop = await runTurn(makeEnv(), thread.id, { text: 'go' }).done;

    expect(stop).toBe('error');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'error',
        errorKind: 'protocol',
        retryable: false,
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: 'turn.complete', stopReason: 'tool_use' }),
    );
  });

  it('loops through tool calls until the model stops calling tools', async () => {
    tools.register(makeEchoTool());
    const thread = await tree.createThread({});
    provider.queue(
      { toolCalls: [{ id: 'c1', name: 'echo', params: { text: 'one' } }] },
      { toolCalls: [{ id: 'c2', name: 'echo', params: { text: 'two' } }] },
      { streamText: ['done'] },
    );

    const stop = await runTurn(makeEnv(), thread.id, { text: 'go' }).done;
    expect(stop).toBe('end');
    expect(provider.requests).toHaveLength(3);
    const meta = await tree.getThread(thread.id);
    const path = await tree.getPath(thread.id, meta!.leafId!);
    expect(
      path
        .filter((node) => node.type === 'assistant_message')
        .map((node) => (node.payload as { providerStopReason?: string }).providerStopReason),
    ).toEqual(['tool_use', 'tool_use', 'end']);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'turn.complete', stopReason: 'end' }),
    );

    // Second request must contain the first tool result.
    const secondReq = provider.requests[1]!;
    const resultMsg = secondReq.messages.find((m) => m.role === 'tool_result');
    expect(resultMsg).toBeDefined();
    expect((resultMsg!.content[0] as { text: string }).text).toBe('echo: one');
  });

  it('feeds tool errors back to the model for self-correction instead of crashing', async () => {
    tools.register(
      makeEchoTool({
        execute: async () => {
          throw new Error('element not found');
        },
      }),
    );
    const thread = await tree.createThread({});
    provider.queue(
      { toolCalls: [{ id: 'c1', name: 'echo', params: { text: 'x' } }] },
      { streamText: ['recovered'] },
    );

    const stop = await runTurn(makeEnv(), thread.id, { text: 'go' }).done;
    expect(stop).toBe('end');
    const secondReq = provider.requests[1]!;
    const resultMsg = secondReq.messages.find((m) => m.role === 'tool_result')!;
    expect(resultMsg).toMatchObject({ isError: true });
    expect((resultMsg.content[0] as { text: string }).text).toMatch(/element not found/);
  });

  it('circuit breaker: 3 consecutive failures inject a reminder, 5 stop the turn', async () => {
    tools.register(
      makeEchoTool({
        execute: async () => {
          throw new Error('element not found');
        },
      }),
    );
    const thread = await tree.createThread({});
    // Each model round returns one failing tool call; round 4 carries the
    // failure reminder and a tool-free final round explains the stop.
    for (let i = 0; i < 5; i++) {
      provider.queue({ toolCalls: [{ id: `c${i}`, name: 'echo', params: { text: 'x' } }] });
    }
    provider.queue({ streamText: ['Could not complete because the element stayed unavailable.'] });

    const stop = await runTurn(makeEnv(), thread.id, { text: 'go' }).done;
    expect(stop).toBe('error');

    // The reminder appears exactly once, in the request AFTER the 3rd failure.
    const reminderRounds = provider.requests
      .map((req, i) => ({
        i,
        hit: req.messages.some(
          (m) =>
            m.role === 'user' &&
            m.content.some((c) => c.type === 'text' && c.text.includes('ALL failed')),
        ),
      }))
      .filter((r) => r.hit);
    expect(reminderRounds).toHaveLength(1);
    expect(reminderRounds[0]!.i).toBe(3);
    expect(provider.requests).toHaveLength(6);
    expect(provider.requests[5]!.tools).toEqual([]);

    // A system notice recorded the stop for the user.
    const meta = await tree.getThread(thread.id);
    const ctx = await buildSessionContext(tree, thread.id, meta!.leafId!);
    const notice = ctx.path.find((n) => n.type === 'system_notice');
    expect(notice).toBeDefined();
    expect((notice!.payload as { text: string }).text).toMatch(/连续 5 次/);
    expect(ctx.messages.at(-1)?.content[0]).toMatchObject({
      type: 'text',
      text: 'Could not complete because the element stayed unavailable.',
    });
  });

  it('user declines do NOT count toward the circuit breaker (deliberate no ≠ broken tool)', async () => {
    // A write tool that always ASKs; the user declines every time.
    tools.register(makeEchoTool({ effects: 'write' }));
    const askGate: GatekeeperCheck = {
      check: async () => ({
        verdict: 'ask',
        request: { tool: 'echo', label: 'echo', params: {}, targetOrigin: '', flags: [] },
      }),
    };
    const thread = await tree.createThread({});
    // 6 declined rounds + a final text round: if declines counted, the turn
    // would have stopped at 5; it must instead run to completion.
    for (let i = 0; i < 6; i++) {
      provider.queue({ toolCalls: [{ id: `c${i}`, name: 'echo', params: { text: 'x' } }] });
    }
    provider.queue({ streamText: ['ok, stopping'] });

    const stop = await runTurn(
      makeEnv({ gatekeeper: askGate, requestApproval: async () => ({ kind: 'decline' }) }),
      thread.id,
      { text: 'go' },
    ).done;
    expect(stop).toBe('end');
    // No auto-stop notice was written.
    const meta = await tree.getThread(thread.id);
    const ctx = await buildSessionContext(tree, thread.id, meta!.leafId!);
    expect(
      ctx.path.some(
        (n) => n.type === 'system_notice' && /连续 5 次/.test((n.payload as { text: string }).text),
      ),
    ).toBe(false);
  });

  it('a success between failures resets the circuit breaker', async () => {
    let calls = 0;
    tools.register(
      makeEchoTool({
        execute: async (_id, p: { text: string }) => {
          calls++;
          if (calls === 3) return { content: [{ type: 'text', text: `echo: ${p.text}` }] };
          throw new Error('flaky');
        },
      }),
    );
    const thread = await tree.createThread({});
    for (let i = 0; i < 4; i++) {
      provider.queue({ toolCalls: [{ id: `c${i}`, name: 'echo', params: { text: 'x' } }] });
    }
    provider.queue({ streamText: ['done'] });

    const stop = await runTurn(makeEnv(), thread.id, { text: 'go' }).done;
    // 2 fails, 1 success (reset), 1 fail → never hits 5; turn completes.
    expect(stop).toBe('end');
  });

  it('returns zod validation errors to the model (not thrown at user)', async () => {
    tools.register(makeEchoTool());
    const thread = await tree.createThread({});
    provider.queue(
      { toolCalls: [{ id: 'c1', name: 'echo', params: { wrong: 1 } }] },
      { streamText: ['fixed'] },
    );

    await runTurn(makeEnv(), thread.id, { text: 'go' }).done;
    const resultMsg = provider.requests[1]!.messages.find((m) => m.role === 'tool_result')!;
    expect((resultMsg.content[0] as { text: string }).text).toMatch(/Invalid parameters/);
  });

  it('handles unknown tools and JSON parse errors gracefully', async () => {
    const thread = await tree.createThread({});
    provider.queue(
      {
        toolCalls: [
          { id: 'c1', name: 'nonexistent', params: {} },
          {
            id: 'c2',
            name: 'echo',
            params: '{broken',
            parseError: 'tool call arguments were not valid JSON',
          },
        ],
      },
      { streamText: ['ok'] },
    );

    const stop = await runTurn(makeEnv(), thread.id, { text: 'go' }).done;
    expect(stop).toBe('end');
    const results = provider.requests[1]!.messages.filter((m) => m.role === 'tool_result');
    expect(results).toHaveLength(2);
    expect((results[0]!.content[0] as { text: string }).text).toMatch(/Unknown tool/);
    expect((results[1]!.content[0] as { text: string }).text).toMatch(/not valid JSON/);
  });
});

describe('gatekeeper integration', () => {
  it('rechecks Gatekeeper before an automatic trusted-input escalation', async () => {
    const trusted = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'trusted' }] }));
    tools.register({
      name: 'type',
      label: 'Type',
      description: 'type',
      parameters: z.object({ element: z.string(), ref: z.string(), text: z.string() }),
      level: 'L1',
      effects: 'write',
      execute: async () => {
        throw actionError('l1_not_effective', 'ignored', 'verify', true, {
          escalationTool: 'type_trusted',
        });
      },
    });
    tools.register({
      name: 'type_trusted',
      label: 'Trusted type',
      description: 'trusted type',
      parameters: z.object({ element: z.string(), ref: z.string(), text: z.string() }),
      level: 'L2',
      effects: 'write',
      execute: trusted,
    });
    const checked: string[] = [];
    const gatekeeper: GatekeeperCheck = {
      check: async (call) => {
        checked.push(call.toolName);
        return call.toolName === 'type_trusted'
          ? {
              verdict: 'ask',
              request: {
                tool: call.toolName,
                label: 'Trusted type',
                params: call.params,
                targetOrigin: 'https://example.com',
                flags: ['escalation_l2'],
              },
            }
          : { verdict: 'allow' };
      },
    };
    const approvals: string[] = [];
    const thread = await tree.createThread({});
    provider.queue(
      {
        toolCalls: [
          {
            id: 'c1',
            name: 'type',
            params: { element: 'Name', ref: 's1_1', text: 'Ada' },
          },
        ],
      },
      { streamText: ['done'] },
    );

    await runTurn(
      makeEnv({
        gatekeeper,
        requestApproval: async (_turnId, request) => {
          approvals.push(request.tool);
          return { kind: 'accept' };
        },
      }),
      thread.id,
      { text: 'fill the form' },
    ).done;

    expect(checked).toEqual(['type', 'type_trusted']);
    expect(approvals).toEqual(['type_trusted']);
    expect(trusted).toHaveBeenCalledOnce();
    const result = provider.requests[1]!.messages.find((message) => message.role === 'tool_result');
    expect((result?.content[0] as { text?: string }).text).toContain('trusted');
  });

  it('deny → tool_result explains the denial, loop continues', async () => {
    tools.register(makeEchoTool({ effects: 'write' }));
    const gatekeeper: GatekeeperCheck = {
      check: async () => ({ verdict: 'deny', reason: 'blocked origin' }),
    };
    const thread = await tree.createThread({});
    provider.queue(
      { toolCalls: [{ id: 'c1', name: 'echo', params: { text: 'x' } }] },
      { streamText: ['adapted'] },
    );

    const stop = await runTurn(makeEnv({ gatekeeper }), thread.id, { text: 'go' }).done;
    expect(stop).toBe('end');
    const resultMsg = provider.requests[1]!.messages.find((m) => m.role === 'tool_result')!;
    expect((resultMsg.content[0] as { text: string }).text).toMatch(
      /denied by policy: blocked origin/,
    );
  });

  it('executes an approved tool after the approval callback persists its decision', async () => {
    const executed = vi.fn();
    let decisionWasPersistedBeforeExecution = false;
    tools.register(
      makeEchoTool({
        effects: 'write',
        execute: async (_id, params) => {
          const approvalNodes = await db.nodes
            .where('threadId')
            .equals(thread.id)
            .filter((node) => node.type === 'approval_decision')
            .toArray();
          decisionWasPersistedBeforeExecution = approvalNodes.length === 1;
          executed(params);
          return { content: [{ type: 'text', text: 'done' }] };
        },
      }),
    );
    const gatekeeper: GatekeeperCheck = {
      check: async () => ({
        verdict: 'ask',
        request: {
          tool: 'echo',
          label: 'Echo',
          params: { text: 'x' },
          targetOrigin: 'https://x.com',
          flags: [],
        },
      }),
    };
    const thread = await tree.createThread({});
    provider.queue(
      { toolCalls: [{ id: 'c1', name: 'echo', params: { text: 'x' } }] },
      { streamText: ['finished'] },
    );

    await runTurn(
      makeEnv({
        gatekeeper,
        requestApproval: async (_turnId, request) => {
          const decision: ApprovalDecision = { kind: 'accept' };
          const decidedAt = Date.now();
          await tree.appendNode(thread.id, {
            type: 'approval_decision',
            ts: decidedAt,
            payload: {
              approvalId: 'approval-c1',
              request,
              decision,
              decidedAt,
            },
          });
          return decision;
        },
      }),
      thread.id,
      { text: 'go' },
    ).done;
    expect(executed).toHaveBeenCalledWith({ text: 'x' });
    expect(decisionWasPersistedBeforeExecution).toBe(true);

    const meta = await tree.getThread(thread.id);
    const ctx = await buildSessionContext(tree, thread.id, meta!.leafId!);
    const approvalNodes = ctx.path.filter((node) => node.type === 'approval_decision');
    expect(approvalNodes).toHaveLength(1);
    expect(approvalNodes[0]?.payload).toMatchObject({
      request: { tool: 'echo', params: { text: 'x' } },
      decision: { kind: 'accept' },
    });
  });

  it('ask → declined with note → note reaches the model, tool NOT executed', async () => {
    const executed = vi.fn();
    tools.register(
      makeEchoTool({
        effects: 'write',
        execute: async () => {
          executed();
          return { content: [] };
        },
      }),
    );
    const gatekeeper: GatekeeperCheck = {
      check: async () => ({
        verdict: 'ask',
        request: {
          tool: 'echo',
          label: 'Echo',
          params: {},
          targetOrigin: 'https://x.com',
          flags: [],
        },
      }),
    };
    const decline: ApprovalDecision = { kind: 'decline', note: '换个方式' };
    const thread = await tree.createThread({});
    provider.queue(
      { toolCalls: [{ id: 'c1', name: 'echo', params: { text: 'x' } }] },
      { streamText: ['ok I will adapt'] },
    );

    await runTurn(makeEnv({ gatekeeper, requestApproval: async () => decline }), thread.id, {
      text: 'go',
    }).done;
    expect(executed).not.toHaveBeenCalled();
    const resultMsg = provider.requests[1]!.messages.find((m) => m.role === 'tool_result')!;
    expect((resultMsg.content[0] as { text: string }).text).toMatch(/declined.*换个方式/s);
  });

  it('cancel → declines and interrupts the turn', async () => {
    tools.register(makeEchoTool({ effects: 'write' }));
    const gatekeeper: GatekeeperCheck = {
      check: async () => ({
        verdict: 'ask',
        request: {
          tool: 'echo',
          label: 'Echo',
          params: {},
          targetOrigin: 'https://x.com',
          flags: [],
        },
      }),
    };
    const thread = await tree.createThread({});
    provider.queue({ toolCalls: [{ id: 'c1', name: 'echo', params: { text: 'x' } }] });

    const stop = await runTurn(
      makeEnv({ gatekeeper, requestApproval: async () => ({ kind: 'cancel' }) }),
      thread.id,
      { text: 'go' },
    ).done;
    expect(stop).toBe('interrupted');
  });
});

describe('steering & interrupt (docs/04 §3)', () => {
  it('steer input is appended after the current LLM call and enters the next request', async () => {
    tools.register(makeEchoTool());
    const thread = await tree.createThread({});
    provider.queue(
      { toolCalls: [{ id: 'c1', name: 'echo', params: { text: 'step1' } }] },
      { streamText: ['done'] },
    );

    const handle = runTurn(makeEnv(), thread.id, { text: 'go' });
    await handle.steer({ text: 'also check prices' });
    await handle.done;

    const secondReq = provider.requests[1]!;
    const userTexts = secondReq.messages
      .filter((m) => m.role === 'user')
      .flatMap((m) => m.content.map((c) => (c.type === 'text' ? c.text : '')));
    expect(userTexts).toContain('also check prices');
  });

  it('materializes durable pending steer ids on the first request after resume', async () => {
    const thread = await tree.createThread({});
    await tree.appendNode(thread.id, {
      type: 'user_message',
      payload: { content: [{ type: 'text', text: 'original request' }] },
    });
    provider.queue({ streamText: ['resumed'] });

    await runTurn(
      makeEnv({
        initialPendingSteers: [{ nodeId: 'durable-steer', admissionSequence: 0 }],
        materializeSteers: async (nodeIds) => {
          expect(nodeIds).toEqual(['durable-steer']);
          await tree.appendNode(thread.id, {
            id: nodeIds[0],
            type: 'user_message',
            payload: {
              content: [{ type: 'text', text: 'survived restart' }],
              steered: true,
            },
          });
        },
      }),
      thread.id,
      { text: 'unused resumed input' },
      'user',
      { resumeExisting: true },
    ).done;

    expect(JSON.stringify(provider.requests[0]!.messages)).toContain('survived restart');
    const path = await tree.getPath(thread.id, (await tree.getThread(thread.id))!.leafId!);
    expect(path.map((node) => node.type)).toEqual([
      'user_message',
      'user_message',
      'assistant_message',
    ]);
  });

  it('restores durable pending steers by admission sequence after inverse persistence', async () => {
    const thread = await tree.createThread({});
    await tree.appendNode(thread.id, {
      type: 'user_message',
      payload: { content: [{ type: 'text', text: 'original request' }] },
    });
    provider.queue({ streamText: ['resumed'] });

    await runTurn(
      makeEnv({
        initialPendingSteers: [
          { nodeId: 'restart-b', admissionSequence: 1 },
          { nodeId: 'restart-a', admissionSequence: 0 },
        ],
        materializeSteers: async (nodeIds) => {
          for (const nodeId of nodeIds) {
            await tree.appendNode(thread.id, {
              id: nodeId,
              type: 'user_message',
              payload: {
                content: [
                  { type: 'text', text: nodeId === 'restart-a' ? 'restart A' : 'restart B' },
                ],
                steered: true,
              },
            });
          }
        },
      }),
      thread.id,
      { text: 'unused resumed input' },
      'user',
      { resumeExisting: true },
    ).done;

    const restoredTexts = provider.requests[0]!.messages.filter(
      (message) => message.role === 'user',
    )
      .flatMap((message) =>
        message.content.map((block) => (block.type === 'text' ? block.text : '')),
      )
      .filter((text) => text.startsWith('restart '));
    expect(restoredTexts).toEqual(['restart A', 'restart B']);
  });

  it('interrupt aborts promptly with stopReason interrupted', async () => {
    tools.register(
      makeEchoTool({
        execute: (_id, _params, signal) =>
          new Promise((_, reject) => {
            signal.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          }),
      }),
    );
    const thread = await tree.createThread({});
    provider.queue({ toolCalls: [{ id: 'c1', name: 'echo', params: { text: 'x' } }] });

    const handle = runTurn(makeEnv(), thread.id, { text: 'go' });
    // Let the loop reach the tool, then interrupt.
    await new Promise((r) => setTimeout(r, 10));
    handle.interrupt();
    const stop = await handle.done;
    expect(stop).toBe('interrupted');
    const turnComplete = events.find((e) => e.type === 'turn.complete');
    expect(turnComplete).toMatchObject({ stopReason: 'interrupted' });
  });

  it('non-user turns are not steerable', async () => {
    const thread = await tree.createThread({});
    provider.queue({ streamText: ['summary'] });
    const handle = runTurn(makeEnv(), thread.id, { text: 'title' }, 'title');
    expect(handle.steerable).toBe(false);
    expect(() => handle.steer({ text: 'x' })).toThrow(/not steerable/);
    await handle.done;
  });
});

describe('unbounded tool execution & token budget (docs/04 §1)', () => {
  it('does not cap tool calls by step count', async () => {
    tools.register(makeEchoTool());
    const thread = await tree.createThread({});
    provider.queue(
      {
        toolCalls: Array.from({ length: 65 }, (_, i) => ({
          id: `c${i}`,
          name: 'echo',
          params: { text: `${i}` },
        })),
      },
      { streamText: ['finished'] },
    );

    const stop = await runTurn(makeEnv(), thread.id, { text: 'go' }).done;
    expect(stop).toBe('end');
    const toolResults = provider.requests[1]!.messages.filter(
      (message) => message.role === 'tool_result',
    );
    expect(toolResults).toHaveLength(65);
    expect(
      provider.requests[1]!.messages.some((message) =>
        message.content.some(
          (block) => block.type === 'text' && /step|tool-call limit/i.test(block.text),
        ),
      ),
    ).toBe(false);
  });

  it('token budget pauses the turn (the only hard gate)', async () => {
    tools.register(makeEchoTool());
    const thread = await tree.createThread({});
    provider.queue(
      {
        toolCalls: [{ id: 'c1', name: 'echo', params: { text: 'x' } }],
        usage: { input: 900, output: 200 },
      },
      { streamText: ['never reached'] },
    );

    const stop = await runTurn(makeEnv({ tokenBudget: 1000 }), thread.id, { text: 'go' }).done;
    expect(stop).toBe('budget_pause');
    expect(provider.requests).toHaveLength(1); // no second call
  });
});

describe('recovery invariants (docs/04 §5.3)', () => {
  it('resumes from the persisted leaf without appending the user input twice', async () => {
    const thread = await tree.createThread({});
    provider.queue({ streamText: ['partial'] }, { streamText: ['continued'] });

    await runTurn(makeEnv(), thread.id, { text: 'run once' }).done;
    await runTurn(makeEnv({ turnId: 'persisted-turn' }), thread.id, { text: 'run once' }, 'user', {
      resumeExisting: true,
      initialStepCursor: 1,
    }).done;

    const nodes = await db.nodes.where('threadId').equals(thread.id).toArray();
    expect(nodes.filter((node) => node.type === 'turn_context')).toHaveLength(1);
    expect(nodes.filter((node) => node.type === 'user_message')).toHaveLength(1);
    expect(nodes.filter((node) => node.type === 'assistant_message')).toHaveLength(2);
  });

  it('every completed item is persisted before turn.complete (checkpoint replay)', async () => {
    tools.register(makeEchoTool());
    const thread = await tree.createThread({});
    provider.queue(
      { toolCalls: [{ id: 'c1', name: 'echo', params: { text: 'x' } }] },
      { streamText: ['final answer'] },
    );

    await runTurn(makeEnv(), thread.id, { text: 'go' }).done;

    // Replay from DB: full history is reconstructible.
    const meta = await tree.getThread(thread.id);
    const ctx = await buildSessionContext(tree, thread.id, meta!.leafId!);
    expect(ctx.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool_result',
      'assistant',
    ]);
    expect(ctx.turnContext).not.toBeNull();
  });
});
