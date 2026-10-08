import { describe, it, expect } from 'vitest';
import * as PocketPay from '../src';
import type {
AccountBalance,
BalanceResult,
FailureResult,
FundResult,
PaymentRecord,
PaymentResult,
PocketPayResult,
SDKConfig,
SendXLMParams,
SuccessResult,
TransactionRecord,
VaultBalanceParams,
VaultDepositParams,
VaultResult,
VaultWithdrawParams,
WalletKeypair,
} from '../src';

const REQUIRED_PUBLIC_EXPORTS = {
errors: ['PocketPayError', 'PaymentParseError', 'PaymentErrorCode'],
wallet: [
'createWallet',
'importWallet',
'getPublicKey',
'getBalance',
'fundTestnetAccount',
'getBalanceOrUnfunded',
],
payments: ['sendXLM'],
transactions: [
'getTransactions',
'getPayments',
'filterTransactions',
'filterByDirection',
'filterByAsset',
'filterByDateRange',
'filterByCounterparty',
'sortTransactionsByDate',
],
soroban: ['depositToVault', 'withdrawFromVault', 'getVaultBalance'],
config: [
'resolveConfig',
'getHorizonServer',
'setHorizonServerFactory',
'resetHorizonServerFactory',
'getNetworkPassphrase',
'getFriendbotUrl',
'validateNetwork',
'validateHorizonUrl',
'validateSorobanRpcUrl',
'validateTimeout',
'validateContractId',
],
utilities: [
'validatePublicKey',
'validateSecretKey',
'validateAmount',
'stroopsToXLM',
'mapAuthRequirements',
'inspectSignedTransaction',
'safeInspectSignedTransaction',
'matchSignersByHint',
'identifyPresentSigners',
'assertAuthFullyMapped',
'toAuthAccountState',
'parseAmount',
'parsePositiveAmount',
'safeParseAmount',
'fromStroops',
'toStroops',
'formatStroops',
'xlmToStroops',
'truncateAddress',
'validateMemo',
'validateSequenceValue',
'isSequenceStale',
'requiresRebuild',
'validateMemoInput',
'safeValidateMemo',
'normalizeMemo',
'buildMemo',
'toSuccessResult',
'toFailureResult',
'toResult',
'safeGetBalance',
'safeFundTestnetAccount',
'safeSendXLM',
'safeGetTransactions',
'safeGetPayments',
'redactSecretKey',
'redactSensitiveValue',
],
diagnostics: [
'enableDiagnostics',
'disableDiagnostics',
'setDiagnosticsHooks',
'resetDiagnosticsHooks',
'isDiagnosticsEnabled',
'emitDiagnosticsEvent',
'buildDiagnosticsReport',
'redactDiagnosticsValue',
'probeConfiguredEndpoints',
],
network: [
'NetworkClient',
'withTimeout',
'fetchWithTimeout',
'executeHorizonOperation',
'executeSorobanOperation',
'checkEndpointReachability',
'submitTransactionIdempotently',
'pollTransactionStatus',
'withRetryPolicy',
'fetchFeeEstimate',
],
} as const;

/** Asserts a named helper is exported from the package root. */
function expectExported(name: string): void {
  expect(
    (PocketPay as Record<string, unknown>)[name],
    `"${name}" should be exported from the package root`
  ).toBeDefined();
}

// Helpers that exist internally (e.g. in src/utils) but should never be
// exposed on the package root, since they're implementation details.
const INTERNAL_ONLY = ['wrapError', 'sleep'];

describe('Package root exports', () => {
  it('exports wallet helpers from the package root', () => {
    for (const name of REQUIRED_PUBLIC_EXPORTS.wallet) {
      expectExported(name);
    }
  });

  it('exports payment helpers from the package root', () => {
    for (const name of REQUIRED_PUBLIC_EXPORTS.payments) {
      expectExported(name);
    }
  });

  it('exports transaction helpers from the package root', () => {
    for (const name of REQUIRED_PUBLIC_EXPORTS.transactions) {
      expectExported(name);
    }
  });

  it('exports Soroban helper exports from the package root', () => {
    for (const name of REQUIRED_PUBLIC_EXPORTS.soroban) {
      expectExported(name);
    }
  });

  it('exports config and validation utilities from the package root', () => {
    for (const name of REQUIRED_PUBLIC_EXPORTS.config) {
      expectExported(name);
    }

    for (const name of REQUIRED_PUBLIC_EXPORTS.utilities) {
      expectExported(name);
    }
  });

  it('exports diagnostics helpers from the package root', () => {
    for (const name of REQUIRED_PUBLIC_EXPORTS.diagnostics) {
      expectExported(name);
    }
  });

  it('exports the network resilience layer from the package root', () => {
    for (const name of REQUIRED_PUBLIC_EXPORTS.network) {
      expectExported(name);
    }
  });

  it('exports errors and public types from the package root', () => {
    for (const name of REQUIRED_PUBLIC_EXPORTS.errors) {
      expectExported(name);
    }
  });

  it('does not expose internal-only helpers from the package root', () => {
    for (const name of INTERNAL_ONLY) {
      expect(
        (PocketPay as Record<string, unknown>)[name],
        `"${name}" is an internal helper and should not be exported from the package root`
      ).toBeUndefined();
    }
  });
});
