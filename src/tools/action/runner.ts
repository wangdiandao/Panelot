import type { ExecuteResult } from '../content/executor';
import { ActionError } from './errors';

export interface ActionAdapter {
  execute(
    tool: string,
    params: unknown,
    signal?: AbortSignal,
    deadlineAt?: number,
  ): Promise<ExecuteResult>;
}

export class ActionRunner {
  constructor(private readonly l1: ActionAdapter) {}

  async run(
    tool: string,
    params: unknown,
    signal?: AbortSignal,
    deadlineAt?: number,
  ): Promise<ExecuteResult> {
    try {
      return await (signal === undefined && deadlineAt === undefined
        ? this.l1.execute(tool, params)
        : this.l1.execute(tool, params, signal, deadlineAt));
    } catch (error) {
      if (!(error instanceof ActionError)) throw error;
      if (error.failure.code === 'stale_ref' && params && typeof params === 'object') {
        const recoveredParams = {
          ...(params as Record<string, unknown>),
          allowRecovery: true,
        };
        return signal === undefined && deadlineAt === undefined
          ? this.l1.execute(tool, recoveredParams)
          : this.l1.execute(tool, recoveredParams, signal, deadlineAt);
      }
      if (error.failure.code === 'l1_not_effective') {
        const escalation =
          tool === 'type' ? 'type_trusted' : tool === 'click' ? 'click_trusted' : '';
        if (escalation) {
          throw new ActionError({
            ...error.failure,
            message: `${error.failure.message} 如需继续，请改用 ${escalation}；该 L2 工具会单独经过权限裁决。`,
            details: { ...error.failure.details, escalationTool: escalation },
          });
        }
      }
      throw error;
    }
  }
}
