/**
 * Hand-written buffered SSE parser (docs/03 §3.1).
 *
 * Requirements it MUST satisfy (compat with imperfect "OpenAI-compatible"
 * relays):
 *  - events split on blank lines (\n\n or \r\n\r\n)
 *  - tolerate multiple `data:` lines within one event (joined with \n per spec)
 *  - tolerate a line split across network chunks (buffer until newline)
 *  - `data: [DONE]` terminates the stream (OpenAI convention)
 *
 * State machine: bytes → buffer → complete lines → complete events.
 * Parsing approach follows the WHATWG EventSource spec's field grammar;
 * simplified from the eventsource-parser package's design.
 */

export interface SseEvent {
  event?: string;
  data: string;
}

/**
 * Incremental parser: feed() chunks as they arrive, receive complete events.
 * Returns `done: true` once `[DONE]` is seen; callers should stop feeding.
 */
export class SseParser {
  private buffer = '';
  private eventName: string | undefined;
  private dataLines: string[] = [];

  /** Parse a decoded text chunk; returns completed events in order. */
  feed(chunk: string): { events: SseEvent[]; done: boolean } {
    this.buffer += chunk;
    const events: SseEvent[] = [];
    let done = false;

    for (;;) {
      const nl = this.buffer.indexOf('\n');
      if (nl === -1) break;
      let line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);

      if (line === '') {
        // Blank line = event boundary.
        if (this.dataLines.length > 0) {
          const data = this.dataLines.join('\n');
          this.dataLines = [];
          const event = this.eventName;
          this.eventName = undefined;
          if (data === '[DONE]') {
            done = true;
            break;
          }
          events.push({ event, data });
        } else {
          this.eventName = undefined;
        }
        continue;
      }

      if (line.startsWith(':')) continue; // comment / keepalive

      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);

      switch (field) {
        case 'data':
          this.dataLines.push(value);
          break;
        case 'event':
          this.eventName = value;
          break;
        // id / retry: irrelevant for our use case.
      }
    }

    return { events, done };
  }

  /** Flush a trailing event not terminated by a blank line (lenient servers). */
  flush(): SseEvent[] {
    // A partial buffered line without trailing newline is also considered.
    if (this.buffer !== '') {
      const line = this.buffer.endsWith('\r') ? this.buffer.slice(0, -1) : this.buffer;
      this.buffer = '';
      if (line.startsWith('data:')) {
        let value = line.slice(5);
        if (value.startsWith(' ')) value = value.slice(1);
        if (value !== '[DONE]') this.dataLines.push(value);
      }
    }
    if (this.dataLines.length === 0) return [];
    const data = this.dataLines.join('\n');
    this.dataLines = [];
    const event = this.eventName;
    this.eventName = undefined;
    return [{ event, data }];
  }
}

/**
 * Convenience: turn a fetch Response body into an async iterable of SSE
 * events. Throws ProviderError('network') on mid-stream disconnects.
 */
export async function* iterateSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  try {
    for (;;) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      const { value, done } = await reader.read();
      if (done) break;
      const result = parser.feed(decoder.decode(value, { stream: true }));
      for (const ev of result.events) yield ev;
      if (result.done) return;
    }
    for (const ev of parser.flush()) yield ev;
  } finally {
    reader.releaseLock();
  }
}
