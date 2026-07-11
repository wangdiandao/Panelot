import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { PanelotDB } from '../../src/db/schema';
import { ThreadTree } from '../../src/db/tree';
import { AttachmentRepository } from '../../src/data/attachments';

let db: PanelotDB;
let repo: AttachmentRepository;
let threadId: string;

beforeEach(async () => {
  db = new PanelotDB(`attachment-test-${crypto.randomUUID()}`);
  repo = new AttachmentRepository(db, { now: () => 42 });
  threadId = (await new ThreadTree(db).createThread()).id;
});

describe('AttachmentRepository', () => {
  it('accepts only user-provenance uploads in the owning thread', async () => {
    const stored = await repo.addUpload({
      threadId,
      kind: 'file',
      mime: 'text/plain',
      bytes: new Blob(['hello']),
      provenance: 'user',
      sourceRef: 'hello.txt',
    });
    expect(stored).toMatchObject({ trust: 'trusted', provenance: 'user', createdAt: 42 });

    await expect(
      repo.addUpload({
        threadId,
        kind: 'file',
        mime: 'text/plain',
        bytes: new Blob(['page data']),
        provenance: 'page',
      }),
    ).rejects.toThrow(/user-provenance/i);
  });

  it('cleans records left half-deleted after a worker restart', async () => {
    await db.attachments.add({
      id: 'half-deleted',
      threadId,
      kind: 'file',
      mime: 'text/plain',
      bytes: new Blob(['x']),
      provenance: 'user',
      createdAt: 1,
      deleting: true,
    });
    await expect(repo.cleanupIncomplete()).resolves.toBe(1);
    expect(await db.attachments.get('half-deleted')).toBeUndefined();
  });

  it('marks referring nodes evicted before deleting attachment bytes', async () => {
    const node = await new ThreadTree(db).appendNode(threadId, {
      type: 'system_notice',
      payload: { text: 'screenshot' },
    });
    const attachment = await repo.addUpload({
      threadId,
      kind: 'image',
      mime: 'image/png',
      bytes: new Blob(['png']),
      provenance: 'user',
    });
    await db.attachments.update(attachment.id, { refs: { nodeIds: [node.id] } });

    await repo.remove(attachment.id);

    expect(await db.attachments.get(attachment.id)).toBeUndefined();
    expect((await db.nodes.get(node.id))?.evicted).toBe(true);
  });
});
