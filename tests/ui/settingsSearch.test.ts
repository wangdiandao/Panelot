/**
 * Settings search: bilingual keyword arrays route human vocabulary to the
 * right tab (OpenWebUI settings-search pattern, docs/09 §3.4).
 */
import { describe, expect, it } from 'vitest';
import { filterSections } from '../../src/ui/settings/SettingsPanel';

describe('filterSections', () => {
  it('returns all sections for an empty query', () => {
    expect(filterSections('')).toHaveLength(7);
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
