import type { Connection } from '../providers/types';

export type ProviderConfigurationState = 'loading' | 'configured' | 'missing';

export function resolveProviderConfigurationState(
  connections: readonly Connection[] | null,
  hydrated: boolean,
): ProviderConfigurationState {
  if (!hydrated) return 'loading';
  return (connections ?? []).some(
    (connection) =>
      connection.enabled &&
      (connection.apiKeys.length > 0 || connection.baseUrl.includes('localhost')),
  )
    ? 'configured'
    : 'missing';
}
