/**
 * Tests for sendXLM preflight validation and network error mapping.
 *
 * Validation tests need no network mock — sendXLM throws before any Horizon
 * call. The account-not-found test stubs loadAccount to reject with a 404 so
 * the ACCOUNT_NOT_FOUND mapping can be exercised offline.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendXLM, enhancedSendXLM, sendAsset, safeSendAsset, createWallet, PocketPayError } from '../src';
import type { SendAssetParams } from '../src';
import { fundedAccount, paymentList } from './fixtures';
// ─── Mock @stellar/stellar-sdk ───────────────────────────────────────────────
// Stub Horizon.Server.loadAccount while keeping the real Keypair, Networks,
// etc. via importActual, so createWallet() and Keypair.fromSecret() still work.
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
/** Builds an HTTP-style error that Horizon SDK throws for 404 responses. */
function makeHorizon404Error(publicKey: string) {
  const err = new Error(`Account not found: ${publicKey}`) as any;
  err.response = { status: 404 };
  return err;
}
describe('Payments Module - Validation', () => {
  beforeEach(() => {
    mockLoadAccount.mockReset();
  });

  it('should reject invalid source secret', async () => {
    await expect(
      sendXLM({ sourceSecret: 'INVALID', destination: createWallet().publicKey, amount: '10' })
    ).rejects.toThrow(PocketPayError);
  });

  it('should reject invalid destination', async () => {
    const wallet = createWallet();
    await expect(
      sendXLM({ sourceSecret: wallet.secretKey, destination: 'GINVALID', amount: '10' })
    ).rejects.toThrow(PocketPayError);
  });

  it('should reject invalid amount', async () => {
    const sender = createWallet();
    const receiver = createWallet();
    await expect(
      sendXLM({ sourceSecret: sender.secretKey, destination: receiver.publicKey, amount: '-5' })
    ).rejects.toThrow(PocketPayError);
  });

  it('should reject self-payment', async () => {
    const wallet = createWallet();
    await expect(
      sendXLM({ sourceSecret: wallet.secretKey, destination: wallet.publicKey, amount: '10' })
    ).rejects.toThrow('Cannot send XLM to yourself');
  });

  it('should reject memo exceeding 28 bytes', async () => {
    const sender = createWallet();
    const receiver = createWallet();
    await expect(
      sendXLM({ sourceSecret: sender.secretKey, destination: receiver.publicKey, amount: '10', memo: 'This memo is way too long and exceeds the twenty eight byte limit!' })
    ).rejects.toThrow('Memo text exceeds 28-byte limit');
  });

  it('should not touch the network when validation fails', async () => {
    await expect(
      sendXLM({ sourceSecret: 'INVALID', destination: createWallet().publicKey, amount: '10' })
    ).rejects.toThrow(PocketPayError);
    expect(mockLoadAccount).not.toHaveBeenCalled();
  });

  it('should map an unfunded source account to ACCOUNT_NOT_FOUND', async () => {
    const sender = createWallet();
    const receiver = createWallet();
    mockLoadAccount.mockRejectedValue(makeHorizon404Error(sender.publicKey));
    await expect(
      sendXLM({ sourceSecret: sender.secretKey, destination: receiver.publicKey, amount: '10' })
    ).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
  });

  it('compares enhanced fee ratio in stroops instead of mixing stroops and XLM (#307)', async () => {
    const sender = createWallet();
    const receiver = createWallet();
    const { Account } = await import('@stellar/stellar-sdk');

    mockSubmitTransaction.mockReset();
    mockLoadAccount
      .mockResolvedValueOnce(new Account(sender.publicKey, '100'))
      .mockResolvedValueOnce(new Account(sender.publicKey, '101'));
    mockSubmitTransaction
      .mockResolvedValueOnce({ hash: 'normal-fee', ledger: 1, fee_charged: '100' })
      .mockResolvedValueOnce({ hash: 'high-fee', ledger: 2, fee_charged: '100' });

    const normal = await enhancedSendXLM({
      sourceSecret: sender.secretKey,
      destination: receiver.publicKey,
      amount: '1',
    });
    expect(normal.ok).toBe(true);
    expect(normal.warnings).toBeUndefined();

    const tiny = await enhancedSendXLM({
      sourceSecret: sender.secretKey,
      destination: receiver.publicKey,
      amount: '0.0000010',
    });
    expect(tiny.ok).toBe(true);
    expect(tiny.warnings).toEqual([
      expect.objectContaining({ code: 'HIGH_FEE_RATIO' }),
    ]);
  });

  it('should not expose sensitive operation data in payment failure errors', async () => {
    const sender = createWallet();
    const receiver = createWallet();
    
    // Simulate a Horizon error with result codes that might contain sensitive data
    const horizonError = new Error('Transaction failed') as any;
    horizonError.response = {
      status: 400,
      data: {
        extras: {
          result_codes: {
            transaction: 'tx_bad_seq',
            operations: ['op_bad_auth', 'op_no_source'] // This could contain sensitive details
          }
        }
      }
    };
    
    mockLoadAccount.mockRejectedValue(horizonError);
    
    await expect(
      sendXLM({ sourceSecret: sender.secretKey, destination: receiver.publicKey, amount: '10' })
    ).rejects.toThrow(PocketPayError);
    
    try {
      await sendXLM({ sourceSecret: sender.secretKey, destination: receiver.publicKey, amount: '10' });
    } catch (error) {
      expect(error).toBeInstanceOf(PocketPayError);
      const err = error as PocketPayError;
      // Error should only contain transaction code, not full operation details
      expect(err.message).toContain('tx_bad_seq');
      expect(err.message).not.toContain('op_bad_auth');
      expect(err.message).not.toContain('op_no_source');
      expect(err.message).not.toContain('JSON.stringify');
    }
  });

  describe('fixture validation', () => {
    it('fundedAccount fixture should have XLM balance', () => {
      const xlmBalance = fundedAccount.balances.find(b => b.asset_type === 'native');
      expect(xlmBalance).toBeDefined();
    });
    it('paymentList fixture should have records', () => {
      expect(paymentList._embedded.records.length).toBe(2);
    });
  });
});

