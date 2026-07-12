import type { ExecuteResult } from '../content/executor';
import { ActionError } from './errors';

export interface ActionAdapter {
  execute(tool: string, params: unknown): Promise<ExecuteResult>;
}

export class ActionRunner {
  constructor(private readonly l1: ActionAdapter) {}

  async run(tool: string, params: unknown): Promise<ExecuteResult> {
    try {
      return await this.l1.execute(tool, params);
    } catch (error) {
      if (!(error instanceof ActionError)) throw error;
      if (error.failure.code === 'stale_ref' && params && typeof params === 'object') {
        return this.l1.execute(tool, {
          ...(params as Record<string, unknown>),
          allowRecovery: true,
        });
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
