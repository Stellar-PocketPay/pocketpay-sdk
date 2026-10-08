import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as StellarSDK from '@stellar/stellar-sdk';
import {
  PocketPayError,
  classifySubmissionOutcome,
  isSafeToRetry,
  requiresStatusCheck,
  withRetryPolicy,
  type SubmissionOutcome,
  type RetryPolicy,
  type RetryPolicyExhaustedResult,
} from '../src';

// ─── Fixtures ────────────────────────────────────────────────────────────────

/**
 * Builds a minimal signed transaction. `maxTime = 0` → no expiry bound.
 * Pass a small positive value (e.g. `1`) to simulate an already-expired tx.
 */
function buildSignedTx(maxTime = 0): StellarSDK.Transaction {
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
    }),
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

function makePocketPayError(
  code: string,
  message = 'test error',
  retryable?: boolean,
  statusCode?: number,
  txHash?: string,
): PocketPayError {
  return new PocketPayError(
    message,
    code,
    { statusCode, cause: undefined },
    txHash,
    retryable,
  );
}

// ─── classifySubmissionOutcome ───────────────────────────────────────────────

describe('classifySubmissionOutcome', () => {
  it('returns success outcome when no error is provided', () => {
    const outcome = classifySubmissionOutcome(undefined, 'abc123');
    expect(outcome.kind).toBe('success');
    if (outcome.kind === 'success') {
      expect(outcome.transactionHash).toBe('abc123');
    }
  });

  it('throws if no error and no txHash are provided', () => {
    expect(() => classifySubmissionOutcome(undefined)).toThrow(
      /txHash is required when error is undefined/,
    );
  });

  it('classifies TX_STATUS_UNKNOWN as unknown_status', () => {
    const error = makePocketPayError('TX_STATUS_UNKNOWN', 'timeout', false, 504, 'hash-abc');
    const outcome = classifySubmissionOutcome(error);
    expect(outcome.kind).toBe('unknown_status');
    if (outcome.kind === 'unknown_status') {
      expect(outcome.error).toBe(error);
      expect(outcome.transactionHash).toBe('hash-abc');
    }
  });

  it('unknown_status falls back to caller-supplied txHash when error.transactionHash is absent', () => {
    const error = makePocketPayError('TX_STATUS_UNKNOWN', 'timeout', false, 504);
    const outcome = classifySubmissionOutcome(error, 'fallback-hash');
    expect(outcome.kind).toBe('unknown_status');
    if (outcome.kind === 'unknown_status') {
      expect(outcome.transactionHash).toBe('fallback-hash');
    }
  });

  it('classifies TX_EXPIRED as non_retryable_failure', () => {
    const error = makePocketPayError('TX_EXPIRED', 'Transaction expired', false, 400);
    const outcome = classifySubmissionOutcome(error);
    expect(outcome.kind).toBe('non_retryable_failure');
    if (outcome.kind === 'non_retryable_failure') {
      expect(outcome.error).toBe(error);
    }
  });

  it('classifies retryable errors (retryable === true) as retryable_failure', () => {
    const error = makePocketPayError('SEND_ERROR', 'rate limit', true, 429);
    const outcome = classifySubmissionOutcome(error);
    expect(outcome.kind).toBe('retryable_failure');
    if (outcome.kind === 'retryable_failure') {
      expect(outcome.error).toBe(error);
      expect(outcome.suggestedDelayMs).toBe(2_000); // 429 → 2s default
    }
  });

  it('uses 1s suggested delay for non-429 retryable errors', () => {
    const error = makePocketPayError('SEND_ERROR', 'transient', true, 503);
    const outcome = classifySubmissionOutcome(error);
    expect(outcome.kind).toBe('retryable_failure');
    if (outcome.kind === 'retryable_failure') {
      expect(outcome.suggestedDelayMs).toBe(1_000);
    }
  });

  it('classifies PAYMENT_FAILED (non-retryable) as non_retryable_failure', () => {
    const error = makePocketPayError('PAYMENT_FAILED', 'tx_bad_seq', false, 400);
    const outcome = classifySubmissionOutcome(error);
    expect(outcome.kind).toBe('non_retryable_failure');
    if (outcome.kind === 'non_retryable_failure') {
      expect(outcome.error).toBe(error);
    }
  });

  it('classifies unknown code with retryable === false as non_retryable_failure', () => {
    const error = makePocketPayError('UNKNOWN_CODE', 'some error', false);
    const outcome = classifySubmissionOutcome(error);
    expect(outcome.kind).toBe('non_retryable_failure');
  });

  it('classifies unknown code with retryable === undefined as non_retryable_failure', () => {
    const error = makePocketPayError('SOME_CODE', 'some error');
    const outcome = classifySubmissionOutcome(error);
    expect(outcome.kind).toBe('non_retryable_failure');
  });
});

