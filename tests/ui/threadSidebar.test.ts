/**
 * ThreadSidebar pure helpers: pinned-first time grouping, compact time-ago
 * labels, and the unread rule (updatedAt > seenAt, never for the open thread).
 */
import { describe, expect, it } from 'vitest';
import { groupThreads, timeAgo, isUnread } from '../../src/ui/components/ThreadSidebar';
import type { ThreadMeta } from '../../src/db/types';

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const thread = (over: Partial<ThreadMeta>): ThreadMeta => ({
  id: 'th1',
  title: 't',
  createdAt: NOW - DAY,
  updatedAt: NOW - HOUR,
  leafId: 'n1',
  tags: [],
  pinned: false,
  archived: false,
  stats: { turns: 1, totalTokens: 0, costUsd: 0 },
  scopeOrigins: [],
  ...over,
});

describe('groupThreads', () => {
  it('buckets by age with pinned floated to their own group first', () => {
    const groups = groupThreads(
      [
        thread({ id: 'a', updatedAt: NOW - HOUR }),
        thread({ id: 'b', updatedAt: NOW - 1.5 * DAY }),
        thread({ id: 'c', updatedAt: NOW - 3 * DAY }),
        thread({ id: 'd', updatedAt: NOW - 30 * DAY }),
        thread({ id: 'p', updatedAt: NOW - 30 * DAY, pinned: true }),
      ],
      NOW,
    );
    expect(groups.map((g) => g.id)).toEqual(['pinned', 'today', 'yesterday', 'week', 'older']);
    expect(groups[0]!.threads[0]!.id).toBe('p');
  });

  it('omits empty groups', () => {
    const groups = groupThreads([thread({ id: 'a', updatedAt: NOW - HOUR })], NOW);
    expect(groups.map((g) => g.id)).toEqual(['today']);
  });
});

describe('timeAgo', () => {
  it('formats compact buckets', () => {
    expect(timeAgo(NOW - 30_000, NOW)).toBeTruthy(); // "now"
    expect(timeAgo(NOW - 5 * 60_000, NOW)).toContain('5');
    expect(timeAgo(NOW - 3 * HOUR, NOW)).toContain('3');
    expect(timeAgo(NOW - 2 * DAY, NOW)).toContain('2');
    expect(timeAgo(NOW - 15 * DAY, NOW)).toContain('2'); // 2 weeks
  });
});

describe('isUnread', () => {
  const th = thread({ id: 'x', updatedAt: NOW });
  it('is unread when the thread advanced past lastSeen', () => {
    expect(isUnread(th, { x: NOW - HOUR }, null)).toBe(true);
  });
  it('is read when seen after the last update', () => {
    expect(isUnread(th, { x: NOW + 1 }, null)).toBe(false);
  });
  it('never marks the open thread unread', () => {
    expect(isUnread(th, { x: NOW - HOUR }, 'x')).toBe(false);
  });
  it('threads never seen are not unread (fresh installs stay quiet)', () => {
    expect(isUnread(th, {}, null)).toBe(false);
  });
});
