import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { PanelotDB } from '../../src/db/schema';
import { CommandReceiptRepository } from '../../src/engine/commandReceipts';

let db: PanelotDB;
let now: number;
let repo: CommandReceiptRepository;
let n = 0;

beforeEach(() => {
  db = new PanelotDB(`receipt-test-${Date.now()}-${n++}`);
  now = 1_000_000;
  repo = new CommandReceiptRepository(db, {
    now: () => now,
    retentionMs: 1_000,
    maxEntries: 2,
  });
});

describe('command receipts', () => {
  it('accepts a command once and returns its persisted response to duplicates', async () => {
    const command = {
      clientId: 'client-a',
      submissionId: 'submission-a',
      commandType: 'turn.submit',
    };

    await expect(repo.begin(command)).resolves.toEqual({ kind: 'accepted' });
    await repo.ack(command.clientId, command.submissionId, {
      type: 'command.ack',
      threadId: 'thread-a',
    });

    await expect(repo.begin(command)).resolves.toEqual({
      kind: 'duplicate',
      response: { type: 'command.ack', threadId: 'thread-a' },
    });
  });

  it('persists rejection responses for deterministic replay', async () => {
    const command = {
      clientId: 'client-a',
      submissionId: 'submission-b',
      commandType: 'queue.update',
    };
    await repo.begin(command);
    await repo.reject(command.clientId, command.submissionId, {
      type: 'command.rejected',
      code: 'invalid_command',
      message: 'bad queue item',
    });

    await expect(repo.begin(command)).resolves.toMatchObject({
      kind: 'duplicate',
      response: { type: 'command.rejected', code: 'invalid_command' },
    });
  });

  it('prunes expired receipts and enforces the bounded history', async () => {
    for (const submissionId of ['a', 'b', 'c']) {
      await repo.begin({ clientId: 'client-a', submissionId, commandType: 'turn.submit' });
      await repo.ack('client-a', submissionId, { type: 'command.ack' });
      now += 10;
    }

    await repo.prune();
    expect(await db.commandReceipts.count()).toBe(2);
    expect(await db.commandReceipts.get('client-a\u0000a')).toBeUndefined();

    now += 1_001;
    await repo.prune();
    expect(await db.commandReceipts.count()).toBe(0);
  });

  it('turns commands interrupted by a worker restart into explicit rejections', async () => {
    const command = {
      clientId: 'client-a',
      submissionId: 'submission-interrupted',
      commandType: 'turn.submit',
    };
    await repo.begin(command);

    await expect(repo.recoverIncomplete()).resolves.toBe(1);
    await expect(repo.begin(command)).resolves.toEqual({
      kind: 'duplicate',
      response: {
        type: 'command.rejected',
        code: 'interrupted',
        message:
          'The background worker restarted before the command result was committed. Refresh the thread snapshot before retrying.',
      },
    });
  });
});
