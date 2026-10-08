import { describe, it, expect, vi } from 'vitest';
import { previewPayment, previewPaymentWithReadiness, createWallet, PocketPayError } from '../src';

const { checkTransactionReadiness } = vi.hoisted(() => ({
  checkTransactionReadiness: vi.fn(),
}));

vi.mock('../src/payments/readiness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/payments/readiness')>();
  return { ...actual, checkTransactionReadiness };
});

describe('Payment Preview Helper', () => {
  it('composes the preview with the shared readiness validator', async () => {
    const sender = createWallet();
    const receiver = createWallet();
    const readiness = {
      ready: true,
      blockers: [],
      warnings: [],
      checks: {
        source: 'passed',
        destination: 'passed',
        amount: 'passed',
        asset: 'passed',
        memo: 'passed',
        network: 'passed',
        fee: 'passed',
        balance: 'passed',
      },
      network: 'testnet',
      fee: '100',
      checkedAt: '2026-10-06T00:00:00.000Z',
    };
    checkTransactionReadiness.mockResolvedValueOnce(readiness);

    const result = await previewPaymentWithReadiness({
      sourceAccount: sender.publicKey,
      destination: receiver.publicKey,
      amount: '10.5',
      memo: 'Test preview',
    });

    expect(result.preview).toMatchObject({
      sourceAccount: sender.publicKey,
      destination: receiver.publicKey,
      amount: '10.5',
      estimatedFee: '100',
    });
    expect(result.readiness).toBe(readiness);
    expect(checkTransactionReadiness).toHaveBeenCalledWith(
      {
        sourceAccount: sender.publicKey,
        destination: receiver.publicKey,
        amount: '10.5',
        asset: { code: 'XLM' },
        memo: 'Test preview',
        fee: '100',
      },
      undefined,
    );
  });

  it('should preview a native XLM payment correctly', async () => {
    const sender = createWallet();
    const receiver = createWallet();

    const preview = await previewPayment({
      sourceAccount: sender.publicKey,
      destination: receiver.publicKey,
      amount: '10.5',
      memo: 'Test preview',
    });

    expect(preview.sourceAccount).toBe(sender.publicKey);
    expect(preview.destination).toBe(receiver.publicKey);
    expect(preview.amount).toBe('10.5');
    expect(preview.memo).toBe('Test preview');
    expect(preview.asset.code).toBe('XLM');
    expect(preview.network).toBe('testnet');
    expect(preview.estimatedFee).toBe('100');
  });

  it('should preview an issued asset payment correctly', async () => {
    const sender = createWallet();
    const receiver = createWallet();
    const issuer = createWallet();

    const preview = await previewPayment({
      sourceAccount: sender.publicKey,
      destination: receiver.publicKey,
      amount: '50',
      asset: { code: 'USDC', issuer: issuer.publicKey },
    }, { network: 'mainnet' });

    expect(preview.sourceAccount).toBe(sender.publicKey);
    expect(preview.destination).toBe(receiver.publicKey);
    expect(preview.amount).toBe('50');
    expect(preview.asset.code).toBe('USDC');
    expect(preview.asset.issuer).toBe(issuer.publicKey);
    expect(preview.network).toBe('mainnet');
  });

  it('should reject invalid amount', async () => {
    const sender = createWallet();
    const receiver = createWallet();

    await expect(
      previewPayment({
        sourceAccount: sender.publicKey,
        destination: receiver.publicKey,
        amount: '-5',
      })
    ).rejects.toThrow(PocketPayError);
  });

  it('should reject invalid source account', async () => {
    const receiver = createWallet();

    await expect(
      previewPayment({
        sourceAccount: 'INVALID_PUBLIC_KEY',
        destination: receiver.publicKey,
        amount: '10',
      })
    ).rejects.toThrow(PocketPayError);
  });

  it('should reject invalid memo length', async () => {
    const sender = createWallet();
    const receiver = createWallet();

    await expect(
      previewPayment({
        sourceAccount: sender.publicKey,
        destination: receiver.publicKey,
        amount: '10',
        memo: 'This memo text is way too long to be allowed in Stellar',
      })
    ).rejects.toThrow(PocketPayError);
  });
});
