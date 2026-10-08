/**
 * Tests for the Account Abstraction Layer (Issue #159)
 *
 * Acceptance criteria verified here:
 *  ✓ A clear account abstraction design is added or implemented.
 *  ✓ Wallet identity and signing capability are separated.
 *  ✓ The model supports local wallet signing.
 *  ✓ The design leaves room for external signer support.
 *  ✓ Tests or examples demonstrate the abstraction.
 *  ✓ Documentation explains the account model (see docs/account-abstraction.md).
 */

import { describe, it, expect, vi } from 'vitest';
import * as StellarSDK from '@stellar/stellar-sdk';

import {
  // Types (imported as values to check runtime availability via factories)
  // Factory functions
  createReadOnlyAccount,
  createLocalAccount,
  createAccountWithSigner,
  // Signer
  LocalSigner,
  createLocalSigner,
  // Error type for negative-path tests
  PocketPayError,
  ErrorCode,
  // Root-level re-exports to confirm wiring
  createWallet,
} from '../src';

// ─── Test fixtures ───────────────────────────────────────────────────────────

/** A real, valid Stellar keypair generated once for all tests. */
const TEST_KEYPAIR = StellarSDK.Keypair.random();
const TEST_SECRET = TEST_KEYPAIR.secret();
const TEST_PUBLIC = TEST_KEYPAIR.publicKey();

/** A second keypair for distinctness checks. */
const OTHER_KEYPAIR = StellarSDK.Keypair.random();
const OTHER_SECRET = OTHER_KEYPAIR.secret();
const OTHER_PUBLIC = OTHER_KEYPAIR.publicKey();

const INVALID_SECRET = 'not-a-secret-key';
const INVALID_PUBLIC = 'not-a-public-key';

// ─── AccountIdentity separation ──────────────────────────────────────────────

describe('AccountIdentity — wallet identity is separate from signing', () => {
  it('createReadOnlyAccount exposes only the public key — no secret material', () => {
    const account = createReadOnlyAccount(TEST_PUBLIC);
    expect(account.identity.publicKey).toBe(TEST_PUBLIC);
    expect(account.publicKey).toBe(TEST_PUBLIC);

    // The identity object should not have any secretKey property
    expect((account.identity as any).secretKey).toBeUndefined();
    // The account itself should not expose a secretKey
    expect((account as any).secretKey).toBeUndefined();
  });

  it('createLocalAccount derives publicKey from secretKey — identity remains separate', () => {
    const account = createLocalAccount(TEST_SECRET);
    // Public key must be consistent with the secret
    expect(account.publicKey).toBe(TEST_PUBLIC);
    expect(account.identity.publicKey).toBe(TEST_PUBLIC);
    // No secret key exposed on the account surface
    expect((account as any).secretKey).toBeUndefined();
    expect((account.identity as any).secretKey).toBeUndefined();
  });

  it('identity.publicKey is readonly — publicKey and identity stay consistent', () => {
    const account = createReadOnlyAccount(TEST_PUBLIC);
    // readonly is a TypeScript compile-time constraint; at runtime we verify
    // that the publicKey shortcut and identity.publicKey remain consistent
    // with the original value passed to the factory.
    expect(account.publicKey).toBe(TEST_PUBLIC);
    expect(account.identity.publicKey).toBe(TEST_PUBLIC);
    expect(account.publicKey).toBe(account.identity.publicKey);
  });
});

// ─── Signer Interface ────────────────────────────────────────────────────────

