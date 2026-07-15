export const THREAD_RUNTIME_STATE_RPC_TYPE = 'panelot.threadRuntimeState' as const;

export interface ClearThreadRuntimeStateRequest {
  type: typeof THREAD_RUNTIME_STATE_RPC_TYPE;
  action: 'clear';
  threadId: string;
}

export type ClearThreadRuntimeStateResponse = { ok: true } | { ok: false; error: string };

const MAX_THREAD_ID_LENGTH = 512;

export function parseClearThreadRuntimeStateRequest(
  input: unknown,
): ClearThreadRuntimeStateRequest | null {
  if (
    !isRecord(input) ||
    Object.keys(input).some((key) => !['type', 'action', 'threadId'].includes(key))
  ) {
    return null;
  }
  if (
    input.type !== THREAD_RUNTIME_STATE_RPC_TYPE ||
    input.action !== 'clear' ||
    typeof input.threadId !== 'string' ||
    input.threadId.length === 0 ||
    input.threadId.length > MAX_THREAD_ID_LENGTH
  ) {
    return null;
  }
  return {
    type: THREAD_RUNTIME_STATE_RPC_TYPE,
    action: 'clear',
    threadId: input.threadId,
  };
}

export function isTrustedChatSender(
  sender: { id?: string; url?: string; tab?: { url?: string } },
  runtimeId: string,
  extensionRoot: string,
): boolean {
  if (sender.id !== runtimeId) return false;
  const source = sender.url ?? sender.tab?.url;
  if (!source) return false;
  try {
    const actual = new URL(source);
    const expected = new URL('chat.html', extensionRoot);
    return (
      actual.protocol === expected.protocol &&
      actual.host === expected.host &&
      actual.pathname === expected.pathname
    );
  } catch {
    return false;
  }
}

export async function clearThreadRuntimeState(threadId: string): Promise<void> {
  const response: unknown = await chrome.runtime.sendMessage({
    type: THREAD_RUNTIME_STATE_RPC_TYPE,
    action: 'clear',
    threadId,
  } satisfies ClearThreadRuntimeStateRequest);
  if (!isRecord(response) || typeof response.ok !== 'boolean') {
    throw new Error('The background returned an invalid thread cleanup response.');
  }
  if (!response.ok) {
    throw new Error(
      typeof response.error === 'string' ? response.error : 'Thread runtime cleanup failed.',
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
