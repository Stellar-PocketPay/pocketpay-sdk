import { describe, expect, it } from 'vitest';
import { mapTransactionSummaryToActivity } from '../src/account/activity';
import type { TransactionSummary } from '../src/types';

describe('account history amount units', () => {
  it('keeps raw transaction subunits separate from display asset units', () => {
    const transaction: TransactionSummary = {
      hash: 'example-tx',
      createdAt: '2026-10-05T10:00:00.000Z',
      sourceAccount: 'GACCOUNT',
      asset: 'XLM',
      amount: '10000000',
      amountDisplay: '1',
    };
    const mapped = mapTransactionSummaryToActivity(transaction, 'GACCOUNT');
    expect(mapped.amount).toBe('1');
    expect(mapped.rawAmount).toBe('10000000');

    const rawOnly = mapTransactionSummaryToActivity(
      { ...transaction, amountDisplay: undefined }, 'GACCOUNT',
    );
    expect(rawOnly.amount).toBeUndefined();
    expect(rawOnly.rawAmount).toBe('10000000');
  });
});
