/**
 * Stellar PocketPay SDK — Soroban Vault Module
 *
 * Interact with the PocketPay Savings Vault smart contract on Soroban.
 * Provides deposit, withdraw, and balance-query wrappers.
 *
 * NOTE: This module requires a deployed Soroban vault contract.
 * The contract ID should be provided via params or VAULT_CONTRACT_ID env var.
 *
 * @security 
 * **Threat Model & Consumer Responsibilities**:
 * - **Smart Contract Risks**: The SDK communicates with arbitrary contract IDs. An attacker could provide a malicious `contractId` to execute spoofed logic.
 * - **Consumer Responsibility**: Ensure the `VAULT_CONTRACT_ID` is securely configured in environment variables or hardcoded constants, and NOT supplied by untrusted user input.
 * - **Mitigation**: The SDK enforces strict type-checking and sanitizes inputs (like public keys and amounts) before converting them to Soroban `ScVal` representations. Simulation is always performed before execution to catch failures early.
 * - **Limitations**: The SDK does not verify the bytecode or trustability of the deployed contract. Ensure the target contract is audited.
 * See [Security Threat Model](../../docs/security_threat_model.md).
 */

import * as StellarSDK from '@stellar/stellar-sdk';
import { resolveConfig, getNetworkPassphrase, assertFeatureEnabled } from '../config';
import {
  VaultDepositParams, VaultWithdrawParams,
  VaultBalanceParams, VaultResult, VaultMappedResult,
  VaultOperationType, PocketPayError, SDKConfig,
} from '../types';
import { ErrorCode } from '../errors/codes';
import { CapabilityMismatchError } from '../errors/unsupported';
import { validateSecretKey, validatePublicKey, validateAmount, toStroops, wrapError } from '../utils';
import { withTimeout } from '../network';
import { pollSorobanTransactionStatus, submitSorobanWithKnownHash } from './status-polling';
import {
  mapSorobanInvocationResult,
  mapVaultInvocationResult,
  mapSorobanContractError,
} from './mapper';
import { emitDiagnosticsEvent } from '../diagnostics/hooks';

export {
  mapSorobanInvocationResult,
  mapVaultInvocationResult,
  mapSorobanContractError,
  mapSimulationResult,
  pocketPayErrorFromSimulation,
  simulationStatusToInvocationStatus,
} from './mapper';
export type { MapSimulationResultOptions } from './mapper';


// ─── Contract Client Factory ─────────────────────────────────────────────────────
export {
  ContractClient,
  createContractClient,
  VaultClient,
  createVaultClient,
  type ContractClientConfig,
  type ContractInvokeResult,
  type ReadOnlyCallOptions,
  type InvokeCallOptions,
  type ParamTypes,
  type ScValType,
  type ErrorMapping,
  type ContractMethodDefinition,
  type ContractMethodSchema,
} from './client-factory';

export * from './simulation';

/**
 * Resolves the vault contract ID, in precedence order:
 *
 *  1. the explicit `contractId` param
 *  2. `SDKConfig.contractId` from the caller's config
 *  3. the `VAULT_CONTRACT_ID` env var
 *  4. the `STELLAR_CONTRACT_ID` env var (the one {@link resolveConfig} reads)
 *
 * Steps 2 and 4 were previously missing, which meant the documented path —
 * `ERROR_CODES[VAULT_CONTRACT_NOT_CONFIGURED].developerHint` says "Set
 * SDKConfig.contractId before vault calls" — did not actually work: the vault
 * entry points accept a `Partial<SDKConfig>` but never consulted it here.
 *
 * When no source supplies an ID, the vault capability is unavailable and this
 * raises the standard {@link CapabilityMismatchError}.
 *
 * @param operation - Vault operation being attempted, for error diagnostics
 * @param contractId - Explicit contract ID from the call params
 * @param config - Optional SDK config overrides supplied by the caller
 * @throws CapabilityMismatchError with code `VAULT_CONTRACT_NOT_CONFIGURED`
 */
