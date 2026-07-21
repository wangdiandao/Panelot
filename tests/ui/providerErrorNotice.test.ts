import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProviderErrorNotice } from '../../src/ui/components/ProviderErrorNotice';
import { providerErrorFromVerifyResult } from '../../src/ui/settings/ProvidersPage';

describe('ProviderErrorNotice', () => {
  it('presents an engine protocol mismatch as a reload issue instead of a Provider issue', () => {
    const html = renderToStaticMarkup(
      createElement(ProviderErrorNotice, {
        error: {
          message: 'Reload required.',
          kind: 'engine_protocol',
        },
      }),
    );

    expect(html).toContain('扩展界面与后台版本不一致');
    expect(html).toContain('重载扩展即可恢复会话');
    expect(html).not.toContain('API 风格');
  });

  it('renders translated diagnostics and escapes upstream detail as plain text', () => {
    const html = renderToStaticMarkup(
      createElement(ProviderErrorNotice, {
        error: {
          message: 'unexpected HTTP 404',
          kind: 'protocol',
          details: {
            status: 404,
            reason: 'endpoint_not_found',
            upstreamCode: 'route_missing',
            upstreamMessage: '<b>Route not found</b>',
          },
        },
      }),
    );

    expect(html).toContain('HTTP 404 · route_missing · &lt;b&gt;Route not found&lt;/b&gt;');
    expect(html).toContain('&lt;b&gt;Route not found&lt;/b&gt;');
    expect(html).not.toContain('<b>Route not found</b>');
  });

  it('preserves structured Verify diagnostics and falls back for legacy failures', () => {
    expect(
      providerErrorFromVerifyResult({
        reachable: true,
        keyValid: true,
        streaming: false,
        toolUse: false,
        failure: 'protocol_mismatch',
        detail: 'Model Not Exist',
        details: {
          status: 400,
          reason: 'model_not_found',
          upstreamCode: 'model_not_found',
          upstreamMessage: 'Model Not Exist',
        },
      }),
    ).toMatchObject({
      message: 'Model Not Exist',
      kind: 'protocol',
      details: {
        status: 400,
        upstreamCode: 'model_not_found',
        upstreamMessage: 'Model Not Exist',
      },
    });

    const fallback = providerErrorFromVerifyResult({
      reachable: false,
      keyValid: false,
      streaming: false,
      toolUse: false,
      failure: 'unreachable',
      detail: 'internal transport text',
    });
    expect(fallback).toMatchObject({ kind: 'network' });
    expect(fallback?.message).not.toBe('internal transport text');
    expect(fallback).not.toHaveProperty('details');
  });
});
