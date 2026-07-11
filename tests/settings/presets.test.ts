import { describe, expect, it } from 'vitest';
import type { ModelPreset } from '../../src/providers/types';
import { upsertModelPreset } from '../../src/settings/presets';

function preset(patch: Partial<ModelPreset> = {}): ModelPreset {
  return {
    id: 'preset-a',
    name: 'Research',
    base: { connectionId: 'connection-a', modelId: 'model-a' },
    ...patch,
  };
}

describe('model preset validation', () => {
  it('normalizes text fields and removes unset generation parameters', () => {
    const result = upsertModelPreset(
      [],
      preset({
        name: '  Research  ',
        systemPrompt: '  verify sources  ',
        promptVersion: '  research-2026  ',
        params: { temperature: undefined, topP: 0.8, stopSequences: [' END ', ''] },
      }),
    );

    expect(result[0]).toEqual(
      expect.objectContaining({
        name: 'Research',
        systemPrompt: 'verify sources',
        promptVersion: 'research-2026',
        params: { topP: 0.8, stopSequences: ['END'] },
      }),
    );
  });

  it('rejects duplicate names and invalid model parameters', () => {
    const existing = [preset()];
    expect(() => upsertModelPreset(existing, preset({ id: 'preset-b' }))).toThrow(
      /already exists/i,
    );
    expect(() => upsertModelPreset([], preset({ params: { temperature: 2.1 } }))).toThrow(
      /temperature/i,
    );
    expect(() =>
      upsertModelPreset([], preset({ base: { connectionId: '', modelId: '' } })),
    ).toThrow(/model/i);
  });
});
