import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { ProviderStopNotice } from '../../src/ui/components/ProviderStopNotice';
import { setLang } from '../../src/ui/i18n';

afterEach(() => setLang('zh-CN'));

describe('ProviderStopNotice', () => {
  it('announces max-token truncation politely in English', () => {
    setLang('en');
    const html = renderToStaticMarkup(
      createElement(ProviderStopNotice, { stopReason: 'max_tokens' }),
    );

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('Response reached the output limit');
    expect(html).toContain('The response may be incomplete.');
  });

  it('renders the content-filter notice in Chinese', () => {
    setLang('zh-CN');
    const html = renderToStaticMarkup(
      createElement(ProviderStopNotice, { stopReason: 'content_filter' }),
    );

    expect(html).toContain('回复因内容过滤而停止');
    expect(html).toContain('原请求不会自动重放');
  });

  it.each(['end', 'interrupted', 'error', 'budget_pause', 'done'] as const)(
    'stays silent for %s',
    (stopReason) => {
      expect(renderToStaticMarkup(createElement(ProviderStopNotice, { stopReason }))).toBe('');
    },
  );
});
