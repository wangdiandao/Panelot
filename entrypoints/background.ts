import { EngineHost } from '../src/engine/host';
import { RealEngineCore } from '../src/engine/core';
import { SettingsProviderResolver } from '../src/engine/providerResolver';
import { PanelotDB } from '../src/db/schema';
import { ToolRegistry } from '../src/agent/tool';
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
import { SkillManager, createLoadSkillTool } from '../src/skills/manager';
import { McpManager } from '../src/mcp/manager';
import { evictAttachmentsIfNeeded } from '../src/data/quota';

export default defineBackground(() => {
  const db = new PanelotDB();
  const gateway = new BrowserToolGateway();
  const cdp = new CdpManager();
  const skills = new SkillManager(db);
  const mcp = new McpManager();

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
      dispatchKey: (tabId, combo) => cdp.dispatchKey(tabId, combo),
      db, // oversized extract output offloads to the attachments table
    })) add(tool);
    for (const tool of createL2Tools(cdp, gateway, db, getThreadId)) add(tool);
    add(createFetchUrlTool());
    for (const tool of createMemoryTools(db)) add(tool);
    add(createTodoTool((tid, todos) => {
      todoStore.set(tid, todos);
    }, getThreadId));
    add(createDownloadTool());
    add(createLoadSkillTool(skills, getThreadId));
    // MCP tools (mcp__{server}__{tool}) from connected servers (docs/07 §4).
    for (const tool of mcp.buildTools()) add(tool);
    return registry;
  };
  const todoStore = new Map<string, unknown>();

  const resolver = new SettingsProviderResolver(db);
  const core = new RealEngineCore(db, registryFor, gatekeeper, resolver, async () => {
    const settings = await SettingsStore.global.get();
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
    const url = activeTab?.url;
    const sitePrompts = await SettingsStore.sitePrompts.get();
    return {
      userGlobalPrompt: settings.userGlobalPrompt,
      sitePrompts: url
        ? sitePrompts.filter((sp) => {
            try {
              return new URL(url).hostname.includes(sp.pattern.replace(/^\*\./, ''));
            } catch {
              return false;
            }
          })
        : [],
      skillsIndex: await skills.buildIndex(url),
      environment: {
        date: new Date().toISOString().slice(0, 10),
        language: settings.language ?? 'zh-CN',
        activeTab: activeTab?.url && activeTab.title ? { url: activeTab.url, title: activeTab.title } : undefined,
      },
    };
  });

  // Rebuild the tool registry when MCP servers connect/disconnect (list_changed).
  mcp.onToolsChanged = () => {/* per-turn registryFor rebuilds from mcp.buildTools() */};
  void mcp.ensureConnected();
  core.onApprovalDecision = (threadId, tool, origin, decision) =>
    gatekeeperService.applyDecision(threadId, tool, origin, decision);
  // Composer permission switch → per-thread gatekeeper config (docs/06 §1).
  core.onPermissionOverride = (threadId, approvalPolicy) =>
    gatekeeperService.setThreadConfig(threadId, { approvalPolicy });
  // "/skill-name …" activates the skill for the turn (docs/08 §4): the body
  // rides along as attached context on the user message.
  core.resolveSlashCommand = async (text) => {
    const skill = await skills.resolveCommand(text);
    if (!skill) return null;
    return {
      kind: 'skill',
      label: `⚡ ${skill.name}`,
      content: [{ type: 'text', text: `# Skill: ${skill.name}\n\n${skill.body}` }],
    };
  };

  // run_javascript ships denied by default (docs/05 §3) — seed once.
  void GatekeeperService.listRules().then((rules) => {
    if (!rules.some((r) => r.tool === 'run_javascript')) {
      void GatekeeperService.addRule({ tool: 'run_javascript', origin: '*', verdict: 'deny', source: 'user_setting' });
    }
  });

  const host = new EngineHost(core);
  core.onBroadcast = (ev) => {
    // Turn boundary: an auto-discovered (unpinned) target only lives for the
    // turn — release it so the next turn follows the tab the user is looking
    // at. Agent-pinned targets (tab_open/tab_activate) persist.
    if (ev.type === 'turn.complete') gateway.releaseFloatingTarget(ev.threadId);
    host.broadcast(ev);
  };

  // MCP OAuth trigger from the settings page (docs/07 §3).
  chrome.runtime.onMessage.addListener((msg: unknown) => {
    const m = msg as { type?: string; id?: string };
    if (m.type === 'panelot.mcpOauth' && m.id) {
      void mcp.runOAuthFlow(m.id).then(() => mcp.connect(m.id!)).catch(() => {});
    }
  });

  // Touched-tab audit trail changes → broadcast to the task panel (docs/09 §3.1).
  gateway.onTabsChanged = (threadId) => {
    void (async () => {
      const tabs = await Promise.all(
        gateway.touchedTabs(threadId).map(async (tabId) => {
          try {
            const t = await chrome.tabs.get(tabId);
            return { tabId, title: t.title ?? '', url: t.url ?? '' };
          } catch {
            return null;
          }
        }),
      );
      core.onBroadcast({ type: 'tabs.updated', threadId, tabs: tabs.filter((t) => t !== null) });
    })();
  };

  // Manual operation on the tab an agent is DRIVING → pause that thread
  // (docs/05 §5). Keyed on the current target, not the audit trail: touching
  // a page the agent worked on earlier is not a conflict.
  gateway.onManualOperation = (tabId) => {
    for (const threadId of core.activeThreadIds()) {
      if (gateway.currentTarget(threadId) === tabId) {
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
  chrome.alarms.create('panelot-quota', { periodInMinutes: 15 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'panelot-quota') {
      // LRU-evict over-budget attachments, never touching a live thread (docs/02 §6).
      const active = core.activeThreadIds()[0];
      void evictAttachmentsIfNeeded(db, active);
    }
  });
});
