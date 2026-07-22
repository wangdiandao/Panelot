import { allocateEngineStreamEpoch, EngineHost } from '../src/engine/host';
import { RealEngineCore } from '../src/engine/core';
import { InteractionAutomation } from '../src/engine/interactionAutomation';
import { SettingsProviderResolver } from '../src/engine/providerResolver';
import { PanelotDB } from '../src/db/schema';
import { ToolRegistry } from '../src/agent/tool';
import type { GatekeeperCheck } from '../src/agent/loop';
import {
  ENGINE_PORT_NAME,
  type EngineConnection,
  wrapBufferedPortConnection,
} from '../src/messaging/engineConnection';
import { SettingsStore } from '../src/settings/store';
import { siteInstructionMatches } from '../src/settings/sitePrompts';
import { listEnabledPluginSiteInstructions } from '../src/plugins/assets';
import { BrowserToolGateway } from '../src/tools/gateway';
import { createL0Tools, createL1Tools } from '../src/tools/browserTools';
import { createBrowserDataTools } from '../src/tools/browserDataTools';
import { createL2Tools } from '../src/tools/l2Tools';
import { CdpManager } from '../src/tools/cdp/debugger';
import {
  createDownloadTool,
  createArtifactTool,
  createFetchUrlTool,
  createInteractionTools,
  createMemoryTools,
} from '../src/tools/builtinTools';
import { GatekeeperService } from '../src/gatekeeper/service';
import type { AnyAgentTool } from '../src/agent/tool';
import { SkillRuntime, createLoadSkillTool } from '../src/skills/runtime';
import type { RunEnvironmentSnapshot } from '../src/db/types';
import { McpManager } from '../src/mcp/manager';
import { handleMcpRuntimeMessage } from '../src/mcp/runtimeMessages';
import { threadIdFromNotification, threadNotificationId } from '../src/ui/threadNotification';
import { type DataImportCommitResult, type StorageAreaLike } from '../src/data/maintenanceTypes';
import {
  DataImportCoordinator,
  type DataImportCoordinatorPreview,
} from '../src/data/maintenanceCoordinator';
import type {
  DataImportMaintenanceStatus,
  DataImportRpcResponse,
} from '../src/data/maintenanceRpcProtocol';
import {
  DATA_IMPORT_RPC_TYPE,
  isTrustedDataImportSender,
  parseDataImportRpcRequest,
} from '../src/data/maintenanceRpcProtocol';
import {
  acceptMaintenanceWorkerPort,
  cleanupOffscreenAttachments,
  MaintenanceWorkerValidator,
  sendOffscreenWorkerCommand,
} from '../src/data/maintenanceWorkerClient';
import {
  isTrustedChatSender,
  parseClearThreadRuntimeStateRequest,
  THREAD_RUNTIME_STATE_RPC_TYPE,
  type ClearThreadRuntimeStateResponse,
} from '../src/messaging/threadRuntimeState';

type RuntimeMessageHandler = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
) => boolean | undefined;

interface PendingRuntimeMessage {
  message: unknown;
  sender: chrome.runtime.MessageSender;
  sendResponse: (response?: unknown) => void;
}

interface BackgroundLifecycleHandlers {
  permissionRemoved(): void;
  tabRemoved(tabId: number): void;
  tabReplaced(addedTabId: number, removedTabId: number): void;
}

