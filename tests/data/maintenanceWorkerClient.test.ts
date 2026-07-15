import { afterEach, describe, expect, it, vi } from 'vitest';
import { maintenanceDigest } from '../../src/data/maintenanceRuntime';
import { MAINTENANCE_WORKER_PORT } from '../../src/data/maintenanceWorkerProtocol';

const RUNTIME_ID = 'panelot-test-extension';
const WORKER_URL = `chrome-extension://${RUNTIME_ID}/mcp-worker.html`;
const OPERATION_ID = '11111111-1111-4111-8111-111111111111';

type Listener<T extends (...args: never[]) => void> = {
  addListener(listener: T): void;
  removeListener(listener: T): void;
  emit(...args: Parameters<T>): void;
};

function listener<T extends (...args: never[]) => void>(): Listener<T> {
  const listeners = new Set<T>();
  return {
    addListener(value) {
      listeners.add(value);
    },
    removeListener(value) {
      listeners.delete(value);
    },
    emit(...args) {
      for (const value of listeners) value(...args);
    },
  };
}

function fakePort(options: { name?: string; id?: string; url?: string } = {}) {
  const onMessage = listener<(message: unknown) => void>();
  const onDisconnect = listener<() => void>();
  let onPost: ((message: unknown) => void) | undefined;
  const value = {
    name: options.name ?? MAINTENANCE_WORKER_PORT,
    sender: { id: options.id ?? RUNTIME_ID, url: options.url ?? WORKER_URL },
    onMessage,
    onDisconnect,
    postMessage: vi.fn((message: unknown) => onPost?.(message)),
    disconnect: vi.fn(),
  };
  return {
    value: value as unknown as chrome.runtime.Port,
    onMessage,
    onDisconnect,
    setPost(handler: (message: unknown) => void) {
      onPost = handler;
    },
    disconnect: value.disconnect,
  };
}

