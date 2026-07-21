// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';
import { composerMaxHeight, resizeTextareaToContent } from '../../src/ui/components/PromptInput';

function textareaWithHeight(scrollHeight: number): HTMLTextAreaElement {
  const textarea = document.createElement('textarea');
  textarea.style.minHeight = '44px';
  textarea.style.maxHeight = '160px';
  Object.defineProperty(textarea, 'scrollHeight', {
    configurable: true,
    value: scrollHeight,
  });
  document.body.append(textarea);
  return textarea;
}

describe('PromptInput responsive textarea sizing', () => {
  it('uses a denser height cap in the panel while respecting short viewports', () => {
    expect(composerMaxHeight('panel', 900)).toBe(256);
    expect(composerMaxHeight('panel', 400)).toBe(168);
    expect(composerMaxHeight('page', 900)).toBe(320);
    expect(composerMaxHeight('page', 400)).toBe(180);
  });

  it('grows to the rendered content height without adding an inner scrollbar', () => {
    const textarea = textareaWithHeight(112);

    resizeTextareaToContent(textarea);

    expect(textarea.style.height).toBe('112px');
    expect(textarea.style.overflowY).toBe('hidden');
    textarea.remove();
  });

  it('caps long drafts and enables scrolling once the viewport-safe limit is reached', () => {
    const textarea = textareaWithHeight(420);

    resizeTextareaToContent(textarea);

    expect(textarea.style.height).toBe('160px');
    expect(textarea.style.overflowY).toBe('auto');
    textarea.remove();
  });

  it('recomputes wrapped content after the available width changes', () => {
    const textarea = textareaWithHeight(300);

    resizeTextareaToContent(textarea);
    expect(textarea.style.height).toBe('160px');

    Object.defineProperty(textarea, 'scrollHeight', { configurable: true, value: 76 });
    resizeTextareaToContent(textarea);

    expect(textarea.style.height).toBe('76px');
    expect(textarea.style.overflowY).toBe('hidden');
    textarea.remove();
  });
});
