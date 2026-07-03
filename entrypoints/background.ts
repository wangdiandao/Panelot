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
import { createL2Tools } from '../src/tools/l2Tools';
import { CdpManager } from '../src/tools/cdp/debugger';
import { createDownloadTool, createFetchUrlTool, createMemoryTools, createTodoTool } from '../src/tools/builtinTools';
import { GatekeeperService } from '../src/gatekeeper/service';
import type { AnyAgentTool } from '../src/agent/tool';

export default defineBackground(() => {
  const db = new PanelotDB();
  const tree = new ThreadTree(db);
  const gateway = new BrowserToolGateway();
  const cdp = new CdpManager();

  // Two-axis Gatekeeper (docs/06): the tool's level rides along so L2 forces
  // escalation and builtins are treated as origin-less.
  const gatekeeperService = new GatekeeperService(db, (threadId) => gateway.getTabOrigin(threadId));
  const toolLevels = new Map<string, string>();
  const gatekeeper: GatekeeperCheck = {
    check: (call, threadId) =>
      gatekeeperService.check({ ...call, level: toolLevels.get(call.toolName) }, threadId),
  };

  // Per-thread tool registry: browser tools bind to the thread's controlled
  // tabs; builtins are shared. Rebuilt per turn (cheap — definitions only).
  const registryFor = (threadId: string): ToolRegistry => {
    const registry = new ToolRegistry();
    const getThreadId = () => threadId;
    const add = (tool: AnyAgentTool) => {
      toolLevels.set(tool.name, tool.level);
      registry.register(tool);
    };
    for (const tool of createL0Tools(gateway, getThreadId)) add(tool);
    for (const tool of createL1Tools(gateway, getThreadId, {
      axTreeFallback: (tabId) => cdp.getAxTreeText(tabId),
      getTabId: (tid) => gateway.getTargetTab(tid),
    })) add(tool);
    for (const tool of createL2Tools(cdp, gateway, db, getThreadId)) add(tool);
    add(createFetchUrlTool());
    for (const tool of createMemoryTools(db)) add(tool);
    add(createTodoTool((tid, todos) => {
      todoStore.set(tid, todos);
    }, getThreadId));
    add(createDownloadTool());
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
  core.onApprovalDecision = (threadId, tool, origin, decision) =>
    gatekeeperService.applyDecision(threadId, tool, origin, decision);

  // run_javascript ships denied by default (docs/05 §3) — seed once.
  void GatekeeperService.listRules().then((rules) => {
    if (!rules.some((r) => r.tool === 'run_javascript')) {
      void GatekeeperService.addRule({ tool: 'run_javascript', origin: '*', verdict: 'deny', source: 'user_setting' });
    }
  });

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

  // Keepalive for running turns with no UI connected (docs/01 §4): a 30s alarm
  // wakes the SW to keep long background tasks progressing across idle gaps.
  chrome.alarms.create('panelot-keepalive', { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'panelot-keepalive' && core.activeThreadIds().length === 0) {
      // Nothing running — nothing to do; the alarm itself kept us warm.
    }
  });
});