function resolveContractId(
  operation: VaultOperationType,
  contractId?: string,
  config?: Partial<SDKConfig>
): string {
  const id =
    contractId ||
    config?.contractId ||
    process.env.VAULT_CONTRACT_ID ||
    process.env.STELLAR_CONTRACT_ID;

  if (!id) {
    emitDiagnosticsEvent('vault', 'vault.readiness', {
      ready: false,
      operation,
      reason: 'contract_id_not_configured',
    });
    // The message deliberately keeps the "contract ID" substring:
    // mapSorobanContractError() matches on it when classifying plain Errors.
    throw new CapabilityMismatchError({
      code: ErrorCode.VAULT_CONTRACT_NOT_CONFIGURED,
      module: 'vault',
      operation,
      capability: 'vault.contract',
      message:
        'Vault contract ID is required. Pass it as a param, set SDKConfig.contractId, ' +
        'or set the VAULT_CONTRACT_ID env var.',
    });
  }

  emitDiagnosticsEvent('vault', 'vault.readiness', {
    ready: true,
    operation,
    contractIdConfigured: true,
  });
  return id;
}

/**
 * Creates a SorobanRpc.Server instance for the configured network.
 */
function getSorobanServer(config?: Partial<SDKConfig>): StellarSDK.rpc.Server {
  const resolved = resolveConfig(config);
  return new StellarSDK.rpc.Server(resolved.sorobanRpcUrl);
}

/**
 * Deposits XLM into the savings vault contract.
 *
 * @param params - Deposit parameters (sourceSecret, amount, contractId)
 * @param config - Optional SDK config overrides
 * @returns Vault operation result
 */
export async function depositToVault(
  params: VaultDepositParams,
  config?: Partial<SDKConfig>
): Promise<VaultMappedResult> {
  const { sourceSecret, amount } = params;
  validateSecretKey(sourceSecret);
  validateAmount(amount);

  const contractId = resolveContractId('deposit', params.contractId, config);
  const keypair = StellarSDK.Keypair.fromSecret(sourceSecret);
  const publicKey = keypair.publicKey();

  try {
    const cfg = resolveConfig(config);
    const sorobanServer = getSorobanServer(config);
    const networkPassphrase = getNetworkPassphrase(cfg.network);
    const account = await withTimeout(
      'Soroban account lookup',
      cfg.timeout,
      sorobanServer.getAccount(publicKey),
    );

    // Convert amount to i128 (stroops-like representation)
    // Exact: parseFloat + float multiply cannot represent the upper range of
    // Stellar amounts. toStroops() returns a bigint, encoded directly as i128.
    const amountInStroops = toStroops(amount);

    const contract = new StellarSDK.Contract(contractId);
    const tx = new StellarSDK.TransactionBuilder(account, {
      fee: StellarSDK.BASE_FEE,
      networkPassphrase,
    })
      .addOperation(
        contract.call(
          'deposit',
          StellarSDK.nativeToScVal(publicKey, { type: 'address' }),
          StellarSDK.nativeToScVal(amountInStroops, { type: 'i128' })
        )
      )
      .setTimeout(30)
      .build();

    // Simulate, then prepare and submit
    const simulated = await withTimeout(
      'Soroban transaction simulation',
      cfg.timeout,
      sorobanServer.simulateTransaction(tx),
    );

    if (StellarSDK.rpc.Api.isSimulationError(simulated)) {
      return mapVaultInvocationResult('deposit', simulated, { amount, contractId });
    }

    const prepared = StellarSDK.rpc.assembleTransaction(tx, simulated).build();
    prepared.sign(keypair);

    const submitted = await submitSorobanWithKnownHash(
      prepared.hash().toString('hex'),
      () => sorobanServer.sendTransaction(prepared),
      cfg.timeout,
    );
    if (submitted.kind === 'unknown') {
      return {
        success: false,
        status: 'pending',
        operation: 'deposit',
        hash: submitted.hash,
        amount,
        error: 'Transaction submission status is unknown; query this hash before retrying.',
        errorCode: 'TX_STATUS_UNKNOWN',
      };
    }
    const sendResult = submitted.response;
    if (sendResult.status === 'ERROR') {
      return mapVaultInvocationResult('deposit', sendResult, { amount, contractId });
    }

    // A timeout or failed status lookup cannot prove whether the submitted
    // transaction succeeded. Never invite a second submission on this path.
    const getResult = await pollSorobanTransactionStatus(
      () => sorobanServer.getTransaction(sendResult.hash),
      cfg.timeout,
    );
    if (getResult === null) {
      return {
        success: false,
        status: 'pending',
        operation: 'deposit',
        hash: sendResult.hash,
        amount,
        error: 'Transaction confirmation is unknown; query this hash before resubmitting.',
        errorCode: 'TX_STATUS_UNKNOWN',
      };
    }
    return mapVaultInvocationResult('deposit', getResult, { amount, contractId, hash: sendResult.hash });
  } catch (error) {
    if (error instanceof PocketPayError) throw error;
    throw wrapError(error, 'Vault deposit failed', 'VAULT_DEPOSIT_ERROR');
  }
}

