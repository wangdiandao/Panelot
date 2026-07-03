import { describe, expect, it } from 'vitest';
import { buildInstallPlan, PluginManifest, type PluginContents } from '../../src/plugins/manifest';
import { parseSkill } from '../../src/skills/parse';

const skillName = (raw: string) => parseSkill(raw).frontmatter.name;

describe('buildInstallPlan (docs/08 §5)', () => {
  const contents: PluginContents = {
    manifest: { name: 'shopping-helper', version: '1.0.0', description: '购物助手' },
    skills: [
      '---\nname: price-compare\ndescription: 比价\n---\n比价指令',
      '---\nname: coupon-finder\ndescription: 找券\n---\n找券指令',
    ],
    mcpJson: JSON.stringify({ mcpServers: { prices: { url: 'https://mcp.prices.example/mcp' } } }),
    rules: [
      { tool: 'click', origin: 'https://shop.example.com', verdict: 'allow' },
      { tool: 'run_javascript', origin: '*', verdict: 'deny' },
    ],
    sitePrompts: { 'shop.example.com': '优先展示带图评价' },
  };

  it('lists everything that will be written', () => {
    const plan = buildInstallPlan(contents, skillName);
    expect(plan.skillNames).toEqual(['price-compare', 'coupon-finder']);
    expect(plan.mcpServerNames).toEqual(['prices']);
    expect(plan.ruleCount).toBe(2);
    expect(plan.sitePromptPatterns).toEqual(['shop.example.com']);
  });

  it('downgrades plugin-suggested allow rules to ask (trust boundary)', () => {
    const plan = buildInstallPlan(contents, skillName);
    const clickRule = plan.effectiveRules.find((r) => r.tool === 'click')!;
    expect(clickRule.verdict).toBe('ask'); // NOT allow
    const denyRule = plan.effectiveRules.find((r) => r.tool === 'run_javascript')!;
    expect(denyRule.verdict).toBe('deny'); // deny is preserved
  });

  it('validates the manifest schema', () => {
    expect(PluginManifest.safeParse({ name: 'x', version: '1.0.0' }).success).toBe(true);
    expect(PluginManifest.safeParse({ version: '1.0.0' }).success).toBe(false);
  });
});
