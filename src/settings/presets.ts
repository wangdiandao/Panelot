import type { GenParams, ModelPreset } from '../providers/types';

function optionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function normalizeParams(params: GenParams | undefined): GenParams | undefined {
  if (!params) return undefined;
  if (params.temperature !== undefined && (params.temperature < 0 || params.temperature > 2)) {
    throw new Error('Temperature must be between 0 and 2.');
  }
  if (params.topP !== undefined && (params.topP < 0 || params.topP > 1)) {
    throw new Error('Top P must be between 0 and 1.');
  }
  if (
    params.maxTokens !== undefined &&
    (!Number.isInteger(params.maxTokens) || params.maxTokens <= 0)
  ) {
    throw new Error('Max tokens must be a positive integer.');
  }

  const normalized: GenParams = {};
  if (params.temperature !== undefined) normalized.temperature = params.temperature;
  if (params.topP !== undefined) normalized.topP = params.topP;
  if (params.maxTokens !== undefined) normalized.maxTokens = params.maxTokens;
  if (params.reasoningEffort !== undefined) normalized.reasoningEffort = params.reasoningEffort;
  const stopSequences = params.stopSequences?.map((value) => value.trim()).filter(Boolean);
  if (stopSequences?.length) normalized.stopSequences = [...new Set(stopSequences)];
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function normalizeModelPreset(preset: ModelPreset): ModelPreset {
  const name = preset.name.trim();
  const connectionId = preset.base.connectionId.trim();
  const modelId = preset.base.modelId.trim();
  if (!name) throw new Error('Preset name is required.');
  if (!connectionId || !modelId) throw new Error('A base model is required.');

  return {
    ...preset,
    name,
    icon: optionalText(preset.icon),
    base: { connectionId, modelId },
    systemPrompt: optionalText(preset.systemPrompt),
    params: normalizeParams(preset.params),
    enabledToolLevels: preset.enabledToolLevels
      ? [...new Set(preset.enabledToolLevels)]
      : undefined,
    skills: preset.skills ? [...new Set(preset.skills)] : undefined,
    promptVersion: optionalText(preset.promptVersion),
  };
}

export function upsertModelPreset(
  presets: readonly ModelPreset[],
  candidate: ModelPreset,
): ModelPreset[] {
  const normalized = normalizeModelPreset(candidate);
  const duplicate = presets.find(
    (preset) =>
      preset.id !== normalized.id &&
      preset.name.trim().localeCompare(normalized.name, undefined, { sensitivity: 'accent' }) === 0,
  );
  if (duplicate) throw new Error(`A preset named "${normalized.name}" already exists.`);
  const exists = presets.some((preset) => preset.id === normalized.id);
  return exists
    ? presets.map((preset) => (preset.id === normalized.id ? normalized : preset))
    : [...presets, normalized];
}
