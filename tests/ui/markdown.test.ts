// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { splitUnclosedFence } from '../../src/ui/components/Markdown';

describe('splitUnclosedFence (docs/09 §4.1 rule 1)', () => {
  it('passes balanced content through untouched', () => {
    const md = 'text\n```js\ncode\n```\nmore';
    expect(splitUnclosedFence(md)).toEqual({ closed: md, openTail: null });
  });

  it('splits a trailing unclosed fence for plain-pre rendering', () => {
    const md = 'intro\n```python\nprint(1)\nprint(2)';
    const { closed, openTail } = splitUnclosedFence(md);
    expect(closed).toBe('intro\n');
    expect(openTail).toBe('```python\nprint(1)\nprint(2)');
  });

  it('handles multiple balanced blocks followed by one open block', () => {
    const md = '```a\nx\n```\nmid\n```b\ny';
    const { closed, openTail } = splitUnclosedFence(md);
    expect(closed).toBe('```a\nx\n```\nmid\n');
    expect(openTail).toBe('```b\ny');
  });

  it('does not treat inline backticks as fences', () => {
    const md = 'use `code` inline';
    expect(splitUnclosedFence(md).openTail).toBeNull();
  });
});
