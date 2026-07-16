import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PanelotDB } from '../../src/db/schema';
import type { RunRecord, SkillRecord, ThreadNode } from '../../src/db/types';
import type { CanonicalImportPlan } from '../../src/data/importContract';
import { sealSecretWithRawKey } from '../../src/security/secretStore';
import type { StorageAreaLike } from '../../src/data/maintenanceTypes';
import {
  DATA_IMPORT_JOURNAL_KEY,
  DATA_IMPORT_LAST_COMPLETED_KEY,
  DataImportCoordinator,
} from '../../src/data/maintenanceCoordinator';
import { inProcessMaintenanceValidator } from '../../src/data/maintenanceValidator';

class MemoryStorage implements StorageAreaLike {
  readonly values = new Map<string, unknown>();
  mutations = 0;
  failSet: ((items: Record<string, unknown>) => boolean) | undefined;
  failRemove: ((keys: string[]) => boolean) | undefined;

  async get(keys: string | string[] | Record<string, unknown> | null = null) {
    const selected =
      keys === null
        ? [...this.values.keys()]
        : typeof keys === 'string'
          ? [keys]
          : Array.isArray(keys)
            ? keys
            : Object.keys(keys);
    return Object.fromEntries(
      selected.filter((key) => this.values.has(key)).map((key) => [key, this.values.get(key)]),
    );
  }

  async set(items: Record<string, unknown>) {
    if (this.failSet?.(items)) throw new Error('injected storage set failure');
    this.mutations += 1;
    for (const [key, value] of Object.entries(items)) this.values.set(key, structuredClone(value));
  }

  async remove(input: string | string[]) {
    const keys = typeof input === 'string' ? [input] : input;
    if (this.failRemove?.(keys)) throw new Error('injected storage remove failure');
    this.mutations += 1;
    for (const key of keys) this.values.delete(key);
  }

  async getBytesInUse() {
    return new TextEncoder().encode(JSON.stringify(Object.fromEntries(this.values))).byteLength;
  }
}

let serial = 0;
let db: PanelotDB;
let local: MemoryStorage;
let session: MemoryStorage;

beforeEach(() => {
  db = new PanelotDB(`maintenance-coordinator-${Date.now()}-${serial++}`);
  local = new MemoryStorage();
  session = new MemoryStorage();
});

