import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpWorkerSessions } from '../../src/mcp/workerSessions';

interface TestClient {
  close(): Promise<void>;
  name: string;
}

function client(name: string): TestClient {
  return { name, close: vi.fn(async () => undefined) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('McpWorkerSessions', () => {
  it('does not let an older handshake replace or close the newer owner', () => {
    const sessions = new McpWorkerSessions<TestClient>();
    const oldConnection = sessions.claimConnection('server', 'old');
    const newConnection = sessions.claimConnection('server', 'new');
    const replacement = client('replacement');

    expect(sessions.commitConnection(newConnection.lease, replacement)).toBe(true);
    expect(sessions.commitConnection(oldConnection.lease, client('stale'))).toBe(false);
    const activeReplacementCall = sessions.claimToolCall('server', 'new', 'operation');
    expect(sessions.closeConnection('server', 'old')).toEqual({ owned: false });
    expect(sessions.getClient('server', 'new')).toBe(replacement);
    expect(activeReplacementCall.signal.aborted).toBe(false);
  });

  it('aborts active calls when their connection is replaced', () => {
    const sessions = new McpWorkerSessions<TestClient>();
    const first = sessions.claimConnection('server', 'first');
    expect(sessions.commitConnection(first.lease, client('first'))).toBe(true);
    const operation = sessions.claimToolCall('server', 'first', 'operation');

    const replacement = sessions.claimConnection('server', 'replacement');

    expect(operation.signal.aborted).toBe(true);
    expect(replacement.previous?.client.name).toBe('first');
  });

  it('honors a cancellation that arrives before call admission', () => {
    const sessions = new McpWorkerSessions<TestClient>();

    sessions.cancelToolCall('server', 'connection', 'operation');
    const operation = sessions.claimToolCall('server', 'connection', 'operation');

    expect(operation.signal.aborted).toBe(true);
  });

  it('aborts an admitted call without affecting another connection', () => {
    const sessions = new McpWorkerSessions<TestClient>();
    const target = sessions.claimToolCall('server', 'target', 'operation');
    const other = sessions.claimToolCall('server', 'other', 'operation');

    sessions.cancelToolCall('server', 'target', 'operation');

    expect(target.signal.aborted).toBe(true);
    expect(other.signal.aborted).toBe(false);
  });

  it('keeps arbitrary persisted server ids structurally isolated', () => {
    const sessions = new McpWorkerSessions<TestClient>();
    const first = sessions.claimToolCall('server\u0000tenant', 'connection', 'operation');
    const second = sessions.claimToolCall('server', 'tenant\u0000connection', 'operation');

    sessions.cancelToolCall('server\u0000tenant', 'connection', 'operation');

    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
  });

  it('expires and bounds unmatched cancellation tombstones', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-21T00:00:00Z'));
    const sessions = new McpWorkerSessions<TestClient>();
    for (let index = 0; index < 1_025; index += 1) {
      sessions.cancelToolCall('server', 'connection', `operation-${index}`);
    }

    expect(sessions.claimToolCall('server', 'connection', 'operation-0').signal.aborted).toBe(
      false,
    );
    expect(sessions.claimToolCall('server', 'connection', 'operation-1024').signal.aborted).toBe(
      true,
    );

    sessions.cancelToolCall('server', 'connection', 'expiring');
    vi.advanceTimersByTime(30_001);
    expect(sessions.claimToolCall('server', 'connection', 'expiring').signal.aborted).toBe(false);
  });
});
