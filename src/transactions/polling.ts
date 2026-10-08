import { getHorizonServer } from '../config';
import { TransactionPollConfig, TransactionPollResult, TransactionRecord, SDKConfig } from '../types';
import { classifySubmitError } from '../errors';

const DEFAULT_INTERVAL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMER_MS = 2147483647;

function scheduleDeadline(complete: () => void, deadline: number): () => void {
  let timer: ReturnType<typeof setTimeout>;
  let cancelled = false;
  const schedule = () => {
    timer = setTimeout(() => {
      if (cancelled) return;
      if (Date.now() < deadline) schedule();
      else complete();
    }, Math.min(MAX_TIMER_MS, Math.max(0, deadline - Date.now())));
  };
  schedule();
  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) > 0
    ? Math.max(1, Math.floor(value as number))
    : fallback;
}

/** Untrusted Horizon adapter values may implement getters or Proxy traps. */
function safeProviderField(value: unknown, field: string): unknown {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
  try {
    return (value as Record<string, unknown>)[field];
  } catch {
    return undefined;
  }
}

function abortError(): Error {
  const error = new Error('Transaction polling cancelled');
  error.name = 'AbortError';
  return error;
}

function pollingTimeoutError(): Error {
  const error = new Error('Transaction polling timed out');
  error.name = 'PollingTimeoutError';
  return error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw abortError();
  }
}

function withPollingBounds<T>(
  request: () => Promise<T>,
  signal: AbortSignal | undefined,
  deadline: number,
): Promise<T> {
  throwIfAborted(signal);

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      cancelTimer();
      signal?.removeEventListener('abort', onAbort);
    };
    const resolveOnce = (value: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => rejectOnce(abortError());
    const cancelTimer = scheduleDeadline(
      () => rejectOnce(pollingTimeoutError()),
      deadline,
    );

    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    if (Date.now() >= deadline) {
      rejectOnce(pollingTimeoutError());
      return;
    }

    try {
      request().then(
        (value) => {
          if (Date.now() >= deadline) rejectOnce(pollingTimeoutError());
          else resolveOnce(value);
        },
        (error) => {
          if (Date.now() >= deadline) rejectOnce(pollingTimeoutError());
          else rejectOnce(error);
        },
      );
    } catch (error) {
      if (Date.now() >= deadline) rejectOnce(pollingTimeoutError());
      else rejectOnce(error);
    }
  });
}

