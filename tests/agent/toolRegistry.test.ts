import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ToolRegistry, type AgentTool } from '../../src/agent/tool';

function tool(
  patch: Partial<AgentTool<{ value: string }, unknown>> = {},
): AgentTool<{ value: string }, unknown> {
  return {
    name: 'stable_read',
    label: 'Stable read',
    description: 'Read a stable value.',
    parameters: z.object({ value: z.string() }),
    level: 'builtin',
    effects: 'read',
    execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    ...patch,
  };
}

describe('ToolRegistry capability normalization', () => {
  it('uses one immutable descriptor for provider schemas and recovery metadata', () => {
    const registry = new ToolRegistry();
    const registration = tool();
    registry.register(registration);

    registration.description = 'mutated after registration';
    registration.effects = 'write';

    expect(registry.capabilities()).toEqual([
      expect.objectContaining({
        name: 'stable_read',
        description: 'Read a stable value.',
        level: 'builtin',
        effects: 'read',
        recovery: 'retry-safe',
        resultTrust: 'trusted',
        resultProvenance: 'tool',
        execution: { kind: 'local', id: 'stable_read' },
      }),
    ]);
    expect(registry.schemas()).toEqual([
      {
        name: 'stable_read',
        description: 'Read a stable value.',
        parameters: expect.objectContaining({ type: 'object' }),
      },
    ]);
    expect(registry.get('stable_read')).toMatchObject({
      description: 'Read a stable value.',
      effects: 'read',
      recovery: 'retry-safe',
      resultTrust: 'trusted',
      resultProvenance: 'tool',
      executionBinding: { kind: 'local', id: 'stable_read' },
    });
  });

  it('reports both capability identities when registrations conflict', () => {
    const registry = new ToolRegistry();
    registry.register(tool());

    expect(() =>
      registry.register(
        tool({
          level: 'mcp',
          effects: 'write',
          recovery: 'never-retry',
          executionBinding: {
            kind: 'mcp',
            id: 'stable_read',
            serverId: 'server-a',
            endpoint: 'https://server-a.example.test/mcp',
            auth: { kind: 'none' },
          },
        }),
      ),
    ).toThrow(
      /existing builtin\/read\/retry-safe\/local:stable_read; incoming mcp\/write\/never-retry\/mcp:server-a\/stable_read/,
    );
  });

  it('rejects incomplete interaction metadata and empty execution identities', () => {
    const registry = new ToolRegistry();

    expect(() => registry.register(tool({ interaction: 'ask_user' }))).toThrow(
      /both interaction and prepareInteraction/,
    );
    expect(() =>
      registry.register(
        tool({
          executionBinding: { kind: 'local', id: ' ' },
        }),
      ),
    ).toThrow(/binding id must not be empty/);
    expect(() => registry.register(tool({ level: 'mcp' }))).toThrow(
      /must use an MCP execution binding/,
    );
    expect(() =>
      registry.register(
        tool({
          executionBinding: {
            kind: 'mcp',
            id: 'stable_read',
            serverId: 'server-a',
            endpoint: 'https://server-a.example.test/mcp',
            auth: { kind: 'none' },
          },
        }),
      ),
    ).toThrow(/must use a local execution binding/);
    expect(registry.list()).toEqual([]);
    expect(registry.capabilities()).toEqual([]);
  });

  it('removes the implementation and canonical capability together', () => {
    const registry = new ToolRegistry();
    registry.register(tool());

    registry.unregister('stable_read');

    expect(registry.get('stable_read')).toBeUndefined();
    expect(registry.capabilities()).toEqual([]);
    expect(registry.schemas()).toEqual([]);
  });

  it('preserves implementation this binding while freezing registered metadata', async () => {
    class StatefulTool implements AgentTool<{ value: string }, unknown> {
      name = 'stateful_read';
      label = 'Stateful read';
      description = 'Read through instance state.';
      parameters = z.object({ value: z.string() });
      level = 'builtin' as const;
      effects = 'read' as const;
      calls = 0;
      targetTabId = 17;

      async resolveTarget() {
        return { tabId: this.targetTabId };
      }

      async execute() {
        this.calls += 1;
        return { content: [{ type: 'text' as const, text: String(this.calls) }] };
      }
    }
    const registry = new ToolRegistry();
    const implementation = new StatefulTool();
    registry.register(implementation);
    const registered = registry.get(implementation.name);

    await expect(registered?.resolveTarget?.({ value: 'x' } as never)).resolves.toEqual({
      tabId: 17,
    });
    await expect(
      registered?.execute('call-a', { value: 'x' }, new AbortController().signal),
    ).resolves.toMatchObject({ content: [{ text: '1' }] });
    expect(implementation.calls).toBe(1);
    expect(Object.isFrozen(registered)).toBe(true);
    expect(Object.isFrozen(registered?.inputSchema)).toBe(true);
    expect(Object.isFrozen(registered?.executionBinding)).toBe(true);
    expect(Reflect.set(registered!.executionBinding, 'id', 'mutated-after-registration')).toBe(
      false,
    );
    expect(registered?.executionBinding.id).toBe('stateful_read');
    const properties = registered?.inputSchema.properties as Record<string, unknown>;
    expect(Object.isFrozen(properties)).toBe(true);
    expect(Reflect.set(properties, 'value', { type: 'number' })).toBe(false);

    const firstSnapshot = registry.snapshot();
    registry.unregister(implementation.name);
    expect(registry.snapshot().generation).toBeGreaterThan(firstSnapshot.generation);
    expect(firstSnapshot.entries[0]?.tool).toBe(registered);
    expect(Object.isFrozen(firstSnapshot.entries)).toBe(true);
    expect(Object.isFrozen(firstSnapshot.entries[0]?.capability)).toBe(true);
  });
});
