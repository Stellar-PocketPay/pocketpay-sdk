import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as StellarSDK from '@stellar/stellar-sdk';
import { submitWithGuard } from '../src/transactions/guarded-submit';
import {
  PocketPayError,
  classifySubmitError,
  isRetryableError,
  isUnknownStatusError,
  submitTransactionIdempotently,
  pollTransactionStatus,
} from '../src';

// Helper to build a dummy signed transaction
function buildDummyTransaction(maxTime = 0): StellarSDK.Transaction {
  const kp = StellarSDK.Keypair.random();
  const account = new StellarSDK.Account(kp.publicKey(), '100');
  const builder = new StellarSDK.TransactionBuilder(account, {
    fee: StellarSDK.BASE_FEE,
    networkPassphrase: StellarSDK.Networks.TESTNET,
  });

  builder.addOperation(
    StellarSDK.Operation.payment({
      destination: StellarSDK.Keypair.random().publicKey(),
      asset: StellarSDK.Asset.native(),
      amount: '10.0',
    })
  );

  if (maxTime > 0) {
    builder.setTimebounds(0, maxTime);
  } else {
    builder.setTimeout(30);
  }

  const tx = builder.build();
  tx.sign(kp);
  return tx;
}

describe('Idempotency Strategy - Error Classification', () => {
  it('should pass through PocketPayError directly', () => {
    const original = new PocketPayError('original message', 'SOME_CODE');
    const result = classifySubmitError(original, 'dummy-hash');
    expect(result).toBe(original);
  });

  it('should classify final Stellar transaction results as non-retryable', () => {
    const rawError = {
      response: {
        status: 400,
        data: {
          extras: {
            result_codes: {
              transaction: 'tx_bad_seq',
              operations: [],
            },
          },
        },
      },
    };

    const classified = classifySubmitError(rawError, 'dummy-hash');
    expect(classified.code).toBe('TX_BAD_SEQUENCE');
    expect(classified.statusCode).toBe(400);
    expect(classified.transactionHash).toBe('dummy-hash');
    expect(classified.retryable).toBe(false);
    expect(isRetryableError(classified)).toBe(false);
  });

  it('should classify rate-limiting errors as retryable', () => {
    const rawError = {
      response: {
        status: 429,
      },
      message: 'Rate limit exceeded',
    };

    const classified = classifySubmitError(rawError, 'dummy-hash');
    expect(classified.code).toBe('NET_RATE_LIMITED');
    expect(classified.statusCode).toBe(429);
    expect(classified.retryable).toBe(true);
    expect(isRetryableError(classified)).toBe(true);
  });

  it('should classify gateway timeout (504) as unknown status and non-retryable', () => {
    const rawError = {
      response: {
        status: 504,
      },
      message: 'Gateway Timeout',
    };

    const classified = classifySubmitError(rawError, 'dummy-hash');
    expect(classified.code).toBe('TX_STATUS_UNKNOWN');
    expect(classified.statusCode).toBe(504);
    expect(classified.retryable).toBe(false);
    expect(isUnknownStatusError(classified)).toBe(true);
  });

  it('should classify network socket error (ETIMEDOUT) as unknown status', () => {
    const rawError = {
      code: 'ETIMEDOUT',
      message: 'Connection timed out',
    };

    const classified = classifySubmitError(rawError, 'dummy-hash');
    expect(classified.code).toBe('TX_STATUS_UNKNOWN');
    expect(classified.retryable).toBe(false);
    expect(isUnknownStatusError(classified)).toBe(true);
  });
});

describe('Idempotency Strategy - Status Polling & Submission', () => {
  let submitSpy: any;
  let transactionsSpy: any;
  let mockCall: any;

  beforeEach(() => {
    submitSpy = vi.spyOn(StellarSDK.Horizon.Server.prototype, 'submitTransaction');
    mockCall = vi.fn();
    transactionsSpy = vi.spyOn(StellarSDK.Horizon.Server.prototype, 'transactions').mockReturnValue({
      transaction: vi.fn().mockReturnThis(),
      call: mockCall,
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return result immediately if standard submitTransaction succeeds', async () => {
    const tx = buildDummyTransaction();
    const successResult = { hash: tx.hash().toString('hex'), ledger: 12345 };
    submitSpy.mockResolvedValue(successResult);

    const result = await submitTransactionIdempotently(tx);
    expect(result).toEqual(successResult);
    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(mockCall).not.toHaveBeenCalled();
  });

  it('should poll Horizon and succeed if transaction is found after timeout', async () => {
    const tx = buildDummyTransaction();
    const txHash = tx.hash().toString('hex');

    // Simulate timeout on submission
    const timeoutError = { response: { status: 504 }, message: 'Timeout' };
    submitSpy.mockRejectedValue(timeoutError);

    // First call returns 404 (Not Found), second call returns the transaction record
    const txRecord = { hash: txHash, ledger: 54321, created_at: '2026-07-22T00:00:00Z' };
    mockCall
      .mockRejectedValueOnce({ response: { status: 404 } })
      .mockResolvedValueOnce(txRecord);

    const result = await submitTransactionIdempotently(tx, {
      maxPollAttempts: 3,
      pollIntervalMs: 5,
    });

    expect(result).toEqual(txRecord);
    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(mockCall).toHaveBeenCalledTimes(2);
  });

  it('should throw TX_EXPIRED if maxTime bound is exceeded during polling', async () => {
    // Build a transaction that expired in the past (e.g. maxTime = 1)
    const tx = buildDummyTransaction(1);
    const txHash = tx.hash().toString('hex');

    mockCall.mockRejectedValue({ response: { status: 404 } });

    await expect(
      pollTransactionStatus(tx, { maxPollAttempts: 5, pollIntervalMs: 2 })
    ).rejects.toMatchObject({
      code: 'TX_EXPIRED',
      transactionHash: txHash,
      retryable: false,
    });

    expect(mockCall).not.toHaveBeenCalled(); // Exits immediately due to expiration check
  });

  it('preserves definitive TX_EXPIRED after an ambiguous guarded submission', async () => {
    const tx = buildDummyTransaction(1);
    const txHash = tx.hash().toString('hex');
    submitSpy.mockRejectedValue({ response: { status: 503 }, message: 'Service Unavailable' });

    await expect(
      submitWithGuard(tx, { maxPollAttempts: 1, pollIntervalMs: 0 })
    ).rejects.toMatchObject({
      code: 'TX_EXPIRED',
      transactionHash: txHash,
      retryable: false,
    });

    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(mockCall).not.toHaveBeenCalled();
  });

  it('should throw TX_STATUS_UNKNOWN if polling attempts are exceeded without finding transaction', async () => {
    const tx = buildDummyTransaction();
    const txHash = tx.hash().toString('hex');

    // Always returns 404
    mockCall.mockRejectedValue({ response: { status: 404 } });

    await expect(
      pollTransactionStatus(tx, { maxPollAttempts: 3, pollIntervalMs: 2 })
    ).rejects.toMatchObject({
      code: 'TX_STATUS_UNKNOWN',
      transactionHash: txHash,
      retryable: false,
    });

    expect(mockCall).toHaveBeenCalledTimes(3);
  });
});
