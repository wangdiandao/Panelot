import { schema } from '../agent/schema';
import type { AnyAgentTool } from '../agent/tool';
import type { PanelotDB } from '../db/schema';
import type { SkillRecord } from '../db/types';
import type { SkillIndexEntry } from '../prompts/assemble';
import type { SkillFrontmatter } from './parse';
import { skillMatchesUrl } from './siteMatch';

export class SkillRuntime {
  constructor(protected db: PanelotDB) {}

  async list(): Promise<SkillRecord[]> {
    return this.db.skills.toArray();
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.db.skills.update(id, { enabled });
  }

  async remove(id: string): Promise<void> {
    await this.db.skills.delete(id);
  }

  async buildIndex(currentUrl?: string): Promise<SkillIndexEntry[]> {
    const skills = await this.db.skills.filter((skill) => skill.enabled).toArray();
    const entries: SkillIndexEntry[] = [];
    for (const skill of skills) {
      const frontmatter = skill.frontmatter as SkillFrontmatter;
      const sites = frontmatter.panelot?.sites;
      if (sites?.length && (!currentUrl || !skillMatchesUrl(sites, currentUrl))) continue;
      entries.push({ name: skill.name, description: frontmatter.description, sites });
    }
    return entries;
  }

  async suggestionsFor(url: string): Promise<SkillRecord[]> {
    const skills = await this.db.skills.filter((skill) => skill.enabled).toArray();
    return skills.filter((skill) => {
      const frontmatter = skill.frontmatter as SkillFrontmatter;
      return frontmatter.panelot?.auto_suggest && skillMatchesUrl(frontmatter.panelot.sites, url);
    });
  }

  async getBody(name: string): Promise<string | null> {
    const skill = await this.db.skills.where('name').equals(name).first();
    return skill?.enabled ? skill.body : null;
  }

  async getEnabled(name: string): Promise<SkillRecord | null> {
    const skill = await this.db.skills.where('name').equals(name).first();
    return skill?.enabled ? skill : null;
  }

  async resolveCommand(text: string): Promise<SkillRecord | null> {
    const match = /^\/([\w:-]+)/.exec(text.trim());
    const matchedToken = match?.[1];
    if (!matchedToken) return null;
    const token = matchedToken.toLowerCase();
    const skills = await this.db.skills.filter((skill) => skill.enabled).toArray();
    return (
      skills.find((skill) => {
        const frontmatter = skill.frontmatter as SkillFrontmatter;
        const command = frontmatter.panelot?.command?.replace(/^\//, '').toLowerCase();
        return skill.name.toLowerCase() === token || command === token;
      }) ?? null
    );
  }
}

export function createLoadSkillTool(
  runtime: Pick<SkillRuntime, 'getEnabled'>,
  getThreadId: () => string,
): AnyAgentTool {
  const loaded = new Map<string, Set<string>>();
  return {
    name: 'load_skill',
    label: 'Load Skill',
    description:
      'Load the full instructions of a skill by name. Call before executing any task matching a skill description.',
    parameters: schema.object({ name: schema.string() }),
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
        return {
          content: [
            { type: 'text', text: `技能 "${params.name}" 已加载（本会话内无需重复加载）。` },
          ],
        };
      }
      const skill = await runtime.getEnabled(params.name);
      if (!skill) return { content: [{ type: 'text', text: `未找到技能 "${params.name}"。` }] };
      threadLoaded.add(params.name);
      return {
        content: [{ type: 'text', text: `# Skill: ${params.name}\n\n${skill.body}` }],
        details: { activeSkillId: skill.id },
      };
    },
  };
}
