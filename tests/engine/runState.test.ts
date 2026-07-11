import { describe, expect, it } from 'vitest';
import {
  assertRunTransition,
  recoverInterruptedRun,
  type RunState,
} from '../../src/engine/runState';

describe('run state transitions', () => {
  it.each<[RunState, RunState]>([
    ['queued', 'preparing'],
    ['preparing', 'streaming_model'],
    ['streaming_model', 'waiting_approval'],
    ['waiting_approval', 'executing_tool'],
    ['executing_tool', 'streaming_model'],
    ['streaming_model', 'completed'],
  ])('allows %s -> %s', (from, to) => {
    expect(assertRunTransition(from, to)).toBe(to);
  });

  it('rejects transitions out of terminal states', () => {
    expect(() => assertRunTransition('completed', 'preparing')).toThrow(/completed.*preparing/);
    expect(() => assertRunTransition('failed', 'queued')).toThrow(/failed.*queued/);
  });
});

describe('run crash recovery', () => {
  it('restores queued work and pending approvals without fabricating a tool replay', () => {
    expect(recoverInterruptedRun({ state: 'queued' })).toEqual({
      state: 'queued',
      action: 'resume_run',
    });
    expect(recoverInterruptedRun({ state: 'waiting_approval' })).toEqual({
      state: 'waiting_approval',
      action: 'restore_approval',
    });
  });

  it('replays read-only and explicitly retry-safe tool calls', () => {
    expect(
      recoverInterruptedRun({
        state: 'executing_tool',
        pendingTool: { effect: 'read', recovery: 'inspect-first' },
      }),
    ).toEqual({ state: 'preparing', action: 'replay_tool' });

    expect(
      recoverInterruptedRun({
        state: 'executing_tool',
        pendingTool: { effect: 'write', recovery: 'retry-safe' },
      }),
    ).toEqual({ state: 'preparing', action: 'replay_tool' });
  });

  it('pauses a write whose outcome may already have happened', () => {
    expect(
      recoverInterruptedRun({
        state: 'executing_tool',
        pendingTool: { effect: 'write', recovery: 'never-retry' },
      }),
    ).toEqual({ state: 'paused_uncertain', action: 'request_resolution' });
  });

  it('does not silently restart an interrupted model stream', () => {
    expect(recoverInterruptedRun({ state: 'streaming_model' })).toEqual({
      state: 'interrupted',
      action: 'request_resume',
    });
  });
});
