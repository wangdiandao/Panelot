/**
 * SkillManager (docs/08 §2): storage, progressive disclosure (index in the
 * prompt, load_skill for the body), site-scoped index filtering.
 */

import type { PanelotDB } from '../db/schema';
import type { SkillRecord } from '../db/types';
import type { SkillIndexEntry } from '../prompts/assemble';
import type { AnyAgentTool } from '../agent/tool';
import { z } from 'zod';
import { parseSkill, skillMatchesUrl, type SkillFrontmatter } from './parse';

export class SkillManager {
  constructor(private db: PanelotDB) {}

  async importFromText(raw: string, source: SkillRecord['source'] = 'imported', sourceRef?: string): Promise<SkillRecord> {
    const parsed = parseSkill(raw);
    const existing = await this.db.skills.where('name').equals(parsed.frontmatter.name).first();
    const now = Date.now();
    const record: SkillRecord = {
      id: existing?.id ?? crypto.randomUUID(),
      name: parsed.frontmatter.name,
      raw,
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      enabled: existing?.enabled ?? true,
      source,
      sourceRef,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await this.db.skills.put(record);
    return record;
  }

  async list(): Promise<SkillRecord[]> {
    return this.db.skills.toArray();
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.db.skills.update(id, { enabled });
  }

  async remove(id: string): Promise<void> {
    await this.db.skills.delete(id);
  }

  /**
   * Build the always-resident Skills index for the system prompt (docs/08 §2
   * step 1). Site-scoped skills only appear when the current tab matches —
   * saving prompt space.
   */
  async buildIndex(currentUrl?: string): Promise<SkillIndexEntry[]> {
    const skills = await this.db.skills.filter((s) => s.enabled).toArray();
    const entries: SkillIndexEntry[] = [];
    for (const skill of skills) {
      const fm = skill.frontmatter as SkillFrontmatter;
      const sites = fm.panelot?.sites;
      if (sites?.length) {
        if (!currentUrl || !skillMatchesUrl(sites, currentUrl)) continue;
      }
      entries.push({ name: skill.name, description: fm.description, sites });
    }
    return entries;
  }

  /** Skills whose auto_suggest matches the current URL (docs/08 §2 step 4). */
  async suggestionsFor(url: string): Promise<SkillRecord[]> {
    const skills = await this.db.skills.filter((s) => s.enabled).toArray();
    return skills.filter((s) => {
      const fm = s.frontmatter as SkillFrontmatter;
      return fm.panelot?.auto_suggest && skillMatchesUrl(fm.panelot.sites, url);
    });
  }

  async getBody(name: string): Promise<string | null> {
    const skill = await this.db.skills.where('name').equals(name).first();
    return skill?.body ?? null;
  }

  /**
   * Resolve a leading slash command ("/xhs …") to an enabled skill — by
   * skill name or by its panelot.command alias. Null when nothing matches
   * (the message is then sent as plain text).
   */
  async resolveCommand(text: string): Promise<SkillRecord | null> {
    const m = /^\/([\w:-]+)/.exec(text.trim());
    if (!m) return null;
    const token = m[1]!.toLowerCase();
    const skills = await this.db.skills.filter((s) => s.enabled).toArray();
    return (
      skills.find((s) => {
        const fm = s.frontmatter as SkillFrontmatter;
        const command = fm.panelot?.command?.replace(/^\//, '').toLowerCase();
        return s.name.toLowerCase() === token || command === token;
      }) ?? null
    );
  }
}

// ---------------------------------------------------------------------------
// load_skill tool (docs/08 §2 step 2-3) — progressive disclosure
// ---------------------------------------------------------------------------

export function createLoadSkillTool(manager: SkillManager, getThreadId: () => string): AnyAgentTool {
  // Per-thread "already loaded" guard so a skill body is only injected once.
  const loaded = new Map<string, Set<string>>();
  return {
    name: 'load_skill',
    label: '加载技能',
    description: 'Load the full instructions of a skill by name. Call before executing any task matching a skill description.',
    parameters: z.object({ name: z.string() }),
    level: 'builtin',
    effects: 'read',
    execute: async (_id, params: { name: string }) => {
      const threadId = getThreadId();
      let threadLoaded = loaded.get(threadId);
      if (!threadLoaded) {
        threadLoaded = new Set();
        loaded.set(threadId, threadLoaded);
      }
      if (threadLoaded.has(params.name)) {
        return { content: [{ type: 'text', text: `技能 "${params.name}" 已加载（本会话内无需重复加载）。` }] };
      }
      const body = await manager.getBody(params.name);
      if (!body) return { content: [{ type: 'text', text: `未找到技能 "${params.name}"。` }] };
      threadLoaded.add(params.name);
      return { content: [{ type: 'text', text: `# Skill: ${params.name}\n\n${body}` }] };
    },
  };
}
