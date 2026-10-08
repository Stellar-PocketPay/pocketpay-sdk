/**
 * Stellar PocketPay SDK — Vault Module
 *
 * Dedicated vault module providing helpers and result mappers for Soroban savings vault interactions.
 * 
 * @security See the [SDK Security Threat Model](../../docs/security_threat_model.md)
 * for risks related to contract ID spoofing and malicious payload injection.
 */

export {
  depositToVault,
  withdrawFromVault,
  getVaultBalance,
  executeExperimentalVaultBatch,
  querySorobanEvents,
  mapSorobanInvocationResult,
  mapVaultInvocationResult,
  mapSorobanContractError,
} from '../soroban';

// ─── Capability model and action intents (issue #274) ───────────────────────
export {
  executeVaultIntent,
  validateVaultIntent,
  describeVaultReadiness,
  isVaultActionSupported,
  listSupportedVaultActions,
  VAULT_ACTION_READINESS,
  VAULT_LOCKS_FEATURE_FLAG,
} from './intents';

export type {
  VaultActionKind,
  VaultActionIntent,
  VaultActionReadiness,
} from './intents';

export type {
  VaultDepositParams,
  VaultWithdrawParams,
  VaultBalanceParams,
  VaultResult,
  VaultMappedResult,
  VaultOperationType,
  SorobanInvocationStatus,
  SorobanInvocationResult,
  SorobanInvocationMapperOptions,
} from '../types';

export { buildVaultOperationPreview } from './preview';

export type {
  VaultPreviewAction,
  VaultOperationPreviewParams,
  VaultOperationPreview,
} from './preview';
