import { beforeEach, describe, expect, it, vi } from 'vitest';

const stored = vi.hoisted(() => new Map<string, unknown>());

vi.mock('../../src/settings/store', () => ({
  storageGet: vi.fn(async (key: string, fallback: unknown) => stored.get(key) ?? fallback),
  storageSet: vi.fn(async (key: string, value: unknown) => stored.set(key, value)),
  storageUpdate: vi.fn(
    async (
      key: string,
      fallback: unknown,
      update: (current: unknown) => unknown | Promise<unknown>,
    ) => {
      const next = await update(stored.get(key) ?? fallback);
      stored.set(key, next);
      return next;
    },
  ),
}));

import {
  GATEKEEPER_SESSION_MAX_THREADS,
  GATEKEEPER_SESSION_STATE_KEY,
  GatekeeperService,
} from '../../src/gatekeeper/service';

class MemorySessionStorage {
  readonly values = new Map<string, unknown>();
  failGet = false;
  failSet = false;

  async get(key: string): Promise<Record<string, unknown>> {
    if (this.failGet) throw new Error('get failed');
    return this.values.has(key) ? { [key]: this.values.get(key) } : {};
  }

  async set(items: Record<string, unknown>): Promise<void> {
    if (this.failSet) throw new Error('set failed');
    for (const [key, value] of Object.entries(items)) this.values.set(key, value);
  }