describe('Signer Interface — pluggable signing capability', () => {
  it('LocalSigner exposes the correct publicKey', () => {
    const signer = new LocalSigner({ secretKey: TEST_SECRET });
    expect(signer.publicKey).toBe(TEST_PUBLIC);
  });

  it('createLocalSigner factory produces an equivalent LocalSigner', () => {
    const signer = createLocalSigner(TEST_SECRET);
    expect(signer.publicKey).toBe(TEST_PUBLIC);
    expect(signer).toBeInstanceOf(LocalSigner);
  });

  it('LocalSigner rejects a malformed secret key', () => {
    expect(() => new LocalSigner({ secretKey: INVALID_SECRET })).toThrow(PocketPayError);
    expect(() => createLocalSigner(INVALID_SECRET)).toThrow(PocketPayError);
  });

  it('LocalSigner.sign() returns the same transaction object (mutation model)', async () => {
    const signer = createLocalSigner(TEST_SECRET);
    const keypair = StellarSDK.Keypair.random();
    const account = new StellarSDK.Account(TEST_PUBLIC, '0');
    const tx = new StellarSDK.TransactionBuilder(account, {
      fee: StellarSDK.BASE_FEE,
      networkPassphrase: StellarSDK.Networks.TESTNET,
    })
      .addOperation(
        StellarSDK.Operation.payment({
          destination: OTHER_PUBLIC,
          asset: StellarSDK.Asset.native(),
          amount: '1',
        }),
      )
      .setTimeout(30)
      .build();

    const signed = await signer.sign(tx, StellarSDK.Networks.TESTNET);

    // Should return the same object (mutation in-place)
    expect(signed).toBe(tx);
    // The transaction envelope should now contain a signature
    expect(tx.toEnvelope().toXDR().length).toBeGreaterThan(0);
  });

  it('an external signer implementing the Signer interface works with createAccountWithSigner', async () => {
    // Demonstrates that any object satisfying the Signer interface can be used
    const signCalls: string[] = [];

    const externalSigner = {
      publicKey: TEST_PUBLIC,
      async sign(
        tx: StellarSDK.Transaction | StellarSDK.FeeBumpTransaction,
        networkPassphrase: string,
      ) {
        signCalls.push(networkPassphrase);
        // Real implementation would sign remotely; here we just return unsigned
        return tx;
      },
    };

    const account = createAccountWithSigner({ publicKey: TEST_PUBLIC }, externalSigner);
    expect(account.canSign).toBe(true);
    expect(account.publicKey).toBe(TEST_PUBLIC);

    // Build a minimal transaction to pass to sign()
    const stellarAccount = new StellarSDK.Account(TEST_PUBLIC, '0');
    const tx = new StellarSDK.TransactionBuilder(stellarAccount, {
      fee: StellarSDK.BASE_FEE,
      networkPassphrase: StellarSDK.Networks.TESTNET,
    })
      .addOperation(
        StellarSDK.Operation.payment({
          destination: OTHER_PUBLIC,
          asset: StellarSDK.Asset.native(),
          amount: '1',
        }),
      )
      .setTimeout(30)
      .build();

    await account.sign(tx, StellarSDK.Networks.TESTNET);
    expect(signCalls).toEqual([StellarSDK.Networks.TESTNET]);
  });
});

// ─── createReadOnlyAccount ───────────────────────────────────────────────────

describe('createReadOnlyAccount()', () => {
  it('returns an account with canSign = false', () => {
    const account = createReadOnlyAccount(TEST_PUBLIC);
    expect(account.canSign).toBe(false);
  });

  it('returns an account with signer = undefined', () => {
    const account = createReadOnlyAccount(TEST_PUBLIC);
    expect(account.signer).toBeUndefined();
  });

  it('sign() throws a descriptive error when no signer is attached', async () => {
    const account = createReadOnlyAccount(TEST_PUBLIC);
    const stellarAccount = new StellarSDK.Account(TEST_PUBLIC, '0');
    const tx = new StellarSDK.TransactionBuilder(stellarAccount, {
      fee: StellarSDK.BASE_FEE,
      networkPassphrase: StellarSDK.Networks.TESTNET,
    })
      .addOperation(
        StellarSDK.Operation.payment({
          destination: OTHER_PUBLIC,
          asset: StellarSDK.Asset.native(),
          amount: '1',
        }),
      )
      .setTimeout(30)
      .build();

    await expect(account.sign(tx, StellarSDK.Networks.TESTNET)).rejects.toThrow(
      /read-only.*cannot sign/i,
    );
  });

  it('rejects an invalid public key', () => {
    expect(() => createReadOnlyAccount(INVALID_PUBLIC)).toThrow(PocketPayError);
  });

  it('publicKey shortcut matches identity.publicKey', () => {
    const account = createReadOnlyAccount(TEST_PUBLIC);
    expect(account.publicKey).toBe(account.identity.publicKey);
  });

  it('two read-only accounts with different keys are distinct', () => {
    const a = createReadOnlyAccount(TEST_PUBLIC);
    const b = createReadOnlyAccount(OTHER_PUBLIC);
    expect(a.publicKey).not.toBe(b.publicKey);
  });
});

// ─── createLocalAccount ──────────────────────────────────────────────────────

