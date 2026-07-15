import { describe, expect, it } from 'vitest';
import { iterateSse, SseParser } from '../../src/providers/sse';

function feedAll(parser: SseParser, chunks: string[]) {
  const events: { event?: string; data: string }[] = [];
  let done = false;
  for (const chunk of chunks) {
    const r = parser.feed(chunk);
    events.push(...r.events);
    if (r.done) done = true;
  }
  return { events, done };
}

describe('SseParser (docs/03 §3.1)', () => {
  it('parses simple data events split by blank lines', () => {
    const { events } = feedAll(new SseParser(), ['data: {"a":1}\n\ndata: {"b":2}\n\n']);
    expect(events.map((e) => e.data)).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('tolerates a line split across chunks', () => {
    const { events } = feedAll(new SseParser(), ['data: {"hel', 'lo":true}\n', '\n']);
    expect(events).toEqual([{ event: undefined, data: '{"hello":true}' }]);
  });

  it('joins multiple data lines in one event with newline', () => {
    const { events } = feedAll(new SseParser(), ['data: line1\ndata: line2\n\n']);
    expect(events[0]!.data).toBe('line1\nline2');
  });

  it('terminates on [DONE] and ignores anything after', () => {
    const { events, done } = feedAll(new SseParser(), ['data: x\n\ndata: [DONE]\n\ndata: y\n\n']);
    expect(events.map((e) => e.data)).toEqual(['x']);
    expect(done).toBe(true);
  });

  it('handles CRLF line endings', () => {
    const { events } = feedAll(new SseParser(), ['data: a\r\n\r\n']);
    expect(events[0]!.data).toBe('a');
  });

  it('captures event names (Anthropic style)', () => {
    const { events } = feedAll(new SseParser(), ['event: message_start\ndata: {"x":1}\n\n']);
    expect(events[0]).toEqual({ event: 'message_start', data: '{"x":1}' });
  });

  it('skips comment/keepalive lines', () => {
    const { events } = feedAll(new SseParser(), [': keepalive\n\ndata: real\n\n']);
    expect(events.map((e) => e.data)).toEqual(['real']);
  });

  it('flush() recovers a trailing event without final blank line', () => {
    const parser = new SseParser();
    parser.feed('data: tail');
    expect(parser.flush()).toEqual([{ event: undefined, data: 'tail' }]);
  });

  it('handles many events in a single chunk', () => {
    const chunk = Array.from({ length: 50 }, (_, i) => `data: ${i}\n\n`).join('');
    const { events } = feedAll(new SseParser(), [chunk]);
    expect(events).toHaveLength(50);
  });
});

describe('iterateSse stream termination', () => {
  it('exposes [DONE] as an explicit terminal event', async () => {
    const body = new Response('data: {"ok":true}\n\ndata: [DONE]\n\n').body!;

    const events = [];
    for await (const event of iterateSse(body)) events.push(event);

    expect(events).toEqual([
      { event: undefined, data: '{"ok":true}' },
      { data: '', terminal: 'done' },
    ]);
  });

  it('normalizes a reader rejection as a retryable network failure', async () => {
    let delivered = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!delivered) {
          delivered = true;
          controller.enqueue(new TextEncoder().encode('data: {"ok":true}\n\n'));
          return;
        }
        controller.error(new Error('connection reset'));
      },
    });

    const consume = async () => {
      const iterator = iterateSse(body);
      while (!(await iterator.next()).done) {
        // Drain until the underlying reader rejects.
      }
    };

    await expect(consume()).rejects.toMatchObject({ kind: 'network' });
  });
});
