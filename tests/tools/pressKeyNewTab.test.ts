import { describe, expect, it, vi } from 'vitest';
import { createL1Tools } from '../../src/tools/browserTools';
import type { BrowserToolGateway } from '../../src/tools/gateway';

describe('press_key new-tab handoff', () => {
  it('renders the created tab instead of reporting the unchanged source page', async () => {
    const dispatchKey = vi.fn(async () => {});
    const gateway = {
      getOperationTab: vi.fn(async () => 7),
      runWithNewTabCapture: vi.fn(
        async (_threadId: string, _tabId: number, action: () => Promise<unknown>) => {
          await action();
          return {
            value: { id: 7, url: 'https://example.test/source', status: 'complete' },
            createdTabResult: {
              resultTabId: 9,
              resultText: '链接已在新标签页打开：https://example.test/next',
              evidence: {
                attemptId: 'attempt-1',
                attempts: [],
                effectState: 'verified',
                observedEffects: ['tab_created'],
                outcome: 'verified',
              },
            },
          };
        },
      ),
    };
    (globalThis as unknown as { chrome: unknown }).chrome = {
      tabs: {
        get: vi.fn(async () => ({ id: 7, url: 'https://example.test/source' })),
      },
    };
    const pressKey = createL1Tools(gateway as unknown as BrowserToolGateway, () => 'thread-1', {
      dispatchKey,
      getTabId: vi.fn(async () => 7),
    }).find((tool) => tool.name === 'press_key')!;

    const signal = new AbortController().signal;
    const result = await pressKey.execute('call-1', { key: 'Enter' }, signal, undefined);

    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('[tabId=9] 链接已在新标签页打开'),
    });
    expect(dispatchKey).toHaveBeenCalledWith(7, 'Enter', signal, expect.any(Number));
  });
});
