/**
 * In-process FIFO queue for transaction and vault work.
 *
 * @remarks
 * This queue orders local callbacks; it does not reserve Stellar sequence
 * numbers, cancel submitted transactions, or provide cross-process locking.
 * Build/fetch fresh network state inside the queued callback.
 */

export type TransactionQueueState =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface TransactionQueueSnapshot {
  /** Stable caller-supplied or generated identifier. */
  id: string;
  /** Monotonic enqueue order within this queue instance. */
  sequence: number;
  state: TransactionQueueState;
  enqueuedAt: number;
  startedAt?: number;
  settledAt?: number;
}

export type TransactionQueueResult<T> =
  | {
      id: string;
      state: 'completed';
      value: T;
    }
  | {
      id: string;
      state: 'failed';
      error: unknown;
    }
  | {
      id: string;
      state: 'cancelled';
    };

export interface TransactionQueueEnqueueOptions {
  /**
   * Optional stable operation identifier.
   *
   * IDs cannot be reused within a queue instance, including after settlement.
   * This avoids ambiguous cancellation and support diagnostics.
   */
  id?: string;
  /**
   * Best-effort local state hook.
   *
   * Hook exceptions are ignored so observability cannot break queue progress.
   */
  onStateChange?: (snapshot: TransactionQueueSnapshot) => void;
}

export interface TransactionQueueHandle<T> {
  id: string;
  /**
   * Resolves for all terminal queue states. A completed queue task may still
   * contain an SDK-level failed or unresolved transaction result; callers must
   * inspect the returned value.
   */
  result: Promise<TransactionQueueResult<T>>;
  /**
   * Cancels only while the item is still queued.
   *
   * Once execution starts this returns false: stopping a local callback cannot
   * safely imply that a Stellar submission was cancelled.
   */
  cancel(): boolean;
  snapshot(): TransactionQueueSnapshot;
}

interface QueueEntry {
  id: string;
  sequence: number;
  state: TransactionQueueState;
  enqueuedAt: number;
  startedAt?: number;
  settledAt?: number;
  task: () => Promise<unknown>;
  resolve: (result: TransactionQueueResult<unknown>) => void;
  onStateChange?: (snapshot: TransactionQueueSnapshot) => void;
}

/**
 * Serializes local transaction work in strict FIFO order.
 *
 * Create one queue per sequence domain (normally per signing account) and keep
 * transaction construction/submission inside the callback so each item obtains
 * fresh network state only when it reaches the front of the queue.
 */
export class TransactionQueue {
  private readonly pending: QueueEntry[] = [];
  private readonly entries = new Map<string, QueueEntry>();
  private running?: QueueEntry;
  private draining = false;
  private sequence = 0;

  /** Number of queued plus currently running items. */
  get size(): number {
    return this.pending.length + (this.running ? 1 : 0);
  }

  /** Number of items that have not started yet. */
  get pendingCount(): number {
    return this.pending.length;
  }

  /**
   * Enqueue one local operation.
   *
   * Queue ordering is by the call order of enqueue(). A task failure is captured
   * as a terminal result and does not stop later tasks from running.
   */
  enqueue<T>(
    task: () => T | Promise<T>,
    options: TransactionQueueEnqueueOptions = {},
  ): TransactionQueueHandle<T> {
    if (typeof task !== 'function') {
      throw new TypeError('TransactionQueue task must be a function');
    }

    const sequence = ++this.sequence;
    const requestedId = options.id?.trim();

    if (options.id !== undefined && !requestedId) {
      throw new TypeError('TransactionQueue id must not be empty');
    }

    const id = requestedId ?? `transaction-${sequence}`;

    if (this.entries.has(id)) {
      throw new Error(`TransactionQueue id already exists: ${id}`);
    }

    let resolveResult!: (result: TransactionQueueResult<T>) => void;
    const result = new Promise<TransactionQueueResult<T>>((resolve) => {
      resolveResult = resolve;
    });

    const entry: QueueEntry = {
      id,
      sequence,
      state: 'queued',
      enqueuedAt: Date.now(),
      task: async () => task(),
      resolve: (terminal) => {
        resolveResult(terminal as TransactionQueueResult<T>);
      },
      onStateChange: options.onStateChange,
    };

    this.entries.set(id, entry);
    this.pending.push(entry);
    this.notify(entry);
    this.scheduleDrain();

    return {
      id,
      result,
      cancel: () => this.cancel(id),
      snapshot: () => this.snapshot(id)!,
    };
  }

