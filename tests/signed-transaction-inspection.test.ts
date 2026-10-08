/**
 * Signed transaction inspection tests (issue #206).
 *
 * The only complete view of a built envelope was `SignedTransaction.xdr` — the
 * whole thing, signatures included. `DIAGNOSTICS_SENSITIVE_KEYS` in
 * `src/diagnostics/types.ts` lists `xdr`, `signedXDR`, `envelope`, `signature`
 * and `signatures` among the keys always redacted, so the inspector reads the
 * envelope and never echoes it.
 */

import { describe, it, expect } from 'vitest';
import * as StellarSDK from '@stellar/stellar-sdk';
import {
  inspectSignedTransaction,
  safeInspectSignedTransaction,
  matchSignersByHint,
} from '../src/transactions';
import { PocketPayError } from '../src/types';
import { DIAGNOSTICS_SENSITIVE_KEYS } from '../src/diagnostics/types';

const NETWORK = StellarSDK.Networks.TESTNET;

const source = StellarSDK.Keypair.random();
const cosigner = StellarSDK.Keypair.random();
const stranger = StellarSDK.Keypair.random();
const destination = StellarSDK.Keypair.random().publicKey();

const payment = (amount = '10') =>
  StellarSDK.Operation.payment({
    destination,
    asset: StellarSDK.Asset.native(),
    amount,
  });

/** Builds a transaction, optionally signed and with a memo. */
function build(
  options: {
    operations?: StellarSDK.xdr.Operation[];
    memo?: StellarSDK.Memo;
    sign?: StellarSDK.Keypair[];
    fee?: string;
  } = {}
): StellarSDK.Transaction {
  const account = new StellarSDK.Account(source.publicKey(), '100');
  const builder = new StellarSDK.TransactionBuilder(account, {
    fee: options.fee ?? StellarSDK.BASE_FEE,
    networkPassphrase: NETWORK,
  });
  for (const operation of options.operations ?? [payment()]) builder.addOperation(operation);
  if (options.memo) builder.addMemo(options.memo);
  const transaction = builder.setTimeout(30).build();
  for (const keypair of options.sign ?? []) transaction.sign(keypair);
  return transaction;
}

const capture = (fn: () => unknown): PocketPayError => {
  try {
    fn();
  } catch (error) {
    return error as PocketPayError;
  }
  throw new Error('expected the call to throw');
};

