import { describe, expect, it, vi } from 'vitest';
import { actionError } from '../../src/tools/action/errors';
import { ActionRunner } from '../../src/tools/action/runner';

describe('ActionRunner', () => {
  it('preserves ordinary L1 success', async () => {
    const execute = vi.fn(async () => ({ resultText: 'ok' }));
    await expect(new ActionRunner({ execute }).run('click', {})).resolves.toEqual({
      resultText: 'ok',
    });
  });

  it('points ineffective synthetic input at a separately gated L2 tool', async () => {
    const execute = vi.fn(async () => {
      throw actionError('l1_not_effective', 'input ignored', 'verify', true);
    });
    await expect(new ActionRunner({ execute }).run('type', {})).rejects.toThrow(/type_trusted/);
  });

  it('allows one internal high-confidence stale-ref recovery attempt', async () => {
    const execute = vi
      .fn()
      .mockRejectedValueOnce(actionError('stale_ref', 'stale', 'resolve', true))
      .mockResolvedValueOnce({ resultText: 'recovered' });
    await expect(new ActionRunner({ execute }).run('click', { ref: 's1_1' })).resolves.toEqual({
      resultText: 'recovered',
    });
    expect(execute).toHaveBeenLastCalledWith('click', { ref: 's1_1', allowRecovery: true });
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
