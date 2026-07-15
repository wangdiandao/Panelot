/**
 * L0 + L1 browser tool definitions (docs/05 §3). zod schemas are the single
 * source of truth; descriptions follow docs/10 §3 — one sentence of function,
 * when to use, what to do on failure.
 */

import { schema } from '../agent/schema';
import type { AnyAgentTool } from '../agent/tool';
import { waitForTabLoad, type BrowserToolGateway } from './gateway';
import type { ExecuteResult } from './content/executor';
import type { PanelotDB } from '../db/schema';
import { ActionRunner } from './action/runner';
import { actionError, ActionError } from './action/errors';
import { ActionDeadline, abortedAction, deadlineForTool, waitWithContext } from './action/deadline';
import type { ActionEvidence } from './action/types';

/**
 * How much extracted markdown to feed the model per call. Beyond this the full
 * body is offloaded to an attachment and the model gets this much as a window,
 * with fromChar to page further. Borrowed from chrome-agent-skill's save_path /
 * browser-use's file_system: big page text must not flood context.
 */
const EXTRACT_WINDOW_CHARS = 8_000;

function throwIfToolDone(signal: AbortSignal | undefined, deadlineAt: number): void {
  new ActionDeadline(Number.POSITIVE_INFINITY, signal, deadlineAt).throwIfDone();
}

function awaitBrowserOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  deadlineAt: number,
  effectMayHaveOccurred = false,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(abortedAction('execute', { effectMayHaveOccurred })));
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(
            actionError('timeout', '工具执行超时（超过总截止时间）。', 'execute', true, {
              effectMayHaveOccurred,
            }),
          ),
        ),
      Math.max(0, deadlineAt - Date.now()),
    );
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    void operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function contentResult(result: ExecuteResult) {
  const parts: string[] = [result.resultText];
  if (result.snapshot) parts.push(`\n--- 增量快照 ---\n${result.snapshot}`);
  return {
    content: [{ type: 'text' as const, text: parts.join('\n') }],
    ...(result.evidence ? { details: { actionEvidence: result.evidence } } : {}),
  };
}

function tabbedContentResult(result: ExecuteResult, fallbackTabId: number) {
  const rendered = contentResult(result);
  rendered.content[0]!.text = `[tabId=${result.resultTabId ?? fallbackTabId}] ${rendered.content[0]!.text}`;
  return rendered;
}

function urlOrigin(value: string): string {
  const parsed = new URL(value);
  return parsed.origin === 'null' ? value : parsed.origin;
}

function canonicalHref(value: string): string {
  return new URL(value).href;
}

function verifiedNavigationEvidence(
  tabId: number,
  startedAt: number,
  urlBefore: string | undefined,
  urlAfter: string,
  effect: 'tab_created' | 'url_changed',
): ActionEvidence {
  return {
    attemptId: crypto.randomUUID(),
    tabId,
    ...(urlBefore ? { urlBefore } : {}),
    urlAfter,
    attempts: [
      {
        phase: 'verify',
        strategy: 'l0',
        startedAt,
        durationMs: Date.now() - startedAt,
      },
    ],
    effectState: 'verified',
    observedEffects: [effect],
    outcome: 'verified',
  };
}

async function tabTarget(tabId: number): Promise<{ tabId: number; origin?: string }> {
  const tab = await chrome.tabs.get(tabId);
  return { tabId, ...(tab.url ? { origin: urlOrigin(tab.url) } : {}) };
}

export async function currentBrowserTarget(
  gateway: BrowserToolGateway,
  getThreadId: () => string,
  requestedTabId?: number,
): Promise<{ tabId: number; origin?: string }> {
  return tabTarget(await gateway.getOperationTab(getThreadId(), requestedTabId));
}

/** element + ref dual params (docs/05 §3): element for approval display & model self-check. */
const elementRef = {
  element: schema.string({
    description: 'Human-readable description of the element, shown to the user in approvals',
  }),
  ref: schema.string({
    description:
      'Exact opaque ref copied from the LATEST snapshot. Fails if stale — re-run read_page.',
  }),
};

// ---------------------------------------------------------------------------
// L0 — tab management (no injection)
// ---------------------------------------------------------------------------

