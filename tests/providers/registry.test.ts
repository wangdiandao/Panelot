import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONNECTION_TEMPLATES,
  createAdapter,
  fetchAllModels,
  inferCapabilities,
  normalizeBaseUrl,
} from '../../src/providers/registry';
import type { Connection } from '../../src/providers/types';

afterEach(() => vi.restoreAllMocks());

describe('normalizeBaseUrl (docs/development/providers.md §4)', () => {
  it('strips trailing slashes', () => {
    expect(normalizeBaseUrl('https://api.x.com/v1///', 'openai').url).toBe('https://api.x.com/v1');
  });

  it('defaults to https, but http for localhost', () => {
    expect(normalizeBaseUrl('api.x.com/v1', 'openai').url).toBe('https://api.x.com/v1');
    expect(normalizeBaseUrl('localhost:11434/v1', 'openai').url).toBe('http://localhost:11434/v1');
    expect(normalizeBaseUrl('127.0.0.1:1234/v1', 'openai').url).toBe('http://127.0.0.1:1234/v1');
  });

  it('hints (not forces) missing /v1 for openai kind', () => {
    const r = normalizeBaseUrl('https://api.x.com', 'openai');
    expect(r.url).toBe('https://api.x.com');
    expect(r.hint).toMatch(/v1/);
    expect(normalizeBaseUrl('https://api.x.com/v1', 'openai').hint).toBeUndefined();
    expect(normalizeBaseUrl('https://api.anthropic.com', 'anthropic').hint).toBeUndefined();
  });

  it('rejects insecure remote HTTP, credentials, and fragments', () => {
    expect(() => normalizeBaseUrl('http://api.x.com/v1', 'openai')).toThrow(/HTTPS/);
    expect(() => normalizeBaseUrl('https://user:pass@api.x.com/v1', 'openai')).toThrow(
      /用户名或密码/,
    );
    expect(() => normalizeBaseUrl('https://api.x.com/v1#secret', 'openai')).toThrow(/fragment/);
  });

  it('revalidates persisted endpoints at the adapter boundary', () => {
    const unsafe: Connection = {
      id: 'legacy-unsafe',
      name: 'Legacy unsafe',
      kind: 'openai',
      baseUrl: 'http://api.x.com/v1',
      apiKeys: ['key'],
      enabled: true,
    };

    expect(() => createAdapter(unsafe)).toThrow(/HTTPS/);
    expect(() => createAdapter({ ...unsafe, baseUrl: 'http://127.0.0.1:11434/v1' })).not.toThrow();
  });
});

describe('templates & capabilities', () => {
  it('ships the ten templates from docs/development/providers.md §4', () => {
    expect(CONNECTION_TEMPLATES).toHaveLength(10);
    expect(CONNECTION_TEMPLATES.filter((t) => t.keyless).map((t) => t.name)).toEqual([
      'Ollama (local)',
      'LM Studio (local)',
    ]);
  });

  it('infers known-model capabilities with conservative fallback', () => {
    expect(inferCapabilities('claude-sonnet-5').vision).toBe(true);
    expect(inferCapabilities('deepseek-reasoner').reasoning).toBe(true);
    expect(inferCapabilities('org/llama-3-70b').toolUse).toBe(true);
    expect(inferCapabilities('mystery-model-9000')).toEqual({ toolUse: true, vision: false });
  });
});

describe('fetchAllModels (docs/development/providers.md §6 — concurrent, isolated failures)', () => {
  const conn = (id: string, overrides?: Partial<Connection>): Connection => ({
    id,
    name: id,
    kind: 'openai',
    baseUrl: `https://${id}.test/v1`,
    apiKeys: ['k'],
    enabled: true,
    ...overrides,
  });

  it('one failing connection does not block others', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('bad.test')) throw new Error('unreachable');
      return new Response(JSON.stringify({ data: [{ id: 'model-a' }] }), { status: 200 });
    });

    const results = await fetchAllModels([conn('good'), conn('bad')]);
    const good = results.find((r) => r.connectionId === 'good')!;
    const bad = results.find((r) => r.connectionId === 'bad')!;
    expect(good.models.map((m) => m.id)).toEqual(['model-a']);
    expect(good.error).toBeUndefined();
    expect(bad.models).toEqual([]);
    expect(bad.error).toMatch(/unreachable/);
  });

  it('uses the manual whitelist without hitting the network', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const results = await fetchAllModels([conn('manual', { modelIds: ['m1', 'm2'] })]);
    expect(results[0]!.models.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(spy).not.toHaveBeenCalled();
  });

  it('skips disabled connections', async () => {
    const results = await fetchAllModels([conn('off', { enabled: false })]);
    expect(results).toEqual([]);
  });
});
