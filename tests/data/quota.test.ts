import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { PanelotDB } from '../../src/db/schema';
import { evictAttachmentsIfNeeded } from '../../src/data/quota';

let db: PanelotDB;
let n = 0;
beforeEach(() => {
  db = new PanelotDB(`quota-test-${Date.now()}-${n++}`);
});

function bigBlob(mb: number): Blob {
  return new Blob([new Uint8Array(mb * 1024 * 1024)]);
}

describe('evictAttachmentsIfNeeded (docs/02 §6 — LRU, never the active thread)', () => {
  it('evicts oldest attachments over the 200MB budget', async () => {
    // 3 × 90MB = 270MB > 200MB budget.
    for (let i = 0; i < 3; i++) {
      await db.attachments.add({
        id: `a${i}`,
        threadId: 'old-thread',
        createdAt: i, // ascending → a0 oldest
        kind: 'screenshot',
        mime: 'image/png',
        bytes: bigBlob(90),
      });
    }
    const evicted = await evictAttachmentsIfNeeded(db);
    expect(evicted).toBeGreaterThanOrEqual(1);
    // The oldest one must be gone.
    expect(await db.attachments.get('a0')).toBeUndefined();
  });

  it('never evicts attachments belonging to the active thread', async () => {
    for (let i = 0; i < 3; i++) {
      await db.attachments.add({
        id: `a${i}`,
        threadId: 'active',
        createdAt: i,
        kind: 'screenshot',
        mime: 'image/png',
        bytes: bigBlob(90),
      });
    }
    const evicted = await evictAttachmentsIfNeeded(db, 'active');
    expect(evicted).toBe(0);
    expect(await db.attachments.count()).toBe(3);
  });

  it('is a no-op under budget', async () => {
    await db.attachments.add({ id: 'small', threadId: 't', createdAt: 1, kind: 'image', mime: 'image/png', bytes: bigBlob(1) });
    expect(await evictAttachmentsIfNeeded(db)).toBe(0);
  });
});
