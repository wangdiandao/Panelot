import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PanelotDB } from '../../src/db/schema';
import { ThreadTree } from '../../src/db/tree';
import { ApprovalRepository } from '../../src/engine/approvalRepository';
import { RunRepository } from '../../src/engine/runRepository';
import {
  CommandReceiptRepository,
  createCommandTransactionContext,
} from '../../src/engine/commandReceipts';

let db: PanelotDB;
let approvals: ApprovalRepository;
let now: number;
let sequence = 0;

beforeEach(() => {
  db = new PanelotDB(`approval-repo-test-${Date.now()}-${sequence++}`);
  now = 10_000;
  approvals = new ApprovalRepository(db, { now: () => now });
});

async function createPendingApproval() {
  const thread = await new ThreadTree(db).createThread({ title: 'approval' });
  const runs = new RunRepository(db, { now: () => now });
  const run = await runs.enqueue({
    threadId: thread.id,
    clientId: 'client-a',
    submissionId: 'submission-a',
    input: { text: 'write' },
  });
  await runs.transition(run.id, 'preparing');
  const { approval } = await approvals.createPendingWork({
    id: 'approval-a',
    threadId: thread.id,
    runId: run.id,
    turnId: run.turnId,
    deadlineAt: now + 300_000,
    pendingTool: {
      itemId: 'call-a',
      toolName: 'write_page',
      params: {},
      effect: 'write',
      recovery: 'never-retry',
    },
    toolCallNode: {
      id: 'tool-call:approval-a:1:0',
      type: 'tool_call',
      payload: {
        itemId: 'call-a',
        toolName: 'write_page',
        params: {},
        level: 'L1',
      },
    },
    request: {
      tool: 'write_page',
      label: 'Write page',
      params: {},
      targetOrigin: 'https://example.test',
      flags: [],
    },
  });
  return { thread, run, approval };
}

