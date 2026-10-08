import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  diagnoseTestnetAccount,
  resetHorizonServerFactory,
  setHorizonServerFactory,
} from '../src';
import { testnetAccountFixtures } from './fixtures/testnet-accounts';

describe('diagnoseTestnetAccount', () => {
  afterEach(() => {
    resetHorizonServerFactory();
  });

  it('maps a funded Testnet lookup to a funded diagnostic', async () => {
    const lookup = vi.fn(async () => testnetAccountFixtures.funded.result);

    const result = await diagnoseTestnetAccount(
      testnetAccountFixtures.funded.publicKey,
      { lookup },
    );

    expect(lookup).toHaveBeenCalledOnce();
    expect(lookup).toHaveBeenCalledWith(testnetAccountFixtures.funded.publicKey);
    expect(result).toEqual({
      publicKey: testnetAccountFixtures.funded.publicKey,
      network: 'testnet',
      testnetOnly: true,
      status: 'funded',
      balance: testnetAccountFixtures.funded.result.balance,
    });
  });

  it('maps an unfunded Testnet lookup without treating it as an error', async () => {
    const result = await diagnoseTestnetAccount(
      testnetAccountFixtures.unfunded.publicKey,
      { lookup: async () => testnetAccountFixtures.unfunded.result },
    );

    expect(result).toEqual({
      publicKey: testnetAccountFixtures.unfunded.publicKey,
      network: 'testnet',
      testnetOnly: true,
      status: 'unfunded',
    });
  });

  it('maps lookup failures to a stable unavailable diagnostic without leaking raw errors', async () => {
    const result = await diagnoseTestnetAccount(
      testnetAccountFixtures.funded.publicKey,
      {
        lookup: async () => {
          throw new Error('provider detail that should not escape');
        },
      },
    );

    expect(result).toEqual({
      publicKey: testnetAccountFixtures.funded.publicKey,
      network: 'testnet',
      testnetOnly: true,
      status: 'unavailable',
      message: 'Testnet account state could not be determined.',
    });
    expect(JSON.stringify(result)).not.toContain('provider detail');
  });

  it('preserves a typed error code while keeping the unavailable message safe', async () => {
    const result = await diagnoseTestnetAccount(
      testnetAccountFixtures.funded.publicKey,
      {
        lookup: async () => {
          throw Object.assign(new Error('internal endpoint failure'), {
            code: 'NET_UNREACHABLE',
          });
        },
      },
    );

    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') {
      expect(result.errorCode).toBe('NET_UNREACHABLE');
      expect(result.message).not.toContain('internal endpoint');
    }
  });

  it('drops unrecognized provider codes and hostile getters from shareable diagnostics', async () => {
    const invalidCodes: unknown[] = [
      { code: 'PROVIDER_PRIVATE_METADATA' },
      { code: 'S' + 'A'.repeat(55) },
      Object.defineProperty({}, 'code', {
        get() { throw new Error('private provider details'); },
      }),
    ];

    for (const thrown of invalidCodes) {
      const result = await diagnoseTestnetAccount(
        testnetAccountFixtures.funded.publicKey,
        { lookup: async () => { throw thrown; } },
      );
      expect(result.status).toBe('unavailable');
      if (result.status === 'unavailable') {
        expect(result.errorCode).toBeUndefined();
        expect(result.message).toBe('Testnet account state could not be determined.');
      }
      expect(JSON.stringify(result)).not.toContain('PRIVATE');
    }
  });


  it('rejects malformed funded native balances from injected lookup adapters', async () => {
    const funded = testnetAccountFixtures.funded.result;
    const publicKey = testnetAccountFixtures.funded.publicKey;

    for (const nativeBalance of ['NaN', 'Infinity', '-1.0000000', '1e5', '0.00000001']) {
      const result = await diagnoseTestnetAccount(publicKey, {
        lookup: async () => ({
          ...funded,
          balance: { ...funded.balance, nativeBalance },
        }),
      });
      expect(result.status).toBe('unavailable');
    }

    const inconsistentNativeEntry = await diagnoseTestnetAccount(publicKey, {
      lookup: async () => ({
        ...funded,
        balance: {
          ...funded.balance,
          balances: funded.balance.balances.map((entry) =>
            entry.asset === 'XLM'
              ? { ...entry, balance: '24.0000000' }
              : entry,
          ),
        },
      }),
    });
    expect(inconsistentNativeEntry.status).toBe('unavailable');

    const valid = await diagnoseTestnetAccount(publicKey, {
      lookup: async () => ({
        ...funded,
        balance: { ...funded.balance, nativeBalance: '0.0000001' },
      }),
    });
    expect(valid.status).toBe('funded');
  });

  it('does not mislabel another account or an unknown lookup result as funded/unfunded', async () => {
    const queried = testnetAccountFixtures.funded.publicKey;
    const another = testnetAccountFixtures.unfunded.publicKey;
    const funded = testnetAccountFixtures.funded.result;
    const unfunded = testnetAccountFixtures.unfunded.result;

    const malformed = [
      { ...funded, publicKey: another },
      { ...funded, balance: { ...funded.balance, publicKey: another } },
      { ...unfunded, publicKey: another },
      { status: 'unavailable', publicKey: queried },
      { status: 'unexpected', publicKey: queried },
      { status: 'funded', publicKey: queried, balance: undefined },
    ];

    for (const result of malformed) {
      const diagnosis = await diagnoseTestnetAccount(queried, {
        lookup: async () => result as never,
      });
      expect(diagnosis).toEqual({
        publicKey: queried,
        network: 'testnet',
        testnetOnly: true,
        status: 'unavailable',
        message: 'Testnet account state could not be determined.',
      });
      expect(JSON.stringify(diagnosis)).not.toContain('unexpected');
    }
  });

  it('rejects malformed public keys before invoking a lookup', async () => {
    const lookup = vi.fn(async () => testnetAccountFixtures.unfunded.result);

    await expect(
      diagnoseTestnetAccount('not-a-stellar-account', { lookup }),
    ).rejects.toThrow();

    expect(lookup).not.toHaveBeenCalled();
  });

  it('rejects surrounding whitespace before lookup instead of returning unavailable', async () => {
    const lookup = vi.fn(async () => testnetAccountFixtures.unfunded.result);
    const padded = ` ${testnetAccountFixtures.funded.publicKey} `;

    await expect(
      diagnoseTestnetAccount(padded, { lookup }),
    ).rejects.toMatchObject({
      code: 'INVALID_PUBLIC_KEY',
      validation: {
        field: 'publicKey',
        reason: 'surrounding_whitespace',
      },
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('rejects secret-shaped public-key input without echoing it', async () => {
    const lookup = vi.fn(async () => testnetAccountFixtures.unfunded.result);
    const secretLike = `S${'A'.repeat(55)}`;

    let thrown: unknown;
    try {
      await diagnoseTestnetAccount(secretLike, { lookup });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: 'INVALID_PUBLIC_KEY',
      validation: {
        field: 'publicKey',
        reason: 'secret_key_not_allowed',
      },
    });
    expect((thrown as Error).message).not.toContain(secretLike);
    expect(JSON.stringify(thrown)).not.toContain(secretLike);
    expect(lookup).not.toHaveBeenCalled();
  });
  it('pins the default lookup to Testnet Horizon despite caller endpoint overrides', async () => {
    let requestedUrl: string | undefined;
    setHorizonServerFactory((url) => {
      requestedUrl = url;
      return {
        loadAccount: async () => ({
          balances: [
            {
              asset_type: 'native',
              balance: '25.0000000',
            },
          ],
        }),
      } as any;
    });

    const result = await diagnoseTestnetAccount(
      testnetAccountFixtures.funded.publicKey,
      {
        config: {
          network: 'mainnet',
          horizonUrl: 'https://horizon.stellar.org',
        },
      },
    );

    expect(requestedUrl).toBe('https://horizon-testnet.stellar.org');
    expect(result.status).toBe('funded');
    expect(result.network).toBe('testnet');
    expect(result.testnetOnly).toBe(true);
  });

});
