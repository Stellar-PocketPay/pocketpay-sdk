import { describe, expect, it } from 'vitest';
import { createTransactionQueue } from '../src';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('TransactionQueue', () => {
  it('runs work in FIFO order and does not start the next item early', async () => {
    const gate = deferred();
    const events: string[] = [];
    const queue = createTransactionQueue();

    const first = queue.enqueue(
      async () => {
        events.push('first:start');
        await gate.promise;
        events.push('first:end');
        return 'first-value';
      },
      { id: 'first' },
    );

    const second = queue.enqueue(
      async () => {
        events.push('second:start');
        return 'second-value';
      },
      { id: 'second' },
    );

    await Promise.resolve();

    expect(events).toEqual(['first:start']);
    expect(first.snapshot().state).toBe('running');
    expect(second.snapshot().state).toBe('queued');

    gate.resolve();

    await expect(first.result).resolves.toEqual({
      id: 'first',
      state: 'completed',
      value: 'first-value',
    });
    await expect(second.result).resolves.toEqual({
      id: 'second',
      state: 'completed',
      value: 'second-value',
    });
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('cancels queued work without pretending a running operation was cancelled', async () => {
    const gate = deferred();
    const queue = createTransactionQueue();
    let secondRan = false;

    const first = queue.enqueue(
      async () => {
        await gate.promise;
        return 'done';
      },
      { id: 'running' },
    );

    const second = queue.enqueue(
      async () => {
        secondRan = true;
        return 'should-not-run';
      },
      { id: 'cancel-me' },
    );

    await Promise.resolve();

    expect(first.cancel()).toBe(false);
    expect(second.cancel()).toBe(true);
    expect(second.cancel()).toBe(false);
    await expect(second.result).resolves.toEqual({
      id: 'cancel-me',
      state: 'cancelled',
    });
    expect(secondRan).toBe(false);

    gate.resolve();
    await first.result;
  });

  it('records a task failure and continues with later work', async () => {
    const queue = createTransactionQueue();

    const failed = queue.enqueue(
      async () => {
        throw new Error('local task failed');
      },
      { id: 'failed' },
    );

    const next = queue.enqueue(
      async () => 'continued',
      { id: 'next' },
    );

    const failedResult = await failed.result;
    expect(failedResult.state).toBe('failed');
    if (failedResult.state === 'failed') {
      expect(failedResult.error).toBeInstanceOf(Error);
      expect((failedResult.error as Error).message).toBe('local task failed');
    }

    await expect(next.result).resolves.toEqual({
      id: 'next',
      state: 'completed',
      value: 'continued',
    });
  });
});
