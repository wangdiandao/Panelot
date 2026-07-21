import { describe, expect, it } from 'vitest';
import type { ThreadMeta } from '../../src/db/types';
import { selectInitialSidePanelThread } from '../../src/ui/sidePanelSession';

function thread(id: string, patch: Partial<ThreadMeta> = {}): ThreadMeta {
  return {
    id,
    revision: 1,
    title: id,
    createdAt: 1,
    updatedAt: 1,
    leafId: `${id}-leaf`,
    tags: [],
    pinned: false,
    archived: false,
    stats: { turns: 1, totalTokens: 0, costUsd: 0 },
    scopeOrigins: [],
    ...patch,
  };
}

describe('side panel initial thread selection', () => {
  it('restores the last selected thread even when another thread was updated later', () => {
    expect(selectInitialSidePanelThread(thread('selected'), thread('recent'))?.id).toBe('selected');
  });

  it.each([
    thread('deleted', { deleting: true }),
    thread('archived', { archived: true }),
    thread('empty', { leafId: null }),
  ])('falls back when $id cannot be restored', (lastSelected) => {
    expect(selectInitialSidePanelThread(lastSelected, thread('recent'))?.id).toBe('recent');
  });

  it('returns no thread when neither candidate can be restored', () => {
    expect(selectInitialSidePanelThread(undefined, undefined)).toBeNull();
  });
});
