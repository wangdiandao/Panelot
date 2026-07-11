import type { PanelotDB } from '../db/schema';
import type { CommandReceipt, CommandReceiptResponse } from '../db/types';

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

  async recoverIncomplete(): Promise<number> {
    return this.db.transaction('rw', this.db.commandReceipts, async () => {
      const interrupted = await this.db.commandReceipts
        .where('status')
        .equals('processing')
        .toArray();
      if (interrupted.length === 0) return 0;

      const now = this.now();
      await this.db.commandReceipts.bulkPut(
        interrupted.map((receipt) => ({
          ...receipt,
          status: 'rejected' as const,
          response: {
            type: 'command.rejected' as const,
            code: 'interrupted',
            message:
              'The background worker restarted before the command result was committed. Refresh the thread snapshot before retrying.',
          },
          updatedAt: now,
        })),
      );
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
