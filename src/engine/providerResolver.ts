/**
 * Settings-backed ProviderResolver: thread → preset → connection → adapter
 * (docs/03 §1.3-1.5). Also resolves the task model for compaction/titles.
 */

import { PanelotDB } from '../db/schema';
import { createAdapter, inferCapabilities } from '../providers/registry';
import type { GenParams, ProviderAdapter } from '../providers/types';
import { mergeParams } from '../providers/types';
import { SettingsStore } from '../settings/store';
import type { ProviderResolver } from './core';
import type { TaskModelRef } from '../agent/compactionRunner';

const DEFAULT_CONTEXT_WINDOW = 128_000;

export class SettingsProviderResolver implements ProviderResolver {
  private adapterCache = new Map<string, ProviderAdapter>();

  constructor(private db: PanelotDB) {}

  private async adapterFor(connectionId: string): Promise<ProviderAdapter> {
    const connections = await SettingsStore.connections.get();
    const conn = connections.find((c) => c.id === connectionId && c.enabled);
    if (!conn) throw new Error(`connection ${connectionId} not found or disabled`);
    // Cache by id + key-count so key edits invalidate.
    const cacheKey = `${conn.id}:${conn.apiKeys.length}:${conn.baseUrl}`;
    let adapter = this.adapterCache.get(cacheKey);
    if (!adapter) {
      adapter = createAdapter(conn);
      this.adapterCache.set(cacheKey, adapter);
    }
    return adapter;
  }

  async resolve(
    threadId: string,
    override?: { connectionId: string; modelId: string },
  ): Promise<{ provider: ProviderAdapter; model: string; params: GenParams; contextWindow: number }> {
    let connectionId: string;
    let modelId: string;
    let presetParams: GenParams | undefined;

    if (override) {
      ({ connectionId, modelId } = override);
    } else {
      const thread = await this.db.threads.get(threadId);
      const presets = await SettingsStore.presets.get();
      const preset = presets.find((p) => p.id === thread?.preset) ?? presets[0];
      if (!preset) {
        // No preset configured: fall back to the first enabled connection's first model.
        const connections = await SettingsStore.connections.get();
        const conn = connections.find((c) => c.enabled);
        if (!conn) throw new Error('no provider configured — add one in settings');
        connectionId = conn.id;
        const firstModel = conn.modelIds?.[0];
        if (!firstModel) throw new Error('no model available on the configured connection');
        modelId = firstModel;
      } else {
        connectionId = preset.base.connectionId;
        modelId = preset.base.modelId;
        presetParams = preset.params;
      }
    }

    const provider = await this.adapterFor(connectionId);
    const threadParams = await SettingsStore.threadParams.get(threadId);
    const params = mergeParams(presetParams, threadParams);
    const contextWindow = inferCapabilities(modelId).maxContext ?? DEFAULT_CONTEXT_WINDOW;
    return { provider, model: modelId, params, contextWindow };
  }

  /** Task model (docs/03 §1.5) — falls back to the thread's main model. */
  async resolveTaskModel(fallbackThreadId: string): Promise<TaskModelRef> {
    const settings = await SettingsStore.global.get();
    if (settings.taskModel) {
      const provider = await this.adapterFor(settings.taskModel.connectionId);
      return { provider, model: settings.taskModel.modelId };
    }
    const main = await this.resolve(fallbackThreadId);
    return { provider: main.provider, model: main.model };
  }
}
