import type { PanelotDB } from '../db/schema';
import type { PluginAssetRecord } from '../db/types';
import type { ModelPreset } from '../providers/types';
import { normalizeModelPreset } from '../settings/presets';
import { normalizeSiteInstructions, type SiteInstruction } from '../settings/sitePrompts';

export interface PluginPresetAsset {
  pluginId: string;
  assetId: string;
  preset: ModelPreset;
}

export interface PluginSiteInstruction extends SiteInstruction {
  pluginId: string;
  assetId: string;
}

function parseJson(bytes: Uint8Array, path: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new Error(
      `Invalid JSON in plugin asset ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function parsePluginPresetAsset(
  bytes: Uint8Array,
  pluginId: string,
  assetId: string,
  path: string,
): PluginPresetAsset[] {
  const parsed = parseJson(bytes, path);
  const candidates = Array.isArray(parsed) ? parsed : [parsed];
  return candidates.map((candidate) => {
    if (typeof candidate !== 'object' || candidate === null) {
      throw new Error(`Plugin preset must be an object: ${path}`);
    }
    const preset = normalizeModelPreset(candidate as ModelPreset);
    return {
      pluginId,
      assetId,
      preset: { ...preset, id: `${pluginId}:${preset.id}` },
    };
  });
}

export function parsePluginSiteInstructionAsset(
  bytes: Uint8Array,
  pluginId: string,
  assetId: string,
  path: string,
): PluginSiteInstruction[] {
  const parsed = parseJson(bytes, path);
  const candidates: SiteInstruction[] = Array.isArray(parsed)
    ? (parsed as SiteInstruction[])
    : typeof parsed === 'object' && parsed !== null
      ? Object.entries(parsed as Record<string, unknown>).map(([pattern, prompt]) => {
          if (typeof prompt !== 'string')
            throw new Error(`Plugin site instruction must be text: ${path}`);
          return { pattern, prompt };
        })
      : [];
  if (candidates.length === 0) throw new Error(`Plugin site instruction asset is empty: ${path}`);
  return normalizeSiteInstructions(candidates).map((instruction) => ({
    ...instruction,
    pluginId,
    assetId,
  }));
}

async function enabledAssets(
  db: PanelotDB,
  kind: PluginAssetRecord['kind'],
): Promise<PluginAssetRecord[]> {
  const enabled = new Set(
    (await db.plugins.filter((plugin) => plugin.enabled).toArray()).map((plugin) => plugin.id),
  );
  return db.pluginAssets
    .filter((asset) => asset.kind === kind && enabled.has(asset.pluginId))
    .toArray();
}

export async function listEnabledPluginPresets(db: PanelotDB): Promise<PluginPresetAsset[]> {
  const result: PluginPresetAsset[] = [];
  for (const asset of await enabledAssets(db, 'preset')) {
    const bytes = new Uint8Array(await asset.bytes.arrayBuffer());
    result.push(...parsePluginPresetAsset(bytes, asset.pluginId, asset.id, asset.path));
  }
  return result;
}

export async function listEnabledPluginSiteInstructions(
  db: PanelotDB,
): Promise<PluginSiteInstruction[]> {
  const result: PluginSiteInstruction[] = [];
  for (const asset of await enabledAssets(db, 'site-instruction')) {
    const bytes = new Uint8Array(await asset.bytes.arrayBuffer());
    result.push(...parsePluginSiteInstructionAsset(bytes, asset.pluginId, asset.id, asset.path));
  }
  return result;
}
