import type { PanelotDB } from '../db/schema';
import { ThreadTree, type AppendNodeInput } from '../db/tree';
import type { PendingToolExecution, ToolCallPayload } from '../db/types';

export function stablePersistenceKey(value: unknown): string {
  const ancestors = new Set<object>();

  const encode = (current: unknown): string => {
    if (current === null) return 'null';
    if (current === undefined) return 'undefined';
    if (typeof current === 'string') return `string:${JSON.stringify(current)}`;
    if (typeof current === 'boolean') return `boolean:${current}`;
    if (typeof current === 'number') {
      if (Number.isNaN(current)) return 'number:NaN';
      if (Object.is(current, -0)) return 'number:-0';
      return `number:${String(current)}`;
    }
    if (typeof current === 'bigint') return `bigint:${String(current)}`;
    if (typeof current !== 'object') {
      throw new Error(`Unsupported persisted value type: ${typeof current}`);
    }
    if (ancestors.has(current)) throw new Error('Persisted value contains a cycle');
    ancestors.add(current);
    try {
      if (Array.isArray(current)) return `array:[${current.map(encode).join(',')}]`;
      if (current instanceof Date) return `date:${current.toISOString()}`;
      const entries = Object.keys(current)
        .sort()
        .map(
          (key) => `${JSON.stringify(key)}:${encode((current as Record<string, unknown>)[key])}`,
        );
      return `object:{${entries.join(',')}}`;
    } finally {
      ancestors.delete(current);
    }
  };

  return encode(value);
}

export function assertPreparedToolCall(
  node: AppendNodeInput,
  pendingTool: PendingToolExecution,
): asserts node is AppendNodeInput & { id: string; type: 'tool_call' } {
  if (node.type !== 'tool_call' || !node.id) {
    throw new Error('Prepared tool call must have a stable tool_call node id');
  }
  const payload = node.payload as ToolCallPayload;
  if (payload.itemId !== pendingTool.itemId || payload.toolName !== pendingTool.toolName) {
    throw new Error('Prepared tool call node does not match pendingTool');
  }
}

export async function persistStableToolCallNode(
  db: PanelotDB,
  threadId: string,
  node: AppendNodeInput & { id: string; type: 'tool_call' },
): Promise<void> {
  const existing = await db.nodes.get(node.id);
  if (existing) {
    const parentMatches = node.parentId === undefined || existing.parentId === node.parentId;
    const timestampMatches = node.ts === undefined || existing.ts === node.ts;
    if (
      existing.threadId !== threadId ||
      existing.type !== 'tool_call' ||
      !parentMatches ||
      !timestampMatches ||
      stablePersistenceKey(existing.payload) !== stablePersistenceKey(node.payload)
    ) {
      throw new Error(`Prepared tool call node identity collision: ${node.id}`);
    }
    return;
  }

  await new ThreadTree(db).appendNode(threadId, node);
}