describe('ApprovalRepository', () => {
  it('commits the decision and its audit node atomically', async () => {
    const { thread, run } = await createPendingApproval();
    now = 11_000;
    const command = createCommandTransactionContext({
      clientId: 'client-a',
      submissionId: 'approval-response-a',
      commandType: 'approval.response',
    });
    const receipts = new CommandReceiptRepository(db, { now: () => now });
    await receipts.begin(command);

    const decided = await approvals.decide('approval-a', { kind: 'accept' }, command);

    expect(await db.approvals.get('approval-a')).toMatchObject({
      status: 'decided',
      decision: { kind: 'accept' },
      decidedAt: 11_000,
    });
    const decisionNodes = await db.nodes
      .where('threadId')
      .equals(thread.id)
      .filter((node) => node.type === 'approval_decision')
      .toArray();
    expect(decisionNodes).toHaveLength(1);
    expect(decisionNodes[0]?.payload).toMatchObject({
      approvalId: 'approval-a',
      decision: { kind: 'accept' },
      decidedAt: 11_000,
    });
    expect(await db.runs.get(decided.runId)).toMatchObject({
      state: 'waiting_approval',
      revision: 3,
    });
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

  it('atomically persists the tool call, approval, and waiting run state', async () => {
    const { thread, run } = await createPendingApproval();

    expect(
      await db.nodes
        .where('threadId')
        .equals(thread.id)
        .filter((node) => node.type === 'tool_call')
        .toArray(),
    ).toEqual([
      expect.objectContaining({
        id: 'tool-call:approval-a:1:0',
        payload: expect.objectContaining({ itemId: 'call-a', toolName: 'write_page' }),
      }),
    ]);
    expect(await db.approvals.get('approval-a')).toMatchObject({ status: 'pending' });
    expect(await db.runs.get(run.id)).toMatchObject({
      state: 'waiting_approval',
      pendingTool: { itemId: 'call-a', toolName: 'write_page' },
    });
  });

  it('rolls the approval back if the audit node cannot be appended', async () => {
    const { thread } = await createPendingApproval();
    await db.threads.delete(thread.id);

    await expect(approvals.decide('approval-a', { kind: 'accept' })).rejects.toThrow(
      /thread .* not found/i,
    );
    expect(await db.approvals.get('approval-a')).toMatchObject({ status: 'pending' });
  });

  it('rolls back the decision, audit node, and run revision if receipt completion fails', async () => {
    const { thread, run } = await createPendingApproval();
    const command = createCommandTransactionContext({
      clientId: 'client-a',
      submissionId: 'approval-receipt-failure',
      commandType: 'approval.response',
    });
    const receipts = new CommandReceiptRepository(db, { now: () => now });
    await receipts.begin(command);
    vi.spyOn(db.commandReceipts, 'put').mockRejectedValueOnce(
      new Error('injected receipt write failure'),
    );

    await expect(approvals.decide('approval-a', { kind: 'accept' }, command)).rejects.toThrow(
      /injected receipt write failure/,
    );

    expect(await db.approvals.get('approval-a')).toMatchObject({ status: 'pending' });
    expect(
      await db.nodes
        .where('threadId')
        .equals(thread.id)
        .filter((node) => node.type === 'approval_decision')
        .count(),
    ).toBe(0);
    expect(await db.runs.get(run.id)).toMatchObject({
      state: 'waiting_approval',
      revision: 2,
    });
    expect(await db.commandReceipts.get('client-a\u0000approval-receipt-failure')).toMatchObject({
      status: 'processing',
    });

    await expect(
      approvals.decide('approval-a', { kind: 'accept' }, command),
    ).resolves.toMatchObject({
      status: 'decided',
      decision: { kind: 'accept' },
    });
    await expect(receipts.begin(command)).resolves.toMatchObject({
      kind: 'duplicate',
      response: { type: 'command.ack', threadId: thread.id, runId: run.id, revision: 3 },
    });
  });

  it('does not append duplicate audit nodes for a repeated decision', async () => {
    const { thread } = await createPendingApproval();

    await approvals.decide('approval-a', { kind: 'accept' });
    await approvals.decide('approval-a', { kind: 'accept' });

    expect(
      await db.nodes
        .where('threadId')
        .equals(thread.id)
        .filter((node) => node.type === 'approval_decision')
        .count(),
    ).toBe(1);
  });

  it('atomically claims a decided continuation only once', async () => {
    const { run } = await createPendingApproval();
    await approvals.decide('approval-a', { kind: 'accept' });

    const claims = await Promise.all([
      approvals.claimDecidedContinuation('approval-a'),
      approvals.claimDecidedContinuation('approval-a'),
    ]);

    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
    expect(claims.find((claim) => claim !== null)?.run).toMatchObject({
      id: run.id,
      state: 'executing_tool',
      pendingTool: { startedAt: 10_000 },
    });
    expect(await db.runs.get(run.id)).toMatchObject({
      state: 'executing_tool',
      pendingTool: { startedAt: 10_000 },
    });
  });

  it('keeps the run and approval atomic when the run write fails', async () => {
    const thread = await new ThreadTree(db).createThread({ title: 'atomic approval' });
    const runs = new RunRepository(db, { now: () => now });
    const run = await runs.enqueue({
      threadId: thread.id,
      clientId: 'client-a',
      submissionId: 'submission-atomic',
      input: { text: 'write' },
    });
    await runs.transition(run.id, 'preparing');
    vi.spyOn(db.runs, 'put').mockRejectedValueOnce(new Error('injected run write failure'));

    await expect(
      approvals.createPendingWork({
        id: 'approval-atomic',
        threadId: thread.id,
        runId: run.id,
        turnId: run.turnId,
        request: {
          tool: 'write_page',
          label: 'Write page',
          params: {},
          targetOrigin: 'https://example.test',
          flags: [],
        },
        pendingTool: {
          itemId: 'call-atomic',
          toolName: 'write_page',
          params: {},
          effect: 'write',
          recovery: 'never-retry',
        },
        toolCallNode: {
          id: 'tool-call:approval-atomic:1:0',
          type: 'tool_call',
          payload: {
            itemId: 'call-atomic',
            toolName: 'write_page',
            params: {},
            level: 'L1',
          },
        },
        deadlineAt: now + 300_000,
      }),
    ).rejects.toThrow(/injected run write failure/);

    expect(await db.approvals.get('approval-atomic')).toBeUndefined();
    expect(await db.nodes.where('threadId').equals(thread.id).count()).toBe(0);
    expect(await db.runs.get(run.id)).toMatchObject({ state: 'preparing', revision: 1 });
  });

  it('keeps the first decision when a late response proposes a different result', async () => {
    await createPendingApproval();
    await approvals.decide('approval-a', { kind: 'cancel' });

    await expect(approvals.decide('approval-a', { kind: 'accept' })).resolves.toMatchObject({
      decision: { kind: 'cancel' },
    });
  });

  it('rejects a new command that conflicts with an already persisted decision', async () => {
    const { thread, run } = await createPendingApproval();
    await approvals.decide('approval-a', { kind: 'cancel' });
    const command = createCommandTransactionContext({
      clientId: 'client-b',
      submissionId: 'conflicting-approval-response',
      commandType: 'approval.response',
    });
    const receipts = new CommandReceiptRepository(db, { now: () => now });
    await receipts.begin(command);

    await approvals.decide('approval-a', { kind: 'accept' }, command);

    expect(await db.approvals.get('approval-a')).toMatchObject({
      status: 'decided',
      decision: { kind: 'cancel' },
    });
    expect(
      await db.nodes
        .where('threadId')
        .equals(thread.id)
        .filter((node) => node.type === 'approval_decision')
        .count(),
    ).toBe(1);
    expect(await db.runs.get(run.id)).toMatchObject({ revision: 3 });
    await expect(receipts.begin(command)).resolves.toEqual({
      kind: 'duplicate',
      response: {
        type: 'command.rejected',
        code: 'invalid_command',
        message: 'Approval approval-a was already decided with a different decision.',
        threadId: thread.id,
        revision: 3,
      },
    });
  });
});
