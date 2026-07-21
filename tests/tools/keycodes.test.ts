/** CDP key combinations and trusted input event payloads. */
import { describe, expect, it } from 'vitest';
import { keyEventSequence, parseKeyCombo } from '../../src/tools/cdp/keycodes';

describe('parseKeyCombo', () => {
  it('parses named keys with correct virtual key codes', () => {
    expect(parseKeyCombo('Enter')).toMatchObject({
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      text: '\r',
      modifiers: 0,
    });
    expect(parseKeyCombo('Tab')).toMatchObject({ windowsVirtualKeyCode: 9, text: '' });
    expect(parseKeyCombo('Escape')).toMatchObject({ windowsVirtualKeyCode: 27 });
    expect(parseKeyCombo('ArrowDown')).toMatchObject({ windowsVirtualKeyCode: 40 });
    expect(parseKeyCombo('F5')).toMatchObject({ windowsVirtualKeyCode: 116 });
  });

  it('parses modifier combos into the CDP bitmask (Alt=1 Ctrl=2 Meta=4 Shift=8)', () => {
    expect(parseKeyCombo('Control+a')).toMatchObject({
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
      modifiers: 2,
      text: '',
    });
    expect(parseKeyCombo('Shift+Tab')).toMatchObject({ windowsVirtualKeyCode: 9, modifiers: 8 });
    expect(parseKeyCombo('Control+Shift+p')).toMatchObject({ modifiers: 10 });
    expect(parseKeyCombo('Ctrl+c').modifiers).toBe(2);
    expect(parseKeyCombo('Meta+v').modifiers).toBe(4);
  });

  it('plain letters/digits keep their text; ctrl-combos suppress it', () => {
    expect(parseKeyCombo('a')).toMatchObject({ text: 'a', windowsVirtualKeyCode: 65 });
    expect(parseKeyCombo('5')).toMatchObject({ text: '5', code: 'Digit5' });
    expect(parseKeyCombo('Control+a').text).toBe('');
    // Shift alone still produces text (typed capital).
    expect(parseKeyCombo('Shift+a').text).toBe('a');
  });

  it('rejects unknown keys and modifier-only combos loudly', () => {
    expect(() => parseKeyCombo('Bogus')).toThrow(/未知按键/);
    expect(() => parseKeyCombo('Control')).toThrow(/只有修饰键/);
    expect(() => parseKeyCombo('Hyper+a')).toThrow(/未知修饰键/);
  });

  it('a bare uppercase letter carries the Shift modifier (physically Shift+letter)', () => {
    const a = parseKeyCombo('A');
    expect(a).toMatchObject({ key: 'A', code: 'KeyA', windowsVirtualKeyCode: 65, text: 'A' });
    expect(a.modifiers & 8).toBe(8); // Shift bit set so event.shiftKey matches
    // Lowercase stays unshifted.
    expect(parseKeyCombo('a').modifiers & 8).toBe(0);
  });

  it('shifted symbols use the physical base key code + Shift', () => {
    const q = parseKeyCombo('?');
    expect(q).toMatchObject({ key: '?', code: 'Slash', windowsVirtualKeyCode: 191, text: '?' });
    expect(q.modifiers & 8).toBe(8);
  });

  it('unshifted punctuation uses the OEM physical code + VK', () => {
    expect(parseKeyCombo('/')).toMatchObject({
      code: 'Slash',
      windowsVirtualKeyCode: 191,
      text: '/',
      modifiers: 0,
    });
    expect(parseKeyCombo('.')).toMatchObject({ code: 'Period', windowsVirtualKeyCode: 190 });
    expect(parseKeyCombo('-')).toMatchObject({ code: 'Minus', windowsVirtualKeyCode: 189 });
  });
});

describe('keyEventSequence', () => {
  it('printable keys: keyDown with text (native default action) then keyUp', () => {
    const seq = keyEventSequence(parseKeyCombo('Enter'));
    expect(seq).toHaveLength(2);
    expect(seq[0]!.params).toMatchObject({
      type: 'keyDown',
      text: '\r',
      windowsVirtualKeyCode: 13,
    });
    expect(seq[1]!.params).toMatchObject({ type: 'keyUp' });
  });

  it('control keys: rawKeyDown (no text) then keyUp', () => {
    const seq = keyEventSequence(parseKeyCombo('Escape'));
    expect(seq[0]!.params.type).toBe('rawKeyDown');
    expect(seq[0]!.params.text).toBeUndefined();
  });

  it('carries the modifier bitmask on both events', () => {
    const seq = keyEventSequence(parseKeyCombo('Control+a'));
    expect(seq[0]!.params.modifiers).toBe(2);
    expect(seq[1]!.params.modifiers).toBe(2);
  });
});
