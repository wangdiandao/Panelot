import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PanelotDB } from '../../src/db/schema';
import { ThreadTree } from '../../src/db/tree';
import { InteractionRepository } from '../../src/engine/interactionRepository';
import { RunRepository } from '../../src/engine/runRepository';
import {
  CommandReceiptRepository,
  createCommandTransactionContext,
} from '../../src/engine/commandReceipts';

let db: PanelotDB;
let interactions: InteractionRepository;
let now: number;
let sequence = 0;

beforeEach(() => {
  db = new PanelotDB(`interaction-repo-test-${Date.now()}-${sequence++}`);
  now = 10_000;
  interactions = new InteractionRepository(db, { now: () => now });
});

async function createPendingInteraction() {
  const thread = await new ThreadTree(db).createThread({ title: 'interaction' });
  const runs = new RunRepository(db, { now: () => now });
  const run = await runs.enqueue({
    threadId: thread.id,
    clientId: 'client-a',
    submissionId: 'submission-a',
    input: { text: 'ask' },
  });
  await runs.transition(run.id, 'preparing');
  const created = await interactions.createPendingWork({
    id: 'interaction-a',
    threadId: thread.id,
    runId: run.id,
    turnId: run.turnId,
    itemId: 'call-a',
    request: {
      kind: 'ask_user',
      questions: [{ id: 'choice', question: 'Which option?' }],
    },
    pendingTool: {
      itemId: 'call-a',
      toolName: 'ask_user',
      params: {},
      effect: 'read',
      recovery: 'retry-safe',
    },
    toolCallNode: {
      id: 'tool-call:interaction-a:1:0',
      type: 'tool_call',
      payload: {
        itemId: 'call-a',
        toolName: 'ask_user',
        params: {},
        level: 'builtin',
      },
    },
  });
  return { thread, ...created };
}

describe('InteractionRepository', () => {
  it('durably suspends a run and exposes the pending request', async () => {
    const { thread, run } = await createPendingInteraction();

    expect(await db.runs.get(run.id)).toMatchObject({
      state: 'waiting_interaction',
      pendingTool: { itemId: 'call-a', toolName: 'ask_user' },
    });
    expect(await interactions.pendingForThread(thread.id)).toEqual([
      expect.objectContaining({
        interactionId: 'interaction-a',
        turnId: run.turnId,
        itemId: 'call-a',
        request: { kind: 'ask_user', questions: [{ id: 'choice', question: 'Which option?' }] },
      }),
    ]);
    expect(
      await db.nodes
        .where('threadId')
        .equals(thread.id)
        .filter((node) => node.type === 'tool_call')
        .count(),
    ).toBe(1);
  });

  it('records the response once and atomically claims one continuation', async () => {
    const { thread, run } = await createPendingInteraction();
    now = 11_000;
    const response = {
      kind: 'submit' as const,
      value: { answers: [{ id: 'choice', value: 'Option A' }] },
    };

    await interactions.resolve('interaction-a', response);
    await interactions.resolve('interaction-a', { kind: 'cancel' });
    const claims = await Promise.all([
      interactions.claimResolvedContinuation('interaction-a'),
      interactions.claimResolvedContinuation('interaction-a'),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await db.runs.get(run.id)).toMatchObject({
      state: 'streaming_model',
      pendingTool: undefined,
    });
    const nodes = await db.nodes.where('threadId').equals(thread.id).toArray();
    expect(nodes.filter((node) => node.type === 'interaction_response')).toHaveLength(1);
    expect(nodes.filter((node) => node.type === 'tool_result')).toHaveLength(1);
    expect(nodes.find((node) => node.type === 'tool_result')?.payload).toMatchObject({
      itemId: 'call-a',
      ok: true,
      provenance: 'user',
    });
    expect(await interactions.pendingCountForThread(thread.id)).toBe(0);
  });

  it('commits a response with its receipt and rolls the whole unit back on receipt failure', async () => {
    const { thread, run } = await createPendingInteraction();
    const command = createCommandTransactionContext({
      clientId: 'client-a',
      submissionId: 'interaction-response-a',
      commandType: 'interaction.response',
    });
    const receipts = new CommandReceiptRepository(db, { now: () => now });
    await receipts.begin(command);
    vi.spyOn(db.commandReceipts, 'put').mockRejectedValueOnce(
      new Error('injected receipt write failure'),
    );
    const response = {
      kind: 'submit' as const,
      value: { answers: [{ id: 'choice', value: 'Option A' }] },
    };

    await expect(interactions.resolve('interaction-a', response, command)).rejects.toThrow(
      /injected receipt write failure/,
    );
    expect(await db.interactions.get('interaction-a')).toMatchObject({ status: 'pending' });
    expect(
      await db.nodes
        .where('threadId')
        .equals(thread.id)
        .filter((node) => node.type === 'interaction_response')
        .count(),
    ).toBe(0);
    expect(await db.runs.get(run.id)).toMatchObject({
      state: 'waiting_interaction',
      revision: 2,
    });
    expect(await db.commandReceipts.get('client-a\u0000interaction-response-a')).toMatchObject({
      status: 'processing',
    });

    await interactions.resolve('interaction-a', response, command);
    await expect(receipts.begin(command)).resolves.toEqual({
      kind: 'duplicate',
      response: {
        type: 'command.ack',
        threadId: thread.id,
        runId: run.id,
        revision: 3,
      },
    });
  });

  it('rejects a new command that conflicts with an already persisted response', async () => {
    const { thread, run } = await createPendingInteraction();
    const originalResponse = {
      kind: 'submit' as const,
      value: { answers: [{ id: 'choice', value: 'Option A' }] },
    };
    await interactions.resolve('interaction-a', originalResponse);
    const command = createCommandTransactionContext({
      clientId: 'client-b',
      submissionId: 'conflicting-interaction-response',
      commandType: 'interaction.response',
    });
    const receipts = new CommandReceiptRepository(db, { now: () => now });
    await receipts.begin(command);

    await interactions.resolve('interaction-a', { kind: 'cancel' }, command);

    expect(await db.interactions.get('interaction-a')).toMatchObject({
      status: 'resolved',
      response: originalResponse,
    });
    expect(
      await db.nodes
        .where('threadId')
        .equals(thread.id)
        .filter((node) => node.type === 'interaction_response')
        .count(),
    ).toBe(1);
    expect(await db.runs.get(run.id)).toMatchObject({ revision: 3 });
    await expect(receipts.begin(command)).resolves.toEqual({
      kind: 'duplicate',
      response: {
        type: 'command.rejected',
        code: 'invalid_command',
        message: 'Interaction interaction-a was already resolved with a different response.',
        threadId: thread.id,
        revision: 3,
      },
    });
  });
});
