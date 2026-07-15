// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingApproval } from '../../src/messaging/protocol';
import { ApprovalCard } from '../../src/ui/components/ApprovalCard';
import { ThreadSidebar } from '../../src/ui/components/ThreadSidebar';
import { TooltipProvider } from '../../src/ui/components/ui/tooltip';
import { handoffMenuCloseToApproval } from '../../src/ui/focusHandoff';
import { setLang } from '../../src/ui/i18n';
import type { ThreadMeta } from '../../src/db/types';

const approval: PendingApproval = {
  approvalId: 'approval-1',
  turnId: 'turn-1',
  requestedAt: 1,
  request: {
    tool: 'page.click',
    label: 'Click a very long checkout control that must remain reviewable',
    params: { ref: 's4_17', nested: { confirmation: 'full-value' } },
    targetOrigin: 'https://example.com/a/very/long/path/that/must/wrap',
    flags: ['cross_scope', 'sensitive_payload', 'escalation_l2'],
    preview: { snapshotLine: 'Checkout button with a long accessible name' },
  },
};

const thread: ThreadMeta = {
  id: 'thread-1',
  revision: 0,
  title: 'Focus contract',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  leafId: null,
  tags: [],
  pinned: false,
  archived: false,
  stats: { turns: 0, totalTokens: 0, costUsd: 0 },
  scopeOrigins: [],
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  setLang('en');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  setLang('zh-CN');
});

describe('ApprovalCard', () => {
  it('uses a named non-modal region with associated risks and complete params', () => {
    const html = renderToStaticMarkup(
      createElement(ApprovalCard, {
        approval,
        queuePosition: { index: 1, total: 3 },
        onDecision: vi.fn(),
      }),
    );

    expect(html).toContain('role="region"');
    expect(html).not.toContain('role="alertdialog"');
    expect(html).toContain('aria-labelledby=');
    expect(html).toContain('aria-describedby=');
    expect(html).not.toContain('<pre aria-label=');
    expect(html).toMatch(/aria-describedby="[^"]*-params-label [^"]*-params"/);
    expect(html).toContain('>Parameters</div>');
    expect(html).toContain('&quot;ref&quot;: &quot;s4_17&quot;');
    expect(html).toContain('&quot;confirmation&quot;: &quot;full-value&quot;');
    expect(html).toContain('grid-cols-2');
    expect(html).toContain('sm:grid-cols-4');
    expect(html.match(/<button/g)).toHaveLength(4);
    for (const shortcut of ['Y', 'S', 'A', 'N']) expect(html).toContain(`>${shortcut}</kbd>`);
  });

  it('keeps every button clickable and preserves Y/S/A/N keyboard decisions', async () => {
    const onDecision = vi.fn();
    await act(async () => root.render(createElement(ApprovalCard, { approval, onDecision })));
    const region = container.querySelector<HTMLElement>('[role="region"]')!;
    expect(document.activeElement).toBe(region);

    for (const key of ['y', 's', 'a', 'n']) {
      await act(async () =>
        region.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })),
      );
    }
    expect(onDecision.mock.calls.map((call) => call[1].kind)).toEqual([
      'accept',
      'acceptForSession',
      'acceptForSite',
      'decline',
    ]);

    onDecision.mockClear();
    for (const button of container.querySelectorAll('button')) {
      await act(async () => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    }
    expect(onDecision).toHaveBeenCalledTimes(4);
  });
});

describe('thread menu focus handoff', () => {
  const renderSidebar = async (pending: boolean) => {
    await act(async () =>
      root.render(
        createElement(
          TooltipProvider,
          null,
          createElement(ThreadSidebar, {
            threads: [thread],
            activeThreadId: thread.id,
            seen: {},
            collapsed: false,
            width: 260,
            onWidthChange: vi.fn(),
            onWidthCommit: vi.fn(),
            onToggleCollapsed: vi.fn(),
            onOpenThread: vi.fn(),
            onNewThread: vi.fn(),
            onTogglePin: vi.fn(),
            onRename: vi.fn(),
            onDelete: vi.fn(),
          }),
          pending ? createElement(ApprovalCard, { approval, onDecision: vi.fn() }) : undefined,
        ),
      ),
    );
  };

  const openAndCloseThreadMenu = async () => {
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-slot="dropdown-menu-trigger"]',
    )!;
    await act(async () => {
      trigger.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          button: 0,
          pointerType: 'mouse',
        }),
      );
    });
    const menu = document.querySelector<HTMLElement>('[data-slot="dropdown-menu-content"]')!;
    expect(menu).not.toBeNull();
    await act(async () => {
      menu.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          code: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    return trigger;
  };

  it('returns focus to the real ThreadRow trigger when no approval exists', async () => {
    await renderSidebar(false);
    const trigger = await openAndCloseThreadMenu();
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('hands real ThreadRow menu focus to the pending approval', async () => {
    await renderSidebar(true);
    const region = container.querySelector<HTMLElement>('[data-approval-focus-target="true"]')!;
    await openAndCloseThreadMenu();
    await vi.waitFor(() => expect(document.activeElement).toBe(region));
  });

  it('does not cancel ordinary menu return focus when no approval exists', () => {
    const event = { preventDefault: vi.fn() };
    handoffMenuCloseToApproval(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('keeps focus on the latest approval instead of returning to a stale menu trigger', () => {
    const trigger = document.createElement('button');
    const first = document.createElement('section');
    const latest = document.createElement('section');
    first.tabIndex = -1;
    latest.tabIndex = -1;
    first.dataset.approvalFocusTarget = 'true';
    latest.dataset.approvalFocusTarget = 'true';
    document.body.append(trigger, first, latest);
    trigger.focus();
    const event = { preventDefault: vi.fn() };

    handoffMenuCloseToApproval(event);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(latest);
    trigger.remove();
    first.remove();
    latest.remove();
  });
});
