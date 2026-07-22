// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AboutPage } from '../../src/ui/settings/AboutPage';
import { setLang, t } from '../../src/ui/i18n';

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  setLang('zh-CN');
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: { runtime: { getManifest: () => ({ version: '0.4.5' }) } },
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, 'chrome');
});

function buttonContaining(text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

describe('AboutPage update check', () => {
  it('shows the current browser download after finding a newer release', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              tag_name: 'v0.5.0',
              html_url: 'https://github.com/wangdiandao/Panelot/releases/tag/v0.5.0',
              draft: false,
              prerelease: false,
              assets: [
                {
                  name: 'panelot-chrome.zip',
                  browser_download_url:
                    'https://github.com/wangdiandao/Panelot/releases/download/v0.5.0/panelot-chrome.zip',
                  content_type: 'application/zip',
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    );

    await act(async () => root.render(createElement(AboutPage)));
    await act(async () => {
      buttonContaining(t('settings.about.update.check')).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('发现新版本 v0.5.0');
    const download = [...container.querySelectorAll('a')].find((link) =>
      link.textContent?.includes(t('settings.about.update.download')),
    );
    expect(download?.getAttribute('href')).toBe(
      'https://github.com/wangdiandao/Panelot/releases/download/v0.5.0/panelot-chrome.zip',
    );
  });

  it('shows a localized error without exposing a remote response body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('secret upstream detail', { status: 429 })),
    );

    await act(async () => root.render(createElement(AboutPage)));
    await act(async () => {
      buttonContaining(t('settings.about.update.check')).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const alertText = container.querySelector('[role="alert"]')?.textContent ?? '';
    expect(alertText).toContain(t('settings.about.update.errorTitle'));
    expect(alertText).not.toContain('secret upstream detail');
  });
});
