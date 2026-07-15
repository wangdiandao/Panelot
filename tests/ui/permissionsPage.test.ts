import { describe, expect, it } from 'vitest';
import { DEFAULT_PERMISSION_POLICIES } from '../../src/ui/settings/PermissionsPage';
import {
  normalizePermissionPolicy,
  resolvePermissionPolicy,
} from '../../src/settings/permissionPolicy';
import { normalizeGlobalSettings } from '../../src/settings/store';

describe('browser default permission policy', () => {
  it('offers the three supported permission policies', () => {
    expect(DEFAULT_PERMISSION_POLICIES).toEqual(['always', 'untrusted', 'auto']);
  });

  it.each(['always', 'untrusted', 'auto'] as const)('keeps %s as the runtime policy', (policy) => {
    expect(normalizePermissionPolicy(policy)).toBe(policy);
  });

  it('migrates legacy settings into one canonical permission policy', () => {
    expect(normalizePermissionPolicy('auto', 'read-only')).toBe('always');
    expect(normalizePermissionPolicy('on-request', 'full')).toBe('untrusted');
    expect(normalizePermissionPolicy('never', 'full')).toBe('untrusted');
    expect(
      normalizeGlobalSettings({
        defaultApprovalPolicy: 'auto',
        defaultCapabilityScope: 'read-only',
      }),
    ).toEqual({ defaultPermissionPolicy: 'always' });
  });

  it('resolves the composer policy from override, preset, then global default', () => {
    expect(resolvePermissionPolicy({ global: { policy: 'auto' } })).toBe('auto');
    expect(
      resolvePermissionPolicy({
        preset: { policy: 'always' },
        global: { policy: 'auto' },
      }),
    ).toBe('always');
    expect(
      resolvePermissionPolicy({
        override: 'untrusted',
        preset: { policy: 'always' },
        global: { policy: 'auto' },
      }),
    ).toBe('untrusted');
  });
});
