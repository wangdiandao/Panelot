/**
 * detectTrigger contract (docs/09 §5): @ and / fire at line start or after
 * whitespace only (ChatGPT rule); {{ fires anywhere; caret-anchored.
 */
import { describe, expect, it } from 'vitest';
import { detectTrigger } from '../../src/ui/components/TriggerMenu';

const at = (text: string, caret = text.length) => detectTrigger(text, caret);

describe('detectTrigger', () => {
  it('@ fires at line start', () => {
    expect(at('@')).toEqual({ kind: '@', start: 0, query: '' });
    expect(at('@pa')).toEqual({ kind: '@', start: 0, query: 'pa' });
  });

  it('@ fires after whitespace', () => {
    expect(at('总结 @页面')).toMatchObject({ kind: '@', query: '页面' });
    expect(at('line1\n@x')).toMatchObject({ kind: '@', query: 'x' });
  });

  it('@ does NOT fire mid-word (email addresses)', () => {
    expect(at('user@example.com')).toBeNull();
  });

  it('/ fires at line start with kebab query', () => {
    expect(at('/cle')).toEqual({ kind: '/', start: 0, query: 'cle' });
  });

  it('/ does NOT fire inside URLs', () => {
    expect(at('https://example.com/path')).toBeNull();
  });

  it('{{ fires anywhere and captures the variable prefix', () => {
    expect(at('日期是{{CUR')).toMatchObject({ kind: '{{', query: 'CUR' });
    expect(at('{{')).toMatchObject({ kind: '{{', query: '' });
  });

  it('caret position anchors detection (typing mid-text)', () => {
    const text = '@page 后面还有内容';
    expect(detectTrigger(text, 5)).toMatchObject({ kind: '@', query: 'page' });
    expect(detectTrigger(text, text.length)).toBeNull();
  });

  it('closed braces do not trigger', () => {
    expect(at('{{PAGE_URL}} 之后')).toBeNull();
  });
});
