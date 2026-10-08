/**
 * Stellar PocketPay SDK — Transaction readiness check (issue #441).
 *
 * Answers "is this payment ready to sign?" with a typed result, before any
 * transaction is built, signed or submitted.
 *
 * @remarks
 * The SDK already had pieces of this answer, each with its own shape:
 * `validateTransactionBuild` for input format, `checkDestinationTrustline` and
 * `validateDestinationNetwork` for the receiving side, `calculateNativeReserves`
 * for the reserve, `validatePocketPayConfig` for the network. None of them looks
 * at the **source** account's spendable balance, and none returns one result a
 * confirmation screen can render. This module composes those primitives into a
 * single {@link TransactionReadiness} value:
 *
 * - `ready` is `true` only when every check ran and none produced a blocker.
 * - `blockers` and `warnings` carry stable, typed codes; branch on `code`, never
 *   parse `message`.
 * - `checks` says which checks passed, failed, or could not run.
 *
 * Nothing here signs, builds or submits. The existing `sendXLM` / `sendAsset`
 * signing and submission paths are unchanged and do not call this module.
 *
 * @security Readiness takes the source **public** key, never a secret. Messages
 * for malformed account IDs are fixed strings and never echo the input, so a
 * secret pasted into the wrong field is not repeated back into logs or UI.
 *
 * See `docs/transaction-readiness.md` for what a `ready: true` result does and
 * does not guarantee.
 */

import * as StellarSDK from '@stellar/stellar-sdk';
import { getHorizonServer, getNetworkPassphrase, validatePocketPayConfig } from '../config';
import type {
  MemoInput,
  ResolvedSDKConfig,
  SDKConfig,
  StellarAssetSpec,
  StellarNetwork,
} from '../types';
import { validateAmount, validatePublicKey } from '../utils';
import { formatStroops, safeParseAmount } from '../utils/amount';
import { normalizeMemo, safeValidateMemo } from '../utils/memo';
import { withTimeout } from '../network';
import { calculateNativeReserves } from '../wallet/multi-asset';
import { isKnownErrorCode } from '../errors/codes';
import { validateAssetSpec } from './trustline';

// ─── Public types ───────────────────────────────────────────────────────────

/** The checks a readiness run performs, named after what they inspect. */
export type TransactionReadinessCheck =
  | 'source'
  | 'destination'
  | 'amount'
  | 'asset'
  | 'memo'
  | 'network'
  | 'fee'
  | 'balance';

/**
 * The order checks are reported in. Local checks come first; checks that need
 * configuration or Horizon come last.
 */
export const READINESS_CHECK_ORDER: readonly TransactionReadinessCheck[] = [
  'source',
  'destination',
  'amount',
  'asset',
  'memo',
  'network',
  'fee',
  'balance',
];

/**
 * Outcome of one check.
 *
 * - `passed` — the check ran completely and found nothing blocking.
 * - `failed` — the check produced at least one blocker.
 * - `skipped` — the check could not run completely because something it
 *   depends on failed (for example, the balance check when the source account
 *   could not be loaded). A skipped check never coexists with `ready: true`.
 */
export type TransactionReadinessCheckStatus = 'passed' | 'failed' | 'skipped';

/** Stable codes for conditions that stop a payment from being ready. */
export type TransactionReadinessBlockerCode =
  // source
  | 'SOURCE_INVALID'
  | 'SOURCE_NOT_FOUND'
  | 'SOURCE_LOOKUP_FAILED'
  // destination
  | 'DESTINATION_INVALID'
  | 'DESTINATION_MUXED_UNSUPPORTED'
  | 'DESTINATION_SELF_PAYMENT'
  | 'DESTINATION_NOT_FOUND'
  | 'DESTINATION_LOOKUP_FAILED'
  // amount
  | 'AMOUNT_INVALID'
  | 'AMOUNT_PRECISION'
  // asset
  | 'ASSET_INVALID'
  | 'SOURCE_TRUSTLINE_MISSING'
  | 'SOURCE_TRUSTLINE_NOT_AUTHORIZED'
  | 'DESTINATION_TRUSTLINE_MISSING'
  | 'DESTINATION_TRUSTLINE_NOT_AUTHORIZED'
  | 'DESTINATION_TRUSTLINE_LIMIT_EXCEEDED'
  // memo
  | 'MEMO_INVALID'
  | 'MEMO_REQUIRED'
  // network
  | 'NETWORK_CONFIG_INVALID'
  | 'NETWORK_PASSPHRASE_MISMATCH'
  | 'NETWORK_LOOKUP_FAILED'
  // fee / balance
  | 'FEE_INVALID'
  | 'INSUFFICIENT_BALANCE'
  | 'INSUFFICIENT_FEE_BALANCE';

