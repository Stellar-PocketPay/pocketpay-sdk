/**
 * Stellar PocketPay SDK — Safe Retry Policy
 *
 * Provides {@link withRetryPolicy}, a structured retry loop for Horizon
 * transaction submissions that never performs a blind resubmission when the
 * outcome is uncertain.
 *
 * ## Safety contract
 *
 * | SubmissionOutcome     | Action taken                                      |
 * |----------------------|---------------------------------------------------|
 * | success              | Return immediately.                               |
 * | retryable_failure    | Wait (exponential backoff + jitter), then retry.  |
 * | non_retryable_failure| Throw immediately — rebuild the transaction.      |
 * | unknown_status       | Poll via `submitTransactionIdempotently`, which   |
 * |                      | resolves status before deciding whether to retry. |
 *
 * A `non_retryable_failure` or exhausted `retryable_failure` is surfaced as a
 * {@link RetryPolicyExhaustedResult} (thrown as a `PocketPayError`) so
 * callers can distinguish "definitive rejection" from "retries ran out".
 */

import * as StellarSDK from '@stellar/stellar-sdk';
import { RetryPolicy, RetryPolicyExhaustedResult, SubmissionOutcome } from '../types';
import { PocketPayError } from '../types';
import { classifySubmitError, classifySubmissionOutcome } from '../errors';
import { submitTransactionIdempotently } from './idempotency';
import { emitDiagnosticsEvent } from '../diagnostics/hooks';

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_POLICY: Required<Omit<RetryPolicy, 'config' | 'onAttempt'>> = {
  maxAttempts: 4,
  initialBackoffMs: 1_000,
  maxBackoffMs: 16_000,
  backoffMultiplier: 2,
  jitter: true,
};

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Computes the capped delay for a given retry index (0-based attempt count
 * after the first try), applying optional jitter.
 */
