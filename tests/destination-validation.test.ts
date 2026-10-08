/**
 * Stellar PocketPay SDK — Destination Validation Tests
 *
 * Tests for destination account validation covering local and network validation,
 * malformed addresses, unfunded accounts, trustline requirements, and error cases.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  validateDestinationLocal,
  validateDestinationNetwork,
  validateDestinationComplete,
  validateDestinationOrThrow,
  safeValidateDestination,
  safeValidateDestinationLocal,
  safeValidateDestinationNetwork,
  type DestinationValidationOptions,
  type DestinationValidationResult,
  type DestinationValidationStatus,
} from '../src/payments/destination-validation';
import { PocketPayError } from '../src/types';
import { setHorizonServerFactory, resetHorizonServerFactory } from '../src/config';

// Mock Stellar SDK and Horizon preserving actual Keypair validation
vi.mock('@stellar/stellar-sdk', async (importActual) => {
  const actual = await importActual<typeof import('@stellar/stellar-sdk')>();
  return {
    ...actual,
    Networks: {
      TESTNET: 'Test SDF Network ; September 2015',
      PUBLIC: 'Public Global Stellar Network ; September 2015',
    },
  };
});

describe('Destination Validation - Local Validation', () => {
  const validPublicKey = 'GBQ3UUVRLPBINPRTKWKPRQWKA4LYXJCTYYHR5DAICXVYXVFQ32P5CADH';
  const invalidPublicKey = 'INVALID_PUBLIC_KEY';
  const anotherValidKey = 'GBMD2ACBNHKTDBF26BW7VZKPB3CXO63HVVYM26DBPLXK5J76ELTGUDG7';

  describe('validateDestinationLocal', () => {
    it('should validate a correct public key', () => {
      const result = validateDestinationLocal(validPublicKey);
      expect(result.valid).toBe(true);
      expect(result.status).toBe('valid_local');
      expect(result.localOnly).toBe(true);
      expect(result.destination).toBe(validPublicKey);
    });

    it('should reject invalid public key format', () => {
      const result = validateDestinationLocal(invalidPublicKey);
      expect(result.valid).toBe(false);
      expect(result.status).toBe('invalid_address_format');
      expect(result.localOnly).toBe(true);
      expect(result.errorCode).toBeDefined();
    });

    it('should detect self-payment when source is provided', () => {
      const options: DestinationValidationOptions = {
        sourcePublicKey: validPublicKey,
      };
      const result = validateDestinationLocal(validPublicKey, options);
      expect(result.valid).toBe(false);
      expect(result.status).toBe('self_payment');
      expect(result.errorCode).toBe('SELF_PAYMENT');
      expect(result.localOnly).toBe(true);
    });

    it('should allow payment to different account when source is provided', () => {
      const options: DestinationValidationOptions = {
        sourcePublicKey: validPublicKey,
      };
      const result = validateDestinationLocal(anotherValidKey, options);
      expect(result.valid).toBe(true);
      expect(result.status).toBe('valid_local');
    });

    it('should validate native XLM asset specification', () => {
      const options: DestinationValidationOptions = {
        asset: { code: 'XLM' },
      };
      const result = validateDestinationLocal(validPublicKey, options);
      expect(result.valid).toBe(true);
      expect(result.status).toBe('valid_local');
    });

    it('should validate native asset with "native" code', () => {
      const options: DestinationValidationOptions = {
        asset: { code: 'native' },
      };
      const result = validateDestinationLocal(validPublicKey, options);
      expect(result.valid).toBe(true);
    });

    it('should reject native XLM with issuer', () => {
      const options: DestinationValidationOptions = {
        asset: { code: 'XLM', issuer: validPublicKey },
      };
      const result = validateDestinationLocal(validPublicKey, options);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe('INVALID_ASSET');
    });

    it('should validate issued asset specification', () => {
      const options: DestinationValidationOptions = {
        asset: { code: 'USDC', issuer: validPublicKey },
      };
      const result = validateDestinationLocal(validPublicKey, options);
      expect(result.valid).toBe(true);
    });

    it('should reject issued asset without issuer', () => {
      const options: DestinationValidationOptions = {
        asset: { code: 'USDC' },
      };
      const result = validateDestinationLocal(validPublicKey, options);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe('MISSING_ASSET_ISSUER');
    });

    it('should reject invalid asset code format', () => {
      const options: DestinationValidationOptions = {
        asset: { code: 'TOO_LONG_ASSET_CODE', issuer: validPublicKey },
      };
      const result = validateDestinationLocal(validPublicKey, options);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe('INVALID_ASSET_CODE');
    });

    it('should reject empty asset code', () => {
      const options: DestinationValidationOptions = {
        asset: { code: '', issuer: validPublicKey },
      };
      const result = validateDestinationLocal(validPublicKey, options);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe('INVALID_ASSET_CODE');
    });
  });

  describe('safeValidateDestinationLocal', () => {
    it('should return success result for valid destination', () => {
      const result = safeValidateDestinationLocal(validPublicKey);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.valid).toBe(true);
      }
    });

    it('should return failure result for invalid destination', () => {
      const result = safeValidateDestinationLocal(invalidPublicKey);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(PocketPayError);
      }
    });
  });
});

describe('Destination Validation - Network Validation', () => {
  const validPublicKey = 'GBQ3UUVRLPBINPRTKWKPRQWKA4LYXJCTYYHR5DAICXVYXVFQ32P5CADH';
  const unfundedPublicKey = 'GBMD2ACBNHKTDBF26BW7VZKPB3CXO63HVVYM26DBPLXK5J76ELTGUDG7';
  const issuerPublicKey = 'GC7ZCFHCZJ6UWVN3EMR3HBDY75IWNXUOOZKCGYC3AQUF3PTVV4AYRIOZ';

  // Mock Horizon server
  const mockLoadAccount = vi.fn();
  const mockServer = {
    loadAccount: mockLoadAccount,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    setHorizonServerFactory(() => mockServer as any);
  });

  afterEach(() => {
    resetHorizonServerFactory();
  });

  describe('validateDestinationNetwork - Account Existence', () => {
    it('should validate funded account', async () => {
      mockLoadAccount.mockResolvedValue({
        sequence: '123456789',
        balances: [],
      });

      const result = await validateDestinationNetwork(validPublicKey);
      expect(result.valid).toBe(true);
      expect(result.status).toBe('valid_network');
      expect(result.localOnly).toBe(false);
      expect(result.metadata?.sequence).toBe('123456789');
    });

    it('should detect unfunded account (404)', async () => {
      const error = new Error('Not Found') as any;
      error.response = { status: 404 };
      mockLoadAccount.mockRejectedValue(error);

      const result = await validateDestinationNetwork(unfundedPublicKey);
      expect(result.valid).toBe(false);
      expect(result.status).toBe('account_not_found');
      expect(result.errorCode).toBe('UNFUNDED_DESTINATION');
      expect(result.localOnly).toBe(false);
    });

    it('should detect inactive account (zero sequence)', async () => {
      mockLoadAccount.mockResolvedValue({
        sequence: '0',
        balances: [],
      });

      const result = await validateDestinationNetwork(validPublicKey);
      expect(result.valid).toBe(false);
      expect(result.status).toBe('account_inactive');
      expect(result.errorCode).toBe('ACCOUNT_INACTIVE');
    });

    it('should detect inactive account (missing sequence)', async () => {
      mockLoadAccount.mockResolvedValue({
        balances: [],
      });

      const result = await validateDestinationNetwork(validPublicKey);
      expect(result.valid).toBe(false);
      expect(result.status).toBe('account_inactive');
    });
  });

  describe('validateDestinationNetwork - Trustline Validation', () => {
    it('should validate native XLM without trustline check', async () => {
      mockLoadAccount.mockResolvedValue({
        sequence: '123456789',
        balances: [],
      });

      const options: DestinationValidationOptions = {
        asset: { code: 'XLM' },
      };

      const result = await validateDestinationNetwork(validPublicKey, options);
      expect(result.valid).toBe(true);
      expect(result.status).toBe('valid_network');
    });

    it('should detect missing trustline for issued asset', async () => {
      mockLoadAccount.mockResolvedValue({
        sequence: '123456789',
        balances: [
          {
            asset_type: 'native',
            balance: '1000',
          },
        ],
      });

      const options: DestinationValidationOptions = {
        asset: { code: 'USDC', issuer: issuerPublicKey },
      };

      const result = await validateDestinationNetwork(validPublicKey, options);
      expect(result.valid).toBe(false);
      expect(result.status).toBe('missing_trustline');
      expect(result.errorCode).toBe('MISSING_TRUSTLINE');
    });

    it('should detect unauthorized trustline', async () => {
      mockLoadAccount.mockResolvedValue({
        sequence: '123456789',
        balances: [
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USDC',
            asset_issuer: issuerPublicKey,
            balance: '100',
            limit: '1000',
            is_authorized: false,
            is_authorized_to_maintain_liabilities: false,
          },
        ],
      });

      const options: DestinationValidationOptions = {
        asset: { code: 'USDC', issuer: issuerPublicKey },
      };

      const result = await validateDestinationNetwork(validPublicKey, options);
      expect(result.valid).toBe(false);
      expect(result.status).toBe('trustline_not_authorized');
      expect(result.errorCode).toBe('TRUSTLINE_NOT_AUTHORIZED');
      expect(result.metadata?.isAuthorized).toBe(false);
    });

    it('should validate authorized trustline', async () => {
      mockLoadAccount.mockResolvedValue({
        sequence: '123456789',
        balances: [
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USDC',
            asset_issuer: issuerPublicKey,
            balance: '100',
            limit: '1000',
            is_authorized: true,
            is_authorized_to_maintain_liabilities: true,
          },
        ],
      });

      const options: DestinationValidationOptions = {
        asset: { code: 'USDC', issuer: issuerPublicKey },
      };

      const result = await validateDestinationNetwork(validPublicKey, options);
      expect(result.valid).toBe(true);
      expect(result.status).toBe('valid_network');
      expect(result.metadata?.isAuthorized).toBe(true);
      expect(result.metadata?.currentBalance).toBe('100');
      expect(result.metadata?.limit).toBe('1000');
    });

    it('rejects an explicitly supplied empty amount before any Horizon lookup', async () => {
      const options: DestinationValidationOptions = {
        asset: { code: 'USDC', issuer: issuerPublicKey },
        amount: '',
      };

      await expect(
        validateDestinationNetwork(validPublicKey, options),
      ).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
      expect(mockLoadAccount).not.toHaveBeenCalled();
    });

    it('should detect trustline limit exceeded', async () => {
      mockLoadAccount.mockResolvedValue({
        sequence: '123456789',
        balances: [
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USDC',
            asset_issuer: issuerPublicKey,
            balance: '900',
            limit: '1000',
            is_authorized: true,
            is_authorized_to_maintain_liabilities: true,
          },
        ],
      });

      const options: DestinationValidationOptions = {
        asset: { code: 'USDC', issuer: issuerPublicKey },
        amount: '200', // Exceeds available capacity of 100
      };

      const result = await validateDestinationNetwork(validPublicKey, options);
      expect(result.valid).toBe(false);
      expect(result.status).toBe('trustline_limit_exceeded');
      expect(result.errorCode).toBe('TRUSTLINE_LIMIT_EXCEEDED');
      expect(result.metadata?.availableCapacity).toBe('100.0000000');
    });

    it('should pass when amount is within trustline capacity', async () => {
      mockLoadAccount.mockResolvedValue({
        sequence: '123456789',
        balances: [
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USDC',
            asset_issuer: issuerPublicKey,
            balance: '100',
            limit: '1000',
            is_authorized: true,
            is_authorized_to_maintain_liabilities: true,
          },
        ],
      });

      const options: DestinationValidationOptions = {
        asset: { code: 'USDC', issuer: issuerPublicKey },
        amount: '50', // Within available capacity of 900
      };

      const result = await validateDestinationNetwork(validPublicKey, options);
      expect(result.valid).toBe(true);
      expect(result.status).toBe('valid_network');
    });

    it('compares trustline capacity in exact stroops, not floats (#307)', async () => {
      const trustline = (balance: string, limit: string) => ({
        sequence: '123456789',
        balances: [
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USDC',
            asset_issuer: issuerPublicKey,
            balance,
            limit,
            is_authorized: true,
            is_authorized_to_maintain_liabilities: true,
          },
        ],
      });
      const asset = { code: 'USDC', issuer: issuerPublicKey };

      mockLoadAccount.mockResolvedValueOnce(trustline('0.0000000', '922337203685.4775807'));
      const fresh = await validateDestinationNetwork(validPublicKey, { asset, amount: '1' });
      expect(fresh.valid).toBe(true);
      expect(fresh.metadata?.availableCapacity).toBe('922337203685.4775807');

      mockLoadAccount.mockResolvedValueOnce(trustline('0.1000000', '0.3000000'));
      const exactFill = await validateDestinationNetwork(validPublicKey, { asset, amount: '0.2' });
      expect(exactFill.valid).toBe(true);
      expect(exactFill.status).toBe('valid_network');

      mockLoadAccount.mockResolvedValueOnce(trustline('899999999999.9999000', '900000000000.0000000'));
      const overflow = await validateDestinationNetwork(validPublicKey, { asset, amount: '0.00011' });
      expect(overflow.valid).toBe(false);
      expect(overflow.status).toBe('trustline_limit_exceeded');
      expect(overflow.metadata?.availableCapacity).toBe('0.0001000');
    });

    it('rejects a malformed capacity amount before the Horizon lookup (#307)', async () => {
      const asset = { code: 'USDC', issuer: issuerPublicKey };
      for (const amount of ['abc', '1e3', '0', '1.12345678', '922337203685.4775808']) {
        await expect(validateDestinationNetwork(validPublicKey, { asset, amount })).rejects.toBeInstanceOf(
          PocketPayError,
        );
      }
      expect(mockLoadAccount).not.toHaveBeenCalled();
    });
  });

  describe('validateDestinationNetwork - Local Validation Prerequisite', () => {
    it('should fail local validation before network call', async () => {
      const invalidKey = 'INVALID_KEY';
      
      const result = await validateDestinationNetwork(invalidKey);
      expect(result.valid).toBe(false);
      expect(result.status).toBe('invalid_address_format');
      expect(result.localOnly).toBe(true);
      expect(mockLoadAccount).not.toHaveBeenCalled();
    });
  });

  describe('safeValidateDestinationNetwork', () => {
    it('should return success result for valid destination', async () => {
      mockLoadAccount.mockResolvedValue({
        sequence: '123456789',
        balances: [],
      });

      const result = await safeValidateDestinationNetwork(validPublicKey);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.valid).toBe(true);
      }
    });

    it('should return failure result for network error', async () => {
      mockLoadAccount.mockRejectedValue(new Error('Network error'));

      const result = await safeValidateDestinationNetwork(validPublicKey);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(PocketPayError);
      }
    });
  });
});

describe('Destination Validation - Complete Validation', () => {
  const validPublicKey = 'GBQ3UUVRLPBINPRTKWKPRQWKA4LYXJCTYYHR5DAICXVYXVFQ32P5CADH';

  const mockLoadAccount = vi.fn();
  const mockServer = {
    loadAccount: mockLoadAccount,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    setHorizonServerFactory(() => mockServer as any);
  });

  afterEach(() => {
    resetHorizonServerFactory();
  });

  describe('validateDestinationComplete', () => {
    it('should perform complete validation by default', async () => {
      mockLoadAccount.mockResolvedValue({
        sequence: '123456789',
        balances: [],
      });

      const result = await validateDestinationComplete(validPublicKey);
      expect(result.valid).toBe(true);
      expect(result.localOnly).toBe(false);
      expect(mockLoadAccount).toHaveBeenCalled();
    });

    it('should perform local-only validation when level is local', async () => {
      const options: DestinationValidationOptions = {
        level: 'local',
      };

      const result = await validateDestinationComplete(validPublicKey, options);
      expect(result.valid).toBe(true);
      expect(result.localOnly).toBe(true);
      expect(mockLoadAccount).not.toHaveBeenCalled();
    });

    it('should perform network validation when level is network', async () => {
      mockLoadAccount.mockResolvedValue({
        sequence: '123456789',
        balances: [],
      });

      const options: DestinationValidationOptions = {
        level: 'network',
      };

      const result = await validateDestinationComplete(validPublicKey, options);
      expect(result.valid).toBe(true);
      expect(result.localOnly).toBe(false);
      expect(mockLoadAccount).toHaveBeenCalled();
    });
  });

  describe('validateDestinationOrThrow', () => {
    it('should return result when validation passes', async () => {
      mockLoadAccount.mockResolvedValue({
        sequence: '123456789',
        balances: [],
      });

      const result = await validateDestinationOrThrow(validPublicKey);
      expect(result.valid).toBe(true);
    });

    it('should throw PocketPayError when validation fails', async () => {
      mockLoadAccount.mockResolvedValue({
        sequence: '123456789',
        balances: [],
      });

      const options: DestinationValidationOptions = {
        sourcePublicKey: validPublicKey,
      };

      await expect(validateDestinationOrThrow(validPublicKey, options))
        .rejects.toThrow(PocketPayError);
    });

    it('should throw with correct error code for unfunded account', async () => {
      const error = new Error('Not Found') as any;
      error.response = { status: 404 };
      mockLoadAccount.mockRejectedValue(error);

      await expect(validateDestinationOrThrow(validPublicKey))
        .rejects.toMatchObject({
          code: 'UNFUNDED_DESTINATION',
        });
    });
  });

  describe('safeValidateDestination', () => {
    it('should return success result for valid destination', async () => {
      mockLoadAccount.mockResolvedValue({
        sequence: '123456789',
        balances: [],
      });

      const result = await safeValidateDestination(validPublicKey);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.valid).toBe(true);
      }
    });

    it('should return failure result for validation error', async () => {
      mockLoadAccount.mockRejectedValue(new Error('Network error'));

      const result = await safeValidateDestination(validPublicKey);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(PocketPayError);
      }
    });
  });
});

describe('Destination Validation - Error Handling', () => {
  const validPublicKey = 'GBQ3UUVRLPBINPRTKWKPRQWKA4LYXJCTYYHR5DAICXVYXVFQ32P5CADH';

  it('should handle network errors gracefully', async () => {
    setHorizonServerFactory(() => ({ loadAccount: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) } as any));

    await expect(validateDestinationNetwork(validPublicKey))
      .rejects.toThrow();
  });

  it('should handle timeout errors', async () => {
    setHorizonServerFactory(() => ({ loadAccount: vi.fn().mockRejectedValue(new Error('TIMEDOUT')) } as any));

    await expect(validateDestinationNetwork(validPublicKey))
      .rejects.toThrow();
  });
});

describe('Destination Validation - Edge Cases', () => {
  const validPublicKey = 'GBQ3UUVRLPBINPRTKWKPRQWKA4LYXJCTYYHR5DAICXVYXVFQ32P5CADH';

  it('should handle case-insensitive asset codes', () => {
    const options: DestinationValidationOptions = {
      asset: { code: 'xlm' },
    };

    const result = validateDestinationLocal(validPublicKey, options);
    expect(result.valid).toBe(true);
  });

  it('should handle case-insensitive native code', () => {
    const options: DestinationValidationOptions = {
      asset: { code: 'NATIVE' },
    };

    const result = validateDestinationLocal(validPublicKey, options);
    expect(result.valid).toBe(true);
  });

  it('should handle asset code with special characters', () => {
    const options: DestinationValidationOptions = {
      asset: { code: 'USDC!', issuer: validPublicKey },
    };

    const result = validateDestinationLocal(validPublicKey, options);
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('INVALID_ASSET_CODE');
  });

  it('should handle asset code at maximum length (12 chars)', () => {
    const options: DestinationValidationOptions = {
      asset: { code: '123456789012', issuer: validPublicKey },
    };

    const result = validateDestinationLocal(validPublicKey, options);
    expect(result.valid).toBe(true);
  });

  it('should handle asset code at minimum length (1 char)', () => {
    const options: DestinationValidationOptions = {
      asset: { code: 'A', issuer: validPublicKey },
    };

    const result = validateDestinationLocal(validPublicKey, options);
    expect(result.valid).toBe(true);
  });

  it('should handle empty options object', () => {
    const result = validateDestinationLocal(validPublicKey, {});
    expect(result.valid).toBe(true);
  });

  it('should handle undefined options', () => {
    const result = validateDestinationLocal(validPublicKey, undefined);
    expect(result.valid).toBe(true);
  });
});
