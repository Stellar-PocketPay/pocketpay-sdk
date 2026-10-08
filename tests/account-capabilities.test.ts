import { describe, expect, it, vi } from 'vitest';
import * as StellarSDK from '@stellar/stellar-sdk';
import {
  createAccountWithSigner,
  createLocalAccount,
  createReadOnlyAccount,
  getAccountCapabilities,
  hasSubmissionTransport,
  PocketPayError,
  ErrorCode,
  type AccountSubmissionTransport,
} from '../src';

const source = StellarSDK.Keypair.random();
const other = StellarSDK.Keypair.random();

describe('account capability snapshot (#209)', () => {
  it('does not infer signing or submission authority from a view-only public key', () => {
    const account = createReadOnlyAccount(source.publicKey());
    expect(getAccountCapabilities(account)).toEqual({
      canView: true, canSign: false, canSubmit: false, submission: 'missing',
    });
  });

  it('does not infer network submission authority from a local signer', () => {
    const account = createLocalAccount(source.secret());
    expect(getAccountCapabilities(account)).toMatchObject({
      canView: true, canSign: true, canSubmit: false, submission: 'missing',
    });
  });

  it('can configure a broadcast-only transport without signing or making network calls', () => {
    const submitSignedTransaction = vi.fn(async () => ({ accepted: true }));
    const transport: AccountSubmissionTransport = { submitSignedTransaction };
    const account = createReadOnlyAccount(source.publicKey());

    expect(getAccountCapabilities(account, transport)).toMatchObject({
      canView: true, canSign: false, canSubmit: true, submission: 'configured',
    });
    expect(submitSignedTransaction).not.toHaveBeenCalled();
    expect(hasSubmissionTransport({ submitSignedTransaction: 123 })).toBe(false);
    expect(hasSubmissionTransport(null)).toBe(false);
  });

  it('does not report an explicitly unavailable remote signer as available', () => {
    const account = createAccountWithSigner({ publicKey: source.publicKey() }, {
      publicKey: source.publicKey(),
      isAvailable: false,
      kind: 'hardware' as const,
      async sign(tx) { return tx; },
    });
    expect(account.canSign).toBe(true); // Original type-level contract unchanged.
    expect(getAccountCapabilities(account).canSign).toBe(false);
  });

  it('keeps signing available when an optional probe is unset', () => {
    const account = createAccountWithSigner({ publicKey: source.publicKey() }, {
      publicKey: source.publicKey(),
      isAvailable: undefined,
      kind: 'hardware' as const,
      async sign(tx) { return tx; },
    });
    expect(getAccountCapabilities(account).canSign).toBe(true);
  });

  it('observes a mutable availability getter only once per capability snapshot', () => {
    let probeReads = 0;
    const account = createAccountWithSigner({ publicKey: source.publicKey() }, {
      publicKey: source.publicKey(),
      kind: 'hardware' as const,
      get isAvailable() {
        probeReads += 1;
        return probeReads === 1 ? false : true;
      },
      async sign(tx) { return tx; },
    });

    expect(getAccountCapabilities(account).canSign).toBe(false);
    expect(probeReads).toBe(1);
  });

  it('fails closed when caller-provided capability getters throw', () => {
    const transport = Object.defineProperty({}, 'submitSignedTransaction', {
      get() { throw new Error('broken transport'); },
    });
    expect(hasSubmissionTransport(transport)).toBe(false);

    const account = createAccountWithSigner({ publicKey: source.publicKey() }, {
      publicKey: source.publicKey(),
      kind: 'hardware' as const,
      get isAvailable() { throw new Error('broken signer availability'); },
      async sign(tx) { return tx; },
    });
    expect(getAccountCapabilities(account).canSign).toBe(false);
  });

  it('fails closed when signer getters become unreadable after account creation', () => {
    let unavailable: 'sign' | 'publicKey' | undefined;
    const signer = {
      get publicKey() {
        if (unavailable === 'publicKey') throw new Error('Signer identity unavailable');
        return source.publicKey();
      },
      get sign() {
        if (unavailable === 'sign') throw new Error('Signer method unavailable');
        return async (tx: StellarSDK.Transaction | StellarSDK.FeeBumpTransaction) => tx;
      },
    };
    const account = createAccountWithSigner({ publicKey: source.publicKey() }, signer);
    expect(getAccountCapabilities(account).canSign).toBe(true);

    unavailable = 'sign';
    expect(getAccountCapabilities(account)).toMatchObject({
      canView: true, canSign: false, canSubmit: false,
    });

    unavailable = 'publicKey';
    expect(getAccountCapabilities(account).canSign).toBe(false);
  });

  it('rejects attaching an identity-mismatched signer without invoking it', () => {
    const sign = vi.fn(async (tx: StellarSDK.Transaction | StellarSDK.FeeBumpTransaction) => tx);
    expect(() => createAccountWithSigner(
      { publicKey: source.publicKey() },
      { publicKey: other.publicKey(), sign },
    )).toThrow(PocketPayError);
    try {
      createAccountWithSigner({ publicKey: source.publicKey() }, {
        publicKey: other.publicKey(), sign,
      });
    } catch (err) {
      expect((err as PocketPayError).code).toBe(ErrorCode.TX_SIGNER_MISMATCH);
    }
    expect(sign).not.toHaveBeenCalled();
  });

  it('rechecks mutable remote signer identity immediately before sign delegation', async () => {
    const signer = {
      publicKey: source.publicKey(),
      sign: vi.fn(async (tx: StellarSDK.Transaction | StellarSDK.FeeBumpTransaction) => tx),
    };
    const account = createAccountWithSigner({ publicKey: source.publicKey() }, signer);
    signer.publicKey = other.publicKey();

    await expect(account.sign({} as StellarSDK.Transaction, StellarSDK.Networks.TESTNET))
      .rejects.toMatchObject({ code: ErrorCode.TX_SIGNER_MISMATCH });
    expect(getAccountCapabilities(account).canSign).toBe(false);
    expect(signer.sign).not.toHaveBeenCalled();
  });
});
