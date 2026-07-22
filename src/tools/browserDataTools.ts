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
  return value ? new Date(value).toISOString() : '时间未知';
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
        'Search browser history by title or URL, optionally within a time range. Use it to find a page the user explicitly refers to, not to profile browsing behavior.',
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
                `${timestamp(item.lastVisitTime)} · ${item.title || '（无标题）'}\n${item.url ?? ''}`,
            )
            .join('\n\n') || '（没有匹配的浏览历史）',
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
            .map((item) => `[${item.id}] ${item.title || '（无标题）'}\n${item.url}`)
            .join('\n\n') || '（没有匹配的书签）',
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
            .map((item) => `${item.title || '（无标题）'}\n${item.url}`)
            .join('\n\n') || '（没有常用站点）',
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
              const kind = entry.tab ? '标签页' : '窗口';
              const title = entry.tab?.title ?? entry.window?.tabs?.[0]?.title ?? '（无标题）';
              return `[${entry.tab?.sessionId ?? entry.window?.sessionId ?? 'unavailable'}] ${kind} · ${title}\n${sessionUrl(entry) ?? ''}`;
            })
            .join('\n\n') || '（没有最近关闭的标签页或窗口）',
        );
      },
    },
    {
      name: 'session_restore',
      label: '恢复关闭项',
      description:
        'Restore one recently closed tab or window by session id. This changes the visible browser session and requires write approval.',
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
        if (!restored) throw new Error('最近关闭项已不可恢复。');
        const kind = restored.tab ? '标签页' : '窗口';
        return text(
          `已恢复${kind}：${restored.tab?.title ?? restored.window?.tabs?.[0]?.title ?? params.sessionId}`,
        );
      },
    },
    {
      name: 'tab_groups_list',
      label: '列出标签组',
      description: 'List every tab group across all browser windows.',
      parameters: schema.object({}),
      level: 'L0',
      effects: 'read',
      execute: async () => {
        const groups = await chrome.tabGroups.query({});
        return text(
          groups
            .map(
              (group) =>
                `[${group.id}] ${group.title || '（无标题）'} · ${group.color} · ${group.collapsed ? '已折叠' : '已展开'}`,
            )
            .join('\n') || '（没有标签组）',
        );
      },
    },
    {
      name: 'tabs_group',
      label: '整理标签页',
      description:
        'Group existing tabs by id, optionally into an existing group. This reorganizes the browser and requires write approval.',
      parameters: schema.object({
        tabIds: schema.array(schema.number({ integer: true, min: 0 }), { min: 1 }),
        groupId: schema.optional(schema.number({ integer: true, min: 0 })),
      }),
      level: 'L0',
      effects: 'write',
      execute: async (_id, params: { tabIds: number[]; groupId?: number }) => {
        const tabIds = params.tabIds as [number, ...number[]];
        const groupId = await chrome.tabs.group({
          tabIds,
          ...(params.groupId === undefined ? {} : { groupId: params.groupId }),
        });
        return text(`已将 ${params.tabIds.length} 个标签页整理到标签组 [${groupId}]。`);
      },
    },
    {
      name: 'tab_group_update',
      label: '更新标签组',
      description:
        'Rename, recolor, or collapse a tab group. This changes browser organization and requires write approval.',
      parameters: schema.object({
        groupId: schema.number({ integer: true, min: 0 }),
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
          throw new Error('请至少提供标题、颜色或折叠状态中的一项。');
        const group = await chrome.tabGroups.update(groupId, changes);
        if (!group) throw new Error(`标签组 [${groupId}] 已不可用。`);
        return text(`已更新标签组 [${group.id}] ${group.title || '（无标题）'}。`);
      },
    },
  ];
}
