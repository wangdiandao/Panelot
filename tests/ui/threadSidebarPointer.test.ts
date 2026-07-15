// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThreadSidebar } from '../../src/ui/components/ThreadSidebar';
import { SIDEBAR_WIDTH_VAR } from '../../src/ui/layoutTokens';
import { TooltipProvider } from '../../src/ui/components/ui/tooltip';

let root: Root;
let container: HTMLDivElement;
let mounted: boolean;
let originalSetPointerCapture: PropertyDescriptor | undefined;
let originalHasPointerCapture: PropertyDescriptor | undefined;
let originalReleasePointerCapture: PropertyDescriptor | undefined;
let captures: WeakMap<HTMLElement, Set<number>>;
let releasePointerCapture: ReturnType<typeof vi.fn>;

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  originalSetPointerCapture = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'setPointerCapture',
  );
  originalHasPointerCapture = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'hasPointerCapture',
  );
  originalReleasePointerCapture = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'releasePointerCapture',
  );
  captures = new WeakMap();
  releasePointerCapture = vi.fn(function (this: HTMLElement, pointerId: number) {
    captures.get(this)?.delete(pointerId);
  });
  Object.defineProperties(HTMLElement.prototype, {
    setPointerCapture: {
      configurable: true,
      value(this: HTMLElement, pointerId: number) {
        const ids = captures.get(this) ?? new Set<number>();
        ids.add(pointerId);
        captures.set(this, ids);
      },
    },
    hasPointerCapture: {
      configurable: true,
      value(this: HTMLElement, pointerId: number) {
        return captures.get(this)?.has(pointerId) ?? false;
      },
    },
    releasePointerCapture: { configurable: true, value: releasePointerCapture },
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  mounted = true;
  document.body.style.userSelect = '';
  document.body.style.cursor = '';
});

afterEach(async () => {
  if (mounted) await act(async () => root.unmount());
  container.remove();
  document.documentElement.style.removeProperty(SIDEBAR_WIDTH_VAR);
  document.body.style.userSelect = '';
  document.body.style.cursor = '';
  restorePointerMethod('setPointerCapture', originalSetPointerCapture);
  restorePointerMethod('hasPointerCapture', originalHasPointerCapture);
  restorePointerMethod('releasePointerCapture', originalReleasePointerCapture);
  vi.restoreAllMocks();
});

function restorePointerMethod(name: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
  else Reflect.deleteProperty(HTMLElement.prototype, name);
}

function renderSidebar(
  overrides: {
    onWidthChange?: (width: number) => void;
    onWidthCommit?: (width: number) => void;
  } = {},
): Promise<void> {
  return act(async () =>
    root.render(
      createElement(
        TooltipProvider,
        null,
        createElement(ThreadSidebar, {
          threads: [],
          activeThreadId: null,
          seen: {},
          collapsed: false,
          width: 300,
          onWidthChange: overrides.onWidthChange ?? vi.fn(),
          onWidthCommit: overrides.onWidthCommit ?? vi.fn(),
          onToggleCollapsed: vi.fn(),
          onOpenThread: vi.fn(),
          onNewThread: vi.fn(),
          onTogglePin: vi.fn(),
          onRename: vi.fn(),
          onDelete: vi.fn(),
        }),
      ),
    ),
  );
}

function pointer(target: Element, type: string, pointerId: number, clientX: number): void {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      pointerId,
      clientX,
      button: 0,
      isPrimary: true,
    }),
  );
}

describe('ThreadSidebar pointer resizing', () => {
  it('commits the captured pointer width exactly once on pointerup', async () => {
    const onWidthChange = vi.fn();
    const onWidthCommit = vi.fn();
    await renderSidebar({ onWidthChange, onWidthCommit });
    const separator = container.querySelector<HTMLElement>('[role="separator"]')!;

    await act(async () => {
      pointer(separator, 'pointerdown', 7, 300);
      pointer(separator, 'pointermove', 7, 348);
      pointer(separator, 'pointerup', 7, 348);
    });

    expect(onWidthChange).toHaveBeenCalledOnce();
    expect(onWidthChange).toHaveBeenCalledWith(348);
    expect(onWidthCommit).toHaveBeenCalledOnce();
    expect(onWidthCommit).toHaveBeenCalledWith(348);
    expect(releasePointerCapture).toHaveBeenCalledWith(7);
    expect(document.body.style.userSelect).toBe('');
    expect(document.body.style.cursor).toBe('');
  });

  it('rolls back pointercancel and lost capture without persisting a partial width', async () => {
    const onWidthCommit = vi.fn();
    await renderSidebar({ onWidthCommit });
    const separator = container.querySelector<HTMLElement>('[role="separator"]')!;

    await act(async () => {
      pointer(separator, 'pointerdown', 8, 300);
      pointer(separator, 'pointermove', 8, 360);
      pointer(separator, 'pointercancel', 8, 360);
    });
    expect(document.documentElement.style.getPropertyValue(SIDEBAR_WIDTH_VAR)).toBe('300px');
    expect(onWidthCommit).not.toHaveBeenCalled();

    await act(async () => {
      pointer(separator, 'pointerdown', 9, 300);
      pointer(separator, 'pointermove', 9, 380);
      captures.get(separator)?.delete(9);
      pointer(separator, 'lostpointercapture', 9, 380);
    });
    expect(document.documentElement.style.getPropertyValue(SIDEBAR_WIDTH_VAR)).toBe('300px');
    expect(onWidthCommit).not.toHaveBeenCalled();
    expect(document.body.style.userSelect).toBe('');
    expect(document.body.style.cursor).toBe('');
  });

  it('cleans up capture and body styles on blur and unmount', async () => {
    const onWidthCommit = vi.fn();
    await renderSidebar({ onWidthCommit });
    const separator = container.querySelector<HTMLElement>('[role="separator"]')!;

    await act(async () => {
      pointer(separator, 'pointerdown', 10, 300);
      pointer(separator, 'pointermove', 10, 350);
      window.dispatchEvent(new Event('blur'));
    });
    expect(onWidthCommit).not.toHaveBeenCalled();
    expect(document.body.style.userSelect).toBe('');
    expect(document.body.style.cursor).toBe('');

    await act(async () => {
      pointer(separator, 'pointerdown', 11, 300);
      pointer(separator, 'pointermove', 11, 340);
    });
    await act(async () => root.unmount());
    mounted = false;
    expect(releasePointerCapture).toHaveBeenCalledWith(11);
    expect(document.body.style.userSelect).toBe('');
    expect(document.body.style.cursor).toBe('');
    expect(onWidthCommit).not.toHaveBeenCalled();
  });
});
