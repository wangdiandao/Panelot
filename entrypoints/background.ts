import { EngineHost } from '../src/engine/host';
import { RealEngineCore } from '../src/engine/core';
import { SettingsProviderResolver } from '../src/engine/providerResolver';
import { PanelotDB } from '../src/db/schema';
import { ThreadTree } from '../src/db/tree';
import { ToolRegistry } from '../src/agent/tool';
import { CompactionRunner } from '../src/agent/compactionRunner';
import type { GatekeeperCheck } from '../src/agent/loop';
import { ENGINE_PORT_NAME, wrapPortConnection } from '../src/messaging/transport';
import { SettingsStore } from '../src/settings/store';

export default defineBackground(() => {
  const db = new PanelotDB();
  const tree = new ThreadTree(db);
  const tools = new ToolRegistry();

  // Interim gatekeeper until Phase 7: read tools pass, write tools ask.
  // (Full two-axis Gatekeeper with rules/blacklist arrives with browser tools.)
  const gatekeeper: GatekeeperCheck = {
    check: async (call) => {
      if (call.effects === 'read') return { verdict: 'allow' };
      return {
        verdict: 'ask',
        request: {
          tool: call.toolName,
          label: call.toolName,
          params: call.params,
          targetOrigin: '',
          flags: [],
        },
      };
    },
  };

  const resolver = new SettingsProviderResolver(db);
  const core = new RealEngineCore(db, tools, gatekeeper, resolver, async () => {
    const settings = await SettingsStore.global.get();
    return {
      userGlobalPrompt: settings.userGlobalPrompt,
      environment: {
        date: new Date().toISOString().slice(0, 10),
        language: settings.language ?? 'zh-CN',
      },
    };
  });
  core.compaction = new CompactionRunner(
    tree,
    (threadId) => resolver.resolveTaskModel(threadId),
    (ev) => core.onBroadcast(ev),
  );

  const host = new EngineHost(core);
  core.onBroadcast = (ev) => host.broadcast(ev);

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
