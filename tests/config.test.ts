/**
 * Tests for the Config module.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  resolveConfig,
  getNetworkPassphrase,
  getFriendbotUrl,
  validateNetwork,
  validateHorizonUrl,
  validateSorobanRpcUrl,
  validateTimeout,
  validateContractId,
  PocketPayError,
} from '../src';
import { getSorobanRpcUrl } from '../src/config';

describe('Config Module', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore env
    process.env = { ...originalEnv };
  });

  describe('resolveConfig', () => {
    it('should default to testnet', () => {
      delete process.env.STELLAR_NETWORK;
      delete process.env.STELLAR_TIMEOUT;
      const config = resolveConfig();
      expect(config.network).toBe('testnet');
      expect(config.horizonUrl).toContain('testnet');
      expect(config.sorobanRpcUrl).toContain('testnet');
      expect(config.timeout).toBe(30000);
    });

    it('should respect environment variables', () => {
      process.env.STELLAR_NETWORK = 'mainnet';
      process.env.STELLAR_SOROBAN_RPC_URL = 'https://rpc.mainnet.example.com';
      const config = resolveConfig();
      expect(config.network).toBe('mainnet');
      expect(config.horizonUrl).toBe('https://horizon.stellar.org');
    });

    it('should allow programmatic overrides', () => {
      const config = resolveConfig({
        network: 'mainnet',
        horizonUrl: 'https://custom-horizon.example.com',
        sorobanRpcUrl: 'https://rpc.mainnet.example.com',
      });
      expect(config.network).toBe('mainnet');
      expect(config.horizonUrl).toBe('https://custom-horizon.example.com');
    });

    it('should prioritize overrides over env vars', () => {
      process.env.STELLAR_NETWORK = 'mainnet';
      const config = resolveConfig({ network: 'testnet' });
      expect(config.network).toBe('testnet');
    });
  });

  describe('resolveConfig - Network Validation', () => {
    it('should reject unsupported network values', () => {
      expect(() => resolveConfig({ network: 'invalid' as any })).toThrow(
        PocketPayError
      );
    });

    it('should reject invalid network from env var', () => {
      process.env.STELLAR_NETWORK = 'production';
      expect(() => resolveConfig()).toThrow(PocketPayError);
    });

    it('should reject null network', () => {
      expect(() => resolveConfig({ network: null as any })).toThrow(
        PocketPayError
      );
    });

    it('should reject empty string network', () => {
      expect(() => resolveConfig({ network: '' as any })).toThrow(
        PocketPayError
      );
    });

    it('should throw INVALID_NETWORK error code', () => {
      try {
        resolveConfig({ network: 'unknown' as any });
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(PocketPayError);
        expect((error as PocketPayError).code).toBe('INVALID_NETWORK');
      }
    });
  });

  describe('resolveConfig - Horizon URL Validation', () => {
    it('should reject invalid Horizon URL', () => {
      expect(() =>
        resolveConfig({ network: 'testnet', horizonUrl: 'not-a-url' })
      ).toThrow(PocketPayError);
    });

    it('should reject empty Horizon URL', () => {
      expect(() =>
        resolveConfig({ network: 'testnet', horizonUrl: '' })
      ).toThrow(PocketPayError);
    });

    it('should reject non-HTTP Horizon URL', () => {
      expect(() =>
        resolveConfig({ network: 'testnet', horizonUrl: 'ftp://example.com' })
      ).toThrow(PocketPayError);
    });

    it('should accept valid HTTPS Horizon URL', () => {
      const config = resolveConfig({
        network: 'testnet',
        horizonUrl: 'https://custom-horizon.example.com',
      });
      expect(config.horizonUrl).toBe('https://custom-horizon.example.com');
    });

    it('should accept valid HTTP Horizon URL', () => {
      const config = resolveConfig({
        network: 'testnet',
        horizonUrl: 'http://localhost:3000',
      });
      expect(config.horizonUrl).toBe('http://localhost:3000');
    });

    it('should throw INVALID_HORIZON_URL error code', () => {
      try {
        resolveConfig({ network: 'testnet', horizonUrl: 'bad-url' });
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(PocketPayError);
        expect((error as PocketPayError).code).toBe('INVALID_HORIZON_URL');
      }
    });

    it('should reject invalid Horizon URL from env var', () => {
      process.env.STELLAR_HORIZON_URL = 'invalid://url';
      expect(() => resolveConfig()).toThrow(PocketPayError);
    });
  });

  describe('resolveConfig - Soroban RPC URL Validation', () => {
    it('should reject invalid Soroban RPC URL', () => {
      expect(() =>
        resolveConfig({
          network: 'testnet',
          sorobanRpcUrl: 'not-a-url',
        })
      ).toThrow(PocketPayError);
    });

    it('should reject empty Soroban RPC URL', () => {
      expect(() =>
        resolveConfig({ network: 'testnet', sorobanRpcUrl: '' })
      ).toThrow(PocketPayError);
    });

    it('should reject non-HTTP Soroban RPC URL', () => {
      expect(() =>
        resolveConfig({
          network: 'testnet',
          sorobanRpcUrl: 'ws://example.com',
        })
      ).toThrow(PocketPayError);
    });

    it('should accept valid HTTPS Soroban RPC URL', () => {
      const config = resolveConfig({
        network: 'testnet',
        sorobanRpcUrl: 'https://custom-soroban.example.com',
      });
      expect(config.sorobanRpcUrl).toBe('https://custom-soroban.example.com');
    });

    it('should throw INVALID_SOROBAN_RPC_URL error code', () => {
      try {
        resolveConfig({ network: 'testnet', sorobanRpcUrl: 'bad-url' });
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(PocketPayError);
        expect((error as PocketPayError).code).toBe('INVALID_SOROBAN_RPC_URL');
      }
    });

    it('should reject invalid Soroban RPC URL from env var', () => {
      process.env.STELLAR_SOROBAN_RPC_URL = 'invalid://url';
      expect(() => resolveConfig()).toThrow(PocketPayError);
    });
  });

  describe('resolveConfig - Timeout Validation', () => {
    it('should reject negative timeout', () => {
      expect(() =>
        resolveConfig({ network: 'testnet', timeout: -1000 })
      ).toThrow(PocketPayError);
    });

    it('should reject zero timeout', () => {
      expect(() =>
        resolveConfig({ network: 'testnet', timeout: 0 })
      ).toThrow(PocketPayError);
    });

    it('should reject non-numeric timeout', () => {
      expect(() =>
        resolveConfig({ network: 'testnet', timeout: 'invalid' as any })
      ).toThrow(PocketPayError);
    });

    it('should reject Infinity timeout', () => {
      expect(() =>
        resolveConfig({ network: 'testnet', timeout: Infinity })
      ).toThrow(PocketPayError);
    });

    it('should accept valid positive timeout', () => {
      const config = resolveConfig({
        network: 'testnet',
        timeout: 30000,
      });
      expect(config.timeout).toBe(30000);
    });

    it('should throw INVALID_TIMEOUT error code', () => {
      try {
        resolveConfig({ network: 'testnet', timeout: -1 });
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(PocketPayError);
        expect((error as PocketPayError).code).toBe('INVALID_TIMEOUT');
      }
    });

    it('should parse timeout from env var', () => {
      process.env.STELLAR_TIMEOUT = '45000';
      const config = resolveConfig();
      expect(config.timeout).toBe(45000);
    });

    it('should reject invalid timeout from env var', () => {
      process.env.STELLAR_TIMEOUT = '-5000';
      expect(() => resolveConfig()).toThrow(PocketPayError);
    });

    it('should use the default timeout when omitted', () => {
      const config = resolveConfig({ network: 'testnet' });
      expect(config.timeout).toBe(30000);
    });
  });

  describe('resolveConfig - Contract ID Validation', () => {
    it('should reject invalid contract ID (wrong length)', () => {
      expect(() =>
        resolveConfig({
          network: 'testnet',
          contractId: 'CABC123',
        })
      ).toThrow(PocketPayError);
    });

    it('should reject contract ID not starting with C', () => {
      const badId = 'GABC2IJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV2RL5';
      expect(() =>
        resolveConfig({
          network: 'testnet',
          contractId: badId,
        })
      ).toThrow(PocketPayError);
    });

    it('should reject contract ID with invalid characters', () => {
      const badId = 'CABC@JKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV2RL5';
      expect(() =>
        resolveConfig({
          network: 'testnet',
          contractId: badId,
        })
      ).toThrow(PocketPayError);
    });

    it('should accept valid 56-character contract ID', () => {
      const validId = 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB2RL5';
      const config = resolveConfig({
        network: 'testnet',
        contractId: validId,
      });
      expect(config.contractId).toBe(validId);
    });

    it('should throw INVALID_CONTRACT_ID error code', () => {
      try {
        resolveConfig({
          network: 'testnet',
          contractId: 'invalid',
        });
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(PocketPayError);
        expect((error as PocketPayError).code).toBe('INVALID_CONTRACT_ID');
      }
    });

    it('should parse contract ID from env var', () => {
      const validId = 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB2RL5';
      process.env.STELLAR_CONTRACT_ID = validId;
      const config = resolveConfig();
      expect(config.contractId).toBe(validId);
    });

    it('should reject invalid contract ID from env var', () => {
      process.env.STELLAR_CONTRACT_ID = 'bad-contract';
      expect(() => resolveConfig()).toThrow(PocketPayError);
    });

    it('should allow undefined contract ID', () => {
      const config = resolveConfig({ network: 'testnet' });
      expect(config.contractId).toBeUndefined();
    });

    it('should allow empty string contract ID', () => {
      const config = resolveConfig({ network: 'testnet', contractId: '' });
      expect(config.contractId).toBe('');
    });
  });

  describe('validateNetwork', () => {
    it('should accept testnet', () => {
      expect(() => validateNetwork('testnet')).not.toThrow();
    });

    it('should accept mainnet', () => {
      expect(() => validateNetwork('mainnet')).not.toThrow();
    });

    it('should reject invalid network', () => {
      expect(() => validateNetwork('invalid')).toThrow(PocketPayError);
    });
  });

  describe('validateHorizonUrl', () => {
    it('should accept valid HTTPS URL', () => {
      expect(() =>
        validateHorizonUrl('https://horizon-testnet.stellar.org')
      ).not.toThrow();
    });

    it('should accept valid HTTP URL', () => {
      expect(() => validateHorizonUrl('http://localhost:8000')).not.toThrow();
    });

    it('should reject invalid URL format', () => {
      expect(() => validateHorizonUrl('not-a-url')).toThrow(PocketPayError);
    });

    it('should reject non-HTTP protocol', () => {
      expect(() => validateHorizonUrl('ftp://example.com')).toThrow(
        PocketPayError
      );
    });
  });

  describe('validateSorobanRpcUrl', () => {
    it('should accept valid HTTPS URL', () => {
      expect(() =>
        validateSorobanRpcUrl('https://soroban-testnet.stellar.org')
      ).not.toThrow();
    });

    it('should accept valid HTTP URL', () => {
      expect(() => validateSorobanRpcUrl('http://localhost:8000')).not.toThrow();
    });

    it('should reject invalid URL format', () => {
      expect(() => validateSorobanRpcUrl('not-a-url')).toThrow(PocketPayError);
    });

    it('should reject non-HTTP protocol', () => {
      expect(() => validateSorobanRpcUrl('ws://example.com')).toThrow(
        PocketPayError
      );
    });
  });

  describe('validateTimeout', () => {
    it('should accept positive number', () => {
      expect(() => validateTimeout(30000)).not.toThrow();
    });

    it('should accept small positive number', () => {
      expect(() => validateTimeout(1)).not.toThrow();
    });

    it('should reject zero', () => {
      expect(() => validateTimeout(0)).toThrow(PocketPayError);
    });

    it('should reject negative number', () => {
      expect(() => validateTimeout(-1000)).toThrow(PocketPayError);
    });

    it('should reject string', () => {
      expect(() => validateTimeout('30000')).toThrow(PocketPayError);
    });

    it('should reject Infinity', () => {
      expect(() => validateTimeout(Infinity)).toThrow(PocketPayError);
    });

    it('should reject NaN', () => {
      expect(() => validateTimeout(NaN)).toThrow(PocketPayError);
    });
  });

  describe('validateContractId', () => {
    it('should accept valid 56-character contract ID', () => {
      const validId = 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB2RL5';
      expect(() => validateContractId(validId)).not.toThrow();
    });

    it('should accept contract ID with base32 characters', () => {
      const validId = 'CBZC2IJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV2RL57';
      expect(() => validateContractId(validId)).not.toThrow();
    });

    it('should reject contract ID with wrong length', () => {
      const badId = 'CABC123';
      expect(() => validateContractId(badId)).toThrow(PocketPayError);
    });

    it('should reject contract ID not starting with C', () => {
      const badId = 'GABC2IJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV2RL5';
      expect(() => validateContractId(badId)).toThrow(PocketPayError);
    });

    it('should reject contract ID with invalid characters', () => {
      const badId = 'CABC-IJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV2RL5';
      expect(() => validateContractId(badId)).toThrow(PocketPayError);
    });

    it('should reject empty string', () => {
      expect(() => validateContractId('')).toThrow(PocketPayError);
    });

    it('should reject non-string', () => {
      expect(() => validateContractId(null as any)).toThrow(PocketPayError);
    });
  });

  describe('getNetworkPassphrase', () => {
    it('should return testnet passphrase by default', () => {
      const passphrase = getNetworkPassphrase('testnet');
      expect(passphrase).toContain('Test SDF Network');
    });

    it('should return mainnet passphrase', () => {
      const passphrase = getNetworkPassphrase('mainnet');
      expect(passphrase).toContain('Public Global Stellar Network');
    });

    it('should throw for invalid network', () => {
      expect(() => getNetworkPassphrase('invalid' as any)).toThrow(
        PocketPayError
      );
    });
  });

  describe('getFriendbotUrl', () => {
    it('should return the friendbot URL', () => {
      const url = getFriendbotUrl();
      expect(url).toBe('https://friendbot.stellar.org');
    });
  });

  describe('getSorobanRpcUrl', () => {
    it('should return the testnet Soroban RPC URL by default', () => {
      delete process.env.STELLAR_NETWORK;
      delete process.env.STELLAR_SOROBAN_RPC_URL;
      expect(getSorobanRpcUrl()).toBe('https://soroban-testnet.stellar.org');
    });

    it('should require a Soroban RPC provider for mainnet', () => {
      delete process.env.STELLAR_SOROBAN_RPC_URL;
      expect(() => getSorobanRpcUrl({ network: 'mainnet' })).toThrow(PocketPayError);
    });

    it('should respect an explicit sorobanRpcUrl override', () => {
      expect(
        getSorobanRpcUrl({ sorobanRpcUrl: 'https://custom-soroban.example.org' })
      ).toBe('https://custom-soroban.example.org');
    });

    it('should respect the STELLAR_SOROBAN_RPC_URL env var', () => {
      process.env.STELLAR_SOROBAN_RPC_URL = 'https://env-soroban.example.org';
      expect(getSorobanRpcUrl()).toBe('https://env-soroban.example.org');
    });
  });
});

