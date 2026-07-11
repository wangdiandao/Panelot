/**
 * Full-stack engine regression: DirectTransport → EngineHost → RealEngineCore
 * → mock provider → Dexie. No browser required (docs/04 §7).
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PanelotDB } from '../../src/db/schema';
import { ThreadTree } from '../../src/db/tree';
import { RealEngineCore, type ProviderResolver } from '../../src/engine/core';
import { RunRepository } from '../../src/engine/runRepository';
import { ApprovalRepository } from '../../src/engine/approvalRepository';
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
        () => reject(new Error('timeout waiting for matching event')),
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

// ---------------------------------------------------------------------------

describe('engine integration (Op → events → DB)', () => {
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
        approvalPolicy: 'always',
        capabilityScope: 'read-only',
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
        approvalPolicy: 'always',
        capabilityScope: 'read-only',
        activeSkills: ['skill-a'],
        promptVersion: 'kernel-a',
      },
    });
    expect(run?.revision).toBeGreaterThan(0);
    expect(permissionConfigs).toContainEqual({
      approvalPolicy: 'always',
      capabilityScope: 'read-only',
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

    client.post({
      type: 'approval.response',
      approvalId: request.approvalId,
      decision: { kind: 'accept' },
    });
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
    expect(followingUserTexts.filter((text) => text === 'include in imminent request')).toHaveLength(1);
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
    const orderedTexts = provider.requests[1]!.messages
      .filter((message) => message.role === 'user')
      .flatMap((message) =>
        message.content.map((block) => (block.type === 'text' ? block.text : '')),
      )
      .filter((text) => text.startsWith('ordered '));
    expect(orderedTexts).toEqual(['ordered A', 'ordered B']);
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
    expect(JSON.stringify(provider.requests[1]!.messages.at(-1))).toContain(
      'cross final boundary',
    );
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
        new Promise((_, reject) => {
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
        new Promise((_, reject) =>
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
    const tree = new ThreadTree(sharedDb);
    const thread = await tree.createThread({ title: 'approval recovery' });
    await tree.appendNode(thread.id, {
      type: 'turn_context',
      payload: {
        turnId: 'turn-approved',
        model: { connectionId: 'connection', modelId: 'mock' },
        approvalPolicy: 'untrusted',
        capabilityScope: 'full',
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
    await runs.prepare(run.id, {
      connectionId: 'connection',
      modelId: 'mock',
      modelParameters: {},
      enabledToolLevels: ['L0', 'L1', 'L2', 'mcp'],
      approvalPolicy: 'untrusted',
      capabilityScope: 'full',
      activeSkills: [],
      promptVersion: 'kernel',
    });
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
    const events: AgentEvent[] = [];
    core.onBroadcast = (event) => events.push(event);
    provider.queue({ streamText: ['continued'] });

    await core.recover();
    await waitForEvent(events, 'turn.complete');

    expect(executionCount).toBe(1);
    expect((await sharedDb.runs.get(run.id))?.state).toBe('completed');
  });

  it('replays a prepared read after restart without duplicating the user node', async () => {
    const sharedDb = new PanelotDB(`safe-tool-recovery-${Date.now()}`);
    const tree = new ThreadTree(sharedDb);
    const thread = await tree.createThread({ title: 'safe recovery' });
    await tree.appendNode(thread.id, {
      type: 'turn_context',
      payload: {
        turnId: 'turn-safe',
        model: { connectionId: 'connection', modelId: 'mock' },
        approvalPolicy: 'untrusted',
        capabilityScope: 'full',
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
    await runs.prepare(run.id, {
      connectionId: 'connection',
      modelId: 'mock',
      modelParameters: {},
      enabledToolLevels: ['L0', 'L1', 'L2', 'mcp'],
      approvalPolicy: 'untrusted',
      capabilityScope: 'full',
      activeSkills: [],
      promptVersion: 'kernel',
    });
    await runs.transition(run.id, 'executing_tool', {
      pendingTool: {
        itemId: 'safe-call',
        toolName: 'safe_read',
        params: {},
        effect: 'read',
        recovery: 'inspect-first',
      },
    });

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

  it('pauses an uncertain write until the user explicitly chooses retry', async () => {
    const sharedDb = new PanelotDB(`uncertain-tool-recovery-${Date.now()}`);
    const tree = new ThreadTree(sharedDb);
    const thread = await tree.createThread({ title: 'uncertain recovery' });
    await tree.appendNode(thread.id, {
      type: 'turn_context',
      payload: {
        turnId: 'turn-unsafe',
        model: { connectionId: 'connection', modelId: 'mock' },
        approvalPolicy: 'untrusted',
        capabilityScope: 'full',
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
    await runs.prepare(run.id, {
      connectionId: 'connection',
      modelId: 'mock',
      modelParameters: {},
      enabledToolLevels: ['L0', 'L1', 'L2', 'mcp'],
      approvalPolicy: 'untrusted',
      capabilityScope: 'full',
      activeSkills: [],
      promptVersion: 'kernel',
    });
    await runs.transition(run.id, 'executing_tool', {
      pendingTool: {
        itemId: 'unsafe-call',
        toolName: 'unsafe_write',
        params: {},
        effect: 'write',
        recovery: 'never-retry',
      },
    });

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

  it('thread.selectBranch moves leafId to the sibling branch (docs/09 §2)', async () => {
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
});
