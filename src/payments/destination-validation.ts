/**
 * Stellar PocketPay SDK — Destination Account Validation Module
 *
 * Provides a comprehensive validation strategy for destination accounts in payment flows.
 * Defines clear boundaries between local validation (synchronous, no network calls) and
 * network validation (asynchronous, Horizon queries).
 *
 * Validation Strategy:
 * ────────────────────────────────────────────────────────────────────────────────
 * LOCAL VALIDATION (synchronous, no network calls):
 * - Address format validation (G... public key shape)
 * - Address checksum validation (Ed25519 public key verification)
 * - Self-payment detection (when source is available)
 * - Basic asset specification format validation
 *
 * NETWORK VALIDATION (asynchronous, Horizon queries):
 * - Account existence check (is the account funded?)
 * - Account status verification (is the account active?)
 * - Trustline verification for issued assets
 * - Trustline authorization status
 * - Trustline capacity checks (when amount is provided)
 *
 * Usage Pattern:
 * ────────────────────────────────────────────────────────────────────────────────
 * 1. Call validateDestinationLocal() for fast, synchronous validation
 * 2. If local validation passes, optionally call validateDestinationNetwork()
 *    for comprehensive checks before payment submission
 * 3. Use validateDestinationComplete() for a one-shot validation that runs both
 *    phases in sequence
 */

import * as StellarSDK from '@stellar/stellar-sdk';
import { getHorizonServer, resolveConfig } from '../config';
import {
  StellarAssetSpec,
  TrustlineCheckOptions,
  TrustlineCheckResult,
  PocketPayError,
  SDKConfig,
  PocketPayResult,
} from '../types';
import { validatePublicKey, validateAmount, wrapError, toResult } from '../utils';
import { formatStroops, toStroops } from '../utils/amount';
import { withTimeout } from '../network';
import { remainingTrustlineCapacity } from './trustline';

// ─── Type Definitions ───────────────────────────────────────────────────────────

/**
 * Validation level to control how thoroughly the destination is checked.
 */
export type DestinationValidationLevel = 'local' | 'network' | 'complete';

/**
 * Status discriminant for destination validation results.
 */
export type DestinationValidationStatus =
  // Local validation statuses
  | 'valid_local'
  | 'invalid_address_format'
  | 'invalid_address_checksum'
  | 'self_payment'
  // Network validation statuses
  | 'valid_network'
  | 'account_not_found'
  | 'account_unfunded'
  | 'account_inactive'
  | 'missing_trustline'
  | 'trustline_not_authorized'
  | 'trustline_limit_exceeded';

/**
 * Options for destination validation.
 */
export interface DestinationValidationOptions {
  /** Validation level to perform (default: 'complete') */
  level?: DestinationValidationLevel;
  /** Asset specification for trustline validation (required for issued assets) */
  asset?: StellarAssetSpec;
  /** Payment amount for capacity checks (optional) */
  amount?: string;
  /** Source public key for self-payment detection (optional) */
  sourcePublicKey?: string;
  /** SDK config overrides */
  config?: Partial<SDKConfig>;
}

/**
 * Result of destination validation.
 */
export interface DestinationValidationResult {
  /** Whether the destination passed all requested validation checks */
  valid: boolean;
  /** Validation status indicating the outcome */
  status: DestinationValidationStatus;
  /** Destination public key that was validated */
  destination: string;
  /** Asset specification (if provided) */
  asset?: StellarAssetSpec;
  /** Human-readable explanation of the validation result */
  message: string;
  /** Machine-readable error code (if validation failed) */
  errorCode?: string;
  /** Whether this was a local-only validation */
  localOnly: boolean;
  /** Additional metadata about the validation */
  metadata?: {
    /** Account sequence number (if network validation was performed) */
    sequence?: string;
    /** Current balance for the asset (if trustline check was performed) */
    currentBalance?: string;
    /** Trustline limit (if trustline check was performed) */
    limit?: string;
    /** Available trustline capacity (if trustline check was performed) */
    availableCapacity?: string;
    /** Whether the trustline is authorized (if trustline check was performed) */
    isAuthorized?: boolean;
  };
}

// ─── Local Validation (Synchronous, No Network Calls) ───────────────────────────

