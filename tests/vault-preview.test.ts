import { describe, expect, it } from 'vitest';
import * as StellarSDK from '@stellar/stellar-sdk';
import {
  buildVaultOperationPreview,
  PocketPayError,
  resetDiagnosticsHooks,
  setDiagnosticsHooks,
} from '../src';

const wallet = StellarSDK.Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7)).publicKey();

describe('vault operation preview', () => {
  it('builds a side-effect-free deposit preview with public review fields', () => {
    const preview = buildVaultOperationPreview(
      { operation: 'deposit', wallet, amount: '12.5' },
      { network: 'mainnet' },
    );

    expect(preview).toMatchObject({
      operation: 'deposit',
      wallet,
      amount: '12.5',
      asset: { code: 'XLM' },
      network: 'mainnet',
      estimatedFee: String(StellarSDK.BASE_FEE),
      supported: true,
    });
    expect(preview.warnings.join(' ')).toContain('does not imply native XLM custody');
    expect(JSON.stringify(preview)).not.toMatch(/secret|sourceSecret/i);
  });

  it('does not emit config diagnostics while building a side-effect-free preview', () => {
    const events: string[] = [];
    setDiagnosticsHooks({
      onEvent(event) {
        events.push(`${event.domain}:${event.type}`);
      },
    });

    try {
      buildVaultOperationPreview(
        { operation: 'deposit', wallet, amount: '1' },
        { network: 'testnet' },
      );
      expect(events).toEqual([]);
    } finally {
      resetDiagnosticsHooks();
    }
  });

  it('returns the canonical public wallet in the review model', () => {
    const preview = buildVaultOperationPreview({
      operation: 'getBalance',
      wallet: `  ${wallet}\n`,
    });

    expect(preview.wallet).toBe(wallet);
  });

  it('marks balance previews as read-only with no transaction fee', () => {
    const preview = buildVaultOperationPreview({ operation: 'getBalance', wallet });

    expect(preview.amount).toBeUndefined();
    expect(preview.estimatedFee).toBe('0');
    expect(preview.supported).toBe(true);
    expect(preview.warnings).toEqual([]);
  });

  it('previews lock intent without pretending the SDK can execute it', () => {
    const preview = buildVaultOperationPreview({
      operation: 'createLock',
      wallet,
      amount: '4',
      unlockAt: 1_900_000_000,
    });

    expect(preview.supported).toBe(false);
    expect(preview.unlockAt).toBe(1_900_000_000);
    expect(preview.warnings.join(' ')).toContain(
      'current SDK does not execute vault lock operations',
    );
  });

  it('rejects a lock preview that omits its unlock time', () => {
    let thrown: unknown;
    try {
      buildVaultOperationPreview({
        operation: 'createLock',
        wallet,
        amount: '4',
      } as never);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PocketPayError);
    expect(thrown).toMatchObject({
      code: 'INVALID_OPERATION',
      validation: {
        field: 'unlockAt',
        reason: 'missing',
      },
    });
  });

  it('does not serialize rejected numeric unlock times in validation metadata', () => {
    for (const unlockAt of [-123456789, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      let thrown: unknown;
      try {
        buildVaultOperationPreview({
          operation: 'createLock',
          wallet,
          amount: '4',
          unlockAt,
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(PocketPayError);
      expect(thrown).toMatchObject({
        code: 'INVALID_OPERATION',
        validation: {
          field: 'unlockAt',
          reason: 'invalid_timestamp',
        },
      });
      expect((thrown as PocketPayError).validation).not.toHaveProperty('value');
      expect(JSON.stringify(thrown)).not.toContain(String(unlockAt));
    }
  });

  it('rejects a lock preview whose unlock time is already in the past', () => {
    let thrown: unknown;
    try {
      buildVaultOperationPreview({
        operation: 'createLock',
        wallet,
        amount: '4',
        unlockAt: 1,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PocketPayError);
    expect(thrown).toMatchObject({
      code: 'INVALID_OPERATION',
      validation: {
        field: 'unlockAt',
        reason: 'not_future',
      },
    });
    expect((thrown as PocketPayError).validation).not.toHaveProperty('value');
  });

  it('returns a typed validation error for an unknown runtime operation', () => {
    let thrown: unknown;
    try {
      buildVaultOperationPreview({
        operation: 'not-a-vault-operation' as never,
        wallet,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PocketPayError);
    expect(thrown).toMatchObject({
      code: 'INVALID_OPERATION',
      validation: {
        field: 'operation',
        reason: 'unsupported_value',
      },
    });
    expect((thrown as PocketPayError).validation).not.toHaveProperty('value');
  });

  it('never serializes sensitive malformed operation, wallet or amount values', () => {
    const privateValue = 'private-token-credential-1234567890';
    const candidates = [
      { operation: privateValue, wallet } as never,
      { operation: 'deposit', wallet: privateValue, amount: '1' } as never,
      { operation: 'deposit', wallet, amount: privateValue } as never,
    ];
    for (const candidate of candidates) {
      let thrown: unknown;
      try {
        buildVaultOperationPreview(candidate);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(PocketPayError);
      expect(JSON.stringify(thrown)).not.toContain(privateValue);
      expect((thrown as Error).message).not.toContain(privateValue);
      expect((thrown as PocketPayError).validation).not.toHaveProperty('value');
    }
    let precision: unknown;
    try {
      buildVaultOperationPreview({ operation: 'deposit', wallet, amount: '0.12345678' });
    } catch (error) {
      precision = error;
    }
    expect(precision).toMatchObject({
      code: 'INVALID_AMOUNT_PRECISION',
      validation: { field: 'amount', reason: 'too_precise' },
    });
    expect((precision as PocketPayError).validation).not.toHaveProperty('value');
  });

  it('returns the SDK typed validation error for a malformed public key', () => {
    expect(() =>
      buildVaultOperationPreview({ operation: 'deposit', wallet: 'GINVALID', amount: '1' }),
    ).toThrow(PocketPayError);
  });

  it('rejects secret-like wallet input without echoing it in the typed error', () => {
    const secret = StellarSDK.Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9)).secret();
    const malformedSecret = `S${'A'.repeat(54)}`;

    for (const secretLike of [secret, malformedSecret]) {
      let thrown: unknown;

      try {
        buildVaultOperationPreview({
          operation: 'deposit',
          wallet: secretLike,
          amount: '1',
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(PocketPayError);
      expect(thrown).toMatchObject({
        code: 'INVALID_PUBLIC_KEY',
        validation: {
          field: 'publicKey',
          reason: 'secret_key_not_allowed',
        },
      });
      expect((thrown as PocketPayError).validation).not.toHaveProperty('value');
      expect((thrown as Error).message).not.toContain(secretLike);
      expect(JSON.stringify(thrown)).not.toContain(secretLike);
    }
  });

  it('returns typed invalid-input errors for non-object preview parameters', () => {
    for (const malformed of [null, undefined, false, 7, [], 'deposit']) {
      let thrown: unknown;
      try {
        buildVaultOperationPreview(malformed as never);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(PocketPayError);
      expect(thrown).toMatchObject({
        code: 'INVALID_OPERATION',
        validation: { field: 'params', reason: 'invalid_type' },
      });
      expect((thrown as PocketPayError).validation).not.toHaveProperty('value');
    }
  });

  it('does not echo arbitrary runtime wallet objects into validation errors', () => {
    const secret = StellarSDK.Keypair.fromRawEd25519Seed(Buffer.alloc(32, 11)).secret();
    let thrown: unknown;
    try {
      buildVaultOperationPreview({
        operation: 'deposit',
        wallet: { privateInput: secret } as never,
        amount: '1',
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PocketPayError);
    expect(thrown).toMatchObject({
      code: 'INVALID_PUBLIC_KEY',
      validation: { field: 'publicKey', reason: 'not_a_string' },
    });
    expect((thrown as PocketPayError).validation).not.toHaveProperty('value');
    expect(JSON.stringify(thrown)).not.toContain(secret);
  });

  it('rejects invalid runtime amount types and secret-shaped amounts safely', () => {
    const secret = StellarSDK.Keypair.fromRawEd25519Seed(Buffer.alloc(32, 13)).secret();
    for (const amount of [undefined, Symbol('invalid'), { privateInput: secret }, secret]) {
      let thrown: unknown;
      try {
        buildVaultOperationPreview({ operation: 'deposit', wallet, amount } as never);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(PocketPayError);
      expect(thrown).toMatchObject({
        code: 'INVALID_AMOUNT',
        validation: { field: 'amount' },
      });
      expect((thrown as PocketPayError).validation).not.toHaveProperty('value');
      expect(JSON.stringify(thrown)).not.toContain(secret);
    }
  });

  it('snapshots stateful preview getters exactly once before building review output', () => {
    const privateValue = 'private-token-after-validation';
    const reads = { operation: 0, wallet: 0, amount: 0 };
    const params: Record<string, unknown> = {};

    Object.defineProperties(params, {
      operation: {
        enumerable: true,
        get() {
          reads.operation += 1;
          return reads.operation === 1 ? 'deposit' : privateValue;
        },
      },
      wallet: {
        enumerable: true,
        get() {
          reads.wallet += 1;
          return reads.wallet === 1 ? wallet : privateValue;
        },
      },
      amount: {
        enumerable: true,
        get() {
          reads.amount += 1;
          return reads.amount === 1 ? '1.25' : privateValue;
        },
      },
    });

    const preview = buildVaultOperationPreview(params as never);

    expect(reads).toEqual({ operation: 1, wallet: 1, amount: 1 });
    expect(preview).toMatchObject({
      operation: 'deposit',
      wallet,
      amount: '1.25',
    });
    expect(JSON.stringify(preview)).not.toContain(privateValue);
  });

  it('converts throwing preview getters into typed non-leaking errors', () => {
    const privateValue = 'private-token-from-throwing-getter';
    const params: Record<string, unknown> = {
      operation: 'deposit',
      wallet,
    };

    Object.defineProperty(params, 'amount', {
      enumerable: true,
      get() {
        throw new Error(privateValue);
      },
    });

    let thrown: unknown;
    try {
      buildVaultOperationPreview(params as never);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PocketPayError);
    expect(thrown).toMatchObject({
      code: 'INVALID_OPERATION',
      validation: { field: 'amount', reason: 'unreadable' },
    });
    expect((thrown as Error).message).not.toContain(privateValue);
    expect(JSON.stringify(thrown)).not.toContain(privateValue);
  });

  it('returns the SDK typed validation error when a write preview has no amount', () => {
    expect(() =>
      buildVaultOperationPreview({ operation: 'withdraw', wallet } as never),
    ).toThrow(PocketPayError);
  });
});
