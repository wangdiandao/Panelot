import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PanelotDB } from '../../src/db/schema';
import { CommandReceiptRepository } from '../../src/engine/commandReceipts';
import { ThreadTree } from '../../src/db/tree';
import { RunRepository } from '../../src/engine/runRepository';

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

  it('commits thread creation and its receipt as one work unit', async () => {
    const command = {
      clientId: 'client-a',
      submissionId: 'thread-create',
      commandType: 'thread.create',
    };
    await repo.begin(command);

    const thread = await repo.createThreadAndAck(command.clientId, command.submissionId, {
      preset: 'preset-a',
    });

    expect(await db.threads.get(thread.id)).toMatchObject({ preset: 'preset-a' });
    await expect(repo.begin(command)).resolves.toEqual({
      kind: 'duplicate',
      response: {
        type: 'command.ack',
        threadId: thread.id,
        revision: 0,
      },
    });
  });

  it('rolls thread creation back when receipt completion fails', async () => {
    const command = {
      clientId: 'client-a',
      submissionId: 'thread-create-failure',
      commandType: 'thread.create',
    };
    await repo.begin(command);
    vi.spyOn(db.commandReceipts, 'put').mockRejectedValueOnce(
      new Error('injected receipt write failure'),
    );

    await expect(
      repo.createThreadAndAck(command.clientId, command.submissionId, {}),
    ).rejects.toThrow(/injected receipt write failure/);

    expect(await db.threads.count()).toBe(0);
    expect(await db.commandReceipts.get('client-a\u0000thread-create-failure')).toMatchObject({
      status: 'processing',
    });
  });

  it('recovers an accepted turn receipt from its durable run identity', async () => {
    const thread = await new ThreadTree(db).createThread({ title: 'receipt recovery' });
    const command = {
      clientId: 'client-a',
      submissionId: 'turn-domain-committed',
      commandType: 'turn.submit',
    };
    await repo.begin(command);
    const run = await new RunRepository(db, { now: () => now }).enqueue({
      threadId: thread.id,
      clientId: command.clientId,
      submissionId: command.submissionId,
      input: { text: 'committed before ack' },
    });

    await expect(repo.recoverIncomplete()).resolves.toBe(1);
    await expect(repo.begin(command)).resolves.toEqual({
      kind: 'duplicate',
      response: {
        type: 'command.ack',
        threadId: thread.id,
        runId: run.id,
        revision: 0,
      },
    });
  });

  it("does not recover another client's run with the same submission id", async () => {
    const thread = await new ThreadTree(db).createThread({ title: 'receipt client scope' });
    await new RunRepository(db, { now: () => now }).enqueue({
      threadId: thread.id,
      clientId: 'client-a',
      submissionId: 'shared-submission',
      input: { text: 'client A work' },
    });
    const wrongClient = {
      clientId: 'client-b',
      submissionId: 'shared-submission',
      commandType: 'turn.submit',
    };
    await repo.begin(wrongClient);

    await expect(repo.recoverIncomplete()).resolves.toBe(1);
    await expect(repo.begin(wrongClient)).resolves.toEqual({
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