describe('DataImportCoordinator', () => {
  it('commits once, preserves extension-owned assets, and finishes on a fresh worker', async () => {
    const plan = makePlan({ attachmentId: 'attachment-1' });
    const pluginSkill = makeSkill('Plugin skill', 'plugin');
    await db.skills.put(pluginSkill);
    await db.attachments.put({
      id: 'attachment-1',
      threadId: 'new-thread',
      createdAt: 1,
      kind: 'file',
      mime: 'text/plain',
      bytes: new Blob(['kept']),
      provenance: 'user',
      refs: { nodeIds: ['old-node'], runIds: ['old-run'] },
    });
    await db.interactions.put({
      id: 'old-interaction',
      threadId: 'old-thread',
      runId: 'old-run',
      turnId: 'old-turn',
      itemId: 'old-call',
      request: { kind: 'user_action', instruction: 'Old handoff' },
      status: 'resolved',
      response: { kind: 'cancel' },
      requestedAt: 1,
      respondedAt: 2,
    });
    local.values.set('thread_params:old', { temperature: 1 });
    local.values.set('unknown_future_key', { keep: true });
    session.values.set('engine_client_id:chat', 'old-client');
    session.values.set('engine_outbox:chat', [{ stale: true }]);
    session.values.set('draft:old', 'discard');
    session.values.set('draft:draft', 'keep');
    session.values.set('unknown_session', 'keep');
    const transaction = vi.spyOn(db, 'transaction');
    const coordinator = createCoordinator();
    const preview = await coordinator.preview(plan, 'operation-1');

    const result = await coordinator.commit({
      operationId: preview.operationId,
      input: plan,
      expectedDigest: preview.digest,
      settings: plan.settings,
      oauthAccessToClear: 0,
    });

    expect(result).toMatchObject({ status: 'committed', reloadRequired: true });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(coordinator.isAdmissionBlocked()).toBe(true);
    expect((await db.threads.toArray()).map((thread) => thread.id)).toEqual(['new-thread']);
    expect(await db.skills.get(pluginSkill.id)).toEqual(pluginSkill);
    expect((await db.attachments.get('attachment-1'))?.refs).toEqual({
      nodeIds: ['new-node'],
      runIds: [],
    });
    expect(await db.interactions.count()).toBe(0);
    expect(local.values.get(DATA_IMPORT_JOURNAL_KEY)).toMatchObject({ phase: 'db_committed' });
    expect(local.values.has('thread_params:old')).toBe(false);
    expect(local.values.get('unknown_future_key')).toEqual({ keep: true });

    await expect(createCoordinator().reconcileStartup()).resolves.toBe('rolled_forward');
    expect(local.values.has(DATA_IMPORT_JOURNAL_KEY)).toBe(false);
    expect(local.values.get(DATA_IMPORT_LAST_COMPLETED_KEY)).toMatchObject({
      operationId: 'operation-1',
    });
    expect(await db.maintenance.count()).toBe(0);
    expect(session.values.has('engine_client_id:chat')).toBe(false);
    expect(session.values.has('engine_outbox:chat')).toBe(false);
    expect(session.values.has('draft:old')).toBe(false);
    expect(session.values.get('draft:draft')).toBe('keep');
    expect(session.values.get('unknown_session')).toBe('keep');
  });

  it('blocks hard activity and requires explicit confirmation for dormant runs', async () => {
    const plan = makePlan();
    await db.runs.put(makeRun('streaming_model'));
    const coordinator = createCoordinator(['active-thread']);
    let preview = await coordinator.preview(plan, 'blocked-operation');
    expect(preview.blockers).toMatchObject({ hardBlocked: true });
    await expect(
      coordinator.commit({
        operationId: preview.operationId,
        input: plan,
        expectedDigest: preview.digest,
        settings: plan.settings,
        oauthAccessToClear: 0,
      }),
    ).resolves.toMatchObject({ status: 'blocked' });
    expect(local.values.has(DATA_IMPORT_JOURNAL_KEY)).toBe(false);

    await db.runs.clear();
    await db.runs.put(makeRun('queued'));
    const dormant = createCoordinator();
    preview = await dormant.preview(plan, 'dormant-operation');
    expect(preview.blockers).toMatchObject({
      hardBlocked: false,
      requiresDormantConfirmation: true,
    });
    await expect(
      dormant.commit({
        operationId: preview.operationId,
        input: plan,
        expectedDigest: preview.digest,
        settings: plan.settings,
        oauthAccessToClear: 0,
      }),
    ).resolves.toMatchObject({ status: 'blocked' });
    await expect(
      dormant.commit({
        operationId: preview.operationId,
        input: plan,
        expectedDigest: preview.digest,
        settings: plan.settings,
        oauthAccessToClear: 0,
        confirmDiscardDormant: true,
      }),
    ).resolves.toMatchObject({ status: 'committed' });

    await db.runs.clear();
    await db.approvals.put({
      id: 'approval',
      threadId: 'old-thread',
      runId: 'old-run',
      turnId: 'old-turn',
      request: { tool: 'click', label: 'Click', params: {}, targetOrigin: '', flags: [] },
      status: 'pending',
      requestedAt: 1,
    });
    const approvalBlocked = createCoordinator();
    const approvalPreview = await approvalBlocked.preview(plan, 'approval-operation');
    expect(approvalPreview.blockers).toMatchObject({ hardBlocked: true, pendingApprovals: 1 });

    await db.approvals.clear();
    await db.interactions.put({
      id: 'interaction',
      threadId: 'old-thread',
      runId: 'old-run',
      turnId: 'old-turn',
      itemId: 'call',
      request: {
        kind: 'ask_user',
        questions: [{ id: 'choice', question: 'Choose one' }],
      },
      status: 'pending',
      requestedAt: 1,
    });
    const interactionBlocked = createCoordinator();
    const interactionPreview = await interactionBlocked.preview(plan, 'interaction-operation');
    expect(interactionPreview.blockers).toMatchObject({
      hardBlocked: true,
      pendingInteractions: 1,
    });
  });

  it.each([
    [
      'unsafe Provider endpoint',
      (plan: CanonicalImportPlan) => {
        plan.settings.connections = [
          {
            id: 'provider',
            name: 'Provider',
            kind: 'openai',
            baseUrl: 'javascript:alert(1)',
            apiKeys: [],
            enabled: true,
          },
        ];
      },
    ],
    [
      'unsafe MCP endpoint',
      (plan: CanonicalImportPlan) => {
        plan.settings.mcp_servers = [
          {
            id: 'mcp',
            name: 'MCP',
            url: 'https://user:pass@mcp.example/mcp',
            auth: { kind: 'none' },
            enabled: true,
            disabledTools: [],
            connectOnStartup: false,
          },
        ];
      },
    ],
    [
      'incomplete thread',
      (plan: CanonicalImportPlan) => {
        delete (plan.threads[0] as unknown as Record<string, unknown>).tags;
      },
    ],
    [
      'invalid node payload',
      (plan: CanonicalImportPlan) => {
        plan.nodes[0] = {
          ...plan.nodes[0]!,
          type: 'assistant_message',
          payload: { content: [] },
        } as unknown as ThreadNode;
      },
    ],
    [
      'tool call without params',
      (plan: CanonicalImportPlan) => {
        plan.nodes[0] = {
          ...plan.nodes[0]!,
          type: 'tool_call',
          payload: { itemId: 'tool', toolName: 'read_page', level: 'L0' },
        } as ThreadNode;
      },
    ],
    [
      'tool call with non-JSON params',
      (plan: CanonicalImportPlan) => {
        plan.nodes[0] = {
          ...plan.nodes[0]!,
          type: 'tool_call',
          payload: {
            itemId: 'tool',
            toolName: 'read_page',
            params: { omittedByJson: undefined },
            level: 'L0',
          },
        } as ThreadNode;
      },
    ],
    [
      'approval request without params',
      (plan: CanonicalImportPlan) => {
        plan.nodes[0] = {
          ...plan.nodes[0]!,
          type: 'approval_decision',
          payload: {
            approvalId: 'approval',
            request: { tool: 'click', label: 'Click', targetOrigin: '', flags: [] },
            decision: { kind: 'decline' },
            decidedAt: 1,
          },
        } as unknown as ThreadNode;
      },
    ],
    [
      'approval request with non-JSON params',
      (plan: CanonicalImportPlan) => {
        plan.nodes[0] = {
          ...plan.nodes[0]!,
          type: 'approval_decision',
          payload: {
            approvalId: 'approval',
            request: {
              tool: 'click',
              label: 'Click',
              params: { omittedByJson: undefined },
              targetOrigin: '',
              flags: [],
            },
            decision: { kind: 'decline' },
            decidedAt: 1,
          },
        } as ThreadNode;
      },
    ],
    [
      'invalid memory',
      (plan: CanonicalImportPlan) => {
        plan.memories = [{ id: 'memory', key: 'key', updatedAt: 1 } as never];
      },
    ],
    [
      'invalid skill contract',
      (plan: CanonicalImportPlan) => {
        plan.skills = [
          {
            ...makeSkill('imported-skill', 'imported'),
            frontmatter: { name: 'other', description: 'other' },
          },
        ];
      },
    ],
    [
      'skill raw frontmatter drift',
      (plan: CanonicalImportPlan) => {
        const skill = makeSkill('imported-skill', 'imported');
        skill.raw = skill.raw.replace(
          'description: imported-skill',
          'description: different-description',
        );
        plan.skills = [skill];
      },
    ],
    [
      'invalid thread timestamps',
      (plan: CanonicalImportPlan) => {
        plan.threads[0]!.createdAt = 3;
        plan.threads[0]!.updatedAt = 2;
      },
    ],
    [
      'invalid tree ordering',
      (plan: CanonicalImportPlan) => {
        plan.nodes.push({
          ...plan.nodes[0]!,
          id: 'child',
          parentId: plan.nodes[0]!.id,
          seq: 0,
        });
      },
    ],
    [
      'thread parent self-reference',
      (plan: CanonicalImportPlan) => {
        plan.threads[0]!.parentThreadId = plan.threads[0]!.id;
      },
    ],
    [
      'missing thread parent',
      (plan: CanonicalImportPlan) => {
        plan.threads[0]!.parentThreadId = 'missing-thread';
      },
    ],
    [
      'thread parent cycle',
      (plan: CanonicalImportPlan) => {
        plan.threads[0]!.parentThreadId = 'parent-thread';
        plan.threads.push({
          ...structuredClone(plan.threads[0]!),
          id: 'parent-thread',
          parentThreadId: plan.threads[0]!.id,
          leafId: null,
        });
      },
    ],
    [
      'non-empty thread without leaf',
      (plan: CanonicalImportPlan) => {
        plan.threads[0]!.leafId = null;
      },
    ],
    [
      'thread with multiple roots',
      (plan: CanonicalImportPlan) => {
        plan.nodes.push({
          ...plan.nodes[0]!,
          id: 'second-root',
          seq: 1,
        });
      },
    ],
  ] as const)('rejects %s before journal, storage, or Dexie mutation', async (_name, corrupt) => {
    const plan = makePlan();
    corrupt(plan);
    await db.threads.put({
      ...makePlan().threads[0]!,
      id: 'preserved-thread',
      leafId: null,
    });
    const transaction = vi.spyOn(db, 'transaction');

    await expect(
      createCoordinator().commit({
        operationId: 'malformed-operation',
        input: plan,
        expectedDigest: 'not-reached',
        settings: plan.settings,
        oauthAccessToClear: 0,
      }),
    ).rejects.toThrow();

    expect(local.mutations).toBe(0);
    expect(transaction).not.toHaveBeenCalled();
    expect((await db.threads.toArray()).map((thread) => thread.id)).toEqual(['preserved-thread']);
    expect(await db.maintenance.count()).toBe(0);
  });

  it('authenticates every sealed secret against its exact purpose before any write', async () => {
    const plan = makePlan();
    const connection = {
      id: 'provider',
      name: 'Provider',
      kind: 'openai' as const,
      baseUrl: 'https://provider.example/v1',
      apiKeys: [],
      enabled: true,
    };
    plan.settings.connections = [connection];
    const preview = await createCoordinator().preview(plan, 'wrong-purpose');
    const rawKey = Array.from({ length: 32 }, (_, index) => index);
    const sealed = await sealSecretWithRawKey('secret', 'mcp:wrong:bearer', rawKey);
    const transaction = vi.spyOn(db, 'transaction');

    await expect(
      createCoordinator().commit({
        operationId: preview.operationId,
        input: plan,
        expectedDigest: preview.digest,
        settings: { ...plan.settings, connections: [{ ...connection, apiKeys: [sealed] }] },
        localSecretKey: rawKey,
        oauthAccessToClear: 0,
      }),
    ).rejects.toThrow('IMPORT_SECRET_AUTH');

    expect(local.mutations).toBe(0);
    expect(transaction).not.toHaveBeenCalled();
    expect(await db.maintenance.count()).toBe(0);
  });

  it('restores the exact settings and key preimage when settings application fails', async () => {
    const plan = makePlan();
    const connection = {
      id: 'provider',
      name: 'Provider',
      kind: 'openai' as const,
      baseUrl: 'https://provider.example/v1',
      apiKeys: [],
      enabled: true,
    };
    plan.settings.connections = [connection];
    local.values.set('global_settings', { language: 'en' });
    local.values.set('thread_params:old', { topP: 0.5 });
    local.failRemove = (keys) => keys.includes('global_settings');
    const coordinator = createCoordinator();
    const preview = await coordinator.preview(plan, 'rollback-operation');
    const rawKey = Array.from({ length: 32 }, (_, index) => index);
    const sealed = await sealSecretWithRawKey('secret', 'provider-key', rawKey);

    await expect(
      coordinator.commit({
        operationId: preview.operationId,
        input: plan,
        expectedDigest: preview.digest,
        settings: {
          ...plan.settings,
          connections: [{ ...connection, apiKeys: [sealed] }],
        },
        oauthAccessToClear: 0,
        localSecretKey: rawKey,
      }),
    ).rejects.toThrow('injected storage remove failure');

    expect(local.values.get('global_settings')).toEqual({ language: 'en' });
    expect(local.values.get('thread_params:old')).toEqual({ topP: 0.5 });
    expect(local.values.has('panelot_local_secret_key')).toBe(false);
    expect(local.values.has(DATA_IMPORT_JOURNAL_KEY)).toBe(false);
    expect(await db.maintenance.count()).toBe(0);
  });

  it('rolls a committed database forward after a journal phase failure', async () => {
    const plan = makePlan();
    const coordinator = createCoordinator();
    const preview = await coordinator.preview(plan, 'marker-operation');
    local.failSet = (items) =>
      (items[DATA_IMPORT_JOURNAL_KEY] as { phase?: string } | undefined)?.phase === 'db_committed';

    await expect(
      coordinator.commit({
        operationId: preview.operationId,
        input: plan,
        expectedDigest: preview.digest,
        settings: plan.settings,
        oauthAccessToClear: 0,
      }),
    ).rejects.toThrow('IMPORT_COMMITTED_RELOAD');
    expect(coordinator.isAdmissionBlocked()).toBe(true);
    expect(await db.maintenance.get('data-import')).toMatchObject({
      operationId: 'marker-operation',
    });

    local.failSet = undefined;
    await expect(createCoordinator().reconcileStartup()).resolves.toBe('rolled_forward');
    expect(await db.maintenance.count()).toBe(0);
    expect(local.values.has(DATA_IMPORT_JOURNAL_KEY)).toBe(false);
  });

  it('rolls settings_applied startup state back when no database marker exists', async () => {
    local.values.set('global_settings', { language: 'zh-CN' });
    local.values.set(DATA_IMPORT_JOURNAL_KEY, {
      version: 1,
      operationId: 'interrupted-operation',
      digest: 'a'.repeat(64),
      phase: 'settings_applied',
      createdAt: 1,
      preimage: {
        global_settings: { exists: true, value: { language: 'en' } },
        connections: { exists: false },
      },
    });

    await expect(createCoordinator().reconcileStartup()).resolves.toBe('rolled_back');
    expect(local.values.get('global_settings')).toEqual({ language: 'en' });
    expect(local.values.has('connections')).toBe(false);
    expect(local.values.has(DATA_IMPORT_JOURNAL_KEY)).toBe(false);
  });

  it('rolls back the destructive Dexie transaction and settings when a database write fails', async () => {
    const old = makePlan();
    await db.threads.put({ ...old.threads[0]!, id: 'old-thread', leafId: null });
    local.values.set('global_settings', { language: 'en' });
    const plan = makePlan();
    const coordinator = createCoordinator();
    const preview = await coordinator.preview(plan, 'db-rollback');
    vi.spyOn(db.nodes, 'bulkPut').mockRejectedValueOnce(new Error('injected database failure'));

    await expect(
      coordinator.commit({
        operationId: preview.operationId,
        input: plan,
        expectedDigest: preview.digest,
        settings: plan.settings,
        oauthAccessToClear: 0,
      }),
    ).rejects.toThrow('injected database failure');

    expect((await db.threads.toArray()).map((thread) => thread.id)).toEqual(['old-thread']);
    expect(local.values.get('global_settings')).toEqual({ language: 'en' });
    expect(local.values.has(DATA_IMPORT_JOURNAL_KEY)).toBe(false);
    expect(await db.maintenance.count()).toBe(0);
  });

  it('preserves extension-owned skills and rejects imported collisions transactionally', async () => {
    const preserved = makeSkill('collision', 'plugin');
    await db.skills.put(preserved);
    const plan = makePlan();
    plan.skills = [makeSkill('collision', 'imported')];
    const coordinator = createCoordinator();
    const preview = await coordinator.preview(plan, 'skill-collision');
    const transaction = vi.spyOn(db, 'transaction');

    await expect(
      coordinator.commit({
        operationId: preview.operationId,
        input: plan,
        expectedDigest: preview.digest,
        settings: plan.settings,
        oauthAccessToClear: 0,
      }),
    ).rejects.toThrow('IMPORT_SKILL_COLLISION');

    expect(await db.skills.toArray()).toEqual([preserved]);
    expect(local.mutations).toBe(0);
    expect(transaction).not.toHaveBeenCalled();
    expect(local.values.has(DATA_IMPORT_JOURNAL_KEY)).toBe(false);
    expect(await db.maintenance.count()).toBe(0);
  });

  it('normalizes Provider endpoints before settings are persisted', async () => {
    const plan = makePlan();
    plan.settings.connections = [
      {
        id: 'provider',
        name: 'Provider',
        kind: 'openai',
        baseUrl: 'https://provider.example/v1/',
        apiKeys: [],
        enabled: true,
      },
    ];
    const coordinator = createCoordinator();
    const preview = await coordinator.preview(plan, 'normalize-provider');
    const settings = structuredClone(plan.settings);
    (settings.connections as { baseUrl: string }[])[0]!.baseUrl = 'https://provider.example/v1';

    await expect(
      coordinator.commit({
        operationId: preview.operationId,
        input: plan,
        expectedDigest: preview.digest,
        settings,
        oauthAccessToClear: 0,
      }),
    ).resolves.toMatchObject({ status: 'committed' });

    expect(local.values.get('connections')).toEqual(settings.connections);
  });

  it('accepts canonical nested Skill YAML without loading the full Skill parser', async () => {
    const plan = makePlan();
    plan.skills = [
      {
        ...makeSkill('yaml-skill', 'imported'),
        raw: `---
name: yaml-skill
description: "YAML skill"
allowed-tools: [read_page, "tabs_list"]
panelot:
  sites:
    - example.com
  auto_suggest: true
  variables:
    - key: query
      label: Query
      type: text
      required: true
---
body`,
        frontmatter: {
          name: 'yaml-skill',
          description: 'YAML skill',
          'allowed-tools': ['read_page', 'tabs_list'],
          panelot: {
            sites: ['example.com'],
            auto_suggest: true,
            variables: [{ key: 'query', label: 'Query', type: 'text', required: true }],
          },
        },
      },
    ];

    await expect(createCoordinator().preview(plan, 'canonical-skill')).resolves.toMatchObject({
      operationId: 'canonical-skill',
    });
  });

  it('treats a completed operation as idempotent and rejects operation reuse', async () => {
    const plan = makePlan();
    let coordinator = createCoordinator();
    const preview = await coordinator.preview(plan, 'repeat-operation');
    const request = {
      operationId: preview.operationId,
      input: plan,
      expectedDigest: preview.digest,
      settings: plan.settings,
      oauthAccessToClear: 0,
    };
    await coordinator.commit(request);
    await createCoordinator().reconcileStartup();

    coordinator = createCoordinator();
    await expect(coordinator.commit(request)).resolves.toMatchObject({ status: 'committed' });
    const changed = structuredClone(plan);
    changed.exportedAt += 1;
    const changedPreview = await coordinator.preview(changed, 'new-operation');
    await expect(
      coordinator.commit({
        ...request,
        input: changed,
        expectedDigest: changedPreview.digest,
      }),
    ).rejects.toThrow('OPERATION_REUSED');
  });

  it('rejects post-preview settings drift and releases admission when draining fails', async () => {
    const plan = makePlan();
    let coordinator = createCoordinator();
    let preview = await coordinator.preview(plan, 'drift-operation');
    await expect(
      coordinator.commit({
        operationId: preview.operationId,
        input: plan,
        expectedDigest: preview.digest,
        settings: { ...plan.settings, global_settings: { language: 'en' } },
        oauthAccessToClear: 0,
      }),
    ).rejects.toThrow('IMPORT_SETTINGS_CHANGED');
    expect(coordinator.isAdmissionBlocked()).toBe(false);
    expect(local.values.has(DATA_IMPORT_JOURNAL_KEY)).toBe(false);

    coordinator = new DataImportCoordinator(db, {
      local,
      session,
      validator: inProcessMaintenanceValidator,
      waitForAdmissionIdle: async () => {
        throw new Error('injected drain failure');
      },
    });
    preview = await coordinator.preview(plan, 'drain-operation');
    await expect(
      coordinator.commit({
        operationId: preview.operationId,
        input: plan,
        expectedDigest: preview.digest,
        settings: plan.settings,
        oauthAccessToClear: 0,
      }),
    ).rejects.toThrow('injected drain failure');
    expect(coordinator.isAdmissionBlocked()).toBe(false);
    expect(local.values.has(DATA_IMPORT_JOURNAL_KEY)).toBe(false);
  });
});

