/**
 * L0 + L1 browser tool definitions (docs/05 §3). zod schemas are the single
 * source of truth; descriptions follow docs/10 §3 — one sentence of function,
 * when to use, what to do on failure.
 */

import { z } from 'zod';
import type { AnyAgentTool } from '../agent/tool';
import { waitForTabLoad, type BrowserToolGateway } from './gateway';
import type { ExecuteResult } from './content/executor';
import type { PanelotDB } from '../db/schema';

/**
 * How much extracted markdown to feed the model per call. Beyond this the full
 * body is offloaded to an attachment and the model gets this much as a window,
 * with fromChar to page further. Borrowed from chrome-agent-skill's save_path /
 * browser-use's file_system: big page text must not flood context.
 */
const EXTRACT_WINDOW_CHARS = 8_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function contentResult(result: ExecuteResult) {
  const parts: string[] = [result.resultText];
  if (result.snapshot) parts.push(`\n--- 增量快照 ---\n${result.snapshot}`);
  return { content: [{ type: 'text' as const, text: parts.join('\n') }] };
}

function urlOrigin(value: string): string {
  const parsed = new URL(value);
  return parsed.origin === 'null' ? value : parsed.origin;
}

async function tabTarget(tabId: number): Promise<{ tabId: number; origin?: string }> {
  const tab = await chrome.tabs.get(tabId);
  return { tabId, ...(tab.url ? { origin: urlOrigin(tab.url) } : {}) };
}

export async function currentBrowserTarget(
  gateway: BrowserToolGateway,
  getThreadId: () => string,
): Promise<{ tabId: number; origin?: string }> {
  return tabTarget(await gateway.getTargetTab(getThreadId()));
}

