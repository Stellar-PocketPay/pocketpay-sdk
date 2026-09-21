import type { Asset } from '../types/asset';
import { NATIVE_ASSET, validateAsset } from '../types/asset';
import { safeParseAmount } from './amount';

export type BalanceDisplayStatus = 'ready' | 'missing' | 'invalid';
export type BalanceDisplayReason = 'missing_balance' | 'invalid_balance' | 'invalid_asset';

export interface BalanceDisplayOptions {
  /** Minimum fraction digits shown. Defaults to 2. */
  minimumFractionDigits?: number;
  /** Maximum fraction digits shown. Defaults to Stellar's 7 decimal places. */
  maximumFractionDigits?: number;
  /** Add deterministic thousands separators without converting through number. Defaults to true. */
  groupThousands?: boolean;
  /** Include a shortened issuer after issued-asset codes. Defaults to false. */
  includeIssuer?: boolean;
  /** Replacement text for a missing balance. Defaults to an em dash. */
  missingLabel?: string;
  /** Replacement text for an invalid balance. Defaults to "Invalid balance". */
  invalidLabel?: string;
}

export interface BalanceDisplayInput {
  /**
   * Stellar balance as a decimal string. Number input is intentionally rejected:
   * callers must not lose protocol precision before normalization.
   */
  balance: unknown;
  /** Defaults to native XLM when omitted. */
  asset?: Asset | null;
}

export interface NormalizedBalanceDisplay {
  status: BalanceDisplayStatus;
  reason?: BalanceDisplayReason;
  /** Canonical seven-decimal Stellar amount when status is ready. */
  amount: string | null;
  /** Exact formatted amount without the asset suffix. */
  formattedAmount: string;
  /** Validated asset, or null when the asset itself is invalid. */
  asset: Asset | null;
  assetLabel: string;
  /** Complete user-facing amount + asset string. */
  display: string;
}

const DEFAULT_MINIMUM_FRACTION_DIGITS = 2;
const DEFAULT_MAXIMUM_FRACTION_DIGITS = 7;

function resolveFractionDigits(options: BalanceDisplayOptions): {
  minimum: number;
  maximum: number;
} {
  const minimum = options.minimumFractionDigits ?? DEFAULT_MINIMUM_FRACTION_DIGITS;
  const maximum = options.maximumFractionDigits ?? DEFAULT_MAXIMUM_FRACTION_DIGITS;

  if (
    !Number.isInteger(minimum) ||
    !Number.isInteger(maximum) ||
    minimum < 0 ||
    maximum < 0 ||
    minimum > 7 ||
    maximum > 7 ||
    minimum > maximum
  ) {
    throw new RangeError(
      'Balance display fraction digits must be integers from 0 through 7 with minimum <= maximum.',
    );
  }

  return { minimum, maximum };
}

