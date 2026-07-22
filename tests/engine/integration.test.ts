/**
 * Full-stack engine regression: DirectTransport → EngineHost → RealEngineCore
 * → mock provider → Dexie. No browser required (docs/development/agent-engine.md §7).
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { PanelotDB } from '../../src/db/schema';
import { ThreadTree } from '../../src/db/tree';
import {
  RealEngineCore,
  type EngineCoreOptions,
  type ProviderResolver,
} from '../../src/engine/core';
import { RunRepository } from '../../src/engine/runRepository';
import { ApprovalRepository } from '../../src/engine/approvalRepository';
import { InteractionRepository } from '../../src/engine/interactionRepository';
import { EngineHost } from '../../src/engine/host';
import { createDirectPair } from '../../src/messaging/transport';
import { ToolRegistry } from '../../src/agent/tool';
import type { GatekeeperCheck } from '../../src/agent/loop';
import { ENGINE_PROTOCOL, ENGINE_SCHEMA_HASH } from '../../src/messaging/protocol';
import type { AgentEvent, Op, ThreadSnapshot, TurnOverrides } from '../../src/messaging/protocol';
import {
  ProviderError,
  type FinalResult,
  type ProviderAdapter,
  type ProviderStream,
  type StreamEvent,
  type StreamRequest,
} from '../../src/providers/types';
import { OpenAiAdapter } from '../../src/providers/openai';
import { actionError } from '../../src/tools/action/errors';
import {
  captureToolCatalog,
  createRunEnvironmentSnapshot,
} from '../../src/engine/runEnvironmentSnapshot';
import type { ResolvedRunEnvironment } from '../../src/db/types';

// ---------------------------------------------------------------------------

/** Omit that distributes over union members (plain Omit collapses the union). */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

type Scripted = Partial<FinalResult> & {
  streamText?: string[];
  onStreamStart?: () => void;
  release?: Promise<void>;
  streamError?: Error;
  waitForAbort?: boolean;
};

class MockProvider implements ProviderAdapter {
  requests: StreamRequest[] = [];
  private script: Scripted[] = [];
  private i = 0;
  queue(...r: Scripted[]) {
    this.script.push(...r);
  }
  stream(req: StreamRequest): ProviderStream {
    this.requests.push(req);
    const s = this.script[this.i++] ?? {};
    const events: StreamEvent[] = (s.streamText ?? []).map((t) => ({ type: 'text', delta: t }));
    const final: FinalResult = {
      message: s.message ?? [{ type: 'text', text: (s.streamText ?? []).join('') }],
      toolCalls: s.toolCalls ?? [],
      usage: s.usage ?? { input: 50, output: 10 },
      stopReason: s.stopReason ?? ((s.toolCalls?.length ?? 0) > 0 ? 'tool_use' : 'end'),
    };
    async function* gen() {
      s.onStreamStart?.();
      await s.release;
      if (s.waitForAbort) {
        await new Promise<void>((_resolve, reject) => {
          req.signal.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        });
      }
      if (s.streamError) throw s.streamError;
      for (const ev of events) yield ev;
    }
    const it = gen();
    return {
      [Symbol.asyncIterator]: () => it,
      final: async () => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _ of it) {
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

class TestClient {
  events: AgentEvent[] = [];
  private waiters: { predicate: (ev: AgentEvent) => boolean; resolve: (ev: AgentEvent) => void }[] =
    [];
  constructor(private send: (op: Op) => void) {}

  receive(ev: AgentEvent): void {
    this.events.push(ev);
    this.waiters = this.waiters.filter((w) => {
      if (w.predicate(ev)) {
        w.resolve(ev);
        return false;
      }
      return true;
    });
  }

  post(op: DistributiveOmit<Op, 'submissionId'> & { submissionId?: string }): string {
    const submissionId = op.submissionId ?? crypto.randomUUID();
    this.send({
      ...op,
      submissionId,
      ...(op.type === 'initialize'
        ? {
            protocol: ENGINE_PROTOCOL,
            schemaHash: ENGINE_SCHEMA_HASH,
            clientId: 'integration-client',
          }
        : {}),
    } as Op);
    return submissionId;
  }

  waitFor<T extends AgentEvent['type']>(
    type: T,
    timeoutMs = 3000,
  ): Promise<Extract<AgentEvent, { type: T }>> {
    const existing = this.events.find((e) => e.type === type);
    if (existing) return Promise.resolve(existing as Extract<AgentEvent, { type: T }>);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `timeout waiting for ${type}; got: ${this.events.map((e) => e.type).join(',')}`,
            ),
          ),
        timeoutMs,
      );
      this.waiters.push({
        predicate: (ev) => ev.type === type,
        resolve: (ev) => {
          clearTimeout(timer);
          resolve(ev as Extract<AgentEvent, { type: T }>);
        },
      });
    });
  }

  waitForMatching<T extends AgentEvent>(
    predicate: (event: AgentEvent) => event is T,
    timeoutMs = 3000,
  ): Promise<T> {
    const existing = this.events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `timeout waiting for matching event; got: ${this.events
                .map((event) =>
                  'submissionId' in event
                    ? `${event.type}:${event.submissionId ?? ''}`
                    : event.type,
                )
                .join(',')}`,
            ),
          ),
        timeoutMs,
      );
      this.waiters.push({
        predicate,
        resolve: (event) => {
          clearTimeout(timer);
          resolve(event as T);
        },
      });
    });
  }
}

// ---------------------------------------------------------------------------

let db: PanelotDB;
let provider: MockProvider;
let tools: ToolRegistry;
let n = 0;

const allowAll: GatekeeperCheck = { check: async () => ({ verdict: 'allow' }) };

function registerBlockingTool(name: string) {
  let toolStarted: () => void;
  let releaseTool: () => void;
  const entered = new Promise<void>((resolve) => (toolStarted = resolve));
  const gate = new Promise<void>((resolve) => (releaseTool = resolve));
  tools.register({
    name,
    label: name,
    description: 'blocks for deterministic steering assertions',
    parameters: z.object({}),
    level: 'builtin',
    effects: 'read',
    execute: async () => {
      toolStarted!();
      await gate;
      return { content: [{ type: 'text', text: 'released' }] };
    },
  });
  return { entered, release: () => releaseTool!() };
}

function buildEngine(
  dbInstance?: PanelotDB,
  resolverOverride?: ProviderResolver,
  gatekeeperOverride?: GatekeeperCheck,
  options: EngineCoreOptions = {},
) {
  db = dbInstance ?? new PanelotDB(`int-test-${Date.now()}-${n++}`);
  provider = provider ?? new MockProvider();
  tools = new ToolRegistry();
  const resolver: ProviderResolver = {
    resolve: async () => ({ provider, model: 'mock', params: {} }),
  };
  const core = new RealEngineCore(
    db,
    tools,
    gatekeeperOverride ?? allowAll,
    resolverOverride ?? resolver,
    undefined,
    options,
  );
  const host = new EngineHost(core);
  core.onBroadcast = (ev) => host.broadcast(ev);
  return { core, host };
}

function connect(host: EngineHost): TestClient {
  const { transport, connection } = createDirectPair();
  host.onConnection(connection);
  const client = new TestClient((op) => transport.send(op));
  transport.onEvent((ev) => client.receive(ev));
  return client;
}

beforeEach(() => {
  provider = new MockProvider();
});

