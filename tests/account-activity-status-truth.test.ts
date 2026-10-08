import { describe, expect, it } from 'vitest';
import {
  TransactionStatus,
  mapPaymentReceiptToActivity,
  mapTransactionSummaryToActivity,
  mapVaultResultToActivity,
} from '../src';
import type { PaymentReceipt, VaultMappedResult } from '../src';

const ACCOUNT = 'GACCOUNT';
const CREATED_AT = '2026-10-08T00:00:00.000Z';

describe('account activity: evidence-bound status and direction', () => {
  it('never marks contradictory or unknown transaction status as completed', () => {
    const base = {
      hash: 'transaction-id',
      createdAt: CREATED_AT,
      sourceAccount: ACCOUNT,
    };
    expect(mapTransactionSummaryToActivity({
      ...base,
      successful: false,
      status: TransactionStatus.COMPLETED,
    }, ACCOUNT).status).toBe(TransactionStatus.UNKNOWN);
    expect(mapTransactionSummaryToActivity({
      ...base,
      successful: true,
      status: 'unrecognized' as TransactionStatus,
    }, ACCOUNT).status).toBe(TransactionStatus.UNKNOWN);
  });

  it('does not claim a self-payment without receipt source-account evidence', () => {
    const receipt: PaymentReceipt = {
      source: 'submission',
      status: TransactionStatus.PENDING,
      actionRequired: 'poll',
      createdAt: CREATED_AT,
      destination: ACCOUNT,
    };
    const record = mapPaymentReceiptToActivity(receipt, ACCOUNT);
    expect(record.direction).toBe('neutral');
    expect(record.counterparty).toBeUndefined();
    expect(mapPaymentReceiptToActivity({
      ...receipt, status: 'weird' as TransactionStatus,
    }, ACCOUNT).status).toBe(TransactionStatus.UNKNOWN);
  });

  it('keeps contradictory vault results unknown instead of showing success', () => {
    const result: VaultMappedResult = {
      status: 'success',
      success: false,
      operation: 'deposit',
      amount: '1',
    };
    expect(mapVaultResultToActivity({
      result, createdAt: CREATED_AT,
    }).status).toBe(TransactionStatus.UNKNOWN);
    expect(mapVaultResultToActivity({
      result: { ...result, status: 'failed', success: true },
      createdAt: CREATED_AT,
    }).status).toBe(TransactionStatus.UNKNOWN);
  });
});
