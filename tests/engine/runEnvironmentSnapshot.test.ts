import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '../../src/agent/tool';
import { PanelotDB } from '../../src/db/schema';
import type {
  ResolvedRunEnvironment,
  RunEnvironmentSnapshot,
  ToolExecutionBinding,
} from '../../src/db/types';
import { SettingsProviderResolver } from '../../src/engine/providerResolver';
import { RunRepository } from '../../src/engine/runRepository';
import {
  bindToolRegistry,
  captureSkillCatalog,
  captureToolCatalog,
  createRunEnvironmentSnapshot,
  digestCanonical,
  RUN_ENVIRONMENT_SNAPSHOT_LIMITS,
  verifyRunEnvironmentSnapshot,
} from '../../src/engine/runEnvironmentSnapshot';
import type { Connection } from '../../src/providers/types';
import { SettingsStore } from '../../src/settings/store';

let sequence = 0;

function environment(patch: Partial<ResolvedRunEnvironment> = {}): ResolvedRunEnvironment {
  return {
    connectionId: 'provider-a',
    modelId: 'model-a',
    modelParameters: { temperature: 0.2 },
    presetId: 'preset-a',
    presetPrompt: 'Preset prompt',
    enabledToolLevels: ['L0', 'L1', 'L2', 'mcp'],
    permissionPolicy: 'untrusted',
    activeSkills: ['skill-a'],
    promptVersion: 'kernel-test',
    browserContext: { capturedAt: 1, referencedTabs: [] },
    ...patch,
  };
}

function registerTool(
  registry: ToolRegistry,
  description = 'Read a stable value.',
  executionBinding?: ToolExecutionBinding,
  resultText = 'ok',
): void {
  registry.register({
    name: 'stable_read',
    label: 'Stable read',
    description,
    parameters: z.object({ value: z.string() }),
    level: executionBinding?.kind === 'mcp' ? 'mcp' : 'builtin',
    effects: 'read',
    executionBinding,
    execute: async () => ({ content: [{ type: 'text', text: resultText }] }),
  });
}

async function snapshot(registry: ToolRegistry, text = 'hello'): Promise<RunEnvironmentSnapshot> {
  const base = environment();
  const skills = await captureSkillCatalog([
    {
      id: 'skill-a',
      name: 'skill-a',
      body: 'Captured skill body',
      description: 'Captured skill description',
      sites: ['example.test'],
    },
  ]);
  return createRunEnvironmentSnapshot({
    environment: base,
    normalizedInput: { text },
    providerBinding: {
      kind: 'settings',
      connectionId: base.connectionId,
      protocol: 'openai',
      baseUrl: 'https://old.example.test/v1',
      quirks: { noStreamOptions: true },
      credentials: [
        { kind: 'api-key', connectionId: base.connectionId, slot: 0 },
        { kind: 'custom-header', connectionId: base.connectionId, headerName: 'api-key' },
      ],
    },
    systemPrompt: 'Captured system prompt',
    skillCatalog: skills,
    toolCatalog: await captureToolCatalog(registry, base.enabledToolLevels),
    capturedAt: 10,
  });
}

beforeEach(async () => {
  await SettingsStore.connections.set([]);
});

