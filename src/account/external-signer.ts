/**
 * PocketPay SDK issue #212: abort-aware external signing contract.
 *
 * External signers hold private keys outside SDK memory. This module only
 * coordinates a request and returns an explicit, safe outcome; it never
 * sends transactions to Horizon or retries an unknown signing operation.
 */
import type * as StellarSDK from '@stellar/stellar-sdk';
import type { ExternalSignerAdapter } from './types';

export type SignableExternalTransaction =
  StellarSDK.Transaction | StellarSDK.FeeBumpTransaction;

/** Never include a secret key in this request. */
export interface ExternalSignatureRequest {
  readonly transaction: SignableExternalTransaction;
  readonly networkPassphrase: string;
  readonly signal: AbortSignal;
}

/** Device-defined result without potentially sensitive exception messages. */
export type ExternalDeviceSignOutcome =
  | { readonly status: 'signed'; readonly transaction: SignableExternalTransaction }
  | { readonly status: 'cancelled' | 'rejected' | 'unavailable' | 'failed' };

/**
 * Opt-in extension for devices able to honor an AbortSignal during approval.
 * The legacy ExternalSignerAdapter.sign() remains compatible and unchanged.
 * Implementers MUST stop transport prompts where possible and MUST NOT submit
 * anything after cancellation. A device may already have created a signature;
 * consumers must discard late results and must never auto-resubmit.
 */
export interface AbortableExternalSignerAdapter extends ExternalSignerAdapter {
  requestSignature(request: ExternalSignatureRequest): Promise<ExternalDeviceSignOutcome>;
}

export interface ExternalSignatureOptions {
  /** Verify a device is signing for the expected public identity. */
  expectedPublicKey?: string;
  /** Explicit cancellation of a pending approval. */
  signal?: AbortSignal;
}

/** Stable status codes for UI and transaction orchestration. */
export type ExternalSignatureOutcome =
  | { readonly status: 'signed'; readonly transaction: SignableExternalTransaction }
  | {
      readonly status: 'cancelled' | 'rejected' | 'unavailable' | 'failed' | 'mismatch';
      readonly retryable: false;
      readonly safeMessage: string;
    };

const SAFE_MESSAGES = {
  cancelled: 'The signature request was cancelled. No transaction was submitted.',
  rejected: 'The signer declined the signature request.',
  unavailable: 'The external signer is unavailable.',
  failed: 'The external signer could not complete the request.',
  mismatch: 'The external signer does not match the requested account.',
} as const;

function fail(status: keyof typeof SAFE_MESSAGES): ExternalSignatureOutcome {
  return { status, retryable: false, safeMessage: SAFE_MESSAGES[status] };
}

/**
 * Request external approval, returning one typed outcome rather than leaking
 * device/transport errors. An AbortSignal settles the consumer-side request
 * promptly even if a nonconforming device ignores it; its late result is
 * ignored. This function NEVER submits a signature to a network.
 */
export async function requestExternalSignature(
  adapter: AbortableExternalSignerAdapter,
  transaction: SignableExternalTransaction,
  networkPassphrase: string,
  options: ExternalSignatureOptions = {},
): Promise<ExternalSignatureOutcome> {
  const signal = options.signal ?? new AbortController().signal;
  if (signal.aborted) return fail('cancelled');
  if (!transaction || typeof networkPassphrase !== 'string' || !networkPassphrase.trim()) {
    return fail('failed');
  }

  try {
    if (!adapter || !adapter.isAvailable || typeof adapter.requestSignature !== 'function') {
      return fail('unavailable');
    }
    if (
      options.expectedPublicKey &&
      adapter.publicKey !== options.expectedPublicKey
    ) {
      return fail('mismatch');
    }
  } catch {
    // A transport-backed availability or identity getter can itself fail.
    return fail('failed');
  }

  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<ExternalSignatureOutcome>((resolve) => {
    onAbort = () => resolve(fail('cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
  });

  // The rejection handler is attached immediately. Even after an aborted
  // Promise.race there is no unhandled device failure or leaked error text.
  const deviceCall: Promise<ExternalSignatureOutcome> = Promise.resolve()
    .then(() =>
      adapter.requestSignature({
        transaction,
        networkPassphrase,
        signal,
      }),
    )
    .then(
      (outcome): ExternalSignatureOutcome => {
        if (signal.aborted) return fail('cancelled');
        switch (outcome?.status) {
          case 'signed':
            return outcome.transaction
              ? { status: 'signed', transaction: outcome.transaction }
              : fail('failed');
          case 'cancelled':
          case 'rejected':
          case 'unavailable':
          case 'failed':
            return fail(outcome.status);
          default:
            return fail('failed');
        }
      },
      (): ExternalSignatureOutcome => (signal.aborted ? fail('cancelled') : fail('failed')),
    );

  try {
    // The host receives cancellation without waiting for a disconnected
    // hardware device or browser extension to finish an unresolved prompt.
    const result = await Promise.race([deviceCall, cancelled]);
    return signal.aborted ? fail('cancelled') : result;
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}