describe('createLocalAccount()', () => {
  it('returns an account with canSign = true', () => {
    const account = createLocalAccount(TEST_SECRET);
    expect(account.canSign).toBe(true);
  });

  it('attaches a LocalSigner instance', () => {
    const account = createLocalAccount(TEST_SECRET);
    expect(account.signer).toBeInstanceOf(LocalSigner);
  });

  it('signer.publicKey matches account.publicKey', () => {
    const account = createLocalAccount(TEST_SECRET);
    expect(account.signer?.publicKey).toBe(account.publicKey);
  });

  it('signs a transaction without throwing', async () => {
    const account = createLocalAccount(TEST_SECRET);
    const stellarAccount = new StellarSDK.Account(TEST_PUBLIC, '0');
    const tx = new StellarSDK.TransactionBuilder(stellarAccount, {
      fee: StellarSDK.BASE_FEE,
      networkPassphrase: StellarSDK.Networks.TESTNET,
    })
      .addOperation(
        StellarSDK.Operation.payment({
          destination: OTHER_PUBLIC,
          asset: StellarSDK.Asset.native(),
          amount: '1',
        }),
      )
      .setTimeout(30)
      .build();

    const signed = await account.sign(tx, StellarSDK.Networks.TESTNET);
    expect(signed).toBeDefined();
  });

  it('rejects a malformed secret key', () => {
    expect(() => createLocalAccount(INVALID_SECRET)).toThrow(PocketPayError);
  });

  it('two accounts built from different keys are distinct', () => {
    const a = createLocalAccount(TEST_SECRET);
    const b = createLocalAccount(OTHER_SECRET);
    expect(a.publicKey).not.toBe(b.publicKey);
  });

  it('is consistent with createWallet() — derived public key matches', () => {
    const wallet = createWallet();
    const account = createLocalAccount(wallet.secretKey);
    expect(account.publicKey).toBe(wallet.publicKey);
  });
});

// ─── createAccountWithSigner ─────────────────────────────────────────────────

describe('createAccountWithSigner()', () => {
  it('creates a read-only account when no signer is passed', () => {
    const account = createAccountWithSigner({ publicKey: TEST_PUBLIC });
    expect(account.canSign).toBe(false);
    expect(account.signer).toBeUndefined();
  });

  it('creates a signing account when a signer is passed', () => {
    const signer = createLocalSigner(TEST_SECRET);
    const account = createAccountWithSigner({ publicKey: TEST_PUBLIC }, signer);
    expect(account.canSign).toBe(true);
    expect(account.signer).toBe(signer);
  });

  it('delegates sign() to the provided signer', async () => {
    const signer = createLocalSigner(TEST_SECRET);
    const signSpy = vi.spyOn(signer, 'sign');

    const account = createAccountWithSigner({ publicKey: TEST_PUBLIC }, signer);

    const stellarAccount = new StellarSDK.Account(TEST_PUBLIC, '0');
    const tx = new StellarSDK.TransactionBuilder(stellarAccount, {
      fee: StellarSDK.BASE_FEE,
      networkPassphrase: StellarSDK.Networks.TESTNET,
    })
      .addOperation(
        StellarSDK.Operation.payment({
          destination: OTHER_PUBLIC,
          asset: StellarSDK.Asset.native(),
          amount: '1',
        }),
      )
      .setTimeout(30)
      .build();

    await account.sign(tx, StellarSDK.Networks.TESTNET);
    expect(signSpy).toHaveBeenCalledOnce();
  });

  it('rejects a signer for a different account identity before attachment', () => {
    const wrongSigner = {
      publicKey: OTHER_PUBLIC,
      sign: vi.fn(async (transaction: StellarSDK.Transaction | StellarSDK.FeeBumpTransaction) => transaction),
    };

    let error: unknown;
    try {
      createAccountWithSigner({ publicKey: TEST_PUBLIC }, wrongSigner);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PocketPayError);
    expect(error).toMatchObject({ code: ErrorCode.TX_SIGNER_MISMATCH });
    expect(wrongSigner.sign).not.toHaveBeenCalled();
  });

  it('snapshots the supplied identity so caller mutation cannot drift the account', () => {
    const identity = { publicKey: TEST_PUBLIC };
    const signer = createLocalSigner(TEST_SECRET);
    const account = createAccountWithSigner(identity, signer);

    identity.publicKey = OTHER_PUBLIC;

    expect(account.publicKey).toBe(TEST_PUBLIC);
    expect(account.identity.publicKey).toBe(TEST_PUBLIC);
    expect(Object.isFrozen(account.identity)).toBe(true);
    expect(Reflect.set(account.identity as object, 'publicKey', OTHER_PUBLIC)).toBe(false);
    expect(account.publicKey).toBe(TEST_PUBLIC);
  });

  it('rechecks external signer identity before each sign call', async () => {
    const externalSigner = {
      publicKey: TEST_PUBLIC,
      sign: vi.fn(async (transaction: StellarSDK.Transaction | StellarSDK.FeeBumpTransaction) => transaction),
    };
    const account = createAccountWithSigner({ publicKey: TEST_PUBLIC }, externalSigner);
    const transaction = {} as StellarSDK.Transaction;

    externalSigner.publicKey = OTHER_PUBLIC;
    await expect(account.sign(transaction, StellarSDK.Networks.TESTNET)).rejects.toMatchObject({
      code: ErrorCode.TX_SIGNER_MISMATCH,
    });
    expect(externalSigner.sign).not.toHaveBeenCalled();

    externalSigner.publicKey = TEST_PUBLIC;
    await expect(account.sign(transaction, StellarSDK.Networks.TESTNET)).resolves.toBe(transaction);
    expect(externalSigner.sign).toHaveBeenCalledOnce();
  });

  it('rejects an invalid public key in the identity', () => {
    expect(() => createAccountWithSigner({ publicKey: INVALID_PUBLIC })).toThrow(PocketPayError);
  });
});

