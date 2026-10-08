/**
 * Pure, deterministic SDK payment-flow scenarios. All identifiers are public
 * test-only values, and no live network, wallet secret, or signing is involved.
 *
 * The input can be handed to createPaymentIntent for actual preflight checking.
 * The receipt and network outcome are *fixtures*, not broadcast confirmations.
 */
import type { CreatePaymentIntentParams } from '../../src/types/payment-intent';
import type { AccountFixture } from './accounts/account-builder';
import type { PaymentFixture } from './payments/payment-builder';
import type { TransactionFixture } from './transactions/transaction-builder';
import type { NetworkFixture } from './network/network-builder';
import { AccountBuilder } from './accounts/account-builder';
import { PaymentBuilder } from './payments/payment-builder';
import { TransactionBuilder } from './transactions/transaction-builder';
import { NetworkBuilder } from './network/network-builder';

export const FIXTURE_FLOW_SOURCE = 'GBEDH75BXETOM2UPESSCHDVGV7XRDKS74YUKXTC7LR627DQ3SUZIJG3Y';
export const FIXTURE_FLOW_DESTINATION = 'GBAW5KWLZU5PEUMR4PWXJVGFXDT4FRYIOKKTU74O5CGB24RWJS36LICH';
export const FIXTURE_FLOW_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

export interface PaymentFlowFixture {
  account: AccountFixture;
  input: CreatePaymentIntentParams;
  payment: PaymentFixture;
  transaction: TransactionFixture;
  network: NetworkFixture;
  /** Test outcome supplied by the caller; never evidence of a real ledger. */
  receipt: {
    state: 'confirmed' | 'pending' | 'failed';
    hash?: string;
    errorCode?: string;
  };
}

/** Compose a self-consistent test scenario, with isolated builder instances. */
function flow(
  options: {
    amount?: string;
    destination?: string;
    asset?: CreatePaymentIntentParams['asset'];
    memo?: string;
    balance?: string;
    paymentStatus?: PaymentFixture['status'];
    networkStatus?: number;
    receipt?: PaymentFlowFixture['receipt'];
  } = {},
): PaymentFlowFixture {
  const source = FIXTURE_FLOW_SOURCE;
  const destination = options.destination ?? FIXTURE_FLOW_DESTINATION;
  const amount = options.amount ?? '5.0000000';
  const asset: CreatePaymentIntentParams['asset'] = options.asset ?? { type: 'native', code: 'XLM' };
  const paymentStatus = options.paymentStatus ?? 'completed';
  const issuer = asset.type === 'issued' ? asset.issuer : undefined;
  const hash = 'a1b2c3d4e5f678901234567890abcdef1234567890abcdef1234567890abcdef';
  const account = new AccountBuilder().withId(source).withBalance(options.balance ?? '1000.0000000').build();
  const paymentBuilder = new PaymentBuilder()
    .withFrom(source).withTo(destination).withAmount(amount)
    .withAsset(asset.code).withStatus(paymentStatus).withTxHash(hash);
  if (issuer) paymentBuilder.withAssetIssuer(issuer);
  if (options.memo) paymentBuilder.withMemo(options.memo);
  const transactionBuilder = new TransactionBuilder()
    .withHash(hash).withFrom(source).withTo(destination)
    .withAmount(amount).withAsset(asset.code).withStatus(paymentStatus);
  if (issuer) transactionBuilder.withAssetIssuer(issuer);
  if (options.memo) transactionBuilder.withMemo(options.memo);
  const networkStatus = options.networkStatus ?? 200;
  const networkBuilder = new NetworkBuilder().withStatus(networkStatus);
  if (networkStatus >= 400) networkBuilder.withError('Network unavailable');
  return {
    account,
    input: { source, destination, amount, asset, memo: options.memo },
    payment: paymentBuilder.build(),
    transaction: transactionBuilder.build(),
    network: networkBuilder.build(),
    receipt: options.receipt ?? { state: 'confirmed', hash },
  };
}

/**
 * Distinct public test scenarios. Failures are intentionally typed as
 * simulation outcomes; no fixture contains a secret key or on-chain receipt.
 */
export const paymentFlowFixtures: Readonly<{
  nativeSuccess: PaymentFlowFixture;
  issuedSuccess: PaymentFlowFixture;
  invalidRecipient: PaymentFlowFixture;
  insufficientFunds: PaymentFlowFixture;
  networkFailure: PaymentFlowFixture;
  pending: PaymentFlowFixture;
}> = {
  nativeSuccess: flow(),
  issuedSuccess: flow({
    asset: { type: 'issued', code: 'USDC', issuer: FIXTURE_FLOW_ISSUER },
    amount: '12.5000000',
  }),
  invalidRecipient: flow({
    destination: 'NOT_A_STELLAR_ADDRESS',
    paymentStatus: 'failed',
    receipt: { state: 'failed', errorCode: 'INVALID_PUBLIC_KEY' },
  }),
  insufficientFunds: flow({
    amount: '10.0000000',
    balance: '0.0000000',
    paymentStatus: 'failed',
    receipt: { state: 'failed', errorCode: 'INSUFFICIENT_BALANCE' },
  }),
  networkFailure: flow({
    networkStatus: 503,
    paymentStatus: 'failed',
    receipt: { state: 'failed', errorCode: 'NETWORK_UNAVAILABLE' },
  }),
  pending: flow({
    paymentStatus: 'pending',
    receipt: { state: 'pending' },
  }),
};
