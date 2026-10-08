/**
 * Tests for Multi-Asset Balance Model
 *
 * Verifies representation of native XLM, issued assets, reserve calculations,
 * status states (available, reserved, unauthorized, unavailable, unknown),
 * unfunded account handling, display formatting, and asset search helpers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  calculateNativeReserves,
  parseMultiAssetBalance,
  getMultiAssetBalance,
  safeGetMultiAssetBalance,
  formatAssetBalanceDisplay,
  findAssetInMultiBalance,
  createWallet,
  PocketPayError,
} from '../src';

const mockLoadAccount = vi.fn();

vi.mock('@stellar/stellar-sdk', async (importActual) => {
  const actual = await importActual<typeof import('@stellar/stellar-sdk')>();
  return {
    ...actual,
    Horizon: {
      ...actual.Horizon,
      Server: vi.fn().mockImplementation(() => ({
        loadAccount: mockLoadAccount,
      })),
    },
  };
});

function makeHorizon404Error(publicKey: string) {
  const err = new Error(`Account not found: ${publicKey}`) as any;
  err.response = { status: 404 };
  return err;
}

describe('Multi-Asset Balance Model', () => {
  let publicKey: string;
  let issuerPublicKey: string;

  beforeEach(() => {
    mockLoadAccount.mockReset();
    publicKey = createWallet().publicKey;
    issuerPublicKey = createWallet().publicKey;
  });

  describe('calculateNativeReserves', () => {
    it('calculates minimum reserve for 0 subentries (1.0 XLM)', () => {
      const reserves = calculateNativeReserves(0);
      expect(reserves.baseReserve).toBe('0.5000000');
      expect(reserves.minBalance).toBe('1.0000000');
    });

    it('calculates minimum reserve for 3 subentries (2.5 XLM)', () => {
      const reserves = calculateNativeReserves(3);
      expect(reserves.minBalance).toBe('2.5000000');
    });

    it('handles negative or undefined subentries gracefully', () => {
      expect(calculateNativeReserves(-1).minBalance).toBe('1.0000000');
      expect(calculateNativeReserves().minBalance).toBe('1.0000000');
    });
  });

  describe('parseMultiAssetBalance', () => {
    it('parses native XLM balance with subentry reserve deduction', () => {
      const horizonData = {
        subentry_count: 2,
        balances: [
          {
            asset_type: 'native',
            balance: '100.0000000',
            selling_liabilities: '5.0000000',
            buying_liabilities: '0.0000000',
          },
        ],
      };

      const result = parseMultiAssetBalance(publicKey, horizonData, 'funded');

      expect(result.publicKey).toBe(publicKey);
      expect(result.accountState).toBe('funded');
      expect(result.totalAssetCount).toBe(1);
      expect(result.native).toBeDefined();

      if (result.native) {
        expect(result.native.type).toBe('native');
        expect(result.native.assetCode).toBe('XLM');
        expect(result.native.totalBalance).toBe('100.0000000');
        // Min reserve for 2 subentries = 2.0 XLM. Total reserved = 2.0 + 5.0 = 7.0 XLM.
        expect(result.native.reservedBalance).toBe('7.0000000');
        expect(result.native.availableBalance).toBe('93.0000000');
        expect(result.native.subentryCount).toBe(2);
        expect(result.native.state).toBe('available');
        expect(result.native.formattedDisplay).toBe('93.00 XLM');
      }
    });

    it('parses issued assets with authorized and unauthorized states', () => {
      const horizonData = {
        subentry_count: 2,
        balances: [
          {
            asset_type: 'native',
            balance: '50.0000000',
          },
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USDC',
            asset_issuer: issuerPublicKey,
            balance: '100.5000000',
            limit: '10000.0000000',
            is_authorized: true,
            is_authorized_to_maintain_liabilities: true,
            selling_liabilities: '10.0000000',
          },
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'EURT',
            asset_issuer: issuerPublicKey,
            balance: '25.0000000',
            limit: '500.0000000',
            is_authorized: false,
          },
        ],
      };

      const result = parseMultiAssetBalance(publicKey, horizonData, 'funded');

      expect(result.totalAssetCount).toBe(3);
      expect(result.issuedAssets).toHaveLength(2);

      const usdc = result.issuedAssets.find((a) => a.assetCode === 'USDC');
      expect(usdc).toBeDefined();
      if (usdc) {
        expect(usdc.type).toBe('issued');
        expect(usdc.issuer).toBe(issuerPublicKey);
        expect(usdc.totalBalance).toBe('100.5000000');
        expect(usdc.availableBalance).toBe('90.5000000'); // 100.5 - 10.0
        expect(usdc.reservedBalance).toBe('10.0000000');
        expect(usdc.isAuthorized).toBe(true);
        expect(usdc.state).toBe('available');
        expect(usdc.formattedDisplay).toBe('90.50 USDC');
      }

      const eurt = result.issuedAssets.find((a) => a.assetCode === 'EURT');
      expect(eurt).toBeDefined();
      if (eurt) {
        expect(eurt.isAuthorized).toBe(false);
        expect(eurt.state).toBe('unauthorized');
        expect(eurt.formattedDisplay).toBe('25.00 EURT (Unauthorized)');
      }
    });

    it('keeps high-range wallet balances exact to the stroop (#307)', () => {
      const horizonData = {
        subentry_count: 0,
        balances: [
          {
            asset_type: 'native',
            balance: '922337203685.4775807',
            selling_liabilities: '0.0000001',
          },
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USDC',
            asset_issuer: issuerPublicKey,
            balance: '922337203685.4775807',
            selling_liabilities: '0.0000001',
            limit: '922337203685.4775807',
            is_authorized: true,
          },
        ],
      };

      const result = parseMultiAssetBalance(publicKey, horizonData, 'funded');

      expect(result.native?.reservedBalance).toBe('1.0000001');
      expect(result.native?.availableBalance).toBe('922337203684.4775806');
      expect(result.native?.formattedDisplay).toBe('922337203684.48 XLM');

      const usdc = result.issuedAssets[0];
      expect(usdc.reservedBalance).toBe('0.0000001');
      expect(usdc.availableBalance).toBe('922337203685.4775806');
      expect(formatAssetBalanceDisplay(usdc, 7)).toBe('922337203685.4775806 USDC');
    });

    it('handles unknown or unparseable asset types gracefully', () => {
      const horizonData = {
        balances: [
          {
            asset_type: 'custom_unknown_type',
            asset_code: 'TOKEN',
            balance: '12.34',
          },
        ],
      };

      const result = parseMultiAssetBalance(publicKey, horizonData, 'funded');

      expect(result.unknownAssets).toHaveLength(1);
      const unknownItem = result.unknownAssets[0];
      expect(unknownItem.type).toBe('unknown');
      expect(unknownItem.assetCode).toBe('TOKEN');
      expect(unknownItem.state).toBe('unknown');
      expect(unknownItem.formattedDisplay).toContain('(Unknown)');
    });

    it('returns clean unfunded model when account data is missing (404)', () => {
      const result = parseMultiAssetBalance(publicKey, null, 'unfunded');

      expect(result.accountState).toBe('unfunded');
      expect(result.native).toBeUndefined();
      expect(result.issuedAssets).toHaveLength(0);
      expect(result.totalAssetCount).toBe(0);
    });

    it('returns unavailable model when account state is unavailable', () => {
      const result = parseMultiAssetBalance(publicKey, null, 'unavailable');

      expect(result.accountState).toBe('unavailable');
      expect(result.native).toBeUndefined();
      expect(result.issuedAssets).toHaveLength(0);
      expect(result.totalAssetCount).toBe(0);
    });
  });

  describe('getMultiAssetBalance & safeGetMultiAssetBalance', () => {
    it('fetches and parses multi-asset balance from Horizon', async () => {
      mockLoadAccount.mockResolvedValue({
        subentry_count: 1,
        balances: [
          { asset_type: 'native', balance: '200.0000000' },
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USDC',
            asset_issuer: issuerPublicKey,
            balance: '50.0000000',
            limit: '1000.0000000',
            is_authorized: true,
          },
        ],
      });

      const balance = await getMultiAssetBalance(publicKey);

      expect(balance.accountState).toBe('funded');
      expect(balance.native?.availableBalance).toBe('198.5000000'); // 200 - 1.5 min reserve
      expect(balance.issuedAssets).toHaveLength(1);
      expect(balance.issuedAssets[0].assetCode).toBe('USDC');
    });

    it('returns unfunded status for 404 response without throwing', async () => {
      mockLoadAccount.mockRejectedValue(makeHorizon404Error(publicKey));

      const balance = await getMultiAssetBalance(publicKey);
      expect(balance.accountState).toBe('unfunded');
      expect(balance.totalAssetCount).toBe(0);
    });

    it('safeGetMultiAssetBalance returns SuccessResult when successful', async () => {
      mockLoadAccount.mockResolvedValue({
        balances: [{ asset_type: 'native', balance: '50.0000000' }],
      });

      const res = await safeGetMultiAssetBalance(publicKey);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.accountState).toBe('funded');
        expect(res.value.native?.totalBalance).toBe('50.0000000');
      }
    });

    it('safeGetMultiAssetBalance returns FailureResult for invalid public key', async () => {
      const res = await safeGetMultiAssetBalance('INVALID_KEY');
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe('INVALID_PUBLIC_KEY');
      }
    });
  });

  describe('formatAssetBalanceDisplay & findAssetInMultiBalance', () => {
    it('formats native and issued assets properly with custom decimals', () => {
      const nativeItem: NativeAssetBalanceItem = {
        type: 'native',
        assetCode: 'XLM',
        totalBalance: '100.0000000',
        availableBalance: '97.5000000',
        reservedBalance: '2.5000000',
        sellingLiabilities: '0.0000000',
        buyingLiabilities: '0.0000000',
        subentryCount: 3,
        state: 'available',
        formattedDisplay: '97.50 XLM',
      };

      const issuedItem: IssuedAssetBalanceItem = {
        type: 'issued',
        assetCode: 'USDC',
        issuer: issuerPublicKey,
        totalBalance: '50.1234567',
        availableBalance: '50.1234567',
        reservedBalance: '0.0000000',
        sellingLiabilities: '0.0000000',
        buyingLiabilities: '0.0000000',
        limit: '1000.0000000',
        isAuthorized: true,
        state: 'available',
        formattedDisplay: '50.12 USDC',
      };

      expect(formatAssetBalanceDisplay(nativeItem, 2)).toBe('97.50 XLM');
      expect(formatAssetBalanceDisplay(issuedItem, 4)).toBe('50.1235 USDC');
    });

    it('finds XLM and issued assets accurately within MultiAssetBalance', () => {
      const horizonData = {
        subentry_count: 1,
        balances: [
          { asset_type: 'native', balance: '100.0000000' },
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USDC',
            asset_issuer: issuerPublicKey,
            balance: '50.0000000',
          },
        ],
      };

      const multiBalance = parseMultiAssetBalance(publicKey, horizonData, 'funded');

      const xlm = findAssetInMultiBalance(multiBalance, 'XLM');
      expect(xlm).toBeDefined();
      expect(xlm?.type).toBe('native');

      const usdc = findAssetInMultiBalance(multiBalance, 'USDC', issuerPublicKey);
      expect(usdc).toBeDefined();
      expect(usdc?.type).toBe('issued');

      const missing = findAssetInMultiBalance(multiBalance, 'NONEXISTENT');
      expect(missing).toBeUndefined();
    });
  });
});