/** Stable codes for conditions worth showing that do not stop the payment. */
export type TransactionReadinessWarningCode =
  | 'NETWORK_ENDPOINT_MISMATCH'
  | 'DESTINATION_IS_ISSUER'
  | 'HIGH_FEE_RATIO';

/** The {@link TransactionReadinessParams} field (or config) an issue is about. */
export type TransactionReadinessField =
  | 'sourceAccount'
  | 'destination'
  | 'amount'
  | 'asset'
  | 'memo'
  | 'networkPassphrase'
  | 'fee'
  | 'config';

/** A condition that stops the payment from being ready. */
export interface TransactionReadinessBlocker {
  /** The check that produced this blocker. */
  check: TransactionReadinessCheck;
  /** Stable machine-readable code. */
  code: TransactionReadinessBlockerCode;
  /** The input the caller should change, when there is one. */
  field?: TransactionReadinessField;
  /** Human-readable message, safe to display. */
  message: string;
  /**
   * The code raised by the SDK validator or lookup this blocker came from,
   * carried verbatim (for example `INVALID_PUBLIC_KEY`, `TX_INVALID_MEMO`,
   * `REQUEST_TIMEOUT`). Absent when no SDK error was involved.
   */
  cause?: string;
  /**
   * `true` when running the same check again later may pass without the caller
   * changing any input — a Horizon lookup failure or timeout.
   */
  retryable: boolean;
}

/** A condition worth showing that does not stop the payment. */
export interface TransactionReadinessWarning {
  /** The check that produced this warning. */
  check: TransactionReadinessCheck;
  /** Stable machine-readable code. */
  code: TransactionReadinessWarningCode;
  /** The input the warning is about, when there is one. */
  field?: TransactionReadinessField;
  /** Human-readable message, safe to display. */
  message: string;
}

/**
 * Balance figures the balance check used, as canonical 7-decimal strings.
 * Present whenever the balance check had a loaded source account to work with.
 */
export interface TransactionReadinessBalance {
  /** The asset being sent. Native XLM is always reported as `{ code: 'XLM' }`. */
  asset: StellarAssetSpec;
  /** The payment amount. */
  amount: string;
  /** The total fee bid for the transaction, in XLM. */
  fee: string;
  /** XLM the source must have spendable: amount + fee for XLM payments, fee alone for issued assets. */
  nativeRequired: string;
  /** Spendable XLM: balance minus the minimum reserve and selling liabilities. */
  nativeAvailable: string;
  /** XLM held as the minimum reserve, using Stellar sponsorship semantics and the SDK base reserve. */
  minimumBalance: string;
  /**
   * Spendable balance of the issued asset (balance minus selling liabilities).
   * Absent for XLM payments, when the source is the asset's issuer, and when the
   * source holds no trustline for the asset.
   */
  assetAvailable?: string;
}

/** Inputs to {@link checkTransactionReadiness}. */
export interface TransactionReadinessParams {
  /** Public key of the source account (G...). Readiness never takes a secret. */
  sourceAccount: string;
  /** Public key of the destination account (G...). */
  destination: string;
  /** Amount to send, as a decimal string (for example `"10.5"`). */
  amount: string;
  /** Asset to send. Defaults to native XLM. */
  asset?: StellarAssetSpec;
  /** Memo: a text string or a typed {@link MemoInput}. */
  memo?: string | MemoInput;
  /**
   * The network passphrase the caller intends to sign with — for example the
   * one a wallet is connected to, or the one carried by a payment request.
   * When given, it must equal the passphrase of the configured network.
   */
  networkPassphrase?: string;
  /**
   * Maximum fee per operation, in stroops, as an integer string. Defaults to
   * `BASE_FEE` (100), which is what `sendXLM` and `sendAsset` bid. Must be at
   * least 100 and fit the protocol's 32-bit fee field.
   */
  fee?: string;
  /**
   * When `true`, also asks the configured Horizon server which network it
   * serves (`GET /`) and requires its passphrase to match the configured
   * network. Off by default because it adds one request.
   */
  verifyHorizonNetwork?: boolean;
}

/** Typed result of a readiness check. */
export interface TransactionReadiness {
  /** `true` only when every check passed and there are no blockers. */
  ready: boolean;
  /** Everything stopping the payment, in {@link READINESS_CHECK_ORDER}. Empty when `ready`. */
  blockers: TransactionReadinessBlocker[];
  /** Non-blocking findings, in {@link READINESS_CHECK_ORDER}. */
  warnings: TransactionReadinessWarning[];
  /** Status of every check. */
  checks: Record<TransactionReadinessCheck, TransactionReadinessCheckStatus>;
  /** The configured network, when configuration resolved. */
  network?: StellarNetwork;
  /** Passphrase of the configured network, when configuration resolved. */
  networkPassphrase?: string;
  /** Total fee bid for the one-operation payment, in stroops, when the fee was valid. */
  fee?: string;
  /** Balance figures used by the balance check. */
  balance?: TransactionReadinessBalance;
  /** ISO 8601 time the check completed. A readiness result is a point-in-time snapshot. */
  checkedAt: string;
}

