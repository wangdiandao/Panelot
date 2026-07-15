import { describe, expect, it } from 'vitest';
import { schema, type RuntimeSchema } from '../../src/agent/schema';
import { validateParams, type AgentTool } from '../../src/agent/tool';

function validate(parameters: RuntimeSchema, raw: unknown) {
  const tool: AgentTool = {
    name: 'diagnostic_tool',
    label: 'Diagnostic tool',
    description: 'Exercises runtime parameter diagnostics.',
    parameters,
    level: 'builtin',
    effects: 'read',
    execute: async () => ({ content: [] }),
  };
  return validateParams(tool, raw);
}

function diagnostic(parameters: RuntimeSchema, raw: unknown): string {
  const result = validate(parameters, raw);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('Expected invalid parameters.');
  return result.error;
}

describe('zod/mini validateParams diagnostics', () => {
  it('identifies type and integer violations', () => {
    const parameters = schema.object({
      label: schema.string(),
      count: schema.number({ integer: true }),
    });

    expect(diagnostic(parameters, { label: 42, count: 1 })).toMatch(/label: .*expected string/i);
    expect(diagnostic(parameters, { label: 'ok', count: 1.5 })).toMatch(/count: .*expected int/i);
  });

  it('identifies URL and regular-expression violations', () => {
    const parameters = schema.object({
      url: schema.string({ url: true }),
      slug: schema.string({
        pattern: /^[a-z]+$/,
        patternMessage: 'Use lowercase ASCII letters only.',
      }),
    });

    expect(diagnostic(parameters, { url: 'not a url', slug: 'valid' })).toMatch(/url: .*url/i);
    expect(diagnostic(parameters, { url: 'https://example.com', slug: 'NOT_VALID' })).toContain(
      'slug: Use lowercase ASCII letters only.',
    );
  });

  it('reports minimum and maximum bounds', () => {
    const parameters = schema.object({
      name: schema.string({ min: 3, max: 5 }),
      score: schema.number({ min: 1, max: 10 }),
    });

    expect(diagnostic(parameters, { name: 'ab', score: 5 })).toMatch(/name: .*>=3 characters/i);
    expect(diagnostic(parameters, { name: 'abcdef', score: 5 })).toMatch(/name: .*<=5 characters/i);
    expect(diagnostic(parameters, { name: 'valid', score: 0 })).toMatch(/score: .*>=1/i);
    expect(diagnostic(parameters, { name: 'valid', score: 11 })).toMatch(/score: .*<=10/i);
  });

  it('reports array bounds while preserving optional fields', () => {
    const parameters = schema.object({
      tags: schema.array(schema.string(), { min: 1 }),
      note: schema.optional(schema.string()),
    });

    expect(diagnostic(parameters, { tags: [] })).toMatch(/tags: .*>=1 item/i);
    expect(validate(parameters, { tags: ['one'] })).toMatchObject({ ok: true });
    expect(diagnostic(parameters, { tags: ['one'], note: 42 })).toMatch(/note: .*expected string/i);
  });

  it('resets stateful regular expressions between parses', () => {
    const pattern = /^[a-z]+$/g;
    const parameters = schema.object({ slug: schema.string({ pattern }) });

    expect(validate(parameters, { slug: 'valid' })).toMatchObject({ ok: true });
    expect(validate(parameters, { slug: 'valid' })).toMatchObject({ ok: true });
    expect(diagnostic(parameters, { slug: 'INVALID' })).toMatch(/slug: .*match/i);
    expect(pattern.lastIndex).toBe(0);
  });

  it('requires object fields to be own properties', () => {
    const parameters = schema.object({ label: schema.string() });
    const inherited = Object.create({ label: 'not-owned' }) as Record<string, unknown>;

    expect(diagnostic(parameters, inherited)).toMatch(/label: .*required field/i);
  });

  it('preserves the JSON Schema contract used for provider tool declarations', () => {
    const parameters = schema.object({
      url: schema.string({ url: true, description: 'Target URL' }),
      retries: schema.optional(schema.number({ integer: true, min: 0, max: 3 })),
      tags: schema.array(schema.enum(['one', 'two'] as const), { min: 1 }),
      metadata: schema.record(schema.string({ pattern: /^[a-z]+$/ }), schema.unknown()),
    });

    expect(schema.toJSONSchema(parameters, { io: 'input' })).toEqual({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        url: { type: 'string', format: 'uri', description: 'Target URL' },
        retries: { type: 'integer', minimum: 0, maximum: 3 },
        tags: {
          type: 'array',
          items: { type: 'string', enum: ['one', 'two'] },
          minItems: 1,
        },
        metadata: {
          type: 'object',
          propertyNames: { type: 'string', pattern: '^[a-z]+$' },
          additionalProperties: {},
        },
      },
      required: ['url', 'tags', 'metadata'],
      additionalProperties: false,
    });
  });
});