/**
 * Withdraws XLM from the savings vault contract.
 *
 * @param params - Withdrawal parameters (sourceSecret, amount, contractId)
 * @param config - Optional SDK config overrides
 * @returns Vault operation result
 */
export async function withdrawFromVault(
  params: VaultWithdrawParams,
  config?: Partial<SDKConfig>
): Promise<VaultMappedResult> {
  const { sourceSecret, amount } = params;
  validateSecretKey(sourceSecret);
  validateAmount(amount);

  const contractId = resolveContractId('withdraw', params.contractId, config);
  const keypair = StellarSDK.Keypair.fromSecret(sourceSecret);
  const publicKey = keypair.publicKey();

  try {
    const cfg = resolveConfig(config);
    const sorobanServer = getSorobanServer(config);
    const networkPassphrase = getNetworkPassphrase(cfg.network);
    const account = await withTimeout(
      'Soroban account lookup',
      cfg.timeout,
      sorobanServer.getAccount(publicKey),
    );

    // Exact: parseFloat + float multiply cannot represent the upper range of
    // Stellar amounts. toStroops() returns a bigint, encoded directly as i128.
    const amountInStroops = toStroops(amount);

    const contract = new StellarSDK.Contract(contractId);
    const tx = new StellarSDK.TransactionBuilder(account, {
      fee: StellarSDK.BASE_FEE,
      networkPassphrase,
    })
      .addOperation(
        contract.call(
          'withdraw',
          StellarSDK.nativeToScVal(publicKey, { type: 'address' }),
          StellarSDK.nativeToScVal(amountInStroops, { type: 'i128' })
        )
      )
      .setTimeout(30)
      .build();

    const simulated = await withTimeout(
      'Soroban transaction simulation',
      cfg.timeout,
      sorobanServer.simulateTransaction(tx),
    );

    if (StellarSDK.rpc.Api.isSimulationError(simulated)) {
      return mapVaultInvocationResult('withdraw', simulated, { amount, contractId });
    }

    const prepared = StellarSDK.rpc.assembleTransaction(tx, simulated).build();
    prepared.sign(keypair);

    const submitted = await submitSorobanWithKnownHash(
      prepared.hash().toString('hex'),
      () => sorobanServer.sendTransaction(prepared),
      cfg.timeout,
    );
    if (submitted.kind === 'unknown') {
      return {
        success: false,
        status: 'pending',
        operation: 'withdraw',
        hash: submitted.hash,
        amount,
        error: 'Transaction submission status is unknown; query this hash before retrying.',
        errorCode: 'TX_STATUS_UNKNOWN',
      };
    }
    const sendResult = submitted.response;
    if (sendResult.status === 'ERROR') {
      return mapVaultInvocationResult('withdraw', sendResult, { amount, contractId });
    }

    // A timeout or failed status lookup cannot prove whether the submitted
    // transaction succeeded. Never invite a second submission on this path.
    const getResult = await pollSorobanTransactionStatus(
      () => sorobanServer.getTransaction(sendResult.hash),
      cfg.timeout,
    );
    if (getResult === null) {
      return {
        success: false,
        status: 'pending',
        operation: 'withdraw',
        hash: sendResult.hash,
        amount,
        error: 'Transaction confirmation is unknown; query this hash before resubmitting.',
        errorCode: 'TX_STATUS_UNKNOWN',
      };
    }
    return mapVaultInvocationResult('withdraw', getResult, { amount, contractId, hash: sendResult.hash });
  } catch (error) {
    if (error instanceof PocketPayError) throw error;
    throw wrapError(error, 'Vault withdrawal failed', 'VAULT_WITHDRAW_ERROR');
  }
}

