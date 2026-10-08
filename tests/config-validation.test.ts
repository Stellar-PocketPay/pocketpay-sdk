import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  validatePocketPayConfig,
  getNetworkPassphrase,
  ConfigValidationResult,
  ConfigValidationIssue,
} from '../src';

describe('validatePocketPayConfig', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.STELLAR_NETWORK;
    delete process.env.STELLAR_HORIZON_URL;
    delete process.env.STELLAR_SOROBAN_RPC_URL;
    delete process.env.STELLAR_TIMEOUT;
    delete process.env.STELLAR_CONTRACT_ID;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('Valid Configuration', () => {
    it('returns valid result with default testnet config when called with no arguments', () => {
      const result = validatePocketPayConfig();

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
      expect(result.issues).toHaveLength(0);
      expect(result.config).toBeDefined();
      expect(result.config?.network).toBe('testnet');
      expect(result.config?.networkPassphrase).toBe(
        getNetworkPassphrase('testnet')
      );
      expect(result.config?.horizonUrl).toContain('testnet');
      expect(result.config?.sorobanRpcUrl).toContain('testnet');
      expect(result.config?.timeout).toBe(30000);
    });

    it('returns valid result for explicit valid testnet overrides', () => {
      const result = validatePocketPayConfig({
        network: 'testnet',
        horizonUrl: 'https://custom-testnet.example.com',
        sorobanRpcUrl: 'https://custom-soroban-testnet.example.com',
        timeout: 15000,
        contractId: 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB2RL5',
      });

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.config).toMatchObject({
        network: 'testnet',
        horizonUrl: 'https://custom-testnet.example.com',
        sorobanRpcUrl: 'https://custom-soroban-testnet.example.com',
        timeout: 15000,
        contractId: 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB2RL5',
      });
    });

    it('returns valid result for explicit valid mainnet config', () => {
      const result = validatePocketPayConfig({
        network: 'mainnet',
        networkPassphrase: getNetworkPassphrase('mainnet'),
        horizonUrl: 'https://horizon.stellar.org',
        sorobanRpcUrl: 'https://rpc.mainnet.example.com',
        timeout: 30000,
      });

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.config?.network).toBe('mainnet');
    });
  });

  describe('Malformed & Invalid Inputs (Errors)', () => {
    it('reports error for unsupported network name', () => {
      const result = validatePocketPayConfig({ network: 'invalid-net' as any });

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({
        severity: 'error',
        field: 'network',
        code: 'INVALID_NETWORK',
      });
      expect(result.config).toBeUndefined();
    });

    it('reports a typed error for a network passphrase mismatch', () => {
      const result = validatePocketPayConfig({
        network: 'mainnet',
        networkPassphrase: getNetworkPassphrase('testnet'),
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          field: 'networkPassphrase',
          code: 'INVALID_NETWORK_PASSPHRASE',
        })
      );
      expect(result.config).toBeUndefined();
    });

    it('reports error for invalid Horizon URL format and protocol', () => {
      const result = validatePocketPayConfig({
        horizonUrl: 'not-a-url',
      });

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'horizonUrl' && e.code === 'INVALID_HORIZON_URL')).toBe(true);

      const ftpResult = validatePocketPayConfig({
        horizonUrl: 'ftp://horizon.example.com',
      });
      expect(ftpResult.valid).toBe(false);
      expect(ftpResult.errors.some((e) => e.field === 'horizonUrl')).toBe(true);
    });

    it('reports error for invalid Soroban RPC URL format and protocol', () => {
      const result = validatePocketPayConfig({
        sorobanRpcUrl: 'ws://soroban.example.com',
      });

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'sorobanRpcUrl' && e.code === 'INVALID_SOROBAN_RPC_URL')).toBe(true);
    });

    it('reports error for negative or zero timeout', () => {
      const negResult = validatePocketPayConfig({ timeout: -5000 });
      expect(negResult.valid).toBe(false);
      expect(negResult.errors.some((e) => e.field === 'timeout' && e.code === 'INVALID_TIMEOUT')).toBe(true);

      const zeroResult = validatePocketPayConfig({ timeout: 0 });
      expect(zeroResult.valid).toBe(false);
      expect(zeroResult.errors.some((e) => e.field === 'timeout' && e.code === 'INVALID_TIMEOUT')).toBe(true);
    });

    it('reports error for non-numeric or NaN timeout', () => {
      const strResult = validatePocketPayConfig({ timeout: 'invalid' as any });
      expect(strResult.valid).toBe(false);
      expect(strResult.errors.some((e) => e.field === 'timeout')).toBe(true);

      const nanResult = validatePocketPayConfig({ timeout: NaN });
      expect(nanResult.valid).toBe(false);
      expect(nanResult.errors.some((e) => e.field === 'timeout')).toBe(true);
    });

    it('reports error for malformed contract ID', () => {
      const badLength = validatePocketPayConfig({ contractId: 'C123' });
      expect(badLength.valid).toBe(false);
      expect(badLength.errors.some((e) => e.field === 'contractId' && e.code === 'INVALID_CONTRACT_ID')).toBe(true);

      const badPrefix = validatePocketPayConfig({
        contractId: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB2RL5',
      });
      expect(badPrefix.valid).toBe(false);
      expect(badPrefix.errors.some((e) => e.field === 'contractId')).toBe(true);
    });
  });

  describe('Advisory Warnings', () => {
    it('warns when unencrypted HTTP protocol is used for remote host', () => {
      const result = validatePocketPayConfig({
        horizonUrl: 'http://remote-horizon.example.com',
      });

      expect(result.valid).toBe(true); // Warning does not invalidate config
      expect(result.warnings.some((w) => w.code === 'INSECURE_HTTP_URL' && w.field === 'horizonUrl')).toBe(true);
    });

    it('does not warn for http protocol on localhost', () => {
      const result = validatePocketPayConfig({
        horizonUrl: 'http://localhost:8000',
        sorobanRpcUrl: 'http://127.0.0.1:8000',
      });

      expect(result.valid).toBe(true);
      expect(result.warnings.filter((w) => w.code === 'INSECURE_HTTP_URL')).toHaveLength(0);
    });

    it('warns when endpoint network does not match configured network', () => {
      const result = validatePocketPayConfig({
        network: 'mainnet',
        horizonUrl: 'https://horizon-testnet.stellar.org',
        sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
      });

      expect(result.valid).toBe(true);
      expect(result.warnings.filter((w) => w.code === 'NETWORK_MISMATCH')).toHaveLength(2);
    });

    it('warns when extreme timeout values are configured', () => {
      const lowResult = validatePocketPayConfig({ timeout: 500 });
      expect(lowResult.valid).toBe(true);
      expect(lowResult.warnings.some((w) => w.code === 'EXTREME_TIMEOUT')).toBe(true);

      const highResult = validatePocketPayConfig({ timeout: 150000 });
      expect(highResult.valid).toBe(true);
      expect(highResult.warnings.some((w) => w.code === 'EXTREME_TIMEOUT')).toBe(true);
    });
  });

  describe('Security & Sensitive Data Redaction', () => {
    it('does not expose secret key material in issue outputs', () => {
      const secretKey = 'SDXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX4L5';
      const result = validatePocketPayConfig({
        network: secretKey as any,
      });

      expect(result.valid).toBe(false);
      const issue = result.errors.find((e) => e.field === 'network');
      expect(issue).toBeDefined();

      const issueStr = JSON.stringify(issue);
      expect(issueStr).not.toContain(secretKey);
      expect(issueStr).toContain('S[REDACTED]');
    });
  });
});