function groupIntegerDigits(value: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Rounds a canonical non-negative seven-decimal Stellar amount without ever
 * converting it through JavaScript number.
 */
function formatCanonicalAmount(
  canonical: string,
  minimum: number,
  maximum: number,
  groupThousands: boolean,
): string {
  const [whole, fraction = ''] = canonical.split('.');
  let roundedWhole = whole;
  let roundedFraction = fraction.slice(0, maximum);

  if (maximum < fraction.length && fraction[maximum] >= '5') {
    const combined = maximum === 0 ? whole : whole + roundedFraction.padEnd(maximum, '0');
    const incremented = (BigInt(combined) + 1n).toString();

    if (maximum === 0) {
      roundedWhole = incremented;
      roundedFraction = '';
    } else {
      const padded = incremented.padStart(maximum + 1, '0');
      roundedWhole = padded.slice(0, -maximum);
      roundedFraction = padded.slice(-maximum);
    }
  }

  while (roundedFraction.length > minimum && roundedFraction.endsWith('0')) {
    roundedFraction = roundedFraction.slice(0, -1);
  }

  while (roundedFraction.length < minimum) {
    roundedFraction += '0';
  }

  const integer = groupThousands ? groupIntegerDigits(roundedWhole) : roundedWhole;
  return roundedFraction.length > 0 ? `${integer}.${roundedFraction}` : integer;
}

function issuerLabel(issuer: string): string {
  return issuer.length <= 12 ? issuer : `${issuer.slice(0, 6)}...${issuer.slice(-4)}`;
}

/** Returns a stable UI label for native or issued assets. */
export function formatBalanceAssetLabel(
  asset: Asset,
  options: Pick<BalanceDisplayOptions, 'includeIssuer'> = {},
): string {
  const validation = validateAsset(asset);
  if (!validation.valid) {
    throw new Error(`Invalid balance asset: ${validation.error ?? 'unknown asset'}`);
  }

  if (asset.type === 'native') return 'XLM';
  return options.includeIssuer
    ? `${asset.code} (${issuerLabel(asset.issuer)})`
    : asset.code;
}

/**
 * Normalizes a raw SDK balance into one precision-safe display contract.
 *
 * Missing and invalid balances are represented explicitly instead of producing
 * "NaN" or silently coercing caller input. Valid amounts stay exact strings
 * through parsing, rounding, grouping, and display.
 */
export function normalizeBalanceDisplay(
  input: BalanceDisplayInput,
  options: BalanceDisplayOptions = {},
): NormalizedBalanceDisplay {
  const digits = resolveFractionDigits(options);
  const candidateAsset = input.asset === undefined ? NATIVE_ASSET : input.asset;
  const assetValidation = validateAsset(candidateAsset as Asset);

  if (!assetValidation.valid) {
    const formattedAmount = options.invalidLabel ?? 'Invalid balance';
    return {
      status: 'invalid',
      reason: 'invalid_asset',
      amount: null,
      formattedAmount,
      asset: null,
      assetLabel: 'UNKNOWN',
      display: `${formattedAmount} UNKNOWN`,
    };
  }

  const asset = candidateAsset as Asset;
  const assetLabel = formatBalanceAssetLabel(asset, options);

  if (
    input.balance === null ||
    input.balance === undefined ||
    (typeof input.balance === 'string' && input.balance.trim().length === 0)
  ) {
    const formattedAmount = options.missingLabel ?? '—';
    return {
      status: 'missing',
      reason: 'missing_balance',
      amount: null,
      formattedAmount,
      asset,
      assetLabel,
      display: `${formattedAmount} ${assetLabel}`,
    };
  }

  if (typeof input.balance !== 'string') {
    const formattedAmount = options.invalidLabel ?? 'Invalid balance';
    return {
      status: 'invalid',
      reason: 'invalid_balance',
      amount: null,
      formattedAmount,
      asset,
      assetLabel,
      display: `${formattedAmount} ${assetLabel}`,
    };
  }

  const parsed = safeParseAmount(input.balance.trim());
  if (!parsed.valid) {
    const formattedAmount = options.invalidLabel ?? 'Invalid balance';
    return {
      status: 'invalid',
      reason: 'invalid_balance',
      amount: null,
      formattedAmount,
      asset,
      assetLabel,
      display: `${formattedAmount} ${assetLabel}`,
    };
  }

  const amount = parsed.amount.toDecimal();
  const formattedAmount = formatCanonicalAmount(
    amount,
    digits.minimum,
    digits.maximum,
    options.groupThousands ?? true,
  );

  return {
    status: 'ready',
    amount,
    formattedAmount,
    asset,
    assetLabel,
    display: `${formattedAmount} ${assetLabel}`,
  };
}

/** Convenience wrapper returning only the final user-facing display string. */
export function formatBalanceDisplay(
  balance: unknown,
  asset: Asset = NATIVE_ASSET,
  options: BalanceDisplayOptions = {},
): string {
  return normalizeBalanceDisplay({ balance, asset }, options).display;
}
