/**
 * SKILL.md parsing (docs/08 §1) — Claude Code compatible frontmatter with a
 * `panelot` extension namespace. Unknown frontmatter keys are preserved
 * (passthrough) so Claude Code skills import without loss.
 */

import { schema, type Infer } from '../agent/schema';
import { CORE_SCHEMA, load } from 'js-yaml';

export const VariableDef = schema.object({
  key: schema.string(),
  label: schema.string(),
  type: schema.enum(['text', 'select', 'date', 'url']),
  options: schema.optional(schema.array(schema.string())),
  default: schema.optional(schema.string()),
  required: schema.optional(schema.boolean()),
});
export type VariableDef = Infer<typeof VariableDef>;

export const SkillFrontmatter = schema.looseObject({
  name: schema.string({
    pattern: /^[a-z0-9-]+$/,
    patternMessage: 'name must be kebab-case',
    max: 64,
  }),
  description: schema.string({ min: 1, max: 500 }),
  panelot: schema.optional(
    schema.object({
      sites: schema.optional(schema.array(schema.string())),
      auto_suggest: schema.optional(schema.boolean()),
      command: schema.optional(schema.string({ pattern: /^\/[a-z0-9:-]+$/ })),
      variables: schema.optional(schema.array(VariableDef)),
    }),
  ),
}); // Unknown Claude Code keys are preserved even when Panelot does not consume them.

export type SkillFrontmatter = Infer<typeof SkillFrontmatter>;

export interface ParsedSkill {
  frontmatter: SkillFrontmatter;
  body: string;
}

/**
 * Parse a SKILL.md string with YAML core types, then validate interoperable
 * fields while preserving unknown frontmatter keys.
 */
export function parseSkill(raw: string): ParsedSkill {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw.trim());
  if (!match) throw new Error('SKILL.md 缺少 YAML frontmatter（--- 包裹的头部）');

  const fm = parseSimpleYaml(match[1]!);
  const result = schema.safeParse(SkillFrontmatter, fm);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`SKILL.md frontmatter 无效: ${issues}`);
  }
  return { frontmatter: result.data, body: (match[2] ?? '').trim() };
}

export function listSkillFileDependencies(raw: string): string[] {
  const { body } = parseSkill(raw);
  const dependencies = new Set<string>();
  for (const match of body.matchAll(/\]\((?!https?:|#|mailto:)([^)]+)\)/gi)) {
    const path = match[1]?.split('#')[0]?.trim();
    if (path) dependencies.add(path);
  }
  for (const match of body.matchAll(/(?:^|[\s`'"])((?:scripts|references|assets)\/[\w./-]+)/gim)) {
    if (match[1]) dependencies.add(match[1]);
  }
  return [...dependencies].sort();
}

/**
 * Anchors and aliases are unnecessary here and are rejected so a small file
 * cannot expand into an unexpectedly large object graph.
 */
export function parseSimpleYaml(text: string): Record<string, unknown> {
  if (/(?:^|\s)[&*][a-z0-9_-]+/im.test(text)) {
    throw new Error('SKILL.md frontmatter 不允许 YAML anchors/aliases');
  }
  const value = load(text, { schema: CORE_SCHEMA, json: false, filename: 'SKILL.md' });
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('SKILL.md frontmatter 必须是 YAML mapping');
  }
  return value as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Site matching (docs/08 §2) via URLPattern where available.
// ---------------------------------------------------------------------------

export function skillMatchesUrl(sites: string[] | undefined, url: string): boolean {
  if (!sites || sites.length === 0) return false;
  for (const pattern of sites) {
    if (matchSite(pattern, url)) return true;
  }
  return false;
}

function matchSite(pattern: string, url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  // Strip scheme/path from the pattern; support leading *.
  const patternHost = pattern.replace(/^https?:\/\//, '').split('/')[0] ?? pattern;
  if (patternHost.startsWith('*.')) {
    const suffix = patternHost.slice(2);
    return host === suffix || host.endsWith(`.${suffix}`);
  }
  return host === patternHost;
}
