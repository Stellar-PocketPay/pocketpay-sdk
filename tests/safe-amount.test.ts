/**
 * Safe amount model tests (issue #270).
 *
 * Stellar amounts are int64 stroops. The SDK modelled them with `number`:
 * `xlmToStroops` declared a number return, and both vault paths converted with
 * `Math.round(parseFloat(amount) * 10_000_000)`. Ordinary amounts survived
 * that, but the type cannot carry the protocol's range — `Number.MAX_SAFE_INTEGER`
 * stops at 9,007,199,254,740,991 stroops while Stellar permits
 * 9,223,372,036,854,775,807, about a thousand times more.
 */

import { describe, it, expect } from 'vitest';
import {
  SafeAmount,
  parseAmount,
  parsePositiveAmount,
  safeParseAmount,
  fromStroops,
  toStroops,
  formatStroops,
  STROOPS_PER_UNIT,
  AMOUNT_DECIMALS,
  MAX_STROOPS,
  validateAmount,
  xlmToStroops,
  stroopsToXLM,
} from '../src/utils';
import { PocketPayError } from '../src/types';
import { ErrorCode, isKnownErrorCode, describeError } from '../src/errors';

/** Exact reference conversion, independent of the implementation. */
const reference = (amount: string): bigint => {
  const [whole, fraction = ''] = amount.split('.');
  return BigInt(whole + fraction.padEnd(AMOUNT_DECIMALS, '0'));
};

const capture = (fn: () => unknown): PocketPayError => {
  try {
    fn();
  } catch (error) {
    return error as PocketPayError;
  }
  throw new Error('expected the call to throw');
};

describe('constants match the protocol', () => {
  it('uses 7 decimals and 10,000,000 stroops per unit', () => {
    expect(AMOUNT_DECIMALS).toBe(7);
    expect(STROOPS_PER_UNIT).toBe(10_000_000n);
  });

  it('caps at the int64 maximum', () => {
    expect(MAX_STROOPS).toBe(2n ** 63n - 1n);
  });

  it('covers the range a JavaScript number cannot', () => {
    // The gap this model exists to close.
    expect(MAX_STROOPS).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
  });
});

describe('parseAmount — zero and small decimals', () => {
  it('accepts zero in every spelling', () => {
    expect(parseAmount('0').stroops).toBe(0n);
    expect(parseAmount('0.0').stroops).toBe(0n);
    expect(parseAmount('0.0000000').stroops).toBe(0n);
    expect(parseAmount('0').isZero).toBe(true);
  });

  it('accepts the smallest representable amount', () => {
    expect(parseAmount('0.0000001').stroops).toBe(1n);
  });

  it('parses ordinary decimals exactly', () => {
    for (const amount of ['0.1', '1', '1.5', '10.5', '12.3456789', '999.9999999']) {
      expect(parseAmount(amount).stroops, amount).toBe(reference(amount));
    }
  });
});

describe('parseAmount — trailing zeros preserve intent', () => {
  it('keeps the caller input verbatim', () => {
    const amount = parseAmount('10.5000000');
    expect(amount.input).toBe('10.5000000');
  });

  it('treats trailing-zero spellings as equal values', () => {
    expect(parseAmount('1').equals(parseAmount('1.0000000'))).toBe(true);
    expect(parseAmount('10.5').equals(parseAmount('10.5000000'))).toBe(true);
    expect(parseAmount('10.5').stroops).toBe(parseAmount('10.50').stroops);
  });

  it('canonicalises to seven decimals on output', () => {
    expect(parseAmount('1').toString()).toBe('1.0000000');
    expect(parseAmount('10.5').toString()).toBe('10.5000000');
    expect(parseAmount('0.0000001').toString()).toBe('0.0000001');
  });
});

