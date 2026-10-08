/**
 * Stellar PocketPay SDK — Transaction lifecycle orchestrator.
 *
 * Implements the five stage boundaries of
 * [ADR 0005](../../docs/adr/0005-transaction-lifecycle.md) over the modules that
 * already exist: preparation in `transactions/offline-preparation.ts`, sequence
 * in `account/sequence.ts`, guarded submission and polling in
 * `network/idempotency.ts`, outcome classification in `errors/index.ts`.
 *
 * @remarks
 * The piece this module exists for is {@link submitGuarded}. The SDK shipped
 * `submitTransactionIdempotently` with a single call site — `retry-policy.ts` —
 * while three paths submitted straight to Horizon with no duplicate protection
 * at all. Routing every write through one guarded entry point is the point of
 * the orchestrator, not an incidental benefit of it.
 *
 * @security A submission timeout does not prove failure. Per ADR 0005,
 * "unresolved is not failure": the envelope may already be on-chain, so the
 * only safe recovery is to poll, never to resubmit or rebuild blindly.
 */

import { defaultSequenceProvider } from '../account/sequence';
import { resolveConfig } from '../config';
import { classifySubmissionOutcome, classifySubmitError } from '../errors';
import { submitTransactionIdempotently, withTimeout } from '../network';
import type {
  LifecycleFailure,
  LifecycleResult,
  LifecycleStage,
  SDKConfig,
  SubmissionOutcome,
} from '../types';
import { TransactionStatus } from '../types/transaction';
import { PocketPayError } from '../types';
import type { GuardedSubmitOptions, SubmittableTransaction } from './guarded-submit';
import { submitWithGuard } from './guarded-submit';
import {
  buildUnsignedTransaction,
  fetchNetworkState,
  prepareTransactionOffline,
  signTransaction,
  updateWithNetworkState,
  type OfflineTransactionParams,
  type PreparedTransaction,
  type SignedTransaction,
  type UnsignedTransaction,
} from './offline-preparation';

export type { GuardedSubmitOptions, SubmittableTransaction };
export { submitWithGuard };

/** Defaults mirrored from `IdempotencyOptions` so the deadline can be derived. */
const DEFAULT_MAX_POLL_ATTEMPTS = 10;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

/**
 * Maps a classified submission outcome onto the lifecycle axes.
 *
 * `unknown_status` becomes `unresolved`, never `rejected`. `retryable_failure`
 * leaves the operation `submitted` with a `PENDING` status, because the same
 * signed envelope may still be resubmitted — it was not rejected.
 */
function toLifecycleResult(outcome: SubmissionOutcome): LifecycleResult {
  switch (outcome.kind) {
    case 'success':
      return {
        state: 'confirmed',
        stage: 'confirm',
        status: TransactionStatus.COMPLETED,
        actionRequired: 'none',
        transactionHash: outcome.transactionHash,
      };
    case 'retryable_failure':
      return {
        state: 'submitted',
        stage: 'submit',
        status: TransactionStatus.PENDING,
        actionRequired: 'retry',
        failure: toLifecycleFailure(outcome.error),
      };
    case 'non_retryable_failure':
      return {
        state: 'rejected',
        stage: 'submit',
        status: TransactionStatus.FAILED,
        actionRequired: 'rebuild',
        failure: toLifecycleFailure(outcome.error),
      };
    case 'unknown_status':
      return {
        state: 'unresolved',
        stage: 'confirm',
        status: TransactionStatus.UNKNOWN,
        actionRequired: 'poll',
        ...(outcome.transactionHash ? { transactionHash: outcome.transactionHash } : {}),
        failure: toLifecycleFailure(outcome.error),
      };
    default: {
      // Adding a variant to SubmissionOutcome without handling it here becomes
      // a compile error. The value is never interpolated, so an unexpected
      // payload cannot leak through this branch.
      const exhaustive: never = outcome;
      void exhaustive;
      return {
        state: 'unresolved',
        stage: 'confirm',
        status: TransactionStatus.UNKNOWN,
        actionRequired: 'poll',
      };
    }
  }
}

