/**
 * Settings storage — chrome.storage.local wrappers for provider config,
 * presets, permission rules, UI preferences (docs/02 note: small config lives
 * in chrome.storage for cross-context change events, not Dexie).
 *
 * In test environments (no chrome global) an in-memory fallback is used.
 */

import type { Connection, ModelPreset, GenParams } from '../providers/types';

export interface GlobalSettings {
  /** Task model for titles/compaction/suggestions (docs/03 §1.5). */
  taskModel?: { connectionId: string; modelId: string };
  userGlobalPrompt?: string;
  language?: 'zh-CN' | 'en';
  theme?: 'system' | 'light' | 'dark';
  /** Default two-axis permission levels (docs/06 §1). */
  defaultApprovalPolicy?: string;
  defaultCapabilityScope?: string;
  /** Optional hard token budget per turn. */
  turnTokenBudget?: number;
}

const memoryStore = new Map<string, unknown>();

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
    return;
  }
  await chrome.storage.local.set({ [key]: value });
}

export function onStorageChange(key: string, cb: (value: unknown) => void): () => void {
  if (!hasChromeStorage()) return () => {};
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'local' && key in changes) cb(changes[key]!.newValue);
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
    set: (v: Connection[]) => storageSet('connections', v),
  },
  presets: {
    get: () => storageGet<ModelPreset[]>('model_presets', []),
    set: (v: ModelPreset[]) => storageSet('model_presets', v),
  },
  global: {
    get: () => storageGet<GlobalSettings>('global_settings', {}),
    set: (v: GlobalSettings) => storageSet('global_settings', v),
  },
  /** Per-thread param overrides layer onto preset params (docs/03 §1.4). */
  threadParams: {
    get: (threadId: string) => storageGet<GenParams>(`thread_params:${threadId}`, {}),
    set: (threadId: string, v: GenParams) => storageSet(`thread_params:${threadId}`, v),
  },
  /** Site-level instructions (docs/08 §6). */
  sitePrompts: {
    get: () => storageGet<{ pattern: string; prompt: string }[]>('site_prompts', []),
    set: (v: { pattern: string; prompt: string }[]) => storageSet('site_prompts', v),
  },
};