export default defineBackground({
  type: 'module',
  main() {
    let enginePortHandler: ((connection: EngineConnection) => void) | undefined;
    let runtimeReady = false;
    let initializationFailed = false;
    let initializationStarted = false;
    const pendingPorts = new Map<
      chrome.runtime.Port,
      { connection: EngineConnection; remove: () => void }
    >();
    const messageHandlers: RuntimeMessageHandler[] = [];
    const pendingMessages: PendingRuntimeMessage[] = [];
    let lifecycleHandlers: BackgroundLifecycleHandlers | undefined;
    const pendingLifecycleEvents: Array<(handlers: BackgroundLifecycleHandlers) => void> = [];
    const dispatchMessage: RuntimeMessageHandler = (message, sender, sendResponse) => {
      for (const handler of messageHandlers) {
        if (handler(message, sender, sendResponse)) return true;
      }
      return false;
    };
    const start = () => {
      if (initializationStarted || initializationFailed) return;
      initializationStarted = true;
      try {
        const handler = startBackground(
          (runtimeHandler) => messageHandlers.push(runtimeHandler),
          prepareStorageGeneration(),
          (handlers) => {
            lifecycleHandlers = handlers;
            for (const event of pendingLifecycleEvents) event(handlers);
            pendingLifecycleEvents.length = 0;
          },
        );
        enginePortHandler = handler;
        runtimeReady = true;
        for (const [port, pending] of pendingPorts) {
          port.onDisconnect.removeListener(pending.remove);
          handler(pending.connection);
        }
        pendingPorts.clear();
        for (const pending of pendingMessages) {
          if (!dispatchMessage(pending.message, pending.sender, pending.sendResponse)) {
            pending.sendResponse(undefined);
          }
        }
        pendingMessages.length = 0;
      } catch {
        initializationFailed = true;
        runtimeReady = true;
        for (const port of pendingPorts.keys()) port.disconnect();
        pendingPorts.clear();
        for (const pending of pendingMessages) {
          pending.sendResponse({ ok: false, error: 'Background initialization failed' });
        }
        pendingMessages.length = 0;
      }
    };

    chrome.runtime.onConnect.addListener((port) => {
      if (acceptMaintenanceWorkerPort(port)) return;
      if (port.name !== ENGINE_PORT_NAME) return;
      if (initializationFailed) {
        port.disconnect();
        return;
      }
      if (enginePortHandler) {
        enginePortHandler(wrapBufferedPortConnection(port));
        return;
      }
      const connection = wrapBufferedPortConnection(port);
      const remove = () => pendingPorts.delete(port);
      pendingPorts.set(port, { connection, remove });
      port.onDisconnect.addListener(remove);
      start();
    });
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (initializationFailed) {
        sendResponse({ ok: false, error: 'Background initialization failed' });
        return true;
      }
      if (runtimeReady) return dispatchMessage(message, sender, sendResponse);
      pendingMessages.push({ message, sender, sendResponse });
      start();
      return true;
    });
    chrome.runtime.onInstalled.addListener(start);
    chrome.runtime.onStartup.addListener(start);
    chrome.permissions.onRemoved.addListener(() => {
      if (lifecycleHandlers) lifecycleHandlers.permissionRemoved();
      else pendingLifecycleEvents.push((handlers) => handlers.permissionRemoved());
      start();
    });
    chrome.tabs.onRemoved.addListener((tabId) => {
      if (lifecycleHandlers) lifecycleHandlers.tabRemoved(tabId);
      else pendingLifecycleEvents.push((handlers) => handlers.tabRemoved(tabId));
      start();
    });
    chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
      if (lifecycleHandlers) lifecycleHandlers.tabReplaced(addedTabId, removedTabId);
      else {
        pendingLifecycleEvents.push((handlers) => handlers.tabReplaced(addedTabId, removedTabId));
      }
      start();
    });
  },
});

const STORAGE_GENERATION_KEY = 'panelot_storage_generation';
const STORAGE_GENERATION = 'panelot_v1';

async function prepareStorageGeneration(): Promise<boolean> {
  const current = await storageGet(chrome.storage.local, STORAGE_GENERATION_KEY);
  if (current[STORAGE_GENERATION_KEY] === STORAGE_GENERATION) return false;
  await storageClear(chrome.storage.local);
  await storageClear(chrome.storage.session);
  return true;
}

function storageGet(
  area: chrome.storage.StorageArea,
  key: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    area.get(key, (items) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(items);
    });
  });
}