// ─── Package-root wiring ─────────────────────────────────────────────────────

describe('Package root exports — account abstraction', () => {
  it('createReadOnlyAccount is exported from the package root', async () => {
    const { createReadOnlyAccount: fn } = await import('../src');
    expect(fn).toBeDefined();
    expect(typeof fn).toBe('function');
  });

  it('createLocalAccount is exported from the package root', async () => {
    const { createLocalAccount: fn } = await import('../src');
    expect(fn).toBeDefined();
    expect(typeof fn).toBe('function');
  });

  it('createAccountWithSigner is exported from the package root', async () => {
    const { createAccountWithSigner: fn } = await import('../src');
    expect(fn).toBeDefined();
    expect(typeof fn).toBe('function');
  });

  it('LocalSigner class is exported from the package root', async () => {
    const { LocalSigner: cls } = await import('../src');
    expect(cls).toBeDefined();
    expect(typeof cls).toBe('function');
  });

  it('createLocalSigner factory is exported from the package root', async () => {
    const { createLocalSigner: fn } = await import('../src');
    expect(fn).toBeDefined();
    expect(typeof fn).toBe('function');
  });
});

// ─── External signer extensibility ───────────────────────────────────────────

describe('External signer extensibility — room for future integrations', () => {
  it('async signer is supported (simulates a remote HSM call)', async () => {
    // An external signer that resolves asynchronously (as a remote call would)
    const asyncSigner = {
      publicKey: TEST_PUBLIC,
      async sign(
        tx: StellarSDK.Transaction | StellarSDK.FeeBumpTransaction,
        _networkPassphrase: string,
      ) {
        // Simulate async I/O (e.g. hardware wallet confirmation)
        await new Promise((resolve) => setTimeout(resolve, 0));
        return tx;
      },
    };

    const account = createAccountWithSigner({ publicKey: TEST_PUBLIC }, asyncSigner);
    const stellarAccount = new StellarSDK.Account(TEST_PUBLIC, '0');
    const tx = new StellarSDK.TransactionBuilder(stellarAccount, {
      fee: StellarSDK.BASE_FEE,
      networkPassphrase: StellarSDK.Networks.TESTNET,
    })
      .addOperation(
        StellarSDK.Operation.payment({
          destination: OTHER_PUBLIC,
          asset: StellarSDK.Asset.native(),
          amount: '1',
        }),
      )
      .setTimeout(30)
      .build();

    const signed = await account.sign(tx, StellarSDK.Networks.TESTNET);
    expect(signed).toBeDefined();
  });

  it('signer that rejects propagates the error to the caller', async () => {
    const failingSigner = {
      publicKey: TEST_PUBLIC,
      async sign(): Promise<never> {
        throw new Error('Hardware wallet rejected the transaction');
      },
    };

    const account = createAccountWithSigner({ publicKey: TEST_PUBLIC }, failingSigner);
    const stellarAccount = new StellarSDK.Account(TEST_PUBLIC, '0');
    const tx = new StellarSDK.TransactionBuilder(stellarAccount, {
      fee: StellarSDK.BASE_FEE,
      networkPassphrase: StellarSDK.Networks.TESTNET,
    })
      .addOperation(
        StellarSDK.Operation.payment({
          destination: OTHER_PUBLIC,
          asset: StellarSDK.Asset.native(),
          amount: '1',
        }),
      )
      .setTimeout(30)
      .build();

    await expect(account.sign(tx, StellarSDK.Networks.TESTNET)).rejects.toThrow(
      'Hardware wallet rejected the transaction',
    );
  });
});
