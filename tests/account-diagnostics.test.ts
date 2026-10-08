/**
 * Account diagnostics report tests (issue #444).
 *
 * Offline only: every case either injects the `lookup` seam or installs the
 * shared mock Horizon client, so no real network call is made.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as StellarSDK from '@stellar/stellar-sdk';
import {
  buildAccountDiagnosticsReport,
  resetDiagnosticsHooks,
  resetHorizonServerFactory,
  PocketPayError,
  DIAGNOSTICS_REDACTED_PLACEHOLDER,
  type AccountDiagnosticsLookup,
  type AssetBalance,
  type BalanceResult,
} from '../src';
import { installMockHorizon, type MockHorizonHandle } from './helpers/mockHorizon';
import { fundedAccount } from './fixtures';

const PUBLIC_KEY = fundedAccount.id;
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const TESTNET = { network: 'testnet' as const };

function funded(nativeBalance: string, trustlines = 0): BalanceResult {
  const balances: AssetBalance[] = [
    { asset: 'XLM', balance: nativeBalance, issuer: '' },
  ];
  for (let i = 0; i < trustlines; i += 1) {
    balances.push({ asset: `TK${i}`, balance: '1.0000000', issuer: USDC_ISSUER });
  }
  return {
    status: 'funded',
    publicKey: PUBLIC_KEY,
    balance: { publicKey: PUBLIC_KEY, balances, nativeBalance },
  };
}

function lookupReturning(result: BalanceResult) {
  return vi.fn<AccountDiagnosticsLookup>().mockResolvedValue(result);
}

function lookupRejecting(error: unknown) {
  return vi.fn<AccountDiagnosticsLookup>().mockRejectedValue(error);
}

/** HTTP-style error shaped like the one Horizon's client throws. */
function horizonError(status: number, message: string) {
  const err = new Error(message) as Error & { response?: { status: number } };
  err.response = { status };
  return err;
}

beforeEach(() => {
  resetDiagnosticsHooks();
});

