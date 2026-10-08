/**
 * Account-focused diagnostics for support and payment-readiness triage.
 *
 * This report only consumes public account state and the SDK's already-redacted
 * configuration snapshot. It never accepts or returns signing material.
 *
 * Layering: `diagnostics` is a Layer 1 module (see
 * docs/dependency_direction_map.md) and must not import feature modules such
 * as `wallet`. The default account lookup therefore reads Horizon through
 * `config` + `network`, the same way `account/sequence.ts` does. Callers that
 * prefer the wallet helper can inject it: `{ lookup: getBalanceOrUnfunded }`.
 */

import * as StellarSDK from '@stellar/stellar-sdk';
import { getHorizonServer, resolveConfig } from '../config';
import { isKnownErrorCode } from '../errors';
import { withTimeout } from '../network';
import type { AssetBalance, BalanceResult, SDKConfig } from '../types';
import { formatStroops, safeParseAmount } from '../utils/amount';
import { buildDiagnosticsReport } from './report';
import {
  DIAGNOSTICS_REDACTED_PLACEHOLDER,
  redactDiagnosticsValue,
} from './redact';
import type {
  AccountDiagnosticsReport,
  AccountDiagnosticsSnapshot,
  BuildAccountDiagnosticsOptions,
  PaymentReadinessReason,
  PaymentReadinessSnapshot,
} from './types';

/** Current protocol base reserve (0.5 XLM) on testnet and mainnet, in stroops. */
const BASE_RESERVE_STROOPS = 5_000_000n;

/** Minimum per-operation network fee (100 stroops). */
const MIN_BASE_FEE_STROOPS = 100n;

const DEFAULT_ERROR_CODE = 'ACCOUNT_DIAGNOSTICS_ERROR';
const INVALID_PUBLIC_KEY_CODE = 'INVALID_PUBLIC_KEY';

interface NormalizedAccountError {
  code: string;
  message: string;
  httpStatus?: number;
}

