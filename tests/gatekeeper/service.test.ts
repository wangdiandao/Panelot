import { beforeEach, describe, expect, it, vi } from 'vitest';

const stored = vi.hoisted(() => new Map<string, unknown>());

vi.mock('../../src/settings/store', () => ({
  storageGet: vi.fn(async (key: string, fallback: unknown) => stored.get(key) ?? fallback),
  storageSet: vi.fn(async (key: string, value: unknown) => stored.set(key, value)),
}));

import { GatekeeperService } from '../../src/gatekeeper/service';

function makeDb(scopeOrigins: string[] = []) {
  const thread = {
    id: 'thread-1',
    scopeOrigins,
    revision: 2,
    updatedAt: 0,
  };
  return {
    thread,
    db: {
      threads: {
        get: vi.fn(async () => thread),
        update: vi.fn(async (_id: string, patch: Partial<typeof thread>) => {
          Object.assign(thread, patch);
          return 1;
        }),
      },
    },
  };
}

describe('GatekeeperService', () => {
  beforeEach(() => {
    stored.clear();
    vi.stubGlobal('chrome', undefined);
  });

  it('uses global defaults and keeps originless built-ins independent of the active page', async () => {
    stored.set('global_settings', {
      defaultApprovalPolicy: 'auto',
      defaultCapabilityScope: 'full',
    });
    const { db } = makeDb();
    const service = new GatekeeperService(db as never, async () => 'https://bank.example');

    await expect(
      service.check(
        { toolName: 'todo_write', params: {}, effects: 'write', level: 'builtin' },
        'thread-1',
      ),
    ).resolves.toMatchObject({ verdict: 'allow' });
  });

  it('applies thread overrides and clears session grants', async () => {
    const { db } = makeDb(['https://example.com']);
    const service = new GatekeeperService(db as never, async () => 'https://example.com');
    service.setThreadConfig('thread-1', { approvalPolicy: 'untrusted' });
    service.setThreadConfig('thread-1', { capabilityScope: 'full' });

    expect(service.getThreadConfig('thread-1')).toEqual({
      approvalPolicy: 'untrusted',
      capabilityScope: 'full',
    });
    await service.applyDecision('thread-1', 'click', 'https://example.com', {
      kind: 'acceptForSession',
    });
    await expect(
      service.check({ toolName: 'click', params: {}, effects: 'write' }, 'thread-1'),
    ).resolves.toMatchObject({ verdict: 'allow' });
    service.clearSession('thread-1');
    await expect(
      service.check({ toolName: 'click', params: {}, effects: 'write' }, 'thread-1'),
    ).resolves.toMatchObject({ verdict: 'ask' });
  });

  it('updates scope, persists site grants, and ignores rejected decisions', async () => {
    const { db, thread } = makeDb();
    const service = new GatekeeperService(db as never, async () => 'https://example.com');

    await service.applyDecision('thread-1', 'click', 'https://example.com', { kind: 'decline' });
    expect(thread.scopeOrigins).toEqual([]);
    await service.applyDecision('thread-1', 'click', 'https://example.com', {
      kind: 'acceptForSite',
    });

    expect(thread.scopeOrigins).toEqual(['https://example.com']);
    expect(stored.get('permission_rules')).toEqual([
      expect.objectContaining({
        tool: 'click',
        origin: 'https://example.com',
        verdict: 'allow',
        source: 'approval_persist',
      }),
    ]);
  });

  it('adds, lists, and removes configured rules', async () => {
    await GatekeeperService.addRule({
      tool: 'navigate',
      origin: 'https://example.com',
      verdict: 'ask',
      source: 'user_setting',
    });
    const [rule] = await GatekeeperService.listRules();
    expect(rule).toMatchObject({ tool: 'navigate', origin: 'https://example.com' });
    await GatekeeperService.removeRule(rule!.id);
    await expect(GatekeeperService.listRules()).resolves.toEqual([]);
  });

  it('adds host-permission context without requesting permission itself', async () => {
    vi.stubGlobal('chrome', { permissions: {} });
    const { db } = makeDb(['https://example.com']);
    const hostPermissions = {
      inspect: vi.fn(async () => ({ granted: false, origin: 'https://example.com/*' })),
    };
    const service = new GatekeeperService(
      db as never,
      async () => 'https://example.com',
      hostPermissions as never,
    );
    service.setThreadConfig('thread-1', { approvalPolicy: 'auto', capabilityScope: 'full' });

    await expect(
      service.check({ toolName: 'click', params: {}, effects: 'write' }, 'thread-1'),
    ).resolves.toMatchObject({
      verdict: 'ask',
      request: { targetOrigin: 'https://example.com/*', flags: ['host_permission'] },
    });
  });
});
