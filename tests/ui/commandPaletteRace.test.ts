// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ThreadMeta } from '../../src/db/types';
import type { ThreadSearchHit } from '../../src/ui/threadSearch';

const searchMocks = vi.hoisted(() => ({ searchThreads: vi.fn() }));

vi.mock('../../src/ui/threadSearch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/ui/threadSearch')>()),
  searchThreads: searchMocks.searchThreads,
}));

vi.mock('../../src/db/schema', () => ({ PanelotDB: class {} }));

import { CommandPalette } from '../../src/ui/components/CommandPalette';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function hit(id: string, title: string): ThreadSearchHit {
  const thread: ThreadMeta = {
    id,
    title,
    createdAt: 1,
    updatedAt: 1,
    leafId: 'node',
    tags: [],
    pinned: false,
    archived: false,
    deleting: false,
    revision: 0,
    stats: { turns: 1, totalTokens: 0, costUsd: 0 },
    scopeOrigins: [],
  };
  return { thread, snippet: `${title} snippet` };
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.clearAllMocks();
});

function renderPalette(open: boolean): Promise<void> {
  return act(async () =>
    root.render(
      createElement(CommandPalette, {
        open,
        onOpenChange: vi.fn(),
        onOpenThread: vi.fn(),
        onNewThread: vi.fn(),
        onOpenSettings: vi.fn(),
      }),
    ),
  );
}

async function setQuery(query: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('[data-slot="command-input"]')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, query);
  await act(async () => input.dispatchEvent(new Event('input', { bubbles: true })));
  await act(async () => vi.advanceTimersByTimeAsync(query ? 300 : 0));
}

describe('CommandPalette search races', () => {
  it('ignores an older query that resolves after the current query', async () => {
    const alpha = deferred<ThreadSearchHit[]>();
    const beta = deferred<ThreadSearchHit[]>();
    searchMocks.searchThreads.mockImplementation((_db: unknown, query: string) => {
      if (query === 'alpha') return alpha.promise;
      if (query === 'beta') return beta.promise;
      return Promise.resolve([]);
    });

    await renderPalette(true);
    await setQuery('');
    await setQuery('alpha');
    await setQuery('beta');

    await act(async () => {
      beta.resolve([hit('b', 'Beta thread')]);
      await beta.promise;
    });
    expect(document.body.textContent).toContain('Beta thread');

    await act(async () => {
      alpha.resolve([hit('a', 'Alpha thread')]);
      await alpha.promise;
    });
    expect(document.body.textContent).toContain('Beta thread');
    expect(document.body.textContent).not.toContain('Alpha thread');
  });

  it('does not publish a pending search after the palette closes', async () => {
    const pending = deferred<ThreadSearchHit[]>();
    searchMocks.searchThreads.mockImplementation((_db: unknown, query: string) =>
      query === 'pending' ? pending.promise : Promise.resolve([]),
    );

    await renderPalette(true);
    await setQuery('');
    await setQuery('pending');
    await renderPalette(false);

    await act(async () => {
      pending.resolve([hit('late', 'Late thread')]);
      await pending.promise;
    });
    expect(document.body.textContent).not.toContain('Late thread');
  });
});