function httpStatusOf(error: object): number | undefined {
  // Provider/library Error objects may expose throwing getters. Never let an
  // accessor failure break the support-safe account diagnostics fallback.
  try {
    const candidate =
      (error as { statusCode?: unknown }).statusCode ??
      (error as { response?: { status?: unknown } }).response?.status;
    return typeof candidate === 'number' && Number.isInteger(candidate)
      && candidate >= 100 && candidate <= 599
      ? candidate
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizeAccountError(error: unknown): NormalizedAccountError {
  let code = DEFAULT_ERROR_CODE;
  let httpStatus: number | undefined;

  if (error && typeof error === 'object') {
    try {
      const candidate = (error as { code?: unknown }).code;
      if (typeof candidate === 'string' && isKnownErrorCode(candidate)) {
        code = candidate;
      }
    } catch {
      // Error code getter is untrusted; preserve the stable SDK fallback.
    }
    httpStatus = httpStatusOf(error);
  }

  // Do not forward provider messages into a shareable support report. They may
  // contain URLs, headers, account material, or other context the SDK cannot
  // classify safely.
  return {
    code,
    message: 'Account state could not be loaded.',
    ...(httpStatus !== undefined ? { httpStatus } : {}),
  };
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  try {
    if ((error as { code?: unknown }).code === 'ACCOUNT_NOT_FOUND') return true;
  } catch {
    // Still check a safe HTTP status, even when the code getter throws.
  }
  return httpStatusOf(error) === 404;
}

/**
 * Default lookup: one Horizon account read, mapped to the same
 * {@link BalanceResult} shape that `getBalanceOrUnfunded` returns.
 * A 404 means the account has never been funded; anything else is thrown.
 */
async function loadAccountFromHorizon(
  publicKey: string,
  config?: Partial<SDKConfig>,
): Promise<BalanceResult> {
  const server = getHorizonServer(config);
  const { timeout } = resolveConfig(config);

  try {
    const account = await withTimeout(
      'Horizon account lookup',
      timeout,
      server.loadAccount(publicKey),
    );
    const balances: AssetBalance[] = account.balances.map((bal: any) =>
      bal.asset_type === 'native'
        ? { asset: 'XLM', balance: bal.balance, issuer: '' }
        : {
            asset: bal.asset_code || 'unknown',
            balance: bal.balance,
            issuer: bal.asset_issuer || '',
          },
    );
    const native = balances.find((b) => b.asset === 'XLM' && b.issuer === '');
    return {
      status: 'funded',
      publicKey,
      balance: { publicKey, balances, nativeBalance: native?.balance ?? '0' },
    };
  } catch (error) {
    if (isNotFound(error)) return { status: 'unfunded', publicKey };
    throw error;
  }
}

/**
 * Lower-bound minimum balance: (2 + trustlines) x base reserve. Offers, extra
 * signers, data entries, sponsorships and selling liabilities are not visible
 * in a balance list and can only raise the real minimum.
 */
function estimateMinimumBalanceStroops(balances: AssetBalance[]): bigint {
  const trustlines = balances.filter(
    (b) => !(b.asset === 'XLM' && b.issuer === ''),
  ).length;
  return (2n + BigInt(trustlines)) * BASE_RESERVE_STROOPS;
}

function invalidPublicKeyReadiness(
  networkConfigured: boolean,
): PaymentReadinessSnapshot {
  const reasons: PaymentReadinessReason[] = ['INVALID_PUBLIC_KEY'];
  if (!networkConfigured) reasons.push('NETWORK_CONFIGURATION_UNAVAILABLE');
  return {
    status: 'not_ready',
    accountFunded: false,
    feeBalancePresent: false,
    networkConfigured,
    reasons,
  };
}

function paymentReadiness(
  account: AccountDiagnosticsSnapshot,
  networkConfigured: boolean,
): PaymentReadinessSnapshot {
  if (account.status === 'error') {
    if (account.errorCode === INVALID_PUBLIC_KEY_CODE) {
      return invalidPublicKeyReadiness(networkConfigured);
    }
    const reasons: PaymentReadinessReason[] = ['ACCOUNT_STATE_UNAVAILABLE'];
    if (!networkConfigured) reasons.push('NETWORK_CONFIGURATION_UNAVAILABLE');
    return {
      status: 'unknown',
      accountFunded: false,
      feeBalancePresent: false,
      networkConfigured,
      reasons,
    };
  }

  const accountFunded = account.status === 'funded';

  let feeBalancePresent = false;
  if (accountFunded && account.nativeBalance !== undefined) {
    const native = safeParseAmount(account.nativeBalance);
    const minimum =
      account.estimatedMinimumBalance !== undefined
        ? safeParseAmount(account.estimatedMinimumBalance)
        : undefined;
    feeBalancePresent =
      native.valid &&
      minimum !== undefined &&
      minimum.valid &&
      native.amount.stroops - minimum.amount.stroops >= MIN_BASE_FEE_STROOPS;
  }

  const reasons: PaymentReadinessReason[] = [];
  if (!accountFunded) reasons.push('ACCOUNT_UNFUNDED');
  if (accountFunded && !feeBalancePresent) reasons.push('NO_NATIVE_XLM_FOR_FEES');
  if (!networkConfigured) reasons.push('NETWORK_CONFIGURATION_UNAVAILABLE');

  return {
    status:
      accountFunded && feeBalancePresent && networkConfigured
        ? 'ready'
        : 'not_ready',
    accountFunded,
    feeBalancePresent,
    networkConfigured,
    reasons,
  };
}

/**
 * Build a support-safe diagnostics report for one public Stellar account.
 *
 * "ready" means the account-side prerequisites visible without constructing a
 * payment are present: the account is funded, its native XLM balance exceeds
 * the estimated minimum balance by at least one base fee (100 stroops), and
 * the configured network is recognized. Callers must still perform normal
 * per-payment validation for destination, amount, trustlines, sequence and
 * operation-specific requirements.
 *
 * The function does not throw for account lookup failures; they are reported
 * as `account.status: 'error'` with a stable code and a fixed message. Invalid
 * configuration overrides still throw, exactly like {@link buildDiagnosticsReport}.
 *
 * Tests and offline consumers can inject `lookup` to avoid network I/O.
 *
 * @param publicKey - Public account id (`G...`). Anything else is reported as
 *   `INVALID_PUBLIC_KEY` and is never echoed into the report.
 * @param options - Optional config overrides and lookup seam.
 * @returns A deep-redacted {@link AccountDiagnosticsReport}
 */
export async function buildAccountDiagnosticsReport(
  publicKey: string,
  options: BuildAccountDiagnosticsOptions = {},
): Promise<AccountDiagnosticsReport> {
  const overrides: Partial<SDKConfig> | undefined = options.config;
  const base = buildDiagnosticsReport(overrides);
  const lookup = options.lookup ?? loadAccountFromHorizon;

  const accountId = typeof publicKey === 'string' ? publicKey.trim() : '';

  let account: AccountDiagnosticsSnapshot;
  if (!StellarSDK.StrKey.isValidEd25519PublicKey(accountId)) {
    // Never echo unvalidated input: a caller may have passed a secret key,
    // seed phrase or other material by mistake.
    account = {
      publicKey: DIAGNOSTICS_REDACTED_PLACEHOLDER,
      status: 'error',
      errorCode: INVALID_PUBLIC_KEY_CODE,
      errorMessage: 'The supplied account id is not a valid Stellar public key (G...).',
    };
  } else {
    try {
      const result = await lookup(accountId, overrides);

      // An injected provider or adapter may accidentally serve a cached response
      // for a different wallet. Never report another account's balance or
      // payment readiness under the requested identity.
      if (result.publicKey !== accountId ||
          (result.status === 'funded' && result.balance.publicKey !== accountId)) {
        throw new Error('Account lookup returned a different public identity.');
      }

      if (result.status === 'unfunded') {
        account = { publicKey: accountId, status: 'unfunded' };
      } else {
        account = {
          publicKey: accountId,
          status: 'funded',
          nativeBalance: result.balance.nativeBalance,
          assetCount: result.balance.balances.length,
          estimatedMinimumBalance: formatStroops(
            estimateMinimumBalanceStroops(result.balance.balances),
          ),
        };
      }
    } catch (error) {
      if (isNotFound(error)) {
        account = { publicKey: accountId, status: 'unfunded' };
      } else {
        const normalized = normalizeAccountError(error);
        account = {
          publicKey: accountId,
          status: 'error',
          errorCode: normalized.code,
          errorMessage: normalized.message,
          ...(normalized.httpStatus !== undefined
            ? { errorHttpStatus: normalized.httpStatus }
            : {}),
        };
      }
    }
  }

  const networkConfigured =
    base.network.passphraseKnown && base.network.horizonUrl.length > 0;

  return redactDiagnosticsValue({
    ...base,
    account,
    paymentReadiness: paymentReadiness(account, networkConfigured),
  });
}
