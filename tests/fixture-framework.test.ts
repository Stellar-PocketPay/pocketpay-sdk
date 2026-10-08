import { describe, expect, it } from 'vitest';
import {
  AccountBuilder, PaymentBuilder, TransactionBuilder, VaultBuilder,
  NetworkBuilder, SorobanBuilder, createSdkScenario, sdkScenarioKinds,
  createFetchFromFixture, networkFixtures,
} from './fixtures';

describe('deterministic SDK integration fixtures (#318)', () => {
  it('fixes default timestamps in account, payment, transaction and vault builders', () => {
    const a = [AccountBuilder, PaymentBuilder, TransactionBuilder, VaultBuilder];
    for (const Builder of a) {
      const first = new Builder().build();
      const second = new Builder().build();
      expect(first.createdAt.toISOString()).toBe('2024-01-15T10:30:00.000Z');
      expect(first).toEqual(second);
      expect(first.createdAt).not.toBe(second.createdAt);
    }
  });

  it('copies nested values and dates on set, build, clone, merge and reset', () => {
    const input = [{ type: 'success', nested: { value: 1 } }];
    const builder = new SorobanBuilder().withParams(input);
    const first = builder.build();
    first.params![0].nested.value = 9;
    const second = builder.clone().build();
    expect(second.params![0].nested.value).toBe(1);
    input[0].nested.value = 8;
    expect(builder.build().params![0].nested.value).toBe(1);

    const account = new AccountBuilder().withBalance('5').set('createdAt', new Date('2020-01-01T00:00:00Z'));
    const copy = account.clone().build();
    copy.createdAt.setFullYear(1999);
    expect(account.build().createdAt.getUTCFullYear()).toBe(2020);
    expect(account.reset().build().balance).toBe('0.00');

    const network = new NetworkBuilder().merge({ data: { nested: ['a'] } });
    const built = network.build();
    built.data.nested.push('b');
    expect(network.build().data.nested).toEqual(['a']);
  });

  it('returns a fresh correlated response set for all five named outcomes', () => {
    expect(sdkScenarioKinds).toEqual(['success', 'failure', 'timeout', 'unsupported', 'unknown']);
    for (const outcome of sdkScenarioKinds) {
      const first = createSdkScenario(outcome);
      const again = createSdkScenario(outcome);
      expect(first).toEqual(again);
      first.account.createdAt.setFullYear(1999);
      expect(again.account.createdAt.getUTCFullYear()).toBe(2024);
    }
    expect(createSdkScenario('unknown').transaction.status).toBe('unknown');
    expect(createSdkScenario('unsupported').soroban.error).toBe('Unsupported feature');
    expect(createSdkScenario('timeout').network.timeout).toBe(true);
  });

  it('adapts immutable network scenarios to distinct fetch responses', async () => {
    const network = createFetchFromFixture(networkFixtures.success);
    const first = await network('https://example.test/');
    const payload = await first.json() as { success: boolean };
    payload.success = false;
    const again = await network('https://example.test/');
    expect(await again.json()).toEqual({ success: true, result: 'success' });
    expect(again.status).toBe(200);
  });

  it('models rate-limited and abort/timeout fetch paths without real I/O', async () => {
    const rateLimited = await createFetchFromFixture(networkFixtures.rateLimited)('https://example.test/');
    expect(rateLimited.status).toBe(429);
    expect(rateLimited.headers.get('retry-after')).toBe('60');
    await expect(createFetchFromFixture(networkFixtures.timeout)('https://example.test/'))
      .rejects.toMatchObject({ name: 'AbortError' });
  });
});
