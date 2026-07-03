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
import { BrowserToolGateway } from '../src/tools/gateway';
import { createL0Tools, createL1Tools } from '../src/tools/browserTools';
import { createDownloadTool, createFetchUrlTool, createMemoryTools, createTodoTool } from '../src/tools/builtinTools';

export default defineBackground(() => {
  const db = new PanelotDB();
  const tree = new ThreadTree(db);
  const gateway = new BrowserToolGateway();

  // Interim gatekeeper until the full two-axis Gatekeeper (Phase 7):
  // read tools pass, write tools ask with the target origin surfaced.
  const gatekeeper: GatekeeperCheck = {
    check: async (call, threadId) => {
      if (call.effects === 'read') return { verdict: 'allow' };
      return {
        verdict: 'ask',
        request: {
          tool: call.toolName,
          label: call.toolName,
          params: call.params,
          targetOrigin: await gateway.getTabOrigin(threadId),
          flags: [],
        },
      };
    },
  };

  // Per-thread tool registry: browser tools bind to the thread's controlled
  // tabs; builtins are shared. Rebuilt per turn (cheap — definitions only).
  const registryFor = (threadId: string): ToolRegistry => {
    const registry = new ToolRegistry();
    const getThreadId = () => threadId;
    for (const tool of createL0Tools(gateway, getThreadId)) registry.register(tool);
    for (const tool of createL1Tools(gateway, getThreadId)) registry.register(tool);
    registry.register(createFetchUrlTool());
    for (const tool of createMemoryTools(db)) registry.register(tool);
    registry.register(createTodoTool((tid, todos) => {
      todoStore.set(tid, todos);
    }, getThreadId));
    registry.register(createDownloadTool());
    return registry;
  };
  const todoStore = new Map<string, unknown>();

  const resolver = new SettingsProviderResolver(db);
  const core = new RealEngineCore(db, registryFor, gatekeeper, resolver, async () => {
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

  // Manual operation on a controlled page → pause the owning thread (docs/05 §5).
  gateway.onManualOperation = (tabId) => {
    for (const threadId of core.activeThreadIds()) {
      if (gateway.controls(threadId).includes(tabId)) {
        void core.pauseThread(threadId, '检测到你在页面上手动操作，任务已自动暂停。发送消息可继续。');
      }
    }
  };

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== ENGINE_PORT_NAME) return;
    host.onConnection(wrapPortConnection(port));
  });

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
