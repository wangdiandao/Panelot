import { schema } from '../agent/schema';
import type { AnyAgentTool } from '../agent/tool';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function limit(value?: number): number {
  return Math.min(MAX_LIMIT, Math.max(1, value ?? DEFAULT_LIMIT));
}

function text(value: string) {
  return { content: [{ type: 'text' as const, text: value }] };
}

function timestamp(value?: number): string {
  return value ? new Date(value).toISOString() : 'unknown time';
}

function sessionUrl(entry: chrome.sessions.Session): string | undefined {
  return entry.tab?.url ?? entry.window?.tabs?.find((tab) => tab.url)?.url;
}

function origin(value: string): string {
  const parsed = new URL(value);
  return parsed.origin === 'null' ? value : parsed.origin;
}

export function createBrowserDataTools(): AnyAgentTool[] {
  return [
    {
      name: 'history_search',
      label: '搜索浏览历史',
      description:
        'Search browser history by title or URL, optionally within a time range; use it to find a page the user explicitly refers to, not to profile browsing behavior.',
      parameters: schema.object({
        query: schema.optional(schema.string()),
        startTime: schema.optional(
          schema.number({ description: 'Inclusive Unix timestamp in milliseconds' }),
        ),
        endTime: schema.optional(
          schema.number({ description: 'Exclusive Unix timestamp in milliseconds' }),
        ),
        maxResults: schema.optional(schema.number({ integer: true, min: 1, max: MAX_LIMIT })),
      }),
      level: 'L0',
      effects: 'read',
      execute: async (
        _id,
        params: { query?: string; startTime?: number; endTime?: number; maxResults?: number },
      ) => {
        const rows = await chrome.history.search({
          text: params.query?.trim() ?? '',
          startTime: params.startTime ?? 0,
          ...(params.endTime === undefined ? {} : { endTime: params.endTime }),
          maxResults: limit(params.maxResults),
        });
        return text(
          rows
            .map(
              (item) =>
                `${timestamp(item.lastVisitTime)} · ${item.title || '(untitled)'}\n${item.url ?? ''}`,
            )
            .join('\n\n') || '(no matching history entries)',
        );
      },
    },
    {
      name: 'bookmarks_search',
      label: '搜索书签',
      description:
        'Search browser bookmarks by title or URL when the user asks for a saved page or destination.',
      parameters: schema.object({
        query: schema.string({ min: 1 }),
        maxResults: schema.optional(schema.number({ integer: true, min: 1, max: MAX_LIMIT })),
      }),
      level: 'L0',
      effects: 'read',
      execute: async (_id, params: { query: string; maxResults?: number }) => {
        const rows = (await chrome.bookmarks.search(params.query)).filter((item) => item.url);
        return text(
          rows
            .slice(0, limit(params.maxResults))
            .map((item) => `[${item.id}] ${item.title || '(untitled)'}\n${item.url}`)
            .join('\n\n') || '(no matching bookmarks)',
        );
      },
    },
    {
      name: 'top_sites',
      label: '列出常用站点',
      description:
        'List the browser-provided most visited sites when the user asks to navigate to a familiar or frequently used site.',
      parameters: schema.object({
        maxResults: schema.optional(schema.number({ integer: true, min: 1, max: MAX_LIMIT })),
      }),
      level: 'L0',
      effects: 'read',
      execute: async (_id, params: { maxResults?: number }) => {
        const rows = await chrome.topSites.get();
        return text(
          rows
            .slice(0, limit(params.maxResults))
            .map((item) => `${item.title || '(untitled)'}\n${item.url}`)
            .join('\n\n') || '(no top sites)',
        );
      },
    },
    {
      name: 'sessions_recently_closed',
      label: '列出最近关闭项',
      description:
        'List recently closed tabs and windows, including their session ids, before restoring one.',
      parameters: schema.object({
        maxResults: schema.optional(schema.number({ integer: true, min: 1, max: 25 })),
      }),
      level: 'L0',
      effects: 'read',
      execute: async (_id, params: { maxResults?: number }) => {
        const rows = await chrome.sessions.getRecentlyClosed({
          maxResults: Math.min(25, limit(params.maxResults)),
        });
        return text(
          rows
            .map((entry) => {
              const kind = entry.tab ? 'tab' : 'window';
              const title = entry.tab?.title ?? entry.window?.tabs?.[0]?.title ?? '(untitled)';
              return `[${entry.tab?.sessionId ?? entry.window?.sessionId ?? 'unavailable'}] ${kind} · ${title}\n${sessionUrl(entry) ?? ''}`;
            })
            .join('\n\n') || '(no recently closed tabs or windows)',
        );
      },
    },
    {
      name: 'session_restore',
      label: '恢复关闭项',
      description:
        'Restore one recently closed tab or window by session id; this changes the visible browser session and requires write approval.',
      parameters: schema.object({ sessionId: schema.string({ min: 1 }) }),
      level: 'L0',
      effects: 'write',
      resolveTarget: async (params: { sessionId: string }) => {
        const rows = await chrome.sessions.getRecentlyClosed({ maxResults: 25 });
        const entry = rows.find(
          (item) =>
            item.tab?.sessionId === params.sessionId || item.window?.sessionId === params.sessionId,
        );
        const url = entry ? sessionUrl(entry) : undefined;
        return url ? { origin: origin(url) } : {};
      },
      execute: async (_id, params: { sessionId: string }) => {
        const restored = await chrome.sessions.restore(params.sessionId);
        if (!restored) throw new Error('The recently closed item is no longer available.');
        const kind = restored.tab ? 'tab' : 'window';
        return text(
          `Restored ${kind}: ${restored.tab?.title ?? restored.window?.tabs?.[0]?.title ?? params.sessionId}`,
        );
      },
    },
    {
      name: 'tab_groups_list',
      label: '列出标签组',
      description: 'List tab groups in the current window, or every window when all is true.',
      parameters: schema.object({ all: schema.optional(schema.boolean()) }),
      level: 'L0',
      effects: 'read',
      execute: async (_id, params: { all?: boolean }) => {
        const groups = await chrome.tabGroups.query(
          params.all ? {} : { windowId: chrome.windows.WINDOW_ID_CURRENT },
        );
        return text(
          groups
            .map(
              (group) =>
                `[${group.id}] ${group.title || '(untitled)'} · ${group.color} · ${group.collapsed ? 'collapsed' : 'expanded'}`,
            )
            .join('\n') || '(no tab groups)',
        );
      },
    },
    {
      name: 'tabs_group',
      label: '整理标签页',
      description:
        'Group existing tabs by id, optionally into an existing group; this reorganizes the browser and requires write approval.',
      parameters: schema.object({
        tabIds: schema.array(schema.number({ integer: true }), { min: 1 }),
        groupId: schema.optional(schema.number({ integer: true })),
      }),
      level: 'L0',
      effects: 'write',
      execute: async (_id, params: { tabIds: number[]; groupId?: number }) => {
        const tabIds = params.tabIds as [number, ...number[]];
        const groupId = await chrome.tabs.group({
          tabIds,
          ...(params.groupId === undefined ? {} : { groupId: params.groupId }),
        });
        return text(`Grouped ${params.tabIds.length} tab(s) into group [${groupId}].`);
      },
    },
    {
      name: 'tab_group_update',
      label: '更新标签组',
      description:
        'Rename, recolor, or collapse a tab group; this changes browser organization and requires write approval.',
      parameters: schema.object({
        groupId: schema.number({ integer: true }),
        title: schema.optional(schema.string({ max: 100 })),
        color: schema.optional(
          schema.enum([
            'grey',
            'blue',
            'red',
            'yellow',
            'green',
            'pink',
            'purple',
            'cyan',
            'orange',
          ]),
        ),
        collapsed: schema.optional(schema.boolean()),
      }),
      level: 'L0',
      effects: 'write',
      execute: async (
        _id,
        params: {
          groupId: number;
          title?: string;
          color?:
            'grey' | 'blue' | 'red' | 'yellow' | 'green' | 'pink' | 'purple' | 'cyan' | 'orange';
          collapsed?: boolean;
        },
      ) => {
        const { groupId, ...changes } = params;
        if (Object.keys(changes).length === 0)
          throw new Error('Provide a title, color, or collapsed state to update.');
        const group = await chrome.tabGroups.update(groupId, changes);
        if (!group) throw new Error(`Tab group [${groupId}] is no longer available.`);
        return text(`Updated tab group [${group.id}] ${group.title || '(untitled)'}.`);
      },
    },
  ];
}
