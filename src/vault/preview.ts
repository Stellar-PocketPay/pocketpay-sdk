import * as StellarSDK from '@stellar/stellar-sdk';
import { resolveConfigWithoutDiagnostics } from '../config';
import { PocketPayError } from '../types';
import type { SDKConfig, StellarAssetSpec, StellarNetwork } from '../types';
import { validateAmount, validatePublicKey } from '../utils';
import {
  VAULT_ACTION_READINESS,
  type VaultActionKind,
} from './intents';

/** Vault actions that can be represented safely before execution. */
export type VaultPreviewAction = Extract<
  VaultActionKind,
  'deposit' | 'withdraw' | 'getBalance' | 'createLock'
>;

/** Input for a side-effect-free vault operation preview. */
export type VaultOperationPreviewParams =
  | {
      operation: 'deposit' | 'withdraw';
      /** Public wallet address only. Secret keys are never accepted by previews. */
      wallet: string;
      amount: string;
      unlockAt?: never;
    }
  | {
      operation: 'getBalance';
      /** Public wallet address only. Secret keys are never accepted by previews. */
      wallet: string;
      amount?: never;
      unlockAt?: never;
    }
  | {
      operation: 'createLock';
      /** Public wallet address only. Secret keys are never accepted by previews. */
      wallet: string;
      amount: string;
      /** Unix timestamp in seconds at which the proposed lock becomes withdrawable. */
      unlockAt: number;
    };

/** Stable review-before-action model for vault operations. */
export interface VaultOperationPreview {
  operation: VaultPreviewAction;
  /** Canonical native vault asset. */
  asset: StellarAssetSpec;
  /** Public wallet address; never a secret. */
  wallet: string;
  /** Requested amount, absent for a balance lookup. */
  amount?: string;
  /** Proposed unlock time for createLock previews, in Unix seconds. */
  unlockAt?: number;
  network: StellarNetwork;
  /** Base fee estimate in stroops. Read-only balance previews use "0". */
  estimatedFee: string;
  /** Whether the current SDK can execute the modelled action today. */
  supported: boolean;
  /** Safe, non-secret caveats a confirmation UI can render verbatim. */
  warnings: string[];
}

const XLM_ASSET: StellarAssetSpec = Object.freeze({ code: 'XLM' });

const BOOKKEEPING_WARNING =
  'The current Savings Vault contract records internal balances; this preview does not imply native XLM custody.';
const SOROBAN_FEE_WARNING =
  'Estimated fee is the Stellar base-fee floor; final Soroban resource fees are determined during simulation.';
const LOCK_PREVIEW_WARNING =
  'Lock actions can be previewed, but the current SDK does not execute vault lock operations.';

function isVaultPreviewAction(operation: unknown): operation is VaultPreviewAction {
  return (
    operation === 'deposit' ||
    operation === 'withdraw' ||
    operation === 'getBalance' ||
    operation === 'createLock'
  );
}

function operationRequiresAmount(operation: VaultPreviewAction): boolean {
  return operation === 'deposit' || operation === 'withdraw' || operation === 'createLock';
}

/** Snapshot an untrusted runtime property exactly once, with a typed failure. */
function readPreviewField(
  params: VaultOperationPreviewParams,
  field: 'operation' | 'wallet' | 'amount' | 'unlockAt',
): unknown {
  try {
    return (params as unknown as Record<string, unknown>)[field];
  } catch {
    throw new PocketPayError('Vault preview parameter could not be read', 'INVALID_OPERATION', {
      validation: { field, reason: 'unreadable' },
    });
  }
}

function isSecretSeedLike(value: unknown): boolean {
  // Any S-prefixed wallet value belongs on the secret-key error path. Even a
  // truncated or mistyped seed must not reach validatePublicKey(), whose
  // validation error intentionally includes the supplied public-key value.
  return typeof value === 'string' && value.trim().toUpperCase().startsWith('S');
}

function validateLockUnlockAt(operation: VaultPreviewAction, unlockAt: unknown): void {
  if (operation !== 'createLock') return;

  if (!Number.isSafeInteger(unlockAt) || (unlockAt as number) <= 0) {
    // Preview validation is support-safe: rejected input values are never
    // copied into serializable error metadata, including numeric timestamps.
    throw new PocketPayError(
      'Vault lock previews require unlockAt as a positive integer Unix timestamp',
      'INVALID_OPERATION',
      {
        validation: {
          field: 'unlockAt',
          reason: unlockAt === undefined ? 'missing' : 'invalid_timestamp',
        },
      },
    );
  }

  if ((unlockAt as number) <= Math.floor(Date.now() / 1000)) {
    throw new PocketPayError(
      'Vault lock previews require unlockAt to be in the future',
      'INVALID_OPERATION',
      {
        validation: {
          field: 'unlockAt',
          reason: 'not_future',
        },
      },
    );
  }
}

/**
 * Builds a vault confirmation model without signing, simulating, or submitting.
 *
 * The preview accepts a public wallet address only so it is safe to log or
 * display as application state. Input validation delegates to the SDK's
 * existing typed validators.
 */
