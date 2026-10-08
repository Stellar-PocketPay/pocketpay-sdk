import { describe, expect, it } from 'vitest';
import * as StellarSDK from '@stellar/stellar-sdk';
import {
  buildUnsignedTransaction,
  getTransactionSigningSummary,
  prepareTransactionWithManualSequence,
  type TransactionSigningSummary,
} from '../src';

const source = StellarSDK.Keypair.random();
const destination = StellarSDK.Keypair.random();

function prepare() {
  return prepareTransactionWithManualSequence(
    {
      sourcePublicKey: source.publicKey(),
      operations: [
        {
          destination: destination.publicKey(),
          amount: '12.5',
          asset: { code: 'XLM' },
        },
      ],
      memo: 'review me',
      baseFee: '100',
      timebounds: { minTime: 1_700_000_000, maxTime: 1_700_000_300 },
    },
    '123',
    { network: 'testnet' }
  );
}

describe('getTransactionSigningSummary', () => {
  it('summarises a prepared payload before it is built', () => {
    const summary: TransactionSigningSummary = getTransactionSigningSummary(prepare());

    expect(summary.source).toBe(source.publicKey());
    expect(summary.networkName).toBe('Stellar Testnet');
    expect(summary.fee).toBe('100');
    expect(summary.feeInXlm).toBe('0.0000100');
    expect(summary.memo).toBe('review me');
    expect(summary.operationCount).toBe(1);
    expect(summary.operations).toEqual([
      expect.objectContaining({
        type: 'payment',
        destination: destination.publicKey(),
        amount: '12.5',
        assetCode: 'XLM',
      }),
    ]);
    expect(summary.canSign).toBe(true);
    expect(summary.transactionHash).toBeUndefined();
  });

  it('summarises the exact unsigned payload without signing or submitting it', () => {
    const unsigned = buildUnsignedTransaction(prepare());
    expect(unsigned.transaction.signatures).toHaveLength(0);

    const summary = getTransactionSigningSummary(unsigned);

    expect(summary.transactionHash).toBe(unsigned.hash);
    expect(summary.source).toBe(source.publicKey());
    expect(summary.operationCount).toBe(1);
    expect(summary.timebounds).toMatchObject({
      minTime: 1_700_000_000,
      maxTime: 1_700_000_300,
    });
    expect(summary.canSign).toBe(true);

    // Review is a read-only boundary: producing it must never add signatures.
    expect(unsigned.transaction.signatures).toHaveLength(0);
    expect(JSON.stringify(summary)).not.toContain('secret');
    expect(JSON.stringify(summary)).not.toContain('xdr');
  });
});
