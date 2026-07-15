import { schema, type Infer } from '../agent/schema';

export const MAX_PLUGIN_FILES = 1_000;

export const PluginManifest = schema.object({
  id: schema.string({ pattern: /^[a-z0-9][a-z0-9._-]{1,63}$/ }),
  name: schema.string({ min: 1, max: 100 }),
  version: schema.string({ min: 1, max: 50 }),
  description: schema.optional(schema.string({ max: 500 })),
  assets: schema.array(
    schema.object({
      path: schema.string({ min: 1 }),
      kind: schema.enum(['skill', 'preset', 'site-instruction', 'other']),
    }),
    { max: MAX_PLUGIN_FILES },
  ),
});

export type PluginManifest = Infer<typeof PluginManifest>;
export type PluginAssetKind = PluginManifest['assets'][number]['kind'];

export type PluginInstallWarning =
  'prompt-assets-disabled' | 'upgrade-disables-plugin' | 'opaque-assets';

export interface PluginInstallSource {
  readonly kind: 'zip' | 'github';
  readonly label: string;
  readonly resolvedUrl?: string;
}

export interface PluginInstallAssetSummary {
  readonly path: string;
  readonly kind: PluginAssetKind;
  readonly mime: string;
  readonly bytes: number;
}

export interface PluginInstallSkillSummary {
  readonly path: string;
  readonly name: string;
  readonly description: string;
}

export interface PluginInstallPresetSummary {
  readonly path: string;
  readonly id: string;
  readonly name: string;
  readonly model: string;
  readonly systemPromptSummary?: string;
}

export interface PluginInstallSiteInstructionSummary {
  readonly path: string;
  readonly pattern: string;
  readonly instructionSummary: string;
}

export interface PluginInstallPlan {
  readonly format: 'panelot-plugin-install-plan';
  readonly digest: string;
  readonly analyzedAt: number;
  readonly expiresAt: number;
  readonly source: PluginInstallSource;
  readonly operation: 'install' | 'upgrade';
  readonly existing?: Readonly<{
    version: string;
    enabled: boolean;
  }>;
  readonly manifest: Readonly<{
    id: string;
    name: string;
    version: string;
    description?: string;
    assets: readonly Readonly<PluginManifest['assets'][number]>[];
  }>;
  readonly assets: readonly Readonly<PluginInstallAssetSummary>[];
  readonly skills: readonly Readonly<PluginInstallSkillSummary>[];
  readonly presets: readonly Readonly<PluginInstallPresetSummary>[];
  readonly siteInstructions: readonly Readonly<PluginInstallSiteInstructionSummary>[];
  readonly warnings: readonly PluginInstallWarning[];
}

export function parsePluginManifest(input: unknown): PluginManifest {
  assertExactObjectKeys(input, ['id', 'name', 'version', 'description', 'assets'], 'manifest');
  const candidate = input as { assets?: unknown };
  if (Array.isArray(candidate.assets)) {
    for (const [index, asset] of candidate.assets.entries()) {
      assertExactObjectKeys(asset, ['path', 'kind'], `manifest.assets[${index}]`);
    }
  }
  const manifest = schema.parse(PluginManifest, input);
  if (!manifest.name.trim()) throw new Error('Plugin name must not be blank');
  if (!manifest.version.trim()) throw new Error('Plugin version must not be blank');
  if (manifest.description !== undefined && !manifest.description.trim()) {
    throw new Error('Plugin description must not be blank');
  }
  return {
    ...manifest,
    name: manifest.name.trim(),
    version: manifest.version.trim(),
    description: manifest.description?.trim(),
    assets: manifest.assets.map((asset) => ({ ...asset })),
  };
}

export function freezeInstallPlan(plan: PluginInstallPlan): PluginInstallPlan {
  return deepFreeze(plan);
}

function assertExactObjectKeys(
  value: unknown,
  allowed: readonly string[],
  location: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Plugin ${location} must be an object`);
  }
  const supported = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !supported.has(key));
  if (unknown.length > 0) {
    throw new Error(`Plugin ${location} has unsupported field: ${unknown.join(', ')}`);
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
