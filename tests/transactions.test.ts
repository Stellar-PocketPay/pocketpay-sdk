/**
 * Tests for getTransactions and getPayments — mocked Horizon responses.
 *
 * Verifies that raw Horizon records are mapped into the SDK's typed
 * TransactionSummary / PaymentSummary models, including pagingToken and the
 * list-level nextCursor. No real network calls are made; the Horizon server's
 * transaction/payment query builders are stubbed via vi.mock.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getTransactions, getPayments, createWallet, PocketPayError } from '../src';
import { mapTransactionToSummary } from '../src/transactions';

// ─── Mock @stellar/stellar-sdk ───────────────────────────────────────────────
// Stub Horizon.Server so the transaction/payment builder chain is controllable
// offline. Keypair, Networks, etc. remain real via importActual, so
// createWallet() still produces valid keys.
const mockTxCall = vi.fn();
const mockPayCall = vi.fn();

function makeChain(callFn: ReturnType<typeof vi.fn>) {
  const chain: any = {
    forAccount: () => chain,
    limit: () => chain,
    order: () => chain,
    call: callFn,
  };
  return chain;
}

vi.mock('@stellar/stellar-sdk', async (importActual) => {
  const actual = await importActual<typeof import('@stellar/stellar-sdk')>();
  return {
    ...actual,
    Horizon: {
      ...actual.Horizon,
      Server: vi.fn().mockImplementation(() => ({
        transactions: () => makeChain(mockTxCall),
        payments: () => makeChain(mockPayCall),
      })),
    },
  };
});

// ─── Horizon response fixtures ───────────────────────────────────────────────

function makeHorizonTxPage() {
  return {
    records: [
      {
        hash: 'txhash1',
        ledger: 5000000,
        created_at: '2024-01-15T10:30:00Z',
        source_account: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
        fee_charged: '100',
        operation_count: 1,
        successful: true,
        memo: 'hello',
        memo_type: 'text',
        paging_token: '123456789',
      },
      {
        hash: 'txhash2',
        ledger: 5000001,
        created_at: '2024-01-15T11:00:00Z',
        source_account: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
        fee_charged: '100',
        operation_count: 2,
        successful: true,
        memo_type: 'none',
        paging_token: '123456790',
      },
    ],
  };
}

function makeHorizonPaymentPage() {
  return {
    records: [
      {
        id: 'op1',
        transaction_hash: 'txhash1',
        type: 'payment',
        created_at: '2024-01-15T10:30:00Z',
        from: 'GSENDER00000000000000000000000000000000000000000000000000',
        to: 'GRECEIVER0000000000000000000000000000000000000000000000000',
        amount: '10.5000000',
        asset_type: 'native',
        paging_token: '987654321',
      },
      {
        id: 'op2',
        transaction_hash: 'txhash2',
        type: 'create_account',
        created_at: '2024-01-15T11:00:00Z',
        funder: 'GFUNDER00000000000000000000000000000000000000000000000000',
        account: 'GNEWACCT00000000000000000000000000000000000000000000000000',
        starting_balance: '5.0000000',
        asset_type: 'native',
        paging_token: '987654322',
      },
      {
        // non-payment op type — should be filtered out
        id: 'op3',
        transaction_hash: 'txhash3',
        type: 'manage_data',
        created_at: '2024-01-15T11:30:00Z',
        paging_token: '987654323',
      },
    ],
  };
}

function makeHorizon404Error() {
  const err = new Error('not found') as any;
  err.response = { status: 404 };
  return err;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Transactions Module - getTransactions', () => {
  const account = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';

  beforeEach(() => {
    mockTxCall.mockReset();
  });

  it('maps Horizon records to TransactionSummary fields', async () => {
    mockTxCall.mockResolvedValue(makeHorizonTxPage());
    const result = await getTransactions(account);
    expect(result.count).toBe(2);
    const first = result.records[0];
    expect(first).toEqual({
      hash: 'txhash1',
      ledger: 5000000,
      createdAt: '2024-01-15T10:30:00Z',
      sourceAccount: account,
      fee: '100',
      operationCount: 1,
      successful: true,
      memo: 'hello',
      memoType: 'text',
      pagingToken: '123456789',
    });
  });

  it('maps a missing memo to undefined', async () => {
    mockTxCall.mockResolvedValue(makeHorizonTxPage());
    const result = await getTransactions(account);
    expect(result.records[1].memo).toBeUndefined();
  });

  it('safe-formats Horizon text memos and preserves their type across history mappers', async () => {
    const page = makeHorizonTxPage();
    page.records[0].memo = 'line1\nline2\u202e';
    mockTxCall.mockResolvedValue(page);

    const history = await getTransactions(account);
    expect(history.records[0]).toMatchObject({
      memo: 'line1\\nline2\\u202e',
      memoType: 'text',
    });

    const summary = mapTransactionToSummary(
      {
        id: 'tx-id',
        paging_token: '123',
        tx_hash: 'txhash',
        created_at: '2024-01-15T10:30:00Z',
        source_account: account,
        fee_account: account,
        fee_charged: '100',
        memo_type: 'text',
        memo: 'line1\nline2\u202e',
        successful: true,
        operations: [],
      },
      { userAccount: account },
    );

    expect(summary).toMatchObject({
      memo: 'line1\\nline2\\u202e',
      memoType: 'text',
    });
  });

  it('normalizes Horizon hash and return memos to canonical hex across history mappers', async () => {
    const binaryMemo = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
    const horizonMemo = binaryMemo.toString('base64');
    const canonicalHex = binaryMemo.toString('hex');

    const page = makeHorizonTxPage();
    page.records[0].memo_type = 'hash';
    page.records[0].memo = horizonMemo;
    mockTxCall.mockResolvedValue(page);

    const history = await getTransactions(account);
    expect(history.records[0]).toMatchObject({
      memo: canonicalHex,
      memoType: 'hash',
    });

    const summary = mapTransactionToSummary(
      {
        id: 'tx-id',
        paging_token: '123',
        tx_hash: 'txhash',
        created_at: '2024-01-15T10:30:00Z',
        source_account: account,
        fee_account: account,
        fee_charged: '100',
        memo_type: 'return',
        memo: horizonMemo,
        successful: true,
        operations: [],
      },
      { userAccount: account },
    );

    expect(summary).toMatchObject({
      memo: canonicalHex,
      memoType: 'return',
    });
  });

  it('sets nextCursor to the last record paging token', async () => {
    mockTxCall.mockResolvedValue(makeHorizonTxPage());
    const result = await getTransactions(account);
    expect(result.nextCursor).toBe('123456790');
  });

  it('sets nextCursor undefined for an empty page', async () => {
    mockTxCall.mockResolvedValue({ records: [] });
    const result = await getTransactions(account);
    expect(result.count).toBe(0);
    expect(result.nextCursor).toBeUndefined();
  });

  it('rejects an invalid public key before any network call', async () => {
    await expect(getTransactions('BADKEY')).rejects.toThrow(PocketPayError);
    expect(mockTxCall).not.toHaveBeenCalled();
  });

  it('maps a Horizon 404 to ACCOUNT_NOT_FOUND', async () => {
    mockTxCall.mockRejectedValue(makeHorizon404Error());
    await expect(getTransactions(account)).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
  });

  it('maps a slow Horizon transactions request to REQUEST_TIMEOUT', async () => {
    mockTxCall.mockReturnValue(new Promise(() => undefined));

    await expect(getTransactions(account, { limit: 10 }, { timeout: 5 })).rejects.toMatchObject({
      code: 'REQUEST_TIMEOUT',
      message: 'Horizon transactions request timed out after 5ms',
    });
  });
});

describe('Transactions Module - getPayments', () => {
  const account = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';

  beforeEach(() => {
    mockPayCall.mockReset();
  });

  it('maps Horizon payment records to PaymentSummary fields', async () => {
    mockPayCall.mockResolvedValue(makeHorizonPaymentPage());
    const result = await getPayments(account);
    const first = result.records[0];
    expect(first).toEqual({
      id: 'op1',
      transactionHash: 'txhash1',
      type: 'payment',
      createdAt: '2024-01-15T10:30:00Z',
      from: 'GSENDER00000000000000000000000000000000000000000000000000',
      to: 'GRECEIVER0000000000000000000000000000000000000000000000000',
      amount: '10.5000000',
      asset: 'XLM',
      assetIssuer: '',
      pagingToken: '987654321',
    });
  });

  it('maps create_account funder/account/starting_balance correctly', async () => {
    mockPayCall.mockResolvedValue(makeHorizonPaymentPage());
    const result = await getPayments(account);
    const second = result.records[1];
    expect(second.type).toBe('create_account');
    expect(second.from).toBe('GFUNDER00000000000000000000000000000000000000000000000000');
    expect(second.to).toBe('GNEWACCT00000000000000000000000000000000000000000000000000');
    expect(second.amount).toBe('5.0000000');
  });

  it('filters out non-payment operation types', async () => {
    mockPayCall.mockResolvedValue(makeHorizonPaymentPage());
    const result = await getPayments(account);
    // 3 records in, manage_data filtered out → 2 records
    expect(result.count).toBe(2);
    expect(result.records.every(r => r.type !== 'manage_data')).toBe(true);
  });

  it('sets nextCursor to the last mapped record paging token', async () => {
    mockPayCall.mockResolvedValue(makeHorizonPaymentPage());
    const result = await getPayments(account);
    expect(result.nextCursor).toBe('987654322');
  });

  it('rejects an invalid public key before any network call', async () => {
    await expect(getPayments('BADKEY')).rejects.toThrow(PocketPayError);
    expect(mockPayCall).not.toHaveBeenCalled();
  });

  it('maps a Horizon 404 to ACCOUNT_NOT_FOUND', async () => {
    mockPayCall.mockRejectedValue(makeHorizon404Error());
    await expect(getPayments(account)).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
  });

  it('maps a slow Horizon payments request to REQUEST_TIMEOUT', async () => {
    mockPayCall.mockReturnValue(new Promise(() => undefined));

    await expect(getPayments(account, { limit: 10 }, { timeout: 5 })).rejects.toMatchObject({
      code: 'REQUEST_TIMEOUT',
      message: 'Horizon payments request timed out after 5ms',
    });
  });
});
