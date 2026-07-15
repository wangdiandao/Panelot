import type { PanelotDB } from '../db/schema';
import type { CommandReceipt, CommandReceiptResponse, ThreadMeta } from '../db/types';
import { createThreadMeta } from '../db/tree';

const DAY = 24 * 60 * 60 * 1_000;

export interface CommandIdentity {
  clientId: string;
  submissionId: string;
  commandType: string;
}

interface CommandReceiptRepositoryOptions {
  now?: () => number;
  retentionMs?: number;
  maxEntries?: number;
}

export type BeginCommandResult =
  { kind: 'accepted' } | { kind: 'duplicate'; response?: CommandReceiptResponse };

function receiptId(clientId: string, submissionId: string): string {
  return `${clientId}\u0000${submissionId}`;
}

export class CommandReceiptRepository {
  private readonly now: () => number;
  private readonly retentionMs: number;
  private readonly maxEntries: number;

  constructor(
    private readonly db: PanelotDB,
    options: CommandReceiptRepositoryOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.retentionMs = options.retentionMs ?? 7 * DAY;
    this.maxEntries = options.maxEntries ?? 10_000;
  }

  async begin(command: CommandIdentity): Promise<BeginCommandResult> {
    return this.db.transaction('rw', this.db.commandReceipts, async () => {
      const id = receiptId(command.clientId, command.submissionId);
      const existing = await this.db.commandReceipts.get(id);
      if (existing) return { kind: 'duplicate', response: existing.response };

      const now = this.now();
      await this.db.commandReceipts.add({
        id,
        clientId: command.clientId,
        submissionId: command.submissionId,
        commandType: command.commandType,
        status: 'processing',
        createdAt: now,
        updatedAt: now,
        expiresAt: now + this.retentionMs,
      });
      return { kind: 'accepted' };
    });
  }

  async ack(
    clientId: string,
    submissionId: string,
    response: CommandReceiptResponse,
  ): Promise<void> {
    await this.finish(clientId, submissionId, 'acknowledged', response);
  }

  async reject(
    clientId: string,
    submissionId: string,
    response: CommandReceiptResponse,
  ): Promise<void> {
    await this.finish(clientId, submissionId, 'rejected', response);
  }

  async createThreadAndAck(
    clientId: string,
    submissionId: string,
    partial: Partial<ThreadMeta>,
  ): Promise<ThreadMeta> {
    return this.db.transaction('rw', [this.db.commandReceipts, this.db.threads], async () => {
      const id = receiptId(clientId, submissionId);
      const receipt = await this.db.commandReceipts.get(id);
      if (!receipt) throw new Error(`Command receipt not found: ${id}`);
      if (receipt.status === 'acknowledged' && receipt.response?.threadId) {
        const existing = await this.db.threads.get(receipt.response.threadId);
        if (!existing) throw new Error(`Thread not found for command receipt: ${id}`);
        return existing;
      }
      if (receipt.status !== 'processing') {
        throw new Error(`Command receipt is already ${receipt.status}: ${id}`);
      }

      const now = this.now();
      const thread = createThreadMeta(partial, now);
      const response: CommandReceiptResponse = {
        type: 'command.ack',
        threadId: thread.id,
        revision: thread.revision,
      };
      await this.db.threads.add(thread);
      await this.db.commandReceipts.put({
        ...receipt,
        status: 'acknowledged',
        response,
        updatedAt: now,
      });
      return thread;
    });
  }

  async recoverIncomplete(): Promise<number> {
    return this.db.transaction('rw', [this.db.commandReceipts, this.db.runs], async () => {
      const interrupted = await this.db.commandReceipts
        .where('status')
        .equals('processing')
        .toArray();
      if (interrupted.length === 0) return 0;

      const now = this.now();
      const recovered: CommandReceipt[] = [];
      for (const receipt of interrupted) {
        const run =
          receipt.commandType === 'turn.submit' || receipt.commandType === 'turn.enqueue'
            ? await this.db.runs
                .where('submissionId')
                .equals(receipt.submissionId)
                .filter((candidate) => candidate.clientId === receipt.clientId)
                .first()
            : undefined;
        recovered.push(
          run
            ? {
                ...receipt,
                status: 'acknowledged',
                response: {
                  type: 'command.ack',
                  threadId: run.threadId,
                  runId: run.id,
                  revision: run.revision,
                },
                updatedAt: now,
              }
            : {
                ...receipt,
                status: 'rejected',
                response: {
                  type: 'command.rejected',
                  code: 'interrupted',
                  message:
                    'The background worker restarted before the command result was committed. Refresh the thread snapshot before retrying.',
                },
                updatedAt: now,
              },
        );
      }
      await this.db.commandReceipts.bulkPut(recovered);
      return interrupted.length;
    });
  }

  async prune(): Promise<void> {
    await this.db.transaction('rw', this.db.commandReceipts, async () => {
      const now = this.now();
      await this.db.commandReceipts.where('expiresAt').belowOrEqual(now).delete();

      const count = await this.db.commandReceipts.count();
      const overflow = count - this.maxEntries;
      if (overflow <= 0) return;

      const oldest = await this.db.commandReceipts
        .orderBy('createdAt')
        .limit(overflow)
        .primaryKeys();
      await this.db.commandReceipts.bulkDelete(oldest as string[]);
    });
  }

  private async finish(
    clientId: string,
    submissionId: string,
    status: CommandReceipt['status'],
    response: CommandReceiptResponse,
  ): Promise<void> {
    const id = receiptId(clientId, submissionId);
    const updated = await this.db.commandReceipts.update(id, {
      status,
      response,
      updatedAt: this.now(),
    });
    if (updated === 0) throw new Error(`Command receipt not found: ${id}`);
  }
}