/** element + ref dual params (docs/05 §3): element for approval display & model self-check. */
const elementRef = {
  element: z
    .string()
    .describe('Human-readable description of the element, shown to the user in approvals'),
  ref: z
    .string()
    .describe(
      'Exact ref from the LATEST snapshot, e.g. "s3_12". Fails if stale — re-run read_page.',
    ),
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
  ): Promise<{ content: { type: 'text'; text: string }[] }> => {
    try {
      const snap = await gateway.callContentTool(threadId(), 'read_page', { maxTokens: 1500 });
      return { content: [{ type: 'text', text: `${text}\n\n${snap.resultText}` }] };
    } catch {
      return {
        content: [{ type: 'text', text: `${text}\n（页面快照暂不可用，需要交互时先 read_page）` }],
      };
    }
  };
  return [
    {
      name: 'tabs_list',
      label: '列出标签页',
      description:
        'List open tabs in the current window (all:true = every window). Marks the tab the user is looking at and your current operation target.',
      parameters: z.object({ all: z.boolean().optional() }),
      level: 'L0',
      effects: 'read',
      execute: async (_id, params: { all?: boolean }) => {
        const targetId = gateway.currentTarget(threadId());
        // The tab the USER is looking at (active in the focused window) — the
        // model must be able to tell it apart from the agent's working tab.
        const userTab = await gateway.getUserActiveTab();
        const tabs = await chrome.tabs.query(params.all ? {} : { currentWindow: true });
        const rows = tabs.map((t) => {
          const marks = [
            t.id === userTab?.id ? '用户正在看' : t.active ? '窗口活跃' : '',
            t.id === targetId ? '当前操作目标' : '',
          ]
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
        'Navigate to a URL. Reuses an existing tab if the URL is already open; otherwise opens a new one. Returns the tab id.',
      parameters: z.object({ url: z.string().url() }),
      level: 'L0',
      effects: 'write',
      resolveTarget: async (params: { url: string }) => ({ origin: urlOrigin(params.url) }),
      execute: async (_id, params: { url: string }) => {
        // Reuse an existing tab for the same origin+path to avoid duplicates
        // (page-agent / browser-use pattern: prefer activate over create).
        const allTabs = await chrome.tabs.query({});
        const existing = allTabs.find((t) => {
          if (!t.url || !t.id) return false;
          try {
            const existing = new URL(t.url);
            const target = new URL(params.url);
            return existing.origin === target.origin && existing.pathname === target.pathname;
          } catch {
            return false;
          }
        });
        if (existing?.id !== undefined) {
          gateway.pinTarget(threadId(), existing.id);
          await waitForTabLoad(existing.id);
          return {
            content: [
              {
                type: 'text',
                text: `已复用已打开的标签页 [${existing.id}] ${params.url} 作为操作目标（后台操作，用户看到的页面没有变化）。`,
              },
            ],
          };
        }
        const tab = await chrome.tabs.create({ url: params.url, active: false });
        if (tab.id !== undefined) gateway.pinTarget(threadId(), tab.id);
        await waitForTabLoad(tab.id!);
        return {
          content: [
            {
              type: 'text',
              text: `已在后台打开标签页 [${tab.id}] ${params.url}（用户看到的页面没有变化）。`,
            },
          ],
        };
      },
    },
    {
      name: 'tab_activate',
      label: '切换操作目标',
      description:
        "Retarget this task's page tools to an already-open tab (ids from tabs_list). By default this is a BACKGROUND retarget — the tab the user sees does not change. Pass focus:true only when the user asked to bring that tab to the foreground.",
      parameters: z.object({
        tabId: z.number(),
        focus: z
          .boolean()
          .optional()
          .describe('true = also bring the tab to the foreground (changes what the user sees)'),
      }),
      level: 'L0',
      effects: 'write',
      resolveTarget: async (params: { tabId: number }) => tabTarget(params.tabId),
      execute: async (_id, params: { tabId: number; focus?: boolean }) => {
        const tab = await chrome.tabs.get(params.tabId);
        gateway.pinTarget(threadId(), params.tabId);
        if (params.focus) {
          await chrome.tabs.update(params.tabId, { active: true });
          if (tab.windowId !== undefined) {
            await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {
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
        }
        return {
          content: [
            {
              type: 'text',
              text: `本任务的操作目标已指向 [${params.tabId}]（${tab.title}）。仅后台指向变化，用户看到的页面没有变化。`,
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
      parameters: z.object({ tabId: z.number() }),
      level: 'L0',
      effects: 'write',
      resolveTarget: async (params: { tabId: number }) => tabTarget(params.tabId),
      execute: async (_id, params: { tabId: number }) => {
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
        await chrome.tabs.remove(params.tabId);
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
        'Navigate the current target tab to a URL. Returns a fresh snapshot of the new page — old refs are void.',
      parameters: z.object({ url: z.string().url() }),
      level: 'L0',
      effects: 'write',
      resolveTarget: async (params: { url: string }) => ({
        ...(await currentBrowserTarget(gateway, getThreadId)),
        origin: urlOrigin(params.url),
      }),
      execute: async (_id, params: { url: string }) => {
        const tabId = await gateway.getTargetTab(threadId());
        await chrome.tabs.update(tabId, { url: params.url });
        await waitForTabLoad(tabId);
        return withSnapshot(`已导航到 ${params.url}`);
      },
    },
    {
      name: 'go_back',
      label: '后退',
      description: 'Go back in the target tab history. Returns a fresh snapshot.',
      parameters: z.object({}),
      level: 'L0',
      effects: 'write',
      resolveTarget: () => currentBrowserTarget(gateway, getThreadId),
      execute: async () => {
        const tabId = await gateway.getTargetTab(threadId());
        await chrome.tabs.goBack(tabId);
        await waitForTabLoad(tabId);
        return withSnapshot('已后退');
      },
    },
    {
      name: 'go_forward',
      label: '前进',
      description: 'Go forward in the target tab history. Returns a fresh snapshot.',
      parameters: z.object({}),
      level: 'L0',
      effects: 'write',
      resolveTarget: () => currentBrowserTarget(gateway, getThreadId),
      execute: async () => {
        const tabId = await gateway.getTargetTab(threadId());
        await chrome.tabs.goForward(tabId);
        await waitForTabLoad(tabId);
        return withSnapshot('已前进');
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// L1 — perception & interaction via content script
// ---------------------------------------------------------------------------

export interface L1Deps {
  /** AXTree fallback for the perception degradation chain (docs/05 §1.4). */
  axTreeFallback?: (tabId: number) => Promise<string>;
  getTabId?: (threadId: string) => Promise<number>;
  /** Trusted CDP key dispatch — synthetic events can't trigger native behavior. */
  dispatchKey?: (tabId: number, combo: string) => Promise<void>;
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
  const resolveTarget = () => currentBrowserTarget(gateway, getThreadId);
  const call = async (tool: string, params: unknown) => {
    const threadId = getThreadId();
    try {
      const result = await gateway.callContentTool(threadId, tool, params);
      return contentResult(result);
    } catch (e) {
      // Perception degradation: L1 empty tree → CDP AXTree (docs/05 §1.4).
      if (
        tool === 'read_page' &&
        /EMPTY_TREE/.test((e as Error).message) &&
        deps.axTreeFallback &&
        deps.getTabId
      ) {
        const tabId = await deps.getTabId(threadId);
        const axText = await deps.axTreeFallback(tabId);
        return contentResult({ resultText: axText });
      }
      throw e;
    }
  };

  const tools: AnyAgentTool[] = [
    {
      name: 'read_page',
      label: '读取页面',
      description:
        "Returns a snapshot of the page: each interactive element appears as `role \"name\" [ref=sN_M]`. Call this before your first interaction with a page and whenever refs go stale. mode:'article' extracts readable text for content reading; 'snapshot' (default) is for interaction.",
      parameters: z.object({
        mode: z.enum(['snapshot', 'article']).optional(),
        maxTokens: z.number().max(6000).optional(),
      }),
      level: 'L1',
      effects: 'read',
      execute: (_id, params) => call('read_page', params),
    },
    {
      name: 'find_in_page',
      label: '页内查找',
      description:
        'Find elements/text in the current snapshot by query. Cheaper than a full read_page for targeted lookups. Returns matching snapshot lines with refs.',
      parameters: z.object({ query: z.string().min(1) }),
      level: 'L1',
      effects: 'read',
      execute: (_id, params) => call('find_in_page', params),
    },
    {
      name: 'extract',
      label: '提取正文',
      description:
        "Extract the page (or a ref'd subtree via scope) as clean Markdown with links preserved — cheaper and more readable than a full read_page snapshot for reading content or collecting URLs. Long pages truncate; pass fromChar to continue from where it stopped. Oversized results are saved to an attachment and summarized.",
      parameters: z.object({
        scope: z
          .string()
          .optional()
          .describe(
            'Ref of a container from the latest snapshot to limit extraction to that subtree',
          ),
        fromChar: z
          .number()
          .optional()
          .describe(
            'Character offset to continue a long extraction from (see the previous result)',
          ),
      }),
      level: 'L1',
      effects: 'read',
      execute: async (_id, params: { scope?: string; fromChar?: number }) => {
        const threadId = getThreadId();
        // Content script returns the FULL markdown; windowing + offload happen
        // here (engine side has db access; the content script does not).
        const result = await gateway.callContentTool(threadId, 'extract', { scope: params.scope });
        const origin = await gateway.getTabOrigin(threadId);
        const { text, attachmentId } = await windowAndOffload(
          deps.db,
          threadId,
          result.resultText,
          params.fromChar ?? 0,
          { url: origin, title: '' },
        );
        return {
          content: [{ type: 'text' as const, text }],
          ...(attachmentId ? { details: { extractionAttachmentId: attachmentId } } : {}),
        };
      },
    },
    {
      name: 'get_selection',
      label: '获取选中文本',
      description: "Get the user's current text selection on the page.",
      parameters: z.object({}),
      level: 'L1',
      effects: 'read',
      execute: (_id, params) => call('get_selection', params),
    },
    {
      name: 'click',
      label: '点击元素',
      description:
        'Click an element. element: human-readable description shown to the user for approval; ref: from the LATEST snapshot. Fails if the ref is stale — re-run read_page and retry with a fresh ref. If the click navigates, the result says so — do NOT retry a click that navigated.',
      parameters: z.object({
        ...elementRef,
        button: z.enum(['left', 'right']).optional(),
        doubleClick: z.boolean().optional(),
      }),
      level: 'L1',
      effects: 'write',
      execute: (_id, params) => call('click', params),
    },
    {
      name: 'type',
      label: '输入文本',
      description:
        'Set a field value and dispatch input events. Use submit:true to press Enter after (may navigate — the result says so). mode:"append" keeps existing text. If the field ignores the input, retry with slowly:true.',
      parameters: z.object({
        ...elementRef,
        text: z.string(),
        mode: z.enum(['replace', 'append']).optional(),
        submit: z.boolean().optional(),
        slowly: z.boolean().optional(),
      }),
      level: 'L1',
      effects: 'write',
      execute: (_id, params) => call('type', params),
    },
    {
      name: 'select_option',
      label: '选择下拉项',
      description:
        'Select option(s) in a <select> by value or visible text. On mismatch the error lists available options.',
      parameters: z.object({ ...elementRef, values: z.array(z.string()).min(1) }),
      level: 'L1',
      effects: 'write',
      execute: (_id, params) => call('select_option', params),
    },
    {
      name: 'press_key',
      label: '按键',
      description:
        "Press a key or combo with TRUSTED input (triggers native behavior: Enter submits, Tab moves focus, Escape dismisses). e.g. 'Enter', 'Escape', 'Control+a', 'Shift+Tab'. Optional ref focuses that element first. May trigger navigation — the result will say so.",
      parameters: z.object({
        key: z.string().min(1),
        ref: z
          .string()
          .optional()
          .describe('Element to focus before pressing (from the latest snapshot)'),
      }),
      level: 'L2',
      effects: 'write',
      execute: async (_id, params: { key: string; ref?: string }) => {
        const threadId = getThreadId();
        // Focus the target element first when a ref is given.
        if (params.ref) await gateway.callContentTool(threadId, 'focus', { ref: params.ref });
        if (deps.dispatchKey && deps.getTabId) {
          const tabId = await deps.getTabId(threadId);
          const urlBefore = (await chrome.tabs.get(tabId)).url;
          await deps.dispatchKey(tabId, params.key);
          // Key presses (Enter on forms) routinely navigate — report it.
          await new Promise((r) => setTimeout(r, 300));
          const after = await chrome.tabs.get(tabId);
          if (after.url !== urlBefore || after.status === 'loading') {
            await waitForTabLoad(tabId);
            const navigated = await chrome.tabs.get(tabId);
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `已按键 ${params.key}，页面跳转到 ${navigated.url}。旧 ref 已失效，需要交互时先 read_page。`,
                },
              ],
            };
          }
          return { content: [{ type: 'text' as const, text: `已按键 ${params.key}（原生输入）` }] };
        }
        // No CDP available (test env): synthetic fallback — say so honestly.
        const result = await gateway.callContentTool(threadId, 'press_key', { key: params.key });
        const r = contentResult(result);
        r.content[0]!.text += '\n[合成事件：可能未触发原生行为（表单提交/焦点移动）。]';
        return r;
      },
    },
    {
      name: 'scroll',
      label: '滚动',
      description:
        "Scroll the page or a container (target ref). amount: 'page' (default), 'end', or pixels. New content may appear after scrolling — re-read if needed.",
      parameters: z.object({
        target: z.string().optional(),
        direction: z.enum(['up', 'down']),
        amount: z.union([z.enum(['page', 'end']), z.number()]).optional(),
      }),
      level: 'L1',
      effects: 'read',
      execute: (_id, params) => call('scroll', params),
    },
    {
      name: 'hover',
      label: '悬停',
      description:
        'Hover over an element to reveal menus/tooltips. Follow with read_page to see what appeared.',
      parameters: z.object({ ...elementRef }),
      level: 'L1',
      effects: 'write',
      execute: (_id, params) => call('hover', params),
    },
    {
      name: 'wait_for',
      label: '等待',
      description:
        'Wait for text to appear (text), disappear (textGone), or a fixed time (timeMs). Text conditions time out at 30s. Prefer text conditions over raw time after async actions.',
      parameters: z.object({
        text: z.string().optional(),
        textGone: z.union([z.boolean(), z.string()]).optional(),
        timeMs: z.number().max(30_000).optional(),
      }),
      level: 'L1',
      effects: 'read',
      execute: (_id, params) => call('wait_for', params),
    },
    {
      name: 'run_javascript',
      label: '执行 JavaScript',
      description:
        "Run JavaScript in the page's MAIN world (full access to the page's own variables/functions) and return the JSON-serialized result. Powerful and risky — DENIED by default; the user must enable it in settings. Prefer the structured tools (click/type/extract) whenever possible.",
      parameters: z.object({ code: z.string() }),
      level: 'L1',
      effects: 'write',
      execute: async (_id, params: { code: string }) => {
        const tabId = await gateway.getTargetTab(getThreadId());
        const [frame] = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN', // the real page context — isolated world can't see page JS
          func: async (code: string) => {
            try {
              // eslint-disable-next-line no-new-func
              const value = await new Function(`return (async () => { ${code} })()`)();
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
          args: [params.code],
        });
        const r = frame?.result as { ok: boolean; value?: string; error?: string } | undefined;
        if (!r) throw new Error('脚本执行无结果（页面可能不允许注入）');
        if (!r.ok) {
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
        return { content: [{ type: 'text' as const, text: `执行结果: ${r.value}` }] };
      },
    },
    {
      name: 'batch_actions',
      label: '批量操作',
      description:
        'Up to 4 click/type/select_option actions executed in order; stops early if the page changes significantly. Prefer this for multi-field forms — one approval, one round-trip.',
      parameters: z.object({
        actions: z
          .array(
            z.object({
              kind: z.enum(['click', 'type', 'select_option']),
              params: z.record(z.string(), z.unknown()),
            }),
          )
          .min(1)
          .max(4),
      }),
      level: 'L1',
      effects: 'write',
      execute: (_id, params) => call('batch_actions', params),
    },
  ];
  return tools.map((tool) => ({ ...tool, resolveTarget: tool.resolveTarget ?? resolveTarget }));
}
