import { describe, expect, it } from 'vitest';
import { importWallet, safeImportWallet } from '../src/wallet';
import { signTransaction } from '../src/transactions/offline-preparation';
import { PocketPayError } from '../src/types';
import { toResult, toEnhancedResult, wrapError } from '../src/utils';

// Built at runtime so the repository never contains usable signing material.
// It has the shape of a Stellar secret key but an intentionally invalid checksum.
const makeSyntheticSecret = (): string =>
  `S${'ABCDEFGHJKLMNPQRSTUVWXYZ234567'.repeat(2).slice(0, 55)}`;

function expectSecretAbsent(error: PocketPayError, secret: string): void {
  const exposedText = [
    error.message,
    error.stack,
    error.cause?.message,
    error.cause?.stack,
    JSON.stringify(error),
  ]
    .filter((value): value is string => typeof value === 'string')
    .join('\n');

  expect(exposedText).not.toContain(secret);
}

describe('wallet secret redaction boundaries', () => {
  it('does not expose a rejected import secret in thrown errors', () => {
    const secret = makeSyntheticSecret();

    try {
      importWallet(secret);
      expect.fail('expected importWallet to reject the synthetic secret');
    } catch (error) {
      expect(error).toBeInstanceOf(PocketPayError);
      const pocketError = error as PocketPayError;
      expectSecretAbsent(pocketError, secret);
      expect(pocketError.validation?.value).toBeUndefined();
    }
  });

  it('does not expose a rejected import secret in safe-result metadata', () => {
    const secret = makeSyntheticSecret();
    const result = safeImportWallet(secret);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expectSecretAbsent(result.error, secret);
      expect(result.error.validation?.value).toBeUndefined();
    }
  });

  it('does not expose a rejected signing secret', () => {
    const secret = makeSyntheticSecret();

    try {
      // Secret validation runs before the unsigned transaction is inspected.
      signTransaction({} as never, secret);
      expect.fail('expected signTransaction to reject the synthetic secret');
    } catch (error) {
      expect(error).toBeInstanceOf(PocketPayError);
      expectSecretAbsent(error as PocketPayError, secret);
    }
  });

  it('redacts transaction failure messages, stacks, and returned causes', async () => {
    const secret = makeSyntheticSecret();
    const raw = new Error(`Horizon rejected transaction for ${secret}`);
    raw.stack = `Error: Horizon rejected transaction for ${secret}`;

    const result = await toResult(
      async () => Promise.reject(raw),
      'Failed to submit transaction',
      'TX_SUBMISSION_ERROR',
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expectSecretAbsent(result.error, secret);
      expect(result.error.cause).toBeInstanceOf(Error);
      expect(result.error.cause).not.toBe(raw);
    }
  });

  it('redacts a secret in a non-enumerable error name before returning metadata', async () => {
    const secret = makeSyntheticSecret();
    const raw = new Error('Transaction rejected');
    Object.defineProperty(raw, 'name', { value: `HorizonError ${secret}` });
    raw.stack = 'Error: Transaction rejected';

    // The original JSON has no name field; cloning must not add a secret.
    expect(JSON.stringify(raw)).not.toContain(secret);
    const result = await toResult(
      async () => Promise.reject(raw),
      'Failed to submit transaction',
      'TX_SUBMISSION_ERROR',
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expectSecretAbsent(result.error, secret);
      expect(result.error.cause?.name).toBe('HorizonError S[REDACTED]');
      expect(result.error.code).toBe('TX_SUBMISSION_ERROR');
      expect(result.error.cause).not.toBe(raw);
    }
    expect(raw.name).toBe(`HorizonError ${secret}`);
    expect(raw.stack).toBe('Error: Transaction rejected');
  });

  it('preserves an ordinary cause name, message, stack, and wrapper code', async () => {
    const raw = new TypeError('Invalid transaction shape');
    raw.stack = 'TypeError: Invalid transaction shape';
    const result = await toResult(
      async () => Promise.reject(raw),
      'Failed to submit transaction',
      'TX_SUBMISSION_ERROR',
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('TX_SUBMISSION_ERROR');
      expect(result.error.message).toBe('Failed to submit transaction: Invalid transaction shape');
      expect(result.error.cause).toBeInstanceOf(Error);
      expect(result.error.cause).not.toBe(raw);
      expect(result.error.cause?.name).toBe('TypeError');
      expect(result.error.cause?.message).toBe(raw.message);
      expect(result.error.cause?.stack).toBe(raw.stack);
    }
  });

  it('redacts pretyped PocketPayErrors at safe-result and wrapping boundaries', async () => {
    const secret = makeSyntheticSecret();
    const cause = Object.assign(new Error(`Upstream failure ${secret}`), {
      unsafeDiagnostic: secret,
    });
    const raw = Object.assign(
      new PocketPayError(`Rejected ${secret}`, 'TX_SUBMISSION_ERROR', {
        cause,
        validation: { field: 'secretKey', reason: 'invalid_format', value: secret },
        category: 'wallet',
        safeMessage: `Transaction failed ${secret}`,
        timeout: Object.assign(
          { stage: 'submission' as const, operation: `Waited for ${secret}`, timeoutMs: 1000 },
          { internalSecret: secret },
        ),
      }),
      { extraPayload: { secret } },
    );

    const failed = await toResult(async () => { throw raw; });
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error).not.toBe(raw);
      expect(failed.error.code).toBe('TX_SUBMISSION_ERROR');
      expect(failed.error.validation?.value).toBe('S[REDACTED]');
      expect(failed.error.cause?.message).toContain('S[REDACTED]');
      expect(failed.error.timeout?.operation).toContain('S[REDACTED]');
      expectSecretAbsent(failed.error, secret);
      expect(JSON.stringify(failed)).not.toContain(secret);
      expect(Object.prototype.hasOwnProperty.call(failed.error, 'extraPayload')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(failed.error.cause!, 'unsafeDiagnostic')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(failed.error.timeout!, 'internalSecret')).toBe(false);
    }

    const enhanced = await toEnhancedResult(async () => { throw raw; });
    expect(enhanced.ok).toBe(false);
    if (!enhanced.ok) {
      expectSecretAbsent(enhanced.error, secret);
      expect(JSON.stringify(enhanced)).not.toContain(secret);
    }
    expectSecretAbsent(wrapError(raw, 'Context', 'IGNORED'), secret);
    expect(raw.message).toContain(secret);
    expect(raw.validation?.value).toBe(secret);
  });

  it('does not leak secrets through malformed typed numeric or boolean metadata', async () => {
    const secret = makeSyntheticSecret();
    const raw = new PocketPayError('Safe wrapper', 'TX_SUBMISSION_ERROR', {
      timeout: { stage: 'confirmation', operation: 'confirm', timeoutMs: 1000 },
    });

    // These public readonly types do not prevent malformed JS callers from
    // passing objects with secret-bearing properties at runtime.
    Object.assign(raw, { statusCode: { diagnostic: secret }, retryable: { diagnostic: secret } });
    Object.assign(raw.timeout!, { timeoutMs: { diagnostic: secret } });

    const result = await toResult(async () => { throw raw; });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toBe(raw);
      expect(result.error.code).toBe('TX_SUBMISSION_ERROR');
      expect(result.error.statusCode).toBeUndefined();
      expect(result.error.retryable).toBeUndefined();
      expect(result.error.timeout).toMatchObject({
        stage: 'confirmation', operation: 'confirm', timeoutMs: 0,
      });
      expectSecretAbsent(result.error, secret);
      expect(JSON.stringify(result)).not.toContain(secret);
    }

    // The input object belongs to the caller and must never be rewritten.
    expect(raw.statusCode).toEqual({ diagnostic: secret });
    expect(raw.timeout?.timeoutMs).toEqual({ diagnostic: secret });

    Object.assign(raw, { timeout: secret });
    const malformed = wrapError(raw, 'unused', 'IGNORED');
    expect(malformed.timeout).toBeUndefined();
    expectSecretAbsent(malformed, secret);
  });

  it('returns a safe result when a thrown non-Error refuses string conversion', async () => {
    const secret = makeSyntheticSecret();
    const thrownValue = {
      toString() { throw new Error(`Conversion failed for ${secret}`); },
    };

    const result = await toResult(
      async () => { throw thrownValue; },
      'Failed to submit transaction',
      'TX_SUBMISSION_ERROR',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('TX_SUBMISSION_ERROR');
      expect(result.error.message).toContain('Non-renderable thrown value');
      expectSecretAbsent(result.error, secret);
    }

    const enhanced = await toEnhancedResult(async () => { throw thrownValue; });
    expect(enhanced.ok).toBe(false);
    if (!enhanced.ok) expectSecretAbsent(enhanced.error, secret);
  });

  it('preserves the identity of already-safe typed errors', async () => {
    const raw = new PocketPayError('Ordinary failure', 'ORDINARY_ERROR');
    const result = await toResult(async () => { throw raw; });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(raw);
    expect(wrapError(raw, 'Context', 'IGNORED')).toBe(raw);
  });
});
