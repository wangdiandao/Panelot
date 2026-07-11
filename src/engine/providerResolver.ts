/**
 * Settings-backed ProviderResolver: thread → preset → connection → adapter
 * (docs/03 §1.3-1.5). Also resolves the task model for titles.
 */

import { PanelotDB } from '../db/schema';
import { createAdapter } from '../providers/registry';
import type { Connection, GenParams, ProviderAdapter } from '../providers/types';
import { mergeParams } from '../providers/types';
import { SettingsStore } from '../settings/store';
import { decryptHeaderValue, decryptSecret } from '../settings/crypto';
import type { ProviderResolver } from './core';
import { listEnabledPluginPresets } from '../plugins/assets';

export interface TaskModelRef {
  provider: ProviderAdapter;
  model: string;
}

export class SettingsProviderResolver implements ProviderResolver {
  private adapterCache = new Map<string, { fingerprint: string; adapter: ProviderAdapter }>();
  /** Models fetched from GET /models, per connection (SW-lifetime cache). */
  private modelListCache = new Map<string, string[]>();

  constructor(private db: PanelotDB) {}

  /**
   * Default model for a connection without a manual model list: fetch it
   * from the endpoint (the manual list is a fallback for endpoints WITHOUT
   * /models, not a requirement — docs/03 §1.2).
   */
  private async endpointDefaultModel(conn: Connection): Promise<string | undefined> {
    const cached = this.modelListCache.get(conn.id);
    if (cached) return cached[0];
    try {
      const adapter = await this.adapterFor(conn.id);
      if (!adapter.listModels) return undefined;
      const models = await adapter.listModels();
      if (models.length > 0) this.modelListCache.set(conn.id, models);
      return models[0];
    } catch {
      return undefined;
    }
  }

  /** Global default model, only if its connection still exists and is enabled. */
  private async usableDefaultModel(): Promise<
    { connectionId: string; modelId: string } | undefined
  > {
    const { defaultModel } = await SettingsStore.global.get();
    if (!defaultModel) return undefined;
    const connections = await SettingsStore.connections.get();
    const alive = connections.some((c) => c.id === defaultModel.connectionId && c.enabled);
    return alive ? defaultModel : undefined;
  }

  private async adapterFor(connectionId: string): Promise<ProviderAdapter> {
    const connections = await SettingsStore.connections.get();
    const conn = connections.find((c) => c.id === connectionId && c.enabled);
    if (!conn) throw new Error(`connection ${connectionId} not found or disabled`);
    // Decrypt keys at use time (stored AES-GCM obfuscated, docs §7).
    const decrypted = {
      ...conn,
      apiKeys: await Promise.all(conn.apiKeys.map((k) => decryptSecret(k))),
      customHeaders: conn.customHeaders
        ? Object.fromEntries(
            await Promise.all(
              Object.entries(conn.customHeaders).map(async ([name, value]) => [
                name,
                await decryptHeaderValue(conn.id, name, value),
              ]),
            ),
          )
        : undefined,
    };
    const fingerprint = stableConnectionFingerprint(conn);
    const cached = this.adapterCache.get(conn.id);
    let adapter = cached?.fingerprint === fingerprint ? cached.adapter : undefined;
    if (!adapter) {
      adapter = createAdapter(decrypted);
      this.adapterCache.set(conn.id, { fingerprint, adapter });
      this.modelListCache.delete(conn.id);
    }
    return adapter;
  }

  async resolve(
    threadId: string,
    override?: { connectionId: string; modelId: string },
  ): Promise<Awaited<ReturnType<ProviderResolver['resolve']>>> {
    let connectionId: string;
    let modelId: string;
    let presetParams: GenParams | undefined;
    const thread = await this.db.threads.get(threadId);
    const [userPresets, pluginPresets] = await Promise.all([
      SettingsStore.presets.get(),
      listEnabledPluginPresets(this.db),
    ]);
    const presets = [...userPresets, ...pluginPresets.map((asset) => asset.preset)];
    const threadPreset = presets.find((preset) => preset.id === thread?.preset);
    const globalDefault = threadPreset ? undefined : await this.usableDefaultModel();
    const preset = threadPreset ?? (globalDefault ? undefined : presets[0]);

    if (override) {
      ({ connectionId, modelId } = override);
      presetParams = preset?.params;
    } else {
      // Fallback chain: thread preset (exact match) → global default model →
      // first preset → first enabled connection's first model.
      if (globalDefault) {
        ({ connectionId, modelId } = globalDefault);
      } else if (!preset) {
        // Nothing configured: fall back to the first enabled connection's
        // first model — manual list first, then live GET /models.
        const connections = await SettingsStore.connections.get();
        const conn = connections.find((c) => c.enabled);
        if (!conn) throw new Error('no provider configured — add one in settings');
        connectionId = conn.id;
        const firstModel = conn.modelIds?.[0] ?? (await this.endpointDefaultModel(conn));
        if (!firstModel)
          throw new Error(
            'no model available on the configured connection — the endpoint has no /models list; add model ids manually in settings',
          );
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
    const connections = await SettingsStore.connections.get();
    const modelEntry = connections
      .find((connection) => connection.id === connectionId)
      ?.models?.find((model) => model.id === modelId);
    const globalSettings = await SettingsStore.global.get();
    return {
      provider,
      model: modelId,
      params,
      connectionId,
      presetId: preset?.id,
      presetPrompt: preset?.systemPrompt,
      enabledToolLevels: preset?.enabledToolLevels,
      approvalPolicy:
        preset?.defaultApprovalPolicy ?? asApprovalPolicy(globalSettings.defaultApprovalPolicy),
      capabilityScope:
        preset?.defaultCapabilityScope ?? asCapabilityScope(globalSettings.defaultCapabilityScope),
      activeSkills: [...(preset?.skills ?? [])],
      promptVersion: preset?.promptVersion ?? 'kernel',
      modelCapabilities: modelEntry?.capabilities,
      pricing: modelEntry?.pricing,
    };
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

function stableConnectionFingerprint(connection: Connection): string {
  const headers = connection.customHeaders
    ? Object.fromEntries(
        Object.entries(connection.customHeaders).sort(([a], [b]) => a.localeCompare(b)),
      )
    : undefined;
  return JSON.stringify({
    id: connection.id,
    kind: connection.kind,
    baseUrl: connection.baseUrl,
    apiKeys: connection.apiKeys,
    customHeaders: headers,
    prefixId: connection.prefixId,
    modelIds: connection.modelIds,
    models: connection.models,
    enabled: connection.enabled,
    quirks: connection.quirks,
  });
}

function asApprovalPolicy(
  value: string | undefined,
): import('../messaging/protocol').ApprovalPolicy | undefined {
  return value && ['always', 'untrusted', 'on-request', 'never', 'granular', 'auto'].includes(value)
    ? (value as import('../messaging/protocol').ApprovalPolicy)
    : undefined;
}

function asCapabilityScope(
  value: string | undefined,
): import('../messaging/protocol').CapabilityScope | undefined {
  return value && ['read-only', 'same-origin-write', 'cross-origin', 'full'].includes(value)
    ? (value as import('../messaging/protocol').CapabilityScope)
    : undefined;
}
