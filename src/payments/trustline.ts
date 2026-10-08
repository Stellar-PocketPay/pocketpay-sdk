/**
 * Stellar PocketPay SDK — Trustline Validation Module
 *
 * Provides pre-flight local and network verification of destination trustlines for
 * issued asset payment flows.
 */

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
import { withTimeout } from '../network';

// Horizon exposes Stellar amounts as decimal strings with seven fractional digits.
// Comparing them through Number/parseFloat loses stroop precision for large
// issued-asset trustline limits, so all capacity checks use exact integers.
const TRUSTLINE_SCALE = 10_000_000n;

function parseHorizonUnits(value: unknown): bigint {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,7})?$/.test(value)) {
    throw new PocketPayError(
      'Cannot verify destination trustline capacity from the Horizon response',
      'TRUSTLINE_CHECK_ERROR',
    );
  }
  const [whole, fractional = ''] = value.split('.');
  return BigInt(whole!) * TRUSTLINE_SCALE + BigInt(fractional.padEnd(7, '0'));
}

function formatHorizonUnits(units: bigint): string {
  return `${units / TRUSTLINE_SCALE}.${(units % TRUSTLINE_SCALE).toString().padStart(7, '0')}`;
}

/**
 * Validates the format and parameters of a Stellar asset specification locally.
 *
 * Native XLM (`code: "XLM"` or `code: "native"`) must not specify an issuer.
 * Issued assets require a valid 1-12 character alphanumeric asset code and a
 * valid Stellar public key issuer (G...).
 *
 * @param asset - The asset specification to validate
 * @returns `true` if valid
 * @throws {PocketPayError} with code `INVALID_ASSET`, `INVALID_ASSET_CODE`, or `MISSING_ASSET_ISSUER`
 */
export function validateAssetSpec(asset: StellarAssetSpec): boolean {
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

/**
 * Checks whether a destination account is capable of receiving a payment for a specific asset.
 *
 * Performs local format validation followed by a Horizon network query to inspect the
 * destination's account balances for:
 * 1. Account existence (is funded)
 * 2. Active trustline for `asset.code` + `asset.issuer`
 * 3. Trustline authorization state (if issuer requires authorization)
 * 4. Available trustline capacity (`limit - currentBalance >= amount`)
 *
 * @param destination - Stellar public key (G...) of the payment recipient
 * @param asset - Asset specification (native XLM or issued asset)
 * @param options - Optional check options including payment amount and SDK config
 * @returns Detailed {@link TrustlineCheckResult}
 */
export async function checkDestinationTrustline(
  destination: string,
  asset: StellarAssetSpec,
  options?: TrustlineCheckOptions,
): Promise<TrustlineCheckResult> {
  validatePublicKey(destination);
  validateAssetSpec(asset);

  if (options?.amount) {
    validateAmount(options.amount);
  }

  const isNative = asset.code.toUpperCase() === 'XLM' || asset.code.toLowerCase() === 'native';

  if (isNative) {
    return {
      valid: true,
      status: 'native_xlm',
      destination,
      asset: { code: 'XLM' },
      message: 'Native XLM does not require a trustline check',
    };
  }

  const config = options?.config;
  const cfg = resolveConfig(config);
  const server = getHorizonServer(config);

  try {
    const account = await withTimeout(
      'Horizon destination account lookup for trustline check',
      cfg.timeout,
      server.loadAccount(destination),
    );

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
        errorCode: 'MISSING_TRUSTLINE',
        message: `Destination account ${destination} has no trustline for asset ${asset.code}:${asset.issuer}`,
      };
    }

    const balObj = matchingBalance as any;
    // An absent Horizon balance/limit is unknown, not a zero balance or
    // an authorized empty trustline. Exact-unit parsing below fails closed.
    const currentBalance = balObj.balance;
    const limit = balObj.limit;
    const isAuthorized = balObj.is_authorized !== false && balObj.is_authorized_to_maintain_liabilities !== false;

    if (!isAuthorized) {
      return {
        valid: false,
        status: 'not_authorized',
        destination,
        asset,
        currentBalance,
        limit,
        isAuthorized: false,
        errorCode: 'TRUSTLINE_NOT_AUTHORIZED',
        message: `Trustline for ${asset.code}:${asset.issuer} exists on destination account but is not authorized by the issuer`,
      };
    }

    const currentUnits = parseHorizonUnits(currentBalance);
    const limitUnits = parseHorizonUnits(limit);
    const availableUnits = limitUnits > currentUnits ? limitUnits - currentUnits : 0n;
    const availableCapacity = formatHorizonUnits(availableUnits);

    if (options?.amount) {
      // validateAmount above rejects non-decimal, zero and >7-digit fractions.
      // Use the same exact scale as Horizon for the final authorization gate.
      const sendUnits = parseHorizonUnits(options.amount);
      if (sendUnits > availableUnits) {
        return {
          valid: false,
          status: 'limit_exceeded',
          destination,
          asset,
          currentBalance,
          limit,
          availableCapacity,
          isAuthorized: true,
          errorCode: 'TRUSTLINE_LIMIT_EXCEEDED',
          message: `Payment amount (${options.amount}) exceeds destination available trustline capacity (${availableCapacity})`,
        };
      }
    }

    return {
      valid: true,
      status: 'valid',
      destination,
      asset,
      currentBalance,
      limit,
      availableCapacity,
      isAuthorized: true,
      message: `Destination account has a valid authorized trustline for ${asset.code}:${asset.issuer}`,
    };
  } catch (error) {
    if (error instanceof Error && (error as any).response?.status === 404) {
      return {
        valid: false,
        status: 'account_not_found',
        destination,
        asset,
        errorCode: 'UNFUNDED_DESTINATION',
        message: `Destination account ${destination} does not exist on-chain (unfunded)`,
      };
    }
    throw wrapError(error, 'Failed to check destination trustline', 'TRUSTLINE_CHECK_ERROR');
  }
}

/**
 * Non-throwing wrapper for {@link checkDestinationTrustline}.
 *
 * @param destination - Stellar public key (G...)
 * @param asset - Asset specification
 * @param options - Optional check options
 * @returns `PocketPayResult<TrustlineCheckResult>`
 */
export async function safeCheckDestinationTrustline(
  destination: string,
  asset: StellarAssetSpec,
  options?: TrustlineCheckOptions,
): Promise<PocketPayResult<TrustlineCheckResult>> {
  return toResult(
    () => checkDestinationTrustline(destination, asset, options),
    'Failed to check destination trustline',
    'TRUSTLINE_CHECK_ERROR',
  );
}

/**
 * Verifies trustline requirements and throws a structured `PocketPayError` if the check fails.
 *
 * @param destination - Destination account public key
 * @param asset - Asset specification
 * @param options - Optional check options (including amount)
 * @throws {PocketPayError} if destination trustline check fails
 */
export async function verifyPaymentTrustlineOrThrow(
  destination: string,
  asset: StellarAssetSpec,
  options?: TrustlineCheckOptions,
): Promise<TrustlineCheckResult> {
  const result = await checkDestinationTrustline(destination, asset, options);
  if (!result.valid) {
    throw new PocketPayError(
      result.message || 'Trustline validation failed',
      result.errorCode || 'TRUSTLINE_VALIDATION_FAILED',
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
