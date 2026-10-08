export type { ResultWarning, RecoveryHint } from '../types';
export { PaymentParseError, PaymentErrorCode } from './payment-errors';

// ─── Error Classification ───────────────────────────────────────────────────

import { PocketPayError, SubmissionOutcome } from '../types';
import {
  ErrorCategory,
  ErrorCode,
  ERROR_CODES,
  type ErrorCodeValue,
  isKnownErrorCode,
} from './codes';
import { describeError, getErrorCategory, redactError, redactSensitive, isRetryableCode } from './taxonomy';

export {
  ErrorCategory,
  ErrorCode,
  ERROR_CODES,
  isKnownErrorCode,
  describeError,
  getErrorCategory,
  redactError,
  redactSensitive,
  isRetryableCode,
};

// ─── Unsupported features and capability gating ─────────────────────────────

export {
  UnsupportedFeatureError,
  CapabilityMismatchError,
  DisabledFeatureError,
  isUnsupportedFeatureError,
  isCapabilityMismatchError,
  isDisabledFeatureError,
} from './unsupported';

export type {
  FeatureContext,
  UnsupportedFeatureOptions,
  CapabilityMismatchOptions,
  DisabledFeatureOptions,
} from './unsupported';

export {
  SDK_CAPABILITIES,
  getCapability,
  listCapabilities,
  assertCapability,
} from './capabilities';

export type { CapabilityStatus, CapabilitySpec } from './capabilities';


/**
 * Classifies raw network or Horizon submission errors into a structured `PocketPayError`
 * with attached status code, transaction hash, and retryability information.
 *
 * @param error - The raw error thrown by Horizon or fetch
 * @param txHash - Optional transaction hash associated with the submission
 * @returns A classified `PocketPayError`
 */
export function classifySubmitError(error: unknown, txHash?: string): PocketPayError {
  if (error instanceof PocketPayError) {
    if (txHash && !error.transactionHash) {
      (error as any).transactionHash = txHash;
    }
    return error;
  }

  const err = error as any;
  const status = err?.response?.status ?? err?.statusCode ?? err?.status;
  const resultCodes = err?.response?.data?.extras?.result_codes;

  if (resultCodes?.transaction) {
    const txCode = resultCodes.transaction;

    // tx_bad_seq is the one transaction result code with a distinct recovery
    // path: the envelope is permanently invalid, but rebuilding it against a
    // fresh sequence succeeds. Collapsing it into TX_FAILED with everything
    // else left callers parsing `message` to tell them apart. Every other
    // result code keeps its existing classification.
    if (txCode === 'tx_bad_seq') {
      return new PocketPayError(
        `Payment failed with transaction result code: ${txCode}`,
        ErrorCode.TX_BAD_SEQUENCE,
        {
          statusCode: 400,
          cause: err instanceof Error ? err : undefined,
          category: ErrorCategory.Transaction,
          safeMessage: ERROR_CODES[ErrorCode.TX_BAD_SEQUENCE].safeMessage,
        },
        txHash,
        // Not retryable: resubmitting the same signed envelope can never
        // succeed. Callers must rebuild — see requiresRebuild().
        false,
      );
    }

    return new PocketPayError(
      `Payment failed with transaction result code: ${txCode}`,
      ErrorCode.TX_FAILED,
      {
        statusCode: 400,
        cause: err instanceof Error ? err : undefined,
        category: ErrorCategory.Transaction,
        safeMessage: ERROR_CODES[ErrorCode.TX_FAILED].safeMessage,
      },
      txHash,
      false,
    );
  }

  const isTimeout =
    status === 504 ||
    err?.code === 'ETIMEDOUT' ||
    err?.code === 'ECONNRESET' ||
    err?.code === 'ENOTFOUND' ||
    (typeof err?.message === 'string' && err.message.toLowerCase().includes('timeout'));

  if (isTimeout) {
    return new PocketPayError(
      `Transaction status unknown after submission attempt for hash ${txHash ?? 'unknown'}`,
      ErrorCode.TX_STATUS_UNKNOWN,
      {
        statusCode: status || 504,
        cause: err instanceof Error ? err : undefined,
        category: ErrorCategory.Transaction,
        safeMessage: ERROR_CODES[ErrorCode.TX_STATUS_UNKNOWN].safeMessage,
      },
      txHash,
      false,
    );
  }

  if (status === 429) {
    return new PocketPayError(
      'Rate limit exceeded (429)',
      ErrorCode.NET_RATE_LIMITED,
      {
        statusCode: 429,
        cause: err instanceof Error ? err : undefined,
        category: ErrorCategory.Network,
        safeMessage: ERROR_CODES[ErrorCode.NET_RATE_LIMITED].safeMessage,
      },
      txHash,
      true,
    );
  }

  // Unknown / generic submission failure. Redact any secret material that may
  // have leaked into the raw message before storing it on the error.
  const rawMessage = err?.message || String(error);
  return new PocketPayError(
    `Transaction submission failed: ${redactSensitive(rawMessage)}`,
    ErrorCode.TX_FAILED,
    {
      statusCode: status,
      cause: err instanceof Error ? err : undefined,
      category: ErrorCategory.Transaction,
      safeMessage: ERROR_CODES[ErrorCode.TX_FAILED].safeMessage,
    },
    txHash,
    false,
  );
}

/**
 * Checks whether an error is marked as retryable.
 *
 * @param error - The error to check
 * @returns `true` if `error.retryable` is true
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof PocketPayError) {
    return Boolean(error.retryable);
  }
  return false;
}

/**
 * Checks whether an error has code `TX_STATUS_UNKNOWN`.
 *
 * @param error - The error to check
 * @returns `true` if the status of the transaction is unknown
 */
