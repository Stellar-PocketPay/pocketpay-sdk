/**
 * Focused regression coverage for issue #183.
 *
 * The balance model must preserve Horizon's seven-decimal strings across the
 * full Stellar int64 range. JavaScript number/parseFloat cannot do that.
 */
import { describe, expect, it } from 'vitest';
import { formatAssetBalanceDisplay, parseMultiAssetBalance } from '../src';

describe('multi-asset balance exactness', () => {
  it('keeps native reserve arithmetic exact at the protocol maximum', () => {
    const result = parseMultiAssetBalance('GTEST', {
      subentry_count: 0,
      balances: [{
        asset_type: 'native',
        balance: '922337203685.4775807',
        selling_liabilities: '0.0000001',
        buying_liabilities: '0.0000000',
      }],
    });

    expect(result.native?.reservedBalance).toBe('1.0000001');
    expect(result.native?.availableBalance).toBe('922337203684.4775806');
    expect(result.native?.formattedDisplay).toBe('922337203684.48 XLM');
    expect(formatAssetBalanceDisplay(result.native!, 7)).toBe(
      '922337203684.4775806 XLM',
    );
  });

  it('keeps issued-asset liability subtraction exact', () => {
    const result = parseMultiAssetBalance('GTEST', {
      subentry_count: 1,
      balances: [{
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        asset_issuer: 'GISSUER',
        balance: '922337203685.4775807',
        selling_liabilities: '0.0000001',
        buying_liabilities: '0.0000000',
        limit: '922337203685.4775807',
        is_authorized: true,
      }],
    });

    expect(result.issuedAssets[0]?.availableBalance).toBe('922337203685.4775806');
    expect(result.issuedAssets[0]?.reservedBalance).toBe('0.0000001');
  });

  it('classifies malformed Horizon decimals as unknown instead of emitting NaN', () => {
    const result = parseMultiAssetBalance('GTEST', {
      subentry_count: 0,
      balances: [{
        asset_type: 'credit_alphanum4',
        asset_code: 'USD',
        asset_issuer: 'GISSUER',
        balance: 'not-a-number',
        selling_liabilities: '0.0000000',
        buying_liabilities: '0.0000000',
        limit: '100.0000000',
        is_authorized: true,
      }],
    });

    expect(result.issuedAssets).toHaveLength(0);
    expect(result.unknownAssets).toHaveLength(1);
    expect(result.unknownAssets[0]?.state).toBe('unknown');
    expect(JSON.stringify(result)).not.toContain('NaN');
  });
});
