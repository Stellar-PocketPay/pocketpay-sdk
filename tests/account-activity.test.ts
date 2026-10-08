import { describe, expect, it } from 'vitest';
import {
  TransactionDirection,
  TransactionStatus,
  filterAccountActivity,
  mapPaymentReceiptToActivity,
  mapPaymentSummaryToActivity,
  mapTransactionSummaryToActivity,
  mapVaultResultToActivity,
  normalizeAccountActivity,
} from '../src';
import type {
  PaymentReceipt,
  PaymentSummary,
  TransactionSummary,
  VaultMappedResult,
} from '../src';

const ACCOUNT = 'GACCOUNT';
const OTHER = 'GOTHER';

const sentPayment: PaymentSummary = {
  id: 'op-1',
  transactionHash: 'tx-1',
  type: 'payment',
  createdAt: '2026-10-05T12:00:00.000Z',
  from: ACCOUNT,
  to: OTHER,
  amount: '12.5',
  asset: 'USDC',
  assetIssuer: 'GISSUER',
  pagingToken: '100',
};

describe('account activity normalization', () => {
  it('maps sent and received Horizon payments relative to the displayed account', () => {
    const sent = mapPaymentSummaryToActivity(sentPayment, ACCOUNT);
    const received = mapPaymentSummaryToActivity(
      { ...sentPayment, id: 'op-2', from: OTHER, to: ACCOUNT },
      ACCOUNT,
    );

    expect(sent.direction).toBe(TransactionDirection.OUTGOING);
    expect(sent.counterparty).toBe(OTHER);
    expect(sent.status).toBe(TransactionStatus.COMPLETED);
    expect(received.direction).toBe(TransactionDirection.INCOMING);
    expect(received.counterparty).toBe(OTHER);
  });

  it('preserves failed and unknown transaction states', () => {
    const failed: TransactionSummary = {
      hash: 'failed-tx',
      createdAt: '2026-10-05T11:00:00.000Z',
      sourceAccount: ACCOUNT,
      successful: false,
    };
    const unknown: TransactionSummary = {
      hash: 'unknown-tx',
      createdAt: '2026-10-05T10:00:00.000Z',
    };

    expect(mapTransactionSummaryToActivity(failed, ACCOUNT).status)
      .toBe(TransactionStatus.FAILED);
    expect(mapTransactionSummaryToActivity(unknown, ACCOUNT).status)
      .toBe(TransactionStatus.UNKNOWN);
  });

  it('does not infer an incoming transaction from another source account alone', () => {
    const unrelated: TransactionSummary = {
      hash: 'unrelated-tx',
      createdAt: '2026-10-05T11:30:00.000Z',
      sourceAccount: OTHER,
      successful: true,
    };

    expect(mapTransactionSummaryToActivity(unrelated, ACCOUNT).direction)
      .toBe('neutral');
    expect(mapTransactionSummaryToActivity({
      ...unrelated,
      direction: TransactionDirection.INCOMING,
    }, ACCOUNT).direction).toBe(TransactionDirection.INCOMING);
    expect(mapTransactionSummaryToActivity({
      ...unrelated,
      sourceAccount: ACCOUNT,
    }, ACCOUNT).direction).toBe(TransactionDirection.OUTGOING);
  });

  it('preserves pending/unknown receipt states instead of treating them as failures', () => {
    const pending: PaymentReceipt = {
      status: TransactionStatus.PENDING,
      source: 'submission',
      actionRequired: 'retry',
      createdAt: '2026-10-05T13:00:00.000Z',
      transactionHash: 'pending-tx',
      amount: '2',
      asset: 'XLM',
      destination: OTHER,
    };
    const unknown: PaymentReceipt = {
      ...pending,
      status: TransactionStatus.UNKNOWN,
      actionRequired: 'poll',
      transactionHash: 'unknown-tx',
    };

    expect(mapPaymentReceiptToActivity(pending, ACCOUNT).status)
      .toBe(TransactionStatus.PENDING);
    expect(mapPaymentReceiptToActivity(unknown, ACCOUNT).status)
      .toBe(TransactionStatus.UNKNOWN);
  });

  it('maps vault direction/status without inventing a timestamp', () => {
    const deposit: VaultMappedResult = {
      success: true,
      status: 'success',
      operation: 'deposit',
      hash: 'vault-deposit',
      amount: '3',
    };
    const balance: VaultMappedResult = {
      success: true,
      status: 'success',
      operation: 'get_balance',
      balance: '9',
    };

    const depositActivity = mapVaultResultToActivity({
      result: deposit,
      createdAt: '2026-10-05T14:00:00.000Z',
    });
    const balanceActivity = mapVaultResultToActivity({
      result: balance,
      createdAt: '2026-10-05T14:01:00.000Z',
    });

    expect(depositActivity.direction).toBe(TransactionDirection.OUTGOING);
    expect(depositActivity.status).toBe(TransactionStatus.COMPLETED);
    expect(balanceActivity.direction).toBe('neutral');
    expect(balanceActivity.amount).toBe('9');
  });

  it('gives hashless vault records stable IDs that include observation time', () => {
    const result: VaultMappedResult = {
      success: false,
      status: 'pending',
      operation: 'deposit',
      amount: '1',
    };

    const first = mapVaultResultToActivity({
      result,
      createdAt: '2026-10-05T14:00:00.000Z',
    });
    const second = mapVaultResultToActivity({
      result,
      createdAt: '2026-10-05T14:01:00.000Z',
    });

    expect(first.id).toBe('vault:deposit:2026-10-05T14:00:00.000Z');
    expect(second.id).toBe('vault:deposit:2026-10-05T14:01:00.000Z');
    expect(first.id).not.toBe(second.id);
  });

  it('combines deterministic fixtures into reverse chronological history', () => {
    const records = normalizeAccountActivity({
      account: ACCOUNT,
      payments: [sentPayment],
      transactions: [{
        hash: 'tx-old',
        createdAt: '2026-10-05T09:00:00.000Z',
        sourceAccount: OTHER,
        successful: true,
      }],
      receipts: [{
        status: TransactionStatus.PENDING,
        source: 'submission',
        actionRequired: 'retry',
        createdAt: '2026-10-05T15:00:00.000Z',
        transactionHash: 'tx-new',
        destination: OTHER,
      }],
    });

    expect(records.map((record) => record.transactionHash))
      .toEqual(['tx-new', 'tx-1', 'tx-old']);
  });

  it('keeps valid timestamps chronological when invalid timestamps are present', () => {
    const records = normalizeAccountActivity({
      account: ACCOUNT,
      transactions: [
        {
          hash: 'tx-old',
          createdAt: '2026-10-05T09:00:00.000Z',
          successful: true,
        },
        {
          hash: 'tx-invalid',
          createdAt: 'not-a-date',
          successful: true,
        },
        {
          hash: 'tx-new',
          createdAt: '2026-10-05T15:00:00.000Z',
          successful: true,
        },
      ],
    });

    expect(records.map((record) => record.transactionHash))
      .toEqual(['tx-new', 'tx-old', 'tx-invalid']);
  });

  it('filters normalized history by status/kind/direction/asset', () => {
    const records = normalizeAccountActivity({
      account: ACCOUNT,
      payments: [sentPayment],
      receipts: [{
        status: TransactionStatus.PENDING,
        source: 'submission',
        actionRequired: 'retry',
        createdAt: '2026-10-05T15:00:00.000Z',
        transactionHash: 'pending',
        amount: '1',
        asset: 'XLM',
        destination: OTHER,
      }],
    });

    expect(filterAccountActivity(records, {
      kind: 'payment',
      status: TransactionStatus.PENDING,
      direction: TransactionDirection.OUTGOING,
      asset: 'XLM',
    }).map((record) => record.transactionHash)).toEqual(['pending']);
  });
  it('gives simultaneous hashless receipts different private stable IDs', () => {
    const pending: PaymentReceipt = {
      status: TransactionStatus.PENDING,
      source: 'submission',
      actionRequired: 'retry',
      createdAt: '2026-10-05T15:00:00.000Z',
      destination: OTHER,
      amount: '1.25',
      asset: 'XLM',
      memo: 'private-first-memo',
    };
    const first = mapPaymentReceiptToActivity(pending, ACCOUNT);
    const second = mapPaymentReceiptToActivity(
      { ...pending, destination: ACCOUNT, memo: 'private-second-memo' },
      ACCOUNT,
    );
    expect(first.id).not.toBe(second.id);
    expect(first.id).toBe(mapPaymentReceiptToActivity(pending, ACCOUNT).id);
    expect(first.id).not.toContain('private-first-memo');
    expect(first.id).not.toContain(OTHER);
    expect(second.id).not.toContain('private-second-memo');
    expect(second.id).not.toContain(ACCOUNT);
    expect(mapPaymentReceiptToActivity({
      ...pending, transactionHash: 'signed-tx-hash',
    }, ACCOUNT).id).toBe('receipt:signed-tx-hash');
  });

  it('keeps multiple vault operations within one transaction distinct', () => {
    const deposit: VaultMappedResult = {
      success: true, status: 'success', operation: 'deposit',
      hash: 'shared-transaction', amount: '2',
    };
    const withdrawal: VaultMappedResult = {
      ...deposit, operation: 'withdraw', amount: '1',
    };
    const first = mapVaultResultToActivity({
      result: deposit, createdAt: '2026-10-05T15:00:00.000Z',
    });
    const second = mapVaultResultToActivity({
      result: withdrawal, createdAt: '2026-10-05T15:00:00.000Z',
    });
    expect(first.transactionHash).toBe('shared-transaction');
    expect(second.transactionHash).toBe('shared-transaction');
    expect(first.id).toBe('vault:shared-transaction:deposit');
    expect(second.id).toBe('vault:shared-transaction:withdraw');
    expect(first.id).not.toBe(second.id);
  });

});
