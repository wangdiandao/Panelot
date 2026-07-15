import { describe, expect, it } from 'vitest';
import {
  isTrustedChatSender,
  parseClearThreadRuntimeStateRequest,
  THREAD_RUNTIME_STATE_RPC_TYPE,
} from '../../src/messaging/threadRuntimeState';

describe('thread runtime state RPC', () => {
  it('accepts only an exact bounded clear request', () => {
    expect(
      parseClearThreadRuntimeStateRequest({
        type: THREAD_RUNTIME_STATE_RPC_TYPE,
        action: 'clear',
        threadId: 'thread-1',
      }),
    ).toEqual({
      type: THREAD_RUNTIME_STATE_RPC_TYPE,
      action: 'clear',
      threadId: 'thread-1',
    });
    expect(
      parseClearThreadRuntimeStateRequest({
        type: THREAD_RUNTIME_STATE_RPC_TYPE,
        action: 'clear',
        threadId: 'thread-1',
        extra: true,
      }),
    ).toBeNull();
    expect(
      parseClearThreadRuntimeStateRequest({
        type: THREAD_RUNTIME_STATE_RPC_TYPE,
        action: 'clear',
        threadId: 'x'.repeat(513),
      }),
    ).toBeNull();
  });

  it('accepts only the extension chat page as sender', () => {
    const root = 'chrome-extension://panelot/';
    expect(
      isTrustedChatSender(
        { id: 'panelot', url: 'chrome-extension://panelot/chat.html?thread=thread-1' },
        'panelot',
        root,
      ),
    ).toBe(true);
    expect(
      isTrustedChatSender(
        { id: 'panelot', url: 'chrome-extension://panelot/options.html' },
        'panelot',
        root,
      ),
    ).toBe(false);
    expect(
      isTrustedChatSender(
        { id: 'other', url: 'chrome-extension://panelot/chat.html' },
        'panelot',
        root,
      ),
    ).toBe(false);
  });
});
