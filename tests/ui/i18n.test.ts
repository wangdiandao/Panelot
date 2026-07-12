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

  it('defines bilingual summaries and guidance for every provider diagnosis', () => {
    const diagnoses = [
      'invalid_key',
      'permission_denied',
      'quota_exceeded',
      'endpoint_not_found',
      'model_not_found',
      'invalid_request',
      'upstream_error',
      'response_format',
    ];
    const broadKinds = [
      'auth',
      'rate_limit',
      'overloaded',
      'context_too_long',
      'content_filter',
      'network',
      'protocol',
    ];
    const keys = [
      ...diagnoses.flatMap((reason) => [`error.reason.${reason}`, `error.guidance.${reason}`]),
      ...broadKinds.flatMap((kind) => [`error.${kind}`, `error.guidance.${kind}`]),
    ];

    for (const key of keys) {
      setLang('zh-CN');
      expect(t(key), `${key} zh-CN`).not.toBe(key);
      setLang('en');
      expect(t(key), `${key} en`).not.toBe(key);
    }
  });
});