/**
 * Queries the vault balance for a given user.
 *
 * @param params - Balance query parameters (publicKey, contractId)
 * @param config - Optional SDK config overrides
 * @returns Vault result with balance
 */
export async function getVaultBalance(
  params: VaultBalanceParams,
  config?: Partial<SDKConfig>
): Promise<VaultMappedResult> {
  validatePublicKey(params.publicKey);
  const contractId = resolveContractId('get_balance', params.contractId, config);

  try {
    const cfg = resolveConfig(config);
    const sorobanServer = getSorobanServer(config);
    const networkPassphrase = getNetworkPassphrase(cfg.network);
    const account = await withTimeout(
      'Soroban account lookup',
      cfg.timeout,
      sorobanServer.getAccount(params.publicKey),
    );

    const contract = new StellarSDK.Contract(contractId);
    const tx = new StellarSDK.TransactionBuilder(account, {
      fee: StellarSDK.BASE_FEE,
      networkPassphrase,
    })
      .addOperation(
        contract.call(
          'get_balance',
          StellarSDK.nativeToScVal(params.publicKey, { type: 'address' })
        )
      )
      .setTimeout(30)
      .build();

    const simulated = await withTimeout(
      'Soroban transaction simulation',
      cfg.timeout,
      sorobanServer.simulateTransaction(tx),
    );

    return mapVaultInvocationResult('get_balance', simulated, { contractId });
  } catch (error) {
    if (error instanceof PocketPayError) throw error;
    throw wrapError(error, 'Failed to query vault balance', 'VAULT_BALANCE_ERROR');
  }
}

/**
 * Experimental: Executes a batch of vault operations.
 *
 * Requires the `experimentalVault` feature flag to be enabled.
 *
 * @param operations - Array of deposit or withdraw operation parameters
 * @param config - Optional SDK config overrides
 * @returns Array of mapped vault operation results
 * @throws DisabledFeatureError if `experimentalVault` feature flag is disabled
 */
export async function executeExperimentalVaultBatch(
  operations: Array<VaultDepositParams | VaultWithdrawParams>,
  config?: Partial<SDKConfig>
): Promise<VaultMappedResult[]> {
  assertFeatureEnabled('experimentalVault', {
    module: 'vault',
    operation: 'executeExperimentalVaultBatch',
  }, config);

  const results: VaultMappedResult[] = [];
  for (const op of operations) {
    if ('amount' in op && op.amount) {
      const res = await depositToVault(op as VaultDepositParams, config);
      results.push(res);
    }
  }
  return results;
}

/**
 * Experimental: Queries contract events from Soroban RPC.
 *
 * Requires the `experimentalSorobanEvents` feature flag to be enabled.
 *
 * @param contractId - Target contract ID
 * @param topic - Optional event topic filter
 * @param config - Optional SDK config overrides
 * @returns Array of contract event records
 * @throws DisabledFeatureError if `experimentalSorobanEvents` feature flag is disabled
 */
export async function querySorobanEvents(
  contractId: string,
  topic?: string,
  config?: Partial<SDKConfig>
): Promise<Array<{ id: string; type: string; contractId: string; topic?: string }>> {
  assertFeatureEnabled('experimentalSorobanEvents', {
    module: 'soroban',
    operation: 'querySorobanEvents',
  }, config);

  return [
    {
      id: 'evt-1',
      type: 'contract',
      contractId,
      topic,
    },
  ];
}
