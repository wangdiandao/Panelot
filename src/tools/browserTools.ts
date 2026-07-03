/**
 * L0 + L1 browser tool definitions (docs/05 §3). zod schemas are the single
 * source of truth; descriptions follow docs/10 §3 — one sentence of function,
 * when to use, what to do on failure.
 */

import { z } from 'zod';
import type { AnyAgentTool } from '../agent/tool';
import type { BrowserToolGateway } from './gateway';
import type { ExecuteResult } from './content/executor';
import { fenceUntrusted } from '../prompts/assemble';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function contentResult(threadOrigin: string, tool: string, result: ExecuteResult) {
  const parts: string[] = [result.resultText];
  if (result.snapshot) parts.push(`\n--- 增量快照 ---\n${result.snapshot}`);
  const text = parts.join('\n');
  // Page-derived content is untrusted — fence it (docs/10 §4).
  const fenced = tool === 'read_page' || tool === 'find_in_page' || tool === 'get_selection'
    ? fenceUntrusted(text, threadOrigin, tool)
    : text;
  return { content: [{ type: 'text' as const, text: fenced }] };
}

/** element + ref dual params (docs/05 §3): element for approval display & model self-check. */
const elementRef = {
  element: z.string().describe('Human-readable description of the element, shown to the user in approvals'),
  ref: z.string().describe('Exact ref from the LATEST snapshot, e.g. "s3_12". Fails if stale — re-run read_page.'),
};

// ---------------------------------------------------------------------------
// L0 — tab management (no injection)
// ---------------------------------------------------------------------------

export function createL0Tools(gateway: BrowserToolGateway, getThreadId: () => string): AnyAgentTool[] {
  const threadId = getThreadId;
  return [
    {
      name: 'tabs_list',
      label: '列出标签页',
      description: 'List the tabs this task controls plus the active tab. Pass all:true only when you need every open tab.',
      parameters: z.object({ all: z.boolean().optional() }),
      level: 'L0',
      effects: 'read',
      execute: async (_id, params: { all?: boolean }) => {
        const controlled = new Set(gateway.controls(threadId()));
        const tabs = await chrome.tabs.query(params.all ? {} : { currentWindow: true });
        const rows = tabs
          .filter((t) => params.all || controlled.has(t.id ?? -1) || t.active)
          .map((t) => `[${t.id}] ${t.active ? '● ' : ''}${controlled.has(t.id ?? -1) ? '(受控) ' : ''}${t.title} — ${t.url}`);
        return { content: [{ type: 'text', text: rows.join('\n') || '（无标签页）' }] };
      },
    },
    {
      name: 'tab_open',
      label: '打开标签页',
      description: 'Open a URL in a new tab and make it the controlled target.',
      parameters: z.object({ url: z.string().url() }),
      level: 'L0',
      effects: 'write',
      execute: async (_id, params: { url: string }) => {
        const tab = await chrome.tabs.create({ url: params.url, active: false });
        if (tab.id !== undefined) gateway.attachTab(threadId(), tab.id);
        await waitForTabLoad(tab.id!);
        return { content: [{ type: 'text', text: `已打开标签页 [${tab.id}] ${params.url}` }] };
      },
    },
    {
      name: 'tab_activate',
      label: '切换标签页',
      description: 'Make an already-open tab the controlled target (use ids from tabs_list).',
      parameters: z.object({ tabId: z.number() }),
      level: 'L0',
      effects: 'write',
      execute: async (_id, params: { tabId: number }) => {
        const tab = await chrome.tabs.get(params.tabId);
        gateway.attachTab(threadId(), params.tabId);
        return { content: [{ type: 'text', text: `受控目标已切换到 [${params.tabId}] ${tab.title}` }] };
      },
    },
    {
      name: 'tab_close',
      label: '关闭标签页',
      description: 'Close a tab this task controls.',
      parameters: z.object({ tabId: z.number() }),
      level: 'L0',
      effects: 'write',
      execute: async (_id, params: { tabId: number }) => {
        gateway.detachTab(threadId(), params.tabId);
        await chrome.tabs.remove(params.tabId);
        return { content: [{ type: 'text', text: `已关闭标签页 [${params.tabId}]` }] };
      },
    },
    {
      name: 'navigate',
      label: '导航',
      description: 'Navigate the controlled tab to a URL. After navigation, call read_page for a fresh snapshot — old refs are void.',
      parameters: z.object({ url: z.string().url() }),
      level: 'L0',
      effects: 'write',
      execute: async (_id, params: { url: string }) => {
        const tabId = await gateway.getTargetTab(threadId());
        await chrome.tabs.update(tabId, { url: params.url });
        await waitForTabLoad(tabId);
        return { content: [{ type: 'text', text: `已导航到 ${params.url}` }] };
      },
    },
    {
      name: 'go_back',
      label: '后退',
      description: 'Go back in the controlled tab history.',
      parameters: z.object({}),
      level: 'L0',
      effects: 'write',
      execute: async () => {
        const tabId = await gateway.getTargetTab(threadId());
        await chrome.tabs.goBack(tabId);
        await waitForTabLoad(tabId);
        return { content: [{ type: 'text', text: '已后退' }] };
      },
    },
    {
      name: 'go_forward',
      label: '前进',
      description: 'Go forward in the controlled tab history.',
      parameters: z.object({}),
      level: 'L0',
      effects: 'write',
      execute: async () => {
        const tabId = await gateway.getTargetTab(threadId());
        await chrome.tabs.goForward(tabId);
        await waitForTabLoad(tabId);
        return { content: [{ type: 'text', text: '已前进' }] };
      },
    },
  ];
}

