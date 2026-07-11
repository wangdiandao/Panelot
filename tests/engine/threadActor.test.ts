import { describe, expect, it } from 'vitest';
import { ThreadActor } from '../../src/engine/threadActor';

describe('ThreadActor', () => {
  it('serializes work and continues after a failed command', async () => {
    const actor = new ThreadActor();
    const order: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = actor.run(async () => {
      order.push('first:start');
      await gate;
      order.push('first:end');
    });
    const second = actor.run(async () => {
      order.push('second');
      throw new Error('expected');
    });
    const third = actor.run(async () => order.push('third'));

    await Promise.resolve();
    expect(order).toEqual(['first:start']);
    release();
    await first;
    await expect(second).rejects.toThrow('expected');
    await third;
    expect(order).toEqual(['first:start', 'first:end', 'second', 'third']);
  });
});
