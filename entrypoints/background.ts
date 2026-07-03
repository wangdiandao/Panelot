import { EngineHost, StubEngineCore } from '../src/engine/host';
import { ENGINE_PORT_NAME, wrapPortConnection } from '../src/messaging/transport';

export default defineBackground(() => {
  // Engine core is swapped in Phase 4; the host shell is final.
  const host = new EngineHost(new StubEngineCore());

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== ENGINE_PORT_NAME) return;
    host.onConnection(wrapPortConnection(port));
  });

  // Toolbar click opens the side panel (per-window).
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {/* older Chrome */});

  chrome.commands.onCommand.addListener((command) => {
    if (command === 'toggle-sidepanel') {
      void chrome.windows.getCurrent().then((win) => {
        if (win.id !== undefined) void chrome.sidePanel.open({ windowId: win.id });
      });
    }
  });
});