// ─── sendAsset Tests ──────────────────────────────────────────────────────────

describe('sendAsset - Preflight Validation', () => {
  let sender: ReturnType<typeof createWallet>;
  let receiver: ReturnType<typeof createWallet>;
  let issuer: ReturnType<typeof createWallet>;

  beforeEach(() => {
    mockLoadAccount.mockReset();
    mockSubmitTransaction.mockReset();
    sender = createWallet();
    receiver = createWallet();
    issuer = createWallet();
  });

  // ─── input validation ───────────────────────────────────────────────────────

  it('rejects invalid source secret', async () => {
    await expect(
      sendAsset({
        sourceSecret: 'BADSECRET',
        destination: receiver.publicKey,
        amount: '10',
        asset: { code: 'USDC', issuer: issuer.publicKey },
      }),
    ).rejects.toThrow(PocketPayError);
    expect(mockLoadAccount).not.toHaveBeenCalled();
  });

  it('rejects invalid destination public key', async () => {
    await expect(
      sendAsset({
        sourceSecret: sender.secretKey,
        destination: 'GBADKEY',
        amount: '10',
        asset: { code: 'USDC', issuer: issuer.publicKey },
      }),
    ).rejects.toThrow(PocketPayError);
    expect(mockLoadAccount).not.toHaveBeenCalled();
  });

  it('rejects negative amount', async () => {
    await expect(
      sendAsset({
        sourceSecret: sender.secretKey,
        destination: receiver.publicKey,
        amount: '-5',
        asset: { code: 'USDC', issuer: issuer.publicKey },
      }),
    ).rejects.toThrow(PocketPayError);
    expect(mockLoadAccount).not.toHaveBeenCalled();
  });

  it('rejects zero amount', async () => {
    await expect(
      sendAsset({
        sourceSecret: sender.secretKey,
        destination: receiver.publicKey,
        amount: '0',
        asset: { code: 'USDC', issuer: issuer.publicKey },
      }),
    ).rejects.toThrow(PocketPayError);
  });

  it('rejects memo exceeding 28 bytes', async () => {
    await expect(
      sendAsset({
        sourceSecret: sender.secretKey,
        destination: receiver.publicKey,
        amount: '10',
        asset: { code: 'USDC', issuer: issuer.publicKey },
        memo: 'This memo is way too long and blows the 28-byte limit!',
      }),
    ).rejects.toThrow('Memo text exceeds 28-byte limit');
  });

  it('rejects issued asset with empty code', async () => {
    await expect(
      sendAsset({
        sourceSecret: sender.secretKey,
        destination: receiver.publicKey,
        amount: '10',
        asset: { code: '' } as any,
      }),
    ).rejects.toThrow(PocketPayError);
  });

  it('rejects issued asset with missing issuer', async () => {
    await expect(
      sendAsset({
        sourceSecret: sender.secretKey,
        destination: receiver.publicKey,
        amount: '10',
        asset: { code: 'USDC' }, // no issuer
      }),
    ).rejects.toThrow(PocketPayError);
    expect(mockLoadAccount).not.toHaveBeenCalled();
  });

  it('rejects issued asset with invalid issuer key format', async () => {
    await expect(
      sendAsset({
        sourceSecret: sender.secretKey,
        destination: receiver.publicKey,
        amount: '10',
        asset: { code: 'USDC', issuer: 'NOTAVALIDKEY' },
      }),
    ).rejects.toThrow(PocketPayError);
    expect(mockLoadAccount).not.toHaveBeenCalled();
  });

  it('rejects self-payment for issued assets', async () => {
    await expect(
      sendAsset({
        sourceSecret: sender.secretKey,
        destination: sender.publicKey, // same as source
        amount: '10',
        asset: { code: 'USDC', issuer: issuer.publicKey },
      }),
    ).rejects.toMatchObject({ code: 'SELF_PAYMENT' });
  });

  it('does not call the network when any preflight validation fails', async () => {
    try {
      await sendAsset({
        sourceSecret: 'BADSECRET',
        destination: receiver.publicKey,
        amount: '10',
        asset: { code: 'USDC', issuer: issuer.publicKey },
      });
    } catch {
      // expected
    }
    expect(mockLoadAccount).not.toHaveBeenCalled();
  });

  // ─── native XLM via sendAsset ───────────────────────────────────────────────

  it('accepts native XLM asset spec — no trustline check, maps ACCOUNT_NOT_FOUND', async () => {
    // Native XLM: trustline check is skipped; only account lookup matters
    mockLoadAccount.mockRejectedValue(makeHorizon404Error(sender.publicKey));

    await expect(
      sendAsset({
        sourceSecret: sender.secretKey,
        destination: receiver.publicKey,
        amount: '10',
        asset: { code: 'XLM' },
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });

    // loadAccount was called exactly once (for the source account), not twice
    expect(mockLoadAccount).toHaveBeenCalledTimes(1);
  });

  it('accepts "native" as the asset code for XLM', async () => {
    mockLoadAccount.mockRejectedValue(makeHorizon404Error(sender.publicKey));

    await expect(
      sendAsset({
        sourceSecret: sender.secretKey,
        destination: receiver.publicKey,
        amount: '1',
        asset: { code: 'native' },
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
  });

  // ─── trustline preflight for issued assets ──────────────────────────────────

  it('runs trustline preflight for issued assets and throws when trustline is missing', async () => {
    // The trustline check loads the destination account
    mockLoadAccount.mockResolvedValue({
      balances: [{ asset_type: 'native', balance: '100.0' }],
    });

    await expect(
      sendAsset({
        sourceSecret: sender.secretKey,
        destination: receiver.publicKey,
        amount: '10',
        asset: { code: 'USDC', issuer: issuer.publicKey },
      }),
    ).rejects.toThrow(PocketPayError);
  });

  it('skips trustline preflight when skipTrustlineCheck is true', async () => {
    // With skipTrustlineCheck the only loadAccount call is the source account lookup
    mockLoadAccount.mockRejectedValue(makeHorizon404Error(sender.publicKey));

    await expect(
      sendAsset({
        sourceSecret: sender.secretKey,
        destination: receiver.publicKey,
        amount: '10',
        asset: { code: 'USDC', issuer: issuer.publicKey },
        skipTrustlineCheck: true,
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });

    // Only one loadAccount call (source), not two (destination trustline check)
    expect(mockLoadAccount).toHaveBeenCalledTimes(1);
  });

  it('throws ACCOUNT_NOT_FOUND when source account does not exist (issued asset)', async () => {
    // First call: destination trustline check passes
    // Second call: source account lookup returns 404
    mockLoadAccount
      .mockResolvedValueOnce({
        balances: [
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USDC',
            asset_issuer: issuer.publicKey,
            balance: '0.0000000',
            limit: '1000.0000000',
            is_authorized: true,
          },
        ],
      })
      .mockRejectedValueOnce(makeHorizon404Error(sender.publicKey));

    await expect(
      sendAsset({
        sourceSecret: sender.secretKey,
        destination: receiver.publicKey,
        amount: '10',
        asset: { code: 'USDC', issuer: issuer.publicKey },
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
  });

  // ─── successful submission shape ────────────────────────────────────────────

  it('returns a PaymentResult with asset field populated on success', async () => {
    mockSubmitTransaction.mockResolvedValueOnce({
      hash: 'TESTHASH123',
      ledger: 42,
      fee_charged: '100',
      created_at: '2026-07-22T12:00:00Z',
    });

    // Build a real Account object so TransactionBuilder.build() can call sequenceNumber()
    const { Account } = await import('@stellar/stellar-sdk');
    const sourceAccount = new Account(sender.publicKey, '100');

    mockLoadAccount
      .mockResolvedValueOnce({
        // destination — trustline check
        balances: [
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USDC',
            asset_issuer: issuer.publicKey,
            balance: '0.0000000',
            limit: '1000.0000000',
            is_authorized: true,
          },
        ],
      })
      .mockResolvedValueOnce(sourceAccount); // source account for tx builder

    const result = await sendAsset({
      sourceSecret: sender.secretKey,
      destination: receiver.publicKey,
      amount: '50',
      asset: { code: 'USDC', issuer: issuer.publicKey },
    });

    expect(result.success).toBe(true);
    expect(result.hash).toBe('TESTHASH123');
    expect(result.asset).toEqual({ code: 'USDC', issuer: issuer.publicKey });
    expect(result.amount).toBe('50');
    expect(result.sourceAccount).toBe(sender.publicKey);
    expect(result.destinationAccount).toBe(receiver.publicKey);
  });

  it('returns a PaymentResult with asset: { code: "XLM" } for native XLM via sendAsset', async () => {
    mockSubmitTransaction.mockResolvedValueOnce({
      hash: 'XLMHASH456',
      ledger: 99,
      fee_charged: '100',
      created_at: '2026-07-22T12:00:00Z',
    });

    const { Account } = await import('@stellar/stellar-sdk');
    const sourceAccount = new Account(sender.publicKey, '200');
    mockLoadAccount.mockResolvedValueOnce(sourceAccount);

    const result = await sendAsset({
      sourceSecret: sender.secretKey,
      destination: receiver.publicKey,
      amount: '5',
      asset: { code: 'XLM' },
    });

    expect(result.success).toBe(true);
    expect(result.asset).toEqual({ code: 'XLM' });
  });

  // ─── safeSendAsset ───────────────────────────────────────────────────────────

  it('safeSendAsset returns ok:false with a PocketPayError on validation failure', async () => {
    const result = await safeSendAsset({
      sourceSecret: 'BADSECRET',
      destination: receiver.publicKey,
      amount: '10',
      asset: { code: 'USDC', issuer: issuer.publicKey },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(PocketPayError);
    }
  });

  it('safeSendAsset never throws even when the network errors', async () => {
    mockLoadAccount.mockRejectedValue(new Error('Network failure'));

    const result = await safeSendAsset({
      sourceSecret: sender.secretKey,
      destination: receiver.publicKey,
      amount: '10',
      asset: { code: 'USDC', issuer: issuer.publicKey },
      skipTrustlineCheck: true,
    });

    expect(result.ok).toBe(false);
  });

  // ─── SendAssetParams type coverage ──────────────────────────────────────────

  it('SendAssetParams type is correctly shaped for native XLM', () => {
    const params: SendAssetParams = {
      sourceSecret: sender.secretKey,
      destination: receiver.publicKey,
      amount: '10',
      asset: { code: 'XLM' },
      memo: 'test',
    };
    expect(params.asset.code).toBe('XLM');
    expect(params.asset.issuer).toBeUndefined();
  });

  it('SendAssetParams type is correctly shaped for issued asset', () => {
    const params: SendAssetParams = {
      sourceSecret: sender.secretKey,
      destination: receiver.publicKey,
      amount: '100',
      asset: { code: 'USDC', issuer: issuer.publicKey },
    };
    expect(params.asset.issuer).toBe(issuer.publicKey);
    expect(params.skipTrustlineCheck).toBeUndefined();
  });
});
