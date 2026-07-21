import type { PanelotDB } from '../db/schema';
import type { ApprovalRecord, PendingToolExecution, RunRecord } from '../db/types';
import { ThreadTree, type AppendNodeInput } from '../db/tree';
import type {
  ApprovalDecision,
  ApprovalRequestPayload,
  PendingApproval,
} from '../messaging/protocol';
import { assertRunTransition } from './runState';
import {
  assertPreparedToolCall,
  persistStableToolCallNode,
  stablePersistenceKey,
} from './toolCallPersistence';
import {
  completeCommandReceiptInTransaction,
  type CommandTransactionContext,
} from './commandReceipts';

interface ApprovalRepositoryOptions {
  now?: () => number;
}

export class ApprovalRepository {
  private readonly now: () => number;

  constructor(
    private readonly db: PanelotDB,
    options: ApprovalRepositoryOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  async create(input: {
    id: string;
    threadId: string;
    runId: string;
    turnId: string;
    request: ApprovalRequestPayload;
    deadlineAt?: number;
  }): Promise<ApprovalRecord> {
    const record: ApprovalRecord = {
      ...input,
      status: 'pending',
      requestedAt: this.now(),
    };
    await this.db.approvals.add(record);
    return record;
  }

  async createPendingWork(input: {
    id: string;
    threadId: string;
    runId: string;
    turnId: string;
    request: ApprovalRequestPayload;
    pendingTool: PendingToolExecution;
    toolCallNode: AppendNodeInput;
    deadlineAt: number;
  }): Promise<{ approval: ApprovalRecord; run: RunRecord }> {
    const toolCallNode = input.toolCallNode;
    assertPreparedToolCall(toolCallNode, input.pendingTool);
    return this.db.transaction(
      'rw',
      [this.db.approvals, this.db.runs, this.db.threads, this.db.nodes],
      async () => {
        const run = await this.db.runs.get(input.runId);
        if (!run || run.threadId !== input.threadId || run.turnId !== input.turnId) {
          throw new Error(`Run not found for approval: ${input.id}`);
        }
        assertRunTransition(run.state, 'waiting_approval');
        await persistStableToolCallNode(this.db, input.threadId, toolCallNode);
        const requestedAt = this.now();
        const approval: ApprovalRecord = {
          id: input.id,
          threadId: input.threadId,
          runId: input.runId,
          turnId: input.turnId,
          request: structuredClone(input.request),
          status: 'pending',
          requestedAt,
          deadlineAt: input.deadlineAt,
        };
        const updatedRun: RunRecord = {
          ...run,
          state: 'waiting_approval',
          pendingTool: structuredClone(input.pendingTool),
          revision: run.revision + 1,
          updatedAt: requestedAt,
        };
        await this.db.approvals.add(approval);
        await this.db.runs.put(updatedRun);
        return { approval, run: updatedRun };
      },
    );
  }

  async decide(
    id: string,
    decision: ApprovalDecision,
    command?: CommandTransactionContext,
  ): Promise<ApprovalRecord> {
    if (command && command.commandType !== 'approval.response') {
      throw new Error(`Invalid command transaction for approval decision: ${command.commandType}`);
    }
    return this.db.transaction(
      'rw',
      [this.db.approvals, this.db.runs, this.db.threads, this.db.nodes, this.db.commandReceipts],
      async () => {
        const current = await this.db.approvals.get(id);
        if (!current) throw new Error(`Approval not found: ${id}`);
        const run = await this.db.runs.get(current.runId);
        if (!run || run.threadId !== current.threadId) {
          throw new Error(`Run not found for approval: ${id}`);
        }
        if (current.status === 'decided') {
          if (command) {
            const response =
              stablePersistenceKey(current.decision) === stablePersistenceKey(decision)
                ? {
                    type: 'command.ack' as const,
                    threadId: current.threadId,
                    runId: run.id,
                    revision: run.revision,
                  }
                : {
                    type: 'command.rejected' as const,
                    code: 'invalid_command',
                    message: `Approval ${id} was already decided with a different decision.`,
                    threadId: current.threadId,
                    revision: run.revision,
                  };
            await completeCommandReceiptInTransaction(this.db, command, response, this.now());
          }
          return current;
        }
        const decidedAt = this.now();
        const updated: ApprovalRecord = {
          ...current,
          status: 'decided',
          decision,
          decidedAt,
        };
        await new ThreadTree(this.db).appendNode(current.threadId, {
          ts: decidedAt,
          type: 'approval_decision',
          payload: {
            approvalId: current.id,
            request: current.request,
            decision,
            decidedAt,
          },
        });
        await this.db.approvals.put(updated);
        const updatedRun: RunRecord = {
          ...run,
          revision: run.revision + 1,
          updatedAt: decidedAt,
        };
        await this.db.runs.put(updatedRun);
        if (command) {
          await completeCommandReceiptInTransaction(
            this.db,
            command,
            {
              type: 'command.ack',
              threadId: current.threadId,
              runId: run.id,
              revision: updatedRun.revision,
            },
            decidedAt,
          );
        }
        return updated;
      },
    );
  }

  async claimDecidedContinuation(
    id: string,
  ): Promise<{ approval: ApprovalRecord; run: RunRecord } | null> {
    return this.db.transaction('rw', [this.db.approvals, this.db.runs], async () => {
      const approval = await this.db.approvals.get(id);
      if (approval?.status !== 'decided' || !approval.decision) return null;

      const latest = await this.db.approvals
        .where('runId')
        .equals(approval.runId)
        .sortBy('requestedAt')
        .then((records) => records.at(-1));
      if (latest?.id !== approval.id) return null;

      const run = await this.db.runs.get(approval.runId);
      if (
        !run ||
        run.threadId !== approval.threadId ||
        run.turnId !== approval.turnId ||
        run.state !== 'waiting_approval'
      ) {
        return null;
      }

      const accepted =
        approval.decision.kind === 'accept' ||
        approval.decision.kind === 'acceptForSession' ||
        approval.decision.kind === 'acceptForSite';
      const state = accepted
        ? ('executing_tool' as const)
        : approval.decision.kind === 'cancel'
          ? ('interrupted' as const)
          : ('streaming_model' as const);
      assertRunTransition(run.state, state);
      const claimedAt = this.now();
      const claimed: RunRecord = {
        ...run,
        state,
        pendingTool:
          accepted && run.pendingTool
            ? { ...run.pendingTool, startedAt: run.pendingTool.startedAt ?? claimedAt }
            : run.pendingTool,
        revision: run.revision + 1,
        updatedAt: claimedAt,
      };
      await this.db.runs.put(claimed);
      return { approval, run: claimed };
    });
  }

  async get(id: string): Promise<ApprovalRecord | undefined> {
    return this.db.approvals.get(id);
  }

  async latestForRun(runId: string): Promise<ApprovalRecord | undefined> {
    return this.db.approvals
      .where('runId')
      .equals(runId)
      .sortBy('requestedAt')
      .then((records) => records.at(-1));
  }

  async pendingForThread(threadId: string): Promise<PendingApproval[]> {
    const records = await this.db.approvals
      .where('[threadId+status]')
      .equals([threadId, 'pending'])
      .sortBy('requestedAt');
    return records.map((record) => ({
      approvalId: record.id,
      turnId: record.turnId,
      request: record.request,
      requestedAt: record.requestedAt,
    }));
  }

  async pendingCountForThread(threadId: string): Promise<number> {
    return this.db.approvals.where('[threadId+status]').equals([threadId, 'pending']).count();
  }
}
