/**
 * Built-in tools executed inside the engine (docs/development/browser-tools.md §3).
 */

import { schema } from '../agent/schema';
import type { AnyAgentTool } from '../agent/tool';
import type { PanelotDB } from '../db/schema';
import { createArtifact } from './builtinCapabilityRuntime';

// ---------------------------------------------------------------------------

export function createFetchUrlTool(): AnyAgentTool {
  return {
    name: 'fetch_url',
    label: '抓取网页',
    description:
      'Fetch a URL in the background and return readable text without opening a tab. Use it for reference lookups. Use tab_open and read_page when you need to interact with the page.',
    parameters: schema.object({ url: schema.string({ url: true }) }),
    level: 'builtin',
    effects: 'read',
    recovery: 'retry-safe',
    resultTrust: 'untrusted',
    resultProvenance: 'page',
    resolveTarget: async (params: { url: string }) => ({ origin: new URL(params.url).origin }),
    execute: async (_id, params: { url: string }, signal) => {
      const res = await fetch(params.url, {
        signal,
        headers: { accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8' },
        redirect: 'follow',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${params.url}`);
      const contentType = res.headers.get('content-type') ?? '';
      // Stream with a hard byte cap — `await res.text()` on an unbounded
      // response can OOM the service worker.
      const MAX_BYTES = 512 * 1024;
      let raw = '';
      if (res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let received = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.byteLength;
          raw += decoder.decode(value, { stream: true });
          if (received >= MAX_BYTES) {
            await reader.cancel();
            raw += '\n[响应过大，已在 512KB 处截断]';
            break;
          }
        }
      } else {
        raw = await res.text();
      }

      let text: string;
      if (contentType.includes('html')) {
        text = htmlToText(raw);
      } else {
        text = raw;
      }
      const max = 16_000; // ≈4k tokens
      if (text.length > max) text = `${text.slice(0, max)}\n[内容已截断]`;
      return {
        content: [{ type: 'text', text }],
      };
    },
  };
}

/** Crude HTML → text without DOM (service worker has no DOMParser for text/html). */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------------

export function createMemoryTools(db: PanelotDB): AnyAgentTool[] {
  return [
    {
      name: 'memory_read',
      label: '读取记忆',
      description:
        'Read persistent memories by key, or list all keys when key is omitted. Memories persist across conversations.',
      parameters: schema.object({ key: schema.optional(schema.string()) }),
      level: 'builtin',
      effects: 'read',
      execute: async (_id, params: { key?: string }) => {
        if (params.key) {
          const record = await db.memories.where('key').equals(params.key).first();
          return {
            content: [{ type: 'text', text: record ? record.value : `（无记忆：${params.key}）` }],
          };
        }
        const all = await db.memories.toArray();
        const list = all.map((m) => `- ${m.key}`).join('\n');
        return { content: [{ type: 'text', text: list || '（暂无记忆）' }] };
      },
    },
    {
      name: 'memory_write',
      label: '写入记忆',
      description:
        'Save a persistent memory with a key and value. Use it for user preferences and durable facts, not transient task state.',
      parameters: schema.object({
        key: schema.string({ min: 1, max: 100 }),
        value: schema.string({ max: 4000 }),
      }),
      level: 'builtin',
      effects: 'write',
      execute: async (_id, params: { key: string; value: string }) => {
        const existing = await db.memories.where('key').equals(params.key).first();
        if (existing) {
          await db.memories.update(existing.id, { value: params.value, updatedAt: Date.now() });
        } else {
          await db.memories.add({
            id: crypto.randomUUID(),
            key: params.key,
            value: params.value,
            updatedAt: Date.now(),
          });
        }
        return { content: [{ type: 'text', text: `已保存记忆：${params.key}` }] };
      },
    },
  ];
}

// ---------------------------------------------------------------------------

export function createDownloadTool(): AnyAgentTool {
  return {
    name: 'download',
    label: '下载文件',
    description:
      "Download a URL to the user's downloads folder. filename is a suggestion within downloads.",
    parameters: schema.object({
      url: schema.string({ url: true }),
      filename: schema.optional(
        schema.string({
          pattern: /^[^/\\]+$/,
          patternMessage: 'filename must not contain path separators',
        }),
      ),
    }),
    level: 'builtin',
    effects: 'write',
    execute: async (_id, params: { url: string; filename?: string }) => {
      const downloadId = await chrome.downloads.download({
        url: params.url,
        filename: params.filename,
      });
      return { content: [{ type: 'text', text: `已开始下载（#${downloadId}）：${params.url}` }] };
    },
  };
}

export function createArtifactTool(db: PanelotDB, getThreadId: () => string): AnyAgentTool {
  return {
    name: 'artifact_create',
    label: '创建文件',
    description:
      'Create a UTF-8 text artifact, save it to the conversation, and download it for the user. Use it for requested Markdown, CSV, JSON, HTML, or plain-text deliverables. Do not use it for temporary reasoning.',
    parameters: schema.object({
      filename: schema.string({
        min: 1,
        max: 160,
        pattern: /^[^/\\]+$/,
        patternMessage: 'filename must not contain path separators',
      }),
      mime: schema.optional(schema.string({ max: 120 })),
      content: schema.string({ max: 200_000 }),
    }),
    level: 'builtin',
    effects: 'write',
    recovery: 'never-retry',
    resultTrust: 'trusted',
    resultProvenance: 'tool',
    execute: async (_id, params: { filename: string; mime?: string; content: string }) =>
      createArtifact(db, getThreadId(), params),
  };
}

const unavailableInteractionExecute: AnyAgentTool['execute'] = async () => {
  throw new Error('Interactive tools must be executed by the engine interaction runtime.');
};

export function createInteractionTools(
  resolveTabId: (requestedTabId?: number) => Promise<number>,
): AnyAgentTool[] {
  const option = schema.object({
    value: schema.string({ min: 1, max: 80 }),
    label: schema.string({ min: 1, max: 80 }),
    description: schema.optional(schema.string({ max: 240 })),
  });
  const question = schema.object({
    id: schema.string({ min: 1, max: 64 }),
    question: schema.string({ min: 1, max: 500 }),
    options: schema.optional(schema.array(option, { min: 2, max: 3 })),
  });
  return [
    {
      name: 'ask_user',
      label: '询问用户',
      description:
        'Pause the current turn and ask the user one to three concise questions. Use it only when an answer materially changes the next action. Call it alone, and do not use it for routine confirmation. Free-form answers are always available.',
      parameters: schema.object({ questions: schema.array(question, { min: 1, max: 3 }) }),
      level: 'builtin',
      effects: 'read',
      recovery: 'retry-safe',
      resultTrust: 'trusted',
      resultProvenance: 'user',
      interaction: 'ask_user',
      prepareInteraction: async (params) => ({ kind: 'ask_user', questions: params.questions }),
      execute: unavailableInteractionExecute,
    },
    {
      name: 'request_user_action',
      label: '请求用户接管',
      description:
        'Pause and ask the user to perform a browser step that Panelot must not or cannot perform, such as entering credentials, a one-time code, payment details, or completing a human verification. The result never includes secrets.',
      parameters: schema.object({
        instruction: schema.string({ min: 1, max: 1000 }),
        tabId: schema.optional(schema.number({ integer: true, min: 0 })),
      }),
      level: 'builtin',
      effects: 'read',
      recovery: 'retry-safe',
      resultTrust: 'trusted',
      resultProvenance: 'user',
      interaction: 'user_action',
      prepareInteraction: async (params) => ({
        kind: 'user_action',
        instruction: params.instruction,
        tabId: params.tabId === undefined ? undefined : await resolveTabId(params.tabId),
      }),
      execute: unavailableInteractionExecute,
    },
    {
      name: 'watch_page',
      label: '持续等待页面',
      description:
        'Suspend the turn until a page condition becomes true, for waits longer than wait_for or when the service worker may restart. Conditions are checked without asking the model to poll.',
      parameters: schema.object({
        tabId: schema.optional(schema.number({ integer: true, min: 0 })),
        condition: schema.enum(['text', 'text_gone', 'url']),
        value: schema.string({ min: 1, max: 1000 }),
        timeoutSeconds: schema.optional(schema.number({ integer: true, min: 10, max: 86_400 })),
      }),
      level: 'builtin',
      effects: 'read',
      recovery: 'retry-safe',
      resultTrust: 'trusted',
      resultProvenance: 'tool',
      interaction: 'watch_page',
      resolveTarget: async (params) => {
        const tabId = await resolveTabId(params.tabId);
        const tab = await chrome.tabs.get(tabId);
        let origin: string | undefined;
        if (tab.url) {
          try {
            origin = new URL(tab.url).origin;
          } catch {
            origin = undefined;
          }
        }
        return { tabId, origin };
      },
      prepareInteraction: async (params) => ({
        kind: 'watch_page',
        tabId: await resolveTabId(params.tabId),
        condition: { type: params.condition, value: params.value },
        deadlineAt: Date.now() + (params.timeoutSeconds ?? 300) * 1000,
      }),
      execute: unavailableInteractionExecute,
    },
    {
      name: 'schedule_resume',
      label: '定时继续',
      description:
        'Suspend the current turn and resume it after a delay. Use for a concrete future check, not as a substitute for waiting on a known page condition.',
      parameters: schema.object({
        delaySeconds: schema.number({ integer: true, min: 10, max: 604_800 }),
        reason: schema.string({ min: 1, max: 500 }),
      }),
      level: 'builtin',
      effects: 'read',
      recovery: 'retry-safe',
      resultTrust: 'trusted',
      resultProvenance: 'tool',
      interaction: 'schedule',
      prepareInteraction: async (params) => ({
        kind: 'schedule',
        resumeAt: Date.now() + params.delaySeconds * 1000,
        reason: params.reason,
      }),
      execute: unavailableInteractionExecute,
    },
  ];
}
