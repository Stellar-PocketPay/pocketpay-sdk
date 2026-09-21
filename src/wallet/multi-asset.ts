/**
 * Stellar PocketPay SDK — Multi-Asset Balance Model Implementation
 *
 * Provides functions to query, parse, format, and evaluate multi-asset balances
 * representing native XLM and issued credit assets distinctively with support for
 * available, reserved, unauthorized, unavailable, and unknown states.
 */

import {
  MultiAssetBalance,
  MultiAssetBalanceResult,
  AssetBalanceItem,
  NativeAssetBalanceItem,
  IssuedAssetBalanceItem,
  UnknownAssetBalanceItem,
  AccountBalanceState,
  AssetBalanceState,
  SDKConfig,
  PocketPayResult,
} from '../types';
import { PocketPayError } from '../types';
import {
  validatePublicKey,
  wrapError,
  toSuccessResult,
  toFailureResult,
  formatBalanceDisplay,
} from '../utils';
import { getHorizonServer, resolveConfig } from '../config';
import { withTimeout } from '../network';

/**
 * Calculates Stellar protocol XLM reserves based on subentry count.
 *
 * Stellar Protocol Base Reserve Formula:
 * - Base reserve per entry = 0.5 XLM
 * - Minimum account balance = (2 + subentryCount) * 0.5 XLM = 1.0 XLM + subentryCount * 0.5 XLM
 *
 * @param subentryCount - Number of subentries (trustlines, offers, signers, data entries)
 * @returns Object with baseReserve and minimum required XLM balance string
 */
export function calculateNativeReserves(subentryCount: number = 0): {
  baseReserve: string;
  minBalance: string;
} {
  const count = Math.max(0, subentryCount);
  const minReserveNum = (2 + count) * 0.5;
  return {
    baseReserve: '0.5000000',
    minBalance: minReserveNum.toFixed(7),
  };
}

/**
 * Pure helper function to parse raw Horizon account data into the typed MultiAssetBalance model.
 * Handles funded, unfunded, unavailable, and unknown account and asset states cleanly.
 *
 * @param publicKey - Stellar public key (G...)
 * @param horizonAccountData - Raw Horizon account response object (or null if unfunded/unavailable)
 * @param accountState - Account status override ('funded' | 'unfunded' | 'unavailable' | 'unknown')
 * @returns Typed {@link MultiAssetBalance} object
 */
