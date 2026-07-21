import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PanelotDB } from '../../src/db/schema';
import {
  CommandReceiptRepository,
  createCommandTransactionContext,
  fingerprintCommandPayload,
} from '../../src/engine/commandReceipts';
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

  it('rejects reusing a submission identity for a different command type', async () => {
    const identity = { clientId: 'client-a', submissionId: 'submission-a' };
    await repo.begin({ ...identity, commandType: 'turn.submit' });
    await repo.ack(identity.clientId, identity.submissionId, {
      type: 'command.ack',
      threadId: 'thread-a',
    });

    await expect(repo.begin({ ...identity, commandType: 'thread.selectBranch' })).resolves.toEqual({
      kind: 'duplicate',
      response: {
        type: 'command.rejected',
        code: 'invalid_command',
        message: 'submissionId was already used for turn.submit',
      },
    });
    await expect(db.commandReceipts.get('client-a\u0000submission-a')).resolves.toMatchObject({
      status: 'acknowledged',
      commandType: 'turn.submit',
      response: { type: 'command.ack', threadId: 'thread-a' },
    });
  });

  it('rejects reusing a submission identity with a different payload fingerprint', async () => {
    const original = {
      clientId: 'client-a',
      submissionId: 'payload-bound',
      commandType: 'queue.update',
      requestFingerprint: await fingerprintCommandPayload({
        threadId: 'thread-a',
        runId: 'run-a',
        input: { text: 'first' },
      }),
    };
    await repo.begin(original);
    await repo.ack(original.clientId, original.submissionId, {
      type: 'command.ack',
      threadId: 'thread-a',
      runId: 'run-a',
      revision: 1,
    });

    await expect(
      repo.begin({
        ...original,
        requestFingerprint: await fingerprintCommandPayload({
          threadId: 'thread-a',
          runId: 'run-a',
          input: { text: 'different' },
        }),
      }),
    ).resolves.toEqual({
      kind: 'duplicate',
      response: {
        type: 'command.rejected',
        code: 'invalid_command',
        message: 'submissionId was already used with a different command payload',
      },
    });
    expect(await db.commandReceipts.get('client-a\u0000payload-bound')).toMatchObject({
      status: 'acknowledged',
      requestFingerprint: original.requestFingerprint,
      response: { type: 'command.ack', runId: 'run-a', revision: 1 },
    });

    await expect(
      repo.begin({
        clientId: original.clientId,
        submissionId: original.submissionId,
        commandType: original.commandType,
      }),
    ).resolves.toMatchObject({
      kind: 'duplicate',
      response: { type: 'command.rejected', code: 'invalid_command' },
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

  it('does not overwrite a terminal receipt with a later outcome', async () => {
    const command = {
      clientId: 'client-a',
      submissionId: 'terminal-outcome',
      commandType: 'approval.response',
    };
    await repo.begin(command);
    await repo.ack(command.clientId, command.submissionId, {
      type: 'command.ack',
      threadId: 'thread-a',
    });

    await expect(
      repo.reject(command.clientId, command.submissionId, {
        type: 'command.rejected',
        code: 'internal',
        message: 'late continuation failure',
      }),
    ).resolves.toEqual({
      type: 'command.ack',
      threadId: 'thread-a',
    });

    await expect(repo.begin(command)).resolves.toEqual({
      kind: 'duplicate',
      response: { type: 'command.ack', threadId: 'thread-a' },
    });
  });

  it('does not overwrite a terminal rejection with a later acknowledgement', async () => {
    const command = {
      clientId: 'client-a',
      submissionId: 'terminal-rejection',
      commandType: 'interaction.response',
    };
    await repo.begin(command);
    await repo.reject(command.clientId, command.submissionId, {
      type: 'command.rejected',
      code: 'invalid_command',
      message: 'invalid response',
    });

    await expect(
      repo.ack(command.clientId, command.submissionId, {
        type: 'command.ack',
        threadId: 'thread-a',
      }),
    ).resolves.toEqual({
      type: 'command.rejected',
      code: 'invalid_command',
      message: 'invalid response',
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

  it('commits a thread fork with its receipt and rolls both back on receipt failure', async () => {
    const source = await new ThreadTree(db).createThread({ title: 'source' });
    const command = createCommandTransactionContext({
      clientId: 'client-a',
      submissionId: 'thread-fork',
      commandType: 'thread.fork',
    });
    await repo.begin(command);
    vi.spyOn(db.commandReceipts, 'put').mockRejectedValueOnce(
      new Error('injected receipt write failure'),
    );

    await expect(
      repo.forkThreadAndAck(command, source.id, {
        title: 'fork',
        parentThreadId: source.id,
      }),
    ).rejects.toThrow(/injected receipt write failure/);
    expect(await db.threads.count()).toBe(1);
    expect(await db.commandReceipts.get('client-a\u0000thread-fork')).toMatchObject({
      status: 'processing',
    });

    const forked = await repo.forkThreadAndAck(command, source.id, {
      title: 'fork',
      parentThreadId: source.id,
    });
    expect(await db.threads.get(forked.id)).toMatchObject({ parentThreadId: source.id });
    await expect(repo.begin(command)).resolves.toMatchObject({
      kind: 'duplicate',
      response: { type: 'command.ack', threadId: forked.id, revision: 0 },
    });
  });

  it('refuses to complete a payload-bound transaction when its context omits the fingerprint', async () => {
    const source = await new ThreadTree(db).createThread({ title: 'source' });
    const requestFingerprint = await fingerprintCommandPayload({
      threadId: source.id,
      atNodeId: 'node-a',
    });
    await repo.begin({
      clientId: 'client-a',
      submissionId: 'fingerprint-required',
      commandType: 'thread.fork',
      requestFingerprint,
    });

    await expect(
      repo.forkThreadAndAck(
        createCommandTransactionContext({
          clientId: 'client-a',
          submissionId: 'fingerprint-required',
          commandType: 'thread.fork',
        }),
        source.id,
        { parentThreadId: source.id },
      ),
    ).rejects.toThrow(/payload fingerprint mismatch/);

    expect(await db.threads.count()).toBe(1);
    expect(await db.commandReceipts.get('client-a\u0000fingerprint-required')).toMatchObject({
      status: 'processing',
      requestFingerprint,
    });
  });

  it('commits branch selection with its receipt and rolls the cursor back on receipt failure', async () => {
    const tree = new ThreadTree(db);
    const thread = await tree.createThread({ title: 'branches' });
    const root = await tree.appendNode(thread.id, {
      type: 'user_message',
      payload: { content: [{ type: 'text', text: 'root' }] },
    });
    const left = await tree.appendNode(thread.id, {
      parentId: root.id,
      type: 'assistant_message',
      payload: { content: [{ type: 'text', text: 'left' }], model: 'm', connectionId: 'c' },
    });
    const right = await tree.appendNode(thread.id, {
      parentId: root.id,
      type: 'assistant_message',
      payload: { content: [{ type: 'text', text: 'right' }], model: 'm', connectionId: 'c' },
    });
    const before = await tree.getThread(thread.id);
    expect(before?.leafId).toBe(right.id);
    const command = createCommandTransactionContext({
      clientId: 'client-a',
      submissionId: 'select-branch',
      commandType: 'thread.selectBranch',
    });
    await repo.begin(command);
    vi.spyOn(db.commandReceipts, 'put').mockRejectedValueOnce(
      new Error('injected receipt write failure'),
    );

    await expect(repo.selectBranchAndAck(command, thread.id, left.id)).rejects.toThrow(
      /injected receipt write failure/,
    );
    expect(await tree.getThread(thread.id)).toMatchObject({
      leafId: right.id,
      revision: before?.revision,
    });

    const selected = await repo.selectBranchAndAck(command, thread.id, left.id);
    expect(selected).toMatchObject({ leafId: left.id, revision: (before?.revision ?? 0) + 1 });
    await expect(repo.begin(command)).resolves.toMatchObject({
      kind: 'duplicate',
      response: { type: 'command.ack', threadId: thread.id, revision: selected.revision },
    });
  });

  it('recovers an accepted enqueue receipt from its durable run identity', async () => {
    const thread = await new ThreadTree(db).createThread({ title: 'receipt recovery' });
    const command = {
      clientId: 'client-a',
      submissionId: 'turn-domain-committed',
      commandType: 'turn.enqueue',
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

  it('recovers a durable submit that can still be resumed', async () => {
    const thread = await new ThreadTree(db).createThread({ title: 'submit receipt recovery' });
    const command = {
      clientId: 'client-a',
      submissionId: 'submit-domain-ambiguous',
      commandType: 'turn.submit',
    };
    await repo.begin(command);
    await new RunRepository(db, { now: () => now }).enqueue({
      threadId: thread.id,
      clientId: command.clientId,
      submissionId: command.submissionId,
      input: { text: 'run exists but admission outcome is unknown' },
    });

    await expect(repo.recoverIncomplete()).resolves.toBe(1);
    await expect(repo.begin(command)).resolves.toMatchObject({
      kind: 'duplicate',
      response: { type: 'command.ack', threadId: thread.id },
    });
  });

  it('does not acknowledge a submit whose environment resolution already failed', async () => {
    const thread = await new ThreadTree(db).createThread({ title: 'failed submit recovery' });
    const command = {
      clientId: 'client-a',
      submissionId: 'submit-domain-failed',
      commandType: 'turn.submit',
    };
    await repo.begin(command);
    const runs = new RunRepository(db, { now: () => now });
    const run = await runs.enqueue({
      threadId: thread.id,
      clientId: command.clientId,
      submissionId: command.submissionId,
      input: { text: 'provider resolution fails' },
    });
    await runs.transition(run.id, 'failed', {
      error: { code: 'provider_resolution', message: 'unavailable' },
    });

    await expect(repo.recoverIncomplete()).resolves.toBe(1);
    await expect(repo.begin(command)).resolves.toMatchObject({
      kind: 'duplicate',
      response: { type: 'command.rejected', code: 'interrupted' },
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
