import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContextBlock } from '../../src/messaging/protocol';
import { captureSubmissionBrowserContext } from '../../src/ui/pageContext';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('captureSubmissionBrowserContext', () => {
  const referencedPage: ContextBlock = {
    kind: 'tab',
    label: 'Referenced page',
    tab: { tabId: 41, url: 'https://reference.example/', title: 'Referenced page' },
    content: [{ type: 'text', text: 'snapshot' }],
  };

  it('keeps the visible submission tab separate from referenced tabs', async () => {
    vi.stubGlobal('chrome', {
      tabs: {
        query: vi.fn(async () => [
          {
            id: 7,
            url: 'https://visible.example/',
            title: 'Visible page',
            active: true,
            lastAccessed: 200,
          },
          {
            id: 8,
            url: 'chrome-extension://panelot/chat.html',
            title: 'Panelot',
            active: true,
            lastAccessed: 300,
          },
        ]),
      },
    });

    const context = await captureSubmissionBrowserContext([referencedPage]);

    expect(context.defaultTab).toEqual({
      tabId: 7,
      url: 'https://visible.example/',
      title: 'Visible page',
    });
    expect(context.referencedTabs).toEqual([referencedPage.tab]);
  });

  it('does not silently promote a reference when no submission web tab is available', async () => {
    vi.stubGlobal('chrome', {
      tabs: { query: vi.fn(async () => []) },
    });

    const context = await captureSubmissionBrowserContext([referencedPage]);

    expect(context.defaultTab).toBeUndefined();
    expect(context.referencedTabs).toEqual([referencedPage.tab]);
  });
});
