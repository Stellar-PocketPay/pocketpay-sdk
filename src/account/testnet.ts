/**
 * Deterministic Testnet account diagnostics.
 *
 * This module is intentionally read-only: it never creates, funds, signs for,
 * or mutates an account. The default lookup always targets Stellar Testnet.
 */

import type { AccountBalance, BalanceResult, SDKConfig } from '../types';
import { PocketPayError } from '../types';
import { HORIZON_URLS } from '../config';
import { isKnownErrorCode } from '../errors/codes';
import { redactSensitive, validatePublicKey } from '../utils';
import { getBalanceOrUnfunded } from '../wallet';

export type TestnetAccountStatus = 'funded' | 'unfunded' | 'unavailable';

interface TestnetAccountDiagnosticBase {
  /** The public Stellar account being inspected. Never secret material. */
  publicKey: string;
  /** This helper never targets mainnet. */
  network: 'testnet';
  /** Explicit capability marker for consumers and diagnostics UIs. */
  testnetOnly: true;
}

export interface FundedTestnetAccountDiagnostic extends TestnetAccountDiagnosticBase {
  status: 'funded';
  balance: AccountBalance;
}

export interface UnfundedTestnetAccountDiagnostic extends TestnetAccountDiagnosticBase {
  status: 'unfunded';
}

export interface UnavailableTestnetAccountDiagnostic extends TestnetAccountDiagnosticBase {
  status: 'unavailable';
  /** Typed SDK/network code when the failing lookup exposes one. */
  errorCode?: string;
  /** Stable, non-sensitive message suitable for logs and UI. */
  message: string;
}

export type TestnetAccountDiagnostic =
  | FundedTestnetAccountDiagnostic
  | UnfundedTestnetAccountDiagnostic
  | UnavailableTestnetAccountDiagnostic;

/**
 * Injectable account-state lookup used by deterministic tests and offline
 * consumers. Implementations must not return secret material.
 */
export type TestnetAccountLookup = (publicKey: string) => Promise<BalanceResult>;

export interface DiagnoseTestnetAccountOptions {
  /**
   * Optional lookup override. Supplying one avoids all network I/O and is the
   * recommended path for unit tests and deterministic fixtures.
   */
  lookup?: TestnetAccountLookup;
  /**
   * Optional SDK settings for the default Horizon lookup. `network` is always
   * overridden to `testnet` by this helper.
   */
  config?: Partial<SDKConfig>;
}

function readErrorCode(error: unknown): string | undefined {
  try {
    if (typeof error !== 'object' || error === null || !('code' in error)) {
      return undefined;
    }
    const code = (error as { code?: unknown }).code;
    // Diagnostic error codes are identifiers, not untrusted provider text.
    // Keep ONLY known public SDK codes; matching an identifier shape is
    // insufficient because an upstream provider can manufacture uppercase
    // tokens that look like SDK codes or encode private metadata.
    if (
      typeof code !== 'string' ||
      !/^[A-Z][A-Z0-9_]{0,47}$/.test(code) ||
      !isKnownErrorCode(code) ||
      redactSensitive(code) !== code
    ) {
      return undefined;
    }
    return code;
  } catch {
    // A thrown value may be an object with hostile getters or a Proxy.
    // Diagnostics must still return the stable "unavailable" result.
    return undefined;
  }
}

/**
 * Validates the public-key-only input without ever echoing caller material.
 * The shared validator includes invalid values in its error metadata, which is
 * useful for generic validation but unsafe for a diagnostics helper: callers
 * can accidentally paste a secret seed into this field and then serialize the
 * thrown error.
 */
function validateDiagnosticPublicKey(publicKey: unknown): asserts publicKey is string {
  const hasSurroundingWhitespace =
    typeof publicKey === 'string' && publicKey !== publicKey.trim();
  const reason =
    typeof publicKey !== 'string'
      ? 'not_a_string'
      : publicKey.trim().toUpperCase().startsWith('S')
        ? 'secret_key_not_allowed'
        : hasSurroundingWhitespace
          ? 'surrounding_whitespace'
          : 'invalid_format';

  if (hasSurroundingWhitespace) {
    throw new PocketPayError(
      'Invalid Stellar public key.',
      'INVALID_PUBLIC_KEY',
      { validation: { field: 'publicKey', reason } },
    );
  }

  try {
    validatePublicKey(publicKey as string);
  } catch {
    throw new PocketPayError(
      reason === 'secret_key_not_allowed'
        ? 'Testnet account diagnostics require a public Stellar address; secret keys are not accepted.'
        : 'Invalid Stellar public key.',
      'INVALID_PUBLIC_KEY',
      { validation: { field: 'publicKey', reason } },
    );
  }
}

/**
 * Inspect a Stellar Testnet account and return a deterministic three-state
 * diagnostic: `funded`, `unfunded`, or `unavailable`.
 *
 * Invalid public keys remain programmer/input errors and are rejected before
 * any lookup is attempted. Horizon/network failures are converted to the
 * `unavailable` state without exposing raw provider errors or sensitive data.
 */
export async function diagnoseTestnetAccount(
  publicKey: string,
  options: DiagnoseTestnetAccountOptions = {},
): Promise<TestnetAccountDiagnostic> {
  validateDiagnosticPublicKey(publicKey);

  const base: TestnetAccountDiagnosticBase = {
    publicKey,
    network: 'testnet',
    testnetOnly: true,
  };

  try {
    const result = options.lookup
      ? await options.lookup(publicKey)
      : await getBalanceOrUnfunded(publicKey, {
          ...options.config,
          network: 'testnet',
          // Pin the actual account lookup boundary too. resolveConfig() otherwise
          // preserves a caller/env Horizon override even when network is testnet.
          horizonUrl: HORIZON_URLS.testnet,
        });

    // A lookup adapter can return a cached entry for a *different* account.
    // Never label the requested key funded or unfunded from mismatched identity.
    if (!result || result.publicKey !== publicKey) {
      throw new Error('Testnet account lookup identity mismatch');
    }

    if (result.status === 'funded') {
      const balance = result.balance;
      const amountPattern = /^[0-9]+(?:[.][0-9]{1,7})?$/;
      const nativeEntries = Array.isArray(balance?.balances)
        ? balance.balances.filter(
            (entry) =>
              entry?.asset === 'XLM' &&
              entry.issuer === '' &&
              typeof entry.balance === 'string' &&
              amountPattern.test(entry.balance),
          )
        : [];

      if (
        !balance ||
        balance.publicKey !== publicKey ||
        typeof balance.nativeBalance !== 'string' ||
        !amountPattern.test(balance.nativeBalance) ||
        !Array.isArray(balance.balances) ||
        nativeEntries.length !== 1 ||
        nativeEntries[0]?.balance !== balance.nativeBalance
      ) {
        throw new Error('Testnet account lookup returned malformed funded balance');
      }
      return {
        ...base,
        status: 'funded',
        balance,
      };
    }

    if (result.status === 'unfunded') {
      return {
        ...base,
        status: 'unfunded',
      };
    }

    // A runtime/third-party lookup may return an unexpected status, including
    // an "unavailable" state. Unknown is NEVER equivalent to a Horizon 404.
    throw new Error('Testnet account lookup returned an unknown status');
  } catch (error) {
    const errorCode = readErrorCode(error);
    return {
      ...base,
      status: 'unavailable',
      ...(errorCode ? { errorCode } : {}),
      message: 'Testnet account state could not be determined.',
    };
  }
}
