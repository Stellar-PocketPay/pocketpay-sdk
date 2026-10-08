import * as StellarSDK from '@stellar/stellar-sdk';
import { getHorizonServer } from '../config';
import { PocketPayError, SDKConfig } from '../types';
import { classifySubmitError } from '../errors';
import { emitDiagnosticsEvent } from '../diagnostics/hooks';

export interface IdempotencyOptions {
  /** Maximum number of poll attempts (default: 10) */
  maxPollAttempts?: number;
  /** Delay between poll attempts in milliseconds (default: 2000) */
  pollIntervalMs?: number;
}

/**
 * Submits a transaction to Horizon with idempotency handling.
 * If a timeout or network error occurs during submission, it polls Horizon
 * to check if the transaction eventually succeeded, up until the transaction's
 * maxTime bounds or maximum poll attempts.
 *
 * @param transaction - The transaction to submit (Transaction or FeeBumpTransaction)
 * @param options - Polling interval and max attempts configuration
 * @param config - Optional SDK config overrides
 * @returns The successful submission transaction response from Horizon
 */
export async function submitTransactionIdempotently(
  transaction: StellarSDK.Transaction | StellarSDK.FeeBumpTransaction,
  options: IdempotencyOptions = {},
  config?: Partial<SDKConfig>
): Promise<any> {
  const txHash = transaction.hash().toString('hex');
  const server = getHorizonServer(config);

  emitDiagnosticsEvent('transaction', 'transaction.submit.started', {
    txHash,
    operationCount:
      'operations' in transaction ? transaction.operations.length : undefined,
  });

  try {
    const result = await server.submitTransaction(transaction);
    emitDiagnosticsEvent('transaction', 'transaction.submit.succeeded', {
      txHash: (result as { hash?: string })?.hash ?? txHash,
      ledger: (result as { ledger?: number })?.ledger,
    });
    return result;
  } catch (error) {
    const classified = classifySubmitError(error, txHash);

    emitDiagnosticsEvent('transaction', 'transaction.submit.failed', {
      txHash,
      code: classified.code,
      retryable: classified.retryable,
    });

    // If the status is unknown (timeout/network error), we poll for the status instead of throwing immediately.
    if (classified.code === 'TX_STATUS_UNKNOWN') {
      emitDiagnosticsEvent('transaction', 'transaction.submit.polling', {
        txHash,
      });
      return await pollTransactionStatus(transaction, options, config);
    }

    throw classified;
  }
}

/**
 * Polls Horizon for the status of a transaction by its hash.
 * A matching successful:true record confirms execution; a matching
 * successful:false record is terminal failure. Incomplete or mismatched
 * records remain unknown. Query before classifying local timebound expiry.
 *
 * @param transaction - The transaction to check status for
 * @param options - Polling options (maxPollAttempts, pollIntervalMs)
 * @param config - Optional SDK config overrides
 * @returns The transaction record from Horizon once successfully found
 */
export async function pollTransactionStatus(
  transaction: StellarSDK.Transaction | StellarSDK.FeeBumpTransaction,
  options: IdempotencyOptions = {},
  config?: Partial<SDKConfig>
): Promise<any> {
  const txHash = transaction.hash().toString('hex');
  const server = getHorizonServer(config);
  const maxPollAttempts = options.maxPollAttempts ?? 10;
  const pollIntervalMs = options.pollIntervalMs ?? 2000;

  // Retrieve maxTime from the transaction's timeBounds (handle both Transaction & FeeBumpTransaction)
  let maxTime: bigint | undefined;
  if ('timeBounds' in transaction && transaction.timeBounds) {
    maxTime = BigInt(transaction.timeBounds.maxTime);
  } else if ('innerTransaction' in transaction && (transaction as any).innerTransaction?.timeBounds) {
    maxTime = BigInt((transaction as any).innerTransaction.timeBounds.maxTime);
  }

  for (let attempt = 1; attempt <= maxPollAttempts; attempt++) {
    // A past timeBound does not mean the payment failed: it could have been
    // accepted before maxTime. Always query status before classifying expiry.
    let confirmedNotFound = false;
    try {
      const txRecord = await server.transactions().transaction(txHash).call();
      if (txRecord && typeof txRecord.hash === 'string' &&
          txRecord.hash.toLowerCase() === txHash.toLowerCase()) {
        if (txRecord.successful === true) {
          return txRecord;
        }
        if (txRecord.successful === false) {
          throw new PocketPayError(
            'Transaction was included in a ledger but did not succeed.',
            'TX_FAILED',
            400,
            undefined,
            txHash,
            false
          );
        }
      }
      // No matching hash AND explicit successful:true means no confirmation.
      // A malformed record is unknown, never proof of success or absence.
    } catch (error: any) {
      // Only a real Horizon 404 supports timebound expiry classification.
      // Timeouts, stale index snapshots and malformed results remain uncertain.
      confirmedNotFound = error?.response?.status === 404 || error?.status === 404;
      if (!confirmedNotFound) {
        const classified = classifySubmitError(error, txHash);
        if (classified.code !== 'TX_STATUS_UNKNOWN') {
          throw classified;
        }
      }
    }

    if (confirmedNotFound && maxTime && maxTime > 0n) {
      const nowInSeconds = BigInt(Math.floor(Date.now() / 1000));
      if (nowInSeconds > maxTime) {
        throw new PocketPayError(
          `Transaction timebound expired after a Horizon 404 (maxTime ${maxTime.toString()}); confirm finality before rebuilding.`,
          'TX_EXPIRED',
          400,
          undefined,
          txHash,
          false
        );
      }
    }

    // Wait before the next poll attempt
    if (attempt < maxPollAttempts) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  throw new PocketPayError(
    `Failed to determine transaction status after ${maxPollAttempts} attempts.`,
    'TX_STATUS_UNKNOWN',
    504,
    undefined,
    txHash,
    false
  );
}
