import type { PermissionPolicy } from '../messaging/protocol';

export function normalizePermissionPolicy(
  policy: string | undefined,
  legacyCapabilityScope?: string,
): PermissionPolicy | undefined {
  if (legacyCapabilityScope === 'read-only') return 'always';
  if (policy === 'always' || policy === 'untrusted' || policy === 'auto') return policy;
  return policy === undefined ? undefined : 'untrusted';
}

interface PermissionPolicyLayer {
  policy?: string;
  legacyCapabilityScope?: string;
}

export function resolvePermissionPolicy(options: {
  override?: string;
  preset?: PermissionPolicyLayer;
  global?: PermissionPolicyLayer;
}): PermissionPolicy {
  return (
    normalizePermissionPolicy(options.override) ??
    normalizePermissionPolicy(options.preset?.policy, options.preset?.legacyCapabilityScope) ??
    normalizePermissionPolicy(options.global?.policy, options.global?.legacyCapabilityScope) ??
    'untrusted'
  );
}
