/**
 * Settings search: bilingual keyword arrays route human vocabulary to the
 * right tab (OpenWebUI settings-search pattern, docs/development/ui.md §3.4).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { setLang } from '../../src/ui/i18n';
import { filterSections } from '../../src/ui/settings/SettingsPanel';

describe('filterSections', () => {
  beforeEach(() => setLang('en'));

  it('returns all sections for an empty query', () => {
    expect(filterSections('')).toHaveLength(11);
  });

  it('routes preset and agent-profile terms to model presets', () => {
    expect(filterSections('preset')).toContain('presets');
    expect(filterSections('system prompt')).toContain('presets');
  });
  it('routes domain instructions to site settings', () => {
    expect(filterSections('hostname')).toContain('sites');
  });
  it('routes upload and storage terms to attachments', () => {
    expect(filterSections('upload')).toContain('attachments');
  });
  it("routes '密钥' and 'key' to providers", () => {
    expect(filterSections('密钥')).toContain('providers');
    expect(filterSections('key')).toContain('providers');
  });
  it("routes '黑名单' and 'blacklist' to permissions", () => {
    expect(filterSections('黑名单')).toEqual(['permissions']);
    expect(filterSections('blacklist')).toEqual(['permissions']);
  });
  it("routes '导出' to data", () => {
    expect(filterSections('导出')).toContain('data');
  });
  it('matches the visible tab label too', () => {
    expect(filterSections('通用')).toContain('general');
  });
  it('empty result for gibberish', () => {
    expect(filterSections('qqqzzz')).toHaveLength(0);
  });
});
