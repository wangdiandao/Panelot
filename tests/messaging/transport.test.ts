import { describe, expect, it, vi } from 'vitest';
import { wrapBufferedPortConnection } from '../../src/messaging/transport';

function createFakePort() {
  const messageListeners = new Set<(message: unknown) => void>();
  const disconnectListeners = new Set<() => void>();
  const emitDisconnect = () => {
    for (const listener of disconnectListeners) listener();
  };
  const disconnect = vi.fn(emitDisconnect);
  const port = {
    name: 'panelot-engine',
    postMessage: vi.fn(),
    disconnect,
    onMessage: {
      addListener: vi.fn((listener: (message: unknown) => void) => {
        messageListeners.add(listener);
      }),
      removeListener: vi.fn((listener: (message: unknown) => void) => {
        messageListeners.delete(listener);
      }),
    },
    onDisconnect: {
      addListener: vi.fn((listener: () => void) => {
        disconnectListeners.add(listener);
      }),
      removeListener: vi.fn((listener: () => void) => {
        disconnectListeners.delete(listener);
      }),
    },
  } as unknown as chrome.runtime.Port;

  return {
    port,
    disconnect,
    emitMessage(message: unknown) {
      for (const listener of messageListeners) listener(message);
    },
    emitDisconnect,
  };
}

describe('buffered runtime Port connection', () => {
  it('replays early messages in order and then forwards live messages once', () => {
    const fake = createFakePort();
    const connection = wrapBufferedPortConnection(fake.port);
    const received: unknown[] = [];

    fake.emitMessage({ type: 'initialize', submissionId: 'early-1' });
    fake.emitMessage({ type: 'thread.subscribe', submissionId: 'early-2' });
    connection.onOp((message) => received.push(message));
    fake.emitMessage({ type: 'turn.submit', submissionId: 'live-1' });

    expect(received).toEqual([
      { type: 'initialize', submissionId: 'early-1' },
      { type: 'thread.subscribe', submissionId: 'early-2' },
      { type: 'turn.submit', submissionId: 'live-1' },
    ]);
  });

  it('disconnects fail-closed when the pending queue reaches its bound', () => {
    const fake = createFakePort();
    const connection = wrapBufferedPortConnection(fake.port, 2);
    const received: unknown[] = [];

    fake.emitMessage('one');
    fake.emitMessage('two');
    fake.emitMessage('overflow');
    connection.onOp((message) => received.push(message));

    expect(fake.disconnect).toHaveBeenCalledTimes(1);
    expect(received).toEqual([]);
  });

  it('reports a disconnect that happened before the close handler was installed once', async () => {
    const fake = createFakePort();
    const connection = wrapBufferedPortConnection(fake.port);
    const onClose = vi.fn();

    fake.emitDisconnect();
    connection.onClose(onClose);
    await Promise.resolve();
    fake.emitDisconnect();

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
