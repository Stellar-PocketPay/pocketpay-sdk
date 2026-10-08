/**
 * Guarded submission — ADR 0005 stage 4 (issue #305).
 *
 * Lives in its own module so both the one-shot payment helpers and the staged
 * pipeline in `offline-preparation.ts` can use it without either importing the
 * orchestrator, which imports them back. `pnpm check:circular` rejects that
 * cycle even when the import is type-only.
 */

import type * as StellarSDK from '@stellar/stellar-sdk';
import { getHorizonServer, resolveConfig } from '../config';
import { classifySubmitError } from '../errors';
import { pollTransactionStatus, withTimeout } from '../network';
import { PocketPayError, type SDKConfig } from '../types';

/** Any signed envelope the SDK can submit. */
export type SubmittableTransaction =
  | StellarSDK.Transaction
  | StellarSDK.FeeBumpTransaction;

/** Polling budget applied after an unknown submission status. */
export interface GuardedSubmitOptions {
  /** Maximum number of poll attempts (default: 10). */
  maxPollAttempts?: number;
  /** Delay between poll attempts in milliseconds (default: 2000). */
  pollIntervalMs?: number;
}

/**
 * Stage 4 — submit through the duplicate-submission guard, preserving the
 * caller's existing error surface.
 *
 * This is what the one-shot payment helpers use. It differs from
 * the orchestrator's `submitGuarded` in two ways that matter to them:
 *
 * 1. The raw submission carries `cfg.timeout`, which
 *    `submitTransactionIdempotently` does not apply to its own network call.
 * 2. A **definitive** rejection re-throws the *original* Horizon error, so the
 *    helper's existing result-code mapping still runs. The guard changes when
 *    the SDK gives up, not which error code a rejected transaction produces.
 *
 * Only the unknown-status case is intercepted: there the envelope may already
 * be on-chain, so the SDK polls instead of surfacing a failure the caller might
 * "fix" by paying twice.
 *
 * @param transaction - A signed envelope.
 * @param options - Polling budget for the unknown-status path.
 * @param config - Optional SDK config overrides.
 * @returns The Horizon response, either from the submission or from polling.
 * @throws The original submission error when the rejection is definitive.
 */
export async function submitWithGuard(
  transaction: SubmittableTransaction,
  options: GuardedSubmitOptions = {},
  config?: Partial<SDKConfig>,
): Promise<unknown> {
  const cfg = resolveConfig(config);
  const server = getHorizonServer(config);

  try {
    return await withTimeout(
      'Horizon transaction submission',
      cfg.timeout,
      server.submitTransaction(transaction as StellarSDK.Transaction),
    );
  } catch (error) {
    const classified = classifySubmitError(error, transaction.hash().toString('hex'));

    if (classified.code === 'TX_STATUS_UNKNOWN') {
      try {
        return await pollTransactionStatus(transaction, options, config);
      } catch (pollError) {
        // Expiry is definitive: the original envelope cannot settle after
        // maxTime. Preserve that outcome so callers may rebuild safely.
        if (pollError instanceof PocketPayError && pollError.code === 'TX_EXPIRED') {
          throw pollError;
        }
        // An unresolved or failed lookup does not prove rejection. Keep the
        // original unknown-outcome classification and stage metadata.
        throw classified;
      }
    }

    // Definitive rejection: hand back exactly what Horizon said so the
    // caller's own mapping is unchanged by this guard.
    throw error;
  }
}

