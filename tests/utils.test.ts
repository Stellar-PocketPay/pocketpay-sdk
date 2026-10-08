/**
 * Tests for the Utils module.
 */

import { describe, it, expect } from 'vitest';
import {
  validatePublicKey,
  validateSecretKey,
  validateAmount,
  validateMemo,
  validateTransactionHash,
  stroopsToXLM,
  xlmToStroops,
  truncateAddress,
  redactSecretKey,
  redactSensitiveValue,
  redactSensitive,
  PocketPayError,
  createWallet,
} from '../src';

describe('Utils Module', () => {
  describe('validatePublicKey', () => {
    it('should accept a valid public key', () => {
      const wallet = createWallet();
      expect(validatePublicKey(wallet.publicKey)).toBe(true);
    });

    it('should throw for an invalid public key', () => {
      expect(() => validatePublicKey('GINVALID')).toThrow(PocketPayError);
    });

    it('should throw for a secret key passed as public key', () => {
      const wallet = createWallet();
      expect(() => validatePublicKey(wallet.secretKey)).toThrow(PocketPayError);
    });
  });

  describe('validateSecretKey', () => {
    it('should accept a valid secret key', () => {
      const wallet = createWallet();
      expect(validateSecretKey(wallet.secretKey)).toBe(true);
    });

    it('should throw for an invalid secret key', () => {
      expect(() => validateSecretKey('SINVALID')).toThrow(PocketPayError);
    });

    it('should never include secret key value in error metadata', () => {
      const secretKey = 'SABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
      expect(() => validateSecretKey('invalid')).toThrow(PocketPayError);
      try {
        validateSecretKey('invalid');
      } catch (error) {
        expect(error).toBeInstanceOf(PocketPayError);
        const err = error as PocketPayError;
        // Secret key should never appear in error message
        expect(err.message).not.toContain(secretKey);
        // Secret key should never appear in validation metadata
        if (err.validation) {
          expect(err.validation.value).not.toBe(secretKey);
        }
      }
    });
  });

  describe('validateAmount', () => {
    it('should accept valid amounts', () => {
      expect(validateAmount('10')).toBe(true);
      expect(validateAmount('0.001')).toBe(true);
      expect(validateAmount('100.1234567')).toBe(true);
    });

    it('should accept the smallest valid amount (7 decimals)', () => {
      expect(validateAmount('0.0000001')).toBe(true);
    });

    it('should accept a normal valid amount', () => {
      expect(validateAmount('1234.5')).toBe(true);
    });

    it('should reject zero', () => {
      expect(() => validateAmount('0')).toThrow(PocketPayError);
    });

    it('should reject negative amounts', () => {
      expect(() => validateAmount('-5')).toThrow(PocketPayError);
    });

    it('should reject non-numeric strings', () => {
      expect(() => validateAmount('abc')).toThrow(PocketPayError);
    });

    it('should reject empty string', () => {
      expect(() => validateAmount('')).toThrow(PocketPayError);
    });

    it('should reject whitespace-only', () => {
      expect(() => validateAmount('   ')).toThrow(PocketPayError);
    });

    it('should reject numbers with trailing garbage', () => {
      expect(() => validateAmount('10abc')).toThrow(PocketPayError);
    });

    it('should reject scientific notation', () => {
      expect(() => validateAmount('1e3')).toThrow(PocketPayError);
    });

    it('should reject Infinity', () => {
      expect(() => validateAmount('Infinity')).toThrow(PocketPayError);
    });

    it('should reject amounts with leading/trailing whitespace', () => {
      expect(() => validateAmount('  10  ')).toThrow(PocketPayError);
    });

    it('should reject amounts with too many decimals', () => {
      expect(() => validateAmount('1.12345678')).toThrow(PocketPayError);
    });

    it('should throw INVALID_AMOUNT_PRECISION for over-precision', () => {
      expect(() => validateAmount('1.12345678')).toThrow(
        expect.objectContaining({ code: 'INVALID_AMOUNT_PRECISION' })
      );
    });
    it('rejects values above the signed int64 stroop limit', () => {
      expect(validateAmount('922337203685.4775807')).toBe(true);
      expect(() => validateAmount('922337203685.4775808')).toThrow(
        expect.objectContaining({
          code: 'INVALID_AMOUNT',
          validation: expect.objectContaining({ reason: 'exceeds_maximum' }),
        })
      );
      expect(() => validateAmount('922337203686')).toThrow(
        expect.objectContaining({ code: 'INVALID_AMOUNT' })
      );
    });
  });

  describe('validateMemo', () => {
    it('should accept an undefined memo', () => {
      expect(validateMemo(undefined)).toBe(true);
    });

    it('should accept an empty string memo', () => {
      expect(validateMemo('')).toBe(true);
    });

    it('should accept a valid short memo', () => {
      expect(validateMemo('Invoice #1234')).toBe(true);
    });

    it('should accept a memo exactly at the 28-byte limit', () => {
      const memo = 'a'.repeat(28);
      expect(validateMemo(memo)).toBe(true);
    });

    it('should reject a memo exceeding 28 bytes', () => {
      const memo = 'This memo is way too long and exceeds the twenty eight byte limit!';
      expect(() => validateMemo(memo)).toThrow(PocketPayError);
      expect(() => validateMemo(memo)).toThrow('Memo text exceeds 28-byte limit');
    });

    it('should reject a memo one byte over the limit', () => {
      const memo = 'a'.repeat(29);
      expect(() => validateMemo(memo)).toThrow(PocketPayError);
    });

    it('should measure Unicode memos by byte length, not character length', () => {
      // Each '🚀' is 4 bytes in UTF-8, so 7 of them is 28 bytes — right at the limit.
      const atLimit = '🚀'.repeat(7);
      expect(Buffer.byteLength(atLimit, 'utf-8')).toBe(28);
      expect(validateMemo(atLimit)).toBe(true);

      // 8 of them is 32 bytes — over the limit, even though it's only 8 characters.
      const overLimit = '🚀'.repeat(8);
      expect(() => validateMemo(overLimit)).toThrow(PocketPayError);
    });

    it('should reject accented/multi-byte Unicode memos that exceed the byte limit', () => {
      // 'é' is 2 bytes in UTF-8; 15 of them is 30 bytes, over the 28-byte limit,
      // despite being only 15 characters.
      const memo = 'é'.repeat(15);
      expect(() => validateMemo(memo)).toThrow(PocketPayError);
    });
  });

  describe('stroopsToXLM', () => {
    it('should convert stroops to XLM', () => {
      expect(stroopsToXLM(10000000)).toBe('1.0000000');
      expect(stroopsToXLM('50000000')).toBe('5.0000000');
      expect(stroopsToXLM(1)).toBe('0.0000001');
    });
  });

  describe('xlmToStroops', () => {
    it('should convert XLM to stroops', () => {
      expect(xlmToStroops('1')).toBe(10000000);
      expect(xlmToStroops(0.5)).toBe(5000000);
      expect(xlmToStroops('0.0000001')).toBe(1);
    });
  });

  describe('redactSecretKey', () => {
    it('should redact a valid Stellar secret key', () => {
      const wallet = createWallet();
      const redacted = redactSecretKey(wallet.secretKey);
      expect(redacted).toMatch(/^S.../);
      expect(redacted).toMatch(/\.\.\./);
      // Should contain first 4 and last 4 characters
      expect(redacted).toBe(
        `${wallet.secretKey.slice(0, 4)}...${wallet.secretKey.slice(-4)}`
      );
    });

    it('should never expose the full secret key', () => {
      const wallet = createWallet();
      const redacted = redactSecretKey(wallet.secretKey);
      expect(redacted).not.toBe(wallet.secretKey);
      expect(redacted).not.toContain(wallet.secretKey.slice(4, -4));
    });

    it('should return "(empty)" for an empty string', () => {
      expect(redactSecretKey('')).toBe('(empty)');
    });

    it('should return "(empty)" for whitespace-only string', () => {
      expect(redactSecretKey('   ')).toBe('(empty)');
      expect(redactSecretKey('\t')).toBe('(empty)');
      expect(redactSecretKey('\n')).toBe('(empty)');
    });

    it('should return string as-is if already redacted (idempotent)', () => {
      expect(redactSecretKey('SC4M...CK4L')).toBe('SC4M...CK4L');
      expect(redactSecretKey('S...Z')).toBe('S...Z');
      expect(redactSecretKey('abc...xyz')).toBe('abc...xyz');
    });

    it('should return short strings (≤8 chars) as-is', () => {
      expect(redactSecretKey('short')).toBe('short');
      expect(redactSecretKey('12345678')).toBe('12345678');
      expect(redactSecretKey('S')).toBe('S');
    });

    it('should redact non-secret-key strings consistently', () => {
      // The utility does NOT validate — it just truncates
      // 'SINVALID' is exactly 8 chars, so it's returned as-is (short string)
      expect(redactSecretKey('SINVALID')).toBe('SINVALID');
      expect(redactSecretKey('not_a_secret_key_at_all')).toBe('not_..._all');
      expect(redactSecretKey('some_random_long_string')).toBe('some...ring');
    });

    it('should handle a secret key with the same prefix/suffix pattern as a real one', () => {
      const fakeKey = 'SABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV';
      const redacted = redactSecretKey(fakeKey);
      expect(redacted).toBe('SABC...STUV');
      expect(redacted).toContain('...');
      expect(redacted).not.toBe(fakeKey);
    });
  });

  describe('redactSensitiveValue', () => {
    it('should redact with default 4…4', () => {
      expect(redactSensitiveValue('abcdefghijklmnop')).toBe('abcd...mnop');
    });

    it('should redact with custom showFirst/showLast', () => {
      expect(redactSensitiveValue('abcdefghijklmnop', 2, 6)).toBe('ab...klmnop');
    });

    it('should return "(empty)" for empty string', () => {
      expect(redactSensitiveValue('')).toBe('(empty)');
    });

    it('should return "(empty)" for whitespace-only', () => {
      expect(redactSensitiveValue('   ')).toBe('(empty)');
    });

    it('should return as-is if already redacted (idempotent)', () => {
      expect(redactSensitiveValue('abcd...wxyz')).toBe('abcd...wxyz');
      expect(redactSensitiveValue('a...b')).toBe('a...b');
    });

    it('should return short values as-is', () => {
      expect(redactSensitiveValue('abc')).toBe('abc');
      expect(redactSensitiveValue('12345678')).toBe('12345678');
    });

    it('should not throw on any input', () => {
      // @ts-expect-error - testing runtime behavior
      expect(() => redactSensitiveValue(null)).not.toThrow();
      // @ts-expect-error - testing runtime behavior
      expect(() => redactSensitiveValue(undefined)).not.toThrow();
      expect(() => redactSensitiveValue('any-value')).not.toThrow();
    });
  });

  describe('truncateAddress', () => {
    /**
     * Test Suite: truncateAddress utility for UI display
     *
     * Purpose: Ensure public keys are displayed consistently and safely
     * Output Format: "PREFIX...SUFFIX" where PREFIX and SUFFIX are configurable
     */

    describe('Valid Stellar public keys', () => {
      it('should truncate a valid Stellar public key with default params (4...4)', () => {
        const stellarKey = 'GBRPYHIL2CI3WHZDTOOQFC6EB4NCCCVKVPOA77RLAWYDOWYBXVVKWZ7';
        const truncated = truncateAddress(stellarKey);
        expect(truncated).toBe('GBRP...KWZ7');
      });

      it('should truncate a valid Stellar public key with custom params', () => {
        const stellarKey = 'GBRPYHIL2CI3WHZDTOOQFC6EB4NCCCVKVPOA77RLAWYDOWYBXVVKWZ7';
        const truncated = truncateAddress(stellarKey, 6, 6);
        expect(truncated).toBe('GBRPYH...VVKWZ7');
      });

      it('should maintain consistency across multiple calls', () => {
        const stellarKey = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV';
        const result1 = truncateAddress(stellarKey);
        const result2 = truncateAddress(stellarKey);
        expect(result1).toBe(result2);
      });

      it('should preserve the ellipsis separator in output', () => {
        const addr = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV';
        const truncated = truncateAddress(addr);
        expect(truncated).toContain('...');
      });
    });

    describe('Short strings', () => {
      it('should return string as-is when equal to startChars + endChars', () => {
        expect(truncateAddress('ABCDEFGH', 4, 4)).toBe('ABCDEFGH');
      });

      it('should return short strings unchanged', () => {
        expect(truncateAddress('ABCD')).toBe('ABCD');
        expect(truncateAddress('AB')).toBe('AB');
        expect(truncateAddress('A')).toBe('A');
      });

      it('should handle strings shorter than default threshold', () => {
        const shortAddr = 'GABC';
        expect(truncateAddress(shortAddr)).toBe('GABC');
      });

      it('should return string as-is when shorter than requested char count', () => {
        const addr = 'GABCDE';
        expect(truncateAddress(addr, 6, 6)).toBe('GABCDE');
      });
    });

    describe('Empty and edge case values', () => {
      it('should handle empty string', () => {
        expect(truncateAddress('')).toBe('');
      });

      it('should handle single character', () => {
        expect(truncateAddress('G')).toBe('G');
      });

      it('should handle exactly 8 characters with default params', () => {
        const addr = 'GABCDEFG';
        expect(truncateAddress(addr)).toBe('GABCDEFG');
      });

      it('should truncate when string length exceeds startChars + endChars', () => {
        const addr = 'GABCDEFGH'; // 9 chars
        const truncated = truncateAddress(addr, 4, 4);
        expect(truncated).toBe('GABC...EFGH');
      });
    });

    describe('Custom truncation lengths', () => {
      it('should support custom start char count', () => {
        const addr = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV';
        const truncated = truncateAddress(addr, 8, 4);
        expect(truncated).toBe('GABCDEFG...STUV');
      });

      it('should support custom end char count', () => {
        const addr = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV';
        const truncated = truncateAddress(addr, 4, 8);
        expect(truncated).toBe('GABC...OPQRSTUV');
      });

      it('should support custom start and end char counts', () => {
        const addr = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV';
        const truncated = truncateAddress(addr, 6, 6);
        expect(truncated).toBe('GABCDE...QRSTUV');
      });

      it('should respect asymmetric char counts', () => {
        const addr = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV';
        const truncated = truncateAddress(addr, 2, 10);
        expect(truncated).toBe('GA...MNOPQRSTUV');
      });

      it('should handle large custom char counts', () => {
        const addr = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV';
        const truncated = truncateAddress(addr, 20, 20);
        // Address is 55 chars; 20+20=40 < 55, so it will truncate
        expect(truncated).toBe('GABCDEFGHIJKLMNOPQRS...CDEFGHIJKLMNOPQRSTUV');
      });
    });

    describe('Consistency in mobile UI display', () => {
      it('should produce consistent format for repeated display', () => {
        const addresses = [
          'GBRPYHIL2CI3WHZDTOOQFC6EB4NCCCVKVPOA77RLAWYDOWYBXVVKWZ7',
          'GBRYYMJTMF2R4Z4JTWC7YJCJHMMKLCX4PJQEBK25XMVZGEJ2QGTGJZX',
          'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV',
        ];

        addresses.forEach(addr => {
          const truncated = truncateAddress(addr);
          // All should follow PREFIX...SUFFIX format
          expect(truncated).toMatch(/^.{4}\.\.\..{4}$/);
        });
      });

      it('should produce visually distinct prefixes for different addresses', () => {
        const addr1 = 'GBRPYHIL2CI3WHZDTOOQFC6EB4NCCCVKVPOA77RLAWYDOWYBXVVKWZ7';
        const addr2 = 'GBRYYMJTMF2R4Z4JTWC7YJCJHMMKLCX4PJQEBK25XMVZGEJ2QGTGJZX';

        const truncated1 = truncateAddress(addr1);
        const truncated2 = truncateAddress(addr2);

        expect(truncated1).not.toBe(truncated2);
      });

      it('should preserve start of address which is most identifying', () => {
        const addr = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV';
        const truncated = truncateAddress(addr);
        expect(truncated.startsWith('GABC')).toBe(true);
      });
    });

    describe('Documentation of expected output', () => {
      it('should format output as "PREFIX...SUFFIX" with ellipsis', () => {
        const addr = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV';
        const truncated = truncateAddress(addr);
        expect(truncated).toMatch(/^[^.]*\.\.\.[^.]*$/);
        expect(truncated.split('...').length).toBe(2);
      });

      it('should not double-truncate consecutive calls', () => {
        const addr = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV';
        const truncated1 = truncateAddress(addr);
        const truncated2 = truncateAddress(truncated1);
        expect(truncated1).toBe(truncated2);
      });
    });
  });

  describe('validateTransactionHash', () => {
    it('should accept a valid 64-character hexadecimal hash', () => {
      const valid = 'a'.repeat(64);
      expect(validateTransactionHash(valid)).toBe(true);
    });

    it('should reject hashes with invalid length', () => {
      expect(() => validateTransactionHash('a'.repeat(63))).toThrow(PocketPayError);
      expect(() => validateTransactionHash('a'.repeat(65))).toThrow(PocketPayError);
      expect(() => validateTransactionHash('')).toThrow(PocketPayError);
    });

    it('should reject non-hexadecimal values', () => {
      const invalidHex = 'g'.repeat(64); // 'g' is not a hex character
      expect(() => validateTransactionHash(invalidHex)).toThrow(PocketPayError);

      const mixed = 'z'.repeat(64);
      expect(() => validateTransactionHash(mixed)).toThrow(PocketPayError);
    });
  });

  describe('redactSensitive', () => {
    it('should redact Stellar secret keys (S...)', () => {
      const wallet = createWallet();
      const result = redactSensitive(wallet.secretKey);
      expect(result).toBe('S[REDACTED]');
    });

    it('should redact secret keys embedded in error messages', () => {
      const wallet = createWallet();
      const message = `Failed to sign transaction with secret key: ${wallet.secretKey}`;
      const result = redactSensitive(message);
      expect(result).toBe('Failed to sign transaction with secret key: S[REDACTED]');
    });

    it('should redact multiple secret keys in a single string', () => {
      const wallet1 = createWallet();
      const wallet2 = createWallet();
      const message = `Keys: ${wallet1.secretKey} and ${wallet2.secretKey}`;
      const result = redactSensitive(message);
      expect(result).toBe('Keys: S[REDACTED] and S[REDACTED]');
    });

    it('should not redact public keys (G...)', () => {
      const wallet = createWallet();
      const result = redactSensitive(wallet.publicKey);
      expect(result).toBe(wallet.publicKey);
    });

    it('should not redact non-secret strings', () => {
      const message = 'This is a regular error message without secrets';
      const result = redactSensitive(message);
      expect(result).toBe(message);
    });

    it('should handle empty strings', () => {
      const result = redactSensitive('');
      expect(result).toBe('');
    });

    it('should handle strings without secret keys', () => {
      const message = 'Error: Invalid public key GABC XYZ';
      const result = redactSensitive(message);
      expect(result).toBe(message);
    });
  });
});