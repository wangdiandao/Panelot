/**
 * Built-in tools executed inside the engine (docs/05 §3): fetch_url, memory,
 * download. web_search ships when a search backend is chosen;
 * ask_user maps to the approval-style RPC.
 */

import { schema } from '../agent/schema';
import type { AnyAgentTool } from '../agent/tool';
import type { PanelotDB } from '../db/schema';

// ---------------------------------------------------------------------------

export function createFetchUrlTool(): AnyAgentTool {
  return {
    name: 'fetch_url',
    label: '抓取网页',
    description:
      'Fetch a URL in the background and return readable text (no tab opened). Use for reference lookups; use tab_open + read_page when you need to interact with the page.',
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
            content: [{ type: 'text', text: record ? record.value : `（无记忆: ${params.key}）` }],
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
        'Save a persistent memory (key + value). Use for user preferences and durable facts, not transient task state.',
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
        return { content: [{ type: 'text', text: `已保存记忆: ${params.key}` }] };
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
      return { content: [{ type: 'text', text: `已开始下载 (#${downloadId}): ${params.url}` }] };
    },
  };
}
