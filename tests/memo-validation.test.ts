/**
 * Typed memo validation tests (issue #240).
 *
 * The SDK previously validated only `text` memos, while it could already read
 * `memo_type` back from Horizon. Anything that was not text failed the text
 * byte-length check and reported "Memo text exceeds 28-byte limit", which
 * described the wrong problem. These tests cover all five Stellar memo types,
 * the typed error, and backwards compatibility of the plain-string form.
 */

import { describe, it, expect } from 'vitest';
import * as StellarSDK from '@stellar/stellar-sdk';
import {
  validateMemoInput,
  safeValidateMemo,
  normalizeMemo,
  formatMemoForDisplay,
  buildMemo,
  validateMemo,
  MEMO_TEXT_MAX_BYTES,
  MEMO_HASH_HEX_LENGTH,
  MEMO_ID_MAX,
  SUPPORTED_MEMO_TYPES,
} from '../src/utils';
import { previewPayment } from '../src/payments';
import { PocketPayError } from '../src/types';
import type { MemoInput } from '../src/types';
import { ErrorCode, isKnownErrorCode, describeError, ErrorCategory } from '../src/errors';

const HEX64 = 'a'.repeat(MEMO_HASH_HEX_LENGTH);
const PUBLIC_KEY = StellarSDK.Keypair.random().publicKey();

/** Extracts the thrown PocketPayError so assertions can inspect it. */
const capture = (fn: () => unknown): PocketPayError => {
  try {
    fn();
  } catch (error) {
    return error as PocketPayError;
  }
  throw new Error('expected the call to throw');
};

describe('normalizeMemo', () => {
  it('treats a plain string as a text memo', () => {
    expect(normalizeMemo('invoice #42')).toEqual({ type: 'text', value: 'invoice #42' });
  });

  it('treats undefined and the empty string as no memo', () => {
    expect(normalizeMemo(undefined)).toBeUndefined();
    expect(normalizeMemo('')).toBeUndefined();
  });

  it('passes a structured memo through unchanged', () => {
    const memo: MemoInput = { type: 'id', value: '42' };
    expect(normalizeMemo(memo)).toBe(memo);
  });
});

describe('validateMemoInput — supported types', () => {
  it('accepts no memo', () => {
    expect(validateMemoInput(undefined)).toBe(true);
    expect(validateMemoInput('')).toBe(true);
    expect(validateMemoInput({ type: 'none' })).toBe(true);
  });

  it('accepts a text memo at exactly the byte limit', () => {
    expect(validateMemoInput({ type: 'text', value: 'a'.repeat(MEMO_TEXT_MAX_BYTES) })).toBe(true);
  });

  it('accepts id memos as string, number and bigint', () => {
    expect(validateMemoInput({ type: 'id', value: '12345' })).toBe(true);
    expect(validateMemoInput({ type: 'id', value: 12345 })).toBe(true);
    expect(validateMemoInput({ type: 'id', value: 12345n })).toBe(true);
    expect(validateMemoInput({ type: 'id', value: '0' })).toBe(true);
    expect(validateMemoInput({ type: 'id', value: String(MEMO_ID_MAX) })).toBe(true);
  });

  it('accepts hash and return memos of 64 hex characters', () => {
    expect(validateMemoInput({ type: 'hash', value: HEX64 })).toBe(true);
    expect(validateMemoInput({ type: 'return', value: HEX64.toUpperCase() })).toBe(true);
  });

  it('exposes every Stellar memo type as supported', () => {
    expect([...SUPPORTED_MEMO_TYPES].sort()).toEqual(
      ['hash', 'id', 'none', 'return', 'text'].sort()
    );
  });
});

