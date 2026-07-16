import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContextBlock } from '../../src/messaging/protocol';
import { setLang } from '../../src/ui/i18n';
import {
  attachSelectionFromTab,
  attachTab,
  captureSubmissionBrowserContext,
} from '../../src/ui/pageContext';

afterEach(() => {
  setLang('zh-CN');
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

  it('localizes page truncation and selection context content', async () => {
    setLang('en');
    const executeScript = vi
      .fn()
      .mockResolvedValueOnce([
        {
          result: {
            text: 'x'.repeat(60_001),
            title: 'Long page',
            url: 'https://page.example/path',
          },
        },
      ])
      .mockResolvedValueOnce([
        {
          result: {
            text: 'selected text',
            title: 'Selection page',
            url: 'https://selection.example/path',
          },
        },
      ]);
    vi.stubGlobal('chrome', { scripting: { executeScript } });

    const page = await attachTab(7, 'https://page.example/path');
    const selection = await attachSelectionFromTab({
      tabId: 8,
      url: 'https://selection.example/path',
      title: 'Selection page',
    });

    expect(page?.content[0]).toMatchObject({ type: 'text' });
    expect((page?.content[0] as { text?: string }).text).toContain('[Content truncated]');
    expect((selection?.content[0] as { text?: string }).text).toBe(
      'Selection from https://selection.example/path:\n\nselected text',
    );
  });
});
