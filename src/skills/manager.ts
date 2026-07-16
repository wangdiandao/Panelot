import type { PanelotDB } from '../db/schema';
import type { SkillRecord } from '../db/types';
import { parseSkill } from './parse';
import { SkillRuntime } from './runtime';

/** Adds import and conflict-management operations to the shared Skills runtime. */
export class SkillManager extends SkillRuntime {
  constructor(db: PanelotDB) {
    super(db);
  }

  async importFromText(
    raw: string,
    source: SkillRecord['source'] = 'imported',
    sourceRef?: string,
    options: {
      conflict?: 'error' | 'overwrite' | 'rename';
      existingId?: string;
    } = {},
  ): Promise<SkillRecord> {
    let parsed = parseSkill(raw);
    let existing = await this.db.skills.where('name').equals(parsed.frontmatter.name).first();
    if (existing && existing.id !== options.existingId) {
      const conflict = options.conflict ?? 'error';
      if (conflict === 'error') throw new SkillNameConflictError(parsed.frontmatter.name);
      if (conflict === 'rename') {
        const name = await this.availableName(parsed.frontmatter.name);
        raw = raw.replace(/^(name\s*:\s*).+$/m, `$1${name}`);
        parsed = parseSkill(raw);
        existing = undefined;
      }
    } else if (options.existingId) {
      existing = await this.db.skills.get(options.existingId);
    }
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

  private async availableName(base: string): Promise<string> {
    for (let suffix = 2; suffix < 10_000; suffix++) {
      const candidate = `${base}-${suffix}`;
      if (!(await this.db.skills.where('name').equals(candidate).first())) return candidate;
    }
    throw new Error(`Unable to find an available name for ${base}`);
  }
}

export class SkillNameConflictError extends Error {
  constructor(readonly skillName: string) {
    super(`Skill "${skillName}" already exists`);
    this.name = 'SkillNameConflictError';
  }
}