function waitForNextAttempt(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  throwIfAborted(signal);

  return new Promise<void>((resolve, reject) => {
    const cancelTimer = scheduleDeadline(() => {
      cleanup();
      resolve();
    }, Date.now() + ms);
    const onAbort = () => {
      cancelTimer();
      cleanup();
      reject(abortError());
    };
    const cleanup = () => signal?.removeEventListener('abort', onAbort);

    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

/**
 * Polls Horizon for the confirmation status of a transaction by its hash.
 *
 * This helper performs status lookups only. It never submits or resubmits the
 * transaction, so retrying a status request cannot duplicate a payment.
 *
 * @param hash - The transaction hash to poll for.
 * @param config - Polling interval, timeout, attempt bound, and cancellation.
 * @param sdkConfig - Optional SDK config overrides.
 * @returns A typed poll result with both completion status and ledger state.
 */
export async function pollTransaction(
  hash: string,
  config: TransactionPollConfig = {},
  sdkConfig?: Partial<SDKConfig>
): Promise<TransactionPollResult> {
  // A malformed input can never represent a Horizon transaction. Do not
  // perform network reads or echo secret-like/invalid strings in a result.
  if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/i.test(hash)) {
    return {
      status: 'unknown',
      state: 'unknown',
      hash: '',
      attempts: 0,
      error: 'A 64-character hexadecimal transaction hash is required.',
    };
  }

  const server = getHorizonServer(sdkConfig);
  const interval = positiveInteger(config.interval, DEFAULT_INTERVAL_MS);
  const timeout = positiveInteger(config.timeout, DEFAULT_TIMEOUT_MS);
  const derivedMaxAttempts = Math.max(1, Math.ceil(timeout / interval));
  const maxAttempts = positiveInteger(config.maxAttempts, derivedMaxAttempts);
  const startTime = Date.now();
  const deadline = startTime + timeout;

  let attempts = 0;
  let lastState: TransactionPollResult['state'] = 'unknown';

  while (attempts < maxAttempts && Date.now() - startTime < timeout) {
    throwIfAborted(config.signal);
    const remainingMs = timeout - (Date.now() - startTime);
    if (remainingMs <= 0) break;

    try {
      const tx = await withPollingBounds(
        () => {
          attempts += 1;
          return server.transactions().transaction(hash).call();
        },
        config.signal,
        deadline,
      );

      // Never confirm (or definitively fail) a different transaction just
      // because a transport returned a successful-looking object. Runtime
      // Horizon adapters are untrusted even when the TS interface is correct.
      // Snapshot decision fields exactly once: stateful getters/Proxy traps
      // must not change identity or success after validation.
      const txHash = safeProviderField(tx, 'hash');
      const txSuccessful = safeProviderField(tx, 'successful');
      const txLedger = safeProviderField(tx, 'ledger_attr');
      const txCreatedAt = safeProviderField(tx, 'created_at');
      const txSourceAccount = safeProviderField(tx, 'source_account');
      const txFeeCharged = safeProviderField(tx, 'fee_charged');
      const txOperationCount = safeProviderField(tx, 'operation_count');
      const txMemo = safeProviderField(tx, 'memo');
      const txMemoType = safeProviderField(tx, 'memo_type');

      const metadataValid =
        typeof txCreatedAt === 'string' &&
        (txLedger === undefined || (typeof txLedger === 'number' && Number.isFinite(txLedger))) &&
        (txSourceAccount === undefined || typeof txSourceAccount === 'string') &&
        (
          txFeeCharged === undefined ||
          typeof txFeeCharged === 'string' ||
          (typeof txFeeCharged === 'number' && Number.isFinite(txFeeCharged))
        ) &&
        (
          txOperationCount === undefined ||
          (typeof txOperationCount === 'number' && Number.isFinite(txOperationCount))
        ) &&
        (txMemo === undefined || txMemo === null || typeof txMemo === 'string') &&
        (txMemoType === undefined || txMemoType === null || typeof txMemoType === 'string');

      if (
        !tx ||
        typeof txHash !== 'string' ||
        txHash.toLowerCase() !== hash.toLowerCase() ||
        typeof txSuccessful !== 'boolean' ||
        !metadataValid
      ) {
        lastState = 'unknown';
      } else {
        const record: TransactionRecord = {
          hash: txHash,
          // `tx.ledger` is Horizon's link-follow helper, not the ledger number;
          // the numeric sequence is exposed as `ledger_attr`.
          ledger: txLedger,
          createdAt: txCreatedAt,
          sourceAccount: txSourceAccount,
          // Horizon types `fee_charged` as `string | number`; preserve stroops.
          fee: txFeeCharged === undefined ? undefined : String(txFeeCharged),
          operationCount: txOperationCount,
          successful: txSuccessful,
          memo: typeof txMemo === 'string' ? txMemo : undefined,
          memoType: typeof txMemoType === 'string' ? txMemoType : undefined,
        };

        return {
          status: txSuccessful ? 'success' : 'failure',
          state: txSuccessful ? 'confirmed' : 'failed',
          hash,
          attempts,
          transaction: record,
        };
      }
    } catch (error: unknown) {
      const name = safeProviderField(error, 'name');
      if (name === 'AbortError') throw error;
      if (name === 'PollingTimeoutError') break;

      const response = safeProviderField(error, 'response');
      const status = safeProviderField(response, 'status') ?? safeProviderField(error, 'status');
      if (status === 404) {
        lastState = 'pending';
      } else {
        let classified: ReturnType<typeof classifySubmitError>;
        try {
          classified = classifySubmitError(error, hash);
        } catch {
          // A hostile/unexpected provider error must never escape through
          // diagnosis or become a false confirmation/pending result.
          return {
            status: 'unknown',
            state: 'unknown',
            hash,
            attempts,
            error: 'Transaction status could not be determined.',
          };
        }
        const retryable =
          classified.code === 'TX_STATUS_UNKNOWN' || classified.retryable === true;
        if (!retryable) {
          return {
            status: 'unknown',
            state: 'unknown',
            hash,
            attempts,
            error: classified.message,
          };
        }
        // A retryable transport failure is not a new ledger observation.
        // Preserve any earlier pending status instead of erasing it to unknown.
        // If no ledger state has been observed yet, lastState is already unknown.
      }
    }

    const elapsed = Date.now() - startTime;
    if (attempts >= maxAttempts || elapsed >= timeout) {
      break;
    }

    await waitForNextAttempt(
      Math.min(interval, Math.max(0, timeout - elapsed)),
      config.signal,
    );
  }

  const attemptBoundReached = attempts >= maxAttempts && Date.now() - startTime < timeout;
  return {
    status: 'timeout',
    state: lastState,
    hash,
    attempts,
    error: attemptBoundReached
      ? `Transaction polling stopped after ${attempts} attempts while status was ${lastState}`
      : `Transaction polling timed out after ${timeout}ms while status was ${lastState}`,
  };
}
