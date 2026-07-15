import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { FilePickerButton } from '../../src/ui/components/FilePickerButton';

describe('FilePickerButton', () => {
  it('associates a labelled file input with a keyboard-operable button', () => {
    const html = renderToStaticMarkup(
      createElement(FilePickerButton, {
        id: 'skill-file',
        label: 'Import skill file',
        accept: '.md',
        onFile: vi.fn(),
      }),
    );

    expect(html).toContain('for="skill-file"');
    expect(html).toContain('id="skill-file"');
    expect(html).toContain('type="file"');
    expect(html).toContain('accept=".md"');
    expect(html).toContain('aria-controls="skill-file"');
    expect(html).toContain('<button');
  });

  it('disables both the visible trigger and the file input', () => {
    const html = renderToStaticMarkup(
      createElement(FilePickerButton, {
        id: 'plugin-zip',
        label: 'Choose plugin ZIP',
        disabled: true,
        onFile: vi.fn(),
      }),
    );

    expect(html.match(/disabled=""/g)).toHaveLength(2);
  });
});
