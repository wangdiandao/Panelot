import { actionError } from './errors';

export const DEFAULT_TOOL_TIMEOUT_MS = 15_000;
export const WAIT_TOOL_TIMEOUT_MS = 31_000;

export interface ActionExecutionContext {
  requestId?: string;
  signal?: AbortSignal;
  deadlineAt?: number;
}

export function deadlineForTool(tool: string, params: unknown, now = Date.now()): number {
  if (tool === 'wait_for') {
    const timeMs = Number((params as { timeMs?: unknown } | null)?.timeMs);
    const requested = Number.isFinite(timeMs) ? Math.max(0, Math.min(timeMs, 30_000)) : 30_000;
    return now + Math.max(requested + 1_000, WAIT_TOOL_TIMEOUT_MS);
  }
  return now + DEFAULT_TOOL_TIMEOUT_MS;
}

export function abortedAction(
  phase: 'resolve' | 'precheck' | 'execute' | 'settle' | 'verify' | 'recover' = 'execute',
  details?: Record<string, unknown>,
) {
  return actionError('aborted', '动作已中断。', phase, false, details);
}

export async function waitWithContext(
  ms: number,
  context: ActionExecutionContext,
  phase: 'resolve' | 'precheck' | 'execute' | 'settle' | 'verify' | 'recover' = 'settle',
): Promise<void> {
  const deadline = new ActionDeadline(Number.POSITIVE_INFINITY, context.signal, context.deadlineAt);
  const waitMs = Math.min(ms, deadline.remaining());
  if (waitMs <= 0) deadline.throwIfDone();
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      context.signal?.removeEventListener('abort', onAbort);
      callback();
    };
    const timer = setTimeout(() => finish(resolve), waitMs);
    const onAbort = () => {
      finish(() => reject(abortedAction(phase)));
    };
    context.signal?.addEventListener('abort', onAbort, { once: true });
    if (context.signal?.aborted) onAbort();
  });
  deadline.throwIfDone();
}

export class ActionDeadline {
  private readonly expiresAt: number;

  constructor(
    timeoutMs: number,
    private readonly signal?: AbortSignal,
    deadlineAt?: number,
  ) {
    this.expiresAt = Math.min(Date.now() + timeoutMs, deadlineAt ?? Number.POSITIVE_INFINITY);
  }

  remaining(): number {
    this.throwIfDone();
    return Math.max(0, this.expiresAt - Date.now());
  }

  throwIfDone(): void {
    if (this.signal?.aborted) throw actionError('aborted', '动作已中断。', 'execute');
    if (Date.now() >= this.expiresAt) {
      throw actionError('timeout', '动作超过总等待时间。', 'settle', true);
    }
  }
}
