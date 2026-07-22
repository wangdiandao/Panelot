/**
 * Settings storage — chrome.storage.local wrappers for provider config,
 * presets, permission rules, UI preferences (docs/development/data-model.md note: small config lives
 * in chrome.storage for cross-context change events, not Dexie).
 *
 * In test environments (no chrome global) an in-memory fallback is used.
 */

import type { Connection, ModelPreset, GenParams } from '../providers/types';
import type { PermissionPolicy } from '../messaging/protocol';
import { normalizeEndpointUrl } from '../security/endpointUrl';
import { normalizeModelPreset, upsertModelPreset, type LegacyModelPreset } from './presets';
import { normalizePermissionPolicy } from './permissionPolicy';

export interface GlobalSettings {
  /** Task model for titles/suggestions (docs/development/providers.md §1.5). */
  taskModel?: { connectionId: string; modelId: string };
  /** Global default chat model — used when a thread has no preset/override. */
  defaultModel?: { connectionId: string; modelId: string };
  userGlobalPrompt?: string;
  language?: 'zh-CN' | 'en';
  theme?: 'system' | 'light' | 'dark';
  /** Default browser permission policy (docs/development/permissions.md §1). */
  defaultPermissionPolicy?: PermissionPolicy;
  /** Optional hard token budget per turn. */
  turnTokenBudget?: number;
  /** Full-page thread sidebar width in px (user-resizable, docs/development/ui.md §3.1). */
  sidebarWidth?: number;
  /** Full-page thread sidebar collapsed to the icon rail. */
  sidebarCollapsed?: boolean;
  /** Collapsed time-group ids in the thread sidebar. */
  sidebarGroupsCollapsed?: string[];
}

export type LegacyGlobalSettings = GlobalSettings & {
  defaultApprovalPolicy?: string;
  defaultCapabilityScope?: string;
};

export function normalizeGlobalSettings(settings: LegacyGlobalSettings): GlobalSettings {
  const { defaultApprovalPolicy, defaultCapabilityScope, ...current } = settings;
  return {
    ...current,
    defaultPermissionPolicy:
      current.defaultPermissionPolicy ??
      normalizePermissionPolicy(defaultApprovalPolicy, defaultCapabilityScope),
  };
}

const memoryStore = new Map<string, unknown>();
const memoryListeners = new Map<string, Set<(value: unknown) => void>>();
const mutationQueues = new Map<string, Promise<void>>();

function hasChromeStorage(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.storage?.local;
}

export async function storageGet<T>(key: string, fallback: T): Promise<T> {
  if (!hasChromeStorage()) return (memoryStore.get(key) as T) ?? fallback;
  const result = await chrome.storage.local.get(key);
  return (result[key] as T) ?? fallback;
}

export async function storageSet(key: string, value: unknown): Promise<void> {
  if (!hasChromeStorage()) {
    memoryStore.set(key, value);
    for (const listener of memoryListeners.get(key) ?? []) listener(value);
    return;
  }
  await chrome.storage.local.set({ [key]: value });
}

async function withStorageMutationLock<T>(key: string, mutate: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (locks) return locks.request(`panelot:storage:${key}`, mutate);

  const previous = mutationQueues.get(key) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(mutate);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  mutationQueues.set(key, settled);
  void settled.then(() => {
    if (mutationQueues.get(key) === settled) mutationQueues.delete(key);
  });
  return result;
}

/** Serialize a read-modify-write across extension documents and the worker. */
export function storageUpdate<T>(
  key: string,
  fallback: T,
  update: (current: T) => T | Promise<T>,
): Promise<T> {
  return withStorageMutationLock(key, async () => {
    const next = await update(await storageGet(key, fallback));
    await storageSet(key, next);
    return next;
  });
}

export function storagePatch<T extends object>(
  key: string,
  fallback: T,
  patch: Partial<T>,
): Promise<T> {
  return storageUpdate(key, fallback, (current) => ({ ...current, ...patch }));
}

