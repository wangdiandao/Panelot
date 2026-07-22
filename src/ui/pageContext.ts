/**
 * Page-context attachment (docs/development/ui.md §3.2 "当前页" chip): extract the
 * active tab's readable text via chrome.scripting on demand (activeTab).
 * The full snapshot engine supersedes this for agent operations;
 * this stays as the cheap "ask about this page" path.
 */

import type {
  BrowserTabIdentity,
  ContextBlock,
  SubmissionBrowserContext,
} from '../messaging/protocol';
import { t } from './i18n';

/** Rough token estimate (~4 chars/token). */
const approxTokens = (s: string) => Math.ceil(s.length / 4);
const MAX_CHARS = 24_000; // ≈ 6k tokens cap for an attached page

interface PageExtract {
  url: string;
  title: string;
  text: string;
}

/** Runs inside the page. Must be self-contained (serialized by chrome). */
function extractPageText(): PageExtract {
  // Prefer <article>/<main>; fall back to body text with scripts stripped.
  const root = document.querySelector('article') ?? document.querySelector('main') ?? document.body;
  const clone = root.cloneNode(true) as HTMLElement;
  clone
    .querySelectorAll('script,style,noscript,nav,footer,iframe,svg')
    .forEach((el) => el.remove());
  const text = (clone.innerText ?? '').replace(/\n{3,}/g, '\n\n').trim();
  return { url: location.href, title: document.title, text };
}

export async function getActiveTab(): Promise<chrome.tabs.Tab | null> {
  // `currentWindow: true` would return the sidepanel window — query all
  // windows and pick the most recently accessed http(s) tab instead.
  const tabs = await chrome.tabs.query({ active: true });
  const web = tabs
    .filter((t): t is chrome.tabs.Tab & { url: string } => !!t.url && /^https?:/.test(t.url))
    .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
  return web[0] ?? null;
}

function tabIdentity(tab: chrome.tabs.Tab): BrowserTabIdentity | undefined {
  if (tab.id === undefined || !tab.url || !/^https?:/.test(tab.url)) return undefined;
  return { tabId: tab.id, url: tab.url, title: tab.title ?? tab.url };
}

export async function captureSubmissionBrowserContext(
  contexts: ContextBlock[] = [],
): Promise<SubmissionBrowserContext> {
  const referencedTabs = [
    ...new Map(
      contexts.flatMap((context) =>
        context.tab ? ([[context.tab.tabId, context.tab]] as const) : [],
      ),
    ).values(),
  ];
  let active: chrome.tabs.Tab | null = null;
  try {
    active = await getActiveTab();
  } catch {
    // Non-extension render/test environments have no tabs API.
  }
  return {
    capturedAt: Date.now(),
    defaultTab: active ? tabIdentity(active) : undefined,
    referencedTabs,
  };
}

/** Extract a tab's readable text as a context block (null if not scriptable). */
async function attachTabById(
  tabId: number,
  url: string,
  kind: 'page' | 'tab',
): Promise<ContextBlock | null> {
  if (!/^https?:/.test(url)) return null;
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractPageText,
    });
    const page = result?.result as PageExtract | undefined;
    if (!page?.text) return null;
    const clipped =
      page.text.length > MAX_CHARS
        ? `${page.text.slice(0, MAX_CHARS)}\n${t('context.contentTruncated')}`
        : page.text;
    return {
      kind,
      label: page.title || new URL(page.url).hostname,
      origin: new URL(page.url).origin,
      tab: { tabId, url: page.url, title: page.title || page.url },
      content: [
        {
          type: 'text',
          text: t('context.pageContent', { title: page.title, url: page.url, content: clipped }),
        },
      ],
      approxTokens: approxTokens(clipped),
    };
  } catch {
    return null; // page not scriptable or permission missing
  }
}

/** Returns null when the page is not scriptable (chrome://, store, etc.). */
export async function attachCurrentPage(): Promise<ContextBlock | null> {
  const tab = await getActiveTab();
  if (!tab?.id || !tab.url) return null;
  return attachTabById(tab.id, tab.url, 'page');
}

/** Attach any open tab's readable text (for the @ trigger menu). */
export async function attachTab(tabId: number, url: string): Promise<ContextBlock | null> {
  return attachTabById(tabId, url, 'tab');
}

/** Open http(s) tabs, for the @ menu's tab list. */
export async function listAttachableTabs(): Promise<{ id: number; title: string; url: string }[]> {
  try {
    const tabs = await chrome.tabs.query({});
    return tabs
      .filter(
        (t): t is chrome.tabs.Tab & { id: number; url: string } =>
          t.id !== undefined && !!t.url && /^https?:/.test(t.url),
      )
      .map((t) => ({ id: t.id, title: t.title ?? t.url, url: t.url }));
  } catch {
    return [];
  }
}

/** Screenshot of the visible active tab as an image context block. */
export async function attachScreenshot(): Promise<ContextBlock | null> {
  try {
    const tab = await getActiveTab();
    if (!tab?.url || !/^https?:/.test(tab.url)) return null;
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    const base64 = dataUrl.split(',')[1];
    if (!base64) return null;
    return {
      kind: 'screenshot',
      label: t('context.screenshot', { title: tab.title ?? t('context.currentPage') }),
      origin: new URL(tab.url).origin,
      tab: tabIdentity(tab),
      content: [{ type: 'image', mime: 'image/png', data: base64 }],
      approxTokens: 1100, // rough vision-token estimate for a viewport shot
    };
  } catch {
    return null;
  }
}

/** Attach the current selection, if any. */
export async function attachSelection(): Promise<ContextBlock | null> {
  const tab = await getActiveTab();
  const identity = tab ? tabIdentity(tab) : undefined;
  return identity ? attachSelectionFromTab(identity) : null;
}

/** Attach the selection from the exact tab captured for this submission. */
export async function attachSelectionFromTab(
  tab: BrowserTabIdentity,
): Promise<ContextBlock | null> {
  if (!/^https?:/.test(tab.url)) return null;
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.tabId },
      func: () => ({
        text: window.getSelection()?.toString() ?? '',
        title: document.title,
        url: location.href,
      }),
    });
    const sel = result?.result as { text: string; title: string; url: string } | undefined;
    if (!sel?.text.trim()) return null;
    return {
      kind: 'selection',
      label: t('context.selection', { title: sel.title }),
      origin: new URL(sel.url).origin,
      tab: { tabId: tab.tabId, url: sel.url, title: sel.title || sel.url },
      content: [
        {
          type: 'text',
          text: t('context.selectionContent', { url: sel.url, content: sel.text }),
        },
      ],
      approxTokens: approxTokens(sel.text),
    };
  } catch {
    return null;
  }
}