describe('parseAmount — large values', () => {
  it('parses the protocol maximum exactly', () => {
    const max = formatStroops(MAX_STROOPS);
    expect(parseAmount(max).stroops).toBe(MAX_STROOPS);
  });

  it('rejects anything above the protocol maximum', () => {
    const tooBig = formatStroops(MAX_STROOPS + 1n);
    expect(capture(() => parseAmount(tooBig)).validation?.reason).toBe('exceeds_maximum');
  });

  it('is exact where float arithmetic was not', () => {
    // Reproduces the divergence the old pipeline produced: this value is inside
    // Stellar's legal range and Math.round(parseFloat(v) * 1e7) was 52 stroops off.
    const amount = '92233720368.5477580';
    const legacy = BigInt(Math.round(parseFloat(amount) * 10_000_000));

    expect(parseAmount(amount).stroops).toBe(reference(amount));
    expect(legacy).not.toBe(reference(amount));
  });

  it('stays exact across the whole range, unlike a number', () => {
    const amount = formatStroops(MAX_STROOPS);
    expect(parseAmount(amount).stroops).toBe(MAX_STROOPS);
    expect(BigInt(Number(MAX_STROOPS))).not.toBe(MAX_STROOPS);
  });
});

describe('parseAmount — invalid input is rejected', () => {
  it('rejects non-decimal strings', () => {
    for (const bad of ['', ' ', '10abc', '1e3', 'NaN', 'Infinity', '-1', '+1', '1.', '.5', '1,5']) {
      expect(capture(() => parseAmount(bad)).code, bad).toBe(ErrorCode.PAYMENT_INVALID_AMOUNT);
    }
  });

  it('rejects non-string input', () => {
    expect(capture(() => parseAmount(10 as never)).validation?.reason).toBe('invalid_format');
  });

  it('rejects more than seven decimal places', () => {
    const err = capture(() => parseAmount('1.00000001'));
    expect(err.validation?.reason).toBe('too_precise');
    expect(err.message).toContain('7 decimal places');
  });

  it('reports a code the published registry recognises', () => {
    const err = capture(() => parseAmount('nope'));
    expect(isKnownErrorCode(err.code)).toBe(true);
    expect(describeError(err.code).known).toBe(true);
    expect(describeError(err.code).safeMessage).not.toBe('An unexpected error occurred.');
  });
});

describe('parsePositiveAmount', () => {
  it('accepts a payable amount', () => {
    expect(parsePositiveAmount('0.0000001').stroops).toBe(1n);
  });

  it('rejects zero', () => {
    expect(capture(() => parsePositiveAmount('0')).validation?.reason).toBe('not_positive');
    expect(capture(() => parsePositiveAmount('0.0000000')).validation?.reason).toBe('not_positive');
  });
});

describe('safeParseAmount', () => {
  it('returns the amount when valid', () => {
    const result = safeParseAmount('1.5');
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.amount.stroops).toBe(15_000_000n);
  });

  it('returns the typed error instead of throwing', () => {
    const result = safeParseAmount('1e3');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error.code).toBe(ErrorCode.PAYMENT_INVALID_AMOUNT);
  });
});

describe('formatStroops and fromStroops round-trip', () => {
  it('formats without dividing through a float', () => {
    expect(formatStroops(0n)).toBe('0.0000000');
    expect(formatStroops(1n)).toBe('0.0000001');
    expect(formatStroops(10_000_000n)).toBe('1.0000000');
    expect(formatStroops(MAX_STROOPS)).toBe('922337203685.4775807');
  });

  it('round-trips every boundary exactly', () => {
    for (const stroops of [0n, 1n, 9_999_999n, 10_000_000n, MAX_STROOPS]) {
      expect(parseAmount(formatStroops(stroops)).stroops).toBe(stroops);
    }
  });

  it('builds from bigint or decimal string stroops', () => {
    expect(fromStroops(1n).toString()).toBe('0.0000001');
    expect(fromStroops('10000000').toString()).toBe('1.0000000');
  });

  it('rejects malformed or out-of-range stroop values', () => {
    expect(capture(() => fromStroops('1.5')).validation?.reason).toBe('invalid_stroops');
    expect(capture(() => fromStroops('abc')).validation?.reason).toBe('invalid_stroops');
    expect(capture(() => fromStroops(MAX_STROOPS + 1n)).validation?.reason).toBe('exceeds_maximum');
  });
});