describe('validateMemoInput — rejected input', () => {
  it('redacts rejected memo payloads from error strings and validation metadata', () => {
    const privateText = 'private-memo-body-marker-\\n\\u202e';
    const privateId = 'unsafe-id-marker-\\n';
    const privateHash = 'z'.repeat(MEMO_HASH_HEX_LENGTH);
    const invalidCases: Array<[MemoInput, string, string]> = [
      [{ type: 'text', value: privateText.repeat(2) }, privateText, 'too_long'],
      [{ type: 'id', value: privateId }, privateId, 'not_unsigned_integer'],
      [{ type: 'hash', value: privateHash }, privateHash, 'not_hexadecimal'],
      [{ type: 'unsupported-private-type' as MemoInput['type'], value: 'x' }, 'unsupported-private-type', 'unsupported_type'],
    ];

    for (const [input, secret, reason] of invalidCases) {
      const error = capture(() => validateMemoInput(input));
      expect(error.code).toBe(ErrorCode.TX_INVALID_MEMO);
      expect(error.validation?.field).toBe('memo');
      expect(error.validation?.reason).toBe(reason);
      expect(error.validation?.value).toBeUndefined();
      expect(JSON.stringify(error)).not.toContain(secret);
      expect(error.message).not.toContain(secret);
    }
  });


  it('rejects a payload-bearing none memo', () => {
    const err = capture(() =>
      validateMemoInput({ type: 'none', value: 'unexpected' })
    );
    expect(err.validation?.reason).toBe('unexpected_payload');
    expect(err.validation?.value).toBeUndefined();
  });

  it('does not echo an unexpected none memo payload through error metadata', () => {
    const sensitiveValue = 'private-memo-payload-marker';
    const err = capture(() => validateMemoInput({ type: 'none', value: sensitiveValue }));
    expect(err.validation?.reason).toBe('unexpected_payload');
    expect(err.validation?.value).toBeUndefined();
    expect(JSON.stringify(err)).not.toContain(sensitiveValue);
  });

  it('rejects a text memo one byte over the limit', () => {
    const err = capture(() =>
      validateMemoInput({ type: 'text', value: 'a'.repeat(MEMO_TEXT_MAX_BYTES + 1) })
    );
    expect(err.validation?.reason).toBe('too_long');
  });

  it('measures text memos in bytes, not characters', () => {
    // 15 multi-byte characters are well under 28 characters but over 28 bytes.
    expect(() => validateMemoInput({ type: 'text', value: 'á'.repeat(15) })).toThrow(PocketPayError);
    expect(validateMemoInput({ type: 'text', value: 'á'.repeat(14) })).toBe(true);
  });

  it('rejects negative, fractional and non-numeric id memos', () => {
    expect(capture(() => validateMemoInput({ type: 'id', value: '-1' })).validation?.reason).toBe(
      'not_unsigned_integer'
    );
    expect(capture(() => validateMemoInput({ type: 'id', value: '1.5' })).validation?.reason).toBe(
      'not_unsigned_integer'
    );
    expect(capture(() => validateMemoInput({ type: 'id', value: 'abc' })).validation?.reason).toBe(
      'not_unsigned_integer'
    );
    expect(capture(() => validateMemoInput({ type: 'id', value: ' 123 ' })).validation?.reason).toBe(
      'not_unsigned_integer'
    );
  });

  it('rejects unsafe numeric ids before JavaScript rounding can change the memo', () => {
    const err = capture(() =>
      validateMemoInput({ type: 'id', value: Number.MAX_SAFE_INTEGER + 1 })
    );
    expect(err.validation?.reason).toBe('unsafe_number');

    expect(validateMemoInput({ type: 'id', value: '9007199254740993' })).toBe(true);
    expect(validateMemoInput({ type: 'id', value: 9007199254740993n })).toBe(true);
  });

  it('rejects an id memo above 2^64 - 1', () => {
    const err = capture(() => validateMemoInput({ type: 'id', value: (MEMO_ID_MAX + 1n).toString() }));
    expect(err.validation?.reason).toBe('out_of_range');
  });

  it('rejects hash and return memos of the wrong length', () => {
    expect(capture(() => validateMemoInput({ type: 'hash', value: 'ab' })).validation?.reason).toBe(
      'invalid_length'
    );
    expect(
      capture(() => validateMemoInput({ type: 'return', value: HEX64 + 'a' })).validation?.reason
    ).toBe('invalid_length');
  });

  it('rejects non-hexadecimal hash memos of the right length', () => {
    const err = capture(() => validateMemoInput({ type: 'hash', value: 'z'.repeat(64) }));
    expect(err.validation?.reason).toBe('not_hexadecimal');
  });
});