function createCoordinator(activeThreadIds: string[] = []) {
  return new DataImportCoordinator(db, {
    local,
    session,
    validator: inProcessMaintenanceValidator,
    activeThreadIds: () => activeThreadIds,
    now: () => 100,
  });
}

function makePlan(options: { attachmentId?: string } = {}): CanonicalImportPlan {
  const attachedContext = options.attachmentId
    ? [
        {
          kind: 'file' as const,
          label: 'file.txt',
          provenance: 'user' as const,
          trust: 'trusted' as const,
          sourceRef: options.attachmentId,
          content: [{ type: 'text' as const, text: 'attachment' }],
        },
      ]
    : undefined;
  const node: ThreadNode = {
    id: 'new-node',
    threadId: 'new-thread',
    parentId: null,
    seq: 0,
    ts: 1,
    type: 'user_message',
    payload: { content: [{ type: 'text', text: 'hello' }], attachedContext },
  };
  return {
    version: 1,
    exportedAt: 1,
    threads: [
      {
        id: 'new-thread',
        revision: 1,
        title: 'new',
        createdAt: 1,
        updatedAt: 2,
        leafId: node.id,
        tags: [],
        pinned: false,
        archived: false,
        stats: { turns: 1, totalTokens: 0, costUsd: 0 },
        scopeOrigins: [],
      },
    ],
    nodes: [node],
    skills: [],
    memories: [],
    settings: {
      connections: null,
      model_presets: null,
      global_settings: null,
      permission_rules: null,
      sensitive_origins: null,
      mcp_servers: null,
      site_prompts: null,
    },
  };
}

function makeRun(state: RunRecord['state']): RunRecord {
  return {
    id: `run-${state}`,
    threadId: 'old-thread',
    turnId: 'turn',
    clientId: 'client',
    submissionId: 'submission',
    input: { text: 'hello' },
    state,
    revision: 1,
    stepCursor: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

function makeSkill(name: string, source: SkillRecord['source']): SkillRecord {
  return {
    id: `${source}-${name}`,
    name,
    raw: `---\nname: ${name}\ndescription: ${name}\n---\nbody`,
    frontmatter: { name, description: name },
    body: 'body',
    enabled: true,
    source,
    sourceRef: source === 'plugin' ? 'plugin-1' : undefined,
    createdAt: 1,
    updatedAt: 1,
  };
}
