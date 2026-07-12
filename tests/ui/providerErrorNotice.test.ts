import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProviderErrorNotice } from '../../src/ui/components/ProviderErrorNotice';
import { providerErrorFromVerifyResult } from '../../src/ui/settings/ProvidersPage';

describe('ProviderErrorNotice', () => {
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
    expect(html).toContain('data-slot="alert-title"');
    expect(html).toContain('data-slot="alert-description"');
  });

  it('keeps long upstream detail wrap-safe instead of truncating it', () => {
    const detail = `failure-${'x'.repeat(300)}`;
    const html = renderToStaticMarkup(
      createElement(ProviderErrorNotice, {
        error: {
          message: 'response failed',
          kind: 'protocol',
          details: { upstreamMessage: detail },
        },
      }),
    );

    expect(html).toContain(detail);
    expect(html).toContain('break-words');
    expect(html).not.toContain('truncate');
  });

  it('fully wraps a long fallback summary without clamping the alert title', () => {
    const message = `unknown-${'fallback '.repeat(60)}`;
    const html = renderToStaticMarkup(
      createElement(ProviderErrorNotice, {
        error: { message },
      }),
    );

    expect(html).toContain(message.trim());
    expect(html).toContain('break-words');
    expect(html).toContain('whitespace-pre-wrap');
    expect(html).not.toContain('line-clamp-1');
    expect(html).not.toContain('truncate');
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