// ─── isSafeToRetry / requiresStatusCheck ────────────────────────────────────

describe('isSafeToRetry', () => {
  it('returns true for retryable_failure outcomes', () => {
    const outcome: SubmissionOutcome = {
      kind: 'retryable_failure',
      error: makePocketPayError('SEND_ERROR', 'rate limit', true, 429),
      suggestedDelayMs: 2_000,
    };
    expect(isSafeToRetry(outcome)).toBe(true);
  });

  it('returns false for success outcomes', () => {
    const outcome: SubmissionOutcome = { kind: 'success', transactionHash: 'abc' };
    expect(isSafeToRetry(outcome)).toBe(false);
  });

  it('returns false for non_retryable_failure outcomes', () => {
    const outcome: SubmissionOutcome = {
      kind: 'non_retryable_failure',
      error: makePocketPayError('PAYMENT_FAILED', 'rejected'),
    };
    expect(isSafeToRetry(outcome)).toBe(false);
  });

  it('returns false for unknown_status outcomes — must poll first', () => {
    const outcome: SubmissionOutcome = {
      kind: 'unknown_status',
      error: makePocketPayError('TX_STATUS_UNKNOWN', 'timeout'),
    };
    expect(isSafeToRetry(outcome)).toBe(false);
  });
});

describe('requiresStatusCheck', () => {
  it('returns true only for unknown_status outcomes', () => {
    const outcome: SubmissionOutcome = {
      kind: 'unknown_status',
      error: makePocketPayError('TX_STATUS_UNKNOWN', 'timeout'),
    };
    expect(requiresStatusCheck(outcome)).toBe(true);
  });

  it('returns false for success', () => {
    expect(requiresStatusCheck({ kind: 'success', transactionHash: 'x' })).toBe(false);
  });

  it('returns false for retryable_failure', () => {
    const outcome: SubmissionOutcome = {
      kind: 'retryable_failure',
      error: makePocketPayError('SEND_ERROR', 'transient', true),
      suggestedDelayMs: 1_000,
    };
    expect(requiresStatusCheck(outcome)).toBe(false);
  });

  it('returns false for non_retryable_failure', () => {
    const outcome: SubmissionOutcome = {
      kind: 'non_retryable_failure',
      error: makePocketPayError('PAYMENT_FAILED', 'rejected'),
    };
    expect(requiresStatusCheck(outcome)).toBe(false);
  });
});

// ─── withRetryPolicy ─────────────────────────────────────────────────────────

