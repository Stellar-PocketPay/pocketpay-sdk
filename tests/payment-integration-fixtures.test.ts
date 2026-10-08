import { describe, expect, it } from 'vitest';
import { createPaymentIntent } from '../src/payments/intent';
import { AccountBuilder } from './fixtures/accounts/account-builder';
import { PaymentBuilder } from './fixtures/payments/payment-builder';
import { TransactionBuilder } from './fixtures/transactions/transaction-builder';
import { VaultBuilder } from './fixtures/vault/vault-builder';
import { paymentFlowFixtures, FIXTURE_FLOW_SOURCE } from './fixtures';

describe('payment integration fixtures (#448)', () => {
  it('uses reproducible timestamps in every builder that carries dates', () => {
    const builders = [AccountBuilder, PaymentBuilder, TransactionBuilder, VaultBuilder];
    for (const Builder of builders) {
      const first = new Builder().build();
      const second = new Builder().build();
      expect(first.createdAt.toISOString()).toBe('2024-01-15T10:30:00.000Z');
      expect(second.createdAt.toISOString()).toBe(first.createdAt.toISOString());
      expect(second.updatedAt.toISOString()).toBe(first.updatedAt.toISOString());
    }
  });

  it('composes account, payment, transaction, and receipt identities consistently', () => {
    for (const scenario of Object.values(paymentFlowFixtures)) {
      expect(scenario.account.id).toBe(FIXTURE_FLOW_SOURCE);
      expect(scenario.payment.from).toBe(scenario.input.source);
      expect(scenario.transaction.to).toBe(scenario.input.destination);
      expect(scenario.payment.amount).toBe(scenario.transaction.amount);
      expect(scenario.payment.asset).toBe(scenario.input.asset.code);
      expect(scenario.transaction.asset).toBe(scenario.input.asset.code);
    }
    expect(JSON.stringify(paymentFlowFixtures)).not.toContain('sourceSecret');
  });

  it('can drive SDK native and issued-asset payment intent preflight', () => {
    for (const scenario of [paymentFlowFixtures.nativeSuccess, paymentFlowFixtures.issuedSuccess]) {
      const result = createPaymentIntent(scenario.input);
      expect(result.validationResult?.valid).toBe(true);
      expect(result.assetState).toBe('supported');
      expect(result.status).toBe('valid');
    }
    expect(paymentFlowFixtures.issuedSuccess.payment.assetIssuer).toBeDefined();
  });

  it('exposes a real SDK validation error for invalid recipient', () => {
    const intent = createPaymentIntent(paymentFlowFixtures.invalidRecipient.input);
    expect(intent.validationResult?.valid).toBe(false);
    expect(intent.validationResult?.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'INVALID_PUBLIC_KEY' })]),
    );
    expect(paymentFlowFixtures.invalidRecipient.receipt).toEqual({
      state: 'failed', errorCode: 'INVALID_PUBLIC_KEY',
    });
  });

  it('models insufficient funds, transport error and pending without broadcasting', () => {
    const { insufficientFunds, networkFailure, pending } = paymentFlowFixtures;
    expect(insufficientFunds.account.balance).toBe('0.0000000');
    expect(insufficientFunds.receipt.errorCode).toBe('INSUFFICIENT_BALANCE');
    expect(networkFailure.network.status).toBe(503);
    expect(networkFailure.receipt.errorCode).toBe('NETWORK_UNAVAILABLE');
    expect(pending.transaction.status).toBe('pending');
    expect(pending.receipt.state).toBe('pending');
  });
});