  /**
   * Cancel a queued item.
   *
   * Running or settled items are never reported as cancelled.
   */
  cancel(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.state !== 'queued') {
      return false;
    }

    const index = this.pending.indexOf(entry);
    if (index >= 0) {
      this.pending.splice(index, 1);
    }

    this.transition(entry, 'cancelled');
    entry.resolve({ id: entry.id, state: 'cancelled' });
    return true;
  }

  /** Cancel every item that has not started. Returns the number cancelled. */
  clearPending(): number {
    const queued = this.pending.slice();
    let cancelled = 0;

    for (const entry of queued) {
      if (this.cancel(entry.id)) {
        cancelled += 1;
      }
    }

    return cancelled;
  }

  /** Return a copy of one item's current local queue state. */
  snapshot(id: string): TransactionQueueSnapshot | undefined {
    const entry = this.entries.get(id);
    return entry ? this.toSnapshot(entry) : undefined;
  }

  /** Return snapshots in original enqueue order, including settled history. */
  listSnapshots(): TransactionQueueSnapshot[] {
    return Array.from(this.entries.values())
      .sort((a, b) => a.sequence - b.sequence)
      .map((entry) => this.toSnapshot(entry));
  }

  private scheduleDrain(): void {
    if (this.draining) {
      return;
    }

    this.draining = true;
    void Promise.resolve().then(() => this.drain());
  }

  private async drain(): Promise<void> {
    try {
      while (this.pending.length > 0) {
        const entry = this.pending.shift();
        if (!entry || entry.state !== 'queued') {
          continue;
        }

        this.running = entry;
        this.transition(entry, 'running');

        try {
          const value = await entry.task();
          this.transition(entry, 'completed');
          entry.resolve({
            id: entry.id,
            state: 'completed',
            value,
          });
        } catch (error) {
          this.transition(entry, 'failed');
          entry.resolve({
            id: entry.id,
            state: 'failed',
            error,
          });
        } finally {
          this.running = undefined;
        }
      }
    } finally {
      this.draining = false;

      // An onStateChange hook may enqueue new work as the final item settles.
      if (this.pending.length > 0) {
        this.scheduleDrain();
      }
    }
  }

  private transition(entry: QueueEntry, state: TransactionQueueState): void {
    entry.state = state;

    if (state === 'running') {
      entry.startedAt = Date.now();
    }

    if (state === 'completed' || state === 'failed' || state === 'cancelled') {
      entry.settledAt = Date.now();
    }

    this.notify(entry);
  }

  private notify(entry: QueueEntry): void {
    if (!entry.onStateChange) {
      return;
    }

    try {
      entry.onStateChange(this.toSnapshot(entry));
    } catch {
      // Observability must never affect transaction ordering or execution.
    }
  }

  private toSnapshot(entry: QueueEntry): TransactionQueueSnapshot {
    return {
      id: entry.id,
      sequence: entry.sequence,
      state: entry.state,
      enqueuedAt: entry.enqueuedAt,
      ...(entry.startedAt === undefined ? {} : { startedAt: entry.startedAt }),
      ...(entry.settledAt === undefined ? {} : { settledAt: entry.settledAt }),
    };
  }
}

/** Create a fresh in-process FIFO transaction queue. */
export function createTransactionQueue(): TransactionQueue {
  return new TransactionQueue();
}
