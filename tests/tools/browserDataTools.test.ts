import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnyAgentTool, ToolResult } from '../../src/agent/tool';
import { createBrowserDataTools } from '../../src/tools/browserDataTools';

const historySearch = vi.fn();
const bookmarksSearch = vi.fn();
const topSitesGet = vi.fn();
const recentlyClosed = vi.fn();
const restore = vi.fn();
const groupsQuery = vi.fn();
const groupTabs = vi.fn();
const updateGroup = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as unknown as { chrome: unknown }).chrome = {
    history: { search: historySearch },
    bookmarks: { search: bookmarksSearch },
    topSites: { get: topSitesGet },
    sessions: { getRecentlyClosed: recentlyClosed, restore },
    windows: { WINDOW_ID_CURRENT: -2 },
    tabs: { group: groupTabs },
    tabGroups: { query: groupsQuery, update: updateGroup },
  };
});

function tool(name: string): AnyAgentTool {
  return createBrowserDataTools().find((item) => item.name === name)!;
}

const signal = () => new AbortController().signal;
const output = (result: ToolResult) => {
  const first = result.content[0];
  return first?.type === 'text' ? first.text : '';
};

describe('browser data tools', () => {
  it('bounds history results and renders useful metadata', async () => {
    historySearch.mockResolvedValue([
      { title: 'Panelot', url: 'https://example.com/panelot', lastVisitTime: 1_700_000_000_000 },
    ]);

    const result = await tool('history_search').execute(
      'call',
      { query: 'panel', maxResults: 999 } as never,
      signal(),
      undefined,
    );

    expect(historySearch).toHaveBeenCalledWith({ text: 'panel', startTime: 0, maxResults: 100 });
    expect(output(result)).toContain('Panelot');
    expect(output(result)).toContain('https://example.com/panelot');
  });

  it('filters bookmark folders and respects the requested limit', async () => {
    bookmarksSearch.mockResolvedValue([
      { id: 'folder', title: 'Folder' },
      { id: '1', title: 'One', url: 'https://one.example/' },
      { id: '2', title: 'Two', url: 'https://two.example/' },
    ]);

    const result = await tool('bookmarks_search').execute(
      'call',
      { query: 'example', maxResults: 1 } as never,
      signal(),
      undefined,
    );

    expect(output(result)).toContain('One');
    expect(output(result)).not.toContain('Two');
    expect(output(result)).not.toContain('Folder');
  });

  it('attributes a restore approval to the destination origin', async () => {
    recentlyClosed.mockResolvedValue([
      { tab: { sessionId: 's1', title: 'Closed', url: 'https://restore.example/path' } },
    ]);

    await expect(
      tool('session_restore').resolveTarget!({ sessionId: 's1' } as never),
    ).resolves.toEqual({
      origin: 'https://restore.example',
    });
  });

  it('always lists tab groups across all browser windows', async () => {
    groupsQuery.mockResolvedValue([{ id: 5, title: 'Research', color: 'blue', collapsed: false }]);

    const result = await tool('tab_groups_list').execute('call', {} as never, signal(), undefined);

    expect(groupsQuery).toHaveBeenCalledWith({});
    expect(output(result)).toContain('Research');
  });

  it('does not expose a window-scope parameter for tab groups', () => {
    expect(tool('tab_groups_list').parameters.safeParse({}).success).toBe(true);
    expect(tool('tab_groups_list').parameters.safeParse({ all: true }).success).toBe(false);
  });

  it('restores by session id and reports the restored kind', async () => {
    restore.mockResolvedValue({ tab: { sessionId: 's1', title: 'Restored tab' } });
    const result = await tool('session_restore').execute(
      'call',
      { sessionId: 's1' } as never,
      signal(),
      undefined,
    );
    expect(restore).toHaveBeenCalledWith('s1');
    expect(output(result)).toContain('Restored tab');
  });

  it('groups a non-empty tab list and updates group presentation', async () => {
    groupTabs.mockResolvedValue(7);
    updateGroup.mockResolvedValue({ id: 7, title: 'Research' });

    const grouped = await tool('tabs_group').execute(
      'call',
      { tabIds: [2, 3] } as never,
      signal(),
      undefined,
    );
    const updated = await tool('tab_group_update').execute(
      'call',
      { groupId: 7, title: 'Research', color: 'blue' } as never,
      signal(),
      undefined,
    );

    expect(groupTabs).toHaveBeenCalledWith({ tabIds: [2, 3] });
    expect(updateGroup).toHaveBeenCalledWith(7, { title: 'Research', color: 'blue' });
    expect(output(grouped)).toContain('[7]');
    expect(output(updated)).toContain('Research');
  });
});