export function onStorageChange(key: string, cb: (value: unknown) => void): () => void {
  if (!hasChromeStorage()) {
    const listeners = memoryListeners.get(key) ?? new Set<(value: unknown) => void>();
    listeners.add(cb);
    memoryListeners.set(key, listeners);
    return () => {
      listeners.delete(cb);
      if (listeners.size === 0) memoryListeners.delete(key);
    };
  }
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    const change = changes[key];
    if (area === 'local' && change) cb(change.newValue);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

// ---------------------------------------------------------------------------
// Typed accessors
// ---------------------------------------------------------------------------

export const SettingsStore = {
  connections: {
    get: () => storageGet<Connection[]>('connections', []),
    set: (v: Connection[]) => {
      const validated = v.map((connection) => ({
        ...connection,
        baseUrl: normalizeEndpointUrl(connection.baseUrl, {
          label: 'Provider 端点 URL',
          stripTrailingSlashes: true,
        }),
      }));
      return storageSet('connections', validated);
    },
    upsert: (connection: Connection) =>
      storageUpdate<Connection[]>('connections', [], (connections) => {
        const validated = {
          ...connection,
          baseUrl: normalizeEndpointUrl(connection.baseUrl, {
            label: 'Provider 端点 URL',
            stripTrailingSlashes: true,
          }),
        };
        const found = connections.some((item) => item.id === connection.id);
        return found
          ? connections.map((item) => (item.id === connection.id ? validated : item))
          : [...connections, validated];
      }),
    remove: (connectionId: string) =>
      storageUpdate<Connection[]>('connections', [], (connections) =>
        connections.filter((connection) => connection.id !== connectionId),
      ),
  },
  presets: {
    get: async () => {
      const stored = await storageGet<LegacyModelPreset[]>('model_presets', []);
      const normalized = stored.map(normalizeModelPreset);
      if (
        stored.some(
          (preset) => 'defaultApprovalPolicy' in preset || 'defaultCapabilityScope' in preset,
        )
      ) {
        await storageSet('model_presets', normalized);
      }
      return normalized;
    },
    set: (v: ModelPreset[]) => storageSet('model_presets', v.map(normalizeModelPreset)),
    upsert: (preset: ModelPreset) =>
      storageUpdate<LegacyModelPreset[]>('model_presets', [], (presets) =>
        upsertModelPreset(presets.map(normalizeModelPreset), preset),
      ),
    remove: (presetId: string) =>
      storageUpdate<LegacyModelPreset[]>('model_presets', [], (presets) =>
        presets.filter((preset) => preset.id !== presetId),
      ),
  },
  global: {
    get: async () => {
      const stored = await storageGet<LegacyGlobalSettings>('global_settings', {});
      const normalized = normalizeGlobalSettings(stored);
      if ('defaultApprovalPolicy' in stored || 'defaultCapabilityScope' in stored) {
        await storageSet('global_settings', normalized);
      }
      return normalized;
    },
    set: (v: GlobalSettings) => storageSet('global_settings', normalizeGlobalSettings(v)),
    patch: (patch: Partial<GlobalSettings>) =>
      storageUpdate<LegacyGlobalSettings>('global_settings', {}, (current) =>
        normalizeGlobalSettings({ ...current, ...patch }),
      ),
  },
  /** Last model the user picked in the selector — new chats reuse it. */
  lastModel: {
    get: () => storageGet<{ connectionId: string; modelId: string } | null>('last_model', null),
    set: (v: { connectionId: string; modelId: string } | null) => storageSet('last_model', v),
  },
  /** Last real thread selected in the side panel, retained across browser restarts. */
  lastSidePanelThread: {
    get: () => storageGet<string | null>('last_side_panel_thread', null),
    set: (threadId: string) => storageSet('last_side_panel_thread', threadId),
  },
  /** Per-thread param overrides layer onto preset params (docs/development/providers.md §1.4). */
  threadParams: {
    get: (threadId: string) => storageGet<GenParams>(`thread_params:${threadId}`, {}),
    set: (threadId: string, v: GenParams) => storageSet(`thread_params:${threadId}`, v),
  },
  /** Site-level instructions (docs/development/skills-plugins.md §6). */
  sitePrompts: {
    get: () => storageGet<{ pattern: string; prompt: string }[]>('site_prompts', []),
    set: (v: { pattern: string; prompt: string }[]) => storageSet('site_prompts', v),
  },
  /**
   * Per-thread last-seen timestamps for the sidebar unread indicator.
   * UI-side map — deliberately NOT a ThreadMeta field (no DB migration).
   */
  threadSeen: {
    get: () => storageGet<Record<string, number>>('thread_seen', {}),
    set: (v: Record<string, number>) => storageSet('thread_seen', v),
    mark: (threadId: string, seenAt: number) =>
      storagePatch<Record<string, number>>('thread_seen', {}, { [threadId]: seenAt }),
  },
};
