/**
 * Issue #314 residual: the lifecycle entry point must consume the existing
 * per-account SequenceProvider, not just offer it as an opt-in helper.
 * Only this bounded integration case is needed; SequenceProvider itself has
 * its own existing concurrency tests.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as StellarSDK from '@stellar/stellar-sdk';
// Import from the published package root: consumers must reach the guarded lifecycle.
import { executeTransactionLifecycle } from '../src';

afterEach(() => vi.restoreAllMocks());

describe('orchestrated same-account submissions', () => {
  it('waits for first submission before fetching the next sequence', async () => {
    const source = StellarSDK.Keypair.random();
    const recipient = StellarSDK.Keypair.random().publicKey();
    const params = {
      sourcePublicKey: source.publicKey(),
      operations: [{
        destination: recipient,
        amount: '1',
        asset: { code: 'XLM' },
      }],
    };

    let networkSequence = 100n;
    // Actual Horizon AccountResponse.sequence is decimal text, unlike
    // the BigNumber exposed by a bare SDK Account constructor.
    const loadAccount = vi.spyOn(StellarSDK.Horizon.Server.prototype, 'loadAccount')
      .mockImplementation(async () => new StellarSDK.Horizon.AccountResponse({
        id: source.publicKey(),
        account_id: source.publicKey(),
        sequence: networkSequence.toString(),
        balances: [],
      } as never));
    vi.spyOn(StellarSDK.Horizon.Server.prototype, 'feeStats')
      .mockResolvedValue({
        ledger_capacity_usage: '0.1',
        max_fee: { p10: '100', p50: '100', p95: '100' },
        last_ledger_base_fee: '100',
      } as never);

    let markFirstSubmit!: () => void;
    const firstSubmitted = new Promise<void>(resolve => { markFirstSubmit = resolve; });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const sequences: string[] = [];
    vi.spyOn(StellarSDK.Horizon.Server.prototype, 'submitTransaction')
      .mockImplementation(async (transaction) => {
        // This lifecycle builds plain transactions, not fee-bump wrappers.
        const tx = transaction as StellarSDK.Transaction;
        sequences.push(tx.sequence);
        if (sequences.length === 1) {
          markFirstSubmit();
          await firstGate;
        }
        networkSequence = BigInt(tx.sequence);
        return {
          hash: tx.hash().toString('hex'),
          ledger: 123,
          successful: true,
        } as never;
      });

    // Without the orchestrator lock, both requests reach loadAccount before
    // either submission settles and create envelopes with the same sequence.
    const one = executeTransactionLifecycle(params, source.secret());
    const two = executeTransactionLifecycle(params, source.secret());
    await firstSubmitted;
    const readsWhileFirstPending = loadAccount.mock.calls.length;
    releaseFirst();

    const [first, second] = await Promise.all([one, two]);
    expect(first.state).toBe('confirmed');
    expect(second.state).toBe('confirmed');
    expect(readsWhileFirstPending).toBe(1);
    expect(loadAccount).toHaveBeenCalledTimes(2);
    expect(sequences).toEqual(['101', '102']);
  });

  it.each([
    {
      name: 'explicit rejection',
      response: (transaction: StellarSDK.Transaction) => ({
        hash: transaction.hash().toString('hex'),
        successful: false,
      }),
      state: 'rejected',
    },
    {
      name: 'mismatched transaction hash',
      response: () => ({
        hash: '0'.repeat(64),
        successful: true,
      }),
      state: 'unresolved',
    },
    {
      name: 'missing successful flag',
      response: (transaction: StellarSDK.Transaction) => ({
        hash: transaction.hash().toString('hex'),
      }),
      state: 'unresolved',
    },
    {
      name: 'verified matching success',
      response: (transaction: StellarSDK.Transaction) => ({
        hash: transaction.hash().toString('hex'),
        successful: true,
      }),
      state: 'confirmed',
    },
  ])('classifies $name ledger evidence as $state', async ({ response, state }) => {
    const source = StellarSDK.Keypair.random();
    const recipient = StellarSDK.Keypair.random().publicKey();

    vi.spyOn(StellarSDK.Horizon.Server.prototype, 'loadAccount')
      .mockResolvedValue(new StellarSDK.Horizon.AccountResponse({
        id: source.publicKey(),
        account_id: source.publicKey(),
        sequence: '100',
        balances: [],
      } as never));
    vi.spyOn(StellarSDK.Horizon.Server.prototype, 'feeStats')
      .mockResolvedValue({
        ledger_capacity_usage: '0.1',
        max_fee: { p10: '100', p50: '100', p95: '100' },
        last_ledger_base_fee: '100',
      } as never);
    vi.spyOn(StellarSDK.Horizon.Server.prototype, 'submitTransaction')
      .mockImplementation(async (transaction) =>
        response(transaction as StellarSDK.Transaction) as never);

    const result = await executeTransactionLifecycle(
      {
        sourcePublicKey: source.publicKey(),
        operations: [{
          destination: recipient,
          amount: '1',
          asset: { code: 'XLM' },
        }],
      },
      source.secret(),
    );

    expect(result.state).toBe(state);
  });
});