export function buildVaultOperationPreview(
  params: VaultOperationPreviewParams,
  config?: Partial<SDKConfig>,
): VaultOperationPreview {
  // TypeScript types do not protect JavaScript and JSON callers at runtime.
  // Reject malformed container values with the SDK's typed error contract.
  let isObject = false;
  try {
    isObject = params !== null && typeof params === 'object' && !Array.isArray(params);
  } catch {
    // Array.isArray throws on revoked Proxies; treat that like invalid input.
  }
  if (!isObject) {
    throw new PocketPayError('Vault preview parameters must be an object', 'INVALID_OPERATION', {
      validation: { field: 'params', reason: 'invalid_type' },
    });
  }

  const runtimeOperation = readPreviewField(params, 'operation');
  if (!isVaultPreviewAction(runtimeOperation)) {
    // The operation field is also untrusted JSON input. It may contain a
    // mistyped seed/token, so never copy its value to a serializable error.
    throw new PocketPayError('Invalid vault preview operation', 'INVALID_OPERATION', {
      validation: { field: 'operation', reason: 'unsupported_value' },
    });
  }

  const runtimeWallet = readPreviewField(params, 'wallet');
  if (typeof runtimeWallet !== 'string') {
    // Do not preserve arbitrary object payloads in the error's validation value.
    throw new PocketPayError('Vault previews require a public Stellar address', 'INVALID_PUBLIC_KEY', {
      validation: { field: 'publicKey', reason: 'not_a_string' },
    });
  }
  if (isSecretSeedLike(runtimeWallet)) {
    throw new PocketPayError(
      'Vault previews require a public Stellar address; secret keys are not accepted',
      'INVALID_PUBLIC_KEY',
      {
        validation: {
          field: 'publicKey',
          reason: 'secret_key_not_allowed',
        },
      },
    );
  }
  try {
    validatePublicKey(runtimeWallet);
  } catch {
    // The shared validator deliberately includes its input in error metadata.
    // Preview validation is safe to log, so don't forward arbitrary wallet text.
    throw new PocketPayError('Invalid vault preview public address', 'INVALID_PUBLIC_KEY', {
      validation: { field: 'publicKey', reason: 'invalid_format' },
    });
  }
  // validatePublicKey accepts surrounding whitespace, so return the exact
  // canonical value it validated instead of echoing a decorated caller string.
  const wallet = (runtimeWallet as string).trim();

  let runtimeAmount: unknown;
  if (operationRequiresAmount(runtimeOperation)) {
    runtimeAmount = readPreviewField(params, 'amount');
    if (typeof runtimeAmount !== 'string') {
      throw new PocketPayError('Vault preview amount must be a decimal string', 'INVALID_AMOUNT', {
        validation: {
          field: 'amount',
          reason: runtimeAmount === undefined ? 'missing' : 'invalid_type',
        },
      });
    }
    // Rejection paths must not repeat seed material passed into an amount field.
    if (isSecretSeedLike(runtimeAmount)) {
      throw new PocketPayError('Vault preview amount must be a decimal string', 'INVALID_AMOUNT', {
        validation: { field: 'amount', reason: 'secret_key_not_allowed' },
      });
    }
    try {
      validateAmount(runtimeAmount);
    } catch (error) {
      // The shared amount validator quotes invalid input. Never forward a
      // possibly mistyped credential from a side-effect-free preview.
      const precise = error instanceof PocketPayError && error.code === 'INVALID_AMOUNT_PRECISION';
      const reason = precise ? 'too_precise'
        : error instanceof PocketPayError && error.validation?.reason === 'not_positive'
        ? 'not_positive' : 'invalid_format';
      throw new PocketPayError(
        'Invalid vault preview amount',
        precise ? 'INVALID_AMOUNT_PRECISION' : 'INVALID_AMOUNT',
        { validation: { field: 'amount', reason } },
      );
    }
  }
  const runtimeUnlockAt =
    runtimeOperation === 'createLock' ? readPreviewField(params, 'unlockAt') : undefined;
  validateLockUnlockAt(runtimeOperation, runtimeUnlockAt);

  const resolved = resolveConfigWithoutDiagnostics(config);
  const readiness = VAULT_ACTION_READINESS[runtimeOperation];
  const warnings: string[] = [];

  if (runtimeOperation === 'deposit' || runtimeOperation === 'withdraw') {
    warnings.push(BOOKKEEPING_WARNING);
  }

  if (runtimeOperation === 'createLock') {
    warnings.push(LOCK_PREVIEW_WARNING);
  }

  if (runtimeOperation !== 'getBalance') {
    warnings.push(SOROBAN_FEE_WARNING);
  }

  const preview: VaultOperationPreview = {
    operation: runtimeOperation,
    asset: XLM_ASSET,
    wallet,
    network: resolved.network,
    estimatedFee:
      runtimeOperation === 'getBalance' ? '0' : String(StellarSDK.BASE_FEE),
    supported: readiness.supported,
    warnings,
  };

  if (operationRequiresAmount(runtimeOperation)) {
    preview.amount = runtimeAmount as string;
  }
  if (runtimeOperation === 'createLock') {
    preview.unlockAt = runtimeUnlockAt as number;
  }

  return preview;
}