async function loadClient() {
  vi.resetModules();
  const sendMessage = vi.fn(async () => ({ ok: true }));
  vi.stubGlobal('chrome', {
    offscreen: {
      hasDocument: vi.fn(async () => true),
    },
    runtime: {
      id: RUNTIME_ID,
      getURL: (path: string) => `chrome-extension://${RUNTIME_ID}/${path}`,
      sendMessage,
    },
  });
  return { client: await import('../../src/data/maintenanceWorkerClient'), sendMessage };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('maintenance worker client', () => {
  it('accepts only the exact internal worker sender and routes cold-path commands', async () => {
    const { client, sendMessage } = await loadClient();
    const unrelated = fakePort({ name: 'unrelated' });
    const spoofed = fakePort({ url: `${WORKER_URL}?spoofed=1` });
    const trusted = fakePort();
    const duplicate = fakePort();

    expect(client.acceptMaintenanceWorkerPort(unrelated.value)).toBe(false);
    expect(unrelated.disconnect).not.toHaveBeenCalled();
    expect(client.acceptMaintenanceWorkerPort(spoofed.value)).toBe(true);
    expect(spoofed.disconnect).toHaveBeenCalledOnce();
    expect(client.acceptMaintenanceWorkerPort(trusted.value)).toBe(true);
    expect(client.acceptMaintenanceWorkerPort(duplicate.value)).toBe(true);
    expect(duplicate.disconnect).toHaveBeenCalledOnce();

    const command = {
      type: 'panelot.offscreen.attachments.evict' as const,
      activeThreadId: 'thread-1',
    };
    await client.sendOffscreenWorkerCommand(command);
    expect(trusted.value.postMessage).toHaveBeenCalledWith(command);
    await client.cleanupOffscreenAttachments();
    expect(sendMessage).toHaveBeenCalledWith({ type: 'panelot.offscreen.attachments.cleanup' });
  });

  it('accepts a correlated plan only when both worker digests match locally', async () => {
    const { client } = await loadClient();
    const port = fakePort();
    const input = {
      version: 1,
      exportedAt: 1,
      threads: [],
      nodes: [],
      skills: [],
      memories: [],
      settings: { language: 'en' },
    };
    port.setPost((message) => {
      const request = message as { requestId: string; operationId: string };
      void (async () => {
        const digest = await maintenanceDigest(input);
        const resultDigest = await maintenanceDigest({
          inputDigest: digest,
          settings: input.settings,
        });
        port.onMessage.emit({
          requestId: request.requestId,
          operationId: request.operationId,
          ok: true,
          result: { digest, resultDigest, settings: input.settings },
        });
      })();
    });
    client.acceptMaintenanceWorkerPort(port.value);

    const plan = await new client.MaintenanceWorkerValidator(async () => {}, 100).buildPlan(
      input,
      OPERATION_ID,
    );

    expect(plan).toMatchObject({ digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(plan.bundle.settings).toEqual(input.settings);
  });

  it.each([
    ['input digest', 'digest'],
    ['validated settings digest', 'resultDigest'],
  ] as const)('rejects a tampered %s', async (_label, field) => {
    const { client } = await loadClient();
    const port = fakePort();
    const input = {
      exportedAt: 1,
      threads: [],
      nodes: [],
      skills: [],
      memories: [],
      settings: {},
    };
    port.setPost((message) => {
      const request = message as { requestId: string; operationId: string };
      void (async () => {
        const digest = await maintenanceDigest(input);
        const resultDigest = await maintenanceDigest({ inputDigest: digest, settings: {} });
        port.onMessage.emit({
          requestId: request.requestId,
          operationId: request.operationId,
          ok: true,
          result: {
            digest: field === 'digest' ? '0'.repeat(64) : digest,
            resultDigest: field === 'resultDigest' ? '0'.repeat(64) : resultDigest,
            settings: {},
          },
        });
      })();
    });
    client.acceptMaintenanceWorkerPort(port.value);

    await expect(
      new client.MaintenanceWorkerValidator(async () => {}, 100).buildPlan(input, OPERATION_ID),
    ).rejects.toThrow(
      field === 'digest' ? 'IMPORT_VALIDATOR_DIGEST' : 'IMPORT_VALIDATOR_RESULT_DIGEST',
    );
  });

  it('fails closed on a mismatched correlation id', async () => {
    const { client } = await loadClient();
    const port = fakePort();
    port.setPost((message) => {
      const request = message as { requestId: string };
      port.onMessage.emit({
        requestId: request.requestId,
        operationId: '22222222-2222-4222-8222-222222222222',
        ok: false,
        error: 'ignored',
      });
    });
    client.acceptMaintenanceWorkerPort(port.value);

    await expect(
      new client.MaintenanceWorkerValidator(async () => {}, 100).buildPlan({}, OPERATION_ID),
    ).rejects.toThrow('IMPORT_VALIDATOR_CORRELATION');
    expect(port.disconnect).toHaveBeenCalledOnce();
  });

  it('fails pending work on disconnect, malformed messages, and timeout', async () => {
    for (const failure of ['disconnect', 'protocol', 'timeout'] as const) {
      const { client } = await loadClient();
      const port = fakePort();
      port.setPost(() => {
        if (failure === 'disconnect') queueMicrotask(() => port.onDisconnect.emit());
        if (failure === 'protocol') queueMicrotask(() => port.onMessage.emit({}));
      });
      client.acceptMaintenanceWorkerPort(port.value);

      await expect(
        new client.MaintenanceWorkerValidator(async () => {}, 5).buildPlan({}, OPERATION_ID),
      ).rejects.toThrow(
        failure === 'disconnect'
          ? 'IMPORT_VALIDATOR_DISCONNECTED'
          : failure === 'protocol'
            ? 'IMPORT_VALIDATOR_PROTOCOL'
            : 'IMPORT_VALIDATOR_TIMEOUT',
      );
    }
  });
});
