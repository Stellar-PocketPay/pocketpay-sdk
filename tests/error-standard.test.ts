/**
 * Error standard tests (issue #260)
 * Verifies the public error code taxonomy: stable codes, categories, safe
 * messages, redaction of secrets, and retryability.
 */

import { describe, it, expect } from 'vitest';
import {
  ErrorCategory,
  ErrorCode,
  ERROR_CODES,
  isKnownErrorCode,
  describeError,
  getErrorCategory,
  redactSensitive,
  redactError,
  isRetryableCode,
} from '../src/errors';
import { classifySubmitError } from '../src/errors';
import { PocketPayError } from '../src/types';

// Build a realistic Stellar-secret-shaped string at runtime so no static
// high-entropy literal is committed to the repo (avoids secret scanners).
const makeFakeKey = () =>
  'S' + 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'.repeat(2).slice(0, 55);

describe('error code standard', () => {
  it('exposes a stable, non-empty registry', () => {
    const codes = Object.values(ErrorCode);
    expect(codes.length).toBeGreaterThan(20);
    for (const code of codes) {
      const spec = ERROR_CODES[code as keyof typeof ERROR_CODES];
      expect(spec).toBeDefined();
      expect(spec.category).toBeTruthy();
      expect(typeof spec.retryable).toBe('boolean');
      expect(spec.safeMessage).toBeTruthy();
      expect(spec.developerHint).toBeTruthy();
    }
  });

  it('classifies codes into the expected categories', () => {
    expect(getErrorCategory(ErrorCode.WALLET_SECRET_EXPOSED)).toBe(ErrorCategory.Wallet);
    expect(getErrorCategory(ErrorCode.PAYMENT_SELF)).toBe(ErrorCategory.Payment);
    expect(getErrorCategory(ErrorCode.TX_EXPIRED)).toBe(ErrorCategory.Transaction);
    expect(getErrorCategory(ErrorCode.NET_RATE_LIMITED)).toBe(ErrorCategory.Network);
    expect(getErrorCategory(ErrorCode.SOROBAN_CONTRACT_ERROR)).toBe(ErrorCategory.Soroban);
    expect(getErrorCategory(ErrorCode.VAULT_DEPOSIT_FAILED)).toBe(ErrorCategory.Vault);
  });

  it('reports retryability per the standard', () => {
    expect(isRetryableCode(ErrorCode.NET_RATE_LIMITED)).toBe(true);
    expect(isRetryableCode(ErrorCode.NET_TIMEOUT)).toBe(true);
    expect(isRetryableCode(ErrorCode.TX_EXPIRED)).toBe(false);
    expect(isRetryableCode(ErrorCode.PAYMENT_SELF)).toBe(false);
  });

  it('safe messages never contain secret keys', () => {
    for (const code of Object.values(ErrorCode)) {
      const spec = ERROR_CODES[code as keyof typeof ERROR_CODES];
      expect(spec.safeMessage).not.toMatch(/[S][A-Za-z0-9]{10,}/);
    }
  });

  it('describeError returns SDK defaults for unknown codes', () => {
    const d = describeError('TOTALLY_UNKNOWN');
    expect(d.known).toBe(false);
    expect(d.category).toBe(ErrorCategory.SDK);
    expect(d.safeMessage).toBeTruthy();
  });

  it('isKnownErrorCode discriminates known vs unknown', () => {
    expect(isKnownErrorCode(ErrorCode.VAULT_WITHDRAW_FAILED)).toBe(true);
    expect(isKnownErrorCode('NOPE')).toBe(false);
  });
});

