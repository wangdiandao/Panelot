/**
 * SKILL.md parsing (docs/08 §1) — Claude Code compatible frontmatter with a
 * `panelot` extension namespace. Unknown frontmatter keys are preserved
 * (passthrough) so Claude Code skills import without loss.
 */

import { z } from 'zod';

export const VariableDef = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(['text', 'select', 'date', 'url']),
  options: z.array(z.string()).optional(),
  default: z.string().optional(),
  required: z.boolean().optional(),
});
export type VariableDef = z.infer<typeof VariableDef>;

export const SkillFrontmatter = z
  .object({
    name: z.string().regex(/^[a-z0-9-]+$/, 'name must be kebab-case').max(64),
    description: z.string().min(1).max(500),
    panelot: z
      .object({
        sites: z.array(z.string()).optional(),
        auto_suggest: z.boolean().optional(),
        command: z.string().regex(/^\/[a-z0-9:-]+$/).optional(),
        variables: z.array(VariableDef).optional(),
      })
      .optional(),
  })
  .passthrough(); // keep Claude Code's allowed-tools etc. (V1 ignores, doesn't error)

export type SkillFrontmatter = z.infer<typeof SkillFrontmatter>;

export interface ParsedSkill {
  frontmatter: SkillFrontmatter;
  body: string;
}

/**
 * Parse a SKILL.md string. Minimal YAML frontmatter parser (flat keys +
 * one level of nesting + inline arrays) — avoids a YAML dependency for the
 * small, well-specified schema. Throws on malformed frontmatter or schema
 * violations (surfaced to the user at import time).
 */
export function parseSkill(raw: string): ParsedSkill {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw.trim());
  if (!match) throw new Error('SKILL.md 缺少 YAML frontmatter（--- 包裹的头部）');

  const fm = parseSimpleYaml(match[1]!);
  const result = SkillFrontmatter.safeParse(fm);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`SKILL.md frontmatter 无效: ${issues}`);
  }
  return { frontmatter: result.data, body: (match[2] ?? '').trim() };
}

/**
 * Tiny YAML subset: `key: value`, nested blocks under a bare `key:`, inline
 * arrays `[a, b]`, and `- {k: v, ...}` list items. Enough for SKILL.md.
 */
export function parseSimpleYaml(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const lines = text.split('\n').filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const indent = line.length - line.trimStart().length;
    if (indent > 0) {
      i++;
      continue; // handled by the parent block below
    }
    const colon = line.indexOf(':');
    if (colon === -1) {
      i++;
      continue;
    }
    const key = line.slice(0, colon).trim();
    const rest = line.slice(colon + 1).trim();

    if (rest === '') {
      // Nested block: collect indented children.
      const block: string[] = [];
      i++;
      while (i < lines.length && lines[i]!.length - lines[i]!.trimStart().length > 0) {
        block.push(lines[i]!);
        i++;
      }
      root[key] = parseBlock(block);
    } else {
      root[key] = parseScalar(rest);
      i++;
    }
  }
  return root;
}

function parseBlock(lines: string[]): unknown {
  // List of objects: "- {k: v}" or "- key: val".
  if (lines.every((l) => l.trim().startsWith('-'))) {
    return lines.map((l) => {
      const item = l.trim().slice(1).trim();
      if (item.startsWith('{')) return parseInlineObject(item);
      return parseScalar(item);
    });
  }
  // Nested map: reduce indent and recurse.
  const minIndent = Math.min(...lines.map((l) => l.length - l.trimStart().length));
  const dedented = lines.map((l) => l.slice(minIndent)).join('\n');
  return parseSimpleYaml(dedented);
}

function parseInlineObject(text: string): Record<string, unknown> {
  const inner = text.replace(/^\{|\}$/g, '').trim();
  const obj: Record<string, unknown> = {};
  for (const pair of splitTopLevel(inner)) {
    const colon = pair.indexOf(':');
    if (colon === -1) continue;
    obj[pair.slice(0, colon).trim()] = parseScalar(pair.slice(colon + 1).trim());
  }
  return obj;
}

/** Split on commas not inside [] or {}. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function parseScalar(value: string): unknown {
  const v = value.trim();
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return splitTopLevel(inner).map((x) => parseScalar(x));
  }
  if (v.startsWith('{') && v.endsWith('}')) return parseInlineObject(v);
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
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
