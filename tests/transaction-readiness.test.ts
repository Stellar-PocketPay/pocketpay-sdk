/**
 * Tests for the transaction readiness check (issue #441).
 *
 * Horizon is replaced through the SDK's own factory seam
 * (`setHorizonServerFactory`), so every test runs offline and deterministically.
 * Each blocker code has at least one test that produces it on its own, plus the
 * ready cases for native XLM and an issued asset.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as StellarSDK from '@stellar/stellar-sdk';
import {
  checkTransactionReadiness,
  READINESS_CHECK_ORDER,
  setHorizonServerFactory,
  resetHorizonServerFactory,
  validatePocketPayConfig,
  type TransactionReadiness,
  type TransactionReadinessParams,
  type SDKConfig,
} from '../src';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const TESTNET: Partial<SDKConfig> = { network: 'testnet' };

const source = StellarSDK.Keypair.random();
const SOURCE = source.publicKey();
const DESTINATION = StellarSDK.Keypair.random().publicKey();
const ISSUER = StellarSDK.Keypair.random().publicKey();
const USDC = { code: 'USDC', issuer: ISSUER };

function nativeLine(balance: string, selling = '0.0000000') {
  return {
    asset_type: 'native',
    balance,
    buying_liabilities: '0.0000000',
    selling_liabilities: selling,
  };
}

function assetLine(
  code: string,
  issuer: string,
  balance: string,
  extra: Partial<{ limit: string; is_authorized: boolean; buying_liabilities: string; selling_liabilities: string }> = {},
) {
  return {
    asset_type: code.length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12',
    asset_code: code,
    asset_issuer: issuer,
    balance,
    limit: '922337203685.4775807',
    buying_liabilities: '0.0000000',
    selling_liabilities: '0.0000000',
    is_authorized: true,
    ...extra,
  };
}

function account(
  id: string,
  balances: unknown[],
  extra: Partial<{ subentry_count: number; num_sponsoring: number; num_sponsored: number; data_attr: Record<string, string> }> = {},
) {
  return {
    id,
    account_id: id,
    sequence: '123',
    subentry_count: 0,
    num_sponsoring: 0,
    num_sponsored: 0,
    data_attr: {},
    balances,
    ...extra,
  };
}

function notFound(): Error {
  const err = new Error('Not Found') as Error & { response: { status: number } };
  err.response = { status: 404 };
  return err;
}

// ─── Mock Horizon ───────────────────────────────────────────────────────────

const accounts = new Map<string, unknown>();
const loadAccount = vi.fn(async (id: string) => {
  const entry = accounts.get(id);
  if (entry instanceof Error) throw entry;
  if (entry === undefined) throw notFound();
  return entry;
});
const root = vi.fn(async () => ({ network_passphrase: StellarSDK.Networks.TESTNET }));
const submitTransaction = vi.fn();

beforeEach(() => {
  accounts.clear();
  loadAccount.mockClear();
  root.mockReset();
  root.mockImplementation(async () => ({ network_passphrase: StellarSDK.Networks.TESTNET }));
  submitTransaction.mockReset();
  setHorizonServerFactory(() => ({ loadAccount, root, submitTransaction }) as any);

  // Default world: funded source with 100 XLM, funded destination.
  accounts.set(SOURCE, account(SOURCE, [nativeLine('100.0000000')]));
  accounts.set(DESTINATION, account(DESTINATION, [nativeLine('5.0000000')]));
});

afterEach(() => {
  resetHorizonServerFactory();
});

function check(overrides: Partial<TransactionReadinessParams> = {}, config: Partial<SDKConfig> = TESTNET) {
  return checkTransactionReadiness(
    { sourceAccount: SOURCE, destination: DESTINATION, amount: '10', ...overrides },
    config,
  );
}

function codes(result: TransactionReadiness): string[] {
  return result.blockers.map((b) => b.code);
}

// ─── Ready cases ────────────────────────────────────────────────────────────

describe('checkTransactionReadiness — ready', () => {
  it('reports a native XLM payment as ready with every check passed', async () => {
    const result = await check({ memo: 'invoice #42' });

    expect(result.ready).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.warnings).toEqual([]);
    for (const name of READINESS_CHECK_ORDER) expect(result.checks[name]).toBe('passed');
    expect(result.network).toBe('testnet');
    expect(result.networkPassphrase).toBe(StellarSDK.Networks.TESTNET);
    expect(result.fee).toBe('100');
    expect(result.balance).toEqual({
      asset: { code: 'XLM' },
      amount: '10.0000000',
      fee: '0.0000100',
      nativeRequired: '10.0000100',
      nativeAvailable: '99.0000000',
      minimumBalance: '1.0000000',
    });
    expect(Number.isNaN(Date.parse(result.checkedAt))).toBe(false);
  });

  it('reports an issued-asset payment as ready when both trustlines allow it', async () => {
    accounts.set(SOURCE, account(SOURCE, [nativeLine('10.0000000'), assetLine('USDC', ISSUER, '50.0000000')], { subentry_count: 1 }));
    accounts.set(DESTINATION, account(DESTINATION, [nativeLine('5.0000000'), assetLine('USDC', ISSUER, '0.0000000', { limit: '1000.0000000' })]));

    const result = await check({ asset: USDC, amount: '25' });

    expect(result.ready).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.balance).toMatchObject({
      asset: USDC,
      nativeRequired: '0.0000100',
      nativeAvailable: '8.5000000',
      minimumBalance: '1.5000000',
      assetAvailable: '50.0000000',
    });
  });

  it('accepts a payment exactly at the spendable limit (amount + fee == available)', async () => {
    // 100 XLM, 1 XLM reserve → 99 spendable; 98.99999 + 0.00001 fee == 99.
    const result = await check({ amount: '98.9999900' });
    expect(result.ready).toBe(true);
  });

  it('lets the issuer send its own asset without a trustline', async () => {
    accounts.set(ISSUER, account(ISSUER, [nativeLine('20.0000000')]));
    accounts.set(DESTINATION, account(DESTINATION, [nativeLine('5.0000000'), assetLine('USDC', ISSUER, '0.0000000')]));

    const result = await check({ sourceAccount: ISSUER, asset: USDC, amount: '1000000' });

    expect(result.ready).toBe(true);
    expect(result.balance?.assetAvailable).toBeUndefined();
  });

  it('accepts a matching networkPassphrase and a matching Horizon passphrase', async () => {
    const result = await check({
      networkPassphrase: StellarSDK.Networks.TESTNET,
      verifyHorizonNetwork: true,
    });
    expect(result.ready).toBe(true);
    expect(root).toHaveBeenCalledTimes(1);
  });

  it('accepts a custom fee bid and reports it', async () => {
    const result = await check({ fee: '500' });
    expect(result.ready).toBe(true);
    expect(result.fee).toBe('500');
    expect(result.balance?.nativeRequired).toBe('10.0000500');
  });


  it('uses the validated config snapshot for Horizon construction', async () => {
    let validationReads = 0;
    const probeConfig = {} as Partial<SDKConfig>;
    Object.defineProperty(probeConfig, 'network', {
      enumerable: true,
      get() {
        validationReads += 1;
        return 'testnet';
      },
    });
    validatePocketPayConfig(probeConfig);

    let reads = 0;
    const changingConfig = {} as Partial<SDKConfig>;
    Object.defineProperty(changingConfig, 'network', {
      enumerable: true,
      get() {
        reads += 1;
        if (reads > validationReads) throw new Error('config read after validation');
        return 'testnet';
      },
    });

    const result = await check({}, changingConfig);

    expect(result.ready).toBe(true);
    expect(result.network).toBe('testnet');
    expect(reads).toBe(validationReads);
  });
});

// ─── Blockers: source ───────────────────────────────────────────────────────

describe('checkTransactionReadiness — source blockers', () => {
  it('SOURCE_INVALID for a malformed key, without echoing the input', async () => {
    const secret = source.secret();
    const result = await check({ sourceAccount: secret });

    expect(result.ready).toBe(false);
    expect(result.blockers[0]).toMatchObject({
      check: 'source',
      code: 'SOURCE_INVALID',
      field: 'sourceAccount',
      cause: 'INVALID_PUBLIC_KEY',
      retryable: false,
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('SOURCE_INVALID for a key with surrounding whitespace', async () => {
    const result = await check({ sourceAccount: ` ${SOURCE}` });
    expect(codes(result)).toContain('SOURCE_INVALID');
  });

  it('SOURCE_NOT_FOUND when Horizon returns 404 for the source', async () => {
    accounts.delete(SOURCE);
    const result = await check();

    expect(codes(result)).toEqual(['SOURCE_NOT_FOUND']);
    expect(result.checks.source).toBe('failed');
    expect(result.checks.balance).toBe('skipped');
  });

  it('SOURCE_LOOKUP_FAILED (retryable) when the source lookup errors', async () => {
    accounts.set(SOURCE, Object.assign(new Error('boom'), { code: 'NET_UNREACHABLE' }));
    const result = await check();

    expect(result.blockers).toEqual([
      expect.objectContaining({ code: 'SOURCE_LOOKUP_FAILED', cause: 'NET_UNREACHABLE', retryable: true }),
    ]);
  });

  it('SOURCE_LOOKUP_FAILED carries the SDK timeout code when the lookup times out', async () => {
    loadAccount.mockImplementationOnce(() => new Promise(() => {}));
    const result = await checkTransactionReadiness(
      { sourceAccount: SOURCE, destination: DESTINATION, amount: '10' },
      { network: 'testnet', timeout: 20 },
    );

    const blocker = result.blockers.find((b) => b.code === 'SOURCE_LOOKUP_FAILED');
    expect(blocker).toBeDefined();
    expect(blocker?.retryable).toBe(true);
    expect(blocker?.cause).toBe('REQUEST_TIMEOUT');
  });
});

// ─── Blockers: destination ──────────────────────────────────────────────────

describe('checkTransactionReadiness — destination blockers', () => {
  it('DESTINATION_INVALID for a malformed key', async () => {
    const result = await check({ destination: 'GNOTAKEY' });
    expect(result.blockers[0]).toMatchObject({ code: 'DESTINATION_INVALID', field: 'destination', cause: 'INVALID_PUBLIC_KEY' });
  });

  it('DESTINATION_MUXED_UNSUPPORTED for an M... address', async () => {
    const muxed = new StellarSDK.MuxedAccount(new StellarSDK.Account(DESTINATION, '0'), '42').accountId();
    const result = await check({ destination: muxed });

    expect(codes(result)).toEqual(['DESTINATION_MUXED_UNSUPPORTED']);
  });

  it('DESTINATION_SELF_PAYMENT when source and destination match', async () => {
    const result = await check({ destination: SOURCE });
    expect(result.blockers[0]).toMatchObject({ code: 'DESTINATION_SELF_PAYMENT', cause: 'SELF_PAYMENT' });
  });

  it('DESTINATION_NOT_FOUND when the destination does not exist', async () => {
    accounts.delete(DESTINATION);
    const result = await check();

    expect(codes(result)).toEqual(['DESTINATION_NOT_FOUND']);
    expect(result.checks.memo).toBe('skipped');
  });

  it('DESTINATION_LOOKUP_FAILED (retryable) when the destination lookup errors', async () => {
    accounts.set(DESTINATION, new Error('503'));
    const result = await check();

    expect(result.blockers).toEqual([
      expect.objectContaining({ code: 'DESTINATION_LOOKUP_FAILED', retryable: true }),
    ]);
  });
});

// ─── Blockers: amount ───────────────────────────────────────────────────────

describe('checkTransactionReadiness — amount blockers', () => {
  it.each(['0', '-5', 'abc', '', '1e3'])('AMOUNT_INVALID for %j', async (amount) => {
    const result = await check({ amount });
    expect(result.blockers[0]).toMatchObject({ check: 'amount', code: 'AMOUNT_INVALID', field: 'amount' });
    expect(result.checks.balance).toBe('skipped');
  });

  it('AMOUNT_PRECISION for more than 7 decimal places', async () => {
    const result = await check({ amount: '1.12345678' });
    expect(result.blockers[0]).toMatchObject({ code: 'AMOUNT_PRECISION', cause: 'INVALID_AMOUNT_PRECISION' });
  });

  it('AMOUNT_INVALID above the protocol maximum', async () => {
    const result = await check({ amount: '922337203686' });
    expect(result.blockers[0]).toMatchObject({ code: 'AMOUNT_INVALID', cause: 'PAYMENT_INVALID_AMOUNT' });
  });
});

// ─── Blockers: asset ────────────────────────────────────────────────────────

describe('checkTransactionReadiness — asset blockers', () => {
  it('ASSET_INVALID for an issued asset without an issuer', async () => {
    const result = await check({ asset: { code: 'USDC' } });
    expect(result.blockers[0]).toMatchObject({ code: 'ASSET_INVALID', cause: 'MISSING_ASSET_ISSUER' });
  });

  it('SOURCE_TRUSTLINE_MISSING when the source does not hold the asset', async () => {
    accounts.set(DESTINATION, account(DESTINATION, [nativeLine('5.0000000'), assetLine('USDC', ISSUER, '0.0000000')]));
    const result = await check({ asset: USDC });

    expect(codes(result)).toEqual(['SOURCE_TRUSTLINE_MISSING']);
    expect(result.checks.balance).toBe('skipped');
  });

  it('SOURCE_TRUSTLINE_NOT_AUTHORIZED when the source trustline is not authorized', async () => {
    accounts.set(SOURCE, account(SOURCE, [nativeLine('10.0000000'), assetLine('USDC', ISSUER, '50.0000000', { is_authorized: false })], { subentry_count: 1 }));
    accounts.set(DESTINATION, account(DESTINATION, [nativeLine('5.0000000'), assetLine('USDC', ISSUER, '0.0000000')]));

    const result = await check({ asset: USDC });
    expect(codes(result)).toEqual(['SOURCE_TRUSTLINE_NOT_AUTHORIZED']);
  });

  it('fails closed when Horizon trustline authorization is missing or non-boolean', async () => {
    accounts.set(
      SOURCE,
      account(SOURCE, [
        nativeLine('10.0000000'),
        assetLine('USDC', ISSUER, '50.0000000', { is_authorized: 'false' as unknown as boolean }),
      ], { subentry_count: 1 }),
    );
    accounts.set(
      DESTINATION,
      account(DESTINATION, [nativeLine('5.0000000'), assetLine('USDC', ISSUER, '0.0000000')]),
    );

    expect(codes(await check({ asset: USDC }))).toEqual(['SOURCE_TRUSTLINE_NOT_AUTHORIZED']);

    accounts.set(
      SOURCE,
      account(SOURCE, [
        nativeLine('10.0000000'),
        assetLine('USDC', ISSUER, '50.0000000'),
      ], { subentry_count: 1 }),
    );
    accounts.set(
      DESTINATION,
      account(DESTINATION, [
        nativeLine('5.0000000'),
        assetLine('USDC', ISSUER, '0.0000000', { is_authorized: undefined as unknown as boolean }),
      ]),
    );

    expect(codes(await check({ asset: USDC }))).toEqual(['DESTINATION_TRUSTLINE_NOT_AUTHORIZED']);
  });

  it('DESTINATION_TRUSTLINE_MISSING when the destination does not hold the asset', async () => {
    accounts.set(SOURCE, account(SOURCE, [nativeLine('10.0000000'), assetLine('USDC', ISSUER, '50.0000000')], { subentry_count: 1 }));
    const result = await check({ asset: USDC });

    expect(result.blockers).toEqual([
      expect.objectContaining({ code: 'DESTINATION_TRUSTLINE_MISSING', cause: 'MISSING_TRUSTLINE', field: 'destination' }),
    ]);
  });

  it('DESTINATION_TRUSTLINE_NOT_AUTHORIZED when the destination trustline is not authorized', async () => {
    accounts.set(SOURCE, account(SOURCE, [nativeLine('10.0000000'), assetLine('USDC', ISSUER, '50.0000000')], { subentry_count: 1 }));
    accounts.set(DESTINATION, account(DESTINATION, [nativeLine('5.0000000'), assetLine('USDC', ISSUER, '0.0000000', { is_authorized: false })]));

    const result = await check({ asset: USDC });
    expect(codes(result)).toEqual(['DESTINATION_TRUSTLINE_NOT_AUTHORIZED']);
  });

  it('DESTINATION_TRUSTLINE_LIMIT_EXCEEDED counts balance and buying liabilities against the limit', async () => {
    accounts.set(SOURCE, account(SOURCE, [nativeLine('10.0000000'), assetLine('USDC', ISSUER, '50.0000000')], { subentry_count: 1 }));
    accounts.set(
      DESTINATION,
      account(DESTINATION, [
        nativeLine('5.0000000'),
        assetLine('USDC', ISSUER, '80.0000000', { limit: '100.0000000', buying_liabilities: '5.0000000' }),
      ]),
    );

    // Capacity = 100 - 80 - 5 = 15.
    expect((await check({ asset: USDC, amount: '15' })).ready).toBe(true);
    const result = await check({ asset: USDC, amount: '15.0000001' });
    expect(result.blockers).toEqual([
      expect.objectContaining({ code: 'DESTINATION_TRUSTLINE_LIMIT_EXCEEDED', field: 'amount' }),
    ]);
    expect(result.blockers[0]?.message).toContain('15.0000000');
  });
});

// ─── Blockers: memo ─────────────────────────────────────────────────────────

describe('checkTransactionReadiness — memo blockers', () => {
  it('MEMO_INVALID for a text memo over 28 bytes', async () => {
    const result = await check({ memo: 'x'.repeat(29) });
    expect(result.blockers[0]).toMatchObject({ code: 'MEMO_INVALID', cause: 'TX_INVALID_MEMO', field: 'memo' });
  });

  it('MEMO_INVALID for a malformed typed memo', async () => {
    const result = await check({ memo: { type: 'hash', value: 'abc' } });
    expect(codes(result)).toEqual(['MEMO_INVALID']);
  });

  it('MEMO_REQUIRED when the destination sets SEP-29 config.memo_required and no memo is given', async () => {
    accounts.set(DESTINATION, account(DESTINATION, [nativeLine('5.0000000')], { data_attr: { 'config.memo_required': 'MQ==' } }));

    const result = await check();
    expect(codes(result)).toEqual(['MEMO_REQUIRED']);
    expect(result.checks.memo).toBe('failed');

    expect((await check({ memo: { type: 'none' } })).ready).toBe(false);
    expect((await check({ memo: { type: 'id', value: '12345' } })).ready).toBe(true);
  });
});

// ─── Blockers: network ──────────────────────────────────────────────────────

describe('checkTransactionReadiness — network blockers', () => {
  it('NETWORK_CONFIG_INVALID for an unsupported network, without calling Horizon', async () => {
    const result = await check({}, { network: 'devnet' as any });

    expect(result.blockers).toEqual([
      expect.objectContaining({ check: 'network', code: 'NETWORK_CONFIG_INVALID', cause: 'INVALID_NETWORK', field: 'config' }),
    ]);
    expect(result.network).toBeUndefined();
    expect(result.checks.source).toBe('skipped');
    expect(result.checks.destination).toBe('skipped');
    expect(result.checks.balance).toBe('skipped');
    expect(loadAccount).not.toHaveBeenCalled();
  });

  it('NETWORK_PASSPHRASE_MISMATCH when the signing passphrase is for another network', async () => {
    const result = await check({ networkPassphrase: StellarSDK.Networks.PUBLIC });
    expect(result.blockers).toEqual([
      expect.objectContaining({ code: 'NETWORK_PASSPHRASE_MISMATCH', field: 'networkPassphrase' }),
    ]);
  });

  it('NETWORK_PASSPHRASE_MISMATCH when Horizon reports a different network (opt-in)', async () => {
    root.mockImplementation(async () => ({ network_passphrase: StellarSDK.Networks.PUBLIC }));

    expect((await check()).ready).toBe(true);
    expect(root).not.toHaveBeenCalled();

    const result = await check({ verifyHorizonNetwork: true });
    expect(result.blockers).toEqual([
      expect.objectContaining({ code: 'NETWORK_PASSPHRASE_MISMATCH', field: 'config' }),
    ]);
  });

  it('NETWORK_LOOKUP_FAILED (retryable) when the Horizon root request fails', async () => {
    root.mockImplementation(async () => {
      throw new Error('down');
    });
    const result = await check({ verifyHorizonNetwork: true });
    expect(result.blockers).toEqual([
      expect.objectContaining({ code: 'NETWORK_LOOKUP_FAILED', retryable: true }),
    ]);
  });
  it('does not echo credentials from mismatched endpoint warnings', async () => {
    const credential = 'private-preview-password-441';
    const result = await check({}, {
      network: 'testnet',
      horizonUrl: `https://username:${credential}@horizon.stellar.org/secret/${credential}`,
    });

    expect(result.warnings).toEqual([
      expect.objectContaining({ code: 'NETWORK_ENDPOINT_MISMATCH', field: 'config' }),
    ]);
    expect(JSON.stringify(result)).not.toContain(credential);
  });

  it('does not echo invalid endpoint input from configuration blockers', async () => {
    const credential = 'private-url-token-441';
    const result = await check({}, {
      network: 'testnet',
      horizonUrl: `not-a-url-${credential}`,
    });

    expect(codes(result)).toContain('NETWORK_CONFIG_INVALID');
    expect(result.blockers).toContainEqual(expect.objectContaining({
      code: 'NETWORK_CONFIG_INVALID',
      cause: 'INVALID_HORIZON_URL',
    }));
    expect(JSON.stringify(result)).not.toContain(credential);
  });

});

// ─── Blockers: fee and balance ──────────────────────────────────────────────

describe('checkTransactionReadiness — fee and balance blockers', () => {
  it.each(['99', '1.5', 'abc', '4294967296'])('FEE_INVALID for fee %j', async (fee) => {
    const result = await check({ fee });
    expect(result.blockers[0]).toMatchObject({ check: 'fee', code: 'FEE_INVALID', field: 'fee' });
    expect(result.fee).toBeUndefined();
    expect(result.checks.balance).toBe('skipped');
  });

  it('INSUFFICIENT_BALANCE when amount + fee exceeds spendable XLM above the reserve', async () => {
    // 10 XLM, 2 subentries → 2 XLM reserve; 1 XLM selling liabilities → 7 spendable.
    accounts.set(SOURCE, account(SOURCE, [nativeLine('10.0000000', '1.0000000')], { subentry_count: 2 }));

    expect((await check({ amount: '6.9999900' })).ready).toBe(true);
    const result = await check({ amount: '7' });
    expect(result.blockers).toEqual([
      expect.objectContaining({ check: 'balance', code: 'INSUFFICIENT_BALANCE', field: 'amount' }),
    ]);
    expect(result.balance).toMatchObject({
      nativeAvailable: '7.0000000',
      nativeRequired: '7.0000100',
      minimumBalance: '2.0000000',
    });
  });

  it('counts sponsorships when computing the minimum reserve', async () => {
    // subentries 1 + sponsoring 2 - sponsored 1 → 2 entries → 2 XLM reserve.
    accounts.set(SOURCE, account(SOURCE, [nativeLine('10.0000000')], { subentry_count: 1, num_sponsoring: 2, num_sponsored: 1 }));
    const result = await check({ amount: '1' });
    expect(result.balance?.minimumBalance).toBe('2.0000000');
  });

  it('allows sponsorship to cover the account base reserves', async () => {
    // CAP-33 can sponsor both base reserves: 2 + 0 + 0 - 2 = 0 reserve units.
    accounts.set(
      SOURCE,
      account(SOURCE, [nativeLine('1.0000100')], {
        subentry_count: 0,
        num_sponsoring: 0,
        num_sponsored: 2,
      }),
    );

    const result = await check({ amount: '1' });

    expect(result.ready).toBe(true);
    expect(result.balance).toMatchObject({
      minimumBalance: '0.0000000',
      nativeAvailable: '1.0000100',
      nativeRequired: '1.0000100',
    });
  });

  it('INSUFFICIENT_BALANCE when the issued-asset balance (minus selling liabilities) is short', async () => {
    accounts.set(
      SOURCE,
      account(SOURCE, [nativeLine('10.0000000'), assetLine('USDC', ISSUER, '30.0000000', { selling_liabilities: '10.0000000' })], { subentry_count: 1 }),
    );
    accounts.set(DESTINATION, account(DESTINATION, [nativeLine('5.0000000'), assetLine('USDC', ISSUER, '0.0000000')]));

    const result = await check({ asset: USDC, amount: '25' });
    expect(codes(result)).toEqual(['INSUFFICIENT_BALANCE']);
    expect(result.balance?.assetAvailable).toBe('20.0000000');
  });

  it('INSUFFICIENT_FEE_BALANCE when an issued-asset payment cannot pay the XLM fee', async () => {
    // Exactly at the 1.5 XLM reserve: nothing spendable for the fee.
    accounts.set(SOURCE, account(SOURCE, [nativeLine('1.5000000'), assetLine('USDC', ISSUER, '50.0000000')], { subentry_count: 1 }));
    accounts.set(DESTINATION, account(DESTINATION, [nativeLine('5.0000000'), assetLine('USDC', ISSUER, '0.0000000')]));

    const result = await check({ asset: USDC, amount: '25' });
    expect(result.blockers).toEqual([
      expect.objectContaining({ code: 'INSUFFICIENT_FEE_BALANCE', field: 'fee' }),
    ]);
  });
});

// ─── Warnings ───────────────────────────────────────────────────────────────

describe('checkTransactionReadiness — warnings', () => {
  it('HIGH_FEE_RATIO when the fee exceeds 10% of a native amount; still ready', async () => {
    const result = await check({ amount: '0.0000500' });
    expect(result.ready).toBe(true);
    expect(result.warnings).toEqual([expect.objectContaining({ check: 'fee', code: 'HIGH_FEE_RATIO' })]);
  });

  it('DESTINATION_IS_ISSUER when paying an asset back to its issuer; still ready', async () => {
    accounts.set(SOURCE, account(SOURCE, [nativeLine('10.0000000'), assetLine('USDC', ISSUER, '50.0000000')], { subentry_count: 1 }));
    accounts.set(ISSUER, account(ISSUER, [nativeLine('20.0000000')]));

    const result = await check({ destination: ISSUER, asset: USDC });
    expect(result.ready).toBe(true);
    expect(result.warnings).toEqual([expect.objectContaining({ code: 'DESTINATION_IS_ISSUER' })]);
  });

  it('NETWORK_ENDPOINT_MISMATCH when the Horizon URL looks like another network', async () => {
    const result = await check({}, { network: 'testnet', horizonUrl: 'https://horizon.stellar.org' });
    expect(result.ready).toBe(true);
    expect(result.warnings).toEqual([expect.objectContaining({ check: 'network', code: 'NETWORK_ENDPOINT_MISMATCH' })]);
  });
});

// ─── Contract ───────────────────────────────────────────────────────────────

describe('checkTransactionReadiness — contract', () => {
  it('collects every blocker in check order instead of stopping at the first', async () => {
    const result = await check({
      destination: 'bad',
      amount: '0',
      asset: { code: 'USDC' },
      memo: 'x'.repeat(40),
      fee: '1',
    });

    expect(codes(result)).toEqual(['DESTINATION_INVALID', 'AMOUNT_INVALID', 'ASSET_INVALID', 'MEMO_INVALID', 'FEE_INVALID']);
    const order = result.blockers.map((b) => READINESS_CHECK_ORDER.indexOf(b.check));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(result.blockers.every((b) => b.retryable === false)).toBe(true);
  });

  it('never signs or submits', async () => {
    await check();
    await check({ asset: USDC });
    expect(submitTransaction).not.toHaveBeenCalled();
  });

  it('does not throw on missing params', async () => {
    const result = await checkTransactionReadiness(undefined as unknown as TransactionReadinessParams, TESTNET);
    expect(result.ready).toBe(false);
    expect(codes(result)).toEqual(['SOURCE_INVALID', 'DESTINATION_INVALID', 'AMOUNT_INVALID']);
  });

  it('ready is true only when there are no blockers and every check passed', async () => {
    const cases = [await check(), await check({ amount: '0' }), await check({}, { network: 'devnet' as any })];
    for (const result of cases) {
      const allPassed = READINESS_CHECK_ORDER.every((name) => result.checks[name] === 'passed');
      expect(result.ready).toBe(result.blockers.length === 0 && allPassed);
    }
  });
});

describe('checkTransactionReadiness — malformed Horizon numeric data (#441)', () => {
  it('fails closed instead of treating malformed reserve or liability fields as zero', async () => {
    accounts.set(
      SOURCE,
      {
        ...account(SOURCE, [nativeLine('100.0000000')]),
        subentry_count: 'not-a-number',
      } as any,
    );

    const malformedReserve = await check();
    expect(malformedReserve.ready).toBe(false);
    expect(malformedReserve.blockers).toContainEqual(
      expect.objectContaining({ code: 'SOURCE_LOOKUP_FAILED', retryable: true }),
    );
    expect(malformedReserve.checks.balance).toBe('skipped');

    accounts.set(
      SOURCE,
      account(
        SOURCE,
        [nativeLine('10.0000000'), assetLine('USDC', ISSUER, '50.0000000')],
        { subentry_count: 1 },
      ),
    );
    accounts.set(
      DESTINATION,
      account(DESTINATION, [
        nativeLine('5.0000000'),
        assetLine('USDC', ISSUER, '0.0000000', { buying_liabilities: 'not-a-number' }),
      ]),
    );

    const malformedLiabilities = await check({ asset: USDC });
    expect(malformedLiabilities.ready).toBe(false);
    expect(malformedLiabilities.blockers).toContainEqual(
      expect.objectContaining({ code: 'DESTINATION_LOOKUP_FAILED', retryable: true }),
    );
    expect(malformedLiabilities.checks.asset).toBe('skipped');
  });
});

describe('checkTransactionReadiness — shareable input and provider errors (#441)', () => {
  it('does not echo accidentally pasted credentials from amount, asset, or memo', async () => {
    const secret = source.secret();
    const candidates: Partial<TransactionReadinessParams>[] = [
      { amount: secret },
      { asset: { code: secret, issuer: ISSUER } },
      { memo: { type: 'hash', value: secret } as never },
    ];
    for (const candidate of candidates) {
      const result = await check(candidate);
      expect(result.ready).toBe(false);
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(result.blockers.some(({ check }) => ['amount', 'asset', 'memo'].includes(check))).toBe(true);
    }
  });

  it('keeps typed SDK causes but drops invented provider codes and throwing getters', async () => {
    const injected = Object.assign(new Error('provider contains a private credential'), {
      code: 'PRIVATE_PROVIDER_TOKEN',
    });
    accounts.set(SOURCE, injected);
    const untrusted = await check();
    const failed = untrusted.blockers.find((b) => b.code === 'SOURCE_LOOKUP_FAILED');
    expect(failed?.retryable).toBe(true);
    expect(failed?.cause).toBeUndefined();
    expect(JSON.stringify(untrusted)).not.toContain('PRIVATE_PROVIDER_TOKEN');

    const hostile = new Error('raw provider error');
    Object.defineProperty(hostile, 'response', {
      get() { throw new Error('sensitive Horizon response header'); },
    });
    Object.defineProperty(hostile, 'code', {
      get() { throw new Error('sensitive private code'); },
    });
    accounts.set(SOURCE, hostile);
    const safe = await check();
    expect(safe.ready).toBe(false);
    expect(safe.blockers).toEqual([
      expect.objectContaining({ code: 'SOURCE_LOOKUP_FAILED', retryable: true }),
    ]);
    expect(JSON.stringify(safe)).not.toContain('sensitive');
  });
});
