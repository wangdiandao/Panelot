/**
 * Plugin package format & install manifest (docs/08 §5).
 *
 * A Plugin is DATA, not code (MV3 CSP forbids remote code): its risk surface
 * is prompt injection + the MCP servers it introduces. Therefore rules.json
 * `allow` entries are downgraded to `ask` on install (docs/08 §5 trust boundary).
 */

import { z } from 'zod';

export const PluginManifest = z.object({
  name: z.string().min(1),
  version: z.string(),
  description: z.string().optional(),
  author: z.string().optional(),
  homepage: z.string().optional(),
  minPanelotVersion: z.string().optional(),
});
export type PluginManifest = z.infer<typeof PluginManifest>;

export interface PluginContents {
  manifest: PluginManifest;
  /** Each skill's raw SKILL.md text. */
  skills: string[];
  /** mcp.json server configs (parsed via parseMcpJson elsewhere). */
  mcpJson?: string;
  /** rules.json — suggested permission rules (allow downgraded to ask). */
  rules?: { tool: string; origin: string; verdict: 'allow' | 'deny' }[];
  /** site-prompts: { pattern: prompt }. */
  sitePrompts?: Record<string, string>;
}

export interface InstallPlan {
  manifest: PluginManifest;
  skillNames: string[];
  mcpServerNames: string[];
  ruleCount: number;
  /** Rules as they will actually be applied (allow → ask downgrade shown). */
  effectiveRules: { tool: string; origin: string; verdict: 'ask' | 'deny' }[];
  sitePromptPatterns: string[];
}

/**
 * Build the confirmation manifest shown before install (docs/08 §5). This is
 * pure — it computes what WILL be written so the UI can display it; nothing is
 * persisted here.
 */
export function buildInstallPlan(
  contents: PluginContents,
  parseSkillName: (raw: string) => string,
): InstallPlan {
  return {
    manifest: contents.manifest,
    skillNames: contents.skills.map(parseSkillName),
    mcpServerNames: contents.mcpJson ? extractMcpNames(contents.mcpJson) : [],
    ruleCount: contents.rules?.length ?? 0,
    // Trust boundary (docs/08 §5): a plugin-suggested `allow` is displayed and
    // stored as `ask` — i.e. NOT persisted as an allow rule, so it falls
    // through to policy (ask). Only `deny` rules are actually written.
    effectiveRules: (contents.rules ?? []).map((r) => ({
      tool: r.tool,
      origin: r.origin,
      verdict: r.verdict === 'allow' ? ('ask' as const) : ('deny' as const),
    })),
    sitePromptPatterns: Object.keys(contents.sitePrompts ?? {}),
  };
}

function extractMcpNames(mcpJson: string): string[] {
  try {
    const parsed = JSON.parse(mcpJson) as { mcpServers?: Record<string, unknown> };
    const servers = parsed.mcpServers ?? (parsed as Record<string, unknown>);
    return Object.keys(servers);
  } catch {
    return [];
  }
}
