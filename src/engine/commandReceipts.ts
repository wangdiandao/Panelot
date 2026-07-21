import type { PanelotDB } from '../db/schema';
import type { CommandReceipt, CommandReceiptResponse, ThreadMeta } from '../db/types';
import { createThreadMeta, ThreadTree } from '../db/tree';
import { stablePersistenceKey } from './toolCallPersistence';

const DAY = 24 * 60 * 60 * 1_000;

export interface CommandIdentity {
  clientId: string;
  submissionId: string;
  commandType: string;
  requestFingerprint?: string;
}

/**
 * Identity carried into a domain transaction that can commit the command
 * outcome with its durable state change. It intentionally contains no mutable
 * repository state, so domain repositories can accept it without depending on
 * RealEngineCore or the transport layer.
 */
export type CommandTransactionContext = Readonly<CommandIdentity>;

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

export function createCommandTransactionContext(
  command: CommandIdentity,
): CommandTransactionContext {
  return Object.freeze({ ...command });
}

export async function fingerprintCommandPayload(payload: unknown): Promise<string> {
  const encoded = new TextEncoder().encode(stablePersistenceKey(payload));
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Complete a receipt from inside the caller's Dexie transaction. The caller
 * must include `commandReceipts` in that transaction together with every
 * domain table it mutates. Returning the already persisted response makes a
 * terminal command outcome immutable across late continuations and retries.
 */
export async function completeCommandReceiptInTransaction(
  db: PanelotDB,
  command: CommandTransactionContext,
  response: CommandReceiptResponse,
  updatedAt: number,
): Promise<CommandReceiptResponse> {
  const id = receiptId(command.clientId, command.submissionId);
  const receipt = await db.commandReceipts.get(id);
  if (!receipt) throw new Error(`Command receipt not found: ${id}`);
  if (receipt.commandType !== command.commandType) {
    throw new Error(
      `Command receipt type mismatch: expected ${receipt.commandType}, received ${command.commandType}`,
    );
  }
  if (receipt.requestFingerprint !== command.requestFingerprint) {
    throw new Error('Command receipt payload fingerprint mismatch');
  }
  if (receipt.status !== 'processing') {
    if (!receipt.response) throw new Error(`Terminal command receipt has no response: ${id}`);
    return receipt.response;
  }

  await db.commandReceipts.put({
    ...receipt,
    status: response.type === 'command.ack' ? 'acknowledged' : 'rejected',
    response,
    updatedAt,
  });
  return response;
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
      if (existing) {
        if (existing.commandType !== command.commandType) {
          return {
            kind: 'duplicate',
            response: {
              type: 'command.rejected',
              code: 'invalid_command',
              message: `submissionId was already used for ${existing.commandType}`,
            },
          };
        }
        if (
          existing.requestFingerprint !== undefined &&
          existing.requestFingerprint !== command.requestFingerprint
        ) {
          return {
            kind: 'duplicate',
            response: {
              type: 'command.rejected',
              code: 'invalid_command',
              message: 'submissionId was already used with a different command payload',
            },
          };
        }
        return { kind: 'duplicate', response: existing.response };
      }

      const now = this.now();
      await this.db.commandReceipts.add({
        id,
        clientId: command.clientId,
        submissionId: command.submissionId,
        commandType: command.commandType,
        requestFingerprint: command.requestFingerprint,
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
  ): Promise<CommandReceiptResponse> {
    return this.finish(clientId, submissionId, response);
  }

  async reject(
    clientId: string,
    submissionId: string,
    response: CommandReceiptResponse,
  ): Promise<CommandReceiptResponse> {
    return this.finish(clientId, submissionId, response);
  }

  async createThreadAndAck(
    clientId: string,
    submissionId: string,
    partial: Partial<ThreadMeta>,
    command?: CommandTransactionContext,
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
      await completeCommandReceiptInTransaction(
        this.db,
        command ??
          createCommandTransactionContext({
            clientId,
            submissionId,
            commandType: 'thread.create',
            requestFingerprint: receipt.requestFingerprint,
          }),
        response,
        now,
      );
      return thread;
    });
  }

  async forkThreadAndAck(
    command: CommandTransactionContext,
    sourceThreadId: string,
    partial: Partial<ThreadMeta>,
  ): Promise<ThreadMeta> {
    if (command.commandType !== 'thread.fork') {
      throw new Error(`Invalid command transaction for thread fork: ${command.commandType}`);
    }
    return this.db.transaction('rw', [this.db.commandReceipts, this.db.threads], async () => {
      const source = await this.db.threads.get(sourceThreadId);
      if (!source || source.deleting) throw new Error(`thread ${sourceThreadId} not found`);
      const now = this.now();
      const thread = createThreadMeta(partial, now);
      await this.db.threads.add(thread);
      await completeCommandReceiptInTransaction(
        this.db,
        command,
        { type: 'command.ack', threadId: thread.id, revision: thread.revision },
        now,
      );
      return thread;
    });
  }

  async selectBranchAndAck(
    command: CommandTransactionContext,
    threadId: string,
    nodeId: string,
  ): Promise<{ leafId: string; revision: number }> {
    if (command.commandType !== 'thread.selectBranch') {
      throw new Error(`Invalid command transaction for branch selection: ${command.commandType}`);
    }
    return this.db.transaction(
      'rw',
      [this.db.commandReceipts, this.db.threads, this.db.nodes],
      async () => {
        const leafId = await new ThreadTree(this.db).switchToSibling(threadId, nodeId);
        const thread = await this.db.threads.get(threadId);
        if (!thread || thread.deleting) throw new Error(`thread ${threadId} not found`);
        await completeCommandReceiptInTransaction(
          this.db,
          command,
          { type: 'command.ack', threadId, revision: thread.revision },
          this.now(),
        );
        return { leafId, revision: thread.revision };
      },
    );
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
        const runSupportsAcknowledgement =
          run &&
          (receipt.commandType === 'turn.enqueue' ||
            run.state !== 'failed' ||
            run.environment !== undefined);
        recovered.push(
          runSupportsAcknowledgement
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
    response: CommandReceiptResponse,
  ): Promise<CommandReceiptResponse> {
    return this.db.transaction('rw', this.db.commandReceipts, async () => {
      const id = receiptId(clientId, submissionId);
      const receipt = await this.db.commandReceipts.get(id);
      if (!receipt) throw new Error(`Command receipt not found: ${id}`);
      return completeCommandReceiptInTransaction(
        this.db,
        createCommandTransactionContext({
          clientId,
          submissionId,
          commandType: receipt.commandType,
          requestFingerprint: receipt.requestFingerprint,
        }),
        response,
        this.now(),
      );
    });
  }
}
