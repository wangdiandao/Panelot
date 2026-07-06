/**
 * buildRows live-overlay contract: user echo items render immediately, and
 * completed live assistant items stay visible until the snapshot refresh
 * (they used to vanish on item.complete for the rest of a multi-step turn).
 */
import { describe, expect, it } from 'vitest';
import { buildRows } from '../../src/ui/components/MessageStream';
import type { LiveItem } from '../../src/ui/engineClient';

const live = (over: Partial<LiveItem>): LiveItem => ({
  itemId: 'i1',
  kind: 'assistant_message',
  meta: {},
  text: '',
  reasoning: '',
  status: 'streaming',
  ...over,
});

describe('buildRows live overlay', () => {
  it('renders a live user_message item as a user row', () => {
    const rows = buildRows([], [live({ kind: 'user_message', text: 'hi there', status: 'ok' })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('user');
  });

  it('keeps a completed live assistant item visible (no flicker mid-turn)', () => {
    const rows = buildRows([], [live({ text: 'partial answer', status: 'ok' })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'assistant', streaming: false, liveText: 'partial answer' });
  });

  it('still marks streaming assistant rows as streaming', () => {
    const rows = buildRows([], [live({ text: 'typing…', status: 'streaming' })]);
    expect(rows[0]).toMatchObject({ kind: 'assistant', streaming: true });
  });

  it('skips empty live items (no text yet)', () => {
    const rows = buildRows([], [live({ kind: 'user_message', text: '' }), live({ itemId: 'i2', text: '' })]);
    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

import type { SnapshotItem } from '../../src/messaging/protocol';

let seq = 0;
const item = (kind: SnapshotItem['kind'], payload: unknown): SnapshotItem => ({
  nodeId: `n${seq++}`,
  kind,
  ts: seq,
  payload,
});
const userMsg = (text: string) => item('user_message', { content: [{ type: 'text', text }] });
const assistantMsg = (text: string) => item('assistant_message', { content: [{ type: 'text', text }], model: 'm', connectionId: 'c' });
const toolCall = (toolName: string, params: unknown = {}) =>
  item('tool_call', { itemId: `t${seq}`, toolName, params, level: 'L1' });

describe('buildRows historical fold (docs/09 §4.2)', () => {
  it('marks tools rows BEFORE the last user message as historical', () => {
    const rows = buildRows(
      [userMsg('q1'), toolCall('click'), assistantMsg('a1'), userMsg('q2'), toolCall('click'), assistantMsg('a2')],
      [],
    );
    const toolsRows = rows.filter((r) => r.kind === 'tools') as { historical?: boolean }[];
    expect(toolsRows).toHaveLength(2);
    expect(toolsRows[0]!.historical).toBe(true);
    expect(toolsRows[1]!.historical).toBeUndefined();
  });

  it('single-turn conversations keep their tools row un-folded', () => {
    const rows = buildRows([userMsg('q'), toolCall('click'), assistantMsg('a')], []);
    const tools = rows.find((r) => r.kind === 'tools') as { historical?: boolean };
    expect(tools.historical).toBeUndefined();
  });
});

describe('buildRows citations (visited-page pill)', () => {
  it('collects navigate/open_tab URLs onto the turn-closing assistant message', () => {
    const rows = buildRows(
      [
        userMsg('compare these'),
        toolCall('navigate', { url: 'https://a.example/x' }),
        toolCall('open_tab', { url: 'https://b.example/y' }),
        toolCall('navigate', { url: 'https://a.example/x' }), // dupe → dropped
        assistantMsg('done'),
      ],
      [],
    );
    const assistant = rows.find((r) => r.kind === 'assistant') as { citations?: { url: string }[] };
    expect(assistant.citations?.map((c) => c.url)).toEqual(['https://a.example/x', 'https://b.example/y']);
  });

  it('resets per turn and ignores non-URL tools', () => {
    const rows = buildRows(
      [
        userMsg('q1'),
        toolCall('navigate', { url: 'https://a.example' }),
        assistantMsg('a1'),
        userMsg('q2'),
        toolCall('click', { ref: 's1_2' }),
        assistantMsg('a2'),
      ],
      [],
    );
    const assistants = rows.filter((r) => r.kind === 'assistant') as { citations?: { url: string }[] }[];
    expect(assistants[0]!.citations?.map((c) => c.url)).toEqual(['https://a.example']);
    expect(assistants[1]!.citations).toBeUndefined();
  });
});
