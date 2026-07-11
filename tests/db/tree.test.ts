import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { PanelotDB } from '../../src/db/schema';
import { ThreadTree } from '../../src/db/tree';
import type { SystemNoticePayload, UserMessagePayload } from '../../src/db/types';

let db: PanelotDB;
let tree: ThreadTree;
let n = 0;

beforeEach(() => {
  db = new PanelotDB(`test-${Date.now()}-${n++}`);
  tree = new ThreadTree(db);
});

const msg = (text: string): UserMessagePayload => ({ content: [{ type: 'text', text }] });

async function seedThread() {
  const thread = await tree.createThread({ title: 'test' });
  const a = await tree.appendNode(thread.id, { type: 'user_message', payload: msg('A') });
  const b = await tree.appendNode(thread.id, {
    type: 'assistant_message',
    payload: { content: [{ type: 'text', text: 'B' }], model: 'm', connectionId: 'c' },
  });
  const c = await tree.appendNode(thread.id, { type: 'user_message', payload: msg('C') });
  return { thread, a, b, c };
}

describe('appendNode', () => {
  it('advances leafId and assigns monotonic seq', async () => {
    const { thread, a, b, c } = await seedThread();
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3]);
    const meta = await tree.getThread(thread.id);
    expect(meta!.leafId).toBe(c.id);
    expect(a.parentId).toBeNull();
    expect(b.parentId).toBe(a.id);
    expect(c.parentId).toBe(b.id);
  });

  it('rejects a parent from another thread', async () => {
    const { a } = await seedThread();
    const other = await tree.createThread({});
    await expect(
      tree.appendNode(other.id, { type: 'user_message', payload: msg('x'), parentId: a.id }),
    ).rejects.toThrow(/not found/);
  });

  it('rejects appends to a deleting thread', async () => {
    const { thread } = await seedThread();
    await db.threads.update(thread.id, { deleting: true });
    await expect(
      tree.appendNode(thread.id, { type: 'user_message', payload: msg('x') }),
    ).rejects.toThrow(/not found/);
  });
});

describe('branching (docs/02 §3.2)', () => {
  it('edit-and-resend creates a sibling and moves the cursor', async () => {
    const { thread, b, c } = await seedThread();
    // Edit message C → sibling of C under parent B.
    const c2 = await tree.forkAt(thread.id, c.id, {
      type: 'user_message',
      payload: msg('C-edited'),
    });
    expect(c2.parentId).toBe(b.id);

    const siblings = await tree.getSiblings(thread.id, c2.id);
    expect(siblings.map((s) => s.id)).toEqual([c.id, c2.id]);

    const meta = await tree.getThread(thread.id);
    expect(meta!.leafId).toBe(c2.id);
  });

  it('switchToSibling descends to the deepest default (highest-seq) descendant', async () => {
    const { thread, c } = await seedThread();
    // Grow branch under original C: C → D → E.
    await tree.appendNode(thread.id, {
      type: 'assistant_message',
      payload: { content: [{ type: 'text', text: 'D' }], model: 'm', connectionId: 'c' },
      parentId: c.id,
    });
    const meta1 = await tree.getThread(thread.id);
    const e = await tree.appendNode(thread.id, {
      type: 'user_message',
      payload: msg('E'),
      parentId: meta1!.leafId,
    });

    // Fork at C, then switch back to the original C branch.
    await tree.forkAt(thread.id, c.id, { type: 'user_message', payload: msg('C2') });
    const leaf = await tree.switchToSibling(thread.id, c.id);
    expect(leaf).toBe(e.id);
  });
});

describe('tombstone deletion (docs/02 §3.3)', () => {
  it('skips tombstones in path traversal (grandchild relinks to grandparent)', async () => {
    const { thread, a, b, c } = await seedThread();
    await tree.tombstone(thread.id, b.id);
    const path = await tree.getPath(thread.id, c.id);
    expect(path.map((p) => p.id)).toEqual([a.id, c.id]);
  });

  it('moves leafId up to the nearest live ancestor when the leaf is tombstoned', async () => {
    const { thread, b, c } = await seedThread();
    await tree.tombstone(thread.id, c.id);
    const meta = await tree.getThread(thread.id);
    expect(meta!.leafId).toBe(b.id);
  });

  it('excludes tombstoned nodes from sibling lists', async () => {
    const { thread, c } = await seedThread();
    const c2 = await tree.forkAt(thread.id, c.id, { type: 'user_message', payload: msg('C2') });
    await tree.tombstone(thread.id, c.id);
    const siblings = await tree.getSiblings(thread.id, c2.id);
    expect(siblings.map((s) => s.id)).toEqual([c2.id]);
  });
});

describe('integrity validation (docs/02 §3.4)', () => {
  it('validates a healthy leaf without repair', async () => {
    const { thread, c } = await seedThread();
    const result = await tree.validateLeaf(thread.id);
    expect(result).toEqual({ leafId: c.id, repaired: false });
  });

  it('repairs a leafId pointing to a nonexistent node', async () => {
    const { thread, c } = await seedThread();
    await db.threads.update(thread.id, { leafId: 'ghost' });
    const result = await tree.validateLeaf(thread.id);
    expect(result.repaired).toBe(true);
    expect(result.leafId).toBe(c.id); // highest-seq reachable node
  });

  it('repairs an orphaned subtree (broken parent chain) without dead-looping', async () => {
    const { thread, c } = await seedThread();
    // Orphan node whose parent does not exist.
    await db.nodes.add({
      id: 'orphan',
      threadId: thread.id,
      parentId: 'missing-parent',
      seq: 99,
      ts: Date.now(),
      type: 'user_message',
      payload: msg('orphan'),
    });
    await db.threads.update(thread.id, { leafId: 'orphan' });

    const result = await tree.validateLeaf(thread.id);
    expect(result.repaired).toBe(true);
    expect(result.leafId).toBe(c.id);
  });

  it('getPath throws on a cyclic chain instead of hanging', async () => {
    const thread = await tree.createThread({});
    // Hand-craft a 2-node cycle.
    await db.nodes.bulkAdd([
      {
        id: 'x',
        threadId: thread.id,
        parentId: 'y',
        seq: 1,
        ts: 1,
        type: 'user_message',
        payload: msg('x'),
      },
      {
        id: 'y',
        threadId: thread.id,
        parentId: 'x',
        seq: 2,
        ts: 2,
        type: 'user_message',
        payload: msg('y'),
      },
    ]);
    await expect(tree.getPath(thread.id, 'x')).rejects.toThrow(/corruption/);
  });
});

describe('thread deletion', () => {
  it('marks deleting before physical removal and hides the thread immediately', async () => {
    const { thread } = await seedThread();
    await db.threads.update(thread.id, { deleting: true });
    expect(await tree.getThread(thread.id)).toBeUndefined();

    await tree.deleteThread(thread.id);
    expect(await db.nodes.where('threadId').equals(thread.id).count()).toBe(0);
    expect(await db.threads.get(thread.id)).toBeUndefined();
  });
});

describe('system_notice nodes', () => {
  it('are stored on the tree like any node', async () => {
    const { thread } = await seedThread();
    const notice: SystemNoticePayload = { text: 'auto-paused', noticeKind: 'paused' };
    const node = await tree.appendNode(thread.id, { type: 'system_notice', payload: notice });
    const path = await tree.getPath(thread.id, node.id);
    expect(path[path.length - 1]!.type).toBe('system_notice');
  });
});