/**
 * Performs local-only validation on a destination account.
 *
 * This function is synchronous and makes no network calls. It validates:
 * - Address format (G... prefix)
 * - Address checksum (Ed25519 public key verification)
 * - Self-payment detection (when sourcePublicKey is provided)
 *
 * @param destination - Stellar public key (G...) to validate
 * @param options - Validation options
 * @returns Destination validation result
 */
export function validateDestinationLocal(
  destination: string,
  options?: DestinationValidationOptions,
): DestinationValidationResult {
  try {
    // 1. Address format validation
    validatePublicKey(destination);

    // 2. Self-payment detection (if source is provided)
    if (options?.sourcePublicKey && options.sourcePublicKey === destination) {
      return {
        valid: false,
        status: 'self_payment',
        destination,
        message: 'Cannot send payment to the same account (self-payment)',
        errorCode: 'SELF_PAYMENT',
        localOnly: true,
      };
    }

    // 3. Asset format validation (if asset is provided)
    if (options?.asset) {
      try {
        validateAssetSpecLocal(options.asset);
      } catch (error) {
        if (error instanceof PocketPayError) {
          return {
            valid: false,
            status: 'invalid_address_format', // Reusing this for asset format errors
            destination,
            asset: options.asset,
            message: error.message,
            errorCode: error.code,
            localOnly: true,
          };
        }
        throw error;
      }
    }

    return {
      valid: true,
      status: 'valid_local',
      destination,
      message: 'Destination address passed local validation',
      localOnly: true,
    };
  } catch (error) {
    if (error instanceof PocketPayError) {
      const status = error.code === 'INVALID_PUBLIC_KEY'
        ? 'invalid_address_format'
        : 'invalid_address_checksum';
      return {
        valid: false,
        status,
        destination,
        message: error.message,
        errorCode: error.code,
        localOnly: true,
      };
    }
    throw wrapError(error, 'Local destination validation failed', 'DESTINATION_VALIDATION_ERROR');
  }
}

/**
 * Validates asset specification locally (synchronous).
 *
 * @param asset - Asset specification to validate
 * @returns true if valid
 * @throws PocketPayError if asset specification is invalid
 */
function validateAssetSpecLocal(asset: StellarAssetSpec): boolean {
  if (!asset || typeof asset !== 'object') {
    throw new PocketPayError('Invalid asset specification object', 'INVALID_ASSET', {
      validation: { field: 'asset', reason: 'invalid_object' },
    });
  }

  const code = (asset.code || '').trim();
  if (!code) {
    throw new PocketPayError('Asset code is required', 'INVALID_ASSET_CODE', {
      validation: { field: 'asset.code', reason: 'empty' },
    });
  }

  const isNative = code.toUpperCase() === 'XLM' || code.toLowerCase() === 'native';

  if (isNative) {
    if (asset.issuer && asset.issuer.trim().length > 0) {
      throw new PocketPayError('Native XLM asset must not specify an issuer', 'INVALID_ASSET', {
        validation: { field: 'asset.issuer', reason: 'native_asset_has_issuer', value: asset.issuer },
      });
    }
    return true;
  }

  // Issued asset code validation: 1-12 alphanumeric characters
  if (!/^[a-zA-Z0-9]{1,12}$/.test(code)) {
    throw new PocketPayError(
      `Invalid asset code: "${code}". Must be 1-12 alphanumeric characters.`,
      'INVALID_ASSET_CODE',
      {
        validation: { field: 'asset.code', reason: 'invalid_format', value: code },
      },
    );
  }

  if (!asset.issuer || asset.issuer.trim().length === 0) {
    throw new PocketPayError(
      `Issued asset "${code}" requires an issuer public key (G...).`,
      'MISSING_ASSET_ISSUER',
      {
        validation: { field: 'asset.issuer', reason: 'missing' },
      },
    );
  }

  validatePublicKey(asset.issuer);
  return true;
}

// ─── Network Validation (Asynchronous, Horizon Queries) ─────────────────────────

/**
 * Performs network validation on a destination account.
 *
 * This function makes Horizon queries to validate:
 * - Account existence (is the account funded?)
 * - Account status (is the account active?)
 * - Trustline requirements for issued assets
 * - Trustline authorization status
 * - Trustline capacity (when amount is provided)
 *
 * @param destination - Stellar public key (G...) to validate
 * @param options - Validation options (asset is required for trustline checks)
 * @returns Destination validation result
 */
