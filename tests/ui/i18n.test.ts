// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getLang, setLang, t } from '../../src/ui/i18n';

function resetI18nState(): void {
  setLang('en');
  document.documentElement.lang = 'en';
}

describe('i18n', () => {
  beforeEach(resetI18nState);
  afterEach(resetI18nState);

  it('keeps the document language in sync with the active language', () => {
    setLang('zh-CN');
    expect(getLang()).toBe('zh-CN');
    expect(document.documentElement.lang).toBe('zh-CN');

    setLang('en');
    expect(getLang()).toBe('en');
    expect(document.documentElement.lang).toBe('en');
  });

  it('defines the permission switch accessible-label translation', () => {
    setLang('zh-CN');
    const zh = t('perm.switch');

    setLang('en');
    const en = t('perm.switch');

    expect(zh).toBe('权限模式');
    expect(en).toBe('Permission mode');
  });

  it('returns the active translation immediately after switching languages', () => {
    setLang('zh-CN');
    expect(t('app.settings')).toBe('设置');

    setLang('en');
    expect(t('app.settings')).toBe('Settings');
  });
});
