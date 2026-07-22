import { describe, expect, it } from 'vitest';
import type { Connection } from '../../src/providers/types';
import { resolveProviderConfigurationState } from '../../src/ui/providerConfiguration';

function connection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: 'provider-1',
    name: 'Provider',
    kind: 'openai',
    baseUrl: 'https://provider.example.com/v1',
    apiKeys: [],
    enabled: true,
    ...overrides,
  };
}

describe('provider configuration state', () => {
  it('distinguishes storage loading from a hydrated fresh profile', () => {
    expect(resolveProviderConfigurationState(null, false)).toBe('loading');
    expect(resolveProviderConfigurationState(null, true)).toBe('missing');
    expect(resolveProviderConfigurationState([], true)).toBe('missing');
  });

  it('accepts enabled keyed and localhost connections', () => {
    expect(resolveProviderConfigurationState([connection({ apiKeys: ['sealed-key'] })], true)).toBe(
      'configured',
    );
    expect(
      resolveProviderConfigurationState(
        [connection({ baseUrl: 'http://localhost:11434/v1' })],
        true,
      ),
    ).toBe('configured');
  });

  it('rejects disabled connections and remote connections without a key', () => {
    expect(
      resolveProviderConfigurationState(
        [connection({ enabled: false, apiKeys: ['sealed-key'] })],
        true,
      ),
    ).toBe('missing');
    expect(resolveProviderConfigurationState([connection()], true)).toBe('missing');
  });
});