export async function validateDestinationNetwork(
  destination: string,
  options?: DestinationValidationOptions,
): Promise<DestinationValidationResult> {
  // First run local validation as a prerequisite
  const localResult = validateDestinationLocal(destination, options);
  if (!localResult.valid) {
    return localResult;
  }

  // Same amount preflight as checkDestinationTrustline: a malformed, zero,
  // over-precise or above-maximum amount is rejected before any network call
  // rather than being compared as NaN against the trustline capacity.
  if (options?.amount !== undefined) {
    validateAmount(options.amount);
  }

  const config = options?.config;
  const cfg = resolveConfig(config);
  const server = getHorizonServer(config);
  const asset = options?.asset;

  try {
    // 1. Account existence check
    const account = await withTimeout(
      'Horizon destination account lookup for validation',
      cfg.timeout,
      server.loadAccount(destination),
    ) as any;

    // 2. Account status check
    // An account is considered inactive if it has no sequence number or is locked
    if (!account.sequence || account.sequence === '0') {
      return {
        valid: false,
        status: 'account_inactive',
        destination,
        asset,
        message: `Destination account ${destination} exists but is inactive`,
        errorCode: 'ACCOUNT_INACTIVE',
        localOnly: false,
        metadata: {
          sequence: account.sequence,
        },
      };
    }

    // 3. Trustline validation for issued assets
    if (asset) {
      const isNative = asset.code.toUpperCase() === 'XLM' || asset.code.toLowerCase() === 'native';
      
      if (!isNative) {
        // Search account balances for matching asset
        const matchingBalance = account.balances.find((b: any) => {
          if (b.asset_type === 'native') return false;
          return b.asset_code === asset.code && b.asset_issuer === asset.issuer;
        });

        if (!matchingBalance) {
          return {
            valid: false,
            status: 'missing_trustline',
            destination,
            asset,
            message: `Destination account ${destination} has no trustline for asset ${asset.code}:${asset.issuer}`,
            errorCode: 'MISSING_TRUSTLINE',
            localOnly: false,
            metadata: {
              sequence: account.sequence,
            },
          };
        }

        const balObj = matchingBalance as any;
        const currentBalance = balObj.balance ?? '0';
        const limit = balObj.limit ?? '0';
        const isAuthorized = balObj.is_authorized !== false && balObj.is_authorized_to_maintain_liabilities !== false;

        if (!isAuthorized) {
          return {
            valid: false,
            status: 'trustline_not_authorized',
            destination,
            asset,
            message: `Trustline for ${asset.code}:${asset.issuer} exists on destination account but is not authorized by the issuer`,
            errorCode: 'TRUSTLINE_NOT_AUTHORIZED',
            localOnly: false,
            metadata: {
              sequence: account.sequence,
              currentBalance,
              limit,
              isAuthorized: false,
            },
          };
        }

        // Remaining capacity in exact stroops through the shared amount model
        // (options.amount was checked with validateAmount before the lookup).
        const capacityStroops = remainingTrustlineCapacity(limit, currentBalance);
        const availableCapacity = formatStroops(capacityStroops);

        // Capacity check when amount is provided
        if (options?.amount !== undefined) {
          if (toStroops(options.amount) > capacityStroops) {
            return {
              valid: false,
              status: 'trustline_limit_exceeded',
              destination,
              asset,
              message: `Payment amount (${options.amount}) exceeds destination available trustline capacity (${availableCapacity})`,
              errorCode: 'TRUSTLINE_LIMIT_EXCEEDED',
              localOnly: false,
              metadata: {
                sequence: account.sequence,
                currentBalance,
                limit,
                availableCapacity,
                isAuthorized: true,
              },
            };
          }
        }

        // Trustline is valid
        return {
          valid: true,
          status: 'valid_network',
          destination,
          asset,
          message: `Destination account has a valid authorized trustline for ${asset.code}:${asset.issuer}`,
          localOnly: false,
          metadata: {
            sequence: account.sequence,
            currentBalance,
            limit,
            availableCapacity,
            isAuthorized: true,
          },
        };
      }
    }

    // Native XLM or no asset specified - account exists and is active
    return {
      valid: true,
      status: 'valid_network',
      destination,
      asset,
      message: `Destination account ${destination} exists and is active`,
      localOnly: false,
      metadata: {
        sequence: account.sequence,
      },
    };
  } catch (error) {
    if (error instanceof Error && (error as any).response?.status === 404) {
      return {
        valid: false,
        status: 'account_not_found',
        destination,
        asset,
        message: `Destination account ${destination} does not exist on-chain (unfunded)`,
        errorCode: 'UNFUNDED_DESTINATION',
        localOnly: false,
      };
    }
    throw wrapError(error, 'Network destination validation failed', 'DESTINATION_VALIDATION_ERROR');
  }
}

