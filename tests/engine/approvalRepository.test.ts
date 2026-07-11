import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { PanelotDB } from '../../src/db/schema';
import { ThreadTree } from '../../src/db/tree';
import { ApprovalRepository } from '../../src/engine/approvalRepository';
import { RunRepository } from '../../src/engine/runRepository';

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
  await runs.transition(run.id, 'waiting_approval', {
    pendingTool: {
      itemId: 'call-a',
      toolName: 'write_page',
      params: {},
      effect: 'write',
      recovery: 'never-retry',
    },
  });
  const approval = await approvals.create({
    id: 'approval-a',
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
  });
  return { thread, run, approval };
}

describe('ApprovalRepository', () => {
  it('commits the decision and its audit node atomically', async () => {
    const { thread } = await createPendingApproval();
    now = 11_000;

    const decided = await approvals.decide('approval-a', { kind: 'accept' });

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
  });

  it('rolls the approval back if the audit node cannot be appended', async () => {
    const { thread } = await createPendingApproval();
    await db.threads.delete(thread.id);

    await expect(approvals.decide('approval-a', { kind: 'accept' })).rejects.toThrow(
      /thread .* not found/i,
    );
    expect(await db.approvals.get('approval-a')).toMatchObject({ status: 'pending' });
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
});