function storageClear(area: chrome.storage.StorageArea): Promise<void> {
  return new Promise((resolve, reject) => {
    area.clear(() => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function storageSet(
  area: chrome.storage.StorageArea,
  items: Record<string, unknown>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    area.set(items, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function startBackground(
  registerRuntimeMessageHandler: (handler: RuntimeMessageHandler) => void,
  resetDatabase: Promise<boolean>,
  registerLifecycleHandlers: (handlers: BackgroundLifecycleHandlers) => void,
): (connection: EngineConnection) => void {
  const db = new PanelotDB();
  const storageGenerationReady = resetDatabase.then((shouldReset) =>
    shouldReset
      ? db
          .transaction('rw', db.tables, () => Promise.all(db.tables.map((table) => table.clear())))
          .then(() =>
            storageSet(chrome.storage.local, {
              [STORAGE_GENERATION_KEY]: STORAGE_GENERATION,
            }),
          )
      : undefined,
  );
  const sessionStateStorage: StorageAreaLike = {
    get: async (keys) => {
      await storageGenerationReady;
      return chrome.storage.session.get(keys);
    },
    set: async (items) => {
      await storageGenerationReady;
      await chrome.storage.session.set(items);
    },
    remove: async (keys) => {
      await storageGenerationReady;
      await chrome.storage.session.remove(keys);
    },
  };
  const maintenance = new DataImportCoordinator(db, {
    local: chrome.storage.local as StorageAreaLike,
    session: chrome.storage.session as StorageAreaLike,
    validator: new MaintenanceWorkerValidator(),
  });
  const reconciliationReady = storageGenerationReady.then(() => maintenance.reconcileStartup());
  const gateway = new BrowserToolGateway(sessionStateStorage, false);
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
  const notifyThread = (
    threadId: string,
    kind: 'approval' | 'recovery' | 'interaction',
    instanceId: string,
  ) => {
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
          : kind === 'interaction'
            ? 'A task is waiting for your input.'
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

  // Two-axis Gatekeeper (docs/development/permissions.md): the tool's level rides along so L2 forces
  // escalation and builtins are treated as origin-less.
  const gatekeeperService = new GatekeeperService(
    db,
    (threadId) => gateway.getTabOrigin(threadId),
    undefined,
    sessionStateStorage,
    false,
  );
  registerLifecycleHandlers({
    permissionRemoved: () => gatekeeperService.handleHostPermissionsRemoved(),
    tabRemoved: (tabId) => gateway.handleTabRemoved(tabId),
    tabReplaced: (addedTabId, removedTabId) => gateway.handleTabReplaced(addedTabId, removedTabId),
  });
  const toolLevels = new Map<string, string>();
  const gatekeeper: GatekeeperCheck = {
    check: (call, threadId) =>
      gatekeeperService.check({ ...call, level: toolLevels.get(call.toolName) }, threadId),
  };

  // Per-thread tool registry: browser tools bind to the thread's controlled
  // tabs; builtins are shared. Rebuilt per turn (cheap — definitions only).
  const registryFor = (threadId: string, snapshot?: RunEnvironmentSnapshot): ToolRegistry => {
    const registry = new ToolRegistry();
    const getThreadId = () => threadId;
    const add = (tool: AnyAgentTool) => {
      toolLevels.set(tool.name, tool.level);
      registry.register(tool);
    };
    for (const tool of createL0Tools(gateway, getThreadId)) add(tool);
    for (const tool of createBrowserDataTools()) add(tool);
    for (const tool of createL1Tools(gateway, getThreadId, {
      axTreeFallback: (tabId, signal, deadlineAt) => cdp.getAxTreeText(tabId, signal, deadlineAt),
      getTabId: (tid) => gateway.getTargetTab(tid),
      dispatchKey: (tabId, combo, signal, deadlineAt) => {
        // CDP keys are isTrusted — indistinguishable from user input in the
        // content script. Mark the window so the agent's own keystroke does
        // not trigger the manual-operation auto-pause.
        return cdp.dispatchKey(tabId, combo, signal, deadlineAt, () => {
          gateway.markAgentInput(tabId);
          gateway.markDriven(threadId, tabId);
        });
      },
      db, // oversized extract output offloads to the attachments table
    }))
      add(tool);
    for (const tool of createL2Tools(cdp, gateway, db, getThreadId)) add(tool);
    add(createFetchUrlTool());
    add(createArtifactTool(db, getThreadId));
    for (const tool of createInteractionTools((tabId) => gateway.getOperationTab(threadId, tabId)))
      add(tool);
    for (const tool of createMemoryTools(db)) add(tool);
    add(createDownloadTool());
    const skillSource = snapshot
      ? {
          getEnabled: async (name: string) => {
            const captured = snapshot.skillCatalog.find((skill) => skill.name === name);
            return captured
              ? {
                  id: captured.id,
                  name: captured.name,
                  raw: captured.body,
                  frontmatter: {
                    name: captured.name,
                    description: captured.description,
                    panelot: { sites: captured.sites },
                  },
                  body: captured.body,
                  enabled: true,
                  source: 'user' as const,
                  createdAt: snapshot.capturedAt,
                  updatedAt: snapshot.capturedAt,
                }
              : null;
          },
        }
      : skills;
    add(createLoadSkillTool(skillSource, getThreadId));
    // MCP tools (mcp__{server}__{tool}) from connected servers (docs/development/mcp.md §4).
    for (const tool of mcp.buildTools(getThreadId)) add(tool);
    return registry;
  };
  const resolver = new SettingsProviderResolver(db);
  const attachmentCleanupReady = storageGenerationReady.then(cleanupOffscreenAttachments);
  const core = new RealEngineCore(db, registryFor, gatekeeper, resolver, async (browserContext) => {
    const settings = await SettingsStore.global.get();
    const submittedTab = browserContext?.defaultTab;
    const contextUrls = [
      submittedTab?.url,
      ...(browserContext?.referencedTabs.map((tab) => tab.url) ?? []),
    ].filter((url, index, urls): url is string => !!url && urls.indexOf(url) === index);
    const [sitePrompts, pluginSitePrompts] = await Promise.all([
      SettingsStore.sitePrompts.get(),
      listEnabledPluginSiteInstructions(db),
    ]);
    const skillIndexes = await Promise.all(
      (contextUrls.length > 0 ? contextUrls : [undefined]).map((url) => skills.buildIndex(url)),
    );
    return {
      userGlobalPrompt: settings.userGlobalPrompt,
      sitePrompts: contextUrls.length
        ? [...sitePrompts, ...pluginSitePrompts].filter((entry) =>
            contextUrls.some((url) => siteInstructionMatches(entry.pattern, url)),
          )
        : [],
      skillsIndex: [
        ...new Map(skillIndexes.flat().map((entry) => [entry.name, entry] as const)).values(),
      ],
      environment: {
        date: new Date().toISOString().slice(0, 10),
        language: settings.language ?? 'zh-CN',
        activeTab:
          submittedTab?.url && submittedTab.title
            ? { tabId: submittedTab.tabId, url: submittedTab.url, title: submittedTab.title }
            : undefined,
      },
    };
  });
  const interactionAutomation = new InteractionAutomation(gateway, (interactionId, response) =>
    core.resolveInteraction(interactionId, response),
  );
  core.onInteractionResolved = (interactionId) => {
    interactionAutomation.clear(interactionId);
  };

  // Rebuild the tool registry when MCP servers connect/disconnect (list_changed).
  mcp.onToolsChanged = () => {
    /* per-turn registryFor rebuilds from mcp.buildTools() */
  };
  const mcpStartupReady = storageGenerationReady.then(() => mcp.ensureConnected('startup'));
  core.onBeforeRun = () => mcp.ensureConnected('use');
  core.onTurnBrowserContext = (threadId, browserContext) =>
    gateway.bindTurnTarget(threadId, browserContext?.defaultTab?.tabId);
  core.onValidateRecoveredTool = async (threadId, pendingTool, _environment) => {
    await gateway.bindRecoveredTarget(
      threadId,
      pendingTool.toolName === 'navigate'
        ? { ...pendingTool.target, origin: undefined }
        : pendingTool.target,
    );
    const verdict = await gatekeeperService.check(
      {
        toolName: pendingTool.toolName,
        params: pendingTool.params,
        effects: pendingTool.effect,
        level: toolLevels.get(pendingTool.toolName),
        target: pendingTool.target,
      },
      threadId,
    );
    if (
      verdict.verdict === 'deny' ||
      (verdict.verdict === 'ask' && verdict.request.flags.includes('host_permission'))
    ) {
      throw new Error('Recovered tool authorization is no longer valid.');
    }
  };
  core.onApprovalDecision = (approvalId, threadId, tool, origin, decision) =>
    gatekeeperService.applyDecision(approvalId, threadId, tool, origin, decision);
  // Composer permission switch → per-thread gatekeeper config (docs/development/permissions.md §1).
  core.onPermissionOverride = (threadId, config) =>
    gatekeeperService.setThreadConfig(threadId, config);
  // "/skill-name …" activates the skill for the turn (docs/development/skills-plugins.md §4): the body
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

  // Persisted initialization distinguishes an intentional deletion from a
  // profile that has never received the shipped run_javascript default.
  const gatekeeperDefaultsReady = GatekeeperService.seedDefaultRules();

  const recoveryReady = Promise.all([
    reconciliationReady,
    attachmentCleanupReady,
    mcpStartupReady,
    gatekeeperDefaultsReady,
    gatekeeperService.ready(),
    gateway.ready(),
  ])
    .then(() => core.recover())
    .catch(() => {
      throw new Error('Background initialization failed');
    });
  const host = new EngineHost(core, recoveryReady, {
    startupRecoveryTimeoutMs: 20_000,
    streamEpoch: reconciliationReady.then(() =>
      allocateEngineStreamEpoch().catch(() => {
        throw new Error('Background initialization failed');
      }),
    ),
    isAdmissionBlocked: () => maintenance.isAdmissionBlocked(),
  });
  maintenance.setRuntimeHooks({
    activeThreadIds: () => host.activeThreadIds(),
    waitForAdmissionIdle: () => host.waitForAdmissionIdle(),
  });
  core.onBroadcast = (ev) => {
    // A call without tabId locks its fallback for one turn so a user tab switch
    // cannot redirect an in-flight sequence. Explicit tabId calls bypass it.
    if (ev.type === 'turn.complete') gateway.releaseFloatingTarget(ev.threadId);
    if (ev.type === 'approval.request') {
      notifyThread(ev.threadId, 'approval', ev.approvalId);
    } else if (ev.type === 'interaction.request') {
      interactionAutomation.handle(ev.threadId, ev.interactionId, ev.request);
      if (
        ev.request.kind === 'ask_user' ||
        ev.request.kind === 'user_action' ||
        ev.request.kind === 'mcp_elicitation'
      ) {
        notifyThread(ev.threadId, 'interaction', ev.interactionId);
      }
    } else if (ev.type === 'run.recovery_required') {
      notifyThread(ev.threadId, 'recovery', ev.run.runId);
    } else if (ev.type === 'turn.complete') {
      clearThreadNotifications(ev.threadId);
    }
    host.broadcast(ev);
  };
  registerRuntimeMessageHandler((message: unknown, sender, sendResponse) => {
    if ((message as { type?: unknown })?.type !== DATA_IMPORT_RPC_TYPE) return false;
    void (async () => {
      const request = parseDataImportRpcRequest(message);
      if (
        !request ||
        !isTrustedDataImportSender(sender, chrome.runtime.id, chrome.runtime.getURL('/'))
      ) {
        sendResponse({
          ok: false,
          error: '无效或未授权的数据维护请求',
        } satisfies DataImportRpcResponse);
        return;
      }
      let result:
        DataImportMaintenanceStatus | DataImportCoordinatorPreview | DataImportCommitResult;
      if (request.action === 'status') {
        result = { ...(await maintenance.status()), reconciliation: await reconciliationReady };
      } else if (request.action === 'preview') {
        result = await maintenance.preview(request.input, request.operationId);
      } else if (request.action === 'commit') {
        result = await maintenance.commit(request);
      } else {
        throw new Error('Unsupported data import action');
      }
      sendResponse({ ok: true, result } satisfies DataImportRpcResponse);
    })().catch((error: unknown) =>
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      } satisfies DataImportRpcResponse),
    );
    return true;
  });
  // MCP OAuth trigger from the settings page (docs/development/mcp.md §3).
  registerRuntimeMessageHandler((message: unknown, sender, sendResponse) => {
    if ((message as { type?: unknown })?.type !== THREAD_RUNTIME_STATE_RPC_TYPE) return false;
    const request = parseClearThreadRuntimeStateRequest(message);
    if (!request || !isTrustedChatSender(sender, chrome.runtime.id, chrome.runtime.getURL('/'))) {
      sendResponse({
        ok: false,
        error: 'Invalid or unauthorized thread cleanup request.',
      } satisfies ClearThreadRuntimeStateResponse);
      return true;
    }
    gateway.clearThread(request.threadId);
    void Promise.all([gatekeeperService.clearSession(request.threadId), gateway.flushState()])
      .then(() => {
        clearThreadNotifications(request.threadId);
        sendResponse({ ok: true } satisfies ClearThreadRuntimeStateResponse);
      })
      .catch((error: unknown) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        } satisfies ClearThreadRuntimeStateResponse),
      );
    return true;
  });
  registerRuntimeMessageHandler((msg: unknown, _sender, sendResponse) => {
    const type = (msg as { type?: unknown })?.type;
    if (type === 'panelot.mcpWorkerElicitation') {
      const request = msg as {
        serverId?: unknown;
        message?: unknown;
        requestedSchema?: unknown;
        context?: { threadId?: unknown; itemId?: unknown };
      };
      if (
        typeof request.serverId !== 'string' ||
        typeof request.message !== 'string' ||
        !request.requestedSchema ||
        typeof request.requestedSchema !== 'object' ||
        typeof request.context?.threadId !== 'string' ||
        typeof request.context.itemId !== 'string'
      ) {
        sendResponse({ action: 'decline' });
        return true;
      }
      void core
        .requestMcpElicitation(request.context.threadId, request.context.itemId, {
          kind: 'mcp_elicitation',
          serverId: request.serverId,
          message: request.message,
          requestedSchema: request.requestedSchema as Record<string, unknown>,
        })
        .then((response) => {
          if (
            response.kind === 'submit' &&
            response.value &&
            typeof response.value === 'object' &&
            !Array.isArray(response.value)
          ) {
            sendResponse({ action: 'accept', content: response.value });
          } else {
            sendResponse({ action: response.kind === 'cancel' ? 'cancel' : 'decline' });
          }
        })
        .catch(() => sendResponse({ action: 'decline' }));
      return true;
    }
    if (typeof type !== 'string' || !type.startsWith('panelot.mcp')) return false;
    handleMcpRuntimeMessage(mcp, msg, sendResponse);
    return true;
  });

  // Touched-tab audit state is broadcast so UI clients can stay consistent
  // across service-worker restarts and thread switches.
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
  void gateway
    .ready()
    .then(() => {
      for (const threadId of gateway.touchedThreadIds()) gateway.onTabsChanged(threadId);
    })
    .catch(() => {});

  // Manual operation → pause, but only when a real human-vs-agent conflict
  // exists (docs/development/browser-tools.md §5): the agent has written to that tab this turn, or a
  // pending or recovered approval is waiting on that exact tab. Read-only turns
  // never pause — the user scrolling their own page is not a conflict.
  gateway.onManualOperation = (tabId) => {
    for (const threadId of core.activeThreadIds()) {
      if (
        gateway.droveThisTurn(threadId, tabId) ||
        core.pendingApprovalTargetsTab(threadId, tabId) ||
        core.recoveredApprovalTargetsTab(threadId, tabId)
      ) {
        void core.pauseThread(
          threadId,
          '检测到你在页面上手动操作，任务已自动暂停。发送消息可继续。',
        );
      }
    }
  };

  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {
    /* older Chrome */
  });

  // Alt+P is the reserved _execute_action command (= toolbar-icon click):
  // with openPanelOnActionClick the browser toggles the side panel natively.
  // Never reimplement this with chrome.sidePanel.open() in an onCommand
  // handler — open() requires a synchronous user gesture, and any awaited
  // promise before it (windows.getCurrent) drops the gesture token, so the
  // call silently fails.

  // Keepalive for running turns with no UI connected (docs/development/architecture.md §4): a 30s alarm
  // wakes the SW to keep long background tasks progressing across idle gaps.
  chrome.alarms.create('panelot-keepalive', { periodInMinutes: 0.5 });
  chrome.alarms.create('panelot-quota', { periodInMinutes: 15 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name.startsWith('panelot-interaction:')) {
      interactionAutomation.handleAlarm(alarm.name);
      return;
    }
    if (alarm.name === 'panelot-quota') {
      // LRU-evict over-budget attachments, never touching a live thread (docs/development/data-model.md §6).
      const active = core.activeThreadIds()[0];
      void sendOffscreenWorkerCommand({
        type: 'panelot.offscreen.attachments.evict',
        ...(active ? { activeThreadId: active } : {}),
      }).catch(() => {});
    }
  });
  return (connection) => host.onConnection(connection);
}