describe('buildAccountDiagnosticsReport — healthy account', () => {
  it('reports a funded account as ready and keeps the base report sections', async () => {
    const lookup = lookupReturning(funded('100.0000000', 1));
    const report = await buildAccountDiagnosticsReport(PUBLIC_KEY, {
      config: TESTNET,
      lookup,
    });

    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith(PUBLIC_KEY, TESTNET);

    expect(report.account).toEqual({
      publicKey: PUBLIC_KEY,
      status: 'funded',
      nativeBalance: '100.0000000',
      assetCount: 2,
      estimatedMinimumBalance: '1.5000000',
    });
    expect(report.paymentReadiness).toEqual({
      status: 'ready',
      accountFunded: true,
      feeBalancePresent: true,
      networkConfigured: true,
      reasons: [],
    });

    // The account report extends the generic support report.
    expect(report.sdkName).toBe('stellar-pocketpay-sdk');
    expect(report.config.network).toBe('testnet');
    expect(report.network.passphraseKnown).toBe(true);
    expect(report.capabilities.length).toBeGreaterThan(0);
    expect(report.vault).toHaveProperty('ready');
  });

  it('keeps only endpoint origins in the shareable report', async () => {
    const lookup = lookupReturning(funded('100.0000000'));
    const report = await buildAccountDiagnosticsReport(PUBLIC_KEY, {
      config: {
        network: 'testnet',
        horizonUrl: 'https://horizon-testnet.stellar.org/private-support-path?tenant=example#local',
        sorobanRpcUrl: 'https://soroban-testnet.stellar.org/private-support-path?tenant=example#local',
      },
      lookup,
    });

    expect(report.config.horizonUrl).toBe('https://horizon-testnet.stellar.org');
    expect(report.network.horizonUrl).toBe('https://horizon-testnet.stellar.org');
    expect(report.config.sorobanRpcUrl).toBe('https://soroban-testnet.stellar.org');
    expect(report.network.sorobanRpcUrl).toBe('https://soroban-testnet.stellar.org');
    expect(JSON.stringify(report)).not.toContain('private-support-path');
    expect(JSON.stringify(report)).not.toContain('tenant=example');
  });

  it('never uses a different account\'s funded balance to declare payment readiness', async () => {
    const foreignKey = StellarSDK.Keypair.random().publicKey();
    const original = funded('100.0000000');
    if (original.status !== 'funded') throw new Error('Expected funded fixture');

    const mismatches: BalanceResult[] = [
      { ...original, publicKey: foreignKey },
      { ...original, balance: { ...original.balance, publicKey: foreignKey } },
    ];
    for (const mismatched of mismatches) {
      const report = await buildAccountDiagnosticsReport(PUBLIC_KEY, {
        config: TESTNET,
        lookup: lookupReturning(mismatched),
      });
      expect(report.account).toMatchObject({
        publicKey: PUBLIC_KEY,
        status: 'error',
        errorCode: 'ACCOUNT_DIAGNOSTICS_ERROR',
        errorMessage: 'Account state could not be loaded.',
      });
      expect(report.paymentReadiness.status).toBe('unknown');
      expect(report.paymentReadiness.feeBalancePresent).toBe(false);
      expect(JSON.stringify(report)).not.toContain(foreignKey);
    }
  });

  it('cannot report a different account\'s unfunded state as the queried wallet', async () => {
    const foreignKey = StellarSDK.Keypair.random().publicKey();
    const report = await buildAccountDiagnosticsReport(PUBLIC_KEY, {
      config: TESTNET,
      lookup: lookupReturning({ status: 'unfunded', publicKey: foreignKey }),
    });
    expect(report.account.status).toBe('error');
    expect(report.account.errorCode).toBe('ACCOUNT_DIAGNOSTICS_ERROR');
    expect(report.paymentReadiness.status).toBe('unknown');
    expect(JSON.stringify(report)).not.toContain(foreignKey);
  });

  it('reads Horizon through the config factory seam when no lookup is injected', async () => {
    const horizon: MockHorizonHandle = installMockHorizon();
    try {
      horizon.loadAccount.mockResolvedValue(fundedAccount);

      const report = await buildAccountDiagnosticsReport(PUBLIC_KEY, {
        config: TESTNET,
      });

      expect(horizon.loadAccount).toHaveBeenCalledWith(PUBLIC_KEY);
      expect(report.account.status).toBe('funded');
      expect(report.account.nativeBalance).toBe('1000.0000000');
      expect(report.account.assetCount).toBe(2);
      expect(report.account.estimatedMinimumBalance).toBe('1.5000000');
      expect(report.paymentReadiness.status).toBe('ready');
    } finally {
      resetHorizonServerFactory();
    }
  });

  it('is deterministic for the same clock and account state', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-02T03:04:05.000Z'));
    try {
      const lookup = lookupReturning(funded('25.0000000'));
      const first = await buildAccountDiagnosticsReport(PUBLIC_KEY, { config: TESTNET, lookup });
      const second = await buildAccountDiagnosticsReport(PUBLIC_KEY, { config: TESTNET, lookup });

      expect(first.generatedAt).toBe('2026-01-02T03:04:05.000Z');
      expect(second).toEqual(first);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('buildAccountDiagnosticsReport — unfunded account', () => {
  afterEach(() => {
    resetHorizonServerFactory();
  });

  it('maps a Horizon 404 to an unfunded, not-ready account', async () => {
    const horizon = installMockHorizon();
    horizon.loadAccount.mockRejectedValue(horizonError(404, 'Not Found'));

    const report = await buildAccountDiagnosticsReport(PUBLIC_KEY, { config: TESTNET });

    expect(report.account).toEqual({ publicKey: PUBLIC_KEY, status: 'unfunded' });
    expect(report.paymentReadiness).toEqual({
      status: 'not_ready',
      accountFunded: false,
      feeBalancePresent: false,
      networkConfigured: true,
      reasons: ['ACCOUNT_UNFUNDED'],
    });
  });

  it('accepts an unfunded BalanceResult from an injected lookup', async () => {
    const lookup = lookupReturning({ status: 'unfunded', publicKey: PUBLIC_KEY });
    const report = await buildAccountDiagnosticsReport(PUBLIC_KEY, { config: TESTNET, lookup });

    expect(report.account.status).toBe('unfunded');
    expect(report.paymentReadiness.reasons).toEqual(['ACCOUNT_UNFUNDED']);
  });

  it('treats ACCOUNT_NOT_FOUND from an injected lookup as unfunded, not as an error', async () => {
    const lookup = lookupRejecting(
      new PocketPayError('Account not found', 'ACCOUNT_NOT_FOUND', 404),
    );
    const report = await buildAccountDiagnosticsReport(PUBLIC_KEY, { config: TESTNET, lookup });

    expect(report.account).toEqual({ publicKey: PUBLIC_KEY, status: 'unfunded' });
    expect(report.paymentReadiness.status).toBe('not_ready');
  });
});

describe('buildAccountDiagnosticsReport — fee balance above reserve', () => {
  it.each([
    // [native balance, trustlines, expected feeBalancePresent]
    ['1.0000000', 0, false], // exactly the 1 XLM minimum: nothing left for fees
    ['1.0000099', 0, false], // 99 stroops above the minimum: below one base fee
    ['1.0000100', 0, true], //  exactly one base fee above the minimum
    ['1.5000000', 1, false], // one trustline raises the minimum to 1.5 XLM
    ['2.0000000', 1, true],
    ['0', 0, false],
  ])('native %s with %i trustline(s) -> feeBalancePresent=%s', async (native, trustlines, expected) => {
    const lookup = lookupReturning(funded(native, trustlines));
    const report = await buildAccountDiagnosticsReport(PUBLIC_KEY, { config: TESTNET, lookup });

    expect(report.account.status).toBe('funded');
    expect(report.paymentReadiness.feeBalancePresent).toBe(expected);
    expect(report.paymentReadiness.status).toBe(expected ? 'ready' : 'not_ready');
    expect(report.paymentReadiness.reasons).toEqual(expected ? [] : ['NO_NATIVE_XLM_FOR_FEES']);
  });

  it('does not report fee readiness for a malformed native balance', async () => {
    const lookup = lookupReturning(funded('not-a-number'));
    const report = await buildAccountDiagnosticsReport(PUBLIC_KEY, { config: TESTNET, lookup });

    expect(report.paymentReadiness.feeBalancePresent).toBe(false);
    expect(report.paymentReadiness.reasons).toEqual(['NO_NATIVE_XLM_FOR_FEES']);
  });
});

describe('buildAccountDiagnosticsReport — failing lookups', () => {
  afterEach(() => {
    resetHorizonServerFactory();
  });

  it('reports a Horizon 5xx as an error without forwarding the provider message', async () => {
    const secret = StellarSDK.Keypair.random().secret();
    const horizon = installMockHorizon();
    horizon.loadAccount.mockRejectedValue(
      horizonError(503, `upstream https://internal.example/accounts?key=${secret} failed`),
    );

    const report = await buildAccountDiagnosticsReport(PUBLIC_KEY, { config: TESTNET });

    expect(report.account).toEqual({
      publicKey: PUBLIC_KEY,
      status: 'error',
      errorCode: 'ACCOUNT_DIAGNOSTICS_ERROR',
      errorMessage: 'Account state could not be loaded.',
      errorHttpStatus: 503,
    });
    expect(report.paymentReadiness).toEqual({
      status: 'unknown',
      accountFunded: false,
      feeBalancePresent: false,
      networkConfigured: true,
      reasons: ['ACCOUNT_STATE_UNAVAILABLE'],
    });

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('internal.example');
  });

  it('keeps a stable SDK error code such as a lookup timeout', async () => {
    const lookup = lookupRejecting(
      new PocketPayError('Horizon account lookup timed out after 10ms', 'REQUEST_TIMEOUT'),
    );
    const report = await buildAccountDiagnosticsReport(PUBLIC_KEY, { config: TESTNET, lookup });

    expect(report.account.status).toBe('error');
    expect(report.account.errorCode).toBe('REQUEST_TIMEOUT');
    expect(report.account.errorMessage).toBe('Account state could not be loaded.');
    expect(report.account).not.toHaveProperty('errorHttpStatus');
    expect(report.paymentReadiness.status).toBe('unknown');
  });

  it('drops an error code that does not look like an identifier', async () => {
    const secret = StellarSDK.Keypair.random().secret();
    const lookup = lookupRejecting({ code: `leaked ${secret} in code` });
    const report = await buildAccountDiagnosticsReport(PUBLIC_KEY, { config: TESTNET, lookup });

    expect(report.account.errorCode).toBe('ACCOUNT_DIAGNOSTICS_ERROR');
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it('does not forward unknown identifier-shaped provider codes', async () => {
    const providerToken = 'ghp_123456789012345678901234567890123456';
    const lookup = lookupRejecting({ code: providerToken });

    const report = await buildAccountDiagnosticsReport(PUBLIC_KEY, { config: TESTNET, lookup });

    expect(report.account.errorCode).toBe('ACCOUNT_DIAGNOSTICS_ERROR');
    expect(JSON.stringify(report)).not.toContain(providerToken);
  });

  it('keeps support reports safe when provider error accessors throw', async () => {
    const secret = StellarSDK.Keypair.random().secret();
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, 'code', {
      get() { throw new Error(`provider code exposed ${secret}`); },
    });
    Object.defineProperty(hostile, 'statusCode', {
      get() { throw new Error(`provider status exposed ${secret}`); },
    });
    const lookup = lookupRejecting(hostile);
    const report = await buildAccountDiagnosticsReport(PUBLIC_KEY, { config: TESTNET, lookup });

    expect(lookup).toHaveBeenCalledTimes(1);
    expect(report.account).toMatchObject({
      status: 'error',
      errorCode: 'ACCOUNT_DIAGNOSTICS_ERROR',
      errorMessage: 'Account state could not be loaded.',
    });
    expect(report.account).not.toHaveProperty('errorHttpStatus');
    expect(report.paymentReadiness.status).toBe('unknown');
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it('still recognizes HTTP 404 when a provider error-code getter throws', async () => {
    const hostile = { statusCode: 404 };
    Object.defineProperty(hostile, 'code', {
      get() { throw new Error('untrusted code accessor'); },
    });
    const report = await buildAccountDiagnosticsReport(PUBLIC_KEY, {
      config: TESTNET,
      lookup: lookupRejecting(hostile),
    });
    expect(report.account.status).toBe('unfunded');
    expect(report.paymentReadiness.reasons).toContain('ACCOUNT_UNFUNDED');
  });

  it('handles non-Error rejections', async () => {
    const lookup = lookupRejecting('socket hang up');
    const report = await buildAccountDiagnosticsReport(PUBLIC_KEY, { config: TESTNET, lookup });

    expect(report.account.errorCode).toBe('ACCOUNT_DIAGNOSTICS_ERROR');
    expect(JSON.stringify(report)).not.toContain('socket hang up');
  });
});

describe('buildAccountDiagnosticsReport — invalid input never leaks', () => {
  it('rejects a secret key passed as the account id without echoing or looking it up', async () => {
    const secret = StellarSDK.Keypair.random().secret();
    const lookup = lookupReturning(funded('100'));

    const report = await buildAccountDiagnosticsReport(secret, { config: TESTNET, lookup });

    expect(lookup).not.toHaveBeenCalled();
    expect(report.account).toEqual({
      publicKey: DIAGNOSTICS_REDACTED_PLACEHOLDER,
      status: 'error',
      errorCode: 'INVALID_PUBLIC_KEY',
      errorMessage: 'The supplied account id is not a valid Stellar public key (G...).',
    });
    expect(report.paymentReadiness).toEqual({
      status: 'not_ready',
      accountFunded: false,
      feeBalancePresent: false,
      networkConfigured: true,
      reasons: ['INVALID_PUBLIC_KEY'],
    });
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it.each([
    ['a seed phrase', 'abandon ability able about above absent absorb abstract absurd abuse access accident'],
    ['a truncated public key', PUBLIC_KEY.slice(0, 40)],
    ['a checksum-broken public key', `${PUBLIC_KEY.slice(0, 55)}A`],
    ['an empty string', ''],
  ])('does not echo %s', async (_label, input) => {
    const lookup = lookupReturning(funded('100'));
    const report = await buildAccountDiagnosticsReport(input, { config: TESTNET, lookup });

    expect(lookup).not.toHaveBeenCalled();
    expect(report.account.publicKey).toBe(DIAGNOSTICS_REDACTED_PLACEHOLDER);
    expect(report.account.errorCode).toBe('INVALID_PUBLIC_KEY');
    if (input.length > 0) {
      expect(JSON.stringify(report)).not.toContain(input);
    }
  });

  it('trims surrounding whitespace from a valid public key', async () => {
    const lookup = lookupReturning(funded('100'));
    const report = await buildAccountDiagnosticsReport(`  ${PUBLIC_KEY}\n`, { config: TESTNET, lookup });

    expect(lookup).toHaveBeenCalledWith(PUBLIC_KEY, TESTNET);
    expect(report.account.publicKey).toBe(PUBLIC_KEY);
  });

  it('still throws for invalid configuration overrides, like buildDiagnosticsReport', async () => {
    const lookup = lookupReturning(funded('100'));
    await expect(
      buildAccountDiagnosticsReport(PUBLIC_KEY, {
        config: { horizonUrl: 'not a url' },
        lookup,
      }),
    ).rejects.toThrow();
    expect(lookup).not.toHaveBeenCalled();
  });
});
