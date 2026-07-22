/**
 * Settings-backed ProviderResolver: thread → preset → connection → adapter
 * (docs/development/providers.md §1.3-1.5). Also resolves the task model for titles.
 */

import { PanelotDB } from '../db/schema';
import { createAdapter } from '../providers/registry';
import type { Connection, GenParams, ProviderAdapter } from '../providers/types';
import { mergeParams } from '../providers/types';
import type { ProviderEnvironmentBinding } from '../db/types';
import { SettingsStore } from '../settings/store';
import { resolvePermissionPolicy } from '../settings/permissionPolicy';
import { decryptHeaderValue, decryptSecret } from '../settings/crypto';
import type { ProviderResolver } from './core';
import { listEnabledPluginPresets } from '../plugins/assets';
import { RunEnvironmentSnapshotError } from './runEnvironmentSnapshot';

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
   * /models, not a requirement — docs/development/providers.md §1.2).
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

  async captureEnvironmentBinding(connectionId: string): Promise<ProviderEnvironmentBinding> {
    const connections = await SettingsStore.connections.get();
    const connection = connections.find((candidate) => candidate.id === connectionId);
    if (!connection) throw new Error(`connection ${connectionId} not found`);
    const credentials: ProviderEnvironmentBinding['credentials'] = connection.apiKeys.map(
      (_value, slot) => ({ kind: 'api-key', connectionId, slot }),
    );
    for (const headerName of Object.keys(connection.customHeaders ?? {}).sort((a, b) =>
      a.localeCompare(b),
    )) {
      credentials.push({ kind: 'custom-header', connectionId, headerName });
    }
    return {
      kind: 'settings',
      connectionId,
      protocol: connection.kind,
      baseUrl: connection.baseUrl,
      quirks: structuredClone(connection.quirks),
      credentials,
    };
  }

  async resolveFromEnvironmentBinding(
    binding: ProviderEnvironmentBinding,
  ): Promise<ProviderAdapter> {
    if (binding.kind !== 'settings' || !binding.protocol || !binding.baseUrl) {
      throw new Error('unsupported provider environment binding');
    }
    const connections = await SettingsStore.connections.get();
    const current = connections.find((candidate) => candidate.id === binding.connectionId);
    if (!current || !current.enabled) {
      throw new Error(`connection ${binding.connectionId} not found or disabled`);
    }
    assertEnvironmentBindingUnchanged(current, binding);
    const keyReferences = binding.credentials
      .filter((reference) => reference.kind === 'api-key')
      .sort((left, right) => (left.slot ?? -1) - (right.slot ?? -1));
    const apiKeys = await Promise.all(
      keyReferences.map(async (reference) => {
        const encrypted = current.apiKeys[reference.slot ?? -1];
        if (encrypted === undefined)
          throw new Error('provider credential reference is unavailable');
        return decryptSecret(encrypted);
      }),
    );
    const headerReferences = binding.credentials.filter(
      (reference) => reference.kind === 'custom-header',
    );
    const customHeaders = headerReferences.length
      ? Object.fromEntries(
          await Promise.all(
            headerReferences.map(async (reference) => {
              const name = reference.headerName;
              if (!name) throw new Error('provider header credential reference is invalid');
              const encrypted = current.customHeaders?.[name];
              if (encrypted === undefined) {
                throw new Error('provider header credential reference is unavailable');
              }
              return [name, await decryptHeaderValue(binding.connectionId, name, encrypted)];
            }),
          ),
        )
      : undefined;
    return createAdapter({
      id: binding.connectionId,
      name: binding.connectionId,
      kind: binding.protocol,
      baseUrl: binding.baseUrl,
      apiKeys,
      customHeaders,
      enabled: true,
      quirks: structuredClone(binding.quirks),
    });
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
        if (!conn) throw new Error('No provider is configured. Add one in Settings.');
        connectionId = conn.id;
        const firstModel = conn.modelIds?.[0] ?? (await this.endpointDefaultModel(conn));
        if (!firstModel)
          throw new Error(
            'No model is available on the configured connection. The endpoint has no /models list; add model IDs manually in Settings.',
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
      permissionPolicy: resolvePermissionPolicy({
        preset: { policy: preset?.defaultPermissionPolicy },
        global: { policy: globalSettings.defaultPermissionPolicy },
      }),
      activeSkills: [...(preset?.skills ?? [])],
      promptVersion: preset?.promptVersion ?? 'kernel',
      modelCapabilities: modelEntry?.capabilities,
      pricing: modelEntry?.pricing,
    };
  }

  /** Task model (docs/development/providers.md §1.5) — falls back to the thread's main model. */
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

function assertEnvironmentBindingUnchanged(
  current: Connection,
  binding: ProviderEnvironmentBinding,
): void {
  const currentCredentials: ProviderEnvironmentBinding['credentials'] = current.apiKeys.map(
    (_value, slot) => ({ kind: 'api-key', connectionId: current.id, slot }),
  );
  for (const headerName of Object.keys(current.customHeaders ?? {}).sort((left, right) =>
    left.localeCompare(right),
  )) {
    currentCredentials.push({ kind: 'custom-header', connectionId: current.id, headerName });
  }
  const bindingCredentials = [...binding.credentials].sort((left, right) =>
    credentialIdentity(left).localeCompare(credentialIdentity(right)),
  );
  currentCredentials.sort((left, right) =>
    credentialIdentity(left).localeCompare(credentialIdentity(right)),
  );
  const unchanged =
    binding.kind === 'settings' &&
    binding.connectionId === current.id &&
    binding.protocol === current.kind &&
    binding.baseUrl === current.baseUrl &&
    stableQuirks(binding.quirks) === stableQuirks(current.quirks) &&
    bindingCredentials.length === currentCredentials.length &&
    bindingCredentials.every((reference, index) => {
      const currentReference = currentCredentials[index];
      return (
        currentReference !== undefined &&
        credentialIdentity(reference) === credentialIdentity(currentReference)
      );
    });
  if (!unchanged) {
    throw new RunEnvironmentSnapshotError(
      'environment_snapshot_invalid',
      'The provider transport or credential binding changed after this run started.',
    );
  }
}

function credentialIdentity(reference: ProviderEnvironmentBinding['credentials'][number]): string {
  return reference.kind === 'api-key'
    ? `${reference.kind}:${reference.connectionId}:${reference.slot ?? -1}`
    : `${reference.kind}:${reference.connectionId}:${reference.headerName ?? ''}`;
}

function stableQuirks(quirks: Connection['quirks']): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(quirks ?? {}).sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
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
