/**
 * Unit handling of the HIGH_FEE_RATIO warning in enhancedSendXLM.
 *
 * `PaymentResult.fee` is Horizon's `fee_charged`, a whole number of stroops,
 * while `amount` is a decimal XLM string (1 XLM = 10,000,000 stroops). The
 * warning is documented as "fee > 10% of amount", so both sides must be in the
 * same unit before the ratio is taken. Dividing stroops by XLM inflates the
 * ratio by 10^7: a 100-stroop base fee on a 1 XLM payment (a 0.001% fee) used
 * to warn, and so did every payment below 1000 XLM.
 *
 * All tests run offline — Horizon is mocked and no live network is used.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { enhancedSendXLM, createWallet } from '../src';

const mockLoadAccount = vi.fn();
const mockSubmitTransaction = vi.fn();

vi.mock('@stellar/stellar-sdk', async (importActual) => {
  const actual = await importActual<typeof import('@stellar/stellar-sdk')>();
  return {
    ...actual,
    Horizon: {
      ...actual.Horizon,
      Server: vi.fn().mockImplementation(() => ({
        loadAccount: mockLoadAccount,
        submitTransaction: mockSubmitTransaction,
      })),
    },
  };
});

async function sourceAccountFor(publicKey: string, sequence = '100') {
  const { Account } = await import('@stellar/stellar-sdk');
  return new Account(publicKey, sequence);
}

/** Sends `amount` XLM with Horizon reporting `feeCharged` stroops. */
async function sendWithFee(amount: string, feeCharged: string | number) {
  const sender = createWallet();
  const receiver = createWallet();
  mockLoadAccount.mockResolvedValueOnce(await sourceAccountFor(sender.publicKey));
  mockSubmitTransaction.mockResolvedValueOnce({
    hash: 'FEE_WARNING_HASH',
    ledger: 42,
    fee_charged: feeCharged,
    created_at: '2026-10-06T12:00:00Z',
  });
  return enhancedSendXLM({
    sourceSecret: sender.secretKey,
    destination: receiver.publicKey,
    amount,
  });
}

function highFeeWarnings(result: Awaited<ReturnType<typeof enhancedSendXLM>>) {
  expect(result.ok).toBe(true);
  return (result.warnings ?? []).filter((w) => w.code === 'HIGH_FEE_RATIO');
}

describe('enhancedSendXLM — HIGH_FEE_RATIO compares fee and amount in the same unit', () => {
  beforeEach(() => {
    mockLoadAccount.mockReset();
    mockSubmitTransaction.mockReset();
  });

  it('does not warn for the 100-stroop base fee on a 1 XLM payment', async () => {
    // 100 stroops = 0.00001 XLM, i.e. 0.001% of 1 XLM.
    const result = await sendWithFee('1', '100');
    expect(highFeeWarnings(result)).toHaveLength(0);
    expect(result.ok && result.warnings).toBeFalsy();
  });

  it('does not warn for the base fee on a small 0.01 XLM payment', async () => {
    // 100 stroops is 0.1% of 0.01 XLM (100,000 stroops).
    const result = await sendWithFee('0.01', '100');
    expect(highFeeWarnings(result)).toHaveLength(0);
  });

  it('warns when the fee really is more than 10% of the amount', async () => {
    // 0.0000001 XLM = 1 stroop; a 100-stroop fee is 10,000% of it.
    const result = await sendWithFee('0.0000001', '100');
    const warnings = highFeeWarnings(result);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('100 stroops');
  });

  it('warns just above the 10% threshold and not at it', async () => {
    // 0.0001 XLM = 1,000 stroops; 10% of that is exactly 100 stroops.
    const atThreshold = await sendWithFee('0.0001', '100');
    expect(highFeeWarnings(atThreshold)).toHaveLength(0);

    const aboveThreshold = await sendWithFee('0.0001', '101');
    expect(highFeeWarnings(aboveThreshold)).toHaveLength(1);
  });

  it('handles a numeric fee_charged from Horizon the same as a string', async () => {
    const small = await sendWithFee('1', 100);
    expect(highFeeWarnings(small)).toHaveLength(0);

    const large = await sendWithFee('0.0000001', 100);
    expect(highFeeWarnings(large)).toHaveLength(1);
  });
});
