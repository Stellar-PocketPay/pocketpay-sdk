import { cloneFixture } from './builders/fixture-builder';
import { accountFixtures } from './accounts/account-fixtures';
import { paymentFixtures } from './payments/payment-fixtures';
import { transactionFixtures } from './transactions/transaction-fixtures';
import { networkFixtures } from './network/network-fixtures';
import { sorobanFixtures } from './soroban/soroban-fixtures';
import { vaultFixtures } from './vault/vault-fixtures';
import { NetworkBuilder } from './network/network-builder';

export type SDKScenarioKind = 'success' | 'failure' | 'timeout' | 'unsupported' | 'unknown';
export type SDKScenario = {
  account: typeof accountFixtures.valid;
  payment: typeof paymentFixtures.success;
  transaction: typeof transactionFixtures.success;
  network: typeof networkFixtures.success;
  soroban: typeof sorobanFixtures.success;
  vault: typeof vaultFixtures.success;
};
export const sdkScenarioKinds: readonly SDKScenarioKind[] = [
  'success', 'failure', 'timeout', 'unsupported', 'unknown',
];

/**
 * A correlated offline scenario across SDK boundaries. Always returns fresh
 * nested values and Date instances; fixture suites can run in any order.
 * 'Unknown' is deliberately not called 'failed': it needs reconciliation.
 */
export function createSdkScenario(kind: SDKScenarioKind): SDKScenario {
  switch (kind) {
    case 'success': return cloneFixture({
      account: accountFixtures.valid,
      payment: paymentFixtures.success,
      transaction: transactionFixtures.success,
      network: networkFixtures.success,
      soroban: sorobanFixtures.success,
      vault: vaultFixtures.success,
    });
    case 'failure': return cloneFixture({
      account: accountFixtures.lowBalance,
      payment: paymentFixtures.failed,
      transaction: transactionFixtures.failed,
      network: networkFixtures.serverError,
      soroban: sorobanFixtures.error,
      vault: vaultFixtures.failed,
    });
    case 'timeout': return cloneFixture({
      account: accountFixtures.valid,
      payment: paymentFixtures.pending,
      transaction: transactionFixtures.pending,
      network: networkFixtures.timeout,
      soroban: sorobanFixtures.timeout,
      vault: vaultFixtures.pending,
    });
    case 'unsupported': return cloneFixture({
      account: accountFixtures.valid,
      payment: paymentFixtures.pending,
      transaction: transactionFixtures.pending,
      network: new NetworkBuilder().withStatus(501).withError('Unsupported feature').build(),
      soroban: sorobanFixtures.unsupported,
      vault: vaultFixtures.pending,
    });
    case 'unknown': return cloneFixture({
      account: accountFixtures.pending,
      payment: paymentFixtures.pending,
      transaction: transactionFixtures.unknown,
      network: networkFixtures.serverError,
      soroban: sorobanFixtures.timeout,
      vault: vaultFixtures.pending,
    });
  }
}