/** Projects an SDK error down to the two fields a lifecycle result may carry. */
function toLifecycleFailure(error: PocketPayError): LifecycleFailure {
  return {
    code: error.code,
    safeMessage: error.safeMessage ?? 'The transaction could not be completed.',
  };
}

/**
 * Total wall-clock budget for a guarded submission.
 *
 * @remarks
 * `submitTransactionIdempotently` submits without a timeout of its own
 * (`src/network/idempotency.ts`): it only reacts to an error, and on
 * `TX_STATUS_UNKNOWN` it polls. Wrapping it in a bare `withTimeout(cfg.timeout)`
 * would abort exactly the polling that makes it safe, so the deadline has to
 * cover the submission **plus** the whole polling budget.
 */
function submissionDeadlineMs(timeoutMs: number, options: GuardedSubmitOptions): number {
  const attempts = options.maxPollAttempts ?? DEFAULT_MAX_POLL_ATTEMPTS;
  const interval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  return timeoutMs + attempts * interval;
}

/**
 * Stage 4–5 — submit a signed envelope through the duplicate-submission guard,
 * then reconcile the outcome.
 *
 * This is the only submission path the SDK should use. It never resubmits an
 * envelope blindly: an unknown status is polled, and a caller that receives
 * `state: 'unresolved'` must poll rather than rebuild.
 *
 * @param transaction - A signed `Transaction` or `FeeBumpTransaction`.
 * @param options - Polling budget for the unknown-status path.
 * @param config - Optional SDK config overrides.
 * @returns The raw Horizon response plus the reconciled lifecycle result.
 */
export async function submitGuarded(
  transaction: SubmittableTransaction,
  options: GuardedSubmitOptions = {},
  config?: Partial<SDKConfig>,
): Promise<{ result: LifecycleResult; response?: unknown }> {
  const cfg = resolveConfig(config);
  const transactionHash = transaction.hash().toString('hex');
  const deadline = submissionDeadlineMs(cfg.timeout, options);

  try {
    const response = await withTimeout(
      'Horizon transaction submission',
      deadline,
      submitTransactionIdempotently(transaction, options, config),
    );

    // An RPC record is not evidence of success merely because it is truthy
    // or contains a hash. Bind its identity to this exact signed envelope and
    // require an explicit boolean outcome before reporting ledger confirmation.
    let responseHash: unknown;
    let successful: unknown;
    try {
      responseHash = (response as { hash?: unknown } | null | undefined)?.hash;
      successful = (response as { successful?: unknown } | null | undefined)?.successful;
    } catch {
      // Unexpected provider accessors are no stronger than missing evidence.
    }
    let outcomeError: PocketPayError | undefined;
    if (
      typeof responseHash !== 'string' ||
      responseHash.toLowerCase() !== transactionHash.toLowerCase() ||
      typeof successful !== 'boolean'
    ) {
      outcomeError = new PocketPayError(
        'The transaction outcome could not be verified on Horizon.',
        'TX_STATUS_UNKNOWN',
        504,
        undefined,
        transactionHash,
        false,
      );
    } else if (!successful) {
      outcomeError = new PocketPayError(
        'Horizon reports that the transaction was rejected.',
        'TX_REJECTED',
        400,
        undefined,
        transactionHash,
        false,
      );
    }

    return {
      response,
      result: toLifecycleResult(classifySubmissionOutcome(outcomeError, transactionHash)),
    };
  } catch (error) {
    const classified = classifySubmitError(error, transactionHash);
    return {
      result: toLifecycleResult(classifySubmissionOutcome(classified, transactionHash)),
    };
  }
}

/**
 * Reconciles a raw submission error into a lifecycle result without submitting.
 *
 * Useful for helpers that already performed their own submission and need the
 * same state vocabulary, and for tests that exercise the reconciliation stage
 * in isolation.
 *
 * @param error - The error thrown by a submission attempt, if any.
 * @param transactionHash - Hash of the envelope that was submitted.
 */
export function reconcileSubmission(
  error: unknown | undefined,
  transactionHash: string,
): LifecycleResult {
  if (error === undefined) {
    return toLifecycleResult(classifySubmissionOutcome(undefined, transactionHash));
  }
  const classified = classifySubmitError(error, transactionHash);
  return toLifecycleResult(classifySubmissionOutcome(classified, transactionHash));
}

