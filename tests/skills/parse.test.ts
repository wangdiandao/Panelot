import { describe, expect, it } from 'vitest';
import {
  listSkillFileDependencies,
  parseSkill,
  parseSimpleYaml,
  skillMatchesUrl,
} from '../../src/skills/parse';

describe('parseSkill (docs/08 §1)', () => {
  it('parses Claude Code compatible frontmatter with panelot extensions', () => {
    const raw = `---
name: xhs-publisher
description: 将当前文章改写为小红书风格并发布。当用户要求发小红书时使用。
panelot:
  sites: ["*.xiaohongshu.com", "creator.xiaohongshu.com"]
  auto_suggest: true
  command: /xhs
  variables:
    - {key: tone, label: 语气, type: select, options: [活泼, 专业], default: 活泼}
---
# 指令正文
把文章改写为小红书风格。`;
    const { frontmatter, body } = parseSkill(raw);
    expect(frontmatter.name).toBe('xhs-publisher');
    expect(frontmatter.panelot?.sites).toEqual(['*.xiaohongshu.com', 'creator.xiaohongshu.com']);
    expect(frontmatter.panelot?.auto_suggest).toBe(true);
    expect(frontmatter.panelot?.command).toBe('/xhs');
    expect(frontmatter.panelot?.variables?.[0]).toMatchObject({
      key: 'tone',
      type: 'select',
      options: ['活泼', '专业'],
    });
    expect(body).toContain('把文章改写为小红书风格');
  });

  it('accepts a minimal skill (name + description only)', () => {
    const { frontmatter, body } = parseSkill(
      '---\nname: simple\ndescription: A simple skill.\n---\nDo the thing.',
    );
    expect(frontmatter.name).toBe('simple');
    expect(body).toBe('Do the thing.');
  });

  it('accepts CRLF files and reports referenced companion files', () => {
    const raw =
      '---\r\nname: bundled\r\ndescription: Uses references.\r\n---\r\nRead [policy](references/policy.md) then run `scripts/check.js`.';
    expect(parseSkill(raw).frontmatter.name).toBe('bundled');
    expect(listSkillFileDependencies(raw)).toEqual(['references/policy.md', 'scripts/check.js']);
  });

  it('preserves unknown Claude Code keys (passthrough) without erroring', () => {
    const { frontmatter } = parseSkill(
      '---\nname: cc\ndescription: x\nallowed-tools: [Read, Write]\n---\nbody',
    );
    expect((frontmatter as Record<string, unknown>)['allowed-tools']).toEqual(['Read', 'Write']);
  });

  it('rejects missing frontmatter', () => {
    expect(() => parseSkill('# just markdown')).toThrow(/frontmatter/);
  });

  it('rejects invalid name (not kebab-case)', () => {
    expect(() => parseSkill('---\nname: Bad Name\ndescription: x\n---\nbody')).toThrow(
      /frontmatter 无效/,
    );
  });

  it('rejects an invalid command format', () => {
    expect(() =>
      parseSkill('---\nname: x\ndescription: y\npanelot:\n  command: xhs\n---\nb'),
    ).toThrow();
  });
});

describe('parseSimpleYaml', () => {
  it('handles scalars, inline arrays, nested maps and bools/numbers', () => {
    const parsed = parseSimpleYaml(`name: test
count: 42
enabled: true
tags: [a, b, c]
nested:
  key: value
  flag: false`);
    expect(parsed).toMatchObject({
      name: 'test',
      count: 42,
      enabled: true,
      tags: ['a', 'b', 'c'],
      nested: { key: 'value', flag: false },
    });
  });
});

describe('skillMatchesUrl (docs/08 §2)', () => {
  it('matches subdomain wildcards and exact hosts', () => {
    expect(skillMatchesUrl(['*.xiaohongshu.com'], 'https://creator.xiaohongshu.com/x')).toBe(true);
    expect(skillMatchesUrl(['*.xiaohongshu.com'], 'https://xiaohongshu.com')).toBe(true);
    expect(skillMatchesUrl(['github.com'], 'https://github.com/foo')).toBe(true);
    expect(skillMatchesUrl(['github.com'], 'https://gitlab.com')).toBe(false);
    expect(skillMatchesUrl(undefined, 'https://x.com')).toBe(false);
  });
});
