/**
 * Strict import boundary for signing-capable Stellar wallet material (#334).
 * This code intentionally never returns, logs or retains an input value in
 * errors, diagnostics or validation metadata.
 */
import * as StellarSDK from '@stellar/stellar-sdk';
import { PocketPayError } from '../types';
import { validateSecretKey } from '../utils';

export type WalletImportFailureReason =
  | 'not_a_string'
  | 'missing'
  | 'public_key_only'
  | 'unsupported_account_material'
  | 'unsupported_format'
  | 'invalid_length'
  | 'invalid_format'
  | 'import_failed';

const FAILURE_MESSAGES: Record<WalletImportFailureReason, string> = {
  not_a_string: 'Wallet import requires a Stellar secret key string.',
  missing: 'Enter the Stellar secret key to restore this wallet.',
  public_key_only: 'A Stellar public address cannot restore signing access. Use a secret key beginning with S.',
  unsupported_account_material: 'This account or contract address is not a wallet secret. Use a Stellar secret key beginning with S.',
  unsupported_format: 'Unsupported wallet import format. Use a Stellar secret key beginning with S.',
  invalid_length: 'Stellar secret keys must be 56 characters long.',
  invalid_format: 'The Stellar secret key has an invalid checksum or encoding.',
  import_failed: 'Wallet import could not be completed. Verify the secret key and try again.',
};

function failure(reason: WalletImportFailureReason): PocketPayError {
  return new PocketPayError(FAILURE_MESSAGES[reason], 'INVALID_SECRET_KEY', {
    validation: { field: 'secretKey', reason },
  });
}

/**
 * Strip any raw exception/cause, including unexpected SDK exceptions whose
 * messages or custom properties may embed the secret that was supplied.
 * Never preserve `validation.value` on import failures.
 */
export function sanitizeWalletImportError(error: unknown): PocketPayError {
  let reason: WalletImportFailureReason = 'import_failed';
  // Do not assume an Error received from another SDK boundary has benign
  // metadata getters or a readable prototype. Even code/validation.reason can
  // be accessor properties (or Proxy traps) that throw or expose the seed.
  // Import failure sanitation must itself remain a nonthrowing operation.
  try {
    if (error instanceof PocketPayError && error.code === 'INVALID_SECRET_KEY') {
      const candidate = error.validation?.reason;
      if (candidate === 'invalid_prefix') {
        reason = 'unsupported_format';
      } else if (
        typeof candidate === 'string' &&
        Object.prototype.hasOwnProperty.call(FAILURE_MESSAGES, candidate)
      ) {
        reason = candidate as WalletImportFailureReason;
      }
    }
  } catch {
    // Malformed/hostile metadata is not a trusted reason. Preserve only a
    // fixed safe default; never echo raw error.message, cause or getter text.
    reason = 'import_failed';
  }
  return failure(reason);
}

/**
 * Validate secret material without exposing its value. This is intentionally
 * stricter/more descriptive than the legacy general-purpose validateSecretKey.
 * No wallet is created or changed when validation fails.
 */
export function validateWalletImportInput(input: unknown): boolean {
  if (typeof input !== 'string') throw failure('not_a_string');
  const key = input.trim();
  if (!key) throw failure('missing');

  // Only classify syntactically valid Stellar address material semantically.
  // Prefix lookalikes with bad length/checksum are malformed input, not genuine
  // public/muxed/contract addresses.
  if (key.startsWith('G')) {
    throw failure(
      StellarSDK.StrKey.isValidEd25519PublicKey(key)
        ? 'public_key_only'
        : 'invalid_format',
    );
  }
  if (key.startsWith('M')) {
    throw failure(
      StellarSDK.StrKey.isValidMed25519PublicKey(key)
        ? 'unsupported_account_material'
        : 'invalid_format',
    );
  }
  if (key.startsWith('C')) {
    throw failure(
      StellarSDK.StrKey.isValidContract(key)
        ? 'unsupported_account_material'
        : 'invalid_format',
    );
  }
  if (!key.startsWith('S')) throw failure('unsupported_format');

  try {
    validateSecretKey(key);
  } catch (error) {
    throw sanitizeWalletImportError(error);
  }
  return true;
}
