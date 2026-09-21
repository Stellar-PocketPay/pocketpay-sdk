import { describe, expect, it } from 'vitest';
import { NATIVE_ASSET } from '../src/types/asset';
import {
  formatBalanceDisplay,
  normalizeBalanceDisplay,
} from '../src/utils/balanceDisplay';

const ISSUER = `G${'A'.repeat(55)}`;

describe('balance display normaliser', () => {
  it('formats native XLM with deterministic grouping and useful fractional digits', () => {
    expect(formatBalanceDisplay('1234.5000000', NATIVE_ASSET)).toBe('1,234.50 XLM');
  });

  it('keeps protocol-scale amounts exact instead of converting through number', () => {
    expect(
      formatBalanceDisplay('900719925.4740991', NATIVE_ASSET, {
        minimumFractionDigits: 7,
        maximumFractionDigits: 7,
      }),
    ).toBe('900,719,925.4740991 XLM');
  });

  it('rounds decimal strings exactly at the configured display precision', () => {
    expect(
      formatBalanceDisplay('1.0050000', NATIVE_ASSET, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
        groupThousands: false,
      }),
    ).toBe('1.01 XLM');
  });

  it('supports issued assets without discarding issuer identity', () => {
    const result = normalizeBalanceDisplay(
      {
        balance: '12.5000000',
        asset: { type: 'issued', code: 'USDC', issuer: ISSUER },
      },
      {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
        includeIssuer: true,
      },
    );

    expect(result.status).toBe('ready');
    expect(result.assetLabel).toBe('USDC (GAAAAA...AAAA)');
    expect(result.display).toBe('12.50 USDC (GAAAAA...AAAA)');
  });

  it('represents missing balances explicitly', () => {
    expect(normalizeBalanceDisplay({ balance: null, asset: NATIVE_ASSET })).toMatchObject({
      status: 'missing',
      reason: 'missing_balance',
      amount: null,
      display: '— XLM',
    });
  });

  it('rejects unsafe or malformed balance inputs instead of displaying NaN', () => {
    expect(normalizeBalanceDisplay({ balance: '1e3', asset: NATIVE_ASSET })).toMatchObject({
      status: 'invalid',
      reason: 'invalid_balance',
      display: 'Invalid balance XLM',
    });
    expect(normalizeBalanceDisplay({ balance: 1.5, asset: NATIVE_ASSET })).toMatchObject({
      status: 'invalid',
      reason: 'invalid_balance',
    });
  });
});