// ─── Complete Validation (Local + Network) ───────────────────────────────────────

/**
 * Performs complete destination validation (local + network).
 *
 * This is a convenience function that runs both local and network validation
 * in sequence. Use this when you want comprehensive validation in a single call.
 *
 * @param destination - Stellar public key (G...) to validate
 * @param options - Validation options
 * @returns Destination validation result
 */
export async function validateDestinationComplete(
  destination: string,
  options?: DestinationValidationOptions,
): Promise<DestinationValidationResult> {
  const level = options?.level || 'complete';

  if (level === 'local') {
    return validateDestinationLocal(destination, options);
  }

  if (level === 'network') {
    return validateDestinationNetwork(destination, options);
  }

  // level === 'complete' or default
  return validateDestinationNetwork(destination, options);
}

// ─── Safe Wrappers ─────────────────────────────────────────────────────────────

/**
 * Non-throwing wrapper for {@link validateDestinationComplete}.
 *
 * @param destination - Stellar public key (G...) to validate
 * @param options - Validation options
 * @returns PocketPayResult with validation result
 */
export async function safeValidateDestination(
  destination: string,
  options?: DestinationValidationOptions,
): Promise<PocketPayResult<DestinationValidationResult>> {
  return toResult(
    () => validateDestinationOrThrow(destination, options),
    'Failed to validate destination',
    'DESTINATION_VALIDATION_ERROR',
  );
}

/**
 * Non-throwing wrapper for {@link validateDestinationLocal}.
 *
 * @param destination - Stellar public key (G...) to validate
 * @param options - Validation options
 * @returns PocketPayResult with validation result
 */
export function safeValidateDestinationLocal(
  destination: string,
  options?: DestinationValidationOptions,
): PocketPayResult<DestinationValidationResult> {
  try {
    const result = validateDestinationLocal(destination, options);
    if (!result.valid) {
      return {
        ok: false,
        error: new PocketPayError(
          result.message || 'Local destination validation failed',
          result.errorCode || 'DESTINATION_VALIDATION_FAILED',
        ),
      };
    }
    return { ok: true, value: result };
  } catch (error) {
    const pocketErr = error instanceof PocketPayError
      ? error
      : wrapError(error, 'Failed to validate destination locally', 'DESTINATION_VALIDATION_ERROR');
    return { ok: false, error: pocketErr };
  }
}

/**
 * Non-throwing wrapper for {@link validateDestinationNetwork}.
 *
 * @param destination - Stellar public key (G...) to validate
 * @param options - Validation options
 * @returns PocketPayResult with validation result
 */
export async function safeValidateDestinationNetwork(
  destination: string,
  options?: DestinationValidationOptions,
): Promise<PocketPayResult<DestinationValidationResult>> {
  return toResult(
    () => validateDestinationNetwork(destination, options),
    'Failed to validate destination on network',
    'DESTINATION_VALIDATION_ERROR',
  );
}

// ─── Throwing Validation Helper ───────────────────────────────────────────────────

/**
 * Validates destination and throws a structured PocketPayError if validation fails.
 *
 * @param destination - Destination account public key
 * @param options - Validation options
 * @throws PocketPayError if destination validation fails
 * @returns Validation result if successful
 */
export async function validateDestinationOrThrow(
  destination: string,
  options?: DestinationValidationOptions,
): Promise<DestinationValidationResult> {
  const result = await validateDestinationComplete(destination, options);
  if (!result.valid) {
    throw new PocketPayError(
      result.message || 'Destination validation failed',
      result.errorCode || 'DESTINATION_VALIDATION_FAILED',
      {
        validation: {
          field: 'destination',
          reason: result.status,
          value: destination,
        },
      },
    );
  }
  return result;
}
