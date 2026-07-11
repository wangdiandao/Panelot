import { EngineHost } from '../src/engine/host';
import { RealEngineCore } from '../src/engine/core';
import { SettingsProviderResolver } from '../src/engine/providerResolver';
import { PanelotDB } from '../src/db/schema';
import { ToolRegistry } from '../src/agent/tool';
import type { GatekeeperCheck } from '../src/agent/loop';
import { ENGINE_PORT_NAME, wrapPortConnection } from '../src/messaging/transport';
import { SettingsStore } from '../src/settings/store';
import { siteInstructionMatches } from '../src/settings/sitePrompts';
import { AttachmentRepository } from '../src/data/attachments';
import { listEnabledPluginSiteInstructions } from '../src/plugins/assets';
import { BrowserToolGateway } from '../src/tools/gateway';
import { createL0Tools, createL1Tools } from '../src/tools/browserTools';
import { createL2Tools } from '../src/tools/l2Tools';
import { CdpManager } from '../src/tools/cdp/debugger';
import {
  createDownloadTool,
  createFetchUrlTool,
  createMemoryTools,
  createTodoTool,
} from '../src/tools/builtinTools';
import { GatekeeperService } from '../src/gatekeeper/service';
import type { AnyAgentTool } from '../src/agent/tool';
import { SkillRuntime, createLoadSkillTool } from '../src/skills/runtime';
import { McpManager } from '../src/mcp/manager';
import { evictAttachmentsIfNeeded } from '../src/data/quota';
import Dexie from 'dexie';
import { threadIdFromNotification, threadNotificationId } from '../src/ui/threadNotification';

export default defineBackground(() => {
  void prepareStorageGeneration().then(startBackground);
});

async function prepareStorageGeneration(): Promise<void> {
  const key = 'panelot_storage_generation';
  const current = await chrome.storage.local.get(key);
  if (current[key] === 'panelot_v1') return;
  await Dexie.delete('panelot');
  await chrome.storage.local.clear();
  await chrome.storage.session.clear();
  await chrome.storage.local.set({ [key]: 'panelot_v1' });
}

