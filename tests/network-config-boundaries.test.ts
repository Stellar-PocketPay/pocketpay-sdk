import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getNetworkPassphrase,
  resolveConfig,
  validatePocketPayConfig,
} from '../src';

function expectConfigError(run: () => unknown, code: string): void {
  try {
    run();
    throw new Error(`Expected configuration error ${code}`);
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

describe('network configuration preset boundaries', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.STELLAR_NETWORK;
    delete process.env.STELLAR_HORIZON_URL;
    delete process.env.STELLAR_SOROBAN_RPC_URL;
    delete process.env.STELLAR_TIMEOUT;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('rejects an explicit null passphrase instead of silently using a preset', () => {
    expectConfigError(
      () =>
        resolveConfig({
          network: 'testnet',
          networkPassphrase: null as unknown as string,
        }),
      'INVALID_NETWORK_PASSPHRASE'
    );

    expect(
      validatePocketPayConfig({
        network: 'testnet',
        networkPassphrase: null,
      })
    ).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        expect.objectContaining({
          field: 'networkPassphrase',
          code: 'INVALID_NETWORK_PASSPHRASE',
        }),
      ]),
    });
  });

  it('rejects URL schemes that merely begin with http', () => {
    expectConfigError(
      () => resolveConfig({ horizonUrl: 'httpx://horizon.example.com' }),
      'INVALID_HORIZON_URL'
    );

    expectConfigError(
      () => resolveConfig({ sorobanRpcUrl: 'httpsx://rpc.example.com' }),
      'INVALID_SOROBAN_RPC_URL'
    );

    const result = validatePocketPayConfig({
      horizonUrl: 'httpx://horizon.example.com',
      sorobanRpcUrl: 'httpsx://rpc.example.com',
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'horizonUrl',
          code: 'INVALID_HORIZON_URL',
        }),
        expect.objectContaining({
          field: 'sorobanRpcUrl',
          code: 'INVALID_SOROBAN_RPC_URL',
        }),
      ])
    );
    expect(result.config).toBeUndefined();
  });

  it('requires an explicit Mainnet RPC provider', () => {
    delete process.env.STELLAR_SOROBAN_RPC_URL;

    expectConfigError(
      () => resolveConfig({ network: 'mainnet' }),
      'INVALID_SOROBAN_RPC_URL'
    );

    expect(validatePocketPayConfig({ network: 'mainnet' })).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        expect.objectContaining({
          field: 'sorobanRpcUrl',
          code: 'INVALID_SOROBAN_RPC_URL',
        }),
      ]),
    });
  });

  it('resolves the ambient network passphrase without requiring unrelated RPC config', () => {
    process.env.STELLAR_NETWORK = 'mainnet';
    delete process.env.STELLAR_SOROBAN_RPC_URL;

    expect(getNetworkPassphrase()).toBe(getNetworkPassphrase('mainnet'));
  });

  it('preserves a valid explicit passphrase and its override source', () => {
    const config = resolveConfig({
      network: 'mainnet',
      networkPassphrase: getNetworkPassphrase('mainnet'),
      sorobanRpcUrl: 'https://rpc.mainnet.example.com',
    });

    expect(config.networkPassphrase).toBe(getNetworkPassphrase('mainnet'));
    expect(config.sources.networkPassphrase).toBe('override');
  });

  it('rejects malformed or empty timeout environment values', () => {
    process.env.STELLAR_TIMEOUT = '1000ms';

    expectConfigError(() => resolveConfig(), 'INVALID_TIMEOUT');
    expect(validatePocketPayConfig()).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        expect.objectContaining({
          field: 'timeout',
          code: 'INVALID_TIMEOUT',
        }),
      ]),
    });

    process.env.STELLAR_TIMEOUT = '';

    expectConfigError(() => resolveConfig(), 'INVALID_TIMEOUT');
    expect(validatePocketPayConfig()).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        expect.objectContaining({
          field: 'timeout',
          code: 'INVALID_TIMEOUT',
        }),
      ]),
    });
  });

  it('rejects explicit null timeout in both validators', () => {
    expectConfigError(
      () => resolveConfig({ timeout: null as unknown as number }),
      'INVALID_TIMEOUT'
    );

    expect(validatePocketPayConfig({ timeout: null })).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        expect.objectContaining({
          field: 'timeout',
          code: 'INVALID_TIMEOUT',
        }),
      ]),
    });
  });

  it('rejects explicit null contract IDs without a runtime TypeError', () => {
    expectConfigError(
      () => resolveConfig({ contractId: null as unknown as string }),
      'INVALID_CONTRACT_ID'
    );

    expect(validatePocketPayConfig({ contractId: null })).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        expect.objectContaining({
          field: 'contractId',
          code: 'INVALID_CONTRACT_ID',
        }),
      ]),
    });
  });

  it('preserves the intentional empty contract ID sentinel', () => {
    expect(resolveConfig({ contractId: '' }).contractId).toBe('');
    expect(validatePocketPayConfig({ contractId: '' }).valid).toBe(true);
  });

  it('redacts sensitive configuration values from thrown errors and validation issues', () => {
    const token = 'private-api-token-987654321';
    const invalidUrl = `httpx://horizon.example.test/?api_key=${token}`;

    try {
      resolveConfig({ horizonUrl: invalidUrl });
      throw new Error('Expected invalid Horizon URL');
    } catch (error) {
      expect(String(error)).not.toContain(token);
      expect(JSON.stringify(error)).not.toContain(token);
    }

    const rejected = validatePocketPayConfig({
      horizonUrl: invalidUrl,
      sorobanRpcUrl: `httpsx://rpc.example.test/?token=${token}`,
      contractId: token,
      network: 'testnet',
    });
    expect(rejected.valid).toBe(false);
    expect(JSON.stringify(rejected.issues)).not.toContain(token);

    const invalidTimeout = validatePocketPayConfig({
      timeout: token as unknown as number,
    });
    expect(invalidTimeout.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'timeout',
          code: 'INVALID_TIMEOUT',
        }),
      ])
    );
    expect(JSON.stringify(invalidTimeout.issues)).not.toContain(token);

    const warnings = validatePocketPayConfig({
      horizonUrl: `http://horizon.example.test/?api_key=${token}`,
    });
    expect(warnings.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'INSECURE_HTTP_URL' }),
      ])
    );
    expect(JSON.stringify(warnings.issues)).not.toContain(token);
  });

});
