import { describe, expect, it } from 'vitest';
import {
  compactionSpan,
  findCutPoint,
  mergeTrackedOps,
  shouldCompact,
} from '../../src/agent/compaction';
import type { ThreadNode, CompactionPayload } from '../../src/db/types';

let seq = 0;
function node(type: ThreadNode['type'], payload: unknown, id?: string): ThreadNode {
  seq++;
  return {
    id: id ?? `n${seq}`,
    threadId: 't',
    parentId: seq === 1 ? null : `n${seq - 1}`,
    seq,
    ts: seq,
    type,
    payload: payload as ThreadNode['payload'],
  };
}

const bigText = (label: string) => ({ content: [{ type: 'text', text: `${label} ${'x'.repeat(4000)}` }] });

describe('shouldCompact', () => {
  it('triggers only above window − reserve', () => {
    expect(shouldCompact(100_000, 128_000, { reserveTokens: 16_000, keepRecentTokens: 20_000 })).toBe(false);
    expect(shouldCompact(113_000, 128_000, { reserveTokens: 16_000, keepRecentTokens: 20_000 })).toBe(true);
  });
});

describe('findCutPoint (docs/04 §5.1)', () => {
  it('keeps at least keepRecentTokens and lands on a turn boundary', () => {
    seq = 0;
    const path = [
      node('turn_context', { turnId: 'a' }),
      node('user_message', bigText('old-q')),
      node('assistant_message', bigText('old-a')),
      node('turn_context', { turnId: 'b' }, 'anchor'),
      node('user_message', bigText('recent-q')),
      node('assistant_message', bigText('recent-a')),
    ];
    // Each big node ≈ 1000+ tokens; keep 2000 → cut lands at/before 'anchor'.
    const cut = findCutPoint(path, { reserveTokens: 0, keepRecentTokens: 2000 });
    expect(cut).toBe('anchor');
  });

  it('never cuts between a tool_call and its tool_result', () => {
    seq = 0;
    const path = [
      node('turn_context', { turnId: 'a' }),
      node('user_message', bigText('q1')),
      node('turn_context', { turnId: 'b' }, 'turn-b'),
      node('user_message', bigText('q2')),
      node('assistant_message', bigText('a2')),
      node('tool_call', { itemId: 'c1', toolName: 'click', params: {} }),
      node('tool_result', { itemId: 'c1', ok: true, contentForLlm: [{ type: 'text', text: 'r'.repeat(8000) }] }),
    ];
    // The naive cut would land inside the tool pair; it must walk back to turn-b.
    const cut = findCutPoint(path, { reserveTokens: 0, keepRecentTokens: 2500 });
    expect(cut).toBe('turn-b');
  });

  it('returns null when history is too short', () => {
    seq = 0;
    const path = [node('user_message', bigText('q'))];
    expect(findCutPoint(path)).toBeNull();
  });
});

describe('compactionSpan (compound-loss prevention)', () => {
  it('starts from the PREVIOUS firstKeptNodeId, not the previous compaction node', () => {
    seq = 0;
    const kept1 = node('user_message', bigText('gen1-kept'), 'kept1');
    const path = [
      node('user_message', bigText('gen1-old')),
      kept1,
      node('compaction', { summary: 's1', firstKeptNodeId: 'kept1' }),
      node('user_message', bigText('gen2-a'), 'kept2'),
      node('assistant_message', bigText('gen2-b')),
    ];
    const prev: CompactionPayload = {
      summary: 's1', firstKeptNodeId: 'kept1',
      tokensBefore: 0, tokensAfter: 0, trackedOps: { visitedUrls: [], mutatedTargets: [] },
    };
    const span = compactionSpan(path, prev, 'kept2');
    // Span = [kept1, kept2) minus compaction nodes → survivors get folded in.
    expect(span.map((n) => n.id)).toEqual(['kept1']);
  });

  it('spans from root when no previous compaction exists', () => {
    seq = 0;
    const path = [
      node('user_message', bigText('a'), 'first'),
      node('assistant_message', bigText('b')),
      node('user_message', bigText('c'), 'cut'),
    ];
    const span = compactionSpan(path, null, 'cut');
    expect(span.map((n) => n.id)).toEqual(['first', expect.any(String)].map((x) => x));
    expect(span).toHaveLength(2);
  });
});

describe('mergeTrackedOps (operation trail survives compactions)', () => {
  it('accumulates visited URLs and mutated targets across generations', () => {
    seq = 0;
    const span = [
      node('tool_call', { itemId: '1', toolName: 'navigate', params: { url: 'https://b.com' } }),
      node('tool_call', { itemId: '2', toolName: 'click', params: { element: '加入购物车按钮', ref: 's1_2' } }),
      node('tool_call', { itemId: '3', toolName: 'navigate', params: { url: 'https://a.com' } }), // dup below
    ];
    const merged = mergeTrackedOps(
      { visitedUrls: ['https://a.com'], mutatedTargets: ['搜索框'] },
      span,
    );
    expect(merged.visitedUrls).toEqual(['https://a.com', 'https://b.com']);
    expect(merged.mutatedTargets).toEqual(['搜索框', '加入购物车按钮']);
  });
});
