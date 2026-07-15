/**
 * buildRows live-overlay contract: user echo items render immediately, and
 * completed live assistant items stay visible until the snapshot refresh
 * (they used to vanish on item.complete for the rest of a multi-step turn).
 */
import { describe, expect, it } from 'vitest';
import {
  buildRows,
  isAssistantRowRunning,
  partitionAssistantSegments,
} from '../../src/ui/components/MessageStream';
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

  it('carries attached context chips onto the echoed user row', () => {
    const attachedContext = [
      {
        kind: 'page' as const,
        label: '淘宝-XX耳机',
        content: [{ type: 'text' as const, text: '…' }],
      },
    ];
    const rows = buildRows(
      [],
      [live({ kind: 'user_message', text: 'compare these', status: 'ok', attachedContext })],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'user',
      payload: { attachedContext: [{ label: '淘宝-XX耳机' }] },
    });
  });

  it('keeps a completed live assistant item visible (no flicker mid-turn)', () => {
    const rows = buildRows([], [live({ text: 'partial answer', status: 'ok' })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'assistant' });
    expect(rows[0]!.kind === 'assistant' && rows[0]!.segments[0]).toMatchObject({
      kind: 'message',
      streaming: false,
      liveText: 'partial answer',
    });
  });

  it('still marks streaming assistant rows as streaming', () => {
    const rows = buildRows([], [live({ text: 'typing…', status: 'streaming' })]);
    expect(rows[0]!.kind === 'assistant' && rows[0]!.segments[0]).toMatchObject({
      kind: 'message',
      streaming: true,
    });
  });

  it.each([
    ['ok', 'ok'],
    ['fail', 'fail'],
  ] as const)('keeps a completed live tool visible with %s status', (status, expected) => {
    const rows = buildRows(
      [],
      [
        live({
          kind: 'tool_call',
          itemId: `tool-${status}`,
          meta: { toolName: 'click', label: 'Click' },
          status,
        }),
      ],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'assistant',
      segments: [
        {
          kind: 'tools',
          cards: [{ itemId: `tool-${status}`, status: expected, live: true }],
        },
      ],
    });
  });

  it('merges a live tool completion over a pending snapshot card', () => {
    const persistedCall = item('tool_call', {
      itemId: 'shared-tool',
      toolName: 'click',
      params: { ref: 's1_1' },
      level: 'L1',
    });
    const rows = buildRows(
      [persistedCall],
      [
        live({
          kind: 'tool_call',
          itemId: 'shared-tool',
          meta: { toolName: 'click' },
          status: 'ok',
        }),
      ],
    );

    expect(rows[0]).toMatchObject({
      kind: 'assistant',
      segments: [
        {
          kind: 'tools',
          cards: [{ itemId: 'shared-tool', status: 'ok', live: true, params: { ref: 's1_1' } }],
        },
      ],
    });
  });

  it('keeps the process running after a live browser step completes', () => {
    const rows = buildRows(
      [],
      [
        live({
          kind: 'tool_call',
          itemId: 'completed-live-tool',
          meta: { toolName: 'click' },
          status: 'ok',
        }),
      ],
    );
    const row = rows[0];
    if (!row || row.kind !== 'assistant') throw new Error('expected assistant row');

    expect(isAssistantRowRunning(row, false, 'another-row')).toBe(true);
  });

  it('skips empty live items (no text yet)', () => {
    const rows = buildRows(
      [],
      [live({ kind: 'user_message', text: '' }), live({ itemId: 'i2', text: '' })],
    );
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
const assistantMsg = (text: string, reasoning?: string) =>
  item('assistant_message', {
    content: [{ type: 'text', text }],
    model: 'm',
    connectionId: 'c',
    reasoning,
  });
const toolCall = (toolName: string, params: unknown = {}) =>
  item('tool_call', { itemId: `t${seq}`, toolName, params, level: 'L1' });

describe('buildRows historical fold (docs/09 §4.2)', () => {
  it('marks tool segments before the last user message as historical', () => {
    const rows = buildRows(
      [
        userMsg('q1'),
        toolCall('click'),
        assistantMsg('a1'),
        userMsg('q2'),
        toolCall('click'),
        assistantMsg('a2'),
      ],
      [],
    );
    const assistants = rows.filter((r) => r.kind === 'assistant');
    expect(assistants).toHaveLength(2);
    expect(assistants[0]!.historical).toBe(true);
    expect(assistants[0]!.segments.find((segment) => segment.kind === 'tools')).toMatchObject({
      historical: true,
    });
    expect(assistants[1]!.historical).toBeUndefined();
  });

  it('single-turn conversations keep their tools row un-folded', () => {
    const rows = buildRows([userMsg('q'), toolCall('click'), assistantMsg('a')], []);
    const assistant = rows.find((r) => r.kind === 'assistant');
    expect(assistant?.kind).toBe('assistant');
    const tools =
      assistant?.kind === 'assistant' &&
      assistant.segments.find((segment) => segment.kind === 'tools');
    expect(tools && tools.kind === 'tools' && tools.historical).toBeUndefined();
  });

  it('keeps interleaved reasoning, tools, and the answer in their real order', () => {
    const rows = buildRows(
      [
        userMsg('q'),
        assistantMsg('', 'inspect the page'),
        toolCall('read_page'),
        assistantMsg('', 'open the matching result'),
        toolCall('click'),
        assistantMsg('answer', 'summarize the evidence'),
      ],
      [],
    );
    expect(rows.map((row) => row.kind)).toEqual(['user', 'assistant']);
    const assistant = rows[1];
    expect(assistant?.kind).toBe('assistant');
    if (assistant?.kind !== 'assistant') throw new Error('expected assistant row');
    expect(assistant.segments.map((segment) => segment.kind)).toEqual([
      'message',
      'tools',
      'message',
      'tools',
      'message',
    ]);
    expect(
      assistant.segments.map((segment) =>
        segment.kind === 'message'
          ? segment.payload.reasoning ||
            segment.payload.content.find((content) => content.type === 'text')?.text
          : segment.cards[0]?.toolName,
      ),
    ).toEqual([
      'inspect the page',
      'read_page',
      'open the matching result',
      'click',
      'summarize the evidence',
    ]);
  });
});

describe('assistant process presentation', () => {
  const interleavedRow = () => {
    const rows = buildRows(
      [
        userMsg('q'),
        assistantMsg('', 'inspect the page'),
        toolCall('read_page'),
        assistantMsg('', 'check the result'),
        toolCall('click'),
        assistantMsg('final answer', 'summarize the evidence'),
      ],
      [],
    );
    const row = rows.find((candidate) => candidate.kind === 'assistant');
    if (!row || row.kind !== 'assistant') throw new Error('expected assistant row');
    return row;
  };

  it('keeps the final answer outside the process after completion', () => {
    const { processSegments, resultMessage } = partitionAssistantSegments(interleavedRow(), false);

    expect(resultMessage?.kind).toBe('message');
    expect(resultMessage?.kind === 'message' && resultMessage.payload.content[0]).toMatchObject({
      type: 'text',
      text: 'final answer',
    });
    expect(processSegments.map((segment) => segment.kind)).toEqual([
      'message',
      'tools',
      'message',
      'tools',
      'message',
    ]);
  });

  it('keeps every stage in the expanded process while the turn is running', () => {
    const { processSegments, resultMessage } = partitionAssistantSegments(interleavedRow(), true);

    expect(resultMessage).toBeUndefined();
    expect(processSegments).toHaveLength(5);
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
    const assistant = rows.find((r) => r.kind === 'assistant');
    const message =
      assistant?.kind === 'assistant'
        ? assistant.segments.find((segment) => segment.kind === 'message')
        : undefined;
    expect(message?.kind === 'message' && message.citations?.map((c) => c.url)).toEqual([
      'https://a.example/x',
      'https://b.example/y',
    ]);
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
    const assistants = rows.filter((r) => r.kind === 'assistant');
    const firstMessage = assistants[0]?.segments.find((segment) => segment.kind === 'message');
    const secondMessage = assistants[1]?.segments.find((segment) => segment.kind === 'message');
    expect(firstMessage?.kind === 'message' && firstMessage.citations?.map((c) => c.url)).toEqual([
      'https://a.example',
    ]);
    expect(secondMessage?.kind === 'message' && secondMessage.citations).toBeUndefined();
  });
});