describe('summary includes useful metadata', () => {
  it('reports source, hash, sequence and operation count', () => {
    const transaction = build();
    const summary = inspectSignedTransaction(transaction);

    expect(summary.sourceAccount).toBe(source.publicKey());
    expect(summary.hash).toBe(transaction.hash().toString('hex'));
    expect(summary.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(summary.sequence).toBe('101');
    expect(summary.operationCount).toBe(1);
  });

  it('reports the fee in stroops and as an exact decimal', () => {
    const summary = inspectSignedTransaction(build({ fee: '10000000' }));
    expect(summary.feeStroops).toBe('10000000');
    // Exact formatting, not a float division.
    expect(summary.fee).toBe('1.0000000');
  });

  it('names a well-known network', () => {
    expect(inspectSignedTransaction(build()).network).toBe('testnet');
    expect(inspectSignedTransaction(build()).networkPassphrase).toBe(NETWORK);
  });

  it('summarises each operation with its asset and destination', () => {
    const summary = inspectSignedTransaction(build({ operations: [payment('25.5')] }));
    const operation = summary.operations[0];

    expect(operation.index).toBe(0);
    expect(operation.type).toBe('payment');
    expect(operation.destination).toBe(destination);
    // The Stellar SDK canonicalises the amount to 7 decimals when building the
    // operation; the inspector reports the envelope's value verbatim.
    expect(operation.amount).toBe('25.5000000');
    expect(operation.asset).toBe('XLM');
    expect(operation.assetIssuer).toBeUndefined();
  });

  it('reports issued assets with their issuer', () => {
    const issuer = StellarSDK.Keypair.random().publicKey();
    const summary = inspectSignedTransaction(
      build({
        operations: [
          StellarSDK.Operation.payment({
            destination,
            asset: new StellarSDK.Asset('USDC', issuer),
            amount: '5',
          }),
        ],
      })
    );

    expect(summary.operations[0].asset).toBe('USDC');
    expect(summary.operations[0].assetIssuer).toBe(issuer);
  });

  it('reports time bounds when present', () => {
    const summary = inspectSignedTransaction(build());
    expect(summary.timeBounds).toBeDefined();
    expect(summary.timeBounds?.maxTime).not.toBe('0');
  });

  it('counts multiple operations', () => {
    const summary = inspectSignedTransaction({
      transaction: build({ operations: [payment(), payment(), payment()] }),
    });
    expect(summary.operationCount).toBe(3);
    expect(summary.operations.map((o) => o.index)).toEqual([0, 1, 2]);
  });
});

describe('memo reporting carries its type', () => {
  it('reports a display-safe text memo', () => {
    const summary = inspectSignedTransaction(
      build({ memo: StellarSDK.Memo.text('invoice\n42\u202e') })
    );
    expect(summary.memo).toBe('invoice\\n42\\u202e');
    expect(summary.memoType).toBe('text');
  });

  it('reports an id memo', () => {
    const summary = inspectSignedTransaction(build({ memo: StellarSDK.Memo.id('12345') }));
    expect(summary.memo).toBe('12345');
    expect(summary.memoType).toBe('id');
  });

  it('renders a hash memo as hex rather than raw bytes', () => {
    const hex = 'a'.repeat(64);
    const summary = inspectSignedTransaction(build({ memo: StellarSDK.Memo.hash(hex) }));
    expect(summary.memoType).toBe('hash');
    expect(summary.memo).toBe(hex);
  });

  it('omits both fields when there is no memo', () => {
    const summary = inspectSignedTransaction(build());
    expect(summary.memo).toBeUndefined();
    expect(summary.memoType).toBeUndefined();
  });
});

describe('signature reporting', () => {
  it('reports an unsigned transaction as unsigned', () => {
    const summary = inspectSignedTransaction(build());
    expect(summary.isSigned).toBe(false);
    expect(summary.signatureCount).toBe(0);
    expect(summary.signatures).toEqual([]);
  });

  it('counts signatures and reports hints only', () => {
    const summary = inspectSignedTransaction(build({ sign: [source, cosigner] }));

    expect(summary.isSigned).toBe(true);
    expect(summary.signatureCount).toBe(2);
    for (const signature of summary.signatures) {
      // A hint is four bytes: eight hex characters, nothing more.
      expect(signature.hint).toMatch(/^[0-9a-f]{8}$/);
      expect(Object.keys(signature)).toEqual(['hint']);
    }
  });

  it('matches hints against public keys the caller already knows', () => {
    const summary = inspectSignedTransaction(build({ sign: [source] }));

    expect(matchSignersByHint(summary, [source.publicKey()])).toEqual([source.publicKey()]);
    expect(matchSignersByHint(summary, [stranger.publicKey()])).toEqual([]);
  });

  it('ignores malformed candidate keys instead of failing', () => {
    const summary = inspectSignedTransaction(build({ sign: [source] }));
    expect(matchSignersByHint(summary, ['not-a-key', source.publicKey()])).toEqual([
      source.publicKey(),
    ]);
  });
});

describe('sensitive values are not exposed', () => {
  it('never includes the secret key or any S-shaped value', () => {
    const summary = inspectSignedTransaction(build({ sign: [source, cosigner] }));
    const serialised = JSON.stringify(summary);

    expect(serialised).not.toContain(source.secret());
    expect(serialised).not.toContain(cosigner.secret());
    expect(serialised).not.toMatch(/\bS[A-Z2-7]{55}\b/);
  });

  it('carries none of the keys the SDK classifies as sensitive', () => {
    // Aligns with DIAGNOSTICS_SENSITIVE_KEYS rather than inventing a second
    // policy: xdr, signedXDR and envelope must not appear at all.
    const summary = inspectSignedTransaction(build({ sign: [source] }));
    const keys = Object.keys(summary);

    for (const sensitive of DIAGNOSTICS_SENSITIVE_KEYS) {
      if (sensitive === 'signatures') continue; // present, but hint-only — asserted below
      expect(keys, sensitive).not.toContain(sensitive);
    }
  });

  it('exposes no raw signature bytes', () => {
    const transaction = build({ sign: [source] });
    const summary = inspectSignedTransaction(transaction);
    const serialised = JSON.stringify(summary);

    const rawSignature = transaction.signatures[0].signature().toString('base64');
    expect(serialised).not.toContain(rawSignature);
    expect(serialised).not.toContain(transaction.toXDR());
  });

  it('does not echo the envelope for a SignedTransaction-shaped input', () => {
    const transaction = build({ sign: [source] });
    const summary = inspectSignedTransaction({
      transaction,
      networkPassphrase: NETWORK,
    });

    expect(JSON.stringify(summary)).not.toContain(transaction.toXDR());
  });
});

describe('accepts the shapes a caller actually has', () => {
  it('accepts a Transaction', () => {
    expect(inspectSignedTransaction(build()).operationCount).toBe(1);
  });

  it('accepts a SignedTransaction-shaped wrapper', () => {
    const transaction = build({ sign: [source] });
    const summary = inspectSignedTransaction({ transaction, networkPassphrase: NETWORK });
    expect(summary.isSigned).toBe(true);
  });

  it('accepts a base64 XDR string with its passphrase', () => {
    const transaction = build({ sign: [source] });
    const summary = inspectSignedTransaction(transaction.toXDR(), NETWORK);

    expect(summary.hash).toBe(transaction.hash().toString('hex'));
    expect(summary.signatureCount).toBe(1);
  });

  it('describes a fee-bump envelope, naming the fee payer separately', () => {
    const inner = build({ sign: [source] });
    const feeBump = StellarSDK.TransactionBuilder.buildFeeBumpTransaction(
      cosigner,
      '2000',
      inner,
      NETWORK
    );

    const summary = inspectSignedTransaction(feeBump);
    expect(summary.isFeeBump).toBe(true);
    expect(summary.feeSource).toBe(cosigner.publicKey());
    // The inner transaction still owns the source and the operations.
    expect(summary.sourceAccount).toBe(source.publicKey());
    expect(summary.operationCount).toBe(1);
  });
});

describe('invalid input is rejected clearly', () => {
  it('rejects an XDR string without a passphrase', () => {
    const err = capture(() => inspectSignedTransaction(build().toXDR()));
    expect(err.validation?.reason).toBe('missing_network_passphrase');
    expect(err).toBeInstanceOf(PocketPayError);
  });

  it('rejects a malformed XDR string', () => {
    const err = capture(() => inspectSignedTransaction('not-valid-xdr', NETWORK));
    expect(err.validation?.reason).toBe('invalid_xdr');
  });

  it('does not leak envelope detail in the rejection message', () => {
    const err = capture(() => inspectSignedTransaction('AAAAAgAAAABsuspicious', NETWORK));
    expect(err.message).not.toContain('AAAAAgAAAABsuspicious');
  });

  it('rejects a value that is not a transaction at all', () => {
    const err = capture(() => inspectSignedTransaction({ nope: true } as never));
    expect(err.validation?.reason).toBe('unsupported_input');
  });

  it('safeInspectSignedTransaction returns the error instead of throwing', () => {
    const result = safeInspectSignedTransaction('not-valid-xdr', NETWORK);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toBeInstanceOf(PocketPayError);
  });

  it('safeInspectSignedTransaction returns the summary when valid', () => {
    const result = safeInspectSignedTransaction(build({ sign: [source] }));
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.summary.signatureCount).toBe(1);
  });
});