// ─── Internals ──────────────────────────────────────────────────────────────

/** Minimum per-operation fee the protocol accepts, in stroops. */
const MIN_FEE_STROOPS = BigInt(StellarSDK.BASE_FEE);
/** The transaction fee is a uint32 on the wire. */
const MAX_FEE_STROOPS = 4_294_967_295n;
/** The payment helpers build exactly one payment operation. */
const PAYMENT_OPERATION_COUNT = 1n;
/** Warn when the fee is more than 1/10 of the amount (mirrors `enhancedSendXLM`). */
const HIGH_FEE_RATIO_DIVISOR = 10n;
/** SEP-29: base64("1"), the value of `config.memo_required` that demands a memo. */
const MEMO_REQUIRED_VALUE = 'MQ==';
const MEMO_REQUIRED_KEY = 'config.memo_required';

interface BalanceLineLike {
  asset_type?: unknown;
  asset_code?: unknown;
  asset_issuer?: unknown;
  balance?: unknown;
  limit?: unknown;
  buying_liabilities?: unknown;
  selling_liabilities?: unknown;
  is_authorized?: unknown;
}

interface AccountLike {
  balances?: unknown;
  subentry_count?: unknown;
  num_sponsoring?: unknown;
  num_sponsored?: unknown;
  data_attr?: unknown;
}

type AccountLookup =
  | { status: 'found'; account: AccountLike }
  | { status: 'not_found' }
  | { status: 'failed'; cause?: string };

/** Accumulates blockers, warnings and per-check completeness. */
function createCollector() {
  const blockers: TransactionReadinessBlocker[] = [];
  const warnings: TransactionReadinessWarning[] = [];
  const failed = new Set<TransactionReadinessCheck>();
  const incomplete = new Set<TransactionReadinessCheck>();

  return {
    block(blocker: Omit<TransactionReadinessBlocker, 'retryable'> & { retryable?: boolean }): void {
      blockers.push({ ...blocker, retryable: blocker.retryable ?? false });
      failed.add(blocker.check);
    },
    warn(warning: TransactionReadinessWarning): void {
      warnings.push(warning);
    },
    /** Marks a check as unable to run completely. */
    skip(check: TransactionReadinessCheck): void {
      incomplete.add(check);
    },
    finish(): Pick<TransactionReadiness, 'ready' | 'blockers' | 'warnings' | 'checks'> {
      const rank = (check: TransactionReadinessCheck) => READINESS_CHECK_ORDER.indexOf(check);
      const checks = {} as Record<TransactionReadinessCheck, TransactionReadinessCheckStatus>;
      for (const check of READINESS_CHECK_ORDER) {
        checks[check] = failed.has(check) ? 'failed' : incomplete.has(check) ? 'skipped' : 'passed';
      }
      const sortedBlockers = [...blockers].sort((a, b) => rank(a.check) - rank(b.check));
      const sortedWarnings = [...warnings].sort((a, b) => rank(a.check) - rank(b.check));
      const ready =
        sortedBlockers.length === 0 &&
        READINESS_CHECK_ORDER.every((check) => checks[check] === 'passed');
      return { ready, blockers: sortedBlockers, warnings: sortedWarnings, checks };
    },
  };
}

/** Never leak provider-defined error metadata into shareable readiness snapshots. */
function publicCause(error: unknown): string | undefined {
  try {
    if ((typeof error !== 'object' || error === null) && typeof error !== 'function') return undefined;
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' && isKnownErrorCode(code) ? code : undefined;
  } catch {
    // Third-party errors and Proxies can expose throwing accessors.
    return undefined;
  }
}

/** Runs an SDK validator without forwarding its input-echoing error message. */
function failureCode(run: () => unknown): { code?: string } | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return { code: publicCause(error) };
  }
}

/**
 * Validates a G... account ID. Stricter than `validatePublicKey` in one way:
 * surrounding whitespace is rejected, because the payment helpers pass the raw
 * string to the transaction builder, which does not trim.
 */
function accountIdFailure(value: unknown): { code?: string } | undefined {
  const failure = failureCode(() => validatePublicKey(value as string));
  if (failure) return failure;
  if (typeof value === 'string' && value !== value.trim()) return { code: 'INVALID_PUBLIC_KEY' };
  return undefined;
}

function isMuxedAccountId(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.startsWith('M') &&
    StellarSDK.StrKey.isValidMed25519PublicKey(value)
  );
}

