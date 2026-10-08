import { describe, expect, it } from 'vitest';
import { StrKey } from '@stellar/stellar-sdk';
import {
  PocketPayError,
  createWallet,
  enhancedImportWallet,
  getPublicKey,
  importWallet,
  safeEnhancedImportWallet,
  safeImportWallet,
  validateWalletImportInput,
  validateSecretKey,
} from '../src';
import { sanitizeWalletImportError } from '../src/wallet/importValidation';

function invalidReason(input: unknown): string {
  try {
    importWallet(input as string);
    throw new Error('Expected import to reject invalid material');
  } catch (error) {
    expect(error).toBeInstanceOf(PocketPayError);
    const failure = error as PocketPayError;
    expect(failure.code).toBe('INVALID_SECRET_KEY');
    expect(failure.cause).toBeUndefined();
    expect(failure.validation?.field).toBe('secretKey');
    expect(failure.validation?.value).toBeUndefined();
    return failure.validation?.reason ?? '';
  }
}

describe('wallet import hardening (#334)', () => {
  it('imports and derives public keys from valid secrets with harmless whitespace', () => {
    const existing = createWallet();
    expect(validateWalletImportInput(existing.secretKey)).toBe(true);
    expect(importWallet(' \n' + existing.secretKey + '\t').publicKey).toBe(existing.publicKey);
    expect(getPublicKey(existing.secretKey)).toBe(existing.publicKey);
  });

  it('rejects G public addresses as public-key-only, not malformed seed material', () => {
    const existing = createWallet();
    expect(invalidReason(existing.publicKey)).toBe('public_key_only');
    const result = enhancedImportWallet(existing.publicKey);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.validation?.reason).toBe('public_key_only');
      expect(result.recoveryHints?.[0]?.message).toMatch(/public address/i);
      expect(JSON.stringify(result.error)).not.toContain(existing.publicKey);
    }
  });

  it('distinguishes empty/nonstring, valid non-secret material, and malformed lookalikes', () => {
    expect(invalidReason('  ')).toBe('missing');
    for (const input of [undefined, null, false, 0, { toString() { throw new Error('Do not invoke'); } }]) {
      expect(invalidReason(input)).toBe('not_a_string');
    }

    const muxed = StrKey.encodeMed25519PublicKey(Buffer.alloc(40));
    const contract = StrKey.encodeContract(Buffer.alloc(32));
    expect(invalidReason(muxed)).toBe('unsupported_account_material');
    expect(invalidReason(contract)).toBe('unsupported_account_material');

    expect(invalidReason('G' + 'A'.repeat(55))).toBe('invalid_format');
    expect(invalidReason('M' + 'A'.repeat(55))).toBe('invalid_format');
    expect(invalidReason('C' + 'A'.repeat(55))).toBe('invalid_format');
    expect(invalidReason('B' + 'A'.repeat(55))).toBe('unsupported_format');
  });

  it('rejects malformed secret lengths and checksum and never prints their values', () => {
    const badLength = 'S123';
    const badChecksum = 'S' + '0'.repeat(55);
    expect(invalidReason(badLength)).toBe('invalid_length');
    expect(invalidReason(badChecksum)).toBe('invalid_format');
    const result = safeImportWallet(badChecksum);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).not.toContain(badChecksum);
      expect(JSON.stringify(result.error)).not.toContain(badChecksum);
    }
  });

  it('sanitizes even unexpected malicious raw SDK failures and error causes', () => {
    const marker = 'SENSITIVE_SIGNING_MATERIAL_IN_CAUSE';
    const raw = new PocketPayError(marker, 'INVALID_SECRET_KEY', {
      validation: { field: 'secretKey', reason: 'invalid_format', value: marker },
      cause: new Error(marker),
    });
    const sanitized = sanitizeWalletImportError(raw);
    expect(sanitized).toBeInstanceOf(PocketPayError);
    expect(sanitized.code).toBe('INVALID_SECRET_KEY');
    expect(sanitized.validation?.reason).toBe('invalid_format');
    expect(sanitized.validation?.value).toBeUndefined();
    expect(sanitized.cause).toBeUndefined();
    expect(JSON.stringify(sanitized)).not.toContain(marker);
    const unknown = sanitizeWalletImportError(new Error(marker));
    expect(unknown.validation?.reason).toBe('import_failed');
    expect(unknown.message).not.toContain(marker);
    expect(unknown.cause).toBeUndefined();
  });

  it('never throws when malformed typed error properties contain throwing getters', () => {
    const secretMarker = 'SECRET_FROM_UNTRUSTED_SDK_METADATA';
    const maliciousReason = new PocketPayError('bad input', 'INVALID_SECRET_KEY');
    Object.defineProperty(maliciousReason, 'validation', {
      value: { field: 'secretKey', get reason() { throw new Error(secretMarker); } },
    });

    const malformedCode = new PocketPayError('bad input', 'INVALID_SECRET_KEY');
    Object.defineProperty(malformedCode, 'code', {
      get() { throw new Error(secretMarker); },
    });

    const maliciousProxy = new Proxy(new PocketPayError('bad input', 'INVALID_SECRET_KEY'), {
      get(target, property) {
        if (property === 'validation') throw new Error(secretMarker);
        return Reflect.get(target, property);
      },
    });

    for (const error of [maliciousReason, malformedCode, maliciousProxy]) {
      const sanitized = sanitizeWalletImportError(error);
      expect(sanitized).toBeInstanceOf(PocketPayError);
      expect(sanitized.code).toBe('INVALID_SECRET_KEY');
      expect(sanitized.validation?.reason).toBe('import_failed');
      expect(sanitized.validation?.value).toBeUndefined();
      expect(sanitized.cause).toBeUndefined();
      expect(JSON.stringify(sanitized)).not.toContain(secretMarker);
    }
  });

  it('safe and enhanced APIs consistently return typed failures instead of throwing', () => {
    const publicOnly = createWallet().publicKey;
    const safe = safeImportWallet(publicOnly);
    const enhanced = safeEnhancedImportWallet(publicOnly);
    expect(safe.ok).toBe(false);
    expect(enhanced.ok).toBe(false);
    if (!safe.ok) expect(safe.error.validation?.reason).toBe('public_key_only');
    if (!enhanced.ok) expect(enhanced.error.validation?.reason).toBe('public_key_only');
  });

  it('does not mutate an existing SDK-created wallet after a rejected import', () => {
    const existing = createWallet();
    expect(invalidReason('S' + '0'.repeat(55))).toBe('invalid_format');
    expect(getPublicKey(existing.secretKey)).toBe(existing.publicKey);
    const replayed = importWallet(existing.secretKey);
    expect(replayed.publicKey).toBe(existing.publicKey);
    expect(replayed.secretKey).toBe(existing.secretKey);
  });

  it('preserves the legacy generic validator reason contract', () => {
    try {
      validateSecretKey('G' + 'A'.repeat(55));
      throw new Error('Expected legacy validation rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(PocketPayError);
      expect((error as PocketPayError).validation?.reason).toBe('invalid_prefix');
    }
  });
});
