// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, Op } from '../../src/messaging/protocol';
import type { EngineTransport } from '../../src/messaging/transport';
import { ThreadView } from '../../src/ui/components/ThreadView';
import { EngineSession } from '../../src/ui/engineClient';
import { setLang, t } from '../../src/ui/i18n';

class FakeTransport implements EngineTransport {
  send(_op: Op): void {}
  onEvent(_handler: (event: AgentEvent) => void): () => void {
    return () => {};
  }
  onDisconnect(_handler: () => void): () => void {
    return () => {};
  }
  close(): void {}
}

const reload = vi.fn();
let root: Root;
let container: HTMLDivElement;
let session: EngineSession;

beforeEach(() => {
  setLang('zh-CN');
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as unknown as { chrome: unknown }).chrome = { runtime: { reload } };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  session = new EngineSession(() => new FakeTransport());
  session.store.setState({
    connected: false,
    reloadRequired: true,
    loading: false,
    lastError: {
      message: 'Reload required.',
      retryable: false,
      kind: 'engine_protocol',
    },
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  setLang('en');
  vi.clearAllMocks();
});

describe('engine reload-required state', () => {
  it('stops reconnect UI, disables the composer, and exposes extension reload', async () => {
    await act(async () =>
      root.render(
        createElement(ThreadView, {
          session,
          providerConfigured: true,
          modelSelectorInComposer: false,
        }),
      ),
    );

    expect(container.textContent).not.toContain(t('reconnecting'));
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea');
    expect(textarea?.disabled).toBe(true);
    expect(textarea?.placeholder).toBe(t('input.reloadRequired'));

    const reloadButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === t('error.reloadExtension'),
    );
    expect(reloadButton).toBeTruthy();
    await act(async () => reloadButton?.click());
    expect(reload).toHaveBeenCalledOnce();
  });
});
