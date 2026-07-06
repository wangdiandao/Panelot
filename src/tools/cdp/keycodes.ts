/**
 * Key combo parsing + CDP Input.dispatchKeyEvent payload construction.
 * Follows Playwright's dispatch sequence: rawKeyDown (with virtual key code
 * and modifiers) → char (printable keys only) → keyUp. Synthetic KeyboardEvent
 * in the isolated world CANNOT trigger native behavior (form submit, focus
 * move, dialog dismiss) — only trusted CDP input can, which is why press_key
 * routes through here.
 */

export interface KeyPayload {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  /** Printable text produced by the key (empty for control keys). */
  text: string;
  /** CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8. */
  modifiers: number;
}

/** Named keys → { code, vk, text? }. */
const NAMED_KEYS: Record<string, { code: string; vk: number; text?: string }> = {
  Enter: { code: 'Enter', vk: 13, text: '\r' },
  Tab: { code: 'Tab', vk: 9 },
  Escape: { code: 'Escape', vk: 27 },
  Backspace: { code: 'Backspace', vk: 8 },
  Delete: { code: 'Delete', vk: 46 },
  ArrowLeft: { code: 'ArrowLeft', vk: 37 },
  ArrowUp: { code: 'ArrowUp', vk: 38 },
  ArrowRight: { code: 'ArrowRight', vk: 39 },
  ArrowDown: { code: 'ArrowDown', vk: 40 },
  Home: { code: 'Home', vk: 36 },
  End: { code: 'End', vk: 35 },
  PageUp: { code: 'PageUp', vk: 33 },
  PageDown: { code: 'PageDown', vk: 34 },
  Insert: { code: 'Insert', vk: 45 },
  ' ': { code: 'Space', vk: 32, text: ' ' },
  Space: { code: 'Space', vk: 32, text: ' ' },
};
for (let f = 1; f <= 12; f++) NAMED_KEYS[`F${f}`] = { code: `F${f}`, vk: 111 + f };

const MODIFIER_BITS: Record<string, number> = {
  Alt: 1,
  Control: 2,
  Ctrl: 2,
  Meta: 4,
  Cmd: 4,
  Command: 4,
  Shift: 8,
};

const SHIFTED_SYMBOLS: Record<string, string> = {
  '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0',
  '_': '-', '+': '=', '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/', '~': '`',
};

/** Punctuation → physical code + US-layout virtual key code (VK_OEM_*). */
const SYMBOL_KEY: Record<string, { code: string; vk: number }> = {
  '-': { code: 'Minus', vk: 189 }, '=': { code: 'Equal', vk: 187 },
  '[': { code: 'BracketLeft', vk: 219 }, ']': { code: 'BracketRight', vk: 221 },
  '\\': { code: 'Backslash', vk: 220 }, ';': { code: 'Semicolon', vk: 186 },
  "'": { code: 'Quote', vk: 222 }, ',': { code: 'Comma', vk: 188 },
  '.': { code: 'Period', vk: 190 }, '/': { code: 'Slash', vk: 191 },
  '`': { code: 'Backquote', vk: 192 },
};

/**
 * Parse a combo like 'Control+a', 'Enter', 'Shift+Tab' into a CDP payload.
 * Throws on unknown named keys so the model gets a clear error instead of a
 * key that silently does nothing.
 */
export function parseKeyCombo(combo: string): KeyPayload {
  const parts = combo.split('+').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error(`无效按键: "${combo}"`);

  let modifiers = 0;
  // Everything except the last part must be a modifier.
  for (const part of parts.slice(0, -1)) {
    const bit = MODIFIER_BITS[part];
    if (bit === undefined) throw new Error(`未知修饰键: "${part}"（支持 Control/Alt/Shift/Meta）`);
    modifiers |= bit;
  }
  const last = parts[parts.length - 1]!;

  // A trailing modifier alone ('Control') is also valid-ish — treat as error
  // to keep the model honest about what it's pressing.
  if (parts.length === 1 && MODIFIER_BITS[last] !== undefined) {
    throw new Error(`"${combo}" 只有修饰键，没有实际按键`);
  }

  const named = NAMED_KEYS[last];
  if (named) {
    return { key: last === 'Space' ? ' ' : last, code: named.code, windowsVirtualKeyCode: named.vk, text: modifiers & ~8 ? '' : (named.text ?? ''), modifiers };
  }

  if (last.length === 1) {
    const ch = last;
    const isLetter = /[a-zA-Z]/.test(ch);
    const isDigit = /[0-9]/.test(ch);
    const upper = ch.toUpperCase();
    const shiftedBase = SHIFTED_SYMBOLS[ch];
    const nonShiftMod = (modifiers & ~8) !== 0; // Ctrl/Alt/Meta suppress text
    if (isLetter) {
      const vk = upper.charCodeAt(0);
      // An uppercase letter is physically Shift+letter — set the Shift bit so
      // event.shiftKey matches the produced character.
      const mods = /[A-Z]/.test(ch) ? modifiers | 8 : modifiers;
      return { key: ch, code: `Key${upper}`, windowsVirtualKeyCode: vk, text: nonShiftMod ? '' : ch, modifiers: mods };
    }
    if (isDigit) {
      return { key: ch, code: `Digit${ch}`, windowsVirtualKeyCode: ch.charCodeAt(0), text: nonShiftMod ? '' : ch, modifiers };
    }
    if (shiftedBase) {
      // Shifted symbol (e.g. '?'): Shift + the physical base key's code/VK.
      const phys = SYMBOL_KEY[shiftedBase] ?? { code: /[0-9]/.test(shiftedBase) ? `Digit${shiftedBase}` : `Key${shiftedBase.toUpperCase()}`, vk: shiftedBase.toUpperCase().charCodeAt(0) };
      return { key: ch, code: phys.code, windowsVirtualKeyCode: phys.vk, text: nonShiftMod ? '' : ch, modifiers: modifiers | 8 };
    }
    // Unshifted punctuation: , . / ; ' [ ] \ - = `
    const phys = SYMBOL_KEY[ch];
    if (phys) {
      return { key: ch, code: phys.code, windowsVirtualKeyCode: phys.vk, text: nonShiftMod ? '' : ch, modifiers };
    }
    // Anything else printable: best-effort, char code as VK.
    return { key: ch, code: '', windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0), text: nonShiftMod ? '' : ch, modifiers };
  }

  throw new Error(`未知按键: "${last}"（支持单字符、Enter/Tab/Escape/方向键/F1-F12 等）`);
}

/** CDP event sequence for one key press (Playwright's ordering). */
export function keyEventSequence(p: KeyPayload): { type: string; params: Record<string, unknown> }[] {
  const base = {
    key: p.key,
    code: p.code,
    windowsVirtualKeyCode: p.windowsVirtualKeyCode,
    nativeVirtualKeyCode: p.windowsVirtualKeyCode,
    modifiers: p.modifiers,
  };
  const events: { type: string; params: Record<string, unknown> }[] = [
    // keyDown WITH text = the browser performs the key's default action
    // (Enter submits, Tab moves focus); rawKeyDown would skip text insertion.
    { type: 'Input.dispatchKeyEvent', params: { type: p.text ? 'keyDown' : 'rawKeyDown', ...base, text: p.text || undefined, unmodifiedText: p.text || undefined } },
    { type: 'Input.dispatchKeyEvent', params: { type: 'keyUp', ...base } },
  ];
  return events;
}
