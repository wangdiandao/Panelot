// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Markdown } from '../../src/ui/components/Markdown';
import { MessageActions } from '../../src/ui/components/MessageActions';
import { TooltipProvider } from '../../src/ui/components/ui/tooltip';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return {
    promise,
    resolve: (value) => {
      if (!resolve) throw new Error('Deferred is unavailable');
      resolve(value);
    },
  };
}

let root: Root;
let container: HTMLDivElement;
const writeText = vi.fn();

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  writeText.mockReset();
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('clipboard action lifecycle', () => {
  it('does not schedule copied state after MessageActions unmounts', async () => {
    const pending = deferred<void>();
    writeText.mockReturnValueOnce(pending.promise);
    const setTimer = vi.spyOn(globalThis, 'setTimeout');
    await act(async () =>
      root.render(
        createElement(
          TooltipProvider,
          null,
          createElement(MessageActions, {
            role: 'assistant',
            text: 'copy me',
            isLast: true,
          }),
        ),
      ),
    );
    const button = container.querySelector('button');
    if (!button) throw new Error('Expected copy button');
    await act(async () => button.click());
    await act(async () => root.unmount());
    const timersBeforeResolution = setTimer.mock.calls.length;

    await act(async () => {
      pending.resolve();
      await pending.promise;
    });

    expect(setTimer).toHaveBeenCalledTimes(timersBeforeResolution);
  });

  it('does not schedule copied state after a Markdown code header unmounts', async () => {
    const pending = deferred<void>();
    writeText.mockReturnValueOnce(pending.promise);
    const setTimer = vi.spyOn(globalThis, 'setTimeout');
    await act(async () => {
      root.render(createElement(Markdown, { content: '```ts\nconst x = 1;\n```' }));
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(container.querySelector('button')).not.toBeNull());
    const button = container.querySelector('button');
    if (!button) throw new Error('Expected code copy button');
    await act(async () => button.click());
    await act(async () => root.unmount());
    const timersBeforeResolution = setTimer.mock.calls.length;

    await act(async () => {
      pending.resolve();
      await pending.promise;
    });

    expect(setTimer).toHaveBeenCalledTimes(timersBeforeResolution);
  });

  it.each([
    {
      name: 'message action',
      render: () =>
        createElement(MessageActions, {
          role: 'assistant' as const,
          text: 'copy me',
          isLast: true,
        }),
    },
    {
      name: 'code header',
      render: () => createElement(Markdown, { content: '```ts\nconst x = 1;\n```' }),
    },
  ])('contains clipboard rejection for $name', async ({ render }) => {
    writeText.mockRejectedValueOnce(new Error('clipboard denied'));
    await act(async () => {
      root.render(createElement(TooltipProvider, null, render()));
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(container.querySelector('button')).not.toBeNull());
    const button = container.querySelector('button');
    if (!button) throw new Error('Expected copy button');
    const labelBefore = button.textContent;

    await act(async () => {
      button.click();
      await Promise.resolve();
    });

    expect(button.textContent).toBe(labelBefore);
  });
});
