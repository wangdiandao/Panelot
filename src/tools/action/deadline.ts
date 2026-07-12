import { actionError } from './errors';

export class ActionDeadline {
  private readonly expiresAt: number;

  constructor(
    timeoutMs: number,
    private readonly signal?: AbortSignal,
  ) {
    this.expiresAt = Date.now() + timeoutMs;
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
