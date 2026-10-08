/**
 * Error-path tests for SDK payment helpers (issue #373).
 *
 * Exercises invalid destination, amount, asset, memo, and network/submission
 * failure modes for sendXLM and sendAsset with typed PocketPayError assertions.
 * All tests run offline — Horizon is mocked and no live network is used.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  sendXLM,
  sendAsset,
  safeSendAsset,
  createWallet,
  PocketPayError,
  PaymentError,
  PaymentFailureCategory,
  classifyPaymentError,
} from '../src';
import {
  makeHorizon404Error,
  makeHorizonResultCodeError,
  neverSettlingPromise,
} from './fixtures';

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

async function expectPocketPayError(
  promise: Promise<unknown>,
  expected: { code: string; validation?: Record<string, unknown>; timeout?: { stage: string } },
): Promise<PocketPayError> {
  try {
    await promise;
    throw new Error('expected promise to reject');
  } catch (error) {
    expect(error).toBeInstanceOf(PocketPayError);
    expect(error).toMatchObject(expected);
    return error as PocketPayError;
  }
}

describe('payment error classification', () => {
  it.each([
    {
      name: 'validation',
      error: () =>
        new PocketPayError('Invalid amount', 'INVALID_AMOUNT', {
          validation: { field: 'amount', reason: 'invalid_format' },
        }),
      category: PaymentFailureCategory.Validation,
    },
    {
      name: 'network',
      error: () => Object.assign(new Error('Connection reset'), { code: 'ECONNRESET' }),
      category: PaymentFailureCategory.Network,
    },
    {
      name: 'explicit network code with HTTP 404',
      error: () =>
        new PocketPayError('Horizon request failed', 'NET_HTTP', {
          statusCode: 404,
        }),
      category: PaymentFailureCategory.Network,
    },
    {
      name: 'account',
      error: () => ({ response: { status: 404 } }),
      category: PaymentFailureCategory.Account,
    },
    {
      name: 'account operation result',
      error: () => ({
        response: {
          status: 400,
          data: {
            extras: {
              result_codes: {
                transaction: 'tx_failed',
                operations: ['op_underfunded'],
              },
            },
          },
        },
      }),
      category: PaymentFailureCategory.Account,
    },
    {
      name: 'account transaction result',
      error: () => ({
        response: {
          status: 400,
          data: {
            extras: {
              result_codes: {
                transaction: 'tx_no_source_account',
                operations: [],
              },
            },
          },
        },
      }),
      category: PaymentFailureCategory.Account,
    },
    {
      name: 'asset',
      error: () => ({
        response: {
          status: 400,
          data: {
            extras: {
              result_codes: {
                transaction: 'tx_failed',
                operations: ['op_no_trust'],
              },
            },
          },
        },
      }),
      category: PaymentFailureCategory.Asset,
    },
    {
      name: 'fee',
      error: () => ({
        response: {
          status: 400,
          data: {
            extras: {
              result_codes: {
                transaction: 'tx_insufficient_fee',
                operations: [],
              },
            },
          },
        },
      }),
      category: PaymentFailureCategory.Fee,
    },
    {
      name: 'submission',
      error: () => ({
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
      }),
      category: PaymentFailureCategory.Submission,
    },
  ])('classifies $name failures without message parsing by callers', ({ error, category }) => {
    const classified = classifyPaymentError(error(), 'Failed to send payment');

    expect(classified).toBeInstanceOf(PaymentError);
    expect(classified.paymentCategory).toBe(category);
    expect(classified.safeMessage).toBeTruthy();
  });

  it('preserves published retryability for known network codes', () => {
    const classified = classifyPaymentError(
      new PocketPayError('Horizon request failed', 'NET_HTTP', {
        statusCode: 404,
      }),
    );

    expect(classified.paymentCategory).toBe(PaymentFailureCategory.Network);
    expect(classified.retryable).toBe(false);
  });

  it('redacts secret-shaped material from payment error messages and causes', () => {
    const secret = `S${'A'.repeat(55)}`;
    const raw = Object.assign(new Error(`Connection reset for ${secret}`), {
      code: 'ECONNRESET',
    });

    const classified = classifyPaymentError(raw);

    expect(classified.paymentCategory).toBe(PaymentFailureCategory.Network);
    expect(classified.message).not.toContain(secret);
    expect(classified.cause?.message).not.toContain(secret);
  });

  it('redacts diagnostics from directly constructed PaymentError instances', () => {
    const secret = `S${'B'.repeat(55)}`;
    const originalCause = new Error(`provider response contains ${secret}`);
    originalCause.name = `Provider ${secret}`;

    const direct = new PaymentError(
      `Payment failed for ${secret}`,
      'SEND_ERROR',
      PaymentFailureCategory.Submission,
      {
        cause: originalCause,
        safeMessage: `Payment unavailable ${secret}`,
        validation: {
          field: `memo ${secret}`,
          reason: `invalid ${secret}`,
          value: secret,
        },
      },
    );

    expect(classifyPaymentError(direct)).toBe(direct);
    expect(direct.message).not.toContain(secret);
    expect(direct.safeMessage).not.toContain(secret);
    expect(direct.cause?.message).not.toContain(secret);
    expect(direct.cause?.name).not.toContain(secret);
    expect(direct.validation?.field).not.toContain(secret);
    expect(direct.validation?.reason).not.toContain(secret);
    expect(direct.validation?.value).not.toContain(secret);
    expect(originalCause.message).toContain(secret);
  });

  it('allowlists validation diagnostics and contains hostile metadata traps', () => {
    const secret = `S${'C'.repeat(55)}`;
    const validation = new Proxy(
      {
        field: `amount ${secret}`,
        reason: `invalid ${secret}`,
        value: secret,
        extra: secret,
      } as any,
      {
        get(target, property, receiver) {
          if (property === 'value') throw new Error(`private validation ${secret}`);
          return Reflect.get(target, property, receiver);
        },
        ownKeys() {
          throw new Error(`validation enumeration ${secret}`);
        },
      },
    );

    const direct = new PaymentError(
      'Payment validation failed',
      'INVALID_AMOUNT',
      PaymentFailureCategory.Validation,
      { validation },
    );

    expect(direct.validation?.field).not.toContain(secret);
    expect(direct.validation?.reason).not.toContain(secret);
    expect(direct.validation?.value).toBeUndefined();
    expect((direct.validation as Record<string, unknown> | undefined)?.extra).toBeUndefined();
  });

  it('contains throwing provider response getters and still classifies the HTTP/network failure', () => {
    const provider = {
      get response(): never { throw new Error('provider-private-response'); },
      statusCode: 503,
      code: 'ECONNRESET',
    };
    const classified = classifyPaymentError(provider);
    expect(classified).toBeInstanceOf(PaymentError);
    expect(classified.paymentCategory).toBe(PaymentFailureCategory.Network);
    expect(classified.statusCode).toBe(503);
    expect(JSON.stringify(classified)).not.toContain('provider-private-response');
  });

  it('does not escape error normalization for a throwing Error.message getter', () => {
    const provider = new Error('provider details');
    Object.defineProperty(provider, 'message', {
      get() { throw new Error('private-provider-key'); },
    });
    const classified = classifyPaymentError(provider);
    expect(classified).toBeInstanceOf(PaymentError);
    expect(classified.code).toBe('SEND_ERROR');
    expect(classified.message).toContain('Unexpected payment failure');
    expect(classified.cause?.message).not.toContain('private-provider-key');
  });

  it('ignores throwing nested Horizon result-code getters while retaining the HTTP status', () => {
    const provider = {
      response: {
        status: 400,
        data: { extras: {
          get result_codes(): never { throw new Error('private-provider-field'); },
        } },
      },
    };
    const classified = classifyPaymentError(provider);
    expect(classified.paymentCategory).toBe(PaymentFailureCategory.Submission);
    expect(classified.statusCode).toBe(400);
    expect(classified.message).not.toContain('private-provider-field');
  });
});

async function sourceAccountFor(publicKey: string, sequence = '100') {
  const { Account } = await import('@stellar/stellar-sdk');
  return new Account(publicKey, sequence);
}

function validUsdcTrustline(issuer: string) {
  return {
    balances: [
      {
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        asset_issuer: issuer,
        balance: '100.0000000',
        limit: '1000.0000000',
        is_authorized: true,
      },
    ],
  };
}

describe('sendXLM — typed validation errors', () => {
  beforeEach(() => {
    mockLoadAccount.mockReset();
    mockSubmitTransaction.mockReset();
  });

  it.each([
    {
      name: 'invalid source secret',
      params: () => ({
        sourceSecret: 'NOT_A_SECRET',
        destination: createWallet().publicKey,
        amount: '10',
      }),
      code: 'INVALID_SECRET_KEY',
      validation: { field: 'secretKey', reason: 'invalid_prefix' },
    },
    {
      name: 'invalid destination public key',
      params: () => {
        const sender = createWallet();
        return {
          sourceSecret: sender.secretKey,
          destination: 'GINVALID',
          amount: '10',
        };
      },
      code: 'INVALID_PUBLIC_KEY',
      validation: { field: 'publicKey', reason: 'invalid_format' },
    },
    {
      name: 'negative amount',
      params: () => {
        const sender = createWallet();
        const receiver = createWallet();
        return {
          sourceSecret: sender.secretKey,
          destination: receiver.publicKey,
          amount: '-5',
        };
      },
      code: 'INVALID_AMOUNT',
      validation: { field: 'amount', reason: 'invalid_format' },
    },
    {
      name: 'zero amount',
      params: () => {
        const sender = createWallet();
        const receiver = createWallet();
        return {
          sourceSecret: sender.secretKey,
          destination: receiver.publicKey,
          amount: '0',
        };
      },
      code: 'INVALID_AMOUNT',
      validation: { field: 'amount', reason: 'not_positive' },
    },
    {
      name: 'non-numeric amount',
      params: () => {
        const sender = createWallet();
        const receiver = createWallet();
        return {
          sourceSecret: sender.secretKey,
          destination: receiver.publicKey,
          amount: '10abc',
        };
      },
      code: 'INVALID_AMOUNT',
      validation: { field: 'amount', reason: 'invalid_format' },
    },
    {
      name: 'amount with too many decimal places',
      params: () => {
        const sender = createWallet();
        const receiver = createWallet();
        return {
          sourceSecret: sender.secretKey,
          destination: receiver.publicKey,
          amount: '1.12345678',
        };
      },
      code: 'INVALID_AMOUNT_PRECISION',
      validation: { field: 'amount', reason: 'too_precise' },
    },
    {
      name: 'memo exceeding 28 bytes',
      params: () => {
        const sender = createWallet();
        const receiver = createWallet();
        return {
          sourceSecret: sender.secretKey,
          destination: receiver.publicKey,
          amount: '10',
          memo: 'a'.repeat(29),
        };
      },
      code: 'TX_INVALID_MEMO',
      validation: { field: 'memo', reason: 'too_long' },
    },
    {
      name: 'self-payment',
      params: () => {
        const wallet = createWallet();
        return {
          sourceSecret: wallet.secretKey,
          destination: wallet.publicKey,
          amount: '10',
        };
      },
      code: 'SELF_PAYMENT',
      validation: { field: 'destination', reason: 'same_as_source' },
    },
  ])('$name', async ({ params, code, validation }) => {
    await expectPocketPayError(sendXLM(params()), { code, validation });
    expect(mockLoadAccount).not.toHaveBeenCalled();
  });
});

describe('sendXLM — network and submission errors', () => {
  let sender: ReturnType<typeof createWallet>;
  let receiver: ReturnType<typeof createWallet>;

  beforeEach(() => {
    mockLoadAccount.mockReset();
    mockSubmitTransaction.mockReset();
    sender = createWallet();
    receiver = createWallet();
  });

  it('returns success with transaction hash on a valid submission', async () => {
    mockSubmitTransaction.mockResolvedValueOnce({
      hash: 'XLM_SUCCESS_HASH',
      ledger: 42,
      fee_charged: '100',
      created_at: '2026-07-22T12:00:00Z',
    });
    mockLoadAccount.mockResolvedValueOnce(await sourceAccountFor(sender.publicKey));

    const result = await sendXLM({
      sourceSecret: sender.secretKey,
      destination: receiver.publicKey,
      amount: '10',
    });

    expect(result.success).toBe(true);
    expect(result.hash).toBe('XLM_SUCCESS_HASH');
    expect(result.destinationAccount).toBe(receiver.publicKey);
  });

  it('maps an unfunded source account to ACCOUNT_NOT_FOUND', async () => {
    mockLoadAccount.mockRejectedValue(makeHorizon404Error(sender.publicKey));

    const error = await expectPocketPayError(
      sendXLM({
        sourceSecret: sender.secretKey,
        destination: receiver.publicKey,
        amount: '10',
      }),
      { code: 'ACCOUNT_NOT_FOUND' },
    );

    expect(error).toBeInstanceOf(PaymentError);
    expect((error as PaymentError).paymentCategory).toBe(PaymentFailureCategory.Account);
  });

  it('maps a slow source account lookup to REQUEST_TIMEOUT (preparation stage)', async () => {
    mockLoadAccount.mockReturnValue(neverSettlingPromise());

    await expectPocketPayError(
      sendXLM(
        {
          sourceSecret: sender.secretKey,
          destination: receiver.publicKey,
          amount: '10',
        },
        { timeout: 5 },
      ),
      {
        code: 'REQUEST_TIMEOUT',
        timeout: { stage: 'preparation' },
      },
    );
  });

  it('maps a slow submission to TX_STATUS_UNKNOWN (submission stage)', async () => {
    mockLoadAccount.mockResolvedValueOnce(await sourceAccountFor(sender.publicKey));
    mockSubmitTransaction.mockReturnValue(neverSettlingPromise());

    await expectPocketPayError(
      sendXLM(
        {
          sourceSecret: sender.secretKey,
          destination: receiver.publicKey,
          amount: '10',
        },
        { timeout: 5 },
      ),
      {
        code: 'TX_STATUS_UNKNOWN',
        timeout: { stage: 'submission' },
      },
    );
  });

  it('maps Horizon result codes on submission to PAYMENT_FAILED', async () => {
    mockLoadAccount.mockResolvedValueOnce(await sourceAccountFor(sender.publicKey));
    mockSubmitTransaction.mockRejectedValue(
      makeHorizonResultCodeError('tx_insufficient_balance', ['op_underfunded']),
    );

    try {
      await sendXLM({
        sourceSecret: sender.secretKey,
        destination: receiver.publicKey,
        amount: '10',
      });
      throw new Error('expected sendXLM to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(PocketPayError);
      const err = error as PocketPayError;
      expect(err.code).toBe('PAYMENT_FAILED');
      expect(err.message).toContain('tx_insufficient_balance');
      expect(err.message).not.toContain('op_underfunded');
    }
  });

  it('wraps unexpected submission failures as SEND_ERROR', async () => {
    mockLoadAccount.mockResolvedValueOnce(await sourceAccountFor(sender.publicKey));
    mockSubmitTransaction.mockRejectedValue(new Error('Network failure'));

    await expectPocketPayError(
      sendXLM({
        sourceSecret: sender.secretKey,
        destination: receiver.publicKey,
        amount: '10',
      }),
      { code: 'SEND_ERROR' },
    );
  });
});

describe('sendAsset — typed validation errors', () => {
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

  it.each([
    {
      name: 'invalid destination',
      build: (ctx: { issuer: ReturnType<typeof createWallet>; receiver: ReturnType<typeof createWallet> }) => ({
        destination: 'GBADKEY',
        amount: '10',
        asset: { code: 'USDC', issuer: ctx.issuer.publicKey },
      }),
      code: 'INVALID_PUBLIC_KEY',
      validation: { field: 'publicKey', reason: 'invalid_format' },
    },
    {
      name: 'zero amount',
      build: (ctx: { issuer: ReturnType<typeof createWallet>; receiver: ReturnType<typeof createWallet> }) => ({
        destination: ctx.receiver.publicKey,
        amount: '0',
        asset: { code: 'USDC', issuer: ctx.issuer.publicKey },
      }),
      code: 'INVALID_AMOUNT',
      validation: { field: 'amount', reason: 'not_positive' },
    },
    {
      name: 'non-numeric amount',
      build: (ctx: { issuer: ReturnType<typeof createWallet>; receiver: ReturnType<typeof createWallet> }) => ({
        destination: ctx.receiver.publicKey,
        amount: '5.5.5',
        asset: { code: 'USDC', issuer: ctx.issuer.publicKey },
      }),
      code: 'INVALID_AMOUNT',
      validation: { field: 'amount', reason: 'invalid_format' },
    },
    {
      name: 'amount with too many decimal places',
      build: (ctx: { issuer: ReturnType<typeof createWallet>; receiver: ReturnType<typeof createWallet> }) => ({
        destination: ctx.receiver.publicKey,
        amount: '1.12345678',
        asset: { code: 'USDC', issuer: ctx.issuer.publicKey },
      }),
      code: 'INVALID_AMOUNT_PRECISION',
      validation: { field: 'amount', reason: 'too_precise' },
    },
  ])('$name', async ({ build, code, validation }) => {
    const built = build({ issuer, receiver });
    await expectPocketPayError(
      sendAsset({
        sourceSecret: sender.secretKey,
        ...built,
      }),
      { code, validation },
    );
    expect(mockLoadAccount).not.toHaveBeenCalled();
  });
});

describe('sendAsset — unsupported asset errors', () => {
  let sender: ReturnType<typeof createWallet>;
  let receiver: ReturnType<typeof createWallet>;
  let issuer: ReturnType<typeof createWallet>;

  beforeEach(() => {
    mockLoadAccount.mockReset();
    sender = createWallet();
    receiver = createWallet();
    issuer = createWallet();
  });

  it.each([
    {
      name: 'native XLM with spurious issuer',
      buildAsset: (issuer: ReturnType<typeof createWallet>) => ({ code: 'XLM', issuer: issuer.publicKey }),
      code: 'INVALID_ASSET',
      validation: { field: 'asset.issuer', reason: 'native_asset_has_issuer' },
    },
    {
      name: 'asset code too long',
      buildAsset: (issuer: ReturnType<typeof createWallet>) => ({ code: 'TOOLONGCODE123', issuer: issuer.publicKey }),
      code: 'INVALID_ASSET_CODE',
      validation: { field: 'asset.code', reason: 'invalid_format' },
    },
    {
      name: 'issued asset missing issuer',
      buildAsset: () => ({ code: 'USDC' }),
      code: 'MISSING_ASSET_ISSUER',
      validation: { field: 'asset.issuer', reason: 'missing' },
    },
    {
      name: 'issued asset with invalid issuer key',
      buildAsset: () => ({ code: 'USDC', issuer: 'NOTAVALIDKEY' }),
      code: 'INVALID_PUBLIC_KEY',
      validation: { field: 'publicKey', reason: 'invalid_format' },
    },
    {
      name: 'empty asset code',
      buildAsset: () => ({ code: '' }) as any,
      code: 'INVALID_ASSET_CODE',
      validation: { field: 'asset.code', reason: 'empty' },
    },
  ])('$name', async ({ buildAsset, code, validation }) => {
    await expectPocketPayError(
      sendAsset({
        sourceSecret: sender.secretKey,
        destination: receiver.publicKey,
        amount: '10',
        asset: buildAsset(issuer),
      }),
      { code, validation },
    );
    expect(mockLoadAccount).not.toHaveBeenCalled();
  });
});

describe('sendAsset — destination trustline errors', () => {
  let sender: ReturnType<typeof createWallet>;
  let receiver: ReturnType<typeof createWallet>;
  let issuer: ReturnType<typeof createWallet>;

  beforeEach(() => {
    mockLoadAccount.mockReset();
    sender = createWallet();
    receiver = createWallet();
    issuer = createWallet();
  });

  it('throws UNFUNDED_DESTINATION when destination account does not exist', async () => {
    mockLoadAccount.mockRejectedValue(makeHorizon404Error(receiver.publicKey));

    await expectPocketPayError(
      sendAsset({
        sourceSecret: sender.secretKey,
        destination: receiver.publicKey,
        amount: '10',
        asset: { code: 'USDC', issuer: issuer.publicKey },
      }),
      {
        code: 'UNFUNDED_DESTINATION',
        validation: { field: 'destination', reason: 'account_not_found' },
      },
    );
  });

  it('throws MISSING_TRUSTLINE when destination has no matching balance', async () => {
    mockLoadAccount.mockResolvedValue({
      balances: [{ asset_type: 'native', balance: '100.0' }],
    });

    await expectPocketPayError(
      sendAsset({
        sourceSecret: sender.secretKey,
        destination: receiver.publicKey,
        amount: '10',
        asset: { code: 'USDC', issuer: issuer.publicKey },
      }),
      {
        code: 'MISSING_TRUSTLINE',
        validation: { field: 'destination', reason: 'missing_trustline' },
      },
    );
  });

  it('throws TRUSTLINE_NOT_AUTHORIZED when trustline is not authorized', async () => {
    mockLoadAccount.mockResolvedValue({
      balances: [
        {
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          asset_issuer: issuer.publicKey,
          balance: '0.0000000',
          limit: '1000.0000000',
          is_authorized: false,
        },
      ],
    });

    await expectPocketPayError(
      sendAsset({
        sourceSecret: sender.secretKey,
        destination: receiver.publicKey,
        amount: '10',
        asset: { code: 'USDC', issuer: issuer.publicKey },
      }),
      {
        code: 'TRUSTLINE_NOT_AUTHORIZED',
        validation: { field: 'destination', reason: 'not_authorized' },
      },
    );
  });

  it('throws TRUSTLINE_LIMIT_EXCEEDED when payment exceeds available capacity', async () => {
    mockLoadAccount.mockResolvedValue({
      balances: [
        {
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          asset_issuer: issuer.publicKey,
          balance: '950.0000000',
          limit: '1000.0000000',
          is_authorized: true,
        },
      ],
    });

    await expectPocketPayError(
      sendAsset({
        sourceSecret: sender.secretKey,
        destination: receiver.publicKey,
        amount: '100',
        asset: { code: 'USDC', issuer: issuer.publicKey },
      }),
      {
        code: 'TRUSTLINE_LIMIT_EXCEEDED',
        validation: { field: 'destination', reason: 'limit_exceeded' },
      },
    );
  });
});

describe('sendAsset — network and submission errors', () => {
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

  it('maps Horizon result codes on submission to PAYMENT_FAILED', async () => {
    mockLoadAccount
      .mockResolvedValueOnce(validUsdcTrustline(issuer.publicKey))
      .mockResolvedValueOnce(await sourceAccountFor(sender.publicKey));
    mockSubmitTransaction.mockRejectedValue(
      makeHorizonResultCodeError('tx_failed', ['op_no_trust']),
    );

    try {
      await sendAsset({
        sourceSecret: sender.secretKey,
        destination: receiver.publicKey,
        amount: '10',
        asset: { code: 'USDC', issuer: issuer.publicKey },
      });
      throw new Error('expected sendAsset to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(PocketPayError);
      const err = error as PaymentError;
      expect(err.code).toBe('PAYMENT_FAILED');
      expect(err.paymentCategory).toBe(PaymentFailureCategory.Asset);
      expect(err.message).toContain('tx_failed');
      expect(err.message).not.toContain('op_no_trust');
    }
  });

  it('wraps unexpected submission failures as SEND_ERROR', async () => {
    mockLoadAccount
      .mockResolvedValueOnce(validUsdcTrustline(issuer.publicKey))
      .mockResolvedValueOnce(await sourceAccountFor(sender.publicKey));
    mockSubmitTransaction.mockRejectedValue(new Error('Connection reset'));

    const error = await expectPocketPayError(
      sendAsset({
        sourceSecret: sender.secretKey,
        destination: receiver.publicKey,
        amount: '10',
        asset: { code: 'USDC', issuer: issuer.publicKey },
      }),
      { code: 'SEND_ERROR' },
    );

    expect(error).toBeInstanceOf(PaymentError);
    expect((error as PaymentError).paymentCategory).toBe(PaymentFailureCategory.Network);
  });

  it('safeSendAsset returns typed SEND_ERROR without throwing on network failure', async () => {
    mockLoadAccount.mockRejectedValue(new Error('Network failure'));

    const result = await safeSendAsset({
      sourceSecret: sender.secretKey,
      destination: receiver.publicKey,
      amount: '10',
      asset: { code: 'USDC', issuer: issuer.publicKey },
      skipTrustlineCheck: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(PaymentError);
      expect(result.error.code).toBe('SEND_ERROR');
      expect((result.error as PaymentError).paymentCategory).toBe(
        PaymentFailureCategory.Network,
      );
    }
  });
});