function computeDelay(
  attemptIndex: number,
  policy: Required<Omit<RetryPolicy, 'config' | 'onAttempt'>>,
): number {
  const base =
    policy.initialBackoffMs * Math.pow(policy.backoffMultiplier, attemptIndex);
  const capped = Math.min(base, policy.maxBackoffMs);
  if (!policy.jitter) return capped;
  // Full-jitter: random value in [0, capped]
  return Math.floor(Math.random() * (capped + 1));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wraps a {@link RetryPolicyExhaustedResult} as a {@link PocketPayError} so
 * callers that rely on `instanceof PocketPayError` still work, while also
 * exposing the rich exhausted-result payload in the error's `cause` field and
 * a custom `exhaustedResult` property.
 */
function exhaustedError(
  result: RetryPolicyExhaustedResult,
): PocketPayError & { exhaustedResult: RetryPolicyExhaustedResult } {
  const err = Object.assign(
    new PocketPayError(
      result.error.message,
      result.error.code,
      {
        statusCode: result.error.statusCode,
        cause: result.error.cause,
      },
      result.error.transactionHash,
      result.error.retryable,
    ),
    { exhaustedResult: result },
  ) as PocketPayError & { exhaustedResult: RetryPolicyExhaustedResult };
  return err;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Submits a signed Stellar transaction to Horizon with a structured retry
 * policy that respects submission safety.
 *
 * ### What makes a retry safe?
 *
 * Stellar transactions are deterministic: once signed, the same envelope
 * always has the same hash. Re-submitting an envelope that was *already
 * accepted* is idempotent — Horizon returns the original result. However,
 * **rebuilding** is necessary when the sequence number is invalid or the
 * transaction was explicitly rejected.
 *
 * `withRetryPolicy` distinguishes three failure modes:
 *
 * 1. **Retryable failure** — explicit pre-processing rate limit (HTTP 429).
 *    The same envelope is resubmitted after an exponential back-off.
 * 2. **Unknown status** — timeout, HTTP 408/5xx, or network drop. {@link submitTransactionIdempotently}
 *    is called internally to poll for the real outcome before any re-try
 *    decision is made. This prevents blind double-submissions.
 * 3. **Non-retryable failure** — definitive rejection or expiry. The policy
 *    throws immediately without further attempts.
 *
 * @param transaction - A signed `Transaction` or `FeeBumpTransaction` to submit.
 * @param policy - Retry configuration. All fields have sensible defaults; only
 *   `maxAttempts` commonly needs tuning.
 * @returns The raw Horizon submission response on success.
 *
 * @throws {PocketPayError} with an `exhaustedResult` property when all
 *   attempts are consumed or a non-retryable failure is encountered.
 *   Inspect `error.exhaustedResult.finalOutcome` to understand why.
 *
 * @example
 * ```ts
 * import { withRetryPolicy } from '@axionvera/pocketpay-sdk';
 *
 * const policy = { maxAttempts: 4, initialBackoffMs: 1_000 };
 *
 * try {
 *   const result = await withRetryPolicy(signedTx, policy);
 *   console.log('Confirmed in ledger', result.ledger);
 * } catch (error) {
 *   if (error instanceof PocketPayError && error.exhaustedResult) {
 *     const { finalOutcome, attempts } = error.exhaustedResult;
 *     if (finalOutcome === 'non_retryable_failure') {
 *       // Rebuild the transaction — same envelope will never succeed.
 *     } else if (finalOutcome === 'unknown_status') {
 *       // Check the explorer before taking any action.
 *     } else {
 *       // Transient failures persisted through all retries.
 *     }
 *   }
 * }
 * ```
 */
export async function withRetryPolicy(
  transaction: StellarSDK.Transaction | StellarSDK.FeeBumpTransaction,
  policy: Partial<RetryPolicy> = {},
): Promise<any> {
  // Merge caller-supplied values over the defaults.
  const effectivePolicy: Required<Omit<RetryPolicy, 'config' | 'onAttempt'>> = {
    maxAttempts: policy.maxAttempts ?? DEFAULT_POLICY.maxAttempts,
    initialBackoffMs: policy.initialBackoffMs ?? DEFAULT_POLICY.initialBackoffMs,
    maxBackoffMs: policy.maxBackoffMs ?? DEFAULT_POLICY.maxBackoffMs,
    backoffMultiplier: policy.backoffMultiplier ?? DEFAULT_POLICY.backoffMultiplier,
    jitter: policy.jitter ?? DEFAULT_POLICY.jitter,
  };

  const { config, onAttempt } = policy;

  let lastOutcome: SubmissionOutcome | undefined;
  let lastError: PocketPayError | undefined;

  for (let attempt = 1; attempt <= effectivePolicy.maxAttempts; attempt++) {
    try {
      // Use `submitTransactionIdempotently` so that `unknown_status` cases
      // are resolved via polling rather than being surfaced as raw errors.
      // This is the key safety guarantee: we never blindly resubmit on timeout.
      const result = await submitTransactionIdempotently(transaction, {}, config);

      const txHash: string =
        (result as any)?.hash ?? transaction.hash().toString('hex');

      // Build a success outcome and return immediately.
      lastOutcome = classifySubmissionOutcome(undefined, txHash);
      return result;
    } catch (rawError) {
      // The idempotency layer can surface already-wrapped network errors.
      // Reclassify those too: an unacknowledged transport drop/timeout is an
      // unknown submission outcome, not permission to resubmit the envelope.
      const classified = classifySubmitError(rawError, transaction.hash().toString('hex'));

      lastError = classified;
      lastOutcome = classifySubmissionOutcome(classified);

      const isLastAttempt = attempt >= effectivePolicy.maxAttempts;

      // ── Non-retryable: throw immediately ──────────────────────────────────
      if (lastOutcome.kind === 'non_retryable_failure') {
        const exhausted: RetryPolicyExhaustedResult = {
          success: false,
          finalOutcome: 'non_retryable_failure',
          error: classified,
          attempts: attempt,
        };
        if (onAttempt) onAttempt(attempt, lastOutcome, 0);
        emitDiagnosticsEvent('network', 'network.retry.attempt', {
          attempt,
          outcome: lastOutcome.kind,
          delayMs: 0,
          txHash: transaction.hash().toString('hex'),
        });
        throw exhaustedError(exhausted);
      }

      // ── Unknown status: submitTransactionIdempotently already polled ───────
      // If it still threw TX_STATUS_UNKNOWN after polling, we give up — any
      // further submission attempt risks a duplicate.
      if (lastOutcome.kind === 'unknown_status') {
        const exhausted: RetryPolicyExhaustedResult = {
          success: false,
          finalOutcome: 'unknown_status',
          error: classified,
          attempts: attempt,
        };
        if (onAttempt) onAttempt(attempt, lastOutcome, 0);
        emitDiagnosticsEvent('network', 'network.retry.attempt', {
          attempt,
          outcome: lastOutcome.kind,
          delayMs: 0,
          txHash: transaction.hash().toString('hex'),
        });
        throw exhaustedError(exhausted);
      }

      // ── Retryable: apply backoff then loop ────────────────────────────────
      // `retryable_failure` is the only variant that continues the loop.
      if (isLastAttempt) {
        const exhausted: RetryPolicyExhaustedResult = {
          success: false,
          finalOutcome: 'retryable_failure',
          error: classified,
          attempts: attempt,
        };
        if (onAttempt) onAttempt(attempt, lastOutcome, 0);
        emitDiagnosticsEvent('network', 'network.retry.attempt', {
          attempt,
          outcome: lastOutcome.kind,
          delayMs: 0,
          txHash: transaction.hash().toString('hex'),
        });
        throw exhaustedError(exhausted);
      }

      // At this point lastOutcome.kind === 'retryable_failure' is guaranteed
      // by the process of elimination above, but TypeScript cannot infer it
      // after the early-return branches. We assert via a narrowed local.
      const retryableOutcome = lastOutcome as Extract<SubmissionOutcome, { kind: 'retryable_failure' }>;

      // Compute delay for the *next* attempt (attempt index is 0-based from 0).
      const delayMs = Math.max(
        computeDelay(attempt - 1, effectivePolicy),
        retryableOutcome.suggestedDelayMs,
      );

      if (onAttempt) onAttempt(attempt, retryableOutcome, delayMs);
      emitDiagnosticsEvent('network', 'network.retry.attempt', {
        attempt,
        outcome: retryableOutcome.kind,
        delayMs,
        txHash: transaction.hash().toString('hex'),
      });
      await sleep(delayMs);
    }
  }

  // This code is unreachable in normal flow, but TypeScript requires it.
  const finalError = lastError ?? new PocketPayError(
    'withRetryPolicy: unexpected exit from retry loop',
    'SEND_ERROR',
  );
  const exhausted: RetryPolicyExhaustedResult = {
    success: false,
    finalOutcome: 'retryable_failure',
    error: finalError,
    attempts: effectivePolicy.maxAttempts,
  };
  throw exhaustedError(exhausted);
}