export function createL0Tools(
  gateway: BrowserToolGateway,
  getThreadId: () => string,
): AnyAgentTool[] {
  const threadId = getThreadId;
  /** Post-navigation snapshot (saves the model a read_page round-trip). */
  const withSnapshot = async (
    text: string,
    tabId: number,
    signal?: AbortSignal,
    deadlineAt = deadlineForTool('read_page', {}),
    actionEvidence?: ActionEvidence,
  ): Promise<{
    content: { type: 'text'; text: string }[];
    details?: { actionEvidence: ActionEvidence };
  }> => {
    try {
      const snap = await gateway.callContentTool(
        threadId(),
        'read_page',
        { maxTokens: 1500 },
        tabId,
        signal,
        deadlineAt,
      );
      return {
        content: [{ type: 'text', text: `[tabId=${tabId}] ${text}\n\n${snap.resultText}` }],
        ...(actionEvidence ? { details: { actionEvidence } } : {}),
      };
    } catch {
      return {
        content: [
          {
            type: 'text',
            text: `[tabId=${tabId}] ${text}\n（页面快照暂不可用，需要交互时先 read_page）`,
          },
        ],
        ...(actionEvidence ? { details: { actionEvidence } } : {}),
      };
    }
  };
  return [
    {
      name: 'tabs_list',
      label: '列出标签页',
      description:
        'List every open tab across all browser windows. Returns tab ids for direct use by every page tool and marks the tab the user is looking at.',
      parameters: schema.object({}),
      level: 'L0',
      effects: 'read',
      execute: async (_id, _params: Record<string, never>, signal) => {
        const deadlineAt = deadlineForTool('tabs_list', {});
        throwIfToolDone(signal, deadlineAt);
        // The tab the USER is looking at (active in the focused window) — the
        // model must be able to identify the default when tabId is omitted.
        const userTab = await gateway.getUserActiveTab();
        const tabs = await chrome.tabs.query({});
        const rows = tabs.map((t) => {
          const marks = [t.id === userTab?.id ? '用户正在看' : t.active ? '窗口活跃' : '']
            .filter(Boolean)
            .map((m) => `(${m})`)
            .join('');
          return `[${t.id}] ${marks ? `${marks} ` : ''}${t.title} — ${t.url}`;
        });
        return { content: [{ type: 'text', text: rows.join('\n') || '（无标签页）' }] };
      },
    },
    {
      name: 'tab_open',
      label: '打开标签页',
      description:
        'Open a URL in a background tab, or reuse an already-open exact URL without changing focus. Returns the tab id and states whether the user-visible page changed.',
      parameters: schema.object({ url: schema.string({ url: true }) }),
      level: 'L0',
      effects: 'write',
      resolveTarget: async (params: { url: string }) => ({ origin: urlOrigin(params.url) }),
      execute: async (_id, params: { url: string }, signal) => {
        const deadlineAt = deadlineForTool('tab_open', params);
        const startedAt = Date.now();
        throwIfToolDone(signal, deadlineAt);
        const target = new URL(params.url);
        const targetHref = target.href;
        const allTabs = await chrome.tabs.query({});
        const existing = allTabs.find((t) => {
          if (!t.url || t.id === undefined) return false;
          try {
            return canonicalHref(t.url) === targetHref;
          } catch {
            return false;
          }
        });
        if (existing?.id !== undefined) {
          await gateway.getOperationTab(threadId(), existing.id);
          await waitForTabLoad(existing.id, 15_000, signal, deadlineAt);
          const userTab = await gateway.getUserActiveTab();
          const visibility =
            userTab?.id === existing.id
              ? '它就是用户当前正在看的标签页；未打开新标签页，也未改变前台页面。'
              : '未切换前台，用户当前看到的页面没有变化。';
          return {
            content: [
              {
                type: 'text',
                text: `已复用 URL 完全相同的已打开标签页 [${existing.id}] ${targetHref}。${visibility}后续工具可直接传 tabId=${existing.id}。`,
              },
            ],
          };
        }
        const tab = await awaitBrowserOperation(
          chrome.tabs.create({ url: targetHref, active: false }),
          signal,
          deadlineAt,
          true,
        );
        if (tab.id === undefined) throw new Error('浏览器创建了标签页，但没有返回 tab id。');
        await gateway.getOperationTab(threadId(), tab.id);
        await waitForTabLoad(tab.id, 15_000, signal, deadlineAt);
        const loaded = await chrome.tabs.get(tab.id);
        if (!loaded.url || canonicalHref(loaded.url) !== targetHref) {
          throw actionError(
            'navigation_uncertain',
            `新标签页未确认加载完整 URL：${targetHref}`,
            'verify',
            true,
            { tabId: tab.id, actualUrl: loaded.url, effectMayHaveOccurred: true },
          );
        }
        return {
          content: [
            {
              type: 'text',
              text: `已在后台打开标签页 [${tab.id}] ${targetHref}（用户看到的页面没有变化）。`,
            },
          ],
          details: {
            actionEvidence: verifiedNavigationEvidence(
              tab.id,
              startedAt,
              undefined,
              targetHref,
              'tab_created',
            ),
          },
        };
      },
    },
    {
      name: 'tab_focus',
      label: '显示标签页',
      description:
        'Bring an already-open tab to the foreground. Use only when the user explicitly asks to see it; other browser tools operate background tabs directly via tabId.',
      parameters: schema.object({ tabId: schema.number({ integer: true, min: 0 }) }),
      level: 'L0',
      effects: 'write',
      resolveTarget: async (params: { tabId: number }) => tabTarget(params.tabId),
      execute: async (_id, params: { tabId: number }, signal) => {
        const deadlineAt = deadlineForTool('tab_focus', params);
        throwIfToolDone(signal, deadlineAt);
        const tab = await chrome.tabs.get(params.tabId);
        await awaitBrowserOperation(
          chrome.tabs.update(params.tabId, { active: true }),
          signal,
          deadlineAt,
          true,
        );
        if (tab.windowId !== undefined) {
          await awaitBrowserOperation(
            chrome.windows.update(tab.windowId, { focused: true }),
            signal,
            deadlineAt,
            true,
          ).catch((error) => {
            if (error instanceof ActionError) throw error;
            /* window may be gone */
          });
        }
        return {
          content: [
            {
              type: 'text',
              text: `已把标签页 [${params.tabId}]（${tab.title}）切到前台，用户现在看到的就是这个页面。`,
            },
          ],
        };
      },
    },
    {
      name: 'tab_close',
      label: '关闭标签页',
      description:
        "Close a tab by id (from tabs_list). Closing a background tab does not change what the user sees — the result states whether the user's visible tab changed.",
      parameters: schema.object({ tabId: schema.number({ integer: true, min: 0 }) }),
      level: 'L0',
      effects: 'write',
      resolveTarget: async (params: { tabId: number }) => tabTarget(params.tabId),
      execute: async (_id, params: { tabId: number }, signal) => {
        const deadlineAt = deadlineForTool('tab_close', params);
        throwIfToolDone(signal, deadlineAt);
        const tab = await chrome.tabs.get(params.tabId).catch(() => null);
        if (!tab) {
          throw new Error(
            `标签页 [${params.tabId}] 不存在（可能已被关闭）。用 tabs_list 查看当前标签页。`,
          );
        }
        // View-state honesty: record whether the user was LOOKING at this tab
        // before closing, so the model never invents a "switch back?" offer.
        const userTab = await gateway.getUserActiveTab();
        const wasUserVisible = userTab?.id === params.tabId;
        gateway.clearTarget(threadId(), params.tabId);
        await awaitBrowserOperation(chrome.tabs.remove(params.tabId), signal, deadlineAt, true);
        if (wasUserVisible) {
          const now = await gateway.getUserActiveTab();
          return {
            content: [
              {
                type: 'text',
                text: `已关闭标签页 [${params.tabId}]（${tab.title ?? tab.url}）。这是用户正在看的页面，浏览器已自动切换到${now ? ` [${now.id}] ${now.title}` : '相邻标签页'}。`,
              },
            ],
          };
        }
        return {
          content: [
            {
              type: 'text',
              text: `已关闭后台标签页 [${params.tabId}]（${tab.title ?? tab.url}）。用户当前看到的页面没有变化${userTab ? `（仍是 [${userTab.id}] ${userTab.title}）` : ''}，不需要切换回去。`,
            },
          ],
        };
      },
    },
    {
      name: 'navigate',
      label: '导航',
      description:
        'Navigate a tab to a URL. Pass tabId from tabs_list to operate it in the background. Returns a fresh snapshot; old refs are void.',
      parameters: schema.object({
        tabId: schema.optional(schema.number({ integer: true, min: 0 })),
        url: schema.string({ url: true }),
      }),
      level: 'L0',
      effects: 'write',
      resolveTarget: async (params: { tabId?: number; url: string }) => ({
        ...(await currentBrowserTarget(gateway, getThreadId, params.tabId)),
        origin: urlOrigin(params.url),
      }),
      execute: async (_id, params: { tabId?: number; url: string }, signal) => {
        const deadlineAt = deadlineForTool('navigate', params);
        const startedAt = Date.now();
        throwIfToolDone(signal, deadlineAt);
        const tabId = await gateway.getOperationTab(threadId(), params.tabId);
        const targetHref = canonicalHref(params.url);
        const before = await chrome.tabs.get(tabId);
        const beforeHref = before.url ? canonicalHref(before.url) : undefined;
        if (beforeHref === targetHref) {
          return withSnapshot(
            `页面已经位于 ${targetHref}，未派发导航。`,
            tabId,
            signal,
            deadlineAt,
          );
        }
        await awaitBrowserOperation(
          chrome.tabs.update(tabId, { url: targetHref }),
          signal,
          deadlineAt,
          true,
        );
        await waitForTabLoad(tabId, 15_000, signal, deadlineAt);
        const loaded = await chrome.tabs.get(tabId);
        if (!loaded.url || canonicalHref(loaded.url) !== targetHref) {
          throw actionError(
            'navigation_uncertain',
            `标签页未确认导航到完整 URL：${targetHref}`,
            'verify',
            true,
            { actualUrl: loaded.url, effectMayHaveOccurred: true },
          );
        }
        return withSnapshot(
          `已导航到 ${targetHref}`,
          tabId,
          signal,
          deadlineAt,
          verifiedNavigationEvidence(tabId, startedAt, beforeHref, targetHref, 'url_changed'),
        );
      },
    },
    {
      name: 'go_back',
      label: '后退',
      description:
        'Go back in a tab history. Pass tabId from tabs_list to operate it in the background. Returns a fresh snapshot.',
      parameters: schema.object({
        tabId: schema.optional(schema.number({ integer: true, min: 0 })),
      }),
      level: 'L0',
      effects: 'write',
      resolveTarget: (params: { tabId?: number }) =>
        currentBrowserTarget(gateway, getThreadId, params.tabId),
      execute: async (_id, params: { tabId?: number }, signal) => {
        const deadlineAt = deadlineForTool('go_back', params);
        throwIfToolDone(signal, deadlineAt);
        const tabId = await gateway.getOperationTab(threadId(), params.tabId);
        await awaitBrowserOperation(chrome.tabs.goBack(tabId), signal, deadlineAt, true);
        await waitForTabLoad(tabId, 15_000, signal, deadlineAt);
        return withSnapshot('已后退', tabId, signal, deadlineAt);
      },
    },
    {
      name: 'go_forward',
      label: '前进',
      description:
        'Go forward in a tab history. Pass tabId from tabs_list to operate it in the background. Returns a fresh snapshot.',
      parameters: schema.object({
        tabId: schema.optional(schema.number({ integer: true, min: 0 })),
      }),
      level: 'L0',
      effects: 'write',
      resolveTarget: (params: { tabId?: number }) =>
        currentBrowserTarget(gateway, getThreadId, params.tabId),
      execute: async (_id, params: { tabId?: number }, signal) => {
        const deadlineAt = deadlineForTool('go_forward', params);
        throwIfToolDone(signal, deadlineAt);
        const tabId = await gateway.getOperationTab(threadId(), params.tabId);
        await awaitBrowserOperation(chrome.tabs.goForward(tabId), signal, deadlineAt, true);
        await waitForTabLoad(tabId, 15_000, signal, deadlineAt);
        return withSnapshot('已前进', tabId, signal, deadlineAt);
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// L1 — perception & interaction via content script
// ---------------------------------------------------------------------------

export interface L1Deps {
  /** AXTree fallback for the perception degradation chain (docs/05 §1.4). */
  axTreeFallback?: (tabId: number, signal?: AbortSignal, deadlineAt?: number) => Promise<string>;
  getTabId?: (threadId: string) => Promise<number>;
  /** Trusted CDP key dispatch — synthetic events can't trigger native behavior. */
  dispatchKey?: (
    tabId: number,
    combo: string,
    signal?: AbortSignal,
    deadlineAt?: number,
  ) => Promise<void>;
  /** When present, oversized extract output is offloaded here instead of context. */
  db?: PanelotDB;
}

/**
 * Window the FULL extracted markdown for the model's context: return one
 * EXTRACT_WINDOW_CHARS slice starting at fromChar. When the full body exceeds
 * one window and a db is available, the COMPLETE text is offloaded to a
 * 'page_text' attachment (UI-side, never re-fed to the LLM — docs/02 §2.3), so
 * the attachment genuinely holds the whole page while the model pages through
 * it with fromChar.
 */
async function windowAndOffload(
  db: PanelotDB | undefined,
  threadId: string,
  full: string,
  fromChar: number,
  meta: { url: string; title: string },
): Promise<{ text: string; attachmentId?: string }> {
  const from = Math.max(0, fromChar);
  const window = full.slice(from, from + EXTRACT_WINDOW_CHARS);
  const hasMore = from + EXTRACT_WINDOW_CHARS < full.length;

  // Fits in one window (and we're at the start) → return as-is, no offload.
  if (from === 0 && !hasMore) return { text: full };

  let attachmentId: string | undefined;
  // Offload the complete body once, on the first window, when it spills over.
  if (db && from === 0 && hasMore) {
    attachmentId = crypto.randomUUID();
    await db.attachments.add({
      id: attachmentId,
      threadId,
      createdAt: Date.now(),
      kind: 'page_text',
      mime: 'text/markdown',
      bytes: new Blob([full], { type: 'text/markdown' }),
      trust: 'untrusted',
      provenance: 'page',
      sourceRef: meta.url,
      meta,
    });
  }

  const parts = [window];
  if (hasMore)
    parts.push(
      `\n\n[还有内容（共 ${full.length} 字符），用 fromChar=${from + EXTRACT_WINDOW_CHARS} 续读${attachmentId ? `；完整正文已存为附件 ${attachmentId}` : ''}。]`,
    );
  else if (from > 0) parts.push(`\n\n[已到正文结尾。]`);
  return { text: parts.join(''), attachmentId };
}

export function createL1Tools(
  gateway: BrowserToolGateway,
  getThreadId: () => string,
  deps: L1Deps = {},
): AnyAgentTool[] {
  const tabIdParameter = {
    tabId: schema.optional(
      schema.number({
        integer: true,
        min: 0,
        description:
          'Target tab id from tabs_list; omitted = the web tab captured when the user submitted',
      }),
    ),
  };
  const splitTabParams = (params: unknown): { tabId?: number; contentParams: unknown } => {
    const { tabId, ...contentParams } = params as Record<string, unknown> & { tabId?: number };
    return { tabId, contentParams };
  };
  const resolveTarget = (params: { tabId?: number }) =>
    currentBrowserTarget(gateway, getThreadId, params.tabId);
  const call = async (tool: string, params: unknown, signal?: AbortSignal) => {
    const threadId = getThreadId();
    const { tabId: requestedTabId, contentParams } = splitTabParams(params);
    const tabId = await gateway.getOperationTab(threadId, requestedTabId);
    const deadlineAt = deadlineForTool(tool, contentParams);
    try {
      const result = ['click', 'type', 'select_option'].includes(tool)
        ? await new ActionRunner({
            execute: (name, actionParams, actionSignal, actionDeadlineAt) =>
              gateway.callContentTool(
                threadId,
                name,
                actionParams,
                tabId,
                actionSignal,
                actionDeadlineAt,
              ),
          }).run(tool, contentParams, signal, deadlineAt)
        : await gateway.callContentTool(threadId, tool, contentParams, tabId, signal, deadlineAt);
      return tabbedContentResult(result, tabId);
    } catch (e) {
      // Perception degradation: L1 empty tree → CDP AXTree (docs/05 §1.4).
      if (
        tool === 'read_page' &&
        /EMPTY_TREE/.test((e as Error).message) &&
        deps.axTreeFallback &&
        deps.getTabId
      ) {
        const axText = await deps.axTreeFallback(tabId, signal, deadlineAt);
        return contentResult({ resultText: `[tabId=${tabId}] ${axText}` });
      }
      throw e;
    }
  };

  const tools: AnyAgentTool[] = [
    {
      name: 'read_page',
      label: '读取页面',
      description:
        "Returns a snapshot of the page: each interactive element appears as `role \"name\" [ref=<snapshot-ref>]`. Copy the opaque ref exactly; call this before your first interaction with a page and whenever refs go stale. mode:'article' extracts readable text for content reading; 'snapshot' (default) is for interaction.",
      parameters: schema.object({
        ...tabIdParameter,
        mode: schema.optional(schema.enum(['snapshot', 'article'])),
        maxTokens: schema.optional(schema.number({ max: 6000 })),
      }),
      level: 'L1',
      effects: 'read',
      execute: (_id, params, signal) => call('read_page', params, signal),
    },
    {
      name: 'find_in_page',
      label: '页内查找',
      description:
        'Find elements/text in the current snapshot by query. Cheaper than a full read_page for targeted lookups. Returns matching snapshot lines with refs.',
      parameters: schema.object({ ...tabIdParameter, query: schema.string({ min: 1 }) }),
      level: 'L1',
      effects: 'read',
      execute: (_id, params, signal) => call('find_in_page', params, signal),
    },
    {
      name: 'extract',
      label: '提取正文',
      description:
        "Extract the page (or a ref'd subtree via scope) as clean Markdown with links preserved — cheaper and more readable than a full read_page snapshot for reading content or collecting URLs. Long pages truncate; pass fromChar to continue from where it stopped. Oversized results are saved to an attachment and summarized.",
      parameters: schema.object({
        ...tabIdParameter,
        scope: schema.optional(
          schema.string({
            description:
              'Ref of a container from the latest snapshot to limit extraction to that subtree',
          }),
        ),
        fromChar: schema.optional(
          schema.number({
            description:
              'Character offset to continue a long extraction from (see the previous result)',
          }),
        ),
      }),
      level: 'L1',
      effects: 'read',
      execute: async (
        _id,
        params: { tabId?: number; scope?: string; fromChar?: number },
        signal,
      ) => {
        const threadId = getThreadId();
        // Content script returns the FULL markdown; windowing + offload happen
        // here (engine side has db access; the content script does not).
        const tabId = await gateway.getOperationTab(threadId, params.tabId);
        const deadlineAt = deadlineForTool('extract', params);
        const result = await gateway.callContentTool(
          threadId,
          'extract',
          { scope: params.scope },
          tabId,
          signal,
          deadlineAt,
        );
        const origin = await gateway.getTabOrigin(threadId, tabId);
        const { text, attachmentId } = await windowAndOffload(
          deps.db,
          threadId,
          result.resultText,
          params.fromChar ?? 0,
          { url: origin, title: '' },
        );
        return {
          content: [{ type: 'text' as const, text: `[tabId=${tabId}] ${text}` }],
          ...(attachmentId ? { details: { extractionAttachmentId: attachmentId } } : {}),
        };
      },
    },
    {
      name: 'get_selection',
      label: '获取选中文本',
      description: "Get the user's current text selection on the page.",
      parameters: schema.object({ ...tabIdParameter }),
      level: 'L1',
      effects: 'read',
      execute: (_id, params, signal) => call('get_selection', params, signal),
    },
    {
      name: 'click',
      label: '点击元素',
      description:
        'Click an element. element: human-readable description shown to the user for approval; ref: from the LATEST snapshot. Fails if the ref is stale — re-run read_page and retry with a fresh ref. If the click navigates, the result says so — do NOT retry a click that navigated.',
      parameters: schema.object({
        ...tabIdParameter,
        ...elementRef,
        button: schema.optional(schema.enum(['left', 'right'])),
        doubleClick: schema.optional(schema.boolean()),
      }),
      level: 'L1',
      effects: 'write',
      execute: (_id, params, signal) => call('click', params, signal),
    },
    {
      name: 'type',
      label: '输入文本',
      description:
        'Set a field value and dispatch input events. Use submit:true to press Enter after (may navigate — the result says so). mode:"append" keeps existing text. If the field ignores the input, retry with slowly:true.',
      parameters: schema.object({
        ...tabIdParameter,
        ...elementRef,
        text: schema.string(),
        mode: schema.optional(schema.enum(['replace', 'append'])),
        submit: schema.optional(schema.boolean()),
        slowly: schema.optional(schema.boolean()),
      }),
      level: 'L1',
      effects: 'write',
      execute: (_id, params, signal) => call('type', params, signal),
    },
    {
      name: 'select_option',
      label: '选择下拉项',
      description:
        'Select option(s) in a <select> by value or visible text. On mismatch the error lists available options.',
      parameters: schema.object({
        ...tabIdParameter,
        ...elementRef,
        values: schema.array(schema.string(), { min: 1 }),
      }),
      level: 'L1',
      effects: 'write',
      execute: (_id, params, signal) => call('select_option', params, signal),
    },
    {
      name: 'press_key',
      label: '按键',
      description:
        "Press a key or combo with TRUSTED input (triggers native behavior: Enter submits, Tab moves focus, Escape dismisses). e.g. 'Enter', 'Escape', 'Control+a', 'Shift+Tab'. Optional ref focuses that element first. May trigger navigation — the result will say so.",
      parameters: schema.object({
        ...tabIdParameter,
        key: schema.string({ min: 1 }),
        ref: schema.optional(
          schema.string({
            description: 'Element to focus before pressing (from the latest snapshot)',
          }),
        ),
      }),
      level: 'L2',
      effects: 'write',
      execute: async (_id, params: { tabId?: number; key: string; ref?: string }, signal) => {
        const threadId = getThreadId();
        const tabId = await gateway.getOperationTab(threadId, params.tabId);
        const deadlineAt = deadlineForTool('press_key', params);
        // Focus the target element first when a ref is given.
        if (params.ref)
          await gateway.callContentTool(
            threadId,
            'focus',
            { ref: params.ref },
            tabId,
            signal,
            deadlineAt,
          );
        if (deps.dispatchKey && deps.getTabId) {
          const urlBefore = (await chrome.tabs.get(tabId)).url;
          const captured = await gateway.runWithNewTabCapture(
            threadId,
            tabId,
            async () => {
              await deps.dispatchKey!(tabId, params.key, signal, deadlineAt);
              // Key presses (Enter on forms) routinely navigate — report it.
              await waitWithContext(300, { signal, deadlineAt });
              return chrome.tabs.get(tabId);
            },
            signal,
            deadlineAt,
          );
          if (captured.createdTabResult) {
            return tabbedContentResult(captured.createdTabResult, tabId);
          }
          const after = captured.value;
          if (after.url !== urlBefore || after.status === 'loading') {
            await waitForTabLoad(tabId, 15_000, signal, deadlineAt);
            const navigated = await chrome.tabs.get(tabId);
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `[tabId=${tabId}] 已按键 ${params.key}，页面跳转到 ${navigated.url}。旧 ref 已失效，需要交互时先 read_page。`,
                },
              ],
            };
          }
          return {
            content: [
              { type: 'text' as const, text: `[tabId=${tabId}] 已按键 ${params.key}（原生输入）` },
            ],
          };
        }
        // No CDP available (test env): synthetic fallback — say so honestly.
        const result = await gateway.callContentTool(
          threadId,
          'press_key',
          { key: params.key },
          tabId,
          signal,
          deadlineAt,
        );
        const r = contentResult(result);
        r.content[0]!.text = `[tabId=${tabId}] ${r.content[0]!.text}\n[合成事件：可能未触发原生行为（表单提交/焦点移动）。]`;
        return r;
      },
    },
    {
      name: 'scroll',
      label: '滚动',
      description:
        "Scroll the page or a container (target ref). amount: 'page' (default), 'end', or pixels. New content may appear after scrolling — re-read if needed.",
      parameters: schema.object({
        ...tabIdParameter,
        target: schema.optional(schema.string()),
        direction: schema.enum(['up', 'down']),
        amount: schema.optional(schema.union([schema.enum(['page', 'end']), schema.number()])),
      }),
      level: 'L1',
      effects: 'read',
      execute: (_id, params, signal) => call('scroll', params, signal),
    },
    {
      name: 'hover',
      label: '悬停',
      description:
        'Hover over an element to reveal menus/tooltips. Follow with read_page to see what appeared.',
      parameters: schema.object({ ...tabIdParameter, ...elementRef }),
      level: 'L1',
      effects: 'write',
      execute: (_id, params, signal) => call('hover', params, signal),
    },
    {
      name: 'wait_for',
      label: '等待',
      description:
        'Wait for text to appear (text), disappear (textGone), or a fixed time (timeMs). Text conditions time out at 30s. Prefer text conditions over raw time after async actions.',
      parameters: schema.object({
        ...tabIdParameter,
        text: schema.optional(schema.string()),
        textGone: schema.optional(schema.union([schema.boolean(), schema.string()])),
        timeMs: schema.optional(schema.number({ max: 30_000 })),
      }),
      level: 'L1',
      effects: 'read',
      execute: (_id, params, signal) => call('wait_for', params, signal),
    },
    {
      name: 'run_javascript',
      label: '执行 JavaScript',
      description:
        "Run JavaScript in the page's MAIN world (full access to the page's own variables/functions) and return the JSON-serialized result. Powerful and risky — DENIED by default; the user must enable it in settings. Prefer the structured tools (click/type/extract) whenever possible.",
      parameters: schema.object({ ...tabIdParameter, code: schema.string() }),
      level: 'L1',
      effects: 'write',
      execute: async (_id, params: { tabId?: number; code: string }, signal) => {
        const tabId = await gateway.getOperationTab(getThreadId(), params.tabId);
        const deadlineAt = deadlineForTool('run_javascript', params);
        throwIfToolDone(signal, deadlineAt);
        gateway.markDriven(getThreadId(), tabId);
        const timeoutMs = Math.max(1, deadlineAt - Date.now());
        const [frame] = await awaitBrowserOperation(
          chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN', // the real page context — isolated world can't see page JS
            func: async (code: string, executionTimeoutMs: number) => {
              try {
                const deadlineMarker = { timeout: true };
                // eslint-disable-next-line no-new-func
                const execution = new Function(`return (async () => { ${code} })()`)();
                const value = await Promise.race([
                  execution,
                  new Promise((resolve) =>
                    setTimeout(() => resolve(deadlineMarker), executionTimeoutMs),
                  ),
                ]);
                if (value === deadlineMarker) {
                  return {
                    ok: false,
                    error:
                      'PanelotDeadlineError: script exceeded the total deadline; page effects may continue',
                  };
                }
                if (value === undefined) return { ok: true, value: 'undefined' };
                try {
                  return { ok: true, value: JSON.stringify(value) };
                } catch {
                  return {
                    ok: true,
                    value: `[不可序列化: ${Object.prototype.toString.call(value)}]`,
                  };
                }
              } catch (e) {
                return {
                  ok: false,
                  error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
                };
              }
            },
            args: [params.code, timeoutMs],
          }),
          signal,
          deadlineAt,
          true,
        );
        const r = frame?.result as { ok: boolean; value?: string; error?: string } | undefined;
        if (!r) throw new Error('脚本执行无结果（页面可能不允许注入）');
        if (!r.ok) {
          if (/PanelotDeadlineError/.test(r.error ?? '')) {
            throw actionError(
              'timeout',
              '脚本超过总截止时间；已派发的页面代码仍可能继续运行。',
              'execute',
              false,
              {
                effectMayHaveOccurred: true,
              },
            );
          }
          // CSP-hardened sites (GitHub, X, banks) block new Function/eval as
          // 'unsafe-eval'. Tell the model plainly instead of a raw EvalError so
          // it switches to structured tools rather than retrying.
          if (/EvalError|unsafe-eval|Content Security Policy|CSP/i.test(r.error ?? '')) {
            throw new Error(
              '该页面的内容安全策略(CSP)禁止动态执行脚本，run_javascript 在此页不可用。请改用结构化工具（read_page/click/type 等）。',
            );
          }
          throw new Error(`页面脚本抛出异常: ${r.error}`);
        }
        return {
          content: [{ type: 'text' as const, text: `[tabId=${tabId}] 执行结果: ${r.value}` }],
        };
      },
    },
    {
      name: 'batch_actions',
      label: '批量操作',
      description:
        'Up to 4 click/type/select_option actions executed in order; stops early if the page changes significantly. Prefer this for multi-field forms — one approval, one round-trip.',
      parameters: schema.object({
        ...tabIdParameter,
        actions: schema.array(
          schema.object({
            kind: schema.enum(['click', 'type', 'select_option']),
            params: schema.record(schema.string(), schema.unknown()),
          }),
          { min: 1, max: 4 },
        ),
      }),
      level: 'L1',
      effects: 'write',
      execute: (_id, params, signal) => call('batch_actions', params, signal),
    },
  ];
  return tools.map((tool) => ({ ...tool, resolveTarget: tool.resolveTarget ?? resolveTarget }));
}