  async remove(key: string): Promise<void> {
    this.values.delete(key);
  }
}

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
      defaultPermissionPolicy: 'auto',
    });
    const { db } = makeDb();
    const service = new GatekeeperService(db as never, async () => 'https://bank.example');

    await expect(
      service.check(
        { toolName: 'load_skill', params: {}, effects: 'write', level: 'builtin' },
        'thread-1',
      ),
    ).resolves.toMatchObject({ verdict: 'allow' });
  });

  it('applies thread overrides and clears session grants', async () => {
    const { db } = makeDb(['https://example.com']);
    const service = new GatekeeperService(db as never, async () => 'https://example.com');
    service.setThreadConfig('thread-1', { permissionPolicy: 'untrusted' });

    expect(service.getThreadConfig('thread-1')).toEqual({
      permissionPolicy: 'untrusted',
    });
    await service.applyDecision('approval-session', 'thread-1', 'click', 'https://example.com', {
      kind: 'acceptForSession',
    });
    await expect(
      service.check({ toolName: 'click', params: {}, effects: 'write' }, 'thread-1'),
    ).resolves.toMatchObject({ verdict: 'allow' });
    await service.clearSession('thread-1');
    await expect(
      service.check({ toolName: 'click', params: {}, effects: 'write' }, 'thread-1'),
    ).resolves.toMatchObject({ verdict: 'ask' });
  });

  it('updates scope, persists site grants, and ignores rejected decisions', async () => {
    const { db, thread } = makeDb();
    const service = new GatekeeperService(db as never, async () => 'https://example.com');

    await service.applyDecision('approval-decline', 'thread-1', 'click', 'https://example.com', {
      kind: 'decline',
    });
    expect(thread.scopeOrigins).toEqual([]);
    await service.applyDecision('approval-site', 'thread-1', 'click', 'https://example.com', {
      kind: 'acceptForSite',
    });
    await service.applyDecision('approval-site', 'thread-1', 'click', 'https://example.com', {
      kind: 'acceptForSite',
    });

    expect(thread.scopeOrigins).toEqual(['https://example.com']);
    expect(stored.get('permission_rules')).toEqual([
      expect.objectContaining({
        tool: 'click',
        origin: 'https://example.com',
        verdict: 'allow',
        source: 'approval_persist',
        sourceApprovalId: 'approval-site',
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
    service.setThreadConfig('thread-1', { permissionPolicy: 'auto' });

    await expect(
      service.check({ toolName: 'click', params: {}, effects: 'write' }, 'thread-1'),
    ).resolves.toMatchObject({
      verdict: 'ask',
      request: { targetOrigin: 'https://example.com/*', flags: ['host_permission'] },
    });
  });

  it('revalidates host permission at dispatch even when the policy revision is unchanged', async () => {
    vi.stubGlobal('chrome', { permissions: {} });
    const { db } = makeDb(['https://example.com']);
    const inspect = vi
      .fn()
      .mockResolvedValueOnce({ granted: true, origin: 'https://example.com/*' })
      .mockResolvedValueOnce({ granted: false, origin: 'https://example.com/*' });
    const service = new GatekeeperService(db as never, async () => 'https://example.com', {
      inspect,
    } as never);
    service.setThreadConfig('thread-1', { permissionPolicy: 'untrusted' });
    const initial = await service.check(
      { toolName: 'click', params: {}, effects: 'write', phase: 'initial' },
      'thread-1',
    );
    expect(initial).toMatchObject({ verdict: 'ask' });
    if (initial.verdict !== 'ask') throw new Error('Expected initial approval request');

    await expect(
      service.check(
        {
          toolName: 'click',
          params: {},
          effects: 'write',
          phase: 'dispatch',
          approvedAuthorizationRevision: initial.authorizationRevision,
        },
        'thread-1',
      ),
    ).resolves.toMatchObject({
      verdict: 'ask',
      request: { flags: expect.arrayContaining(['host_permission']) },
    });
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it('finalizes an unchanged approval only after host permission is still granted', async () => {
    vi.stubGlobal('chrome', { permissions: {} });
    const { db } = makeDb(['https://example.com']);
    const inspect = vi.fn(async () => ({
      granted: true,
      origin: 'https://example.com/*',
    }));
    const service = new GatekeeperService(db as never, async () => 'https://example.com', {
      inspect,
    } as never);
    service.setThreadConfig('thread-1', { permissionPolicy: 'untrusted' });
    const initial = await service.check(
      { toolName: 'click', params: {}, effects: 'write', phase: 'initial' },
      'thread-1',
    );
    if (initial.verdict !== 'ask') throw new Error('Expected initial approval request');

    await expect(
      service.check(
        {
          toolName: 'click',
          params: {},
          effects: 'write',
          phase: 'dispatch',
          approvedAuthorizationRevision: initial.authorizationRevision,
        },
        'thread-1',
      ),
    ).resolves.toEqual({ verdict: 'allow' });
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it('keeps durable page watches inside the target origin permission boundary', async () => {
    vi.stubGlobal('chrome', { permissions: {} });
    const { db } = makeDb();
    const hostPermissions = {
      inspect: vi.fn(async () => ({ granted: false, origin: 'https://example.com/*' })),
    };
    const service = new GatekeeperService(
      db as never,
      async () => 'https://unrelated.test',
      hostPermissions as never,
    );
    service.setThreadConfig('thread-1', { permissionPolicy: 'auto' });

    await expect(
      service.check(
        {
          toolName: 'watch_page',
          params: { condition: 'text', value: 'Done' },
          effects: 'read',
          level: 'builtin',
          target: { origin: 'https://example.com' },
        },
        'thread-1',
      ),
    ).resolves.toMatchObject({
      verdict: 'ask',
      request: {
        targetOrigin: 'https://example.com/*',
        flags: ['host_permission'],
      },
    });
    expect(hostPermissions.inspect).toHaveBeenCalledWith('https://example.com');
  });

  it('restores acceptForSession grants in a new service worker instance', async () => {
    const session = new MemorySessionStorage();
    const { db } = makeDb(['https://example.com']);
    const first = new GatekeeperService(
      db as never,
      async () => 'https://example.com',
      undefined,
      session,
    );

    await first.applyDecision('approval-1', 'thread-1', 'click', 'https://example.com', {
      kind: 'acceptForSession',
    });
    await first.flushState();
    const second = new GatekeeperService(
      db as never,
      async () => 'https://example.com',
      undefined,
      session,
    );

    await expect(
      second.check({ toolName: 'click', params: {}, effects: 'write' }, 'thread-1'),
    ).resolves.toMatchObject({ verdict: 'allow' });
    expect(session.values.has(GATEKEEPER_SESSION_STATE_KEY)).toBe(true);
    expect(stored.has(GATEKEEPER_SESSION_STATE_KEY)).toBe(false);
  });

  it('keeps its persisted grant snapshot readable at the thread boundary', async () => {
    const session = new MemorySessionStorage();
    const { db } = makeDb(['https://example.com']);
    const first = new GatekeeperService(
      db as never,
      async () => 'https://example.com',
      undefined,
      session,
    );

    for (let index = 0; index <= GATEKEEPER_SESSION_MAX_THREADS; index++) {
      await first.applyDecision(
        `approval-${index}`,
        `thread-${index}`,
        'click',
        'https://example.com',
        { kind: 'acceptForSession' },
      );
    }
    await first.flushState();

    const state = session.values.get(GATEKEEPER_SESSION_STATE_KEY) as {
      grants: Array<[string, string[]]>;
    };
    expect(state.grants).toHaveLength(GATEKEEPER_SESSION_MAX_THREADS);
    expect(state.grants[0]?.[0]).toBe('thread-1');
    expect(state.grants.at(-1)?.[0]).toBe(`thread-${GATEKEEPER_SESSION_MAX_THREADS}`);

    const restored = new GatekeeperService(
      db as never,
      async () => 'https://example.com',
      undefined,
      session,
    );
    await expect(restored.ready()).resolves.toBeUndefined();
    await expect(
      restored.check({ toolName: 'click', params: {}, effects: 'write' }, 'thread-0'),
    ).resolves.toMatchObject({ verdict: 'ask' });
    await expect(
      restored.check(
        { toolName: 'click', params: {}, effects: 'write' },
        `thread-${GATEKEEPER_SESSION_MAX_THREADS}`,
      ),
    ).resolves.toMatchObject({ verdict: 'allow' });
  });

  it('does not restore grants after a deleted thread is cleared', async () => {
    const session = new MemorySessionStorage();
    const { db } = makeDb(['https://example.com']);
    const first = new GatekeeperService(
      db as never,
      async () => 'https://example.com',
      undefined,
      session,
    );
    await first.applyDecision('approval-1', 'thread-1', 'click', 'https://example.com', {
      kind: 'acceptForSession',
    });
    await first.clearSession('thread-1');
    await first.flushState();

    const restored = new GatekeeperService(
      db as never,
      async () => 'https://example.com',
      undefined,
      session,
    );
    await expect(
      restored.check({ toolName: 'click', params: {}, effects: 'write' }, 'thread-1'),
    ).resolves.toMatchObject({ verdict: 'ask' });
    expect(session.values.get(GATEKEEPER_SESSION_STATE_KEY)).toEqual({ version: 1, grants: [] });
  });

  it('serializes a grant mutation behind hydration without losing either grant', async () => {
    let releaseGet!: (value: Record<string, unknown>) => void;
    const values = new Map<string, unknown>();
    const session = {
      get: vi.fn(
        () =>
          new Promise<Record<string, unknown>>((resolve) => {
            releaseGet = resolve;
          }),
      ),
      set: vi.fn(async (items: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(items)) values.set(key, value);
      }),
      remove: vi.fn(async () => {}),
    };
    const { db } = makeDb(['https://example.com']);
    const service = new GatekeeperService(
      db as never,
      async () => 'https://example.com',
      undefined,
      session,
    );
    const applying = service.applyDecision(
      'approval-new',
      'thread-1',
      'click',
      'https://example.com',
      { kind: 'acceptForSession' },
    );

    releaseGet({
      [GATEKEEPER_SESSION_STATE_KEY]: {
        version: 1,
        grants: [['thread-1', ['type https://example.com']]],
      },
    });
    await applying;
    await service.flushState();

    expect(values.get(GATEKEEPER_SESSION_STATE_KEY)).toEqual({
      version: 1,
      grants: [['thread-1', ['click https://example.com', 'type https://example.com']]],
    });
  });

  it('clears temporary grants on permission removal and live-inspects revoked hosts', async () => {
    const removedListeners = new Set<() => void>();
    vi.stubGlobal('chrome', {
      permissions: {
        onRemoved: { addListener: (listener: () => void) => removedListeners.add(listener) },
      },
    });
    const session = new MemorySessionStorage();
    const { db } = makeDb(['https://example.com']);
    let granted = true;
    const hostPermissions = {
      inspect: vi.fn(async () => ({
        granted,
        origin: 'https://example.com',
        pattern: 'https://example.com/*',
      })),
    };
    const service = new GatekeeperService(
      db as never,
      async () => 'https://example.com',
      hostPermissions as never,
      session,
    );
    await service.applyDecision('approval-1', 'thread-1', 'click', 'https://example.com', {
      kind: 'acceptForSession',
    });
    await expect(
      service.check({ toolName: 'click', params: {}, effects: 'write' }, 'thread-1'),
    ).resolves.toMatchObject({ verdict: 'allow' });

    granted = false;
    for (const listener of removedListeners) listener();
    await service.flushState();

    await expect(
      service.check({ toolName: 'click', params: {}, effects: 'write' }, 'thread-1'),
    ).resolves.toMatchObject({
      verdict: 'ask',
      request: { flags: ['host_permission'] },
    });
    const restored = new GatekeeperService(
      db as never,
      async () => 'https://example.com',
      hostPermissions as never,
      session,
    );
    await expect(
      restored.check({ toolName: 'click', params: {}, effects: 'write' }, 'thread-1'),
    ).resolves.toMatchObject({ verdict: 'ask' });
  });

  it('keeps deny rules ahead of a restored grant', async () => {
    const session = new MemorySessionStorage();
    const { db } = makeDb(['https://example.com']);
    const service = new GatekeeperService(
      db as never,
      async () => 'https://example.com',
      undefined,
      session,
    );
    await service.applyDecision('approval-1', 'thread-1', 'click', 'https://example.com', {
      kind: 'acceptForSession',
    });
    stored.set('permission_rules', [
      {
        id: 'deny-1',
        tool: 'click',
        origin: 'https://example.com',
        verdict: 'deny',
        source: 'user_setting',
        createdAt: 1,
      },
    ]);
    await expect(
      service.check({ toolName: 'click', params: {}, effects: 'write' }, 'thread-1'),
    ).resolves.toMatchObject({ verdict: 'deny' });
  });

  it('fails closed when session storage cannot be read or written', async () => {
    const { db } = makeDb(['https://example.com']);
    const unreadable = new MemorySessionStorage();
    unreadable.failGet = true;
    const failedHydration = new GatekeeperService(
      db as never,
      async () => 'https://example.com',
      undefined,
      unreadable,
    );
    await expect(
      failedHydration.check({ toolName: 'click', params: {}, effects: 'write' }, 'thread-1'),
    ).rejects.toThrow(/session permission state is unavailable/i);

    const unwritable = new MemorySessionStorage();
    unwritable.failSet = true;
    const failedMutation = new GatekeeperService(
      db as never,
      async () => 'https://example.com',
      undefined,
      unwritable,
    );
    await expect(
      failedMutation.applyDecision('approval-1', 'thread-1', 'click', 'https://example.com', {
        kind: 'acceptForSession',
      }),
    ).rejects.toThrow(/set failed/);
    await expect(
      failedMutation.check({ toolName: 'click', params: {}, effects: 'write' }, 'thread-1'),
    ).rejects.toThrow(/session permission state is unavailable/i);
  });
});