async function waitForTabLoad(tabId: number, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete') return;
    } catch {
      return; // tab gone
    }
    if (Date.now() - start > timeoutMs) return;
    await new Promise((r) => setTimeout(r, 200));
  }
}

// ---------------------------------------------------------------------------
// L1 — perception & interaction via content script
// ---------------------------------------------------------------------------

export function createL1Tools(gateway: BrowserToolGateway, getThreadId: () => string): AnyAgentTool[] {
  const call = async (tool: string, params: unknown) => {
    const threadId = getThreadId();
    const result = await gateway.callContentTool(threadId, tool, params);
    const origin = await gateway.getTabOrigin(threadId);
    return contentResult(origin, tool, result);
  };

  return [
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
      description: 'Find elements/text in the current snapshot by query. Cheaper than a full read_page for targeted lookups. Returns matching snapshot lines with refs.',
      parameters: z.object({ query: z.string().min(1) }),
      level: 'L1',
      effects: 'read',
      execute: (_id, params) => call('find_in_page', params),
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
        'Click an element. element: human-readable description shown to the user for approval; ref: from the LATEST snapshot. Fails if the ref is stale — re-run read_page and retry with a fresh ref.',
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
        'Set a field value and dispatch input events. Use submit:true to press Enter after. mode:"append" keeps existing text. If the field ignores the input, retry with slowly:true.',
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
      description: 'Select option(s) in a <select> by value or visible text. On mismatch the error lists available options.',
      parameters: z.object({ ...elementRef, values: z.array(z.string()).min(1) }),
      level: 'L1',
      effects: 'write',
      execute: (_id, params) => call('select_option', params),
    },
    {
      name: 'press_key',
      label: '按键',
      description: "Press a key or combo on the focused element, e.g. 'Enter', 'Escape', 'Control+a'.",
      parameters: z.object({ key: z.string().min(1) }),
      level: 'L1',
      effects: 'write',
      execute: (_id, params) => call('press_key', params),
    },
    {
      name: 'scroll',
      label: '滚动',
      description: "Scroll the page or a container (target ref). amount: 'page' (default), 'end', or pixels. New content may appear after scrolling — re-read if needed.",
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
      description: 'Hover over an element to reveal menus/tooltips. Follow with read_page to see what appeared.',
      parameters: z.object({ ...elementRef }),
      level: 'L1',
      effects: 'write',
      execute: (_id, params) => call('hover', params),
    },
    {
      name: 'wait_for',
      label: '等待',
      description: 'Wait for text to appear (text), disappear (textGone), or a fixed time (timeMs). Prefer text conditions over raw time after async actions.',
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
        'Run JavaScript in the page (MAIN world) and return its result. Powerful and risky — DENIED by default; the user must enable it in settings. Prefer the structured tools (click/type/extract) whenever possible.',
      parameters: z.object({ code: z.string(), world: z.literal('MAIN').optional() }),
      level: 'L1',
      effects: 'write',
      execute: (_id, params) => call('run_javascript', params),
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
}
