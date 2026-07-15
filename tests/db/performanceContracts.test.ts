import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { PanelotDB } from '../../src/db/schema';
import { buildSessionContext } from '../../src/db/sessionContext';
import { createThreadMeta, ThreadTree } from '../../src/db/tree';
import type { ThreadNode } from '../../src/db/types';

const databases: PanelotDB[] = [];

afterEach(async () => {
  await Promise.all(
    databases.splice(0).map(async (db) => {
      db.close();
      await db.delete();
    }),
  );
});

function createDatabase(label: string): PanelotDB {
  const db = new PanelotDB(`performance-${label}-${crypto.randomUUID()}`);
  databases.push(db);
  return db;
}

function messageNode(threadId: string, index: number, parentId: string | null): ThreadNode {
  return {
    id: `node-${index}`,
    threadId,
    parentId,
    seq: index + 1,
    ts: index,
    type: 'user_message',
    payload: { content: [{ type: 'text', text: `message-${index}` }] },
  };
}

async function seedTree(db: PanelotDB, size: number, shape: 'deep' | 'wide') {
  const threadId = `thread-${shape}`;
  const nodes = Array.from({ length: size }, (_, index) =>
    messageNode(
      threadId,
      index,
      index === 0 ? null : shape === 'deep' ? `node-${index - 1}` : 'node-0',
    ),
  );
  await db.threads.add(createThreadMeta({ id: threadId, leafId: `node-${size - 1}` }, 0));
  await db.nodes.bulkAdd(nodes);
  return { threadId, leafId: `node-${size - 1}` };
}

function countPathQueries(db: PanelotDB) {
  let gets = 0;
  let whereCalls = 0;
  const originalGet = db.nodes.get.bind(db.nodes);
  const originalWhere = db.nodes.where.bind(db.nodes);
  db.nodes.get = ((...args: Parameters<typeof db.nodes.get>) => {
    gets++;
    return originalGet(...args);
  }) as typeof db.nodes.get;
  db.nodes.where = ((...args: Parameters<typeof db.nodes.where>) => {
    whereCalls++;
    return originalWhere(...args);
  }) as typeof db.nodes.where;
  return { read: () => ({ gets, whereCalls }) };
}

