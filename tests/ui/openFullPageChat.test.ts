import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openFullPageChat, openSidePanelAndCloseFullPage } from '../../src/ui/openFullPageChat';

const create = vi.fn();
const close = vi.fn();
const open = vi.fn();
const closeWindow = vi.fn();

beforeEach(() => {
  create.mockReset();
  close.mockReset();
  open.mockReset();
  create.mockResolvedValue({ id: 7, windowId: 3 });
  close.mockResolvedValue(undefined);
  open.mockResolvedValue(undefined);
  closeWindow.mockReset();
  (globalThis as unknown as { window: unknown }).window = { close: closeWindow };
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { getURL: (path: string) => `chrome-extension://panelot${path}` },
    tabs: { create },
    sidePanel: { close, open },
  };
});

describe('openSidePanelAndCloseFullPage', () => {
  it('closes the full-page tab only after the side panel opens', async () => {
    await openSidePanelAndCloseFullPage(3);

    expect(open).toHaveBeenCalledWith({ windowId: 3 });
    expect(closeWindow).toHaveBeenCalledOnce();
  });

  it('keeps the full-page tab when opening the side panel fails', async () => {
    open.mockRejectedValueOnce(new Error('not allowed'));

    await expect(openSidePanelAndCloseFullPage(3)).rejects.toThrow('not allowed');

    expect(closeWindow).not.toHaveBeenCalled();
  });
});

describe('openFullPageChat', () => {
  it('opens the current thread and closes the global side panel in that window', async () => {
    await openFullPageChat('thread / 1');

    expect(create).toHaveBeenCalledWith({
      url: 'chrome-extension://panelot/chat.html?thread=thread%20%2F%201',
    });
    expect(close).toHaveBeenCalledWith({ windowId: 3 });
    expect(closeWindow).not.toHaveBeenCalled();
  });

  it('falls back to closing the panel document when the native close call is unavailable', async () => {
    (chrome.sidePanel as unknown as { close?: typeof close }).close = undefined;

    await openFullPageChat();

    expect(create).toHaveBeenCalledWith({ url: 'chrome-extension://panelot/chat.html' });
    expect(closeWindow).toHaveBeenCalledOnce();
  });
});
