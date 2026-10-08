import { TransactionBuilder } from './transaction-builder';

/**
 * Baseline transaction fixtures
 */
export const transactionFixtures = {
  /**
   * A successful transaction
   */
  success: new TransactionBuilder()
    .withHash('0x1234567890abcdef1234567890abcdef12345678')
    .withFrom('GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890')
    .withTo('GXYZ1234567890ABCDEFGHIJKLMNOPQRSTUVW')
    .withAmount('100.00')
    .withAsset('XLM')
    .withStatus('completed')
    .build(),

  /**
   * A pending transaction
   */
  pending: new TransactionBuilder()
    .withHash('0x1234567890abcdef1234567890abcdef12345679')
    .withFrom('GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890')
    .withTo('GXYZ1234567890ABCDEFGHIJKLMNOPQRSTUVW')
    .withAmount('100.00')
    .withAsset('XLM')
    .withStatus('pending')
    .build(),

  /**
   * A failed transaction
   */
  failed: new TransactionBuilder()
    .withHash('0x1234567890abcdef1234567890abcdef12345680')
    .withFrom('GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890')
    .withTo('GXYZ1234567890ABCDEFGHIJKLMNOPQRSTUVW')
    .withAmount('100.00')
    .withAsset('XLM')
    .withStatus('failed')
    .withError('Transaction failed')
    .build(),

  /**
   * A transaction with memo
   */
  withMemo: new TransactionBuilder()
    .withHash('0x1234567890abcdef1234567890abcdef12345681')
    .withFrom('GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890')
    .withTo('GXYZ1234567890ABCDEFGHIJKLMNOPQRSTUVW')
    .withAmount('100.00')
    .withAsset('XLM')
    .withMemo('Payment for services')
    .withStatus('completed')
    .build(),
  /** Submission acknowledged by no conclusive ledger result; safe to poll, not blindly resend. */
  unknown: new TransactionBuilder()
    .withHash('0x1234567890abcdef1234567890abcdef12345682')
    .withFrom('GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890')
    .withTo('GXYZ1234567890ABCDEFGHIJKLMNOPQRSTUVW')
    .withAmount('100.00')
    .withAsset('XLM')
    .withStatus('unknown')
    .build(),
};

export type TransactionFixtureType = keyof typeof transactionFixtures;
export const transactionFixtureNames = Object.keys(transactionFixtures) as TransactionFixtureType[];
