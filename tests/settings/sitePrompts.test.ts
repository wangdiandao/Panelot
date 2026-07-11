import { describe, expect, it } from 'vitest';
import { normalizeSiteInstructions, siteInstructionMatches } from '../../src/settings/sitePrompts';

describe('site instructions', () => {
  it('matches exact hosts and wildcard subdomains without suffix confusion', () => {
    expect(siteInstructionMatches('example.com', 'https://example.com/a')).toBe(true);
    expect(siteInstructionMatches('example.com', 'https://evil-example.com/a')).toBe(false);
    expect(siteInstructionMatches('*.example.com', 'https://docs.example.com/a')).toBe(true);
    expect(siteInstructionMatches('*.example.com', 'https://example.com/a')).toBe(true);
  });

  it('normalizes entries and rejects duplicate or URL-shaped patterns', () => {
    expect(
      normalizeSiteInstructions([{ pattern: '  *.Example.com. ', prompt: '  Prefer tables.  ' }]),
    ).toEqual([{ pattern: '*.example.com', prompt: 'Prefer tables.' }]);
    expect(() =>
      normalizeSiteInstructions([
        { pattern: 'example.com', prompt: 'a' },
        { pattern: 'EXAMPLE.COM', prompt: 'b' },
      ]),
    ).toThrow(/duplicate/i);
    expect(() =>
      normalizeSiteInstructions([{ pattern: 'https://example.com', prompt: 'a' }]),
    ).toThrow(/hostname/i);
  });
});