describe('unsupported formats report the right problem', () => {
  it('names the unsupported type instead of a length problem', () => {
    const err = capture(() =>
      validateMemoInput({ type: 'quantum' as unknown as MemoInput['type'], value: 'x' })
    );
    expect(err.validation?.reason).toBe('unsupported_type');
    expect(err.message).toContain('Unsupported memo type');
    expect(err.message).not.toContain('28-byte limit');
  });

  it('reports a hash-shaped memo as a length problem for its own type, not as text', () => {
    // Regression: a 64-char hex intended as MEMO_HASH used to fail the text
    // byte check with "Memo text exceeds 28-byte limit", describing the wrong
    // rule. Declared as a hash it now validates cleanly.
    expect(validateMemoInput({ type: 'hash', value: HEX64 })).toBe(true);
    expect(() => validateMemo(HEX64)).toThrow('Memo text exceeds 28-byte limit');
  });
});

describe('typed errors use the published standard', () => {
  it('reports TX_INVALID_MEMO, which the registry recognises', () => {
    const err = capture(() => validateMemoInput({ type: 'text', value: 'a'.repeat(29) }));

    expect(err.code).toBe(ErrorCode.TX_INVALID_MEMO);
    expect(isKnownErrorCode(err.code)).toBe(true);

    const described = describeError(err.code);
    expect(described.known).toBe(true);
    expect(described.category).toBe(ErrorCategory.Transaction);
    expect(described.safeMessage).not.toBe('An unexpected error occurred.');
  });

  it('attaches validation metadata naming the memo field', () => {
    const err = capture(() => validateMemoInput({ type: 'id', value: '-1' }));
    expect(err.validation?.field).toBe('memo');
    expect(err).toBeInstanceOf(PocketPayError);
  });
});

describe('safeValidateMemo', () => {
  it('returns valid:true for an acceptable memo', () => {
    expect(safeValidateMemo({ type: 'id', value: '7' })).toEqual({ valid: true });
  });

  it('returns the typed error instead of throwing', () => {
    const result = safeValidateMemo({ type: 'hash', value: 'nope' });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error.code).toBe(ErrorCode.TX_INVALID_MEMO);
    }
  });
});

describe('formatMemoForDisplay', () => {
  it('returns undefined when there is no displayable memo', () => {
    expect(formatMemoForDisplay(undefined)).toBeUndefined();
    expect(formatMemoForDisplay('')).toBeUndefined();
    expect(formatMemoForDisplay({ type: 'none' })).toBeUndefined();
  });

  it('preserves printable text and non-text payloads', () => {
    expect(formatMemoForDisplay('invoice #42')).toBe('invoice #42');
    expect(formatMemoForDisplay({ type: 'id', value: '12345' })).toBe('12345');
    expect(formatMemoForDisplay({ type: 'hash', value: HEX64 })).toBe(HEX64);
  });

  it('escapes control characters, quotes and backslashes in text memos', () => {
    expect(
      formatMemoForDisplay({
        type: 'text',
        value: 'line1\nline2\t"quoted"\\tail',
      })
    ).toBe('line1\\nline2\\t\\"quoted\\"\\\\tail');
  });

  it('escapes Unicode line and paragraph separators for single-line display', () => {
    expect(
      formatMemoForDisplay({ type: 'text', value: 'left\u2028middle\u2029right' })
    ).toBe('left\\u2028middle\\u2029right');
    expect(formatMemoForDisplay({ type: 'text', value: 'left\u0085right' }))
      .toBe('left\\u0085right');
  });

  it('escapes bidi overrides and isolates to prevent spoofed display direction', () => {
    expect(formatMemoForDisplay({ type: 'text', value: 'left\u202Eright\u2069' }))
      .toBe('left\\u202eright\\u2069');
    expect(formatMemoForDisplay({ type: 'text', value: 'a\u202Ab\u202Dc\u2066d\u2067e\u2068f' }))
      .toBe('a\\u202ab\\u202dc\\u2066d\\u2067e\\u2068f');
  });

  it('escapes left-to-right, right-to-left, and Arabic letter direction marks', () => {
    expect(formatMemoForDisplay({ type: 'text', value: 'a\u200Eb\u200Fc\u061Cd' }))
      .toBe('a\\u200eb\\u200fc\\u061cd');
  });

  it('rejects invalid values before formatting', () => {
    expect(() => formatMemoForDisplay({ type: 'hash', value: 'not-hex' })).toThrow(
      PocketPayError
    );
  });
});

