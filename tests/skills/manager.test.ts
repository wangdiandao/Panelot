import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { PanelotDB } from '../../src/db/schema';
import { SkillManager } from '../../src/skills/manager';
import { createLoadSkillTool } from '../../src/skills/runtime';

let db: PanelotDB;
let manager: SkillManager;
let n = 0;

beforeEach(() => {
  db = new PanelotDB(`skill-test-${Date.now()}-${n++}`);
  manager = new SkillManager(db);
});

const skill = (name: string, opts?: { sites?: string; suggest?: boolean }) =>
  `---\nname: ${name}\ndescription: ${name} 的说明\n${opts?.sites ? `panelot:\n  sites: [${opts.sites}]\n  auto_suggest: ${opts.suggest ?? false}\n` : ''}---\n${name} 的正文指令`;

describe('SkillManager storage & disclosure (docs/08 §2)', () => {
  it('imports and lists skills; re-import updates in place', async () => {
    await manager.importFromText(skill('alpha'));
    await manager.importFromText(skill('alpha'), 'imported', undefined, { conflict: 'overwrite' });
    const list = await manager.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe('alpha');
  });

  it('builds a resident index, filtering site-scoped skills by current URL', async () => {
    await manager.importFromText(skill('global'));
    await manager.importFromText(skill('xhs', { sites: '"*.xiaohongshu.com"' }));

    const offSite = await manager.buildIndex('https://google.com');
    expect(offSite.map((e) => e.name)).toEqual(['global']); // site-scoped hidden

    const onSite = await manager.buildIndex('https://creator.xiaohongshu.com');
    expect(onSite.map((e) => e.name).sort()).toEqual(['global', 'xhs']);
  });

  it('respects the enabled flag in the index', async () => {
    const rec = await manager.importFromText(skill('toggle'));
    await manager.setEnabled(rec.id, false);
    expect(await manager.buildIndex()).toHaveLength(0);
  });

  it('surfaces auto_suggest skills for a matching URL', async () => {
    await manager.importFromText(skill('xhs', { sites: '"*.xiaohongshu.com"', suggest: true }));
    await manager.importFromText(skill('quiet', { sites: '"*.other.com"', suggest: false }));
    const suggestions = await manager.suggestionsFor('https://www.xiaohongshu.com/explore');
    expect(suggestions.map((s) => s.name)).toEqual(['xhs']);
  });
});

describe('resolveCommand (slash-command activation, docs/08 §4)', () => {
  it('matches "/name args" to the enabled skill by name', async () => {
    await manager.importFromText(skill('xhs-writer'));
    const hit = await manager.resolveCommand('/xhs-writer 写一篇笔记');
    expect(hit?.name).toBe('xhs-writer');
  });

  it('matches the panelot.command alias', async () => {
    await manager.importFromText(
      '---\nname: long-name\ndescription: d\npanelot:\n  command: /xhs\n---\nbody',
    );
    const hit = await manager.resolveCommand('/xhs hello');
    expect(hit?.name).toBe('long-name');
  });

  it('ignores disabled skills and non-command text', async () => {
    const rec = await manager.importFromText(skill('off'));
    await manager.setEnabled(rec.id, false);
    expect(await manager.resolveCommand('/off go')).toBeNull();
    expect(await manager.resolveCommand('plain /off text')).toBeNull();
    expect(await manager.resolveCommand('/unknown')).toBeNull();
  });
});

describe('load_skill tool (progressive disclosure, once per thread)', () => {
  it('returns the body on first call, then a cached notice', async () => {
    await manager.importFromText(skill('helper'));
    const tool = createLoadSkillTool(manager, () => 'thread-1');

    const first = await tool.execute(
      'c1',
      { name: 'helper' } as never,
      new AbortController().signal,
    );
    expect((first.content[0] as { text: string }).text).toContain('helper 的正文指令');

    const second = await tool.execute(
      'c2',
      { name: 'helper' } as never,
      new AbortController().signal,
    );
    expect((second.content[0] as { text: string }).text).toContain('已加载');
  });

  it('reports unknown skills without throwing', async () => {
    const tool = createLoadSkillTool(manager, () => 't');
    const result = await tool.execute(
      'c1',
      { name: 'nope' } as never,
      new AbortController().signal,
    );
    expect((result.content[0] as { text: string }).text).toContain('未找到');
  });
});