function isNativeSpec(asset: StellarAssetSpec): boolean {
  const code = asset.code.trim();
  return code.toUpperCase() === 'XLM' || code.toLowerCase() === 'native';
}

/** Exact stroops for a Horizon decimal string; callers validate provider data first. */
function stroopsOf(value: unknown): bigint {
  if (typeof value !== 'string') return 0n;
  const parsed = safeParseAmount(value);
  return parsed.valid ? parsed.amount.stroops : 0n;
}

function integerOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0;
}

function isValidProviderAmount(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const parsed = safeParseAmount(value);
  return parsed.valid && parsed.amount.stroops >= 0n;
}

function isValidProviderCount(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function hasValidSourceNumericData(
  account: AccountLike,
  asset: StellarAssetSpec,
  source: string,
  issuer: string | undefined,
): boolean {
  const nativeLine = balanceLines(account).find((line) => line.asset_type === 'native');
  if (
    !nativeLine ||
    !isValidProviderAmount(nativeLine.balance) ||
    !isValidProviderAmount(nativeLine.selling_liabilities) ||
    !isValidProviderCount(account.subentry_count) ||
    !isValidProviderCount(account.num_sponsoring) ||
    !isValidProviderCount(account.num_sponsored)
  ) {
    return false;
  }

  if (!isNativeSpec(asset) && source !== issuer) {
    const line = findAssetLine(account, asset);
    if (
      line &&
      (!isValidProviderAmount(line.balance) ||
        !isValidProviderAmount(line.selling_liabilities))
    ) {
      return false;
    }
  }

  return true;
}

function hasValidDestinationNumericData(
  account: AccountLike,
  asset: StellarAssetSpec,
  destination: string,
  issuer: string | undefined,
): boolean {
  if (isNativeSpec(asset) || destination === issuer) return true;

  const line = findAssetLine(account, asset);
  return (
    !line ||
    (isValidProviderAmount(line.balance) &&
      isValidProviderAmount(line.limit) &&
      isValidProviderAmount(line.buying_liabilities))
  );
}

function balanceLines(account: AccountLike): BalanceLineLike[] {
  return Array.isArray(account.balances) ? (account.balances as BalanceLineLike[]) : [];
}

function findAssetLine(account: AccountLike, asset: StellarAssetSpec): BalanceLineLike | undefined {
  return balanceLines(account).find(
    (line) =>
      line.asset_type !== 'native' &&
      line.asset_code === asset.code &&
      line.asset_issuer === asset.issuer,
  );
}

function requiresMemo(account: AccountLike): boolean {
  const data = account.data_attr;
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as Record<string, unknown>)[MEMO_REQUIRED_KEY] === MEMO_REQUIRED_VALUE
  );
}

