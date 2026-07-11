import type { RunState, ToolEffect, ToolRecoveryPolicy } from '../db/types';

export type { RunState, ToolEffect, ToolRecoveryPolicy } from '../db/types';

const transitions: Record<RunState, readonly RunState[]> = {
  queued: ['preparing', 'interrupted', 'failed'],
  preparing: [
    'streaming_model',
    'waiting_approval',
    'executing_tool',
    'paused_budget',
    'paused_uncertain',
    'interrupted',
    'failed',
  ],
  streaming_model: [
    'waiting_approval',
    'executing_tool',
    'paused_budget',
    'interrupted',
    'failed',
    'completed',
  ],
  waiting_approval: ['executing_tool', 'streaming_model', 'interrupted', 'failed'],
  executing_tool: [
    'streaming_model',
    'waiting_approval',
    'paused_budget',
    'paused_uncertain',
    'interrupted',
    'failed',
  ],
  paused_budget: ['preparing', 'interrupted', 'failed'],
  paused_uncertain: ['preparing', 'interrupted', 'failed'],
  interrupted: ['queued', 'preparing', 'failed'],
  failed: [],
  completed: [],
};

export function assertRunTransition(from: RunState, to: RunState): RunState {
  if (from === to) return to;
  if (!transitions[from].includes(to)) {
    throw new Error(`Invalid run transition: ${from} -> ${to}`);
  }
  return to;
}

export interface RunRecoveryInput {
  state: RunState;
  pendingTool?: { effect: ToolEffect; recovery: ToolRecoveryPolicy };
}

export type RunRecoveryDecision =
  | { state: 'queued'; action: 'resume_run' }
  | { state: 'waiting_approval'; action: 'restore_approval' }
  | { state: 'preparing'; action: 'replay_tool' }
  | { state: 'paused_uncertain'; action: 'request_resolution' }
  | { state: 'interrupted'; action: 'request_resume' }
  | { state: 'failed' | 'completed' | 'paused_budget' | 'paused_uncertain'; action: 'none' };

export function recoverInterruptedRun(input: RunRecoveryInput): RunRecoveryDecision {
  switch (input.state) {
    case 'queued':
    case 'preparing':
      return { state: 'queued', action: 'resume_run' };
    case 'waiting_approval':
      return { state: 'waiting_approval', action: 'restore_approval' };
    case 'executing_tool':
      if (input.pendingTool?.effect === 'read' || input.pendingTool?.recovery === 'retry-safe') {
        return { state: 'preparing', action: 'replay_tool' };
      }
      return { state: 'paused_uncertain', action: 'request_resolution' };
    case 'streaming_model':
      return { state: 'interrupted', action: 'request_resume' };
    case 'interrupted':
      return { state: 'interrupted', action: 'request_resume' };
    case 'paused_budget':
    case 'paused_uncertain':
    case 'failed':
    case 'completed':
      return { state: input.state, action: 'none' };
  }
}