describe('redaction', () => {
  it('redacts Stellar secret keys', () => {
    const fakeKey = makeFakeKey();
    const redacted = redactSensitive(`secret is ${fakeKey} done`);
    expect(redacted).not.toContain(fakeKey);
    expect(redacted).toContain('[REDACTED_SECRET]');
  });

  it('redactError strips secrets from a PocketPayError message', () => {
    const fakeKey = makeFakeKey();
    const err = new PocketPayError(`leaked ${fakeKey}`, ErrorCode.SDK_INTERNAL);
    const safe = redactError(err);
    expect(safe.message).not.toContain(fakeKey);
    expect(safe.code).toBe(ErrorCode.SDK_INTERNAL);
    expect(safe.safeMessage).toBeTruthy();
  });

  it('redactError works on non-PocketPayError values', () => {
    const fakeKey = makeFakeKey();
    const safe = redactError(new Error(`oops ${fakeKey}`));
    expect(safe.message).not.toContain(fakeKey);
    expect(safe.category).toBe(ErrorCategory.SDK);
  });

  it('never leaks malformed typed metadata or evaluates throwing diagnostic getters', () => {
    const secret = makeFakeKey();
    const malformed = new PocketPayError('Safe error', ErrorCode.SDK_INTERNAL);
    Object.defineProperty(malformed, 'statusCode', {
      value: { diagnostic: secret },
      configurable: true,
    });
    Object.defineProperty(malformed, 'transactionHash', {
      value: { diagnostic: secret },
      configurable: true,
    });
    for (const field of ['name', 'message', 'code']) {
      Object.defineProperty(malformed, field, {
        configurable: true,
        get() { throw new Error(`Unsafe diagnostic ${secret}`); },
      });
    }

    const safe = redactError(malformed);
    expect(safe).toMatchObject({
      name: 'PocketPayError',
      code: ErrorCode.SDK_INTERNAL,
      message: 'An unexpected error occurred.',
      safeMessage: expect.any(String),
    });
    expect(safe.statusCode).toBeUndefined();
    expect(safe.transactionHash).toBeUndefined();
    expect(JSON.stringify(safe)).not.toContain(secret);

    const plain = new Error('Benign');
    Object.defineProperty(plain, 'name', {
      get() { throw new Error(secret); },
    });
    expect(redactError(plain)).toMatchObject({
      name: 'Error', message: 'Benign',
    });
  });

  it('redacts raw thrown strings and custom metadata but preserves real transaction hashes', () => {
    const fakeKey = makeFakeKey();
    expect(redactError(`failure: ${fakeKey}`).message).not.toContain(fakeKey);

    // Public error-code fields must not leak arbitrary values passed to the constructor.
    const unrecognizedCode = new PocketPayError('failed', `UNREGISTERED_${fakeKey}`);
    const redactedCode = redactError(unrecognizedCode);
    expect(redactedCode.code).toBe(ErrorCode.SDK_INTERNAL);
    expect(JSON.stringify(redactedCode)).not.toContain(fakeKey);

    const unexpected = new Error('failed');
    unexpected.name = `SDKError_${fakeKey}`;
    expect(redactError(unexpected).name).not.toContain(fakeKey);

    const untrustedHash = new PocketPayError('failed', ErrorCode.SDK_INTERNAL,
      undefined, undefined, fakeKey);
    expect(redactError(untrustedHash).transactionHash).not.toContain(fakeKey);

    const validHash = 'a'.repeat(64);
    const valid = new PocketPayError('failed', ErrorCode.SDK_INTERNAL,
      undefined, undefined, validHash);
    expect(redactError(valid).transactionHash).toBe(validHash);

    const unprintable = { toString: () => { throw new Error('toString failed'); } };
    expect(redactError(unprintable).message).toBe('Unable to format thrown error value.');
  });
});

describe('classifySubmitError taxonomy wiring', () => {
  it('maps a 429 to NET_RATE_LIMITED and marks it retryable', () => {
    const err = classifySubmitError({ response: { status: 429 } });
    expect(err.code).toBe(ErrorCode.NET_RATE_LIMITED);
    expect(err.category).toBe(ErrorCategory.Network);
    expect(err.retryable).toBe(true);
    expect(err.safeMessage).toBeTruthy();
  });

  it('maps a timeout to TX_STATUS_UNKNOWN', () => {
    const err = classifySubmitError({ code: 'ETIMEDOUT' }, 'abc');
    expect(err.code).toBe(ErrorCode.TX_STATUS_UNKNOWN);
    expect(err.category).toBe(ErrorCategory.Transaction);
  });

  it('redacts secrets leaking from raw submission errors', () => {
    const fakeKey = makeFakeKey();
    const err = classifySubmitError(new Error(`boom ${fakeKey}`));
    expect(err.message).not.toContain(fakeKey);
  });
});
