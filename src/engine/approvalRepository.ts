import type { PanelotDB } from '../db/schema';
import type { ApprovalRecord } from '../db/types';
import { ThreadTree } from '../db/tree';
import type {
  ApprovalDecision,
  ApprovalRequestPayload,
  PendingApproval,
} from '../messaging/protocol';

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
  }): Promise<ApprovalRecord> {
    const record: ApprovalRecord = {
      ...input,
      status: 'pending',
      requestedAt: this.now(),
    };
    await this.db.approvals.add(record);
    return record;
  }

  async decide(id: string, decision: ApprovalDecision): Promise<ApprovalRecord> {
    return this.db.transaction(
      'rw',
      [this.db.approvals, this.db.runs, this.db.threads, this.db.nodes],
      async () => {
        const current = await this.db.approvals.get(id);
        if (!current) throw new Error(`Approval not found: ${id}`);
        if (current.status === 'decided') return current;
        const run = await this.db.runs.get(current.runId);
        if (!run || run.threadId !== current.threadId) {
          throw new Error(`Run not found for approval: ${id}`);
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
        await this.db.runs.update(run.id, {
          revision: run.revision + 1,
          updatedAt: decidedAt,
        });
        return updated;
      },
    );
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
}
