import { describe, expect, it } from 'vitest';
import { normalizeEndpointUrl, validateEndpointUrl } from '../../src/security/endpointUrl';

describe('endpoint URL policy', () => {
  it.each([
    'https://api.example.com/v1',
    'https://localhost:8443/mcp',
    'http://localhost:11434/v1',
    'http://127.0.0.1:1234/v1',
    'http://[::1]:3000/mcp',
  ])('accepts a permitted endpoint: %s', (value) => {
    expect(validateEndpointUrl(value).protocol).toMatch(/^https?:$/);
  });

  it.each([
    'http://api.example.com/v1',
    'http://localhost.evil.example/mcp',
    'http://127.0.0.2:1234/v1',
    'http://127.1:1234/v1',
    'http://2130706433:1234/v1',
    'http://0x7f000001:1234/v1',
    'https://user:password@api.example.com/v1',
    'https://@api.example.com/v1',
    'https://api.example.com/v1#credentials',
    'https://api.example.com/v1#',
    'ftp://api.example.com/v1',
    'not a valid URL',
  ])('rejects an unsafe endpoint: %s', (value) => {
    expect(() => validateEndpointUrl(value)).toThrow();
  });

  it('defaults schemeless remote endpoints to HTTPS and loopback endpoints to HTTP', () => {
    expect(
      normalizeEndpointUrl('api.example.com/v1///', {
        allowImplicitScheme: true,
        stripTrailingSlashes: true,
      }),
    ).toBe('https://api.example.com/v1');
    expect(
      normalizeEndpointUrl('localhost:11434/v1/', {
        allowImplicitScheme: true,
        stripTrailingSlashes: true,
      }),
    ).toBe('http://localhost:11434/v1');
  });

  it('can require HTTPS even when a URL points at loopback', () => {
    expect(() => validateEndpointUrl('http://localhost/oauth', { requireHttps: true })).toThrow(
      /HTTPS/,
    );
  });
});
