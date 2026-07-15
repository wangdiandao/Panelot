// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootstrapLanguage, getLang, setLang, subscribeLang, t } from '../../src/ui/i18n';
import {
  permissionPolicyLabel,
  permissionRuleSourceLabel,
} from '../../src/ui/settings/PermissionsPage';

function resetI18nState(): void {
  setLang('en');
  document.documentElement.lang = 'en';
}

describe('i18n', () => {
  beforeEach(resetI18nState);
  afterEach(() => {
    resetI18nState();
    vi.unstubAllGlobals();
  });

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

  it('bootstraps persisted language before use and follows cross-context changes', async () => {
    let storageListener: (
      changes: Record<string, { newValue?: unknown }>,
      area: string,
    ) => void = () => {};
    const removeListener = vi.fn();
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async () => ({ global_settings: { language: 'en' } })),
        },
        onChanged: {
          addListener: vi.fn((listener) => {
            storageListener = listener;
          }),
          removeListener,
        },
      },
    });

    const stop = await bootstrapLanguage();
    expect(getLang()).toBe('en');
    expect(document.documentElement.lang).toBe('en');

    storageListener({ global_settings: { newValue: { language: 'zh-CN' } } }, 'local');
    expect(getLang()).toBe('zh-CN');
    expect(document.documentElement.lang).toBe('zh-CN');
    stop();
    expect(removeListener).toHaveBeenCalledOnce();
  });

  it('notifies visible React consumers when the language changes', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeLang(listener);
    setLang('en');
    setLang('zh-CN');
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
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

  it('defines bilingual notices for non-natural provider completion reasons', () => {
    const keys = [
      'completion.maxTokens.title',
      'completion.maxTokens.description',
      'completion.contentFilter.title',
      'completion.contentFilter.description',
    ];

    for (const key of keys) {
      setLang('zh-CN');
      expect(t(key), `${key} zh-CN`).not.toBe(key);
      setLang('en');
      expect(t(key), `${key} en`).not.toBe(key);
    }
  });

  it('provides bilingual labels for every settings section and primary empty state', () => {
    const keys = [
      'settings.section.attachments',
      'settings.section.sites',
      'settings.section.presets',
      'settings.section.general',
      'settings.section.providers',
      'settings.section.permissions',
      'settings.section.skills',
      'settings.section.plugins',
      'settings.section.mcp',
      'settings.section.data',
      'settings.section.about',
      'settings.attachments.emptyTitle',
      'settings.sites.emptyTitle',
      'settings.presets.emptyTitle',
      'settings.providers.emptyTitle',
      'settings.skills.emptyTitle',
      'settings.plugins.emptyTitle',
      'settings.mcp.emptyTitle',
    ];

    for (const key of keys) {
      setLang('zh-CN');
      expect(t(key), `${key} zh-CN`).not.toBe(key);
      setLang('en');
      expect(t(key), `${key} en`).not.toBe(key);
    }
  });

  it('localizes protocol values for display without changing the stored values', () => {
    const stored = {
      policies: ['always', 'untrusted', 'auto'] as const,
      sources: ['user_setting', 'approval_persist', 'plugin_default'] as const,
    };
    const before = JSON.stringify(stored);

    for (const lang of ['zh-CN', 'en'] as const) {
      setLang(lang);
      for (const policy of stored.policies) {
        expect(permissionPolicyLabel(policy)).not.toBe(policy);
      }
      for (const source of stored.sources) {
        expect(permissionRuleSourceLabel(source)).not.toBe(source);
      }
    }
    expect(JSON.stringify(stored)).toBe(before);
  });
});