async function startBackground(): Promise<void> {
  const db = new PanelotDB();
  const gateway = new BrowserToolGateway();
  const cdp = new CdpManager();
  const skills = new SkillRuntime(db);
  const mcp = new McpManager();
  const attentionNotifications = new Map<string, Set<string>>();

  const clearThreadNotifications = (threadId: string) => {
    const ids = attentionNotifications.get(threadId);
    if (!ids) return;
    attentionNotifications.delete(threadId);
    for (const id of ids) void chrome.notifications.clear(id);
  };

  const notifyThread = (threadId: string, kind: 'approval' | 'recovery', instanceId: string) => {
    const id = threadNotificationId(threadId, kind, instanceId);
    let ids = attentionNotifications.get(threadId);
    if (!ids) {
      ids = new Set();
      attentionNotifications.set(threadId, ids);
    }
    ids.add(id);
    void chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('/icon/128.png'),
      title: 'Panelot',
      message:
        kind === 'approval'
          ? 'A browser action is waiting for your approval.'
          : 'A task needs your decision before it can continue.',
      priority: 1,
    });
  };

  chrome.notifications.onClicked.addListener((notificationId) => {
    const threadId = threadIdFromNotification(notificationId);
    if (!threadId) return;
    clearThreadNotifications(threadId);
    void chrome.tabs.create({
      url: chrome.runtime.getURL(`/chat.html?thread=${encodeURIComponent(threadId)}`),
    });
  });

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
      dispatchKey: (tabId, combo) => {
        // CDP keys are isTrusted — indistinguishable from user input in the
        // content script. Mark the window so the agent's own keystroke does
        // not trigger the manual-operation auto-pause.
        gateway.markAgentInput(tabId);
        gateway.markDriven(threadId, tabId);
        return cdp.dispatchKey(tabId, combo);
      },
      db, // oversized extract output offloads to the attachments table
    }))
      add(tool);
    for (const tool of createL2Tools(cdp, gateway, db, getThreadId)) add(tool);
    add(createFetchUrlTool());
    for (const tool of createMemoryTools(db)) add(tool);
    add(
      createTodoTool((tid, todos) => {
        todoStore.set(tid, todos);
      }, getThreadId),
    );
    add(createDownloadTool());
    add(createLoadSkillTool(skills, getThreadId));
    // MCP tools (mcp__{server}__{tool}) from connected servers (docs/07 §4).
    for (const tool of mcp.buildTools()) add(tool);
    return registry;
  };
  const todoStore = new Map<string, unknown>();

  const resolver = new SettingsProviderResolver(db);
  await new AttachmentRepository(db).cleanupIncomplete();
  const core = new RealEngineCore(db, registryFor, gatekeeper, resolver, async () => {
    const settings = await SettingsStore.global.get();
    const [activeTab] = await chrome.tabs
      .query({ active: true, currentWindow: true })
      .catch(() => []);
    const url = activeTab?.url;
    const [sitePrompts, pluginSitePrompts] = await Promise.all([
      SettingsStore.sitePrompts.get(),
      listEnabledPluginSiteInstructions(db),
    ]);
    return {
      userGlobalPrompt: settings.userGlobalPrompt,
      sitePrompts: url
        ? [...sitePrompts, ...pluginSitePrompts].filter((sp) =>
            siteInstructionMatches(sp.pattern, url),
          )
        : [],
      skillsIndex: await skills.buildIndex(url),
      environment: {
        date: new Date().toISOString().slice(0, 10),
        language: settings.language ?? 'zh-CN',
        activeTab:
          activeTab?.url && activeTab.title
            ? { url: activeTab.url, title: activeTab.title }
            : undefined,
      },
    };
  });

  // Rebuild the tool registry when MCP servers connect/disconnect (list_changed).
  mcp.onToolsChanged = () => {
    /* per-turn registryFor rebuilds from mcp.buildTools() */
  };
  void mcp.ensureConnected('startup');
  core.onBeforeRun = () => mcp.ensureConnected('use');
  core.onApprovalDecision = (threadId, tool, origin, decision) =>
    gatekeeperService.applyDecision(threadId, tool, origin, decision);
  // Composer permission switch → per-thread gatekeeper config (docs/06 §1).
  core.onPermissionOverride = (threadId, config) =>
    gatekeeperService.setThreadConfig(threadId, config);
  // "/skill-name …" activates the skill for the turn (docs/08 §4): the body
  // rides along as attached context on the user message.
  core.resolveSlashCommand = async (text) => {
    if (/^\/[^:\s]+:[^\s]+/.test(text.trim())) {
      const prompt = await mcp.executePromptCommand(text);
      if (prompt) return prompt;
    }
    const skill = await skills.resolveCommand(text);
    if (!skill) return null;
    return {
      kind: 'skill',
      label: `⚡ ${skill.name}`,
      sourceRef: skill.id,
      trust: 'trusted',
      provenance: skill.source === 'plugin' ? 'plugin' : 'user',
      content: [{ type: 'text', text: `# Skill: ${skill.name}\n\n${skill.body}` }],
    };
  };

  // run_javascript ships denied by default (docs/05 §3) — seed once.
  void GatekeeperService.listRules().then((rules) => {
    if (!rules.some((r) => r.tool === 'run_javascript')) {
      void GatekeeperService.addRule({
        tool: 'run_javascript',
        origin: '*',
        verdict: 'deny',
        source: 'user_setting',
      });
    }
  });

  const host = new EngineHost(core);
  core.onBroadcast = (ev) => {
    // Turn boundary: an auto-discovered (unpinned) target only lives for the
    // turn — release it so the next turn follows the tab the user is looking
    // at. Agent-pinned targets (tab_open/tab_activate) persist.
    if (ev.type === 'turn.complete') gateway.releaseFloatingTarget(ev.threadId);
    if (ev.type === 'approval.request') {
      notifyThread(ev.threadId, 'approval', ev.approvalId);
    } else if (ev.type === 'run.recovery_required') {
      notifyThread(ev.threadId, 'recovery', ev.run.runId);
    } else if (ev.type === 'turn.complete') {
      clearThreadNotifications(ev.threadId);
    }
    host.broadcast(ev);
  };
  void core.recover();

  // MCP OAuth trigger from the settings page (docs/07 §3).
  chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
    const m = msg as { type?: string; id?: string };
    if (m.type === 'panelot.mcpWorkerUnauthorized' && m.id) {
      void mcp.reauthorizeWorker(m.id).then((authorization) => sendResponse({ authorization }));
      return true;
    }
    if (m.type === 'panelot.mcpOauth' && m.id) {
      void mcp
        .runOAuthFlow(m.id)
        .then(() => mcp.connect(m.id!))
        .then(() => sendResponse({ ok: true }))
        .catch((error: unknown) =>
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      return true;
    }
    if (m.type === 'panelot.mcpCatalog') {
      void mcp
        .ensureConnected('use')
        .then(() =>
          sendResponse({
            ok: true,
            prompts: mcp.listPromptCommands(),
            resources: mcp.listResourceReferences(),
          }),
        )
        .catch((error: unknown) =>
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      return true;
    }
    if ((m.type === 'panelot.mcpConnect' || m.type === 'panelot.mcpStatus') && m.id) {
      void (m.type === 'panelot.mcpConnect' ? mcp.connect(m.id) : Promise.resolve())
        .then(() => sendResponse({ ok: true, description: mcp.describeServer(m.id!) }))
        .catch((error: unknown) =>
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            description: mcp.describeServer(m.id!),
          }),
        );
      return true;
    }
    if (m.type === 'panelot.mcpDisconnect' && m.id) {
      void mcp
        .disconnect(m.id)
        .then(() => sendResponse({ ok: true, description: mcp.describeServer(m.id!) }));
      return true;
    }
    const resource = msg as { type?: string; serverId?: string; uri?: string };
    if (resource.type === 'panelot.mcpReadResource' && resource.serverId && resource.uri) {
      void mcp
        .readResourceContext(resource.serverId, resource.uri)
        .then((context) => sendResponse({ ok: true, context }))
        .catch((error: unknown) =>
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      return true;
    }
    return false;
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

  // Manual operation → pause, but ONLY when a real human-vs-agent conflict
  // exists (docs/05 §5): the thread has a turn running AND the agent has
  // WRITTEN to that tab this turn. Read-only turns (Q&A about the user's own
  // page) never pause — the user scrolling their own page is not a conflict.
  gateway.onManualOperation = (tabId) => {
    for (const threadId of core.activeThreadIds()) {
      if (gateway.droveThisTurn(threadId, tabId)) {
        void core.pauseThread(
          threadId,
          '检测到你在页面上手动操作，任务已自动暂停。发送消息可继续。',
        );
      }
    }
  };

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== ENGINE_PORT_NAME) return;
    host.onConnection(wrapPortConnection(port));
  });

  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {
    /* older Chrome */
  });

  // Alt+P is the reserved _execute_action command (= toolbar-icon click):
  // with openPanelOnActionClick the browser toggles the side panel natively.
  // Never reimplement this with chrome.sidePanel.open() in an onCommand
  // handler — open() requires a synchronous user gesture, and any awaited
  // promise before it (windows.getCurrent) drops the gesture token, so the
  // call silently fails.

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
}