describe('withRetryPolicy', () => {
  let submitSpy: ReturnType<typeof vi.spyOn>;
  let transactionsSpy: ReturnType<typeof vi.spyOn>;
  let mockCall: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    submitSpy = vi.spyOn(
      StellarSDK.Horizon.Server.prototype,
      'submitTransaction',
    );
    mockCall = vi.fn();
    transactionsSpy = vi
      .spyOn(StellarSDK.Horizon.Server.prototype, 'transactions')
      .mockReturnValue({
        transaction: vi.fn().mockReturnThis(),
        call: mockCall,
      } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Success path ──────────────────────────────────────────────────────────

  it('returns the Horizon result immediately on first-attempt success', async () => {
    const tx = buildSignedTx();
    const successResult = { hash: tx.hash().toString('hex'), ledger: 100 };
    submitSpy.mockResolvedValue(successResult);

    const result = await withRetryPolicy(tx, { maxAttempts: 3 });
    expect(result).toEqual(successResult);
    expect(submitSpy).toHaveBeenCalledTimes(1);
  });

  // ── Retryable failure → eventual success ─────────────────────────────────

  it('retries on 429 rate-limit and succeeds on a later attempt', async () => {
    const tx = buildSignedTx();
    const successResult = { hash: tx.hash().toString('hex'), ledger: 200 };

    const rateLimit = { response: { status: 429 }, message: 'Rate limited' };
    submitSpy
      .mockRejectedValueOnce(rateLimit)
      .mockRejectedValueOnce(rateLimit)
      .mockResolvedValueOnce(successResult);

    const result = await withRetryPolicy(tx, {
      maxAttempts: 4,
      initialBackoffMs: 1,
      maxBackoffMs: 10,
      jitter: false,
    });

    expect(result).toEqual(successResult);
    expect(submitSpy).toHaveBeenCalledTimes(3);
  });

  // ── Non-retryable failure ─────────────────────────────────────────────────

  it('throws immediately on non-retryable (PAYMENT_FAILED) without further attempts', async () => {
    const tx = buildSignedTx();
    const paymentFailed = {
      response: {
        status: 400,
        data: { extras: { result_codes: { transaction: 'tx_bad_seq' } } },
      },
    };
    submitSpy.mockRejectedValue(paymentFailed);

    await expect(withRetryPolicy(tx, { maxAttempts: 4 })).rejects.toMatchObject({
      code: 'TX_BAD_SEQUENCE',
    });
    // Must not retry — only one attempt
    expect(submitSpy).toHaveBeenCalledTimes(1);
  });

  it('exhausted result contains finalOutcome === non_retryable_failure', async () => {
    const tx = buildSignedTx();
    const paymentFailed = {
      response: {
        status: 400,
        data: { extras: { result_codes: { transaction: 'tx_insufficient_balance' } } },
      },
    };
    submitSpy.mockRejectedValue(paymentFailed);

    let caught: any;
    try {
      await withRetryPolicy(tx, { maxAttempts: 3 });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeDefined();
    const exhausted: RetryPolicyExhaustedResult = caught.exhaustedResult;
    expect(exhausted.success).toBe(false);
    expect(exhausted.finalOutcome).toBe('non_retryable_failure');
    expect(exhausted.attempts).toBe(1);
  });

  // ── Unknown status (timeout / 504) ───────────────────────────────────────

  it('does not blindly resubmit after a timeout — throws with unknown_status after polling fails', async () => {
    const tx = buildSignedTx();

    // Submission times out
    submitSpy.mockRejectedValue({ response: { status: 504 }, message: 'Timeout' });
    // Polling also comes up empty
    mockCall.mockRejectedValue({ response: { status: 404 } });

    await expect(
      withRetryPolicy(tx, {
        maxAttempts: 3,
        initialBackoffMs: 1,
        jitter: false,
      }),
    ).rejects.toMatchObject({ code: 'TX_STATUS_UNKNOWN' });

    // submitTransaction called only once — no blind resubmission
    expect(submitSpy).toHaveBeenCalledTimes(1);
  });

  it('unknown_status exhausted result has finalOutcome === unknown_status', async () => {
    const tx = buildSignedTx();

    submitSpy.mockRejectedValue({ response: { status: 504 }, message: 'Timeout' });
    mockCall.mockRejectedValue({ response: { status: 404 } });

    let caught: any;
    try {
      await withRetryPolicy(tx, { maxAttempts: 2, initialBackoffMs: 1, jitter: false });
    } catch (e) {
      caught = e;
    }

    expect(caught.exhaustedResult).toBeDefined();
    expect((caught.exhaustedResult as RetryPolicyExhaustedResult).finalOutcome).toBe(
      'unknown_status',
    );
    expect((caught.exhaustedResult as RetryPolicyExhaustedResult).success).toBe(false);
  });

  it('resolves successfully when polling finds the transaction after a timeout', async () => {
    const tx = buildSignedTx();
    const txRecord = { hash: tx.hash().toString('hex'), ledger: 300 };

    submitSpy.mockRejectedValueOnce({ response: { status: 504 }, message: 'Timeout' });
    // Polling finds it on first poll attempt
    mockCall.mockResolvedValue(txRecord);

    const result = await withRetryPolicy(tx, { maxAttempts: 3, initialBackoffMs: 1 });
    expect(result).toEqual(txRecord);
    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(mockCall).toHaveBeenCalledTimes(1);
  });

  it('polls a wrapped connection failure rather than re-submitting a payment', async () => {
    const tx = buildSignedTx();
    const txHash = tx.hash().toString('hex');
    const ledgerRecord = { hash: txHash, ledger: 4321 };
    submitSpy.mockRejectedValue(
      makePocketPayError('NET_UNREACHABLE', 'Connection dropped', true, undefined, txHash),
    );
    mockCall.mockResolvedValue(ledgerRecord);

    const result = await withRetryPolicy(tx, {
      maxAttempts: 3, initialBackoffMs: 1, jitter: false,
    });
    expect(result).toEqual(ledgerRecord);
    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(mockCall).toHaveBeenCalledTimes(1);
  });

  // ── Retries exhausted ─────────────────────────────────────────────────────

  it('exhausts retries and reports retryable_failure when transient error persists', async () => {
    const tx = buildSignedTx();
    const rateLimit = { response: { status: 429 }, message: 'Rate limited' };
    submitSpy.mockRejectedValue(rateLimit);

    let caught: any;
    try {
      await withRetryPolicy(tx, {
        maxAttempts: 3,
        initialBackoffMs: 1,
        maxBackoffMs: 5,
        jitter: false,
      });
    } catch (e) {
      caught = e;
    }

    const exhausted: RetryPolicyExhaustedResult = caught.exhaustedResult;
    expect(exhausted.success).toBe(false);
    expect(exhausted.finalOutcome).toBe('retryable_failure');
    expect(exhausted.attempts).toBe(3);
    expect(submitSpy).toHaveBeenCalledTimes(3);
  });

  // ── onAttempt callback ────────────────────────────────────────────────────

  it('calls onAttempt for every failed attempt', async () => {
    const tx = buildSignedTx();
    const rateLimit = { response: { status: 429 }, message: 'Rate limited' };
    submitSpy.mockRejectedValue(rateLimit);

    const onAttempt = vi.fn();

    try {
      await withRetryPolicy(tx, {
        maxAttempts: 3,
        initialBackoffMs: 1,
        maxBackoffMs: 5,
        jitter: false,
        onAttempt,
      });
    } catch {
      // expected
    }

    expect(onAttempt).toHaveBeenCalledTimes(3);
    // First two calls should have a non-zero delayMs (next retry will wait)
    const [, attempt1Outcome] = onAttempt.mock.calls[0];
    expect(attempt1Outcome.kind).toBe('retryable_failure');
    // Last call has delayMs = 0 (no more retries)
    const lastCallDelay = onAttempt.mock.calls[2][2];
    expect(lastCallDelay).toBe(0);
  });

  it('invokes onAttempt once with delayMs 0 for non_retryable_failure', async () => {
    const tx = buildSignedTx();
    const rejected = {
      response: {
        status: 400,
        data: { extras: { result_codes: { transaction: 'tx_bad_auth' } } },
      },
    };
    submitSpy.mockRejectedValue(rejected);

    const onAttempt = vi.fn();
    try {
      await withRetryPolicy(tx, { maxAttempts: 5, onAttempt });
    } catch {
      // expected
    }

    expect(onAttempt).toHaveBeenCalledTimes(1);
    expect(onAttempt.mock.calls[0][2]).toBe(0); // delayMs
  });

  // ── maxAttempts = 1 (no retries) ──────────────────────────────────────────

  it('does not retry when maxAttempts is 1', async () => {
    const tx = buildSignedTx();
    const rateLimit = { response: { status: 429 }, message: 'Rate limited' };
    submitSpy.mockRejectedValue(rateLimit);

    await expect(
      withRetryPolicy(tx, { maxAttempts: 1 }),
    ).rejects.toMatchObject({ code: 'NET_RATE_LIMITED' });
    expect(submitSpy).toHaveBeenCalledTimes(1);
  });

  // ── Default policy (no explicit config) ──────────────────────────────────

  it('succeeds on first attempt using default policy', async () => {
    const tx = buildSignedTx();
    const successResult = { hash: tx.hash().toString('hex'), ledger: 50 };
    submitSpy.mockResolvedValue(successResult);

    const result = await withRetryPolicy(tx); // no policy arg
    expect(result).toEqual(successResult);
    expect(submitSpy).toHaveBeenCalledTimes(1);
  });

  // ── Duplicate-risk guard: unknown_status never retried ────────────────────

  it('never resubmits to Horizon after an unknown_status — no duplicate risk', async () => {
    const tx = buildSignedTx();

    submitSpy.mockRejectedValue({ response: { status: 504 }, message: 'Timeout' });
    mockCall.mockRejectedValue({ response: { status: 404 } }); // polling yields nothing

    try {
      await withRetryPolicy(tx, {
        maxAttempts: 5, // even with many allowed attempts
        initialBackoffMs: 1,
        jitter: false,
      });
    } catch {
      // expected
    }

    // Horizon's submit endpoint must only have been called once
    expect(submitSpy).toHaveBeenCalledTimes(1);
  });
});

// ─── Type-narrowing integration ──────────────────────────────────────────────

describe('SubmissionOutcome type narrowing', () => {
  it('success variant provides transactionHash', () => {
    const outcome: SubmissionOutcome = classifySubmissionOutcome(undefined, 'myHash');
    if (outcome.kind === 'success') {
      // TypeScript narrows correctly: transactionHash is a string
      const hash: string = outcome.transactionHash;
      expect(hash).toBe('myHash');
    } else {
      throw new Error('Expected success outcome');
    }
  });

  it('retryable_failure variant provides suggestedDelayMs', () => {
    const err = makePocketPayError('SEND_ERROR', 'throttled', true, 429);
    const outcome: SubmissionOutcome = classifySubmissionOutcome(err);
    if (outcome.kind === 'retryable_failure') {
      const delay: number = outcome.suggestedDelayMs;
      expect(delay).toBeGreaterThan(0);
    } else {
      throw new Error('Expected retryable_failure outcome');
    }
  });

  it('unknown_status variant exposes error with TX_STATUS_UNKNOWN code', () => {
    const err = makePocketPayError('TX_STATUS_UNKNOWN', 'timed out', false, 504);
    const outcome: SubmissionOutcome = classifySubmissionOutcome(err);
    if (outcome.kind === 'unknown_status') {
      expect(outcome.error.code).toBe('TX_STATUS_UNKNOWN');
    } else {
      throw new Error('Expected unknown_status outcome');
    }
  });
});
