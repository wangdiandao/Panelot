/**
 * Palette full-text search: title hits, body hits with snippets, and the
 * bounded-scan contract (no FTS index — recent threads only).
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { PanelotDB } from '../../src/db/schema';
import { ThreadTree } from '../../src/db/tree';
import { makeSnippet, searchThreads } from '../../src/ui/threadSearch';

let db: PanelotDB;
let tree: ThreadTree;
let n = 0;

beforeEach(() => {
  db = new PanelotDB(`search-test-${Date.now()}-${n++}`);
  tree = new ThreadTree(db);
});

async function makeThread(title: string, messages: string[]): Promise<string> {
  const thread = await tree.createThread({ title });
  for (const [i, text] of messages.entries()) {
    await tree.appendNode(thread.id, {
      type: i % 2 === 0 ? 'user_message' : 'assistant_message',
      payload: { content: [{ type: 'text', text }] },
    });
  }
  return thread.id;
}

describe('searchThreads', () => {
  it('empty query returns recent threads without snippets', async () => {
    await makeThread('alpha', ['hello']);
    await makeThread('beta', ['world']);
    const hits = await searchThreads(db, '');
    expect(hits).toHaveLength(2);
    expect(hits.every((h) => h.snippet === undefined)).toBe(true);
  });

  it('matches titles first (no snippet)', async () => {
    await makeThread('购物比价任务', ['some content']);
    const hits = await searchThreads(db, '比价');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.snippet).toBeUndefined();
  });

  it('matches message bodies with a highlighted snippet', async () => {
    await makeThread('untitled-task', ['请帮我提取这个页面的表格数据然后导出']);
    const hits = await searchThreads(db, '表格数据');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.snippet).toContain('表格数据');
  });

  it('excludes archived and content-less threads', async () => {
    const id = await makeThread('archived-one', ['findme']);
    await db.threads.update(id, { archived: true });
    await tree.createThread({ title: 'empty draft findme' }); // leafId null
    const hits = await searchThreads(db, 'findme');
    expect(hits).toHaveLength(0);
  });
});

describe('makeSnippet', () => {
  it('clips around the match with ellipses', () => {
    const text = `${'a'.repeat(100)}NEEDLE${'b'.repeat(100)}`;
    const snip = makeSnippet(text, 'needle')!;
    expect(snip.startsWith('…')).toBe(true);
    expect(snip.endsWith('…')).toBe(true);
    expect(snip).toContain('NEEDLE');
    expect(snip.length).toBeLessThan(80);
  });
  it('returns undefined for no match', () => {
    expect(makeSnippet('abc', 'zzz')).toBeUndefined();
  });
});
