import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PanelotDB } from '../../src/db/schema';
import { ThreadTree } from '../../src/db/tree';
import { RunRepository } from '../../src/engine/runRepository';
import {
  CommandReceiptRepository,
  createCommandTransactionContext,
} from '../../src/engine/commandReceipts';

let db: PanelotDB;
let runs: RunRepository;
let now: number;
let n = 0;

beforeEach(() => {
  db = new PanelotDB(`run-repo-test-${Date.now()}-${n++}`);
  now = 10_000;
  runs = new RunRepository(db, { now: () => now });
});

async function createThread(): Promise<string> {
  return (await new ThreadTree(db).createThread({ title: 'runtime' })).id;
}

describe('RunRepository', () => {
  it('persists the queued input and all turn overrides', async () => {
    const threadId = await createThread();
    const run = await runs.enqueue({
      threadId,
      clientId: 'client-a',
      submissionId: 'submission-a',
      input: { text: 'use the selected model' },
      overrides: {
        model: { connectionId: 'connection-b', modelId: 'model-c' },
        permissionPolicy: 'always',
        enabledToolLevels: ['L0'],
      },
    });

    expect(await runs.nextQueued(threadId)).toMatchObject({
      id: run.id,
      input: { text: 'use the selected model' },
      overrides: {
        model: { connectionId: 'connection-b', modelId: 'model-c' },
        permissionPolicy: 'always',
        enabledToolLevels: ['L0'],
      },
    });
  });

  it('commits enqueue with its receipt and rolls the run back if receipt completion fails', async () => {
    const threadId = await createThread();
    const command = createCommandTransactionContext({
      clientId: 'client-a',
      submissionId: 'atomic-enqueue',
      commandType: 'turn.enqueue',
    });
    const receipts = new CommandReceiptRepository(db, { now: () => now });
    await receipts.begin(command);
    vi.spyOn(db.commandReceipts, 'put').mockRejectedValueOnce(
      new Error('injected receipt write failure'),
    );
    const input = {
      threadId,
      clientId: command.clientId,
      submissionId: command.submissionId,
      input: { text: 'queued atomically' },
    };

    await expect(runs.enqueue(input, command)).rejects.toThrow(/injected receipt write failure/);
    expect(await db.runs.count()).toBe(0);
    expect(await db.commandReceipts.get('client-a\u0000atomic-enqueue')).toMatchObject({
      status: 'processing',
    });

    const run = await runs.enqueue(input, command);
    await expect(receipts.begin(command)).resolves.toMatchObject({
      kind: 'duplicate',
      response: { type: 'command.ack', threadId, runId: run.id, revision: 0 },
    });
  });

  it('commits queued updates and removals with their receipts', async () => {
    const threadId = await createThread();
    const run = await runs.enqueue({
      threadId,
      clientId: 'client-a',
      submissionId: 'queued-run',
      input: { text: 'original' },
    });
    const receipts = new CommandReceiptRepository(db, { now: () => now });
    const updateCommand = createCommandTransactionContext({
      clientId: 'client-a',
      submissionId: 'update-queued-run',
      commandType: 'queue.update',
    });
    await receipts.begin(updateCommand);
    vi.spyOn(db.commandReceipts, 'put').mockRejectedValueOnce(
      new Error('injected receipt write failure'),
    );

    await expect(
      runs.updateQueued(run.id, { input: { text: 'updated' } }, updateCommand),
    ).rejects.toThrow(/injected receipt write failure/);
    expect(await runs.get(run.id)).toMatchObject({
      input: { text: 'original' },
      state: 'queued',
      revision: 0,
    });
    expect(await db.commandReceipts.get('client-a\u0000update-queued-run')).toMatchObject({
      status: 'processing',
    });

    const updated = await runs.updateQueued(run.id, { input: { text: 'updated' } }, updateCommand);
    await expect(receipts.begin(updateCommand)).resolves.toMatchObject({
      kind: 'duplicate',
      response: { type: 'command.ack', threadId, runId: run.id, revision: updated.revision },
    });

    const removeCommand = createCommandTransactionContext({
      clientId: 'client-a',
      submissionId: 'remove-queued-run',
      commandType: 'queue.remove',
    });
    await receipts.begin(removeCommand);
    const removed = await runs.removeQueued(run.id, removeCommand);
    expect(removed).toMatchObject({ state: 'interrupted', revision: updated.revision + 1 });
    await expect(receipts.begin(removeCommand)).resolves.toMatchObject({
      kind: 'duplicate',
      response: { type: 'command.ack', threadId, runId: run.id, revision: removed.revision },
    });
  });

  it('increments revision on every durable state transition', async () => {
    const threadId = await createThread();
    const run = await runs.enqueue({
      threadId,
      clientId: 'client-a',
      submissionId: 'submission-a',
      input: { text: 'hello' },
    });

    const preparing = await runs.transition(run.id, 'preparing');
    const streaming = await runs.transition(run.id, 'streaming_model');

    expect(preparing.revision).toBe(1);
    expect(streaming.revision).toBe(2);
    await expect(runs.transition(run.id, 'queued')).rejects.toThrow(/streaming_model.*queued/);
  });

  it('atomically prepares one stable tool call and treats a repeated commit as idempotent', async () => {
    const threadId = await createThread();
    const run = await runs.enqueue({
      threadId,
      clientId: 'client-a',
      submissionId: 'prepare-tool-call',
      input: { text: 'inspect' },
    });
    await runs.transition(run.id, 'preparing');
    await runs.transition(run.id, 'streaming_model');
    const node = {
      id: 'tool-call:turn-a:call-a',
      type: 'tool_call' as const,
      payload: {
        itemId: 'call-a',
        toolName: 'read_page',
        params: { tabId: 7 },
        level: 'L1' as const,
      },
    };
    const pendingTool = {
      itemId: 'call-a',
      toolName: 'read_page',
      params: { tabId: 7 },
      target: { tabId: 7, origin: 'https://example.com' },
      effect: 'read' as const,
      recovery: 'retry-safe' as const,
    };

    const prepared = await runs.prepareToolCall(run.id, node, 'executing_tool', pendingTool);
    const repeated = await runs.prepareToolCall(run.id, node, 'executing_tool', pendingTool);

    expect(await db.nodes.where('threadId').equals(threadId).toArray()).toHaveLength(1);
    expect(await db.nodes.get(node.id)).toMatchObject(node);
    expect(prepared).toMatchObject({ state: 'executing_tool', pendingTool });
    expect(repeated.revision).toBe(prepared.revision);
  });

  it('rejects a repeated stable tool call when the complete pendingTool differs', async () => {
    const threadId = await createThread();
    const run = await runs.enqueue({
      threadId,
      clientId: 'client-a',
      submissionId: 'prepare-tool-call-collision',
      input: { text: 'inspect' },
    });
    await runs.transition(run.id, 'preparing');
    await runs.transition(run.id, 'streaming_model');
    const node = {
      id: 'tool-call:turn-collision:1:0',
      type: 'tool_call' as const,
      payload: {
        itemId: 'call-collision',
        toolName: 'read_page',
        params: { tabId: 7 },
        level: 'L1' as const,
      },
    };
    const pendingTool = {
      itemId: 'call-collision',
      toolName: 'read_page',
      params: { tabId: 7 },
      target: { tabId: 7, origin: 'https://example.com' },
      effect: 'read' as const,
      recovery: 'retry-safe' as const,
    };
    const prepared = await runs.prepareToolCall(run.id, node, 'executing_tool', pendingTool);

    await expect(
      runs.prepareToolCall(run.id, node, 'executing_tool', {
        ...pendingTool,
        target: { tabId: 8, origin: 'https://example.com' },
      }),
    ).rejects.toThrow(/pendingTool collision/);

    expect(await db.nodes.where('threadId').equals(threadId).count()).toBe(1);
    expect(await runs.get(run.id)).toEqual(prepared);
  });

  it('rolls back the tool_call node when its run transition cannot commit', async () => {
    const threadId = await createThread();
    const run = await runs.enqueue({
      threadId,
      clientId: 'client-a',
      submissionId: 'prepare-tool-call-rollback',
      input: { text: 'inspect' },
    });

    await expect(
      runs.prepareToolCall(
        run.id,
        {
          id: 'tool-call:turn-b:call-b',
          type: 'tool_call',
          payload: {
            itemId: 'call-b',
            toolName: 'read_page',
            params: {},
            level: 'L1',
          },
        },
        'executing_tool',
        {
          itemId: 'call-b',
          toolName: 'read_page',
          params: {},
          effect: 'read',
          recovery: 'retry-safe',
        },
      ),
    ).rejects.toThrow(/queued.*executing_tool/);

    expect(await db.nodes.where('threadId').equals(threadId).count()).toBe(0);
    expect(await runs.get(run.id)).toMatchObject({ state: 'queued' });
    expect((await runs.get(run.id))?.pendingTool).toBeUndefined();
  });

  it('recovers retry-safe work while pausing an uncertain write', async () => {
    const threadId = await createThread();
    const safe = await runs.enqueue({
      threadId,
      clientId: 'client-a',
      submissionId: 'safe',
      input: { text: 'read' },
    });
    await runs.transition(safe.id, 'preparing');
    await runs.transition(safe.id, 'executing_tool', {
      pendingTool: {
        itemId: 'tool-safe',
        toolName: 'snapshot',
        params: {},
        effect: 'read',
        recovery: 'inspect-first',
      },
    });

    const unsafe = await runs.enqueue({
      threadId,
      clientId: 'client-a',
      submissionId: 'unsafe',
      input: { text: 'write' },
    });
    await runs.transition(unsafe.id, 'preparing');
    await runs.transition(unsafe.id, 'executing_tool', {
      pendingTool: {
        itemId: 'tool-unsafe',
        toolName: 'submit',
        params: {},
        effect: 'write',
        recovery: 'never-retry',
      },
    });

    const recovered = await runs.recoverOpenRuns();
    expect(recovered).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: safe.id, state: 'preparing', recoveryAction: 'replay_tool' }),
        expect.objectContaining({
          id: unsafe.id,
          state: 'paused_uncertain',
          recoveryAction: 'request_resolution',
        }),
      ]),
    );
  });

  it('preserves recovery reasons and accepts the prior done label on stored runs', async () => {
    const threadId = await createThread();
    const paused = await runs.enqueue({
      threadId,
      clientId: 'client-a',
      submissionId: 'paused-reason',
      input: { text: 'pause' },
    });
    await runs.transition(paused.id, 'preparing');
    await runs.transition(paused.id, 'paused_budget', { stopReason: 'budget_pause' });

    const legacy = await runs.enqueue({
      threadId,
      clientId: 'client-a',
      submissionId: 'legacy-done',
      input: { text: 'old completion' },
    });
    await runs.transition(legacy.id, 'preparing');
    await runs.transition(legacy.id, 'streaming_model');
    await runs.transition(legacy.id, 'completed', { stopReason: 'done' });

    expect(await runs.recoverOpenRuns()).toContainEqual(
      expect.objectContaining({
        id: paused.id,
        state: 'paused_budget',
        stopReason: 'budget_pause',
        recoveryAction: 'none',
      }),
    );
    expect(await runs.get(legacy.id)).toMatchObject({
      state: 'completed',
      stopReason: 'done',
    });
  });

  it('commits usage and thread statistics in one transaction', async () => {
    const threadId = await createThread();
    const run = await runs.enqueue({
      threadId,
      clientId: 'client-a',
      submissionId: 'submission-a',
      input: { text: 'hello' },
    });
    await runs.transition(run.id, 'preparing');
    await runs.commitUsage(run.id, { input: 30, output: 12 }, 0.25);

    expect((await db.runs.get(run.id))?.usage).toEqual({ input: 30, output: 12 });
    expect((await db.threads.get(threadId))?.stats).toEqual({
      turns: 0,
      totalTokens: 42,
      costUsd: 0.25,
    });
  });

  it('commits an assistant node, usage, statistics, and run state in one transaction', async () => {
    const threadId = await createThread();
    const run = await runs.enqueue({
      threadId,
      clientId: 'client-a',
      submissionId: 'assistant-atomic',
      input: { text: 'hello' },
    });
    await runs.transition(run.id, 'preparing');
    await runs.transition(run.id, 'streaming_model');

    await runs.appendAssistantAndCommitUsage(
      run.id,
      {
        type: 'assistant_message',
        payload: {
          content: [{ type: 'text', text: 'done' }],
          model: 'model-a',
          connectionId: 'connection-a',
          usage: { input: 20, output: 5 },
          providerStopReason: 'max_tokens',
        },
      },
      { input: 20, output: 5 },
      0.1,
      'completed',
      { stepCursor: 1, stopReason: 'max_tokens' },
    );

    expect(await db.runs.get(run.id)).toMatchObject({
      state: 'completed',
      stopReason: 'max_tokens',
    });
    expect((await db.runs.get(run.id))?.usage).toEqual({ input: 20, output: 5 });
    expect((await db.threads.get(threadId))?.stats).toEqual({
      turns: 0,
      totalTokens: 25,
      costUsd: 0.1,
    });
    const nodes = await db.nodes.where('threadId').equals(threadId).toArray();
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.payload).toMatchObject({ providerStopReason: 'max_tokens' });
  });

  it('rolls back assistant usage when its run transition is invalid', async () => {
    const threadId = await createThread();
    const run = await runs.enqueue({
      threadId,
      clientId: 'client-a',
      submissionId: 'assistant-invalid',
      input: { text: 'hello' },
    });

    await expect(
      runs.appendAssistantAndCommitUsage(
        run.id,
        {
          type: 'assistant_message',
          payload: {
            content: [{ type: 'text', text: 'must roll back' }],
            model: 'model-a',
            connectionId: 'connection-a',
            usage: { input: 20, output: 5 },
          },
        },
        { input: 20, output: 5 },
        0.1,
        'completed',
      ),
    ).rejects.toThrow(/queued.*completed/);

    expect(await db.nodes.where('threadId').equals(threadId).count()).toBe(0);
    expect((await db.runs.get(run.id))?.usage).toBeUndefined();
    expect((await db.threads.get(threadId))?.stats.totalTokens).toBe(0);
  });

  it('rolls back a related node when the run transition cannot commit', async () => {
    const threadId = await createThread();
    const run = await runs.enqueue({
      threadId,
      clientId: 'client-a',
      submissionId: 'submission-atomic',
      input: { text: 'hello' },
    });

    await expect(
      runs.appendNodeAndTransition(
        run.id,
        {
          type: 'tool_result',
          payload: {
            itemId: 'tool-a',
            ok: true,
            contentForLlm: [{ type: 'text', text: 'done' }],
          },
        },
        'completed',
      ),
    ).rejects.toThrow(/queued.*completed/);

    expect(await db.nodes.where('threadId').equals(threadId).count()).toBe(0);
    expect((await db.runs.get(run.id))?.state).toBe('queued');
  });

  it('links user attachments to the committed message in the same transaction', async () => {
    const threadId = await createThread();
    const run = await runs.enqueue({
      threadId,
      clientId: 'client-a',
      submissionId: 'submission-with-file',
      input: { text: 'upload this', attachmentIds: ['attachment-a'] },
    });
    await db.attachments.add({
      id: 'attachment-a',
      threadId,
      createdAt: 1,
      kind: 'file',
      mime: 'text/plain',
      bytes: new Blob(['hello']),
      trust: 'trusted',
      provenance: 'user',
    });

    await runs.appendNodesAndTransition(
      run.id,
      [
        {
          id: 'message-a',
          type: 'user_message',
          payload: { content: [{ type: 'text', text: 'upload this' }] },
        },
      ],
      'preparing',
      {},
      { attachmentIds: ['attachment-a'], nodeId: 'message-a' },
    );

    expect((await db.attachments.get('attachment-a'))?.refs?.nodeIds).toEqual(['message-a']);
  });

  it('durably accepts a steer without moving the thread leaf, then materializes it at delivery', async () => {
    const threadId = await createThread();
    const run = await runs.enqueue({
      threadId,
      clientId: 'client-a',
      submissionId: 'submission-steer-file',
      input: { text: 'start' },
    });
    await runs.transition(run.id, 'preparing');
    await runs.transition(run.id, 'streaming_model');
    await db.attachments.add({
      id: 'attachment-steer',
      threadId,
      createdAt: 1,
      kind: 'file',
      mime: 'text/plain',
      bytes: new Blob(['steer']),
      trust: 'trusted',
      provenance: 'user',
    });

    const updated = await runs.acceptSteer(
      run.id,
      {
        id: 'steer-node',
        type: 'user_message',
        payload: { content: [{ type: 'text', text: 'also inspect this' }], steered: true },
      },
      { attachmentIds: ['attachment-steer'], nodeId: 'steer-node' },
    );

    expect(updated).toMatchObject({
      state: 'streaming_model',
      pendingSteers: [{ nodeId: 'steer-node' }],
    });
    expect(await db.nodes.get('steer-node')).toBeUndefined();
    expect((await db.threads.get(threadId))?.leafId).toBeNull();
    expect((await db.attachments.get('attachment-steer'))?.refs).toMatchObject({
      nodeIds: ['steer-node'],
      runIds: [run.id],
    });

    await runs.materializeSteers(run.id, ['steer-node']);
    expect(await db.nodes.get('steer-node')).toMatchObject({ threadId, type: 'user_message' });
    expect((await db.threads.get(threadId))?.leafId).toBe('steer-node');
    expect((await runs.get(run.id))?.pendingSteers).toEqual([]);
  });

  it('rolls back a steer node when attachment linking fails', async () => {
    const threadId = await createThread();
    const run = await runs.enqueue({
      threadId,
      clientId: 'client-a',
      submissionId: 'submission-steer-invalid-file',
      input: { text: 'start' },
    });
    await runs.transition(run.id, 'preparing');
    await runs.transition(run.id, 'streaming_model');

    await expect(
      runs.acceptSteer(
        run.id,
        {
          id: 'steer-rollback',
          type: 'user_message',
          payload: { content: [{ type: 'text', text: 'must roll back' }], steered: true },
        },
        { attachmentIds: ['missing-attachment'], nodeId: 'steer-rollback' },
      ),
    ).rejects.toThrow(/Attachment not found/);

    expect(await db.nodes.get('steer-rollback')).toBeUndefined();
    expect((await db.threads.get(threadId))?.leafId).toBeNull();
    expect(await db.runs.get(run.id)).toMatchObject({ state: 'streaming_model' });
  });

  it('rejects delayed steer acceptance after the run becomes terminal', async () => {
    const threadId = await createThread();
    const run = await runs.enqueue({
      threadId,
      clientId: 'client-a',
      submissionId: 'submission-terminal-steer',
      input: { text: 'start' },
    });
    await runs.transition(run.id, 'preparing');
    await runs.transition(run.id, 'streaming_model');
    await runs.acceptSteer(run.id, {
      id: 'accepted-before-close',
      type: 'user_message',
      payload: { content: [{ type: 'text', text: 'accepted before close' }], steered: true },
    });
    await runs.transition(run.id, 'completed');

    await expect(
      runs.acceptSteer(run.id, {
        id: 'too-late',
        type: 'user_message',
        payload: { content: [{ type: 'text', text: 'too late' }], steered: true },
      }),
    ).rejects.toThrow(/does not accept steering.*completed/);
    await expect(runs.materializeSteers(run.id, ['accepted-before-close'])).rejects.toThrow(
      /terminal.*completed/,
    );
    expect(await db.nodes.get('too-late')).toBeUndefined();
    expect(await db.nodes.get('accepted-before-close')).toBeUndefined();
    expect((await runs.get(run.id))?.pendingSteers).toEqual([
      expect.objectContaining({ nodeId: 'accepted-before-close' }),
    ]);
  });

  it('retains pending steers for materialization after repository restart', async () => {
    const threadId = await createThread();
    const run = await runs.enqueue({
      threadId,
      clientId: 'client-a',
      submissionId: 'submission-restart-steer',
      input: { text: 'start' },
    });
    await runs.transition(run.id, 'preparing');
    await runs.transition(run.id, 'streaming_model');
    await runs.acceptSteer(run.id, {
      id: 'restart-steer',
      type: 'user_message',
      payload: {
        content: [{ type: 'text', text: 'survive worker restart' }],
        steered: true,
      },
    });

    const restarted = new RunRepository(db, { now: () => now });
    expect((await restarted.get(run.id))?.pendingSteers).toEqual([
      expect.objectContaining({ nodeId: 'restart-steer' }),
    ]);
    await restarted.materializeSteers(run.id, ['restart-steer']);

    const thread = await db.threads.get(threadId);
    const path = await new ThreadTree(db).getPath(threadId, thread!.leafId!);
    expect(path.at(-1)).toMatchObject({
      id: 'restart-steer',
      type: 'user_message',
      payload: { steered: true },
    });
  });

  it('persists admission sequence across restart despite inverse transaction completion', async () => {
    const threadId = await createThread();
    const run = await runs.enqueue({
      threadId,
      clientId: 'client-a',
      submissionId: 'submission-restart-order',
      input: { text: 'start' },
    });
    await runs.transition(run.id, 'preparing');
    await runs.transition(run.id, 'streaming_model');
    await runs.acceptSteer(
      run.id,
      {
        id: 'restart-order-b',
        type: 'user_message',
        payload: { content: [{ type: 'text', text: 'restart order B' }], steered: true },
      },
      undefined,
      1,
    );
    await runs.acceptSteer(
      run.id,
      {
        id: 'restart-order-a',
        type: 'user_message',
        payload: { content: [{ type: 'text', text: 'restart order A' }], steered: true },
      },
      undefined,
      0,
    );

    const restarted = new RunRepository(db, { now: () => now });
    const pending = (await restarted.get(run.id))!.pendingSteers!;
    const orderedIds = [...pending]
      .sort(
        (left, right) =>
          (left.admissionSequence ?? 0) - (right.admissionSequence ?? 0) ||
          left.nodeId.localeCompare(right.nodeId),
      )
      .map((steer) => steer.nodeId);
    await restarted.materializeSteers(run.id, orderedIds);

    const path = await new ThreadTree(db).getPath(
      threadId,
      (await db.threads.get(threadId))!.leafId!,
    );
    expect(
      path.map((node) => node.id).filter((nodeId) => nodeId.startsWith('restart-order-')),
    ).toEqual(['restart-order-a', 'restart-order-b']);
  });

  it('edits and removes only queued runs', async () => {
    const threadId = await createThread();
    const run = await runs.enqueue({
      threadId,
      clientId: 'client-a',
      submissionId: 'submission-a',
      input: { text: 'before' },
    });

    const edited = await runs.updateQueued(run.id, {
      input: { text: 'after' },
      overrides: { permissionPolicy: 'always' },
    });
    expect(edited).toMatchObject({
      state: 'queued',
      revision: 1,
      input: { text: 'after' },
      overrides: { permissionPolicy: 'always' },
    });

    const removed = await runs.removeQueued(run.id);
    expect(removed).toMatchObject({ state: 'interrupted', revision: 2 });
    await expect(runs.updateQueued(run.id, { input: { text: 'too late' } })).rejects.toThrow(
      /not queued/,
    );
  });
});
