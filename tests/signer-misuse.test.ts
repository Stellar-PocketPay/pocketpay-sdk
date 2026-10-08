import { describe, expect, it } from 'vitest';
import * as StellarSDK from '@stellar/stellar-sdk';
import {
  buildUnsignedTransaction,
  ErrorCode,
  prepareTransactionWithManualSequence,
  submitSignedTransaction,
  type SignedTransaction,
} from '../src';

describe('signer misuse boundary', () => {
  it('rejects an unsigned envelope locally before submission', async () => {
    const source = StellarSDK.Keypair.random();
    const destination = StellarSDK.Keypair.random().publicKey();
    const prepared = prepareTransactionWithManualSequence(
      {
        sourcePublicKey: source.publicKey(),
        operations: [
          {
            destination,
            amount: '1',
            asset: { code: 'XLM' },
          },
        ],
      },
      '100',
      { network: 'testnet' }
    );
    const unsigned = buildUnsignedTransaction(prepared);

    expect(unsigned.transaction.signatures).toHaveLength(0);

    // Deliberately model caller misuse at runtime: a built envelope is shaped
    // like the signed wrapper but still carries zero signatures.
    const notActuallySigned: SignedTransaction = {
      transaction: unsigned.transaction,
      networkPassphrase: unsigned.networkPassphrase,
      hash: unsigned.hash,
      xdr: unsigned.transaction.toEnvelope().toXDR('base64'),
    };

    const result = await submitSignedTransaction(notActuallySigned);

    expect(result).toEqual({
      success: false,
      hash: unsigned.hash,
      error: 'The transaction is not signed.',
      errorCode: ErrorCode.TX_UNSIGNED,
    });
    expect(unsigned.transaction.signatures).toHaveLength(0);
  });
});