describe('run environment snapshot', () => {
  it('captures immutable prompt, skill, model, policy, browser, and tool request facts', async () => {
    const registry = new ToolRegistry();
    registerTool(registry);
    const captured = await snapshot(registry);

    expect(await verifyRunEnvironmentSnapshot(captured, { text: 'hello' })).toBe(captured);
    expect(captured).toMatchObject({
      snapshotVersion: 1,
      modelId: 'model-a',
      modelParameters: { temperature: 0.2 },
      presetPrompt: 'Preset prompt',
      permissionPolicy: 'untrusted',
      browserContext: { capturedAt: 1 },
      systemPrompt: 'Captured system prompt',
      skillCatalog: [{ name: 'skill-a', body: 'Captured skill body' }],
      toolCatalog: [{ name: 'stable_read', execution: { kind: 'local' } }],
    });
  });

  it('rejects legacy runs, input drift, and nested or top-level tampering', async () => {
    const registry = new ToolRegistry();
    registerTool(registry);
    const captured = await snapshot(registry);

    await expect(
      verifyRunEnvironmentSnapshot(environment(), { text: 'hello' }),
    ).rejects.toMatchObject({ code: 'environment_snapshot_unsupported' });
    await expect(verifyRunEnvironmentSnapshot(captured, { text: 'changed' })).rejects.toMatchObject(
      {
        code: 'environment_snapshot_invalid',
      },
    );
    const promptTamper = structuredClone(captured);
    promptTamper.systemPrompt = 'tampered';
    await expect(
      verifyRunEnvironmentSnapshot(promptTamper, { text: 'hello' }),
    ).rejects.toMatchObject({ code: 'environment_snapshot_invalid' });
    const toolTamper = structuredClone(captured);
    toolTamper.toolCatalog[0]!.description = 'tampered';
    await expect(verifyRunEnvironmentSnapshot(toolTamper, { text: 'hello' })).rejects.toMatchObject(
      {
        code: 'environment_snapshot_invalid',
      },
    );
  });

  it('fails closed when a local schema or MCP execution binding drifts', async () => {
    const initial = new ToolRegistry();
    registerTool(initial, 'Read a stable value.', {
      kind: 'mcp',
      id: 'stable_read',
      serverId: 'server-a',
      endpoint: 'https://old.example.test/mcp',
      auth: { kind: 'bearer', credentialRef: 'mcp:server-a:bearer' },
    });
    const captured = await snapshot(initial);

    const schemaDrift = new ToolRegistry();
    registerTool(schemaDrift, 'Changed description.', captured.toolCatalog[0]!.execution);
    await expect(bindToolRegistry(schemaDrift, captured)).rejects.toMatchObject({
      code: 'environment_snapshot_invalid',
    });

    const endpointDrift = new ToolRegistry();
    registerTool(endpointDrift, 'Read a stable value.', {
      ...captured.toolCatalog[0]!.execution,
      endpoint: 'https://new.example.test/mcp',
    });
    await expect(bindToolRegistry(endpointDrift, captured)).rejects.toMatchObject({
      code: 'environment_snapshot_invalid',
    });
  });

  it('includes normalized safety defaults in the stable tool capability fingerprint', async () => {
    const initial = new ToolRegistry();
    registerTool(initial);
    const captured = await snapshot(initial);
    expect(captured.toolCatalog[0]).toMatchObject({
      effects: 'read',
      recovery: 'retry-safe',
      resultTrust: 'trusted',
      resultProvenance: 'tool',
      execution: { kind: 'local', id: 'stable_read' },
    });

    const recoveryDrift = new ToolRegistry();
    recoveryDrift.register({
      name: 'stable_read',
      label: 'Stable read',
      description: 'Read a stable value.',
      parameters: z.object({ value: z.string() }),
      level: 'builtin',
      effects: 'read',
      recovery: 'never-retry',
      execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    });

    const drifted = await captureToolCatalog(recoveryDrift, captured.enabledToolLevels);
    expect(drifted[0]?.digest).not.toBe(captured.toolCatalog[0]?.digest);
    await expect(bindToolRegistry(recoveryDrift, captured)).rejects.toMatchObject({
      code: 'environment_snapshot_invalid',
    });
  });

  it('binds the implementation paired with the capability snapshot during registry churn', async () => {
    const initial = new ToolRegistry();
    registerTool(initial, 'Read a stable value.', undefined, 'captured');
    const captured = await snapshot(initial);

    const current = new ToolRegistry();
    registerTool(current, 'Read a stable value.', undefined, 'matching implementation');
    const takeSnapshot = current.snapshot.bind(current);
    vi.spyOn(current, 'snapshot').mockImplementationOnce((levels) => {
      const atomic = takeSnapshot(levels);
      current.unregister('stable_read');
      registerTool(current, 'Changed after snapshot.', undefined, 'replacement implementation');
      return atomic;
    });

    const bound = await bindToolRegistry(current, captured);
    await expect(
      bound.get('stable_read')?.execute('call-1', { value: 'x' }, new AbortController().signal),
    ).resolves.toMatchObject({ content: [{ text: 'matching implementation' }] });
  });

  it('accepts legacy v1 tool fingerprints that omitted equivalent result defaults', async () => {
    const registry = new ToolRegistry();
    registerTool(registry);
    const legacy = structuredClone(await snapshot(registry));
    const legacyTool = legacy.toolCatalog[0]!;
    delete legacyTool.resultTrust;
    delete legacyTool.resultProvenance;
    const { digest: discardedToolDigest, ...legacyCapability } = legacyTool;
    void discardedToolDigest;
    legacyTool.digest = await digestCanonical(legacyCapability);
    legacy.toolCatalogDigest = await digestCanonical(legacy.toolCatalog);
    const { digest: discardedEnvironmentDigest, ...legacyEnvironment } = legacy;
    void discardedEnvironmentDigest;
    legacy.digest = await digestCanonical(legacyEnvironment);

    await expect(verifyRunEnvironmentSnapshot(legacy, { text: 'hello' })).resolves.toBe(legacy);
    await expect(bindToolRegistry(registry, legacy)).resolves.toBeInstanceOf(ToolRegistry);
  });

  it('allows referenced secret rotation only when provider transport facts stay unchanged', async () => {
    const db = new PanelotDB(`provider-snapshot-${sequence++}`);
    const resolver = new SettingsProviderResolver(db);
    const original: Connection = {
      id: 'provider-a',
      name: 'Original',
      kind: 'openai',
      baseUrl: 'https://old.example.test/v1',
      apiKeys: ['old-secret'],
      customHeaders: { 'api-key': 'old-header-secret' },
      enabled: true,
      quirks: { noStreamOptions: true },
    };
    await SettingsStore.connections.set([original]);
    const binding = await resolver.captureEnvironmentBinding('provider-a');

    await SettingsStore.connections.set([
      {
        ...original,
        apiKeys: ['updated-secret'],
        customHeaders: { 'api-key': 'updated-header-secret' },
      },
    ]);
    const adapter = await resolver.resolveFromEnvironmentBinding(binding);
    const restored = (adapter as unknown as { connection: Connection }).connection;

    expect(restored).toMatchObject({
      kind: 'openai',
      baseUrl: 'https://old.example.test/v1',
      apiKeys: ['updated-secret'],
      customHeaders: { 'api-key': 'updated-header-secret' },
      quirks: { noStreamOptions: true },
    });
    const serialized = JSON.stringify(binding);
    expect(serialized).not.toContain('old-secret');
    expect(serialized).not.toContain('old-header-secret');
    expect(serialized).not.toContain('updated-secret');
    expect(serialized).not.toContain('updated-header-secret');
    await db.delete();
  });

  it.each([
    ['kind', { kind: 'anthropic' as const }],
    ['endpoint', { baseUrl: 'https://new.example.test' }],
    ['quirks', { quirks: { noSystemRole: true } }],
    ['key slots', { apiKeys: ['secret', 'second-secret'] }],
    ['header names', { customHeaders: { authorization: 'header-secret' } }],
  ])('fails closed before restoring when provider %s drifted', async (_label, patch) => {
    const db = new PanelotDB(`provider-drift-${sequence++}`);
    const resolver = new SettingsProviderResolver(db);
    const original: Connection = {
      id: 'provider-a',
      name: 'Original',
      kind: 'openai',
      baseUrl: 'https://old.example.test/v1',
      apiKeys: ['old-secret'],
      customHeaders: { 'api-key': 'old-header-secret' },
      enabled: true,
      quirks: { noStreamOptions: true },
    };
    await SettingsStore.connections.set([original]);
    const binding = await resolver.captureEnvironmentBinding(original.id);
    await SettingsStore.connections.set([{ ...original, ...patch }]);

    const failure = await resolver.resolveFromEnvironmentBinding(binding).catch((error) => error);
    expect(failure).toMatchObject({ code: 'environment_snapshot_invalid' });
    const serialized = String(failure);
    expect(serialized).not.toContain('old.example.test');
    expect(serialized).not.toContain('new.example.test');
    expect(serialized).not.toContain('old-secret');
    expect(serialized).not.toContain('header-secret');
    await db.delete();
  });

  it('bounds snapshot bytes, catalogs, individual entries, and nesting before persistence', async () => {
    const registry = new ToolRegistry();
    registerTool(registry);
    const base = environment();
    const normalTools = await captureToolCatalog(registry, base.enabledToolLevels);
    const nearLimitSkills = await captureSkillCatalog([
      {
        id: 'skill-near-limit',
        name: 'skill-near-limit',
        body: 'x'.repeat(RUN_ENVIRONMENT_SNAPSHOT_LIMITS.skillBodyBytes),
        description: '',
      },
    ]);
    await expect(
      createRunEnvironmentSnapshot({
        environment: base,
        normalizedInput: { text: 'bounded' },
        providerBinding: { kind: 'resolver', connectionId: base.connectionId, credentials: [] },
        systemPrompt: 'x'.repeat(RUN_ENVIRONMENT_SNAPSHOT_LIMITS.systemPromptBytes),
        skillCatalog: nearLimitSkills,
        toolCatalog: normalTools,
      }),
    ).resolves.toMatchObject({ snapshotVersion: 1 });

    await expect(
      captureSkillCatalog([
        {
          id: 'skill-too-large',
          name: 'skill-too-large',
          body: 'x'.repeat(RUN_ENVIRONMENT_SNAPSHOT_LIMITS.skillBodyBytes + 1),
          description: '',
        },
      ]),
    ).rejects.toMatchObject({ code: 'environment_snapshot_invalid' });
    await expect(
      captureSkillCatalog(
        Array.from({ length: RUN_ENVIRONMENT_SNAPSHOT_LIMITS.skills + 1 }, (_, index) => ({
          id: `skill-${index}`,
          name: `skill-${index}`,
          body: '',
          description: '',
        })),
      ),
    ).rejects.toMatchObject({ code: 'environment_snapshot_invalid' });
    await expect(
      captureSkillCatalog(
        Array.from({ length: 5 }, (_, index) => ({
          id: `large-skill-${index}`,
          name: `large-skill-${index}`,
          body: 'x'.repeat(RUN_ENVIRONMENT_SNAPSHOT_LIMITS.skillBodyBytes),
          description: '',
        })),
      ),
    ).rejects.toMatchObject({ code: 'environment_snapshot_invalid' });

    const tooManyTools = new ToolRegistry();
    for (let index = 0; index <= RUN_ENVIRONMENT_SNAPSHOT_LIMITS.tools; index += 1) {
      tooManyTools.register({
        name: `tool_${index}`,
        label: `Tool ${index}`,
        description: 'bounded',
        parameters: z.object({}),
        level: 'builtin',
        effects: 'read',
        execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      });
    }
    await expect(captureToolCatalog(tooManyTools, base.enabledToolLevels)).rejects.toMatchObject({
      code: 'environment_snapshot_invalid',
    });

    const boundedSchema = new ToolRegistry();
    boundedSchema.register({
      name: 'bounded_schema',
      label: 'Bounded schema',
      description: 'bounded',
      parameters: z.object({}),
      inputSchema: {
        type: 'object',
        description: 'x'.repeat(RUN_ENVIRONMENT_SNAPSHOT_LIMITS.toolSchemaBytes / 2),
      },
      level: 'builtin',
      effects: 'read',
      execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    });
    await expect(captureToolCatalog(boundedSchema, base.enabledToolLevels)).resolves.toHaveLength(
      1,
    );
    const oversizedSchema = new ToolRegistry();
    oversizedSchema.register({
      name: 'oversized_schema',
      label: 'Oversized schema',
      description: 'oversized',
      parameters: z.object({}),
      inputSchema: {
        type: 'object',
        description: 'x'.repeat(RUN_ENVIRONMENT_SNAPSHOT_LIMITS.toolSchemaBytes),
      },
      level: 'builtin',
      effects: 'read',
      execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    });
    await expect(captureToolCatalog(oversizedSchema, base.enabledToolLevels)).rejects.toMatchObject(
      { code: 'environment_snapshot_invalid' },
    );

    let depth64: unknown = 'leaf';
    for (let depth = 0; depth < RUN_ENVIRONMENT_SNAPSHOT_LIMITS.depth; depth += 1) {
      depth64 = { child: depth64 };
    }
    await expect(digestCanonical(depth64)).resolves.toMatch(/^[a-f\d]{64}$/);
    await expect(digestCanonical({ child: depth64 })).rejects.toMatchObject({
      code: 'environment_snapshot_invalid',
    });

    await expect(
      createRunEnvironmentSnapshot({
        environment: { ...base, modelParameters: { padding: 'x'.repeat(2 * 1024 * 1024) } },
        normalizedInput: { text: 'too large' },
        providerBinding: { kind: 'resolver', connectionId: base.connectionId, credentials: [] },
        systemPrompt: 'bounded',
        skillCatalog: [],
        toolCatalog: normalTools,
      }),
    ).rejects.toMatchObject({ code: 'environment_snapshot_invalid' });
    await expect(
      createRunEnvironmentSnapshot({
        environment: base,
        normalizedInput: { text: 'prompt too large' },
        providerBinding: { kind: 'resolver', connectionId: base.connectionId, credentials: [] },
        systemPrompt: 'x'.repeat(RUN_ENVIRONMENT_SNAPSHOT_LIMITS.systemPromptBytes + 1),
        skillCatalog: [],
        toolCatalog: normalTools,
      }),
    ).rejects.toMatchObject({ code: 'environment_snapshot_invalid' });
  });

  it('rejects an oversized persisted snapshot before digest verification', async () => {
    const registry = new ToolRegistry();
    registerTool(registry);
    const captured = await snapshot(registry);
    const oversized = {
      ...captured,
      padding: 'private-content'.repeat(200_000),
    } as RunEnvironmentSnapshot;

    const failure = await verifyRunEnvironmentSnapshot(oversized, { text: 'hello' }).catch(
      (error) => error,
    );
    expect(failure).toMatchObject({ code: 'environment_snapshot_invalid' });
    expect(String(failure)).not.toContain('private-content');
  });

  it('commits normalized input and snapshot atomically with preparation', async () => {
    const db = new PanelotDB(`snapshot-atomic-${sequence++}`);
    const runs = new RunRepository(db);
    const registry = new ToolRegistry();
    registerTool(registry);
    const run = await runs.enqueue({
      threadId: 'missing-thread',
      clientId: 'client',
      submissionId: 'submission',
      input: { text: 'raw' },
    });
    const captured = await snapshot(registry, 'normalized');

    await expect(runs.prepare(run.id, captured, { text: 'normalized' })).rejects.toThrow(
      'Thread not found',
    );
    const persisted = await db.runs.get(run.id);
    expect(persisted).toMatchObject({
      state: 'queued',
      input: { text: 'raw' },
    });
    expect(persisted?.environment).toBeUndefined();
    await db.delete();
  });
});