async function waitForEvent(events: AgentEvent[], type: AgentEvent['type']): Promise<void> {
  const started = Date.now();
  while (!events.some((event) => event.type === type)) {
    if (Date.now() - started > 3_000) throw new Error(`timeout waiting for ${type}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function testRunEnvironment(
  input: { text: string },
  registry: ToolRegistry,
  patch: Partial<ResolvedRunEnvironment> = {},
) {
  const environment: ResolvedRunEnvironment = {
    connectionId: 'connection',
    modelId: 'mock',
    modelParameters: {},
    enabledToolLevels: ['L0', 'L1', 'L2', 'mcp'],
    permissionPolicy: 'untrusted',
    activeSkills: [],
    promptVersion: 'kernel',
    ...patch,
  };
  return createRunEnvironmentSnapshot({
    environment,
    normalizedInput: input,
    providerBinding: { kind: 'resolver', connectionId: environment.connectionId, credentials: [] },
    systemPrompt: 'test system prompt',
    skillCatalog: [],
    toolCatalog: await captureToolCatalog(registry, environment.enabledToolLevels),
  });
}

async function initThread(client: TestClient): Promise<string> {
  client.post({ type: 'initialize', protocolVersion: 1 });
  await client.waitFor('initialized');
  client.post({ type: 'thread.create' });
  const created = await client.waitFor('thread.created');
  // Pre-title the thread so the once-only title job doesn't consume scripted
  // mock responses mid-test.
  await db.threads.update(created.threadId, { title: 'test-thread' });
  // Subscribe so thread-scoped broadcasts reach this client.
  client.post({ type: 'thread.subscribe', threadId: created.threadId });
  await new Promise<void>((resolve) => {
    const check = () =>
      client.events.filter((e) => e.type === 'initialized').length >= 2
        ? resolve()
        : setTimeout(check, 5);
    check();
  });
  return created.threadId;
}

async function seedPreparedToolRun(
  targetDb: PanelotDB,
  registry: ToolRegistry,
  toolName: string,
  effect: 'read' | 'write',
  recovery: 'retry-safe' | 'inspect-first' | 'never-retry',
) {
  const tree = new ThreadTree(targetDb);
  const thread = await tree.createThread({ title: 'recovery deadline' });
  await tree.appendNode(thread.id, {
    type: 'turn_context',
    payload: {
      turnId: `turn-${toolName}`,
      model: { connectionId: 'connection', modelId: 'mock' },
      permissionPolicy: 'untrusted',
      activeSkills: [],
    },
  });
  await tree.appendNode(thread.id, {
    type: 'user_message',
    payload: { content: [{ type: 'text', text: 'recover the tool' }] },
  });
  await tree.appendNode(thread.id, {
    type: 'tool_call',
    payload: { itemId: `call-${toolName}`, toolName, params: {}, level: 'builtin' },
  });
  const runs = new RunRepository(targetDb);
  const run = await runs.enqueue({
    threadId: thread.id,
    clientId: 'recovery-client',
    submissionId: `recover-${toolName}`,
    input: { text: 'recover the tool' },
  });
  await runs.prepare(run.id, await testRunEnvironment(run.input, registry));
  await runs.transition(run.id, 'executing_tool', {
    pendingTool: {
      itemId: `call-${toolName}`,
      toolName,
      params: {},
      effect,
      recovery,
    },
  });
  return { run, thread };
}

async function seedRecoveredApproval(targetDb: PanelotDB, registry: ToolRegistry) {
  const tree = new ThreadTree(targetDb);
  const thread = await tree.createThread({ title: 'recovered approval owner' });
  await tree.appendNode(thread.id, {
    type: 'turn_context',
    payload: {
      turnId: 'turn-recovered-approval',
      model: { connectionId: 'connection', modelId: 'mock' },
      permissionPolicy: 'untrusted',
      activeSkills: [],
    },
  });
  await tree.appendNode(thread.id, {
    type: 'user_message',
    payload: { content: [{ type: 'text', text: 'approve the recovered action' }] },
  });
  const toolCallNode = await tree.appendNode(thread.id, {
    type: 'tool_call',
    payload: {
      itemId: 'recovered-approval-call',
      toolName: 'recovered_approval_write',
      params: {},
      level: 'L1',
    },
  });
  const runs = new RunRepository(targetDb);
  const run = await runs.enqueue({
    threadId: thread.id,
    clientId: 'recovery-client',
    submissionId: 'recovered-approval-run',
    input: { text: 'approve the recovered action' },
  });
  await runs.prepare(run.id, await testRunEnvironment(run.input, registry));
  const approvals = new ApprovalRepository(targetDb);
  const { approval } = await approvals.createPendingWork({
    id: 'recovered-approval',
    threadId: thread.id,
    runId: run.id,
    turnId: run.turnId,
    request: {
      tool: 'recovered_approval_write',
      label: 'Recovered approval write',
      params: {},
      targetOrigin: 'https://example.test',
      flags: [],
    },
    pendingTool: {
      itemId: 'recovered-approval-call',
      toolName: 'recovered_approval_write',
      params: {},
      effect: 'write',
      recovery: 'never-retry',
    },
    toolCallNode,
    deadlineAt: Date.now() + 300_000,
  });
  return { approval, run, thread, toolCallNode };
}

// ---------------------------------------------------------------------------

describe('engine integration (Op → events → DB)', () => {
  it('routes provider diagnostics only to the client subscribed to the failed thread', async () => {
    const { host } = buildEngine();
    const clientA = connect(host);
    const clientB = connect(host);
    const threadA = await initThread(clientA);
    const threadB = await initThread(clientB);
    expect(threadB).not.toBe(threadA);
    const details = {
      status: 404,
      reason: 'model_not_found' as const,
      upstreamCode: 'model_not_found',
      upstreamMessage: 'Model Not Exist',
      raw: '{"error":"Model Not Exist"}',
    };
    provider.queue({
      streamError: new ProviderError('protocol', 'unexpected HTTP 404', undefined, details),
    });

    clientA.post({ type: 'turn.submit', threadId: threadA, input: { text: 'fail here' } });
    const errorA = await clientA.waitForMatching(
      (event): event is Extract<AgentEvent, { type: 'error' }> =>
        event.type === 'error' && event.code === 'provider_error',
    );
    await clientA.waitFor('turn.complete');

    expect(errorA).toMatchObject({
      threadId: threadA,
      errorKind: 'protocol',
      providerDetails: details,
    });
    expect(
      clientB.events.some((event) => event.type === 'error' && event.code === 'provider_error'),
    ).toBe(false);
  });

  it('turn.submit streams deltas and completes; snapshot reflects the conversation', async () => {
    const { core, host } = buildEngine();
    const client = connect(host);
    const threadId = await initThread(client);

    provider.queue({ streamText: ['He', 'llo!'] });
    client.post({ type: 'turn.submit', threadId, input: { text: 'hi' } });
    await client.waitFor('turn.complete');

    // Deltas were coalesced (16ms window) but content is intact. The user
    // message renders via the client-side optimistic echo — the engine emits
    // no user item (that echoed the message twice).
    const starts = client.events.filter((e) => e.type === 'item.start') as {
      itemId: string;
      kind: string;
    }[];
    expect(starts.map((s) => s.kind)).toEqual(['assistant_message']);
    const deltas = client.events.filter((e) => e.type === 'item.delta');
    const text = deltas.map((d) => (d as { delta: { text?: string } }).delta.text ?? '').join('');
    expect(text).toBe('Hello!');

    const snapshot = await core.getSnapshot(threadId);
    expect(snapshot!.items.map((i) => i.kind)).toEqual(['user_message', 'assistant_message']);
    expect(snapshot!.activeTurn).toBeNull();
  });

  it('does not expose tools when the selected model explicitly disables tool use', async () => {
    const resolver: ProviderResolver = {
      resolve: async () => ({
        provider,
        model: 'chat-only',
        params: {},
        connectionId: 'connection',
        modelCapabilities: { toolUse: false, vision: false, reasoning: false },
      }),
    };
    const { host } = buildEngine(undefined, resolver);
    tools.register({
      name: 'echo',
      label: 'Echo',
      description: 'Echo text.',
      parameters: z.object({ text: z.string() }),
      level: 'builtin',
      effects: 'read',
      execute: async (_id, params) => ({
        content: [{ type: 'text', text: params.text }],
      }),
    });
    const client = connect(host);
    const threadId = await initThread(client);
    provider.queue({ streamText: ['plain reply'] });

    client.post({ type: 'turn.submit', threadId, input: { text: 'hi' } });
    await client.waitFor('turn.complete');

    expect(provider.requests[0]!.tools).toEqual([]);
    const run = await db.runs.where('threadId').equals(threadId).first();
    expect(
      run?.environment && 'toolCatalog' in run.environment
        ? run.environment.toolCatalog
        : undefined,
    ).toEqual([]);
  });

  it('omits the screenshot tool when the selected model disables vision', async () => {
    const resolver: ProviderResolver = {
      resolve: async () => ({
        provider,
        model: 'text-agent',
        params: {},
        connectionId: 'connection',
        modelCapabilities: { toolUse: true, vision: false },
      }),
    };
    const { host } = buildEngine(undefined, resolver);
    for (const name of ['echo', 'screenshot']) {
      tools.register({
        name,
        label: name,
        description: `${name} tool.`,
        parameters: z.object({}),
        level: name === 'screenshot' ? 'L2' : 'builtin',
        effects: 'read',
        execute: async () => ({ content: [{ type: 'text', text: name }] }),
      });
    }
    const client = connect(host);
    const threadId = await initThread(client);
    provider.queue({ streamText: ['plain reply'] });

    client.post({ type: 'turn.submit', threadId, input: { text: 'hi' } });
    await client.waitFor('turn.complete');

    expect(provider.requests[0]!.tools.map((tool) => tool.name)).toEqual(['echo']);
  });

  it('preserves a real adapter stop reason through the run, event, and snapshot', async () => {
    const adapter = new OpenAiAdapter({
      id: 'openai-connection',
      name: 'OpenAI test',
      kind: 'openai',
      baseUrl: 'https://api.test.com/v1',
      apiKeys: ['sk-test'],
      enabled: true,
    });
    const resolver: ProviderResolver = {
      resolve: async () => ({
        provider: adapter,
        model: 'test-model',
        params: {},
        connectionId: 'openai-connection',
      }),
    };
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          [
            'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
            'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
            'data: [DONE]\n\n',
          ].join(''),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
      );

    try {
      const { core, host } = buildEngine(undefined, resolver);
      const client = connect(host);
      const threadId = await initThread(client);

      client.post({ type: 'turn.submit', threadId, input: { text: 'continue' } });
      const complete = await client.waitFor('turn.complete');

      expect(complete.stopReason).toBe('max_tokens');
      expect(await db.runs.where('threadId').equals(threadId).first()).toMatchObject({
        state: 'completed',
        stopReason: 'max_tokens',
      });
      const snapshot = await core.getSnapshot(threadId);
      const assistant = snapshot!.items.find((item) => item.kind === 'assistant_message');
      expect(assistant?.payload).toMatchObject({
        content: [{ type: 'text', text: 'partial' }],
        providerStopReason: 'max_tokens',
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('persists the resolved run environment and terminal state', async () => {
    const resolver: ProviderResolver = {
      resolve: async () => ({
        provider,
        model: 'model-c',
        params: { temperature: 0.2 },
        connectionId: 'connection-b',
        presetId: 'preset-a',
        presetPrompt: 'Be precise.',
        enabledToolLevels: ['L0'],
        permissionPolicy: 'always',
        activeSkills: ['skill-a'],
        promptVersion: 'kernel-a',
      }),
    };
    const { core, host } = buildEngine(undefined, resolver);
    const permissionConfigs: unknown[] = [];
    core.onPermissionOverride = (_threadId, config) => permissionConfigs.push(config);
    const client = connect(host);
    const threadId = await initThread(client);
    const now = Date.now();
    await db.skills.add({
      id: 'skill-a',
      name: 'skill-a',
      raw: '---\nname: skill-a\ndescription: Test skill.\n---\nBe precise.',
      frontmatter: { name: 'skill-a', description: 'Test skill.' },
      body: 'Be precise.',
      enabled: true,
      source: 'user',
      createdAt: now,
      updatedAt: now,
    });

    provider.queue({ streamText: ['done'] });
    client.post({ type: 'turn.submit', threadId, input: { text: 'persist me' } });
    await client.waitFor('turn.complete');

    const run = await db.runs.where('threadId').equals(threadId).first();
    expect(run).toMatchObject({
      state: 'completed',
      input: { text: 'persist me' },
      environment: {
        connectionId: 'connection-b',
        modelId: 'model-c',
        modelParameters: { temperature: 0.2 },
        presetId: 'preset-a',
        presetPrompt: 'Be precise.',
        enabledToolLevels: ['L0'],
        permissionPolicy: 'always',
        activeSkills: ['skill-a'],
        promptVersion: 'kernel-a',
      },
    });
    expect(run?.revision).toBeGreaterThan(0);
    expect(permissionConfigs).toContainEqual({
      permissionPolicy: 'always',
    });
  });

  it('deduplicates repeated submissions from the same client', async () => {
    const { host } = buildEngine();
    const client = connect(host);
    const threadId = await initThread(client);
    provider.queue({ streamText: ['once'] }, { streamText: ['must not run'] });

    const submissionId = 'same-submission';
    client.post({
      type: 'turn.submit',
      submissionId,
      threadId,
      input: { text: 'execute once' },
    });
    client.post({
      type: 'turn.submit',
      submissionId,
      threadId,
      input: { text: 'execute once' },
    });
    await client.waitFor('turn.complete');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(provider.requests).toHaveLength(1);
    expect(await db.runs.where('submissionId').equals(submissionId).count()).toBe(1);
    expect(
      client.events.filter(
        (event) => event.type === 'command.ack' && event.submissionId === submissionId,
      ),
    ).toHaveLength(2);
  });

  it('approval RPC round-trip: approval.request → response → tool runs', async () => {
    const { host } = buildEngine();
    // Gatekeeper that asks for writes — override via a write tool + ask verdict.
    tools.register({
      name: 'poke',
      label: 'Poke',
      description: 'poke',
      parameters: z.object({}),
      level: 'L1',
      effects: 'write',
      execute: async () => ({ content: [{ type: 'text', text: 'poked' }] }),
    });

    const client = connect(host);
    const threadId = await initThread(client);

    provider.queue(
      { toolCalls: [{ id: 'c1', name: 'poke', params: {} }] },
      { streamText: ['done'] },
    );
    client.post({ type: 'turn.submit', threadId, input: { text: 'poke it' } });

    // allowAll gatekeeper → no approval.request expected; this test asserts the
    // tool ran straight through.
    await client.waitFor('turn.complete');
    const resultMsg = provider.requests[1]!.messages.find((m) => m.role === 'tool_result')!;
    const fencedResult = (resultMsg.content[0] as { text: string }).text;
    expect(fencedResult).toMatch(/^<<<web_content_[a-f0-9]+ /);
    expect(fencedResult).toContain('\npoked\n');
    expect(fencedResult).toMatch(/<<<end_web_content_[a-f0-9]+>>>$/);
  });

  it('persists pending approvals and their decisions', async () => {
    let toolExecutionCount = 0;
    let decisionPersistedBeforeExecution = false;
    const ask: GatekeeperCheck = {
      check: async () => ({
        verdict: 'ask',
        request: {
          tool: 'poke',
          label: 'Poke',
          params: {},
          targetOrigin: 'https://example.test',
          flags: [],
        },
      }),
    };
    const { host } = buildEngine(undefined, undefined, ask);
    tools.register({
      name: 'poke',
      label: 'Poke',
      description: 'poke',
      parameters: z.object({}),
      level: 'L1',
      effects: 'write',
      recovery: 'never-retry',
      execute: async () => {
        const meta = await new ThreadTree(db).getThread(threadId);
        const path = await new ThreadTree(db).getPath(threadId, meta!.leafId!);
        const decisionNodes = path.filter((node) => node.type === 'approval_decision');
        expect(decisionNodes).toHaveLength(1);
        expect(decisionNodes[0]?.payload).toMatchObject({
          approvalId: request.approvalId,
          request: {
            tool: 'poke',
            params: {},
            targetOrigin: 'https://example.test',
          },
          decision: { kind: 'accept' },
        });
        decisionPersistedBeforeExecution = true;
        toolExecutionCount++;
        return { content: [{ type: 'text', text: 'poked' }] };
      },
    });
    const client = connect(host);
    const threadId = await initThread(client);
    provider.queue(
      { toolCalls: [{ id: 'c1', name: 'poke', params: {} }] },
      { streamText: ['done'] },
    );

    client.post({ type: 'turn.submit', threadId, input: { text: 'poke it' } });
    const request = await client.waitFor('approval.request');
    expect(await db.approvals.get(request.approvalId)).toMatchObject({
      threadId,
      status: 'pending',
      request: { tool: 'poke', targetOrigin: 'https://example.test' },
    });

    const lateSubmission = client.post({
      type: 'approval.response',
      approvalId: request.approvalId,
      decision: { kind: 'accept' },
    });
    await client.waitForMatching(
      (event): event is Extract<AgentEvent, { type: 'command.ack' }> =>
        event.type === 'command.ack' && event.submissionId === lateSubmission,
    );
    await client.waitFor('turn.complete');
    expect(await db.approvals.get(request.approvalId)).toMatchObject({
      status: 'decided',
      decision: { kind: 'accept' },
    });
    const meta = await new ThreadTree(db).getThread(threadId);
    const path = await new ThreadTree(db).getPath(threadId, meta!.leafId!);
    const decisionNodes = path.filter((node) => node.type === 'approval_decision');
    expect(decisionNodes).toHaveLength(1);
    expect(decisionNodes[0]?.payload).toMatchObject({
      approvalId: request.approvalId,
      request: {
        tool: 'poke',
        params: {},
        targetOrigin: 'https://example.test',
      },
      decision: { kind: 'accept' },
    });
    expect(decisionPersistedBeforeExecution).toBe(true);
    expect(toolExecutionCount).toBe(1);
  });

  it('keeps the committed approval ACK when post-commit continuation fails', async () => {
    const ask: GatekeeperCheck = {
      check: async () => ({
        verdict: 'ask',
        request: {
          tool: 'poke',
          label: 'Poke',
          params: {},
          targetOrigin: 'https://example.test',
          flags: [],
        },
      }),
    };
    const { core, host } = buildEngine(undefined, undefined, ask);
    core.onApprovalDecision = async () => {
      throw new Error('injected post-commit continuation failure');
    };
    tools.register({
      name: 'poke',
      label: 'Poke',
      description: 'poke',
      parameters: z.object({}),
      level: 'L1',
      effects: 'write',
      recovery: 'never-retry',
      execute: async () => ({ content: [{ type: 'text', text: 'poked' }] }),
    });
    const client = connect(host);
    const threadId = await initThread(client);
    provider.queue({ toolCalls: [{ id: 'c1', name: 'poke', params: {} }] });
    client.post({ type: 'turn.submit', threadId, input: { text: 'poke it' } });
    const request = await client.waitFor('approval.request');
    const submissionId = crypto.randomUUID();
    const response = {
      type: 'approval.response' as const,
      submissionId,
      approvalId: request.approvalId,
      decision: { kind: 'accept' as const },
    };

    client.post(response);
    await client.waitForMatching(
      (event): event is Extract<AgentEvent, { type: 'command.ack' }> =>
        event.type === 'command.ack' && event.submissionId === submissionId,
    );
    await host.waitForAdmissionIdle();

    expect(await db.approvals.get(request.approvalId)).toMatchObject({
      status: 'decided',
      decision: { kind: 'accept' },
    });
    expect(await db.commandReceipts.get(`integration-client\u0000${submissionId}`)).toMatchObject({
      status: 'acknowledged',
      response: { type: 'command.ack', threadId },
    });
    expect(
      client.events.filter(
        (event) => event.type === 'command.rejected' && event.submissionId === submissionId,
      ),
    ).toHaveLength(0);

    client.post(response);
    await vi.waitFor(() => {
      expect(
        client.events.filter(
          (event) => event.type === 'command.ack' && event.submissionId === submissionId,
        ),
      ).toHaveLength(2);
    });
  });

  it('rejects a live approval command that conflicts with an in-flight timeout settlement', async () => {
    const ask: GatekeeperCheck = {
      check: async () => ({
        verdict: 'ask',
        request: {
          tool: 'poke',
          label: 'Poke',
          params: {},
          targetOrigin: 'https://example.test',
          flags: [],
        },
      }),
    };
    const { core, host } = buildEngine(undefined, undefined, ask, { approvalTimeoutMs: 5 });
    let timeoutSettled: () => void;
    let releaseContinuation: () => void;
    const timeoutSettlement = new Promise<void>((resolve) => (timeoutSettled = resolve));
    const continuationGate = new Promise<void>((resolve) => (releaseContinuation = resolve));
    core.onApprovalDecision = async (_id, _threadId, _tool, _origin, decision) => {
      if (decision.kind === 'decline') {
        timeoutSettled!();
        await continuationGate;
      }
    };
    tools.register({
      name: 'poke',
      label: 'Poke',
      description: 'poke',
      parameters: z.object({}),
      level: 'L1',
      effects: 'write',
      recovery: 'never-retry',
      execute: async () => ({ content: [{ type: 'text', text: 'poked' }] }),
    });
    const client = connect(host);
    const threadId = await initThread(client);
    provider.queue({ toolCalls: [{ id: 'c1', name: 'poke', params: {} }] });
    client.post({ type: 'turn.submit', threadId, input: { text: 'poke it' } });
    const request = await client.waitFor('approval.request');
    await timeoutSettlement;

    const submissionId = client.post({
      type: 'approval.response',
      approvalId: request.approvalId,
      decision: { kind: 'accept' },
    });
    await vi.waitFor(async () => {
      await expect(
        db.commandReceipts.get(`integration-client\u0000${submissionId}`),
      ).resolves.toMatchObject({ status: 'processing' });
    });
    releaseContinuation!();

    const rejection = await client.waitForMatching(
      (event): event is Extract<AgentEvent, { type: 'command.rejected' }> =>
        event.type === 'command.rejected' && event.submissionId === submissionId,
    );
    expect(rejection).toMatchObject({
      code: 'invalid_command',
      threadId,
      message: `Approval ${request.approvalId} was already decided with a different decision.`,
    });
    await host.waitForAdmissionIdle();
    expect(await db.approvals.get(request.approvalId)).toMatchObject({
      status: 'decided',
      decision: { kind: 'decline' },
    });
    expect(await db.commandReceipts.get(`integration-client\u0000${submissionId}`)).toMatchObject({
      status: 'rejected',
      response: { type: 'command.rejected', code: 'invalid_command', threadId },
    });
    expect(
      client.events.filter(
        (event) => event.type === 'command.ack' && event.submissionId === submissionId,
      ),
    ).toHaveLength(0);
    const decisionNodes = await db.nodes
      .where('threadId')
      .equals(threadId)
      .filter((node) => node.type === 'approval_decision')
      .toArray();
    expect(decisionNodes).toHaveLength(1);
    expect(decisionNodes[0]?.payload).toMatchObject({ decision: { kind: 'decline' } });
  });

  it('rejects a conflicting interaction response after reconstruction without a live waiter', async () => {
    const sharedDb = new PanelotDB(`recovered-interaction-conflict-${Date.now()}`);
    const thread = await new ThreadTree(sharedDb).createThread({ title: 'recovered interaction' });
    const runs = new RunRepository(sharedDb);
    const run = await runs.enqueue({
      threadId: thread.id,
      clientId: 'original-client',
      submissionId: 'original-run',
      input: { text: 'ask' },
    });
    await runs.transition(run.id, 'preparing');
    const interactions = new InteractionRepository(sharedDb);
    await interactions.createPendingWork({
      id: 'recovered-interaction',
      threadId: thread.id,
      runId: run.id,
      turnId: run.turnId,
      itemId: 'ask-call',
      request: {
        kind: 'ask_user',
        questions: [{ id: 'choice', question: 'Which option?' }],
      },
      pendingTool: {
        itemId: 'ask-call',
        toolName: 'ask_user',
        params: {},
        effect: 'read',
        recovery: 'retry-safe',
      },
      toolCallNode: {
        id: 'tool-call:recovered-interaction:1:0',
        type: 'tool_call',
        payload: {
          itemId: 'ask-call',
          toolName: 'ask_user',
          params: {},
          level: 'builtin',
        },
      },
    });
    const originalResponse = {
      kind: 'submit' as const,
      value: { answers: [{ id: 'choice', value: 'Option A' }] },
    };
    await interactions.resolve('recovered-interaction', originalResponse);
    await runs.transition(run.id, 'failed', {
      error: { code: 'stopped', message: 'Already terminal before reconstruction.' },
    });
    const { core } = buildEngine(sharedDb);
    const events: AgentEvent[] = [];
    const submissionId = 'conflicting-recovered-interaction';

    await core.handleOp(
      {
        type: 'interaction.response',
        submissionId,
        interactionId: 'recovered-interaction',
        response: { kind: 'cancel' },
        clientId: 'reconnected-client',
      } as Op,
      (event) => events.push(event),
    );

    expect(await sharedDb.interactions.get('recovered-interaction')).toMatchObject({
      status: 'resolved',
      response: originalResponse,
    });
    expect(
      await sharedDb.commandReceipts.get(`reconnected-client\u0000${submissionId}`),
    ).toMatchObject({
      status: 'rejected',
      response: {
        type: 'command.rejected',
        code: 'invalid_command',
        threadId: thread.id,
      },
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'command.rejected',
        submissionId,
        code: 'invalid_command',
        threadId: thread.id,
      }),
    );
    expect(
      events.some((event) => event.type === 'command.ack' && event.submissionId === submissionId),
    ).toBe(false);
    expect(
      await sharedDb.nodes
        .where('threadId')
        .equals(thread.id)
        .filter((node) => node.type === 'interaction_response')
        .count(),
    ).toBe(1);
  });

  it('turn.steer with wrong expectedTurnId errors; correct id injects', async () => {
    const { host } = buildEngine();
    let releaseTool: () => void;
    const gate = new Promise<void>((r) => (releaseTool = r));
    tools.register({
      name: 'slow',
      label: 'Slow',
      description: 'slow tool',
      parameters: z.object({}),
      level: 'builtin',
      effects: 'read',
      execute: async () => {
        await gate;
        return { content: [{ type: 'text', text: 'finally' }] };
      },
    });

    const client = connect(host);
    const threadId = await initThread(client);

    provider.queue(
      { toolCalls: [{ id: 'c1', name: 'slow', params: {} }] },
      { streamText: ['after steer'] },
    );
    client.post({ type: 'turn.submit', threadId, input: { text: 'start' } });
    const turnStart = await client.waitFor('turn.start');

    // Wrong turn id → turn_mismatch error.
    client.post({ type: 'turn.steer', threadId, expectedTurnId: 'wrong', input: { text: 'x' } });
    const err = await client.waitFor('error');
    expect(err.code).toBe('turn_mismatch');

    // Correct id → injected after current call.
    const steerSubmissionId = client.post({
      type: 'turn.steer',
      threadId,
      expectedTurnId: turnStart.turnId,
      input: { text: 'also do B' },
    });
    await client.waitForMatching(
      (event): event is Extract<AgentEvent, { type: 'command.ack' }> =>
        event.type === 'command.ack' && event.submissionId === steerSubmissionId,
    );
    releaseTool!();
    await client.waitFor('turn.complete');

    const lastReq = provider.requests[1]!;
    const userTexts = lastReq.messages
      .filter((m) => m.role === 'user')
      .flatMap((m) => m.content.map((c) => (c.type === 'text' ? c.text : '')));
    expect(userTexts.filter((text) => text === 'also do B')).toHaveLength(1);

    const meta = await db.threads.get(threadId);
    const path = await new ThreadTree(db).getPath(threadId, meta!.leafId!);
    const steered = path.filter(
      (node) =>
        node.type === 'user_message' && (node.payload as { steered?: boolean }).steered === true,
    );
    expect(steered).toHaveLength(1);
    expect((steered[0]?.payload as { content: unknown }).content).toEqual([
      { type: 'text', text: 'also do B' },
    ]);
    expect(path.findIndex((node) => node.id === steered[0]?.id)).toBeLessThan(
      path.map((node) => node.type).lastIndexOf('assistant_message'),
    );
  });

  it('persists steer durably before command.ack', async () => {
    const { host } = buildEngine();
    const blocker = registerBlockingTool('durable_ack_gate');
    const client = connect(host);
    const threadId = await initThread(client);
    provider.queue(
      { toolCalls: [{ id: 'c1', name: 'durable_ack_gate', params: {} }] },
      { streamText: ['done'] },
    );
    client.post({ type: 'turn.submit', threadId, input: { text: 'start' } });
    const turnStart = await client.waitFor('turn.start');
    await blocker.entered;

    const steerSubmissionId = client.post({
      type: 'turn.steer',
      threadId,
      expectedTurnId: turnStart.turnId,
      input: { text: 'durable before ack' },
    });
    await client.waitForMatching(
      (event): event is Extract<AgentEvent, { type: 'command.ack' }> =>
        event.type === 'command.ack' && event.submissionId === steerSubmissionId,
    );
    const pathBeforeRelease = await new ThreadTree(db).getPath(
      threadId,
      (await db.threads.get(threadId))!.leafId!,
    );
    const activeRunBeforeRelease = await db.runs.where('threadId').equals(threadId).first();
    blocker.release();
    await client.waitFor('turn.complete');
    const finalPath = await new ThreadTree(db).getPath(
      threadId,
      (await db.threads.get(threadId))!.leafId!,
    );

    expect(
      pathBeforeRelease.filter(
        (node) =>
          node.type === 'user_message' && (node.payload as { steered?: boolean }).steered === true,
      ),
    ).toHaveLength(0);
    expect(activeRunBeforeRelease?.pendingSteers).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ steered: true }) }),
    ]);
    expect(finalPath.map((node) => node.type)).toEqual([
      'turn_context',
      'user_message',
      'assistant_message',
      'tool_call',
      'tool_result',
      'user_message',
      'assistant_message',
    ]);
    expect(JSON.stringify(finalPath[5]?.payload)).toContain('durable before ack');
  });

  it('rejects steer when durable persistence fails', async () => {
    const { core, host } = buildEngine();
    const blocker = registerBlockingTool('persistence_failure_gate');
    const runs = (core as unknown as { runs: RunRepository }).runs;
    runs.acceptSteer = async () => {
      throw new Error('injected steer persistence failure');
    };
    const client = connect(host);
    const threadId = await initThread(client);
    provider.queue(
      { toolCalls: [{ id: 'c1', name: 'persistence_failure_gate', params: {} }] },
      { streamText: ['done'] },
    );
    client.post({ type: 'turn.submit', threadId, input: { text: 'start' } });
    const turnStart = await client.waitFor('turn.start');
    await blocker.entered;

    const steerSubmissionId = client.post({
      type: 'turn.steer',
      threadId,
      expectedTurnId: turnStart.turnId,
      input: { text: 'must not be accepted' },
    });
    const response = await client.waitForMatching(
      (
        event,
      ): event is
        | Extract<AgentEvent, { type: 'command.ack' }>
        | Extract<AgentEvent, { type: 'command.rejected' }> =>
        'submissionId' in event &&
        event.submissionId === steerSubmissionId &&
        (event.type === 'command.ack' || event.type === 'command.rejected'),
    );
    blocker.release();
    await client.waitFor('turn.complete');

    expect(response).toMatchObject({ type: 'command.rejected', code: 'internal' });
    expect(
      (await db.nodes.where('threadId').equals(threadId).toArray()).some((node) =>
        JSON.stringify(node.payload).includes('must not be accepted'),
      ),
    ).toBe(false);
  });

  it('atomically persists a steered attachment and its refs before ack', async () => {
    const { host } = buildEngine();
    const blocker = registerBlockingTool('attachment_steer_gate');
    const client = connect(host);
    const threadId = await initThread(client);
    await db.attachments.add({
      id: 'steer-attachment',
      threadId,
      createdAt: Date.now(),
      kind: 'file',
      mime: 'text/plain',
      bytes: new Blob(['attachment']),
      trust: 'trusted',
      provenance: 'user',
    });
    provider.queue(
      { toolCalls: [{ id: 'c1', name: 'attachment_steer_gate', params: {} }] },
      { streamText: ['done'] },
    );
    client.post({ type: 'turn.submit', threadId, input: { text: 'start' } });
    const turnStart = await client.waitFor('turn.start');
    await blocker.entered;

    const steerSubmissionId = client.post({
      type: 'turn.steer',
      threadId,
      expectedTurnId: turnStart.turnId,
      input: { text: 'inspect attachment', attachmentIds: ['steer-attachment'] },
    });
    const ack = await client.waitForMatching(
      (event): event is Extract<AgentEvent, { type: 'command.ack' }> =>
        event.type === 'command.ack' && event.submissionId === steerSubmissionId,
    );
    const attachment = await db.attachments.get('steer-attachment');
    const linkedNodeBeforeDelivery = await db.nodes.get(attachment!.refs!.nodeIds![0]!);
    const activeRun = await db.runs.where('threadId').equals(threadId).first();
    blocker.release();
    await client.waitFor('turn.complete');
    const linkedNode = await db.nodes.get(attachment!.refs!.nodeIds![0]!);

    expect(ack.type).toBe('command.ack');
    expect(linkedNodeBeforeDelivery).toBeUndefined();
    expect(linkedNode).toMatchObject({
      type: 'user_message',
      payload: { steered: true, content: [{ type: 'text', text: 'inspect attachment' }] },
    });
    expect(attachment?.refs?.runIds).toEqual([activeRun!.id]);
  });

  it('delivers a steer accepted after a request cutoff in the following request', async () => {
    const { core, host } = buildEngine();
    tools.register({
      name: 'context_step',
      label: 'Context step',
      description: 'advances to another model request',
      parameters: z.object({}),
      level: 'builtin',
      effects: 'read',
      execute: async () => ({ content: [{ type: 'text', text: 'step complete' }] }),
    });
    const client = connect(host);
    const threadId = await initThread(client);

    let contextSnapshotTaken: () => void;
    let releaseContextBuild: () => void;
    const snapshotTaken = new Promise<void>((resolve) => (contextSnapshotTaken = resolve));
    const contextGate = new Promise<void>((resolve) => (releaseContextBuild = resolve));
    const coreTree = (core as unknown as { tree: ThreadTree }).tree;
    const getPath = coreTree.getPath.bind(coreTree);
    let contextReadCount = 0;
    coreTree.getPath = async (requestedThreadId, leafId) => {
      const path = await getPath(requestedThreadId, leafId);
      contextReadCount++;
      if (contextReadCount === 2) {
        contextSnapshotTaken!();
        await contextGate;
      }
      return path;
    };

    provider.queue(
      { toolCalls: [{ id: 'c1', name: 'context_step', params: {} }] },
      { streamText: ['second response'] },
      { streamText: ['third response'] },
    );
    client.post({ type: 'turn.submit', threadId, input: { text: 'start' } });
    const turnStart = await client.waitFor('turn.start');
    await snapshotTaken;

    const steerSubmissionId = client.post({
      type: 'turn.steer',
      threadId,
      expectedTurnId: turnStart.turnId,
      input: { text: 'include in imminent request' },
    });
    await client.waitForMatching(
      (event): event is Extract<AgentEvent, { type: 'command.ack' }> =>
        event.type === 'command.ack' && event.submissionId === steerSubmissionId,
    );
    releaseContextBuild!();
    await client.waitFor('turn.complete');

    expect(provider.requests).toHaveLength(3);
    const imminentUserTexts = provider.requests[1]!.messages.filter(
      (message) => message.role === 'user',
    ).flatMap((message) =>
      message.content.map((content) => (content.type === 'text' ? content.text : '')),
    );
    expect(imminentUserTexts).not.toContain('include in imminent request');
    const followingUserTexts = provider.requests[2]!.messages.filter(
      (message) => message.role === 'user',
    ).flatMap((message) =>
      message.content.map((content) => (content.type === 'text' ? content.text : '')),
    );
    expect(
      followingUserTexts.filter((text) => text === 'include in imminent request'),
    ).toHaveLength(1);
    expect(contextReadCount).toBe(3);
  });

  it('uses a bounded steer cutoff without duplicate delivery or context rebuild starvation', async () => {
    const { core, host } = buildEngine();
    tools.register({
      name: 'cutoff_step',
      label: 'Cutoff step',
      description: 'advances to the cutoff request',
      parameters: z.object({}),
      level: 'builtin',
      effects: 'read',
      execute: async () => ({ content: [{ type: 'text', text: 'step complete' }] }),
    });
    const client = connect(host);
    const threadId = await initThread(client);

    let contextSnapshotTaken: () => void;
    let releaseContextBuild: () => void;
    let secondRequestStarted: () => void;
    let releaseSecondRequest: () => void;
    const snapshotTaken = new Promise<void>((resolve) => (contextSnapshotTaken = resolve));
    const contextGate = new Promise<void>((resolve) => (releaseContextBuild = resolve));
    const secondStarted = new Promise<void>((resolve) => (secondRequestStarted = resolve));
    const secondGate = new Promise<void>((resolve) => (releaseSecondRequest = resolve));
    const coreTree = (core as unknown as { tree: ThreadTree }).tree;
    const getPath = coreTree.getPath.bind(coreTree);
    let contextReadCount = 0;
    coreTree.getPath = async (requestedThreadId, leafId) => {
      const path = await getPath(requestedThreadId, leafId);
      contextReadCount++;
      if (contextReadCount === 2) {
        contextSnapshotTaken!();
        await contextGate;
      }
      return path;
    };

    provider.queue(
      { toolCalls: [{ id: 'c1', name: 'cutoff_step', params: {} }] },
      {
        onStreamStart: () => secondRequestStarted!(),
        release: secondGate,
        streamText: ['second response'],
      },
      { streamText: ['third response'] },
    );
    client.post({ type: 'turn.submit', threadId, input: { text: 'start' } });
    const turnStart = await client.waitFor('turn.start');
    await snapshotTaken;

    const cutoffTexts = Array.from({ length: 8 }, (_, index) => `cutoff steer ${index}`);
    const cutoffSubmissionIds = cutoffTexts.map((text) =>
      client.post({
        type: 'turn.steer',
        threadId,
        expectedTurnId: turnStart.turnId,
        input: { text },
      }),
    );
    await Promise.all(
      cutoffSubmissionIds.map((submissionId) =>
        client.waitForMatching(
          (event): event is Extract<AgentEvent, { type: 'command.ack' }> =>
            event.type === 'command.ack' && event.submissionId === submissionId,
        ),
      ),
    );
    releaseContextBuild!();
    await secondStarted;

    const secondUserTexts = provider.requests[1]!.messages.filter(
      (message) => message.role === 'user',
    ).flatMap((message) =>
      message.content.map((content) => (content.type === 'text' ? content.text : '')),
    );
    for (const text of cutoffTexts) {
      expect(secondUserTexts).not.toContain(text);
    }

    const afterCutoffSubmissionId = client.post({
      type: 'turn.steer',
      threadId,
      expectedTurnId: turnStart.turnId,
      input: { text: 'after cutoff' },
    });
    await client.waitForMatching(
      (event): event is Extract<AgentEvent, { type: 'command.ack' }> =>
        event.type === 'command.ack' && event.submissionId === afterCutoffSubmissionId,
    );
    expect(secondUserTexts).not.toContain('after cutoff');
    releaseSecondRequest!();
    await client.waitFor('turn.complete');

    expect(provider.requests).toHaveLength(3);
    const thirdUserTexts = provider.requests[2]!.messages.filter(
      (message) => message.role === 'user',
    ).flatMap((message) =>
      message.content.map((content) => (content.type === 'text' ? content.text : '')),
    );
    for (const text of cutoffTexts) {
      expect(thirdUserTexts.filter((candidate) => candidate === text)).toHaveLength(1);
    }
    expect(thirdUserTexts.filter((text) => text === 'after cutoff')).toHaveLength(1);
    expect(contextReadCount).toBe(3);
  });

  it('freezes steer identities while waiting for an earlier cutoff admission', async () => {
    const { core, host } = buildEngine();
    const blocker = registerBlockingTool('frozen_cutoff_gate');
    const runs = (core as unknown as { runs: RunRepository }).runs;
    const acceptSteer = runs.acceptSteer.bind(runs);
    let admissionAStarted: () => void;
    let releaseAdmissionA: () => void;
    let secondRequestStarted: () => void;
    let releaseSecondRequest: () => void;
    const admissionAEntered = new Promise<void>((resolve) => (admissionAStarted = resolve));
    const admissionAGate = new Promise<void>((resolve) => (releaseAdmissionA = resolve));
    const secondRequestEntered = new Promise<void>((resolve) => (secondRequestStarted = resolve));
    const secondRequestGate = new Promise<void>((resolve) => (releaseSecondRequest = resolve));
    runs.acceptSteer = async (...args) => {
      if (JSON.stringify(args[1].payload).includes('cutoff A')) {
        admissionAStarted!();
        await admissionAGate;
      }
      return acceptSteer(...args);
    };

    provider.queue(
      { toolCalls: [{ id: 'c1', name: 'frozen_cutoff_gate', params: {} }] },
      {
        onStreamStart: () => secondRequestStarted!(),
        release: secondRequestGate,
        streamText: ['second response'],
      },
      { streamText: ['third response'] },
    );
    const client = connect(host);
    const threadId = await initThread(client);
    client.post({ type: 'turn.submit', threadId, input: { text: 'start' } });
    const turnStart = await client.waitFor('turn.start');
    await blocker.entered;

    const submissionA = client.post({
      type: 'turn.steer',
      threadId,
      expectedTurnId: turnStart.turnId,
      input: { text: 'cutoff A' },
    });
    await admissionAEntered;
    blocker.release();
    await client.waitForMatching(
      (event): event is Extract<AgentEvent, { type: 'item.complete' }> =>
        event.type === 'item.complete' && event.itemId === 'c1',
    );

    const active = (
      core as unknown as {
        activeTurns: Map<string, { handle: { steer(input: { text: string }): Promise<void> } }>;
      }
    ).activeTurns.get(threadId)!;
    await active.handle.steer({ text: 'cutoff B' });
    releaseAdmissionA!();
    await client.waitForMatching(
      (event): event is Extract<AgentEvent, { type: 'command.ack' }> =>
        event.type === 'command.ack' && event.submissionId === submissionA,
    );
    await secondRequestEntered;

    const secondMessages = JSON.stringify(provider.requests[1]!.messages);
    expect(secondMessages.match(/cutoff A/g)).toHaveLength(1);
    expect(secondMessages).not.toContain('cutoff B');
    releaseSecondRequest!();
    await client.waitFor('turn.complete');

    expect(provider.requests).toHaveLength(3);
    const thirdMessages = JSON.stringify(provider.requests[2]!.messages);
    expect(thirdMessages.match(/cutoff A/g)).toHaveLength(1);
    expect(thirdMessages.match(/cutoff B/g)).toHaveLength(1);
  });

  it('materializes a frozen cutoff in admission order despite out-of-order persistence', async () => {
    const { core, host } = buildEngine();
    const blocker = registerBlockingTool('ordered_cutoff_gate');
    const runs = (core as unknown as { runs: RunRepository }).runs;
    const acceptSteer = runs.acceptSteer.bind(runs);
    let admissionAStarted: () => void;
    let releaseAdmissionA: () => void;
    const admissionAEntered = new Promise<void>((resolve) => (admissionAStarted = resolve));
    const admissionAGate = new Promise<void>((resolve) => (releaseAdmissionA = resolve));
    runs.acceptSteer = async (...args) => {
      if (JSON.stringify(args[1].payload).includes('ordered A')) {
        admissionAStarted!();
        await admissionAGate;
      }
      return acceptSteer(...args);
    };

    provider.queue(
      { toolCalls: [{ id: 'c1', name: 'ordered_cutoff_gate', params: {} }] },
      { streamText: ['done'] },
    );
    const client = connect(host);
    const threadId = await initThread(client);
    client.post({ type: 'turn.submit', threadId, input: { text: 'start' } });
    const turnStart = await client.waitFor('turn.start');
    await blocker.entered;

    const submissionA = client.post({
      type: 'turn.steer',
      threadId,
      expectedTurnId: turnStart.turnId,
      input: { text: 'ordered A' },
    });
    await admissionAEntered;
    const active = (
      core as unknown as {
        activeTurns: Map<string, { handle: { steer(input: { text: string }): Promise<void> } }>;
      }
    ).activeTurns.get(threadId)!;
    await active.handle.steer({ text: 'ordered B' });
    blocker.release();
    await client.waitForMatching(
      (event): event is Extract<AgentEvent, { type: 'item.complete' }> =>
        event.type === 'item.complete' && event.itemId === 'c1',
    );
    releaseAdmissionA!();
    await client.waitForMatching(
      (event): event is Extract<AgentEvent, { type: 'command.ack' }> =>
        event.type === 'command.ack' && event.submissionId === submissionA,
    );
    await client.waitFor('turn.complete');

    expect(provider.requests).toHaveLength(2);
    const orderedTexts = provider.requests[1]!.messages.filter((message) => message.role === 'user')
      .flatMap((message) =>
        message.content.map((block) => (block.type === 'text' ? block.text : '')),
      )
      .filter((text) => text.startsWith('ordered '));
    expect(orderedTexts).toEqual(['ordered A', 'ordered B']);
  });

  it.each(['error', 'abort', 'interrupt'] as const)(
    'terminal drain preserves admission order after inverse persistence on %s',
    async (mode) => {
      const { core, host } = buildEngine();
      const runs = (core as unknown as { runs: RunRepository }).runs;
      const acceptSteer = runs.acceptSteer.bind(runs);
      let admissionAStarted: () => void;
      let releaseAdmissionA: () => void;
      let streamStarted: () => void;
      let releaseStream: () => void;
      const admissionAEntered = new Promise<void>((resolve) => (admissionAStarted = resolve));
      const admissionAGate = new Promise<void>((resolve) => (releaseAdmissionA = resolve));
      const streamEntered = new Promise<void>((resolve) => (streamStarted = resolve));
      const streamGate = new Promise<void>((resolve) => (releaseStream = resolve));
      runs.acceptSteer = async (...args) => {
        if (JSON.stringify(args[1].payload).includes('terminal A')) {
          admissionAStarted!();
          await admissionAGate;
        }
        return acceptSteer(...args);
      };

      provider.queue({
        onStreamStart: () => streamStarted!(),
        ...(mode === 'interrupt' ? {} : { release: streamGate }),
        ...(mode === 'error'
          ? { streamError: new ProviderError('network', 'terminal drain error') }
          : mode === 'abort'
            ? { streamError: new DOMException('provider aborted', 'AbortError') }
            : { waitForAbort: true }),
      });
      const client = connect(host);
      const threadId = await initThread(client);
      client.post({ type: 'turn.submit', threadId, input: { text: 'start' } });
      const turnStart = await client.waitFor('turn.start');
      await streamEntered;

      const submissionA = client.post({
        type: 'turn.steer',
        threadId,
        expectedTurnId: turnStart.turnId,
        input: { text: 'terminal A' },
      });
      await admissionAEntered;
      const active = (
        core as unknown as {
          activeTurns: Map<string, { handle: { steer(input: { text: string }): Promise<void> } }>;
        }
      ).activeTurns.get(threadId)!;
      await active.handle.steer({ text: 'terminal B' });
      releaseAdmissionA!();
      await client.waitForMatching(
        (event): event is Extract<AgentEvent, { type: 'command.ack' }> =>
          event.type === 'command.ack' && event.submissionId === submissionA,
      );

      if (mode === 'interrupt') client.post({ type: 'turn.interrupt', threadId });
      else releaseStream!();
      await client.waitFor('turn.complete');

      const path = await new ThreadTree(db).getPath(
        threadId,
        (await db.threads.get(threadId))!.leafId!,
      );
      const terminalTexts = path
        .filter(
          (node) =>
            node.type === 'user_message' &&
            (node.payload as { steered?: boolean }).steered === true,
        )
        .map((node) => JSON.stringify(node.payload));
      expect(terminalTexts).toHaveLength(2);
      expect(terminalTexts[0]).toContain('terminal A');
      expect(terminalTexts[1]).toContain('terminal B');
    },
  );

  it('keeps a durable steer recoverable when cutoff materialization fails', async () => {
    const { core, host } = buildEngine();
    const blocker = registerBlockingTool('materialization_failure_gate');
    const runs = (core as unknown as { runs: RunRepository }).runs;
    const materializeSteers = runs.materializeSteers.bind(runs);
    let materializationAttempts = 0;
    runs.materializeSteers = async (...args) => {
      materializationAttempts++;
      if (materializationAttempts === 1) throw new Error('transient materialization failure');
      return materializeSteers(...args);
    };
    provider.queue(
      { toolCalls: [{ id: 'c1', name: 'materialization_failure_gate', params: {} }] },
      { streamText: ['resumed after materialization failure'] },
    );
    const client = connect(host);
    const threadId = await initThread(client);
    client.post({ type: 'turn.submit', threadId, input: { text: 'start' } });
    const turnStart = await client.waitFor('turn.start');
    await blocker.entered;
    const steerSubmissionId = client.post({
      type: 'turn.steer',
      threadId,
      expectedTurnId: turnStart.turnId,
      input: { text: 'recover this steer' },
    });
    await client.waitForMatching(
      (event): event is Extract<AgentEvent, { type: 'command.ack' }> =>
        event.type === 'command.ack' && event.submissionId === steerSubmissionId,
    );
    blocker.release();
    const firstComplete = await client.waitFor('turn.complete');
    const interruptedRun = await db.runs.where('threadId').equals(threadId).first();

    expect(firstComplete.stopReason).toBe('interrupted');
    expect(interruptedRun).toMatchObject({
      state: 'interrupted',
      pendingSteers: [
        expect.objectContaining({ payload: expect.objectContaining({ steered: true }) }),
      ],
    });
    expect(provider.requests).toHaveLength(1);

    client.post({ type: 'run.resume', threadId, runId: interruptedRun!.id });
    await client.waitForMatching(
      (event): event is Extract<AgentEvent, { type: 'turn.complete' }> =>
        event.type === 'turn.complete' && event !== firstComplete,
    );

    expect(provider.requests).toHaveLength(2);
    expect(
      JSON.stringify(provider.requests[1]!.messages).match(/recover this steer/g),
    ).toHaveLength(1);
    expect(await runs.get(interruptedRun!.id)).toMatchObject({
      state: 'completed',
      pendingSteers: [],
    });
  });

  it('does not call the provider after interrupt during steer materialization', async () => {
    const { core, host } = buildEngine();
    const blocker = registerBlockingTool('materialization_interrupt_gate');
    const runs = (core as unknown as { runs: RunRepository }).runs;
    const materializeSteers = runs.materializeSteers.bind(runs);
    let materializationStarted: () => void;
    let releaseMaterialization: () => void;
    const materializationEntered = new Promise<void>(
      (resolve) => (materializationStarted = resolve),
    );
    const materializationGate = new Promise<void>((resolve) => (releaseMaterialization = resolve));
    runs.materializeSteers = async (...args) => {
      materializationStarted!();
      await materializationGate;
      return materializeSteers(...args);
    };
    provider.queue(
      { toolCalls: [{ id: 'c1', name: 'materialization_interrupt_gate', params: {} }] },
      { streamText: ['must not run'] },
    );
    const client = connect(host);
    const threadId = await initThread(client);
    client.post({ type: 'turn.submit', threadId, input: { text: 'start' } });
    const turnStart = await client.waitFor('turn.start');
    await blocker.entered;
    const steerSubmissionId = client.post({
      type: 'turn.steer',
      threadId,
      expectedTurnId: turnStart.turnId,
      input: { text: 'materialize before interrupt' },
    });
    await client.waitForMatching(
      (event): event is Extract<AgentEvent, { type: 'command.ack' }> =>
        event.type === 'command.ack' && event.submissionId === steerSubmissionId,
    );
    blocker.release();
    await materializationEntered;

    const interruptSubmissionId = client.post({ type: 'turn.interrupt', threadId });
    await client.waitForMatching(
      (event): event is Extract<AgentEvent, { type: 'command.ack' }> =>
        event.type === 'command.ack' && event.submissionId === interruptSubmissionId,
    );
    releaseMaterialization!();
    const complete = await client.waitFor('turn.complete');

    expect(complete.stopReason).toBe('interrupted');
    expect(provider.requests).toHaveLength(1);
  });

  it('turn.steer rejects after loop termination while terminal persistence is pending', async () => {
    const { core, host } = buildEngine();
    let releaseTerminalState: () => void;
    let terminalStateStarted: () => void;
    const terminalStateGate = new Promise<void>((resolve) => (releaseTerminalState = resolve));
    const terminalStateEntered = new Promise<void>((resolve) => (terminalStateStarted = resolve));
    const runs = (core as unknown as { runs: RunRepository }).runs;
    const transition = runs.transition.bind(runs);
    runs.transition = async (runId, state, patch) => {
      if (state === 'completed') {
        terminalStateStarted!();
        await terminalStateGate;
      }
      return transition(runId, state, patch);
    };

    const client = connect(host);
    const threadId = await initThread(client);
    provider.queue({ streamText: ['done'] });
    client.post({ type: 'turn.submit', threadId, input: { text: 'start' } });
    const turnStart = await client.waitFor('turn.start');
    await terminalStateEntered;

    const steerSubmissionId = client.post({
      type: 'turn.steer',
      threadId,
      expectedTurnId: turnStart.turnId,
      input: { text: 'too late' },
    });
    const response = await client.waitForMatching(
      (
        event,
      ): event is
        Extract<AgentEvent, { type: 'command.ack' }> | Extract<AgentEvent, { type: 'error' }> =>
        'submissionId' in event &&
        event.submissionId === steerSubmissionId &&
        (event.type === 'command.ack' || event.type === 'error'),
    );
    releaseTerminalState!();
    await client.waitFor('turn.complete');

    expect(response).toMatchObject({ type: 'error', code: 'turn_not_steerable' });
    expect(provider.requests).toHaveLength(1);
    const path = await new ThreadTree(db).getPath(
      threadId,
      (await db.threads.get(threadId))!.leafId!,
    );
    expect(
      path.some(
        (node) =>
          node.type === 'user_message' &&
          JSON.stringify((node.payload as { content: unknown }).content).includes('too late'),
      ),
    ).toBe(false);
  });

  it('waits for an admitted steer persistence that crosses the final response boundary', async () => {
    const { core, host } = buildEngine();
    let streamStarted: () => void;
    let releaseStream: () => void;
    let persistenceStarted: () => void;
    let releasePersistence: () => void;
    let assistantCommitted: () => void;
    const streamEntered = new Promise<void>((resolve) => (streamStarted = resolve));
    const streamGate = new Promise<void>((resolve) => (releaseStream = resolve));
    const persistenceEntered = new Promise<void>((resolve) => (persistenceStarted = resolve));
    const persistenceGate = new Promise<void>((resolve) => (releasePersistence = resolve));
    const finalBoundary = new Promise<void>((resolve) => (assistantCommitted = resolve));
    const runs = (core as unknown as { runs: RunRepository }).runs;
    const acceptSteer = runs.acceptSteer.bind(runs);
    runs.acceptSteer = async (...args) => {
      persistenceStarted!();
      await persistenceGate;
      return acceptSteer(...args);
    };
    const appendAssistant = runs.appendAssistantAndCommitUsage.bind(runs);
    runs.appendAssistantAndCommitUsage = async (...args) => {
      const result = await appendAssistant(...args);
      assistantCommitted!();
      return result;
    };

    const client = connect(host);
    const threadId = await initThread(client);
    provider.queue(
      { onStreamStart: () => streamStarted!(), release: streamGate, streamText: ['first final'] },
      { streamText: ['after steer'] },
    );
    client.post({ type: 'turn.submit', threadId, input: { text: 'start' } });
    const turnStart = await client.waitFor('turn.start');
    await streamEntered;
    const steerSubmissionId = client.post({
      type: 'turn.steer',
      threadId,
      expectedTurnId: turnStart.turnId,
      input: { text: 'cross final boundary' },
    });
    await persistenceEntered;
    releaseStream!();
    await finalBoundary;
    releasePersistence!();
    await client.waitForMatching(
      (event): event is Extract<AgentEvent, { type: 'command.ack' }> =>
        event.type === 'command.ack' && event.submissionId === steerSubmissionId,
    );
    await client.waitFor('turn.complete');

    expect(provider.requests).toHaveLength(2);
    const secondRoles = provider.requests[1]!.messages.map((message) => message.role);
    expect(secondRoles).toEqual(['user', 'assistant', 'user']);
    expect(JSON.stringify(provider.requests[1]!.messages.at(-1))).toContain('cross final boundary');
  });

  it('persists an acknowledged steer exactly once when the provider stream errors', async () => {
    const { host } = buildEngine();
    let streamStarted: () => void;
    let releaseStream: () => void;
    const entered = new Promise<void>((resolve) => (streamStarted = resolve));
    const release = new Promise<void>((resolve) => (releaseStream = resolve));
    provider.queue({
      onStreamStart: () => streamStarted!(),
      release,
      streamError: new ProviderError('network', 'stream failed'),
    });

    const client = connect(host);
    const threadId = await initThread(client);
    client.post({ type: 'turn.submit', threadId, input: { text: 'start' } });
    const turnStart = await client.waitFor('turn.start');
    await entered;
    const steerSubmissionId = client.post({
      type: 'turn.steer',
      threadId,
      expectedTurnId: turnStart.turnId,
      input: { text: 'keep this error steer' },
    });
    await client.waitForMatching(
      (event): event is Extract<AgentEvent, { type: 'command.ack' }> =>
        event.type === 'command.ack' && event.submissionId === steerSubmissionId,
    );
    releaseStream!();
    const complete = await client.waitFor('turn.complete');

    expect(complete.stopReason).toBe('error');
    expect(provider.requests).toHaveLength(1);
    const path = await new ThreadTree(db).getPath(
      threadId,
      (await db.threads.get(threadId))!.leafId!,
    );
    expect(
      path.filter(
        (node) =>
          node.type === 'user_message' && (node.payload as { steered?: boolean }).steered === true,
      ),
    ).toHaveLength(1);
    expect(JSON.stringify(path.at(-1)?.payload)).toContain('keep this error steer');
  });

  it('persists an acknowledged steer exactly once when the stream is interrupted', async () => {
    const { host } = buildEngine();
    let streamStarted: () => void;
    const entered = new Promise<void>((resolve) => (streamStarted = resolve));
    provider.queue({ onStreamStart: () => streamStarted!(), waitForAbort: true });

    const client = connect(host);
    const threadId = await initThread(client);
    client.post({ type: 'turn.submit', threadId, input: { text: 'start' } });
    const turnStart = await client.waitFor('turn.start');
    await entered;
    const steerSubmissionId = client.post({
      type: 'turn.steer',
      threadId,
      expectedTurnId: turnStart.turnId,
      input: { text: 'keep this interrupted steer' },
    });
    await client.waitForMatching(
      (event): event is Extract<AgentEvent, { type: 'command.ack' }> =>
        event.type === 'command.ack' && event.submissionId === steerSubmissionId,
    );
    client.post({ type: 'turn.interrupt', threadId });
    const complete = await client.waitFor('turn.complete');

    expect(complete.stopReason).toBe('interrupted');
    expect(provider.requests).toHaveLength(1);
    const path = await new ThreadTree(db).getPath(
      threadId,
      (await db.threads.get(threadId))!.leafId!,
    );
    expect(
      path.filter(
        (node) =>
          node.type === 'user_message' && (node.payload as { steered?: boolean }).steered === true,
      ),
    ).toHaveLength(1);
    expect(JSON.stringify(path.at(-1)?.payload)).toContain('keep this interrupted steer');
  });

  it('rejects steer after interrupt while tool cleanup is pending', async () => {
    const { host } = buildEngine();
    let toolStarted: () => void;
    let abortObserved: () => void;
    let releaseCleanup: () => void;
    const toolEntered = new Promise<void>((resolve) => (toolStarted = resolve));
    const abortEntered = new Promise<void>((resolve) => (abortObserved = resolve));
    const cleanupGate = new Promise<void>((resolve) => (releaseCleanup = resolve));
    tools.register({
      name: 'cleanup_gate',
      label: 'Cleanup gate',
      description: 'waits for controlled abort cleanup',
      parameters: z.object({}),
      level: 'builtin',
      effects: 'read',
      execute: (_id, _params, signal) =>
        new Promise<never>((_, reject) => {
          toolStarted!();
          signal.addEventListener('abort', () => {
            abortObserved!();
            void cleanupGate.then(() => reject(new DOMException('aborted', 'AbortError')));
          });
        }),
    });

    const client = connect(host);
    const threadId = await initThread(client);
    provider.queue({ toolCalls: [{ id: 'c1', name: 'cleanup_gate', params: {} }] });
    client.post({ type: 'turn.submit', threadId, input: { text: 'start' } });
    const turnStart = await client.waitFor('turn.start');
    await toolEntered;

    const interruptSubmissionId = client.post({ type: 'turn.interrupt', threadId });
    await client.waitForMatching(
      (event): event is Extract<AgentEvent, { type: 'command.ack' }> =>
        event.type === 'command.ack' && event.submissionId === interruptSubmissionId,
    );
    await abortEntered;
    const steerSubmissionId = client.post({
      type: 'turn.steer',
      threadId,
      expectedTurnId: turnStart.turnId,
      input: { text: 'too late after interrupt' },
    });
    const response = await client.waitForMatching(
      (
        event,
      ): event is
        Extract<AgentEvent, { type: 'command.ack' }> | Extract<AgentEvent, { type: 'error' }> =>
        'submissionId' in event &&
        event.submissionId === steerSubmissionId &&
        (event.type === 'command.ack' || event.type === 'error'),
    );
    releaseCleanup!();
    const complete = await client.waitFor('turn.complete');

    expect(response).toMatchObject({ type: 'error', code: 'turn_not_steerable' });
    expect(complete.stopReason).toBe('interrupted');
    expect(provider.requests).toHaveLength(1);
    const path = await new ThreadTree(db).getPath(
      threadId,
      (await db.threads.get(threadId))!.leafId!,
    );
    expect(JSON.stringify(path.map((node) => node.payload))).not.toContain(
      'too late after interrupt',
    );
  });

  it('turn.interrupt stops the turn with stopReason interrupted', async () => {
    const { host } = buildEngine();
    tools.register({
      name: 'forever',
      label: 'Forever',
      description: 'never returns until aborted',
      parameters: z.object({}),
      level: 'builtin',
      effects: 'read',
      execute: (_id, _p, signal) =>
        new Promise<never>((_, reject) =>
          signal.addEventListener('abort', () => reject(new DOMException('x', 'AbortError'))),
        ),
    });

    const client = connect(host);
    const threadId = await initThread(client);
    provider.queue({ toolCalls: [{ id: 'c1', name: 'forever', params: {} }] });

    client.post({ type: 'turn.submit', threadId, input: { text: 'go' } });
    await client.waitFor('item.start');
    client.post({ type: 'turn.interrupt', threadId });
    const complete = await client.waitFor('turn.complete');
    expect(complete.stopReason).toBe('interrupted');
  });

  it('enqueue while busy: second input runs as the NEXT turn; queue.updated fires', async () => {
    const { host } = buildEngine();
    const client = connect(host);
    const threadId = await initThread(client);

    provider.queue({ streamText: ['first answer'] }, { streamText: ['second answer'] });
    client.post({ type: 'turn.submit', threadId, input: { text: 'first' } });
    client.post({ type: 'turn.enqueue', threadId, input: { text: 'second' } });

    // Two turn.completes in order.
    await client.waitFor('turn.complete');
    const completes = () => client.events.filter((e) => e.type === 'turn.complete');
    await new Promise<void>((resolve) => {
      const check = () => (completes().length >= 2 ? resolve() : setTimeout(check, 10));
      check();
    });

    expect(provider.requests).toHaveLength(2);
    const secondUser = provider.requests[1]!.messages.filter((m) => m.role === 'user').pop()!;
    expect((secondUser.content[0] as { text: string }).text).toBe('second');
    expect(client.events.some((e) => e.type === 'queue.updated')).toBe(true);
  });

  it('persists and applies queued turn overrides', async () => {
    const seen: ({ connectionId: string; modelId: string } | undefined)[] = [];
    const resolver: ProviderResolver = {
      resolve: async (_threadId, override) => {
        seen.push(override);
        return { provider, model: override?.modelId ?? 'mock', params: {} };
      },
    };
    const { host } = buildEngine(undefined, resolver);
    const client = connect(host);
    const threadId = await initThread(client);

    provider.queue({ streamText: ['queued answer'] });
    client.post({
      type: 'turn.enqueue',
      threadId,
      input: { text: 'queued' },
      overrides: { model: { connectionId: 'connection-b', modelId: 'model-c' } },
    } as DistributiveOmit<
      Extract<Op, { type: 'turn.enqueue' }> & { overrides: TurnOverrides },
      'submissionId'
    >);
    await client.waitFor('turn.complete');

    expect(seen.at(-1)).toEqual({ connectionId: 'connection-b', modelId: 'model-c' });
  });

  it('SW-kill recovery: new engine over the same DB rebuilds the snapshot and continues', async () => {
    // Engine instance 1: run a full turn with a tool call.
    const dbName = `int-recovery-${Date.now()}`;
    const sharedDb = new PanelotDB(dbName);
    const { host: host1 } = buildEngine(sharedDb);
    tools.register({
      name: 'echo',
      label: 'Echo',
      description: 'echo',
      parameters: z.object({ text: z.string() }),
      level: 'builtin',
      effects: 'read',
      execute: async (_id, p: { text: string }) => ({
        content: [{ type: 'text', text: `echo:${p.text}` }],
      }),
    });
    const client1 = connect(host1);
    const threadId = await initThread(client1);
    provider.queue(
      { toolCalls: [{ id: 'c1', name: 'echo', params: { text: 'checkpoint' } }] },
      { streamText: ['all done'] },
    );
    client1.post({ type: 'turn.submit', threadId, input: { text: 'do it' } });
    await client1.waitFor('turn.complete');

    // "SW killed": build a brand-new engine over the same database.
    const provider2 = new MockProvider();
    provider = provider2;
    const { host: host2 } = buildEngine(sharedDb);
    const client2 = connect(host2);
    client2.post({ type: 'initialize', protocolVersion: 1, subscribe: { threadId } });
    const init = await client2.waitFor('initialized');
    const snapshot = init.snapshot as ThreadSnapshot;

    // Replay reconstructed the full history from checkpoints.
    expect(snapshot.items.map((i) => i.kind)).toEqual([
      'user_message',
      'assistant_message',
      'tool_call',
      'tool_result',
      'assistant_message',
    ]);
    expect(snapshot.activeTurn).toBeNull();

    // Continue the conversation on the recovered engine.
    provider2.queue({ streamText: ['continuing fine'] });
    client2.post({ type: 'turn.submit', threadId, input: { text: 'continue' } });
    await client2.waitFor('turn.complete');
    // History fed to the model includes the pre-kill tool result.
    const req = provider2.requests[0]!;
    const resultMsg = req.messages.find((m) => m.role === 'tool_result')!;
    expect((resultMsg.content[0] as { text: string }).text).toBe('echo:checkpoint');
  });

  it('restarts durable queued runs when a new service worker boots', async () => {
    const sharedDb = new PanelotDB(`queued-recovery-${Date.now()}`);
    const tree = new ThreadTree(sharedDb);
    const thread = await tree.createThread({ title: 'queued-recovery' });
    await new RunRepository(sharedDb).enqueue({
      threadId: thread.id,
      clientId: 'recovery-client',
      submissionId: 'queued-before-kill',
      input: { text: 'resume after restart' },
      overrides: { model: { connectionId: 'connection-b', modelId: 'model-c' } },
    });

    const recoveryResolver: ProviderResolver = {
      resolve: async (_threadId, override) => ({
        provider,
        model: override?.modelId ?? 'mock',
        params: {},
        connectionId: override?.connectionId,
      }),
    };
    const { core } = buildEngine(sharedDb, recoveryResolver);
    const events: AgentEvent[] = [];
    core.onBroadcast = (event) => events.push(event);
    provider.queue({ streamText: ['recovered'] });

    await core.recover();
    await waitForEvent(events, 'turn.complete');

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.model).toBe('model-c');
    expect(
      (await sharedDb.runs.where('submissionId').equals('queued-before-kill').first())?.state,
    ).toBe('completed');
  });

  it('continues an accepted approval that was committed before a service worker restart', async () => {
    const sharedDb = new PanelotDB(`approval-recovery-${Date.now()}`);
    const { core } = buildEngine(sharedDb);
    let executionCount = 0;
    tools.register({
      name: 'approved_write',
      label: 'Approved write',
      description: 'Write after approval.',
      parameters: z.object({}),
      level: 'L1',
      effects: 'write',
      recovery: 'never-retry',
      execute: async () => {
        executionCount++;
        return { content: [{ type: 'text', text: 'approved result' }] };
      },
    });
    const tree = new ThreadTree(sharedDb);
    const thread = await tree.createThread({ title: 'approval recovery' });
    await tree.appendNode(thread.id, {
      type: 'turn_context',
      payload: {
        turnId: 'turn-approved',
        model: { connectionId: 'connection', modelId: 'mock' },
        permissionPolicy: 'untrusted',
        activeSkills: [],
      },
    });
    await tree.appendNode(thread.id, {
      type: 'user_message',
      payload: { content: [{ type: 'text', text: 'approve once' }] },
    });
    await tree.appendNode(thread.id, {
      type: 'tool_call',
      payload: { itemId: 'approved-call', toolName: 'approved_write', params: {}, level: 'L1' },
    });
    const runs = new RunRepository(sharedDb);
    const run = await runs.enqueue({
      threadId: thread.id,
      clientId: 'recovery-client',
      submissionId: 'approval-before-kill',
      input: { text: 'approve once' },
    });
    await runs.prepare(run.id, await testRunEnvironment(run.input, tools));
    await runs.transition(run.id, 'waiting_approval', {
      pendingTool: {
        itemId: 'approved-call',
        toolName: 'approved_write',
        params: {},
        effect: 'write',
        recovery: 'never-retry',
      },
    });
    const approvals = new ApprovalRepository(sharedDb);
    await approvals.create({
      id: 'approved-decision',
      threadId: thread.id,
      runId: run.id,
      turnId: run.turnId,
      request: {
        tool: 'approved_write',
        label: 'Approved write',
        params: {},
        targetOrigin: 'https://example.test',
        flags: [],
      },
    });
    await approvals.decide('approved-decision', { kind: 'accept' });

    const events: AgentEvent[] = [];
    core.onBroadcast = (event) => events.push(event);
    provider.queue({ streamText: ['continued'] });

    await core.recover();
    await waitForEvent(events, 'turn.complete');

    expect(executionCount).toBe(1);
    expect((await sharedDb.runs.get(run.id))?.state).toBe('completed');
  });

  it('keeps a recovered approval as the thread owner until its continuation completes', async () => {
    const sharedDb = new PanelotDB(`recovered-approval-busy-${Date.now()}`);
    const { core } = buildEngine(sharedDb);
    let executions = 0;
    tools.register({
      name: 'recovered_approval_write',
      label: 'Recovered approval write',
      description: 'Executes once after the recovered approval.',
      parameters: z.object({}),
      level: 'L1',
      effects: 'write',
      recovery: 'never-retry',
      execute: async () => {
        executions++;
        return { content: [{ type: 'text', text: 'recovered write completed' }] };
      },
    });
    const { approval, run, thread, toolCallNode } = await seedRecoveredApproval(sharedDb, tools);
    const runs = new RunRepository(sharedDb);
    const events: AgentEvent[] = [];
    core.onBroadcast = (event) => events.push(event);

    await core.recover();
    expect(core.activeThreadIds()).toContain(thread.id);
    const interrupted = await runs.enqueue({
      threadId: thread.id,
      clientId: 'resume-client',
      submissionId: 'resume-while-recovered',
      input: { text: 'must remain interrupted' },
    });
    await runs.transition(interrupted.id, 'interrupted');

    const submitEvents: AgentEvent[] = [];
    await core.handleOp(
      {
        type: 'turn.submit',
        submissionId: 'submit-behind-recovered-approval',
        clientId: 'queue-client',
        threadId: thread.id,
        input: { text: 'run only after the recovered action' },
      } as Op,
      (event) => submitEvents.push(event),
    );
    expect(provider.requests).toHaveLength(0);
    expect(
      await sharedDb.runs.where('submissionId').equals('submit-behind-recovered-approval').first(),
    ).toMatchObject({ state: 'queued' });
    expect(submitEvents).toContainEqual(
      expect.objectContaining({
        type: 'command.ack',
        submissionId: 'submit-behind-recovered-approval',
      }),
    );

    for (const op of [
      {
        type: 'turn.fork',
        submissionId: 'fork-behind-recovered-approval',
        threadId: thread.id,
        siblingOfNodeId: toolCallNode.id,
        input: { text: 'must not fork yet' },
      },
      {
        type: 'thread.selectBranch',
        submissionId: 'branch-behind-recovered-approval',
        threadId: thread.id,
        nodeId: toolCallNode.id,
      },
      {
        type: 'run.resume',
        submissionId: 'resume-behind-recovered-approval',
        threadId: thread.id,
        runId: interrupted.id,
      },
    ] as const) {
      const rejected: AgentEvent[] = [];
      await core.handleOp(op as Op, (event) => rejected.push(event));
      expect(rejected).toContainEqual(
        expect.objectContaining({
          type: 'command.rejected',
          submissionId: op.submissionId,
          code: 'turn_mismatch',
        }),
      );
    }

    provider.queue(
      { streamText: ['continued recovered approval'] },
      { streamText: ['ran queued input'] },
    );
    const approvalEvents: AgentEvent[] = [];
    await core.handleOp(
      {
        type: 'approval.response',
        submissionId: 'accept-recovered-approval',
        clientId: 'approval-client',
        approvalId: approval.id,
        decision: { kind: 'accept' },
      } as Op,
      (event) => approvalEvents.push(event),
    );

    const started = Date.now();
    while (events.filter((event) => event.type === 'turn.complete').length < 2) {
      if (Date.now() - started > 3_000) throw new Error('timeout waiting for serialized turns');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(executions).toBe(1);
    expect(provider.requests).toHaveLength(2);
    expect((await sharedDb.runs.get(run.id))?.state).toBe('completed');
    expect((await sharedDb.runs.get(interrupted.id))?.state).toBe('interrupted');
    expect(
      await sharedDb.runs.where('submissionId').equals('submit-behind-recovered-approval').first(),
    ).toMatchObject({ state: 'completed' });
    expect(approvalEvents).toContainEqual(
      expect.objectContaining({
        type: 'command.ack',
        submissionId: 'accept-recovered-approval',
      }),
    );
  });

  it('replays a prepared read after restart without duplicating the user node', async () => {
    const sharedDb = new PanelotDB(`safe-tool-recovery-${Date.now()}`);
    const { core } = buildEngine(sharedDb);
    let executionCount = 0;
    tools.register({
      name: 'safe_read',
      label: 'Safe read',
      description: 'Read safely.',
      parameters: z.object({}),
      level: 'builtin',
      effects: 'read',
      recovery: 'inspect-first',
      execute: async () => {
        executionCount++;
        return { content: [{ type: 'text', text: 'safe result' }] };
      },
    });
    const tree = new ThreadTree(sharedDb);
    const thread = await tree.createThread({ title: 'safe recovery' });
    await tree.appendNode(thread.id, {
      type: 'turn_context',
      payload: {
        turnId: 'turn-safe',
        model: { connectionId: 'connection', modelId: 'mock' },
        permissionPolicy: 'untrusted',
        activeSkills: [],
      },
    });
    await tree.appendNode(thread.id, {
      type: 'user_message',
      payload: { content: [{ type: 'text', text: 'inspect once' }] },
    });
    await tree.appendNode(thread.id, {
      type: 'tool_call',
      payload: { itemId: 'safe-call', toolName: 'safe_read', params: {}, level: 'builtin' },
    });
    const runs = new RunRepository(sharedDb);
    const run = await runs.enqueue({
      threadId: thread.id,
      clientId: 'recovery-client',
      submissionId: 'safe-before-kill',
      input: { text: 'inspect once' },
    });
    await runs.prepare(run.id, await testRunEnvironment(run.input, tools));
    await runs.transition(run.id, 'executing_tool', {
      pendingTool: {
        itemId: 'safe-call',
        toolName: 'safe_read',
        params: {},
        effect: 'read',
        recovery: 'inspect-first',
      },
    });

    const events: AgentEvent[] = [];
    core.onBroadcast = (event) => events.push(event);
    provider.queue({ streamText: ['continued'] });

    await core.recover();
    await waitForEvent(events, 'turn.complete');

    expect(executionCount).toBe(1);
    const nodes = await sharedDb.nodes.where('threadId').equals(thread.id).toArray();
    expect(nodes.filter((node) => node.type === 'user_message')).toHaveLength(1);
    expect((await sharedDb.runs.get(run.id))?.state).toBe('completed');
  });

  it('fails a recovered tool before dispatch when its durable target is no longer valid', async () => {
    const sharedDb = new PanelotDB(`recovery-target-${Date.now()}`);
    const { core } = buildEngine(sharedDb);
    let executionCount = 0;
    tools.register({
      name: 'targeted_read',
      label: 'Targeted read',
      description: 'Reads one durable browser target.',
      parameters: z.object({}),
      level: 'L1',
      effects: 'read',
      recovery: 'inspect-first',
      execute: async () => {
        executionCount++;
        return { content: [{ type: 'text', text: 'must not execute' }] };
      },
    });
    const { run } = await seedPreparedToolRun(
      sharedDb,
      tools,
      'targeted_read',
      'read',
      'inspect-first',
    );
    await sharedDb.runs.update(run.id, {
      pendingTool: {
        itemId: 'call-targeted_read',
        toolName: 'targeted_read',
        params: {},
        target: { tabId: 7, origin: 'https://example.test' },
        effect: 'read',
        recovery: 'inspect-first',
      },
    });
    const validateRecoveredTool = vi.fn(async () => {
      throw new Error('tab removed');
    });
    core.onValidateRecoveredTool = validateRecoveredTool;
    const events: AgentEvent[] = [];
    core.onBroadcast = (event) => events.push(event);
    provider.queue({ streamText: ['continued safely'] });

    await core.recover();
    await waitForEvent(events, 'turn.complete');

    expect(executionCount).toBe(0);
    expect(validateRecoveredTool).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        toolName: 'targeted_read',
        target: { tabId: 7, origin: 'https://example.test' },
      }),
      expect.objectContaining({ snapshotVersion: 1 }),
    );
    const nodes = await sharedDb.nodes.where('threadId').equals(run.threadId).toArray();
    expect(nodes).toContainEqual(
      expect.objectContaining({
        type: 'tool_result',
        payload: expect.objectContaining({
          itemId: 'call-targeted_read',
          ok: false,
          contentForLlm: [
            {
              type: 'text',
              text: 'The recovered tool target or authorization is no longer valid.',
            },
          ],
        }),
      }),
    );
  });

  it('exposes recovered execution to manual pause and quarantines an interrupted write', async () => {
    const sharedDb = new PanelotDB(`recovery-manual-pause-${Date.now()}`);
    const { core } = buildEngine(sharedDb);
    let started!: () => void;
    const executionStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    tools.register({
      name: 'manual_recovery_write',
      label: 'Manual recovery write',
      description: 'Waits for a manual interruption.',
      parameters: z.object({}),
      level: 'L1',
      effects: 'write',
      recovery: 'retry-safe',
      execute: async (_id, _params, signal) => {
        started();
        await new Promise<void>((_resolve, reject) => {
          const onAbort = () => reject(signal.reason);
          signal.addEventListener('abort', onAbort, { once: true });
          if (signal.aborted) onAbort();
        });
        return { content: [{ type: 'text', text: 'must not complete' }] };
      },
    });
    const { run, thread } = await seedPreparedToolRun(
      sharedDb,
      tools,
      'manual_recovery_write',
      'write',
      'retry-safe',
    );

    const recovery = core.recover();
    await executionStarted;
    expect(core.activeThreadIds()).toContain(thread.id);
    await core.pauseThread(thread.id, 'Manual input detected.');
    await recovery;

    expect(core.activeThreadIds()).not.toContain(thread.id);
    expect(await sharedDb.runs.get(run.id)).toMatchObject({
      state: 'paused_uncertain',
      stopReason: 'manual_operation',
      pendingTool: { toolName: 'manual_recovery_write' },
    });
    const nodes = await sharedDb.nodes.where('threadId').equals(thread.id).toArray();
    expect(nodes).toContainEqual(
      expect.objectContaining({
        type: 'system_notice',
        payload: expect.objectContaining({ text: 'Manual input detected.', noticeKind: 'paused' }),
      }),
    );
  });

  it('waits for recovered tool cleanup before committing thread deletion', async () => {
    const sharedDb = new PanelotDB(`recovery-delete-${Date.now()}`);
    const { core } = buildEngine(sharedDb);
    let started!: () => void;
    const executionStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let sawAbort = false;
    tools.register({
      name: 'delete_recovery_read',
      label: 'Delete recovery read',
      description: 'Defers abort cleanup so deletion ordering is observable.',
      parameters: z.object({}),
      level: 'builtin',
      effects: 'read',
      recovery: 'retry-safe',
      execute: async (_id, _params, signal) => {
        started();
        await new Promise<void>((_resolve, reject) => {
          const onAbort = () => {
            sawAbort = true;
            void cleanupGate.then(() => reject(signal.reason));
          };
          signal.addEventListener('abort', onAbort, { once: true });
          if (signal.aborted) onAbort();
        });
        return { content: [{ type: 'text', text: 'unreachable' }] };
      },
    });
    const { thread } = await seedPreparedToolRun(
      sharedDb,
      tools,
      'delete_recovery_read',
      'read',
      'retry-safe',
    );
    const events: AgentEvent[] = [];
    core.onBroadcast = (event) => events.push(event);

    const recovery = core.recover();
    await executionStarted;
    let deletionSettled = false;
    const deletion = core
      .handleOp(
        {
          type: 'thread.delete',
          submissionId: 'delete-during-recovery',
          threadId: thread.id,
        },
        (event) => events.push(event),
      )
      .then(() => {
        deletionSettled = true;
      });
    await vi.waitFor(() => expect(sawAbort).toBe(true));

    expect(deletionSettled).toBe(false);
    expect(await sharedDb.threads.get(thread.id)).toBeDefined();
    expect(
      await sharedDb.commandReceipts.get('unidentified-client\u0000delete-during-recovery'),
    ).toMatchObject({ status: 'processing' });

    releaseCleanup();
    await Promise.all([recovery, deletion]);

    expect(deletionSettled).toBe(true);
    expect(await sharedDb.threads.get(thread.id)).toBeUndefined();
    expect(await sharedDb.nodes.where('threadId').equals(thread.id).count()).toBe(0);
    expect(await sharedDb.runs.where('threadId').equals(thread.id).count()).toBe(0);
    expect(events).toContainEqual(expect.objectContaining({ type: 'thread.deleted' }));
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'command.ack',
        submissionId: 'delete-during-recovery',
        threadId: thread.id,
      }),
    );
  });

  it('preserves recovered owners, timers, and queues when durable deletion fails', async () => {
    const sharedDb = new PanelotDB(`recovery-delete-rollback-${Date.now()}`);
    const { core } = buildEngine(sharedDb);
    tools.register({
      name: 'recovered_approval_write',
      label: 'Recovered approval write',
      description: 'Requires a durable recovered approval.',
      parameters: z.object({}),
      level: 'L1',
      effects: 'write',
      recovery: 'never-retry',
      execute: async () => ({ content: [{ type: 'text', text: 'written' }] }),
    });
    const { approval, thread } = await seedRecoveredApproval(sharedDb, tools);
    await core.recover();
    await core.handleOp(
      {
        type: 'turn.enqueue',
        submissionId: 'queued-before-failed-delete',
        threadId: thread.id,
        input: { text: 'keep queued' },
      },
      () => {},
    );
    const runtime = core as unknown as {
      tree: ThreadTree;
      queues: Map<string, unknown[]>;
      recoveredApprovalsByThread: Map<string, unknown>;
      recoveredApprovalTimers: Map<string, unknown>;
    };
    expect(runtime.queues.get(thread.id)).toHaveLength(1);
    expect(runtime.recoveredApprovalsByThread.has(thread.id)).toBe(true);
    expect(runtime.recoveredApprovalTimers.has(approval.id)).toBe(true);
    vi.spyOn(runtime.tree, 'deleteThread').mockRejectedValueOnce(new Error('delete failed'));
    const deleteEvents: AgentEvent[] = [];

    await core.handleOp(
      {
        type: 'thread.delete',
        submissionId: 'failed-thread-delete',
        threadId: thread.id,
      },
      (event) => deleteEvents.push(event),
    );

    expect(
      await sharedDb.commandReceipts.get('unidentified-client\u0000failed-thread-delete'),
    ).toMatchObject({
      status: 'rejected',
      response: { type: 'command.rejected', code: 'internal', threadId: thread.id },
    });
    expect(deleteEvents).toContainEqual(
      expect.objectContaining({
        type: 'command.rejected',
        submissionId: 'failed-thread-delete',
        code: 'internal',
        message: 'delete failed',
        threadId: thread.id,
      }),
    );
    expect(await sharedDb.threads.get(thread.id)).toBeDefined();
    expect(await sharedDb.approvals.get(approval.id)).toBeDefined();
    expect(await sharedDb.runs.where('threadId').equals(thread.id).count()).toBe(2);
    expect(runtime.queues.get(thread.id)).toHaveLength(1);
    expect(runtime.recoveredApprovalsByThread.has(thread.id)).toBe(true);
    expect(runtime.recoveredApprovalTimers.has(approval.id)).toBe(true);
    expect(core.activeThreadIds()).toContain(thread.id);
  });

  it('cancels a recovered waiting approval when manual input conflicts with its tab', async () => {
    const sharedDb = new PanelotDB(`recovery-approval-manual-${Date.now()}`);
    const { core } = buildEngine(sharedDb);
    let executionCount = 0;
    tools.register({
      name: 'manual_approval_write',
      label: 'Manual approval write',
      description: 'Must not execute after a recovered approval conflicts with manual input.',
      parameters: z.object({}),
      level: 'L1',
      effects: 'write',
      recovery: 'never-retry',
      execute: async () => {
        executionCount++;
        return { content: [{ type: 'text', text: 'unexpected execution' }] };
      },
    });
    const { run, thread } = await seedPreparedToolRun(
      sharedDb,
      tools,
      'manual_approval_write',
      'write',
      'never-retry',
    );
    const runs = new RunRepository(sharedDb);
    const prepared = await runs.get(run.id);
    await runs.transition(run.id, 'waiting_approval', {
      pendingTool: {
        ...prepared!.pendingTool!,
        target: { tabId: 42, origin: 'https://example.test' },
      },
    });
    const approvals = new ApprovalRepository(sharedDb);
    const approval = await approvals.create({
      id: 'manual-recovered-approval',
      threadId: thread.id,
      runId: run.id,
      turnId: run.turnId,
      request: {
        tool: 'manual_approval_write',
        label: 'Manual approval write',
        params: {},
        targetOrigin: 'https://example.test',
        flags: [],
      },
    });
    const events: AgentEvent[] = [];
    core.onBroadcast = (event) => events.push(event);

    await core.recover();
    expect(core.activeThreadIds()).toContain(thread.id);
    expect(core.recoveredApprovalTargetsTab(thread.id, 42)).toBe(true);
    expect(core.recoveredApprovalTargetsTab(thread.id, 43)).toBe(false);
    let idle = false;
    const admissionIdle = core.waitForAdmissionIdle().then(() => {
      idle = true;
    });
    await Promise.resolve();
    expect(idle).toBe(false);

    await core.pauseThread(thread.id, 'Manual input detected.');
    await admissionIdle;

    expect(executionCount).toBe(0);
    expect(core.activeThreadIds()).not.toContain(thread.id);
    expect(await approvals.get(approval.id)).toMatchObject({
      status: 'decided',
      decision: { kind: 'cancel' },
    });
    expect(await runs.get(run.id)).toMatchObject({
      state: 'interrupted',
      pendingTool: undefined,
      stopReason: 'approval_cancelled',
    });
    expect(events.some((event) => event.type === 'turn.complete')).toBe(false);
    const leafId = (await sharedDb.threads.get(thread.id))?.leafId;
    if (!leafId) throw new Error('Recovered approval thread has no leaf node.');
    const path = await new ThreadTree(sharedDb).getPath(thread.id, leafId);
    expect(path).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'approval_decision',
          payload: expect.objectContaining({ decision: { kind: 'cancel' } }),
        }),
        expect.objectContaining({
          type: 'tool_result',
          payload: expect.objectContaining({ itemId: 'call-manual_approval_write', ok: false }),
        }),
        expect.objectContaining({
          type: 'system_notice',
          payload: expect.objectContaining({ text: 'Manual input detected.' }),
        }),
      ]),
    );
  });

  it('prevents dispatch when manual input races an accepted recovered approval', async () => {
    const sharedDb = new PanelotDB(`recovery-approval-race-${Date.now()}`);
    const { core } = buildEngine(sharedDb);
    let executionCount = 0;
    tools.register({
      name: 'racing_approval_write',
      label: 'Racing approval write',
      description: 'Must not dispatch across a recovered approval conflict.',
      parameters: z.object({}),
      level: 'L1',
      effects: 'write',
      recovery: 'never-retry',
      execute: async () => {
        executionCount++;
        return { content: [{ type: 'text', text: 'unexpected execution' }] };
      },
    });
    const { run, thread } = await seedPreparedToolRun(
      sharedDb,
      tools,
      'racing_approval_write',
      'write',
      'never-retry',
    );
    const runs = new RunRepository(sharedDb);
    const prepared = await runs.get(run.id);
    await runs.transition(run.id, 'waiting_approval', {
      pendingTool: {
        ...prepared!.pendingTool!,
        target: { tabId: 77, origin: 'https://example.test' },
      },
    });
    const approvals = new ApprovalRepository(sharedDb);
    await approvals.create({
      id: 'racing-recovered-approval',
      threadId: thread.id,
      runId: run.id,
      turnId: run.turnId,
      request: {
        tool: 'racing_approval_write',
        label: 'Racing approval write',
        params: {},
        targetOrigin: 'https://example.test',
        flags: [],
      },
    });
    let approvalHookEntered!: () => void;
    let releaseApprovalHook!: () => void;
    const approvalHookStarted = new Promise<void>((resolve) => {
      approvalHookEntered = resolve;
    });
    const approvalHookGate = new Promise<void>((resolve) => {
      releaseApprovalHook = resolve;
    });
    core.onApprovalDecision = async () => {
      approvalHookEntered();
      await approvalHookGate;
    };
    const events: AgentEvent[] = [];
    core.onBroadcast = (event) => events.push(event);
    await core.recover();

    const response = core.handleOp(
      {
        type: 'approval.response',
        submissionId: 'accept-racing-approval',
        approvalId: 'racing-recovered-approval',
        decision: { kind: 'accept' },
      },
      (event) => events.push(event),
    );
    await approvalHookStarted;
    expect(core.recoveredApprovalTargetsTab(thread.id, 77)).toBe(true);
    const pause = core.pauseThread(thread.id, 'Manual input detected.');
    releaseApprovalHook();
    await Promise.all([response, pause]);

    expect(executionCount).toBe(0);
    expect(await approvals.get('racing-recovered-approval')).toMatchObject({
      status: 'decided',
      decision: { kind: 'accept' },
    });
    expect(await runs.get(run.id)).toMatchObject({
      state: 'interrupted',
      pendingTool: undefined,
      stopReason: 'manual_operation',
    });
    expect(core.activeThreadIds()).not.toContain(thread.id);
    expect(events.some((event) => event.type === 'turn.complete')).toBe(false);
    const toolResults = await sharedDb.nodes
      .where('threadId')
      .equals(thread.id)
      .filter((node) => node.type === 'tool_result')
      .toArray();
    expect(toolResults).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          itemId: 'call-racing_approval_write',
          ok: false,
        }),
      }),
    );
  });

  it('aborts a recovered read at its deadline and persists a failed run', async () => {
    const sharedDb = new PanelotDB(`recovery-abort-${Date.now()}`);
    const { core } = buildEngine(sharedDb, undefined, undefined, {
      recoveryToolTimeoutMs: 10,
    });
    let sawAbort = false;
    tools.register({
      name: 'abortable_read',
      label: 'Abortable read',
      description: 'Waits for the recovery deadline.',
      parameters: z.object({}),
      level: 'builtin',
      effects: 'read',
      recovery: 'inspect-first',
      execute: (_id, _params, signal) =>
        new Promise<never>((_resolve, reject) => {
          const onAbort = () => {
            sawAbort = true;
            reject(new DOMException('aborted', 'AbortError'));
          };
          signal.addEventListener('abort', onAbort, { once: true });
          if (signal.aborted) onAbort();
        }),
    });
    const { run, thread } = await seedPreparedToolRun(
      sharedDb,
      tools,
      'abortable_read',
      'read',
      'inspect-first',
    );
    const events: AgentEvent[] = [];
    core.onBroadcast = (event) => events.push(event);

    await core.recover();

    expect(sawAbort).toBe(true);
    expect(await sharedDb.runs.get(run.id)).toMatchObject({
      state: 'failed',
      pendingTool: undefined,
      stopReason: 'recovery_tool_timeout',
      error: { code: 'recovery_tool_timeout' },
    });
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'error', threadId: thread.id, retryable: false }),
    );
  });

  it('keeps recovery closed until an abort-ignoring write settles and quarantines its result', async () => {
    const sharedDb = new PanelotDB(`recovery-ignore-abort-${Date.now()}`);
    const { core } = buildEngine(sharedDb, undefined, undefined, {
      recoveryToolTimeoutMs: 10,
    });
    let started!: () => void;
    const executionStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const executionGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sawAbort = false;
    tools.register({
      name: 'stubborn_write',
      label: 'Stubborn write',
      description: 'Ignores abort until its external operation settles.',
      parameters: z.object({}),
      level: 'L1',
      effects: 'write',
      recovery: 'retry-safe',
      execute: async (_id, _params, signal, onUpdate) => {
        started();
        signal.addEventListener('abort', () => {
          sawAbort = true;
        });
        await executionGate;
        onUpdate?.({ progressText: 'late progress' });
        return { content: [{ type: 'text', text: 'late result' }] };
      },
    });
    const { run, thread } = await seedPreparedToolRun(
      sharedDb,
      tools,
      'stubborn_write',
      'write',
      'retry-safe',
    );
    const events: AgentEvent[] = [];
    core.onBroadcast = (event) => events.push(event);
    let recoverySettled = false;

    const recovery = core.recover().then(() => {
      recoverySettled = true;
    });
    await executionStarted;
    await waitForEvent(events, 'run.recovery_required');

    expect(sawAbort).toBe(true);
    expect(recoverySettled).toBe(false);
    expect(await sharedDb.runs.get(run.id)).toMatchObject({
      state: 'paused_uncertain',
      stopReason: 'recovery_tool_timeout',
      error: { code: 'recovery_tool_timeout' },
      pendingTool: { toolName: 'stubborn_write' },
    });

    release();
    await recovery;

    expect(recoverySettled).toBe(true);
    expect((await sharedDb.runs.get(run.id))?.state).toBe('paused_uncertain');
    const nodes = await sharedDb.nodes.where('threadId').equals(thread.id).toArray();
    expect(nodes.filter((node) => node.type === 'tool_result')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'item.delta')).toHaveLength(0);
  });

  it('pauses an uncertain write until the user explicitly chooses retry', async () => {
    const sharedDb = new PanelotDB(`uncertain-tool-recovery-${Date.now()}`);
    const { core } = buildEngine(sharedDb);
    let executionCount = 0;
    tools.register({
      name: 'unsafe_write',
      label: 'Unsafe write',
      description: 'Write once.',
      parameters: z.object({}),
      level: 'L1',
      effects: 'write',
      recovery: 'never-retry',
      execute: async () => {
        executionCount++;
        return { content: [{ type: 'text', text: 'written' }] };
      },
    });
    const tree = new ThreadTree(sharedDb);
    const thread = await tree.createThread({ title: 'uncertain recovery' });
    await tree.appendNode(thread.id, {
      type: 'turn_context',
      payload: {
        turnId: 'turn-unsafe',
        model: { connectionId: 'connection', modelId: 'mock' },
        permissionPolicy: 'untrusted',
        activeSkills: [],
      },
    });
    await tree.appendNode(thread.id, {
      type: 'user_message',
      payload: { content: [{ type: 'text', text: 'submit once' }] },
    });
    await tree.appendNode(thread.id, {
      type: 'tool_call',
      payload: { itemId: 'unsafe-call', toolName: 'unsafe_write', params: {}, level: 'L1' },
    });
    const runs = new RunRepository(sharedDb);
    const run = await runs.enqueue({
      threadId: thread.id,
      clientId: 'recovery-client',
      submissionId: 'unsafe-before-kill',
      input: { text: 'submit once' },
    });
    await runs.prepare(run.id, await testRunEnvironment(run.input, tools));
    await runs.transition(run.id, 'executing_tool', {
      pendingTool: {
        itemId: 'unsafe-call',
        toolName: 'unsafe_write',
        params: {},
        effect: 'write',
        recovery: 'never-retry',
      },
    });

    const events: AgentEvent[] = [];
    core.onBroadcast = (event) => events.push(event);

    await core.recover();
    expect(executionCount).toBe(0);
    expect((await sharedDb.runs.get(run.id))?.state).toBe('paused_uncertain');
    expect(events).toContainEqual(expect.objectContaining({ type: 'run.recovery_required' }));

    provider.queue({ streamText: ['continued after confirmation'] });
    await core.handleOp(
      {
        type: 'run.resolveUncertain',
        submissionId: 'resolve-unsafe',
        threadId: thread.id,
        runId: run.id,
        resolution: 'retry',
      },
      (event) => events.push(event),
    );
    await waitForEvent(events, 'turn.complete');

    expect(executionCount).toBe(1);
    expect((await sharedDb.runs.get(run.id))?.state).toBe('completed');
  });

  it('thread.selectBranch moves leafId to the sibling branch (docs/development/ui.md §2)', async () => {
    const { core, host } = buildEngine();
    const client = connect(host);
    const threadId = await initThread(client);

    provider.queue({ streamText: ['first answer'] });
    client.post({ type: 'turn.submit', threadId, input: { text: 'question' } });
    await client.waitFor('turn.complete');

    // Fork at the user message: append a sibling user node + a reply on it.
    const tree = new ThreadTree(db);
    const snapBefore = (await core.getSnapshot(threadId))!;
    const userNodeId = snapBefore.items.find((i) => i.kind === 'user_message')!.nodeId;
    const editedUser = await tree.forkAt(threadId, userNodeId, {
      type: 'user_message',
      payload: { content: [{ type: 'text', text: 'edited question' }] },
    });
    await tree.appendNode(threadId, {
      type: 'assistant_message',
      payload: { content: [{ type: 'text', text: 'second answer' }] },
      parentId: editedUser.id,
    });

    // Current leaf is on the edited branch (2nd sibling, 1-based index).
    const snapEdited = (await core.getSnapshot(threadId))!;
    const editedUserItem = snapEdited.items.find((i) => i.kind === 'user_message')!;
    expect(editedUserItem.branch).toEqual({ index: 2, count: 2 });

    // Switch back to the original sibling.
    client.post({ type: 'thread.selectBranch', threadId, nodeId: userNodeId });
    await client.waitFor('thread.updated');
    const snapSwitched = (await core.getSnapshot(threadId))!;
    const texts = snapSwitched.items.map((i) => JSON.stringify(i.payload));
    expect(texts.some((t) => t.includes('first answer'))).toBe(true);
    expect(texts.some((t) => t.includes('second answer'))).toBe(false);
  });

  it('title generates from the first message in parallel with the turn (before turn.complete)', async () => {
    db = new PanelotDB(`int-test-title-${Date.now()}`);
    provider = new MockProvider();
    const taskProvider = new MockProvider();
    tools = new ToolRegistry();
    let releaseTool: () => void;
    const gate = new Promise<void>((r) => (releaseTool = r));
    tools.register({
      name: 'slow',
      label: 'Slow',
      description: 'blocks until released',
      parameters: z.object({}),
      level: 'builtin',
      effects: 'read',
      execute: async () => {
        await gate;
        return { content: [{ type: 'text', text: 'done' }] };
      },
    });
    const resolver: ProviderResolver = {
      resolve: async () => ({ provider, model: 'mock', params: {} }),
      resolveTaskModel: async () => ({ provider: taskProvider, model: 'task-mock' }),
    };
    const core = new RealEngineCore(db, tools, allowAll, resolver);
    const host = new EngineHost(core);
    core.onBroadcast = (ev) => host.broadcast(ev);
    const client = connect(host);

    client.post({ type: 'initialize', protocolVersion: 1 });
    await client.waitFor('initialized');
    client.post({ type: 'thread.create' });
    const created = await client.waitFor('thread.created');
    client.post({ type: 'thread.subscribe', threadId: created.threadId });

    taskProvider.queue({ streamText: ['帮我写周报'] });
    provider.queue(
      { toolCalls: [{ id: 'c1', name: 'slow', params: {} }] },
      { streamText: ['answer'] },
    );
    client.post({
      type: 'turn.submit',
      threadId: created.threadId,
      input: { text: '帮我写一份周报' },
    });

    // Two-stage titling, both landing while the turn is still blocked on the
    // slow tool: instant truncated fallback, then the LLM title.
    const titleUpdates = () =>
      client.events
        .filter((e) => e.type === 'thread.updated')
        .map((e) => (e as { patch: { title?: string } }).patch.title)
        .filter((t): t is string => t !== undefined);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timeout; titles: ${titleUpdates().join(',')}`)),
        3000,
      );
      const check = () =>
        titleUpdates().length >= 2 ? (clearTimeout(timer), resolve()) : setTimeout(check, 5);
      check();
    });
    expect(titleUpdates()).toEqual(['帮我写一份周报', '帮我写周报']);
    expect(client.events.some((e) => e.type === 'turn.complete')).toBe(false);
    // The LLM title request went to the task model, from the raw first message.
    expect(taskProvider.requests).toHaveLength(1);
    expect(taskProvider.requests[0]!.model).toBe('task-mock');

    releaseTool!();
    await client.waitFor('turn.complete');
  });

  it('turn.submit overrides.enabledToolLevels filters the tool registry', async () => {
    const { host } = buildEngine();
    tools.register({
      name: 'l2_probe',
      label: 'L2 probe',
      description: 'only visible when L2 enabled',
      parameters: z.object({}),
      level: 'L2',
      effects: 'read',
      execute: async () => ({ content: [{ type: 'text', text: 'ran' }] }),
    });
    const client = connect(host);
    const threadId = await initThread(client);

    provider.queue({ streamText: ['ok1'] }, { streamText: ['ok2'] });
    // Pure-chat turn: no tool levels enabled → provider sees zero tools.
    client.post({
      type: 'turn.submit',
      threadId,
      input: { text: 'chat only' },
      overrides: { enabledToolLevels: [] },
    });
    await client.waitFor('turn.complete');
    expect(provider.requests[0]!.tools).toHaveLength(0);

    // Unrestricted turn → the L2 tool is offered.
    client.post({ type: 'turn.submit', threadId, input: { text: 'full' } });
    await new Promise<void>((resolve) => {
      const check = () =>
        client.events.filter((e) => e.type === 'turn.complete').length >= 2
          ? resolve()
          : setTimeout(check, 5);
      check();
    });
    expect(provider.requests[1]!.tools.map((t) => t.name)).toContain('l2_probe');
  });

  it('interrupt settles a pending approval and ignores a late acceptance', async () => {
    const askGate: GatekeeperCheck = {
      check: async (call) => ({
        verdict: 'ask',
        request: {
          tool: call.toolName,
          label: call.toolName,
          params: call.params,
          targetOrigin: 'https://example.test',
          flags: [],
        },
      }),
    };
    const { core, host } = buildEngine(undefined, undefined, askGate);
    let executions = 0;
    tools.register({
      name: 'approval_write',
      label: 'Approval write',
      description: 'write after approval',
      parameters: z.object({}),
      level: 'L1',
      effects: 'write',
      execute: async () => {
        executions++;
        return { content: [{ type: 'text', text: 'written' }] };
      },
    });
    const client = connect(host);
    const threadId = await initThread(client);
    provider.queue({ toolCalls: [{ id: 'approval-call', name: 'approval_write', params: {} }] });
    const turnSubmission = client.post({
      type: 'turn.submit',
      threadId,
      input: { text: 'write once' },
    });
    const request = await client.waitFor('approval.request');

    client.post({ type: 'turn.interrupt', threadId });
    const complete = await client.waitFor('turn.complete');
    expect(complete.stopReason).toBe('interrupted');
    expect((await core.getSnapshot(threadId))?.pendingApprovals).toEqual([]);
    expect((await db.runs.where('submissionId').equals(turnSubmission).first())?.state).toBe(
      'interrupted',
    );

    const lateSubmission = client.post({
      type: 'approval.response',
      approvalId: request.approvalId,
      decision: { kind: 'accept' },
    });
    const responseOutcome = await client.waitForMatching(
      (event): event is Extract<AgentEvent, { type: 'command.rejected' }> =>
        event.type === 'command.rejected' &&
        event.submissionId === lateSubmission &&
        event.code === 'invalid_command',
    );
    expect(responseOutcome).toMatchObject({ type: 'command.rejected', code: 'invalid_command' });

    expect(executions).toBe(0);
    expect(await db.approvals.get(request.approvalId)).toMatchObject({
      status: 'decided',
      decision: { kind: 'cancel' },
    });
  });

  it('keeps a timed-out approval declined when a response arrives later', async () => {
    const askGate: GatekeeperCheck = {
      check: async (call) => ({
        verdict: 'ask',
        request: {
          tool: call.toolName,
          label: call.toolName,
          params: call.params,
          targetOrigin: 'https://example.test',
          flags: [],
        },
      }),
    };
    const { host } = buildEngine(undefined, undefined, askGate, { approvalTimeoutMs: 20 });
    let executions = 0;
    tools.register({
      name: 'timeout_write',
      label: 'Timeout write',
      description: 'must not run after timeout',
      parameters: z.object({}),
      level: 'L1',
      effects: 'write',
      execute: async () => {
        executions++;
        return { content: [{ type: 'text', text: 'written' }] };
      },
    });
    const client = connect(host);
    const threadId = await initThread(client);
    provider.queue(
      { toolCalls: [{ id: 'timeout-call', name: 'timeout_write', params: {} }] },
      { streamText: ['continued without the action'] },
    );
    client.post({ type: 'turn.submit', threadId, input: { text: 'wait for approval' } });
    const request = await client.waitFor('approval.request');
    await client.waitFor('turn.complete');

    const timeoutResponse = client.post({
      type: 'approval.response',
      approvalId: request.approvalId,
      decision: { kind: 'accept' },
    });
    await client.waitForMatching(
      (event): event is Extract<AgentEvent, { type: 'command.rejected' }> =>
        event.type === 'command.rejected' &&
        event.submissionId === timeoutResponse &&
        event.code === 'invalid_command',
    );

    expect(executions).toBe(0);
    expect(await db.approvals.get(request.approvalId)).toMatchObject({
      decision: { kind: 'decline' },
    });
  });

  it.each(['streaming_model', 'completed'] as const)(
    'does not replay a decided approval from a stale recovery snapshot after the first continuation is %s',
    async (firstContinuationState) => {
      const sharedDb = new PanelotDB(
        `approval-recovery-race-${firstContinuationState}-${Date.now()}`,
      );
      const { core } = buildEngine(sharedDb);
      let executions = 0;
      tools.register({
        name: 'write_once',
        label: 'Write once',
        description: 'must execute at most once',
        parameters: z.object({}),
        level: 'L1',
        effects: 'write',
        recovery: 'never-retry',
        execute: async () => {
          executions++;
          return { content: [{ type: 'text', text: 'written once' }] };
        },
      });
      const tree = new ThreadTree(sharedDb);
      const thread = await tree.createThread({ title: 'approval recovery race' });
      await tree.appendNode(thread.id, {
        type: 'user_message',
        payload: { content: [{ type: 'text', text: 'write once' }] },
      });
      const toolCallNode = await tree.appendNode(thread.id, {
        type: 'tool_call',
        payload: {
          itemId: 'write-once-call',
          toolName: 'write_once',
          params: {},
          level: 'L1',
        },
      });
      const runs = new RunRepository(sharedDb);
      const run = await runs.enqueue({
        threadId: thread.id,
        clientId: 'recovery-client',
        submissionId: 'write-once-submission',
        input: { text: 'write once' },
      });
      await runs.prepare(
        run.id,
        await testRunEnvironment(run.input, tools, { promptVersion: 'test' }),
      );
      const approvals = new ApprovalRepository(sharedDb);
      const { approval } = await approvals.createPendingWork({
        id: 'write-once-approval',
        threadId: thread.id,
        runId: run.id,
        turnId: run.turnId,
        request: {
          tool: 'write_once',
          label: 'Write once',
          params: {},
          targetOrigin: 'https://example.test',
          flags: [],
        },
        pendingTool: {
          itemId: 'write-once-call',
          toolName: 'write_once',
          params: {},
          effect: 'write',
          recovery: 'never-retry',
        },
        toolCallNode,
        deadlineAt: Date.now() + 300_000,
      });

      let streamStarted!: () => void;
      const enteredStream = new Promise<void>((resolve) => {
        streamStarted = resolve;
      });
      let finishStream: (() => void) | undefined;
      const streamRelease =
        firstContinuationState === 'streaming_model'
          ? new Promise<void>((resolve) => {
              finishStream = resolve;
            })
          : undefined;
      provider.queue({
        streamText: ['continued'],
        onStreamStart: streamStarted,
        release: streamRelease,
      });

      let recoveryRead!: () => void;
      const recoveryHasSnapshot = new Promise<void>((resolve) => {
        recoveryRead = resolve;
      });
      let releaseRecovery!: () => void;
      const recoveryGate = new Promise<void>((resolve) => {
        releaseRecovery = resolve;
      });
      const coreRuns = (core as unknown as { runs: RunRepository }).runs;
      const recoverOpenRuns = coreRuns.recoverOpenRuns.bind(coreRuns);
      coreRuns.recoverOpenRuns = async () => {
        const recovered = await recoverOpenRuns();
        recoveryRead();
        await recoveryGate;
        return recovered;
      };
      const events: AgentEvent[] = [];
      core.onBroadcast = (event) => events.push(event);

      const recovery = core.recover();
      await recoveryHasSnapshot;
      await core.handleOp(
        {
          type: 'approval.response',
          submissionId: 'approve-once',
          approvalId: approval.id,
          decision: { kind: 'accept' },
        },
        (event) => events.push(event),
      );
      await enteredStream;

      if (firstContinuationState === 'completed') {
        await waitForEvent(events, 'turn.complete');
      } else {
        expect((await sharedDb.runs.get(run.id))?.state).toBe('streaming_model');
      }

      releaseRecovery();
      await recovery;
      expect(executions).toBe(1);

      finishStream?.();
      await waitForEvent(events, 'turn.complete');
      expect((await sharedDb.runs.get(run.id))?.state).toBe('completed');
      expect(executions).toBe(1);
    },
  );

  it('restores the escalated tool as the pending approval continuation', async () => {
    const sharedDb = new PanelotDB(`escalation-recovery-${Date.now()}`);
    const escalationGate: GatekeeperCheck = {
      check: async (call) =>
        call.toolName === 'type_trusted'
          ? {
              verdict: 'ask',
              request: {
                tool: call.toolName,
                label: 'Trusted type',
                params: call.params,
                targetOrigin: 'https://example.test',
                flags: ['escalation_l2'],
              },
            }
          : { verdict: 'allow' },
    };
    const { core: core1, host: host1 } = buildEngine(sharedDb, undefined, escalationGate);
    const parameters = z.object({ element: z.string(), ref: z.string(), text: z.string() });
    tools.register({
      name: 'type',
      label: 'Type',
      description: 'regular type',
      parameters,
      level: 'L1',
      effects: 'write',
      execute: async () => {
        throw actionError('l1_not_effective', 'trusted input required', 'verify', true, {
          escalationTool: 'type_trusted',
        });
      },
    });
    tools.register({
      name: 'type_trusted',
      label: 'Trusted type',
      description: 'trusted type',
      parameters,
      level: 'L2',
      effects: 'write',
      execute: async () => ({ content: [{ type: 'text', text: 'old worker' }] }),
    });
    const client1 = connect(host1);
    const threadId = await initThread(client1);
    provider.queue({
      toolCalls: [
        {
          id: 'trusted-call',
          name: 'type',
          params: { element: 'Name', ref: 'r1', text: 'Panelot' },
        },
      ],
    });
    client1.post({ type: 'turn.submit', threadId, input: { text: 'fill the name' } });
    const originalRequest = await client1.waitFor('approval.request');
    const waitingRun = await sharedDb.runs.where('threadId').equals(threadId).first();
    expect(waitingRun).toMatchObject({
      state: 'waiting_approval',
      pendingTool: {
        itemId: 'trusted-call',
        toolName: 'type_trusted',
        params: { element: 'Name', ref: 'r1', text: 'Panelot' },
      },
    });

    const abandoned = core1 as unknown as {
      pendingApprovals: Map<string, { cleanup: () => void }>;
    };
    for (const waiter of abandoned.pendingApprovals.values()) waiter.cleanup();
    abandoned.pendingApprovals.clear();

    provider = new MockProvider();
    const { core: core2, host: host2 } = buildEngine(sharedDb, undefined, escalationGate);
    let recoveredExecutions = 0;
    tools.register({
      name: 'type',
      label: 'Type',
      description: 'regular type',
      parameters,
      level: 'L1',
      effects: 'write',
      execute: async () => ({ content: [{ type: 'text', text: 'unused after recovery' }] }),
    });
    tools.register({
      name: 'type_trusted',
      label: 'Trusted type',
      description: 'trusted type',
      parameters,
      level: 'L2',
      effects: 'write',
      execute: async () => {
        recoveredExecutions++;
        return { content: [{ type: 'text', text: 'trusted input complete' }] };
      },
    });
    const client2 = connect(host2);
    client2.post({
      type: 'initialize',
      protocolVersion: 1,
      subscribe: { threadId },
    });
    await client2.waitFor('initialized');
    provider.queue({ streamText: ['continued after restart'] });
    await core2.recover();
    const restoredRequest = await client2.waitFor('approval.request');
    expect(restoredRequest.approvalId).toBe(originalRequest.approvalId);
    await client2.waitForMatching(
      (event): event is Extract<AgentEvent, { type: 'activity.updated' }> =>
        event.type === 'activity.updated' &&
        event.activity.threadId === threadId &&
        event.activity.pendingApprovals === 1,
    );

    client2.post({
      type: 'approval.response',
      approvalId: restoredRequest.approvalId,
      decision: { kind: 'accept' },
    });
    await client2.waitFor('turn.complete');

    expect(recoveredExecutions).toBe(1);
    expect((await sharedDb.runs.get(waitingRun!.id))?.state).toBe('completed');
  });

  it('uses the persisted approval deadline after a worker restart', async () => {
    const sharedDb = new PanelotDB(`approval-deadline-${Date.now()}`);
    const askGate: GatekeeperCheck = {
      check: async (call) => ({
        verdict: 'ask',
        request: {
          tool: call.toolName,
          label: call.toolName,
          params: call.params,
          targetOrigin: 'https://example.test',
          flags: [],
        },
      }),
    };
    const { core: core1, host: host1 } = buildEngine(sharedDb, undefined, askGate, {
      approvalTimeoutMs: 250,
    });
    tools.register({
      name: 'deadline_write',
      label: 'Deadline write',
      description: 'must not run after the persisted deadline',
      parameters: z.object({}),
      level: 'L1',
      effects: 'write',
      execute: async () => ({ content: [{ type: 'text', text: 'old worker' }] }),
    });
    const client1 = connect(host1);
    const threadId = await initThread(client1);
    provider.queue({ toolCalls: [{ id: 'deadline-call', name: 'deadline_write', params: {} }] });
    client1.post({ type: 'turn.submit', threadId, input: { text: 'wait across restart' } });
    const request = await client1.waitFor('approval.request');
    const persisted = await sharedDb.approvals.get(request.approvalId);
    expect(persisted?.deadlineAt).toBeGreaterThan(Date.now());

    const abandoned = core1 as unknown as {
      pendingApprovals: Map<string, { cleanup: () => void }>;
    };
    for (const waiter of abandoned.pendingApprovals.values()) waiter.cleanup();
    abandoned.pendingApprovals.clear();

    provider = new MockProvider();
    const { core: core2, host: host2 } = buildEngine(sharedDb, undefined, askGate, {
      approvalTimeoutMs: 5_000,
    });
    let executions = 0;
    tools.register({
      name: 'deadline_write',
      label: 'Deadline write',
      description: 'must not run after the persisted deadline',
      parameters: z.object({}),
      level: 'L1',
      effects: 'write',
      execute: async () => {
        executions++;
        return { content: [{ type: 'text', text: 'unexpected' }] };
      },
    });
    const client2 = connect(host2);
    client2.post({
      type: 'initialize',
      protocolVersion: 1,
      subscribe: { threadId },
    });
    await client2.waitFor('initialized');
    provider.queue({ streamText: ['continued after timeout'] });
    await core2.recover();
    await client2.waitFor('approval.request');
    await client2.waitFor('turn.complete');

    expect(executions).toBe(0);
    expect(await sharedDb.approvals.get(request.approvalId)).toMatchObject({
      status: 'decided',
      decision: { kind: 'decline' },
    });
  });

  it('fails a waiting run explicitly when its approval record is missing', async () => {
    const sharedDb = new PanelotDB(`missing-approval-${Date.now()}`);
    const { core } = buildEngine(sharedDb);
    const thread = await new ThreadTree(sharedDb).createThread({ title: 'missing approval' });
    const runs = new RunRepository(sharedDb);
    const run = await runs.enqueue({
      threadId: thread.id,
      clientId: 'recovery-client',
      submissionId: 'missing-approval-run',
      input: { text: 'write' },
    });
    await runs.prepare(run.id, await testRunEnvironment(run.input, tools));
    await runs.transition(run.id, 'waiting_approval', {
      pendingTool: {
        itemId: 'missing-call',
        toolName: 'missing_write',
        params: {},
        effect: 'write',
        recovery: 'never-retry',
      },
    });
    const events: AgentEvent[] = [];
    core.onBroadcast = (event) => events.push(event);

    await core.recover();

    expect(await sharedDb.runs.get(run.id)).toMatchObject({
      state: 'failed',
      stopReason: 'recovery_missing_approval',
      error: { code: 'recovery_missing_approval' },
    });
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'error', threadId: thread.id, retryable: false }),
    );
  });

  it('fails closed when a started legacy run has no environment snapshot', async () => {
    const sharedDb = new PanelotDB(`legacy-environment-${Date.now()}`);
    const thread = await new ThreadTree(sharedDb).createThread({ title: 'legacy environment' });
    const runs = new RunRepository(sharedDb);
    const run = await runs.enqueue({
      threadId: thread.id,
      clientId: 'legacy-client',
      submissionId: 'legacy-run',
      input: { text: 'resume legacy' },
    });
    await runs.prepare(run.id, {
      connectionId: 'connection',
      modelId: 'mock',
      modelParameters: {},
      enabledToolLevels: ['L0', 'L1', 'L2', 'mcp'],
      permissionPolicy: 'untrusted',
      activeSkills: [],
      promptVersion: 'legacy',
    });
    await runs.transition(run.id, 'interrupted');
    const { core } = buildEngine(sharedDb);

    await core.recover();

    expect(await sharedDb.runs.get(run.id)).toMatchObject({
      state: 'failed',
      stopReason: 'environment_snapshot_unsupported',
      error: { code: 'environment_snapshot_unsupported' },
    });
  });

  it('interrupts an active run before atomically deleting its durable thread state', async () => {
    const { core, host } = buildEngine();
    const client = connect(host);
    const threadId = await initThread(client);
    let streamStarted: () => void;
    const started = new Promise<void>((resolve) => (streamStarted = resolve));
    provider.queue({ waitForAbort: true, onStreamStart: () => streamStarted!() });
    client.post({
      type: 'turn.submit',
      threadId,
      input: { text: 'delete while streaming' },
    });
    await started;
    await new Promise((resolve) => setTimeout(resolve, 0));

    await db.attachments.add({
      id: 'delete-active-attachment',
      threadId,
      createdAt: 1,
      kind: 'file',
      mime: 'text/plain',
      bytes: new Blob(['delete me']),
    });
    await db.interactions.add({
      id: 'delete-active-interaction',
      threadId,
      runId: 'delete-active-run',
      turnId: 'delete-active-turn',
      itemId: 'delete-active-item',
      request: { kind: 'ask_user', questions: [{ id: 'confirm', question: 'Continue?' }] },
      status: 'pending',
      requestedAt: 1,
    });
    const resolvedInteractions: string[] = [];
    core.onInteractionResolved = (interactionId) => resolvedInteractions.push(interactionId);

    const submissionId = client.post({
      type: 'thread.delete',
      threadId,
      submissionId: 'stable-thread-delete',
    });
    const deleted = await client.waitFor('thread.deleted');
    const acknowledged = await client.waitForMatching(
      (event): event is Extract<AgentEvent, { type: 'command.ack' }> =>
        event.type === 'command.ack' && event.submissionId === submissionId,
    );

    expect(deleted.threadId).toBe(threadId);
    expect(acknowledged.threadId).toBe(threadId);
    expect(resolvedInteractions).toEqual(['delete-active-interaction']);
    expect(await db.threads.get(threadId)).toBeUndefined();
    expect(await db.nodes.where('threadId').equals(threadId).count()).toBe(0);
    expect(await db.attachments.where('threadId').equals(threadId).count()).toBe(0);
    expect(await db.runs.where('threadId').equals(threadId).count()).toBe(0);
    expect(await db.interactions.where('threadId').equals(threadId).count()).toBe(0);
    expect(await db.commandReceipts.get(`integration-client\u0000${submissionId}`)).toMatchObject({
      status: 'acknowledged',
      response: { type: 'command.ack', threadId },
    });

    client.events.length = 0;
    client.post({ type: 'thread.delete', threadId, submissionId });
    await client.waitForMatching(
      (event): event is Extract<AgentEvent, { type: 'command.ack' }> =>
        event.type === 'command.ack' && event.submissionId === submissionId,
    );
    expect(client.events.some((event) => event.type === 'command.rejected')).toBe(false);
  });

  it('rejects an enqueue serialized after deletion without creating an orphan run', async () => {
    const { host } = buildEngine();
    const client = connect(host);
    const threadId = await initThread(client);

    const deleteSubmission = client.post({ type: 'thread.delete', threadId });
    const enqueueSubmission = client.post({
      type: 'turn.enqueue',
      threadId,
      input: { text: 'must not become orphaned' },
    });
    await client.waitForMatching(
      (event): event is Extract<AgentEvent, { type: 'command.ack' }> =>
        event.type === 'command.ack' && event.submissionId === deleteSubmission,
    );
    const rejected = await client.waitForMatching(
      (event): event is Extract<AgentEvent, { type: 'command.rejected' }> =>
        event.type === 'command.rejected' && event.submissionId === enqueueSubmission,
    );

    expect(rejected).toMatchObject({ code: 'thread_not_found', threadId });
    expect(await db.runs.where('threadId').equals(threadId).count()).toBe(0);
    expect(
      await db.commandReceipts.get(`integration-client\u0000${enqueueSubmission}`),
    ).toMatchObject({
      status: 'rejected',
      response: { type: 'command.rejected', code: 'thread_not_found', threadId },
    });
  });

  it('replays thread.created for a duplicate thread creation submission', async () => {
    const { host } = buildEngine();
    const client = connect(host);
    client.post({ type: 'initialize', protocolVersion: 1 });
    await client.waitFor('initialized');
    const submissionId = 'stable-thread-create';
    client.post({ type: 'thread.create', submissionId, preset: 'preset-a' });
    const created = await client.waitFor('thread.created');
    await client.waitForMatching(
      (event): event is Extract<AgentEvent, { type: 'command.ack' }> =>
        event.type === 'command.ack' && event.submissionId === submissionId,
    );
    client.events.length = 0;

    client.post({ type: 'thread.create', submissionId, preset: 'preset-a' });
    const replayed = await client.waitFor('thread.created');

    expect(replayed.threadId).toBe(created.threadId);
    expect(await db.threads.count()).toBe(1);
  });

  it('atomically replays thread forks and rejects payload drift for the same submission', async () => {
    const { host } = buildEngine();
    const client = connect(host);
    const threadId = await initThread(client);
    const submissionId = 'stable-thread-fork';
    const command = {
      type: 'thread.fork' as const,
      submissionId,
      threadId,
      atNodeId: 'anchor-a',
    };

    client.post(command);
    const created = await client.waitForMatching(
      (event): event is Extract<AgentEvent, { type: 'thread.forked' }> =>
        event.type === 'thread.forked' && event.submissionId === submissionId,
    );
    await client.waitForMatching(
      (event): event is Extract<AgentEvent, { type: 'command.ack' }> =>
        event.type === 'command.ack' && event.submissionId === submissionId,
    );
    expect(await db.threads.count()).toBe(2);

    client.events.length = 0;
    client.post(command);
    const replayed = await client.waitForMatching(
      (event): event is Extract<AgentEvent, { type: 'thread.forked' }> =>
        event.type === 'thread.forked' && event.submissionId === submissionId,
    );
    expect(replayed.newThreadId).toBe(created.newThreadId);
    expect(await db.threads.count()).toBe(2);

    client.events.length = 0;
    client.post({ ...command, atNodeId: 'anchor-b' });
    const rejected = await client.waitForMatching(
      (event): event is Extract<AgentEvent, { type: 'command.rejected' }> =>
        event.type === 'command.rejected' && event.submissionId === submissionId,
    );
    expect(rejected).toMatchObject({ code: 'invalid_command' });
    expect(await db.threads.count()).toBe(2);
  });

  it('binds a queue update receipt to its original payload', async () => {
    const { host } = buildEngine();
    const client = connect(host);
    const threadId = await initThread(client);
    const queued = await new RunRepository(db).enqueue({
      threadId,
      clientId: 'seed-client',
      submissionId: 'seed-queued-run',
      input: { text: 'original' },
    });
    const submissionId = 'stable-queue-update';
    client.post({
      type: 'queue.update',
      submissionId,
      threadId,
      runId: queued.id,
      input: { text: 'first update' },
    });
    await client.waitForMatching(
      (event): event is Extract<AgentEvent, { type: 'command.ack' }> =>
        event.type === 'command.ack' && event.submissionId === submissionId,
    );

    client.events.length = 0;
    client.post({
      type: 'queue.update',
      submissionId,
      threadId,
      runId: queued.id,
      input: { text: 'conflicting update' },
    });
    const rejected = await client.waitForMatching(
      (event): event is Extract<AgentEvent, { type: 'command.rejected' }> =>
        event.type === 'command.rejected' && event.submissionId === submissionId,
    );

    expect(rejected).toMatchObject({ code: 'invalid_command' });
    expect(await db.runs.get(queued.id)).toMatchObject({
      input: { text: 'first update' },
      revision: 1,
    });
  });
});
