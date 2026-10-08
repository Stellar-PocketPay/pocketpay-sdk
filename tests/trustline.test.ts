/**
 * Tests for Trustline Validation Module
 *
 * Verifies local asset validation and Horizon network queries for destination
 * trustlines (Native XLM, valid trustline, missing trustline, unauthorized trustline,
 * limit exceeded, unfunded accounts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  validateAssetSpec,
  checkDestinationTrustline,
  safeCheckDestinationTrustline,
  verifyPaymentTrustlineOrThrow,
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

describe('Trustline Validation Module', () => {
  let validIssuer: string;
  let destPublicKey: string;

  beforeEach(() => {
    mockLoadAccount.mockReset();
    validIssuer = createWallet().publicKey;
    destPublicKey = createWallet().publicKey;
  });

  describe('validateAssetSpec (Local Validation)', () => {
    it('accepts native XLM asset spec', () => {
      expect(validateAssetSpec({ code: 'XLM' })).toBe(true);
      expect(validateAssetSpec({ code: 'native' })).toBe(true);
      expect(validateAssetSpec({ code: 'xlm' })).toBe(true);
    });

    it('rejects native XLM asset spec with an issuer', () => {
      expect(() => validateAssetSpec({ code: 'XLM', issuer: validIssuer })).toThrow(PocketPayError);
    });

    it('accepts valid issued asset spec', () => {
      expect(validateAssetSpec({ code: 'USDC', issuer: validIssuer })).toBe(true);
      expect(validateAssetSpec({ code: 'EURT', issuer: validIssuer })).toBe(true);
    });

    it('rejects empty or missing asset code', () => {
      expect(() => validateAssetSpec({ code: '' } as any)).toThrow(PocketPayError);
      expect(() => validateAssetSpec({} as any)).toThrow(PocketPayError);
    });

    it('rejects invalid asset code format (too long or non-alphanumeric)', () => {
      expect(() => validateAssetSpec({ code: 'TOOLONGASSETCODE13', issuer: validIssuer })).toThrow(PocketPayError);
      expect(() => validateAssetSpec({ code: 'USD$', issuer: validIssuer })).toThrow(PocketPayError);
    });

    it('rejects issued asset missing an issuer key', () => {
      expect(() => validateAssetSpec({ code: 'USDC' })).toThrow(PocketPayError);
      expect(() => validateAssetSpec({ code: 'USDC', issuer: '' })).toThrow(PocketPayError);
    });

    it('rejects issued asset with malformed issuer key', () => {
      expect(() => validateAssetSpec({ code: 'USDC', issuer: 'INVALID' })).toThrow(PocketPayError);
    });
  });

  describe('checkDestinationTrustline (Network Queries)', () => {
    it('returns native_xlm status without calling network for XLM', async () => {
      const result = await checkDestinationTrustline(destPublicKey, { code: 'XLM' });
      expect(result.valid).toBe(true);
      expect(result.status).toBe('native_xlm');
      expect(mockLoadAccount).not.toHaveBeenCalled();
    });

    it('returns account_not_found status when destination does not exist (404)', async () => {
      mockLoadAccount.mockRejectedValue(makeHorizon404Error(destPublicKey));
      const result = await checkDestinationTrustline(destPublicKey, { code: 'USDC', issuer: validIssuer });
      expect(result.valid).toBe(false);
      expect(result.status).toBe('account_not_found');
      expect(result.errorCode).toBe('UNFUNDED_DESTINATION');
    });

    it('returns missing_trustline status when destination has no matching balance', async () => {
      mockLoadAccount.mockResolvedValue({
        balances: [
          { asset_type: 'native', balance: '100.0000000' },
          { asset_type: 'credit_alphanum4', asset_code: 'EURT', asset_issuer: validIssuer, balance: '50.0000000', limit: '1000.0000000' },
        ],
      });

      const result = await checkDestinationTrustline(destPublicKey, { code: 'USDC', issuer: validIssuer });
      expect(result.valid).toBe(false);
      expect(result.status).toBe('missing_trustline');
      expect(result.errorCode).toBe('MISSING_TRUSTLINE');
    });

    it('returns not_authorized status when trustline is not authorized by issuer', async () => {
      mockLoadAccount.mockResolvedValue({
        balances: [
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USDC',
            asset_issuer: validIssuer,
            balance: '0.0000000',
            limit: '1000.0000000',
            is_authorized: false,
          },
        ],
      });

      const result = await checkDestinationTrustline(destPublicKey, { code: 'USDC', issuer: validIssuer });
      expect(result.valid).toBe(false);
      expect(result.status).toBe('not_authorized');
      expect(result.errorCode).toBe('TRUSTLINE_NOT_AUTHORIZED');
    });

    it('returns limit_exceeded status when payment amount exceeds available capacity', async () => {
      mockLoadAccount.mockResolvedValue({
        balances: [
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USDC',
            asset_issuer: validIssuer,
            balance: '950.0000000',
            limit: '1000.0000000',
            is_authorized: true,
          },
        ],
      });

      const result = await checkDestinationTrustline(destPublicKey, { code: 'USDC', issuer: validIssuer }, { amount: '100.0' });
      expect(result.valid).toBe(false);
      expect(result.status).toBe('limit_exceeded');
      expect(result.errorCode).toBe('TRUSTLINE_LIMIT_EXCEEDED');
      expect(result.availableCapacity).toBe('50.0000000');
    });

    it('returns valid status when destination has valid trustline and sufficient capacity', async () => {
      mockLoadAccount.mockResolvedValue({
        balances: [
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USDC',
            asset_issuer: validIssuer,
            balance: '100.0000000',
            limit: '1000.0000000',
            is_authorized: true,
          },
        ],
      });

      const result = await checkDestinationTrustline(destPublicKey, { code: 'USDC', issuer: validIssuer }, { amount: '50.0' });
      expect(result.valid).toBe(true);
      expect(result.status).toBe('valid');
      expect(result.currentBalance).toBe('100.0000000');
      expect(result.limit).toBe('1000.0000000');
      expect(result.availableCapacity).toBe('900.0000000');
    });
  });

  describe('issued-asset capacity precision', () => {
    const maxLimit = '922337203685.4775807';
    const oneUnitBelow = '922337203685.4775806';

    it('accepts the last 7-decimal unit of a large trustline', async () => {
      mockLoadAccount.mockResolvedValue({ balances: [{
        asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: validIssuer,
        balance: oneUnitBelow, limit: maxLimit, is_authorized: true,
      }] });
      const result = await checkDestinationTrustline(
        destPublicKey, { code: 'USDC', issuer: validIssuer }, { amount: '0.0000001' },
      );
      expect(result.valid).toBe(true);
      expect(result.status).toBe('valid');
      expect(result.availableCapacity).toBe('0.0000001');
    });

    it('rejects an amount exceeding that capacity by one 7-decimal unit', async () => {
      mockLoadAccount.mockResolvedValue({ balances: [{
        asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: validIssuer,
        balance: oneUnitBelow, limit: maxLimit, is_authorized: true,
      }] });
      const result = await checkDestinationTrustline(
        destPublicKey, { code: 'USDC', issuer: validIssuer }, { amount: '0.0000002' },
      );
      expect(result.valid).toBe(false);
      expect(result.status).toBe('limit_exceeded');
      expect(result.availableCapacity).toBe('0.0000001');
    });

    it('fails closed when Horizon omits balance or limit even without an amount', async () => {
      mockLoadAccount.mockResolvedValue({ balances: [{
        asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: validIssuer,
        balance: '10.0000000', is_authorized: true,
        // Horizon limit field is unexpectedly absent.
      }] });
      await expect(checkDestinationTrustline(
        destPublicKey, { code: 'USDC', issuer: validIssuer },
      )).rejects.toMatchObject({ code: 'TRUSTLINE_CHECK_ERROR' });
    });

    it('fails closed for invalid Horizon balance decimals rather than approving a payment', async () => {
      mockLoadAccount.mockResolvedValue({ balances: [{
        asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: validIssuer,
        balance: 'NaN', limit: '100.0000000', is_authorized: true,
      }] });
      await expect(checkDestinationTrustline(
        destPublicKey, { code: 'USDC', issuer: validIssuer }, { amount: '1' },
      )).rejects.toMatchObject({ code: 'TRUSTLINE_CHECK_ERROR' });
    });
  });

  describe('safeCheckDestinationTrustline', () => {
    it('returns PocketPayResult success when valid', async () => {
      mockLoadAccount.mockResolvedValue({
        balances: [
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USDC',
            asset_issuer: validIssuer,
            balance: '0.0000000',
            limit: '1000.0000000',
            is_authorized: true,
          },
        ],
      });

      const result = await safeCheckDestinationTrustline(destPublicKey, { code: 'USDC', issuer: validIssuer });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.valid).toBe(true);
      }
    });

    it('never throws for invalid destination public key', async () => {
      const result = await safeCheckDestinationTrustline('INVALID_KEY', { code: 'USDC', issuer: validIssuer });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_PUBLIC_KEY');
      }
    });
  });

  describe('verifyPaymentTrustlineOrThrow', () => {
    it('throws PocketPayError when trustline check fails', async () => {
      mockLoadAccount.mockResolvedValue({
        balances: [{ asset_type: 'native', balance: '10.0' }],
      });

      await expect(
        verifyPaymentTrustlineOrThrow(destPublicKey, { code: 'USDC', issuer: validIssuer })
      ).rejects.toThrow(PocketPayError);
    });

    it('resolves cleanly when trustline check passes', async () => {
      mockLoadAccount.mockResolvedValue({
        balances: [
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USDC',
            asset_issuer: validIssuer,
            balance: '10.0000000',
            limit: '1000.0000000',
            is_authorized: true,
          },
        ],
      });

      const res = await verifyPaymentTrustlineOrThrow(destPublicKey, { code: 'USDC', issuer: validIssuer });
      expect(res.valid).toBe(true);
    });
  });
});