/**
 * Returns `true` when a lifecycle result must not be rebuilt or resubmitted.
 *
 * A guard for consumers: `unresolved` looks like a failure and is not one.
 */
export function requiresStatusResolution(result: LifecycleResult): boolean {
  return result.state === 'unresolved';
}

// ─── The five stages, as callable boundaries ────────────────────────────────

/**
 * Stage 1 — prepare intent.
 *
 * Local validation only: no network call and no secret key. Delegates to the
 * validators the SDK already owns rather than introducing a parallel set; the
 * reusable validation pipeline is the subject of issue #249, and this stage is
 * the boundary that will consume it.
 *
 * @param params - Source account, operations, memo and optional time bounds.
 * @returns A prepared transaction that cannot yet be submitted.
 */
export function prepareIntent(params: OfflineTransactionParams): PreparedTransaction {
  return prepareTransactionOffline(params);
}

/**
 * Stage 2 — bind network state and build.
 *
 * Binds a fresh sequence, fee and passphrase to the intent and produces an
 * unsigned deterministic envelope. Per ADR 0005 the sequence must be fresh:
 * `isPreparedSequenceStale` exists precisely because a snapshot can be
 * superseded while it sits unused.
 *
 * @param prepared - Output of {@link prepareIntent}.
 * @param config - Optional SDK config overrides.
 * @returns An unsigned envelope with its hash.
 */
export async function bindAndBuild(
  prepared: PreparedTransaction,
  config?: Partial<SDKConfig>,
): Promise<UnsignedTransaction> {
  const state = await fetchNetworkState(prepared.sourcePublicKey, config);
  return buildUnsignedTransaction(updateWithNetworkState(prepared, state));
}

/**
 * Stage 3 — authorize and sign.
 *
 * The envelope and its hash become immutable here. The hash is the identity of
 * the signed envelope: rebuilding with a new sequence, fee or time bound yields
 * a different envelope and a different hash, even for the same business intent.
 *
 * @param unsigned - Output of {@link bindAndBuild}.
 * @param secretKey - Secret of an authorized signer.
 * @returns The immutable signed envelope.
 */
export function authorizeAndSign(
  unsigned: UnsignedTransaction,
  secretKey: string,
): SignedTransaction {
  return signTransaction(unsigned, secretKey);
}

/**
 * Runs all five stages end to end.
 *
 * Every stage boundary stays observable: the returned result names the stage
 * that was reached, so a failure at build time is distinguishable from one at
 * submission — which matters because only the latter can leave a transaction in
 * an unresolved state.
 *
 * @param params - Transaction intent.
 * @param secretKey - Secret of an authorized signer.
 * @param options - Polling budget for the unknown-status path.
 * @param config - Optional SDK config overrides.
 * @returns The reconciled lifecycle result. Never throws.
 *
 * Concurrent executions from one source account are serialized across the
 * prepare/build/sign/submit stages by the shared, per-process SequenceProvider.
 * A different process still needs an external lock, and an `unresolved`
 * submission must be reconciled before starting another same-source intent.
 */
export async function executeTransactionLifecycle(
  params: OfflineTransactionParams,
  secretKey: string,
  options: GuardedSubmitOptions = {},
  config?: Partial<SDKConfig>,
): Promise<LifecycleResult> {
  return defaultSequenceProvider.withSequence(params.sourcePublicKey, async () => {
    let stage: LifecycleStage = 'intent';

    try {
      const prepared = prepareIntent(params);

      stage = 'build';
      const unsigned = await bindAndBuild(prepared, config);

      stage = 'sign';
      const signed = authorizeAndSign(unsigned, secretKey);

      stage = 'submit';
      const { result } = await submitGuarded(signed.transaction, options, config);
      return result;
    } catch (error) {
      // A failure before submission never leaves the network in an unknown
      // state: nothing was sent, so the safe recovery is to fix the input and
      // rebuild — never to poll for a transaction that does not exist.
      const classified = classifySubmitError(error, '');
      return {
        state: 'rejected',
        stage,
        status: TransactionStatus.FAILED,
        actionRequired: 'rebuild',
        failure: toLifecycleFailure(classified),
      };
    }
  });
}
