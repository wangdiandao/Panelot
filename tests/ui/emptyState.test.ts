/**
 * EmptyState pure helpers: greeting buckets and page-type URL heuristics.
 * (Draft-filtering was removed by owner decision 2026-07-05 — the list is a
 * short static menu, max 4 entries, no scrollbar.)
 */
import { describe, expect, it } from 'vitest';
import { greetingKey, pageSuggestion } from '../../src/ui/components/EmptyState';

describe('greetingKey', () => {
  it('maps hours to time-of-day buckets', () => {
    expect(greetingKey(8)).toBe('empty.morning');
    expect(greetingKey(14)).toBe('empty.afternoon');
    expect(greetingKey(20)).toBe('empty.evening');
    expect(greetingKey(2)).toBe('empty.evening');
  });
});

describe('pageSuggestion', () => {
  it('detects video pages', () => {
    expect(pageSuggestion('https://www.youtube.com/watch?v=1').title).toBeTruthy();
    expect(pageSuggestion('https://www.youtube.com/watch?v=1')).not.toEqual(pageSuggestion('https://example.com/a'));
  });
  it('detects PDFs and GitHub repos', () => {
    expect(pageSuggestion('https://x.com/paper.pdf')).not.toEqual(pageSuggestion('https://example.com'));
    expect(pageSuggestion('https://github.com/foo/bar')).not.toEqual(pageSuggestion('https://example.com'));
  });
  it('falls back to a generic page suggestion', () => {
    expect(pageSuggestion(undefined).title).toBeTruthy();
  });
});