export function parseMultiAssetBalance(
  publicKey: string,
  horizonAccountData?: any,
  accountState: AccountBalanceState = 'funded',
): MultiAssetBalance {
  const updatedAt = new Date().toISOString();

  if (accountState === 'unfunded' || !horizonAccountData) {
    return {
      publicKey,
      accountState: accountState === 'funded' ? 'unfunded' : accountState,
      issuedAssets: [],
      unknownAssets: [],
      totalAssetCount: 0,
      updatedAt,
    };
  }

  if (accountState === 'unavailable') {
    return {
      publicKey,
      accountState: 'unavailable',
      issuedAssets: [],
      unknownAssets: [],
      totalAssetCount: 0,
      updatedAt,
    };
  }

  const subentryCount = typeof horizonAccountData.subentry_count === 'number'
    ? horizonAccountData.subentry_count
    : 0;
  const reserves = calculateNativeReserves(subentryCount);
  const rawBalances: any[] = Array.isArray(horizonAccountData.balances)
    ? horizonAccountData.balances
    : [];

  let nativeItem: NativeAssetBalanceItem | undefined;
  const issuedAssets: IssuedAssetBalanceItem[] = [];
  const unknownAssets: UnknownAssetBalanceItem[] = [];

  for (const bal of rawBalances) {
    const assetType = bal.asset_type;

    if (assetType === 'native') {
      const totalBalance = typeof bal.balance === 'string' ? bal.balance : '0.0000000';
      const sellingLiabilities = typeof bal.selling_liabilities === 'string' ? bal.selling_liabilities : '0.0000000';
      const buyingLiabilities = typeof bal.buying_liabilities === 'string' ? bal.buying_liabilities : '0.0000000';

      const totalNum = parseFloat(totalBalance);
      const minReserveNum = parseFloat(reserves.minBalance);
      const sellingNum = parseFloat(sellingLiabilities);
      const reservedNum = minReserveNum + sellingNum;
      const availableNum = Math.max(0, totalNum - reservedNum);

      const availableBalance = availableNum.toFixed(7);
      const reservedBalance = reservedNum.toFixed(7);

      let state: AssetBalanceState = 'available';
      if (availableNum <= 0 && totalNum > 0) {
        state = 'reserved';
      } else if (totalNum === 0) {
        state = 'unavailable';
      }

      const formattedDisplay = formatBalanceDisplay(
        availableBalance,
        { type: 'native', code: 'XLM' },
        { minimumFractionDigits: 2, maximumFractionDigits: 2, groupThousands: false },
      );

      nativeItem = {
        type: 'native',
        assetCode: 'XLM',
        totalBalance,
        availableBalance,
        reservedBalance,
        sellingLiabilities,
        buyingLiabilities,
        subentryCount,
        state,
        formattedDisplay,
      };
    } else if (assetType === 'credit_alphanum4' || assetType === 'credit_alphanum12') {
      const assetCode = typeof bal.asset_code === 'string' ? bal.asset_code : 'UNKNOWN';
      const issuer = typeof bal.asset_issuer === 'string' ? bal.asset_issuer : '';
      const totalBalance = typeof bal.balance === 'string' ? bal.balance : '0.0000000';
      const sellingLiabilities = typeof bal.selling_liabilities === 'string' ? bal.selling_liabilities : '0.0000000';
      const buyingLiabilities = typeof bal.buying_liabilities === 'string' ? bal.buying_liabilities : '0.0000000';
      const limit = typeof bal.limit === 'string' ? bal.limit : '0.0000000';

      const isAuthorized = bal.is_authorized !== false && bal.is_authorized_to_maintain_liabilities !== false;

      const totalNum = parseFloat(totalBalance);
      const sellingNum = parseFloat(sellingLiabilities);
      const availableNum = Math.max(0, totalNum - sellingNum);

      const availableBalance = availableNum.toFixed(7);
      const reservedBalance = sellingNum.toFixed(7);

      let state: AssetBalanceState = 'available';
      if (!isAuthorized) {
        state = 'unauthorized';
      } else if (availableNum <= 0 && totalNum > 0) {
        state = 'reserved';
      } else if (totalNum === 0) {
        state = 'available';
      }

      const statusTag = !isAuthorized ? ' (Unauthorized)' : '';
      const formattedDisplay = `${formatBalanceDisplay(
        availableBalance,
        { type: 'issued', code: assetCode, issuer },
        { minimumFractionDigits: 2, maximumFractionDigits: 2, groupThousands: false },
      )}${statusTag}`;

      issuedAssets.push({
        type: 'issued',
        assetCode,
        issuer,
        totalBalance,
        availableBalance,
        reservedBalance,
        sellingLiabilities,
        buyingLiabilities,
        limit,
        isAuthorized,
        state,
        formattedDisplay,
      });
    } else {
      const assetCode = typeof bal.asset_code === 'string' ? bal.asset_code : 'UNKNOWN';
      const issuer = typeof bal.asset_issuer === 'string' ? bal.asset_issuer : undefined;
      const totalBalance = typeof bal.balance === 'string' ? bal.balance : '0.0000000';
      const availableBalance = '0.0000000';
      const reservedBalance = totalBalance;
      const state: AssetBalanceState = 'unknown';
      const formattedDisplay = `${totalBalance} ${assetCode} (Unknown)`;

      unknownAssets.push({
        type: 'unknown',
        assetCode,
        issuer,
        totalBalance,
        availableBalance,
        reservedBalance,
        state,
        formattedDisplay,
      });
    }
  }

  const totalAssetCount = (nativeItem ? 1 : 0) + issuedAssets.length + unknownAssets.length;

  return {
    publicKey,
    accountState: 'funded',
    native: nativeItem,
    issuedAssets,
    unknownAssets,
    totalAssetCount,
    updatedAt,
  };
}

