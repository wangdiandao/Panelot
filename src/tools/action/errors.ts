import type { ActionFailure, ActionFailureCode, ActionPhase } from './types';

export class ActionError extends Error {
  constructor(public readonly failure: ActionFailure) {
    super(failure.message);
    this.name = 'ActionError';
  }
}

export function actionError(
  code: ActionFailureCode,
  message: string,
  phase: ActionPhase,
  retryable = false,
  details?: Record<string, unknown>,
): ActionError {
  return new ActionError({ code, message, phase, retryable, ...(details ? { details } : {}) });
}

export function serializeActionFailure(error: unknown): ActionFailure {
  if (error instanceof ActionError) return error.failure;
  if (error instanceof DOMException && error.name === 'AbortError') {
    return { code: 'aborted', message: '动作已中断。', phase: 'execute', retryable: false };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: 'unknown', message, phase: 'execute', retryable: false };
}
