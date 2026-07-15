export async function openFullPageChat(threadId?: string): Promise<chrome.tabs.Tab> {
  const query = threadId ? `?thread=${encodeURIComponent(threadId)}` : '';
  const tab = await chrome.tabs.create({
    url: chrome.runtime.getURL(`/chat.html${query}`),
  });

  if (typeof chrome.sidePanel?.close === 'function' && tab.windowId !== undefined) {
    try {
      await chrome.sidePanel.close({ windowId: tab.windowId });
      return tab;
    } catch {
      // The API can be unavailable or the panel context can disappear during handoff.
    }
  }

  window.close();
  return tab;
}

export async function openSidePanelAndCloseFullPage(windowId: number): Promise<void> {
  await chrome.sidePanel.open({ windowId });
  window.close();
}
