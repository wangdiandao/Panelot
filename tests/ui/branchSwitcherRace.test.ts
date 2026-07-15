// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const treeMocks = vi.hoisted(() => ({ getLogicalSiblings: vi.fn() }));

vi.mock('../../src/db/schema', () => ({ PanelotDB: class {} }));
vi.mock('../../src/db/tree', () => ({
  ThreadTree: class {
    getLogicalSiblings = treeMocks.getLogicalSiblings;
  },
}));

import { BranchSwitcher } from '../../src/ui/components/BranchSwitcher';

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

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe('BranchSwitcher thread races', () => {
  it('carries the originating thread id when an old sibling lookup resolves after navigation', async () => {
    const lookup = deferred<{ id: string }[]>();
    treeMocks.getLogicalSiblings.mockReturnValueOnce(lookup.promise);
    const onSelectBranch = vi.fn();

    await act(async () =>
      root.render(
        createElement(BranchSwitcher, {
          threadId: 'thread-a',
          nodeId: 'a-1',
          branch: { index: 1, count: 2 },
          onSelectBranch,
        }),
      ),
    );
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="下一分支"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );

    await act(async () =>
      root.render(
        createElement(BranchSwitcher, {
          threadId: 'thread-b',
          nodeId: 'b-1',
          branch: { index: 1, count: 1 },
          onSelectBranch,
        }),
      ),
    );
    await act(async () => {
      lookup.resolve([{ id: 'a-1' }, { id: 'a-2' }]);
      await lookup.promise;
      await Promise.resolve();
    });

    expect(onSelectBranch).toHaveBeenCalledWith('thread-a', 'a-2');
    expect(onSelectBranch).not.toHaveBeenCalledWith('thread-b', 'a-2');
  });
});