function maxBigInt(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

async function lookupAccount(
  server: ReturnType<typeof getHorizonServer>,
  cfg: ResolvedSDKConfig,
  accountId: string,
  label: string,
): Promise<AccountLookup> {
  try {
    const account = await withTimeout(label, cfg.timeout, server.loadAccount(accountId));
    return { status: 'found', account: account as unknown as AccountLike };
  } catch (error) {
    // Catching a network failure must not invoke untrusted throwing getters
    // outside the catch, nor copy arbitrary provider codes into UI models.
    let notFound = false;
    try {
      const err = error as { response?: { status?: unknown }; name?: unknown };
      notFound = err?.response?.status === 404 || err?.name === 'NotFoundError';
    } catch {
      // Treat a hostile response accessor as an unknown, retryable failure.
    }
    return notFound
      ? { status: 'not_found' }
      : { status: 'failed', cause: publicCause(error) };
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Checks whether a payment is ready to sign, without building, signing or
 * submitting anything.
 *
 * Runs every check in {@link READINESS_CHECK_ORDER} and collects all blockers
 * instead of stopping at the first, so a confirmation screen can show every
 * problem at once:
 *
 * | Check | Looks at |
 * |---|---|
 * | `source` | source public key format; account exists on the network |
 * | `destination` | public key format; muxed (M...) addresses, which the payment helpers do not accept; self-payment; account exists |
 * | `amount` | positive decimal, at most 7 decimal places, within the protocol maximum |
 * | `asset` | asset spec shape; for issued assets, source and destination trustlines (present, authorized, destination limit) |
 * | `memo` | memo type and length; SEP-29 `config.memo_required` on the destination |
 * | `network` | SDK configuration; `networkPassphrase` against the configured network; optionally Horizon's own passphrase |
 * | `fee` | per-operation fee bid is an integer ≥ 100 stroops that fits the protocol's fee field |
 * | `balance` | source can cover amount + fee above its minimum reserve and selling liabilities |
 *
 * This function does not throw for bad input or Horizon failures: those come
 * back as blockers (lookup failures with `retryable: true`).
 *
 * @param params - The payment to check. Takes the source **public** key.
 * @param config - Optional SDK config overrides, as for `sendXLM`.
 * @returns A {@link TransactionReadiness} snapshot.
 *
 * @example
 * ```ts
 * const readiness = await checkTransactionReadiness({
 *   sourceAccount: wallet.publicKey,
 *   destination,
 *   amount: '25',
 *   memo: 'invoice #42',
 * });
 *
 * if (!readiness.ready) {
 *   for (const blocker of readiness.blockers) showFieldError(blocker.field, blocker.message);
 *   return;
 * }
 * await sendXLM({ sourceSecret, destination, amount: '25', memo: 'invoice #42' });
 * ```
 */
export async function checkTransactionReadiness(
  params: TransactionReadinessParams,
  config?: Partial<SDKConfig>,
): Promise<TransactionReadiness> {
  const input: Partial<TransactionReadinessParams> =
    params && typeof params === 'object' ? params : {};
  const c = createCollector();

  // ─── 1. source (local) ────────────────────────────────────────────────────
  const sourceFailure = accountIdFailure(input.sourceAccount);
  if (sourceFailure) {
    c.block({
      check: 'source',
      code: 'SOURCE_INVALID',
      field: 'sourceAccount',
      message: 'Source account must be a valid Stellar public key (G...).',
      cause: sourceFailure.code,
    });
  }
  const source = sourceFailure ? undefined : (input.sourceAccount as string);

  // ─── 2. destination (local) ───────────────────────────────────────────────
  let destination: string | undefined;
  if (isMuxedAccountId(input.destination)) {
    c.block({
      check: 'destination',
      code: 'DESTINATION_MUXED_UNSUPPORTED',
      field: 'destination',
      message:
        'Muxed (M...) destination addresses are not supported by the SDK payment helpers. ' +
        'Use the underlying G... account and identify the recipient with a memo.',
    });
  } else {
    const destinationFailure = accountIdFailure(input.destination);
    if (destinationFailure) {
      c.block({
        check: 'destination',
        code: 'DESTINATION_INVALID',
        field: 'destination',
        message: 'Destination must be a valid Stellar public key (G...).',
        cause: destinationFailure.code,
      });
    } else if (source !== undefined && source === input.destination) {
      c.block({
        check: 'destination',
        code: 'DESTINATION_SELF_PAYMENT',
        field: 'destination',
        message: 'Source and destination are the same account.',
        cause: 'SELF_PAYMENT',
      });
    } else {
      destination = input.destination as string;
    }
  }

  // ─── 3. amount (local) ────────────────────────────────────────────────────
  let amountStroops: bigint | undefined;
  const amountFailure = failureCode(() => validateAmount(input.amount as string));
  if (amountFailure) {
    c.block({
      check: 'amount',
      code: amountFailure.code === 'INVALID_AMOUNT_PRECISION' ? 'AMOUNT_PRECISION' : 'AMOUNT_INVALID',
      field: 'amount',
      message: 'Amount must be a valid positive decimal number with at most seven fractional digits.',
      cause: amountFailure.code,
    });
  } else {
    // `validateAmount` accepts values above the protocol maximum; the exact
    // parser does not, and it gives us stroops for the balance arithmetic.
    const parsed = safeParseAmount(input.amount as string);
    if (parsed.valid) {
      amountStroops = parsed.amount.stroops;
    } else {
      c.block({
        check: 'amount',
        code: 'AMOUNT_INVALID',
        field: 'amount',
        message: 'Amount is outside the supported Stellar payment range or precision.',
        cause: parsed.error.code,
      });
    }
  }

  // ─── 4. asset (local) ─────────────────────────────────────────────────────
  const requestedAsset: StellarAssetSpec = input.asset ?? { code: 'XLM' };
  const assetFailure = failureCode(() => validateAssetSpec(requestedAsset));
  if (assetFailure) {
    c.block({
      check: 'asset',
      code: 'ASSET_INVALID',
      field: 'asset',
      message: 'Asset must be native XLM or a valid issued asset code and issuer.',
      cause: assetFailure.code,
    });
  }
  const asset = assetFailure ? undefined : requestedAsset;
  const isNative = asset !== undefined && isNativeSpec(asset);
  const issuer = asset !== undefined && !isNative ? asset.issuer : undefined;

  // ─── 5. memo (local) ──────────────────────────────────────────────────────
  const memoResult = safeValidateMemo(input.memo);
  let hasMemo = false;
  if (!memoResult.valid) {
    c.block({
      check: 'memo',
      code: 'MEMO_INVALID',
      field: 'memo',
      message: 'Memo type or value is invalid for the Stellar protocol.',
      cause: memoResult.error.code,
    });
  } else {
    const normalized = normalizeMemo(input.memo);
    hasMemo = normalized !== undefined && normalized.type !== 'none';
  }

  // ─── 6. fee (local) ───────────────────────────────────────────────────────
  let feePerOperation: bigint | undefined;
  if (input.fee === undefined) {
    feePerOperation = MIN_FEE_STROOPS;
  } else if (
    typeof input.fee === 'string' &&
    /^\d+$/.test(input.fee) &&
    BigInt(input.fee) >= MIN_FEE_STROOPS &&
    BigInt(input.fee) * PAYMENT_OPERATION_COUNT <= MAX_FEE_STROOPS
  ) {
    feePerOperation = BigInt(input.fee);
  } else {
    c.block({
      check: 'fee',
      code: 'FEE_INVALID',
      field: 'fee',
      message: `Fee must be a whole number of stroops between ${MIN_FEE_STROOPS} and ${MAX_FEE_STROOPS}.`,
    });
  }
  const totalFee =
    feePerOperation !== undefined ? feePerOperation * PAYMENT_OPERATION_COUNT : undefined;

  if (isNative && amountStroops !== undefined && totalFee !== undefined) {
    if (totalFee * HIGH_FEE_RATIO_DIVISOR > amountStroops) {
      c.warn({
        check: 'fee',
        code: 'HIGH_FEE_RATIO',
        field: 'fee',
        message: `The fee (${formatStroops(totalFee)} XLM) is more than 10% of the payment amount.`,
      });
    }
  }

  // ─── 7. network (configuration) ───────────────────────────────────────────
  let cfg: ResolvedSDKConfig | undefined;
  let passphrase: string | undefined;
  let configResult: ReturnType<typeof validatePocketPayConfig> | undefined;
  let configThrew: { code?: string } | undefined;
  try {
    configResult = validatePocketPayConfig(config);
  } catch (error) {
    configThrew = { code: publicCause(error) };
  }

  if (configResult?.valid && configResult.config) {
    cfg = configResult.config;
    passphrase = getNetworkPassphrase(cfg.network);
    for (const issue of configResult.warnings) {
      if (issue.code === 'NETWORK_MISMATCH') {
        // Configuration warnings may interpolate full URLs (including userinfo,
        // query tokens, or private endpoint paths). Readiness is UI-facing, so
        // preserve the stable code but never forward a raw config message.
        c.warn({
          check: 'network',
          code: 'NETWORK_ENDPOINT_MISMATCH',
          field: 'config',
          message: 'A configured network endpoint appears to target another Stellar network. Check your network and endpoint settings.',
        });
      }
    }
    if (input.networkPassphrase !== undefined && input.networkPassphrase !== passphrase) {
      c.block({
        check: 'network',
        code: 'NETWORK_PASSPHRASE_MISMATCH',
        field: 'networkPassphrase',
        message: `The signing network passphrase does not match the configured ${cfg.network} network.`,
      });
    }
  } else {
    const firstError = configResult?.errors[0];
    c.block({
      check: 'network',
      code: 'NETWORK_CONFIG_INVALID',
      field: 'config',
      // Configuration messages can include raw untrusted endpoint values,
      // credentials or query tokens. Use a static UI-safe message here.
      message: 'SDK configuration is invalid. Check network and endpoint settings.',
      cause: firstError?.code ?? configThrew?.code,
    });
  }

  // ─── Network lookups ──────────────────────────────────────────────────────
  let sourceLookup: AccountLookup | undefined;
  let destinationLookup: AccountLookup | undefined;

  if (cfg) {
    const server = getHorizonServer(cfg);
    const activeCfg = cfg;

    const horizonCheck = input.verifyHorizonNetwork
      ? (async (): Promise<{ passphrase?: unknown } | { failed: true; cause?: string }> => {
          try {
            const root = await withTimeout(
              'Horizon network passphrase lookup for readiness',
              activeCfg.timeout,
              server.root(),
            );
            return { passphrase: (root as { network_passphrase?: unknown })?.network_passphrase };
          } catch (error) {
            return { failed: true, cause: publicCause(error) };
          }
        })()
      : Promise.resolve(undefined);

    const [sourceResult, destinationResult, horizonResult] = await Promise.all([
      source !== undefined
        ? lookupAccount(server, activeCfg, source, 'Horizon source account lookup for readiness')
        : Promise.resolve(undefined),
      destination !== undefined
        ? lookupAccount(server, activeCfg, destination, 'Horizon destination account lookup for readiness')
        : Promise.resolve(undefined),
      horizonCheck,
    ]);
    sourceLookup = sourceResult;
    destinationLookup = destinationResult;

    if (horizonResult && 'failed' in horizonResult) {
      c.block({
        check: 'network',
        code: 'NETWORK_LOOKUP_FAILED',
        field: 'config',
        message: 'Could not ask Horizon which network it serves.',
        cause: horizonResult.cause,
        retryable: true,
      });
    } else if (horizonResult && horizonResult.passphrase !== passphrase) {
      c.block({
        check: 'network',
        code: 'NETWORK_PASSPHRASE_MISMATCH',
        field: 'config',
        message: `The configured Horizon server does not serve the configured ${activeCfg.network} network.`,
      });
    }
  }

  // ─── 1b. source (network) ─────────────────────────────────────────────────
  let sourceAccount = sourceLookup?.status === 'found' ? sourceLookup.account : undefined;
  if (
    sourceAccount &&
    source !== undefined &&
    asset !== undefined &&
    !hasValidSourceNumericData(sourceAccount, asset, source, issuer)
  ) {
    c.block({
      check: 'source',
      code: 'SOURCE_LOOKUP_FAILED',
      field: 'sourceAccount',
      message: 'Horizon returned malformed numeric account data for the source account.',
      retryable: true,
    });
    sourceAccount = undefined;
  }

  if (sourceLookup?.status === 'not_found') {
    c.block({
      check: 'source',
      code: 'SOURCE_NOT_FOUND',
      field: 'sourceAccount',
      message: 'The source account does not exist on the network. Fund it before sending.',
    });
  } else if (sourceLookup?.status === 'failed') {
    c.block({
      check: 'source',
      code: 'SOURCE_LOOKUP_FAILED',
      field: 'sourceAccount',
      message: 'Could not load the source account from Horizon.',
      cause: sourceLookup.cause,
      retryable: true,
    });
  } else if (source !== undefined && !cfg) {
    c.skip('source');
  }

  // ─── 2b. destination (network) and 5b. memo-required ──────────────────────
  let destinationAccount =
    destinationLookup?.status === 'found' ? destinationLookup.account : undefined;
  if (
    destinationAccount &&
    destination !== undefined &&
    asset !== undefined &&
    !hasValidDestinationNumericData(destinationAccount, asset, destination, issuer)
  ) {
    c.block({
      check: 'destination',
      code: 'DESTINATION_LOOKUP_FAILED',
      field: 'destination',
      message: 'Horizon returned malformed numeric account data for the destination account.',
      retryable: true,
    });
    destinationAccount = undefined;
  }

  if (destinationLookup?.status === 'not_found') {
    c.block({
      check: 'destination',
      code: 'DESTINATION_NOT_FOUND',
      field: 'destination',
      message:
        'The destination account does not exist on the network. A payment cannot create it; ' +
        'it must be funded with a create-account operation first.',
    });
  } else if (destinationLookup?.status === 'failed') {
    c.block({
      check: 'destination',
      code: 'DESTINATION_LOOKUP_FAILED',
      field: 'destination',
      message: 'Could not load the destination account from Horizon.',
      cause: destinationLookup.cause,
      retryable: true,
    });
  } else if (destination !== undefined && !cfg) {
    c.skip('destination');
  }

  if (destinationAccount) {
    if (memoResult.valid && !hasMemo && requiresMemo(destinationAccount)) {
      c.block({
        check: 'memo',
        code: 'MEMO_REQUIRED',
        field: 'memo',
        message: 'The destination account requires a memo (SEP-29). Add the memo the recipient asked for.',
      });
    }
  } else {
    c.skip('memo');
  }

  // ─── 4b. asset (network): trustlines for issued assets ────────────────────
  if (asset !== undefined && !isNative) {
    // Source side: the issuer can always send its own asset.
    if (sourceAccount) {
      if (source !== issuer) {
        const line = findAssetLine(sourceAccount, asset);
        if (!line) {
          c.block({
            check: 'asset',
            code: 'SOURCE_TRUSTLINE_MISSING',
            field: 'asset',
            message: `The source account does not hold a trustline for ${asset.code}.`,
          });
        } else if (line.is_authorized !== true) {
          c.block({
            check: 'asset',
            code: 'SOURCE_TRUSTLINE_NOT_AUTHORIZED',
            field: 'asset',
            message: `The issuer has not authorized the source account to send ${asset.code}.`,
          });
        }
      }
    } else {
      c.skip('asset');
    }

    // Destination side: paying the issuer needs no trustline (it burns the asset).
    if (destinationAccount && destination !== undefined) {
      if (destination === issuer) {
        c.warn({
          check: 'asset',
          code: 'DESTINATION_IS_ISSUER',
          field: 'destination',
          message: `The destination is the issuer of ${asset.code}; the payment removes it from circulation.`,
        });
      } else {
        const line = findAssetLine(destinationAccount, asset);
        if (!line) {
          c.block({
            check: 'asset',
            code: 'DESTINATION_TRUSTLINE_MISSING',
            field: 'destination',
            message: `The destination account does not hold a trustline for ${asset.code}.`,
            cause: 'MISSING_TRUSTLINE',
          });
        } else if (line.is_authorized !== true) {
          c.block({
            check: 'asset',
            code: 'DESTINATION_TRUSTLINE_NOT_AUTHORIZED',
            field: 'destination',
            message: `The issuer has not authorized the destination account to receive ${asset.code}.`,
            cause: 'TRUSTLINE_NOT_AUTHORIZED',
          });
        } else if (amountStroops !== undefined) {
          const capacity = maxBigInt(
            0n,
            stroopsOf(line.limit) - stroopsOf(line.balance) - stroopsOf(line.buying_liabilities),
          );
          if (amountStroops > capacity) {
            c.block({
              check: 'asset',
              code: 'DESTINATION_TRUSTLINE_LIMIT_EXCEEDED',
              field: 'amount',
              message:
                `The amount exceeds what the destination's ${asset.code} trustline can still receive ` +
                `(${formatStroops(capacity)}).`,
              cause: 'TRUSTLINE_LIMIT_EXCEEDED',
            });
          }
        } else {
          c.skip('asset');
        }
      }
    } else {
      c.skip('asset');
    }
  }

  // ─── 8. balance (network) ─────────────────────────────────────────────────
  let balance: TransactionReadinessBalance | undefined;
  if (sourceAccount && amountStroops !== undefined && asset !== undefined && totalFee !== undefined) {
    const nativeLine = balanceLines(sourceAccount).find((line) => line.asset_type === 'native');
    // CAP-33 sponsorship can cover both subentries and the account's own
    // two base reserves. Apply the protocol formula before flooring at zero;
    // passing a negative effective subentry count through calculateNativeReserves
    // would clamp too early and incorrectly restore the ordinary 1 XLM floor.
    const reserveUnits = Math.max(
      0,
      2 +
        integerOf(sourceAccount.subentry_count) +
        integerOf(sourceAccount.num_sponsoring) -
        integerOf(sourceAccount.num_sponsored),
    );
    const baseReserve = stroopsOf(calculateNativeReserves(0).baseReserve);
    const minimumBalance = BigInt(reserveUnits) * baseReserve;
    const nativeAvailable = maxBigInt(
      0n,
      stroopsOf(nativeLine?.balance) - minimumBalance - stroopsOf(nativeLine?.selling_liabilities),
    );
    const nativeRequired = isNative ? amountStroops + totalFee : totalFee;

    balance = {
      asset: isNative ? { code: 'XLM' } : { code: asset.code, issuer: asset.issuer },
      amount: formatStroops(amountStroops),
      fee: formatStroops(totalFee),
      nativeRequired: formatStroops(nativeRequired),
      nativeAvailable: formatStroops(nativeAvailable),
      minimumBalance: formatStroops(minimumBalance),
    };

    if (isNative) {
      if (nativeRequired > nativeAvailable) {
        c.block({
          check: 'balance',
          code: 'INSUFFICIENT_BALANCE',
          field: 'amount',
          message:
            `Spendable XLM (${formatStroops(nativeAvailable)}) does not cover the amount plus fee ` +
            `(${formatStroops(nativeRequired)}); ${formatStroops(minimumBalance)} XLM is held as the minimum reserve.`,
        });
      }
    } else {
      if (nativeRequired > nativeAvailable) {
        c.block({
          check: 'balance',
          code: 'INSUFFICIENT_FEE_BALANCE',
          field: 'fee',
          message:
            `Spendable XLM (${formatStroops(nativeAvailable)}) does not cover the fee ` +
            `(${formatStroops(nativeRequired)}); ${formatStroops(minimumBalance)} XLM is held as the minimum reserve.`,
        });
      }
      if (source !== issuer) {
        const line = findAssetLine(sourceAccount, asset);
        if (line) {
          const assetAvailable = maxBigInt(
            0n,
            stroopsOf(line.balance) - stroopsOf(line.selling_liabilities),
          );
          balance.assetAvailable = formatStroops(assetAvailable);
          if (amountStroops > assetAvailable) {
            c.block({
              check: 'balance',
              code: 'INSUFFICIENT_BALANCE',
              field: 'amount',
              message:
                `Spendable ${asset.code} (${formatStroops(assetAvailable)}) does not cover the amount ` +
                `(${formatStroops(amountStroops)}).`,
            });
          }
        } else {
          // No trustline: the asset check already reported it; nothing to compare.
          c.skip('balance');
        }
      }
    }
  } else {
    c.skip('balance');
  }

  return {
    ...c.finish(),
    ...(cfg ? { network: cfg.network, networkPassphrase: passphrase } : {}),
    ...(totalFee !== undefined ? { fee: totalFee.toString() } : {}),
    ...(balance ? { balance } : {}),
    checkedAt: new Date().toISOString(),
  };
}