/**
 * Fetches the comprehensive multi-asset balance model for a Stellar public key.
 *
 * Represents native XLM (with reserve breakdowns), issued credit assets (with trustlines
 * and authorization status), and handles unfunded, unavailable, or unknown states cleanly.
 *
 * @param publicKey - Stellar public key (G...) to query
 * @param config - Optional SDK config overrides
 * @returns Promise resolving to {@link MultiAssetBalance}
 * @throws {PocketPayError} with code `INVALID_PUBLIC_KEY` or `BALANCE_ERROR`
 */
export async function getMultiAssetBalance(
  publicKey: string,
  config?: Partial<SDKConfig>,
): Promise<MultiAssetBalance> {
  validatePublicKey(publicKey);
  const server = getHorizonServer(config);
  const cfg = resolveConfig(config);

  try {
    const accountData = await withTimeout(
      'Horizon account lookup for multi-asset balance',
      cfg.timeout,
      server.loadAccount(publicKey),
    );
    return parseMultiAssetBalance(publicKey, accountData, 'funded');
  } catch (error) {
    if (error instanceof Error && (error as any).response?.status === 404) {
      return parseMultiAssetBalance(publicKey, null, 'unfunded');
    }
    throw wrapError(error, 'Failed to fetch multi-asset balance', 'BALANCE_ERROR');
  }
}

/**
 * Non-throwing safe wrapper for {@link getMultiAssetBalance}.
 *
 * @param publicKey - Stellar public key (G...) to query
 * @param config - Optional SDK config overrides
 * @returns Promise resolving to {@link PocketPayResult} containing {@link MultiAssetBalance}
 */
export async function safeGetMultiAssetBalance(
  publicKey: string,
  config?: Partial<SDKConfig>,
): Promise<PocketPayResult<MultiAssetBalance>> {
  try {
    const balance = await getMultiAssetBalance(publicKey, config);
    return toSuccessResult(balance);
  } catch (error) {
    const err = error instanceof PocketPayError
      ? error
      : wrapError(error, 'Failed to fetch multi-asset balance', 'BALANCE_ERROR');
    return toFailureResult(err);
  }
}

/**
 * Utility helper to format any asset balance item for mobile/web UI consumers.
 *
 * @param item - The {@link AssetBalanceItem} to format
 * @param decimals - Number of decimal places for display (default: 2)
 * @returns Human-readable formatted string (e.g. "97.50 XLM", "50.00 USDC (Unauthorized)")
 */
export function formatAssetBalanceDisplay(
  item: AssetBalanceItem,
  decimals: number = 2,
): string {
  if (item.type === 'native') {
    return formatBalanceDisplay(
      item.availableBalance,
      { type: 'native', code: 'XLM' },
      {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
        groupThousands: false,
      },
    );
  }

  if (item.type === 'issued') {
    const auth = !item.isAuthorized ? ' (Unauthorized)' : '';
    const display = formatBalanceDisplay(
      item.availableBalance,
      { type: 'issued', code: item.assetCode, issuer: item.issuer },
      {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
        groupThousands: false,
      },
    );
    return `${display}${auth}`;
  }

  return `${item.totalBalance} ${item.assetCode} (Unknown)`;
}

/**
 * Searches a {@link MultiAssetBalance} object for a specific asset entry.
 *
 * @param multiBalance - The {@link MultiAssetBalance} object to search
 * @param assetCode - The asset code to find (e.g. "XLM", "USDC")
 * @param issuer - Optional asset issuer public key for issued credit assets
 * @returns The matching {@link AssetBalanceItem} or `undefined`
 */
export function findAssetInMultiBalance(
  multiBalance: MultiAssetBalance,
  assetCode: string,
  issuer?: string,
): AssetBalanceItem | undefined {
  if (assetCode.toUpperCase() === 'XLM' || assetCode === 'native') {
    return multiBalance.native;
  }

  const issued = multiBalance.issuedAssets.find((item) => {
    if (issuer) {
      return item.assetCode === assetCode && item.issuer === issuer;
    }
    return item.assetCode === assetCode;
  });

  if (issued) return issued;

  return multiBalance.unknownAssets.find((item) => {
    if (issuer && item.issuer) {
      return item.assetCode === assetCode && item.issuer === issuer;
    }
    return item.assetCode === assetCode;
  });
}