describe('long-session complexity contracts', () => {
  it('keeps a shallow path in a wide thread on point reads', async () => {
    const db = createDatabase('wide');
    const { threadId, leafId } = await seedTree(db, 10_000, 'wide');
    const queries = countPathQueries(db);

    const path = await new ThreadTree(db).getPath(threadId, leafId);

    expect(path).toHaveLength(2);
    expect(queries.read()).toEqual({ gets: 2, whereCalls: 0 });
  });

  it('bounds IndexedDB round trips for a deep path', async () => {
    const db = createDatabase('deep');
    const { threadId, leafId } = await seedTree(db, 10_000, 'deep');
    const queries = countPathQueries(db);

    const path = await new ThreadTree(db).getPath(threadId, leafId);

    expect(path).toHaveLength(10_000);
    expect(queries.read()).toEqual({ gets: 32, whereCalls: 1 });
  });

  it('assembles large tool-call fan-out without rescanning prior messages', async () => {
    const callCount = 5_000;
    const path: ThreadNode[] = [
      {
        id: 'assistant',
        threadId: 'thread',
        parentId: null,
        seq: 1,
        ts: 1,
        type: 'assistant_message',
        payload: { content: [], model: 'm', connectionId: 'c' },
      },
    ];
    for (let index = 0; index < callCount; index++) {
      path.push({
        id: `call-${index}`,
        threadId: 'thread',
        parentId: path.at(-1)!.id,
        seq: path.length + 1,
        ts: path.length + 1,
        type: 'tool_call',
        payload: { itemId: `item-${index}`, toolName: `tool-${index}`, params: {}, level: 'L0' },
      });
    }
    for (let index = 0; index < callCount; index++) {
      path.push({
        id: `result-${index}`,
        threadId: 'thread',
        parentId: path.at(-1)!.id,
        seq: path.length + 1,
        ts: path.length + 1,
        type: 'tool_result',
        payload: {
          itemId: `item-${index}`,
          ok: true,
          contentForLlm: [{ type: 'text', text: 'ok' }],
        },
      });
    }
    const tree = { getPath: async () => path } as unknown as ThreadTree;

    const context = await buildSessionContext(tree, 'thread', path.at(-1)!.id);

    expect(context.messages).toHaveLength(callCount + 1);
    expect(context.messages[0]?.role).toBe('assistant');
    if (context.messages[0]?.role !== 'assistant') throw new Error('expected assistant message');
    expect(context.messages[0].toolCalls).toHaveLength(callCount);
    expect(context.messages[0].toolCalls?.[0]).toMatchObject({ id: 'item-0', name: 'tool-0' });
    expect(context.messages[0].toolCalls?.at(-1)).toMatchObject({
      id: `item-${callCount - 1}`,
      name: `tool-${callCount - 1}`,
    });
  });

  it('preserves first-match tool names within an assistant and latest-assistant precedence', async () => {
    const path: ThreadNode[] = [
      {
        id: 'assistant-a',
        threadId: 'thread',
        parentId: null,
        seq: 1,
        ts: 1,
        type: 'assistant_message',
        payload: { content: [], model: 'm', connectionId: 'c' },
      },
      {
        id: 'call-first',
        threadId: 'thread',
        parentId: 'assistant-a',
        seq: 2,
        ts: 2,
        type: 'tool_call',
        payload: { itemId: 'duplicate', toolName: 'first', params: {}, level: 'L0' },
      },
      {
        id: 'call-second',
        threadId: 'thread',
        parentId: 'call-first',
        seq: 3,
        ts: 3,
        type: 'tool_call',
        payload: { itemId: 'duplicate', toolName: 'second', params: {}, level: 'L0' },
      },
      {
        id: 'result-a',
        threadId: 'thread',
        parentId: 'call-second',
        seq: 4,
        ts: 4,
        type: 'tool_result',
        payload: {
          itemId: 'duplicate',
          ok: true,
          trust: 'untrusted',
          provenance: 'page',
          contentForLlm: [{ type: 'text', text: 'first result' }],
        },
      },
      {
        id: 'assistant-b',
        threadId: 'thread',
        parentId: 'result-a',
        seq: 5,
        ts: 5,
        type: 'assistant_message',
        payload: { content: [], model: 'm', connectionId: 'c' },
      },
      {
        id: 'call-third',
        threadId: 'thread',
        parentId: 'assistant-b',
        seq: 6,
        ts: 6,
        type: 'tool_call',
        payload: { itemId: 'duplicate', toolName: 'third', params: {}, level: 'L0' },
      },
      {
        id: 'result-b',
        threadId: 'thread',
        parentId: 'call-third',
        seq: 7,
        ts: 7,
        type: 'tool_result',
        payload: {
          itemId: 'duplicate',
          ok: true,
          trust: 'untrusted',
          provenance: 'page',
          contentForLlm: [{ type: 'text', text: 'second result' }],
        },
      },
      {
        id: 'result-missing',
        threadId: 'thread',
        parentId: 'result-b',
        seq: 8,
        ts: 8,
        type: 'tool_result',
        payload: {
          itemId: 'missing',
          ok: true,
          trust: 'untrusted',
          provenance: 'page',
          contentForLlm: [{ type: 'text', text: 'missing result' }],
        },
      },
    ];
    const tree = { getPath: async () => path } as unknown as ThreadTree;

    const context = await buildSessionContext(tree, 'thread', 'result-missing');
    const fencedResults = context.messages
      .filter((message) => message.role === 'tool_result')
      .map((message) => (message.content[0]?.type === 'text' ? message.content[0].text : ''));

    expect(fencedResults[0]).toContain('tool="first"');
    expect(fencedResults[1]).toContain('tool="third"');
    expect(fencedResults[2]).toContain('tool="tool"');
  });
});