describe('buildMemo', () => {
  it('returns undefined when there is no memo', () => {
    expect(buildMemo(undefined)).toBeUndefined();
    expect(buildMemo('')).toBeUndefined();
    expect(buildMemo({ type: 'none' })).toBeUndefined();
  });

  it('builds the matching Stellar memo for each type', () => {
    expect(buildMemo('hello')?.type).toBe(StellarSDK.MemoText);
    expect(buildMemo({ type: 'text', value: 'hello' })?.type).toBe(StellarSDK.MemoText);
    expect(buildMemo({ type: 'id', value: '42' })?.type).toBe(StellarSDK.MemoID);
    expect(buildMemo({ type: 'hash', value: HEX64 })?.type).toBe(StellarSDK.MemoHash);
    expect(buildMemo({ type: 'return', value: HEX64 })?.type).toBe(StellarSDK.MemoReturn);
  });

  it('validates before building', () => {
    expect(() => buildMemo({ type: 'id', value: 'not-a-number' })).toThrow(PocketPayError);
  });
});

describe('backwards compatibility', () => {
  it('leaves the original validateMemo behaviour untouched', () => {
    expect(validateMemo(undefined)).toBe(true);
    expect(validateMemo('')).toBe(true);
    expect(validateMemo('short')).toBe(true);
    expect(() => validateMemo('a'.repeat(29))).toThrow('Memo text exceeds 28-byte limit');
  });

  it('accepts a plain string memo wherever a memo is taken', () => {
    expect(validateMemoInput('invoice #42')).toBe(true);
    expect(buildMemo('invoice #42')?.type).toBe(StellarSDK.MemoText);
  });
});

describe('payment preview reports the memo type', () => {
  it('describes a plain string memo as text', async () => {
    const preview = await previewPayment({
      sourceAccount: PUBLIC_KEY,
      destination: StellarSDK.Keypair.random().publicKey(),
      amount: '10',
      memo: 'invoice #42',
    });
    expect(preview.memo).toBe('invoice #42');
    expect(preview.memoType).toBe('text');
  });

  it('describes a typed memo with its own type', async () => {
    const preview = await previewPayment({
      sourceAccount: PUBLIC_KEY,
      destination: StellarSDK.Keypair.random().publicKey(),
      amount: '10',
      memo: { type: 'id', value: '12345' },
    });
    expect(preview.memo).toBe('12345');
    expect(preview.memoType).toBe('id');
  });

  it('omits both fields when there is no memo', async () => {
    const preview = await previewPayment({
      sourceAccount: PUBLIC_KEY,
      destination: StellarSDK.Keypair.random().publicKey(),
      amount: '10',
    });
    expect(preview.memo).toBeUndefined();
    expect(preview.memoType).toBeUndefined();
  });

  it('escapes text memo controls in the display preview', async () => {
    const preview = await previewPayment({
      sourceAccount: PUBLIC_KEY,
      destination: StellarSDK.Keypair.random().publicKey(),
      amount: '10',
      memo: 'line1\nline2\t\\tail',
    });

    expect(preview.memo).toBe('line1\\nline2\\t\\\\tail');
    expect(preview.memoType).toBe('text');
  });

  it('rejects an invalid memo before doing any other work', async () => {
    await expect(
      previewPayment({
        sourceAccount: PUBLIC_KEY,
        destination: StellarSDK.Keypair.random().publicKey(),
        amount: '10',
        memo: { type: 'hash', value: 'too-short' },
      })
    ).rejects.toBeInstanceOf(PocketPayError);
  });
});