describe('SafeAmount arithmetic is exact', () => {
  it('adds without float error', () => {
    // 0.1 + 0.2 is the canonical float failure; here it is exact.
    expect(parseAmount('0.1').plus(parseAmount('0.2')).toString()).toBe('0.3000000');
  });

  it('subtracts exactly', () => {
    expect(parseAmount('1').minus(parseAmount('0.0000001')).toString()).toBe('0.9999999');
  });

  it('rejects a negative result', () => {
    expect(capture(() => parseAmount('1').minus(parseAmount('2'))).validation?.reason).toBe(
      'negative_result'
    );
  });

  it('rejects a sum beyond the protocol maximum', () => {
    const max = fromStroops(MAX_STROOPS);
    expect(capture(() => max.plus(parseAmount('0.0000001'))).validation?.reason).toBe('overflow');
  });

  it('compares by value, not by spelling', () => {
    expect(parseAmount('1.5').compare(parseAmount('1.5000000'))).toBe(0);
    expect(parseAmount('1').compare(parseAmount('2'))).toBe(-1);
    expect(parseAmount('2').compare(parseAmount('1'))).toBe(1);
  });

  it('is immutable and serialises to its canonical form', () => {
    const amount = parseAmount('1.5');
    expect(Object.isFrozen(amount)).toBe(true);
    expect(JSON.stringify({ amount })).toBe('{"amount":"1.5000000"}');
    expect(amount).toBeInstanceOf(SafeAmount);
  });
});

describe('legacy helpers no longer lose precision silently', () => {
  it('keeps validateAmount behaviour unchanged', () => {
    expect(validateAmount('1')).toBe(true);
    expect(validateAmount('0.0000001')).toBe(true);
    expect(() => validateAmount('0')).toThrow(PocketPayError);
    expect(() => validateAmount('1.00000001')).toThrow('7 decimal places');
    expect(() => validateAmount('10abc')).toThrow(PocketPayError);
  });

  it('rejects amounts above Stellar int64 stroops through legacy validateAmount', () => {
    expect(validateAmount(formatStroops(MAX_STROOPS))).toBe(true);
    const tooBig = formatStroops(MAX_STROOPS + 1n);
    const error = capture(() => validateAmount(tooBig));
    expect(error.code).toBe('INVALID_AMOUNT');
    expect(error.validation?.reason).toBe('exceeds_maximum');
  });

  it('keeps xlmToStroops returning a number for representable amounts', () => {
    expect(xlmToStroops('1')).toBe(10_000_000);
    expect(xlmToStroops('0.0000001')).toBe(1);
  });

  it('throws instead of returning a wrong number beyond the safe range', () => {
    // Previously this returned a silently incorrect value.
    const beyondSafe = formatStroops(BigInt(Number.MAX_SAFE_INTEGER) + 1n);
    const err = capture(() => xlmToStroops(beyondSafe));
    expect(err.validation?.reason).toBe('exceeds_safe_integer');
  });

  it('keeps stroopsToXLM output identical for existing inputs', () => {
    expect(stroopsToXLM(10_000_000)).toBe('1.0000000');
    expect(stroopsToXLM('50000000')).toBe('5.0000000');
    expect(stroopsToXLM(1)).toBe('0.0000001');
  });

  it('makes stroopsToXLM exact for large stroop strings', () => {
    expect(stroopsToXLM(MAX_STROOPS.toString())).toBe('922337203685.4775807');
  });

  it('refuses an unsafe integer rather than rounding it', () => {
    const unsafe = Number.MAX_SAFE_INTEGER + 2;
    expect(capture(() => stroopsToXLM(unsafe)).validation?.reason).toBe('unsafe_integer');
  });
});
