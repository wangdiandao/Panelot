import { describe, expect, it } from 'vitest';
import {
  freezeInstallPlan,
  parsePluginManifest,
  type PluginInstallPlan,
} from '../../src/plugins/manifest';

describe('canonical plugin manifest', () => {
  it('accepts only the production plugin.json contract', () => {
    expect(
      parsePluginManifest({
        id: 'shopping-helper',
        name: 'Shopping Helper',
        version: '1.0.0',
        assets: [{ path: 'skills/compare/SKILL.md', kind: 'skill' }],
      }),
    ).toMatchObject({ id: 'shopping-helper', version: '1.0.0' });
    expect(() =>
      parsePluginManifest({
        name: 'old-schema',
        version: '1.0.0',
        mcpServers: {},
      }),
    ).toThrow(/unsupported|id/i);
  });

  it('rejects unsupported manifest and asset fields instead of hiding them', () => {
    expect(() =>
      parsePluginManifest({
        id: 'unsafe-plugin',
        name: 'Unsafe',
        version: '1.0.0',
        assets: [],
        rules: [{ verdict: 'allow' }],
      }),
    ).toThrow(/unsupported field: rules/i);
    expect(() =>
      parsePluginManifest({
        id: 'unsafe-plugin',
        name: 'Unsafe',
        version: '1.0.0',
        assets: [{ path: 'prompt.md', kind: 'other', execute: true }],
      }),
    ).toThrow(/unsupported field: execute/i);
  });

  it('deep-freezes install plans used by the confirmation boundary', () => {
    const plan = freezeInstallPlan({
      format: 'panelot-plugin-install-plan',
      digest: 'sha256:abc',
      analyzedAt: 1,
      expiresAt: 2,
      source: { kind: 'zip', label: 'plugin.zip' },
      operation: 'install',
      manifest: {
        id: 'example-plugin',
        name: 'Example',
        version: '1.0.0',
        assets: [{ path: 'prompt.md', kind: 'other' }],
      },
      assets: [],
      skills: [],
      presets: [],
      siteInstructions: [],
      warnings: [],
    } satisfies PluginInstallPlan);

    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.manifest)).toBe(true);
    expect(Object.isFrozen(plan.manifest.assets)).toBe(true);
    expect(Object.isFrozen(plan.manifest.assets[0])).toBe(true);
  });
});