export function isUnknownStatusError(error: unknown): boolean {
  if (error instanceof PocketPayError) {
    return error.code === 'TX_STATUS_UNKNOWN';
  }
  return false;
}

/**
 * Returns `true` when the failure can only be recovered by **rebuilding** the
 * transaction against fresh account state — not by resubmitting the envelope.
 *
 * This is deliberately distinct from {@link isRetryableError} and
 * {@link isSafeToRetry}, which both mean "the same signed envelope may be sent
 * again". A `TX_BAD_SEQUENCE` failure is never safe to resubmit: the sequence
 * baked into the envelope is spent. Refresh the sequence, rebuild, re-sign.
 *
 * @param error - The error to check
 * @returns `true` for errors whose recovery is a rebuild
 *
 * @example
 * ```ts
 * const classified = classifySubmitError(rawError, txHash);
 * if (requiresRebuild(classified)) {
 *   sequences.invalidate(sourcePublicKey);
 *   await sendXLM(params); // rebuilt against a fresh sequence
 * }
 * ```
 */
export function requiresRebuild(error: unknown): boolean {
  if (error instanceof PocketPayError) {
    return error.code === ErrorCode.TX_BAD_SEQUENCE;
  }
  return false;
}

// ─── SubmissionOutcome Classification ───────────────────────────────────────

/**
 * Maps a raw submission result or error into a typed {@link SubmissionOutcome}.
 *
 * This is the primary entry point for categorising **what happened** after a
 * Horizon submission attempt. It produces a discriminated union with four
 * variants:
 *
 * - `"success"` — pass `txHash` and no `error`; represents a confirmed submit.
 * - `"retryable_failure"` — transient errors safe to retry (e.g. rate-limit).
 * - `"non_retryable_failure"` — definitive on-chain rejection; rebuild required.
 * - `"unknown_status"` — timeout/network drop; must poll before any action.
 *
 * Callers that catch a raw error should first run it through
 * {@link classifySubmitError} to obtain a `PocketPayError`, then pass that
 * result here.
 *
 * @example
 * ```ts
 * try {
 *   await server.submitTransaction(tx);
 *   const outcome = classifySubmissionOutcome(undefined, tx.hash().toString('hex'));
 * } catch (rawError) {
 *   const classified = classifySubmitError(rawError, txHash);
 *   const outcome = classifySubmissionOutcome(classified);
 * }
 * ```
 */
export function classifySubmissionOutcome(
  error: PocketPayError | undefined,
  txHash?: string,
): SubmissionOutcome {
  // ── Success path ──────────────────────────────────────────────────────────
  if (!error) {
    if (!txHash) {
      throw new Error(
        'classifySubmissionOutcome: txHash is required when error is undefined (success path)',
      );
    }
    return { kind: 'success', transactionHash: txHash };
  }

  // ── Unknown status (timeout / network drop) ───────────────────────────────
  if (error.code === 'TX_STATUS_UNKNOWN') {
    return {
      kind: 'unknown_status',
      error,
      transactionHash: error.transactionHash ?? txHash,
    };
  }

  // ── Transaction has already expired ───────────────────────────────────────
  // TX_EXPIRED means validators can never accept this envelope. Treat it as a
  // non-retryable failure so callers know they must rebuild, not just wait.
  if (error.code === 'TX_EXPIRED') {
    return { kind: 'non_retryable_failure', error };
  }

  // ── Retryable: rate-limit, transient network ───────────────────────────────
  if (error.retryable === true) {
    // Provide a sensible default backoff. For 429s the caller may use the
    // Retry-After header if available; here we default to 2 s.
    const suggestedDelayMs = error.statusCode === 429 ? 2_000 : 1_000;
    return { kind: 'retryable_failure', error, suggestedDelayMs };
  }

  // ── Definitive rejection (PAYMENT_FAILED, SEND_ERROR, etc.) ───────────────
  return { kind: 'non_retryable_failure', error };
}

/**
 * Returns `true` when it is safe to submit the **same signed transaction
 * envelope** again without first polling Horizon for its current status.
 *
 * Only `"retryable_failure"` outcomes qualify. Both `"unknown_status"` (must
 * poll first) and `"non_retryable_failure"` (must rebuild) return `false`.
 *
 * @example
 * ```ts
 * const outcome = classifySubmissionOutcome(classified);
 * if (isSafeToRetry(outcome)) {
 *   await delay(outcome.suggestedDelayMs);
 *   await submitTransactionIdempotently(tx);
 * }
 * ```
 */
export function isSafeToRetry(outcome: SubmissionOutcome): outcome is Extract<SubmissionOutcome, { kind: 'retryable_failure' }> {
  return outcome.kind === 'retryable_failure';
}

/**
 * Returns `true` when the submission outcome is `"unknown_status"`, meaning
 * the SDK could not determine whether the transaction reached on-chain
 * consensus. The caller **must** check transaction status via
 * {@link pollTransactionStatus} before deciding whether to rebuild or accept.
 *
 * Returning `true` here does **not** mean a retry is safe — it means a
 * status check is *required* before any further action is taken.
 *
 * @example
 * ```ts
 * const outcome = classifySubmissionOutcome(classified);
 * if (requiresStatusCheck(outcome)) {
 *   const txRecord = await pollTransactionStatus(tx, { maxPollAttempts: 10 });
 * }
 * ```
 */
export function requiresStatusCheck(outcome: SubmissionOutcome): outcome is Extract<SubmissionOutcome, { kind: 'unknown_status' }> {
  return outcome.kind === 'unknown_status';
}
