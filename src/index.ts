/**
 * Stellar PocketPay SDK
 *
 * Reusable TypeScript helper package for Stellar PocketPay and other Stellar Testnet apps.
 *
 * @packageDocumentation
 */

import * as dotenv from 'dotenv';
dotenv.config();

// ─── Types ──────────────────────────────────────────────────────────────────
export type {
  StellarNetwork,
  SDKConfig,
  ResolvedSDKConfig,
  ConfigSource,
  ConfigSourceMetadata,
  FeatureFlagKey,
  FeatureFlagsConfig,
  ConfigIssueSeverity,
  ConfigValidationIssue,
  ConfigValidationResult,
  WalletKeypair,
  AssetBalance,
  AccountBalance,
  BalanceResult,
  MemoType,
  MemoInput,
  TimeoutStage,
  TimeoutMetadata,
  SendXLMParams,
  SendAssetParams,
  PaymentPreviewParams,
  PaymentPreview,
  PaymentResult,
  TransactionSummary,
  TransactionRecord,
  TransactionList,
  FilterableTransaction,
  FilterTransactionsOptions,
  SortableTransaction,
  TransactionSortOrder,
  PaymentSummary,
  PaymentRecord,
  PaymentList,
  VaultDepositParams,
  VaultWithdrawParams,
  VaultBalanceParams,
  VaultResult,
  VaultMappedResult,
  VaultOperationType,
  SorobanInvocationStatus,
  SorobanInvocationResult,
  SorobanInvocationMapperOptions,
  FundResult,
  SuccessResult,
  FailureResult,
  PocketPayResult,
  EnhancedSuccessResult,
  EnhancedFailureResult,
  EnhancedPocketPayResult,
  StellarAssetSpec,
  TrustlineStatus,
  TrustlineCheckResult,
  TrustlineCheckOptions,
  // ─── Typed Asset Model ─────────────────────────────────────────────────────
  Asset,
  NativeAsset,
  IssuedAsset,
  AssetValidationResult,
  // ─── Multi-Asset Balance Model ──────────────────────────────────────────────
  AssetBalanceState,
  AccountBalanceState,
  NativeAssetBalanceItem,
  IssuedAssetBalanceItem,
  UnknownAssetBalanceItem,
  AssetBalanceItem,
  MultiAssetBalance,
  MultiAssetBalanceResult,
  // ─── Retry Policy ──────────────────────────────────────────────────────────
  SubmissionOutcome,
  RetryPolicy,
  RetryPolicyExhaustedResult,
  FeeEstimate,
} from './types';


export {
  PocketPayError,
  TransactionDirection,
  TransactionStatus,
  // ─── Typed Asset Model Exports ─────────────────────────────────────────────
  NATIVE_ASSET,
  isNativeAsset,
  isIssuedAsset,
  validateAsset,
  assertValidAsset,
} from './types';

// ─── Error Enrichment Types ────────────────────────────────────────────────
export type { ResultWarning, RecoveryHint } from './errors';

// ─── Transaction authorisation requirements (issue #248) ────────────────────
export {
  inspectSignedTransaction,
  safeInspectSignedTransaction,
  matchSignersByHint,
  mapAuthRequirements,
  identifyPresentSigners,
  assertAuthFullyMapped,
  toAuthAccountState,
} from './transactions';

export type {
  SignedTransactionSummary,
  OperationSummary,
  SignatureSummary,
  InspectableTransaction,
} from './transactions';

export type {
  AuthRequirement,
  AuthRequirementSummary,
  AuthRequirementKind,
  AuthThresholdLevel,
  AuthSigner,
  AuthAccountState,
} from './types';

// ─── Account sequence safety ────────────────────────────────────────────────
export {
  SequenceProvider,
  defaultSequenceProvider,
  validateSequenceValue,
  isSequenceStale,
  DEFAULT_SEQUENCE_MAX_AGE_MS,
} from './account';

export type { SequenceSnapshot, SequenceProviderOptions } from './account';

// ─── Wallet ─────────────────────────────────────────────────────────────────
export {
  createWallet,
  importWallet,
  safeImportWallet,
  enhancedImportWallet,
  safeEnhancedImportWallet,
  getPublicKey,
  getBalance,
  getBalanceOrUnfunded,
  fundTestnetAccount,
  safeGetBalance,
  safeFundTestnetAccount,
  enhancedGetBalance,
  safeEnhancedGetBalance,
  // Multi-Asset Balance
  calculateNativeReserves,
  parseMultiAssetBalance,
  getMultiAssetBalance,
  safeGetMultiAssetBalance,
  formatAssetBalanceDisplay,
  findAssetInMultiBalance,
} from './wallet';

// ─── Payments ───────────────────────────────────────────────────────────────
export {
  sendXLM,
  safeSendXLM,
  enhancedSendXLM,
  safeEnhancedSendXLM,
  sendAsset,
  safeSendAsset,
  previewPayment,
  validateAssetSpec,
  checkDestinationTrustline,
  safeCheckDestinationTrustline,
  verifyPaymentTrustlineOrThrow,
  validateSendXLMParams,
  buildPaymentReceipt,
  buildReceiptFromSubmission,
  buildReceiptFromSoroban,
  createPaymentIntent,
  validatePaymentIntent,
  evaluateAssetState,
  checkPaymentIntentTrustline,
} from './payments';

export type {
  ValidationError,
  ValidationErrorCode,
  ValidationErrorField,
  SendXLMValidationResult,
} from './payments';

export type { PaymentReceiptOptions } from './payments';

export type {
  PaymentReceipt,
  ReceiptFailure,
  ReceiptSource,
  ReceiptAction,
} from './types';

// ─── Transaction lifecycle orchestrator (issue #305) ─────────────────────────
export {
  submitGuarded,
  reconcileSubmission,
  requiresStatusResolution,
} from './transactions';

export type { GuardedSubmitOptions, SubmittableTransaction } from './transactions';

export type {
  LifecycleStage,
  LifecycleState,
  LifecycleResult,
  LifecycleFailure,
} from './types';

// ─── Transaction build validation pipeline (issue #249) ─────────────────────
export {
  validateTransactionBuild,
  assertTransactionBuildValid,
  VALIDATION_ORDER,
} from './transactions';

export type {
  ValidationStage,
  TransactionValidationIssue,
  TransactionValidationResult,
  TransactionBuildInput,
  TransactionValidationOptions,
} from './transactions';

// ─── Transactions ───────────────────────────────────────────────────────────
export {
  getTransactions,
  getPayments,
  filterTransactions,
  filterByDirection,
  filterByAsset,
  filterByDateRange,
  filterByCounterparty,
  sortTransactionsByDate,
  safeGetTransactions,
  safeGetPayments,
  // ─── Transaction Fixtures ──────────────────────────────────────────────────
  successfulPaymentSummary,
  failedPaymentSummary,
  pendingTransactionSummary,
  unknownTransactionSummary,
  transactionSummaryFixtures,
} from './transactions';

// ─── Offline Transaction Preparation (armado → firma → submit) ─────────────
export {
  prepareTransactionOffline,
  fetchNetworkState,
  updateWithNetworkState,
  buildUnsignedTransaction,
  signTransaction,
  signTransactionWithSigner,
  // Capability-checked signing entry point: verifies the AccountAbstraction
  // can sign, and that it matches the transaction's source account, before
  // ever calling into the signer.
  signWithAccount,
  submitSignedTransaction,
  prepareAndSignTransaction,
  prepareTransactionWithManualSequence,
  safeFetchNetworkState,
  safeSignWithAccount,
  safeSubmitSignedTransaction,
  safePrepareAndSignTransaction,
} from './transactions';
export type {
  OfflinePaymentOperation,
  OfflineTransactionParams,
  NetworkState,
  PreparedTransaction,
  UnsignedTransaction,
  SignedTransaction,
  SubmissionResult,
} from './transactions';

// ─── Soroban Vault ──────────────────────────────────────────────────────────
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
} from './soroban';
export {
  depositToVault,
  withdrawFromVault,
  getVaultBalance,
  executeExperimentalVaultBatch,
  querySorobanEvents,
  mapSorobanInvocationResult,
  mapVaultInvocationResult,
  mapSorobanContractError,
  mapSimulationResult,
  pocketPayErrorFromSimulation,
  simulationStatusToInvocationStatus,
  simulateContractCall,
} from './soroban';
export type {
  MapSimulationResultOptions,
} from './soroban';

// ─── Vault capability model and action intents (issue #274) ─────────────────
export {
  executeVaultIntent,
  validateVaultIntent,
  describeVaultReadiness,
  isVaultActionSupported,
  listSupportedVaultActions,
  VAULT_ACTION_READINESS,
  VAULT_LOCKS_FEATURE_FLAG,
} from './vault';

export type {
  VaultActionKind,
  VaultActionIntent,
  VaultActionReadiness,
} from './vault';

// ─── Network & Idempotency ──────────────────────────────────────────────────
export {
  submitTransactionIdempotently,
  pollTransactionStatus,
  withRetryPolicy,
  fetchFeeEstimate,
  // Network resilience layer (issue #272)
  NetworkClient,
  withTimeout,
  fetchWithTimeout,
  executeHorizonOperation,
  executeSorobanOperation,
  checkEndpointReachability,
} from './network';

export type { EndpointReachability } from './network';

// ─── Errors ─────────────────────────────────────────────────────────────────
export {
  classifySubmitError,
  isRetryableError,
  isUnknownStatusError,
  // Sequence safety (issue #277)
  requiresRebuild,
  classifySubmissionOutcome,
  isSafeToRetry,
  requiresStatusCheck,
  // Public error code & taxonomy standard (issue #260)
  ErrorCategory,
  ErrorCode,
  ERROR_CODES,
  isKnownErrorCode,
  describeError,
  getErrorCategory,
  redactError,
  isRetryableCode,
  // Unsupported feature & capability error standard
  UnsupportedFeatureError,
  CapabilityMismatchError,
  DisabledFeatureError,
  isUnsupportedFeatureError,
  isCapabilityMismatchError,
  isDisabledFeatureError,
  SDK_CAPABILITIES,
  getCapability,
  listCapabilities,
  assertCapability,
} from './errors';

// ─── Diagnostics (opt-in, redacted) ─────────────────────────────────────────
export type {
  DiagnosticsDomain,
  DiagnosticsHooks,
  EnableDiagnosticsOptions,
  SafeConfigSnapshot,
  SafeNetworkSnapshot,
  CapabilityDiagnosticsEntry,
  WalletCapabilitySnapshot,
  VaultReadinessSnapshot,
  DiagnosticsReport,
  DiagnosticsEvent,
  DiagnosticsSensitiveKey,
  EndpointDiagnostics,
} from './diagnostics';

export {
  DIAGNOSTICS_SENSITIVE_KEYS,
  DIAGNOSTICS_REDACTED_PLACEHOLDER,
  redactDiagnosticsValue,
  redactDiagnosticsString,
  isDiagnosticsSensitiveKey,
  enableDiagnostics,
  disableDiagnostics,
  setDiagnosticsHooks,
  resetDiagnosticsHooks,
  isDiagnosticsEnabled,
  getDiagnosticsHooks,
  emitDiagnosticsEvent,
  buildDiagnosticsReport,
  probeConfiguredEndpoints,
} from './diagnostics';

export type {
  FeatureContext,
  UnsupportedFeatureOptions,
  CapabilityMismatchOptions,
  DisabledFeatureOptions,
  CapabilityStatus,
  CapabilitySpec,
} from './errors';

// ─── Config ─────────────────────────────────────────────────────────────────
export {
  resolveConfig,
  validatePocketPayConfig,
  DEFAULT_FEATURE_FLAGS,
  resolveFeatureFlags,
  isFeatureEnabled,
  assertFeatureEnabled,
  getHorizonServer,
  setHorizonServerFactory,
  resetHorizonServerFactory,
  getNetworkPassphrase,
  getFriendbotUrl,
  validateNetwork,
  validateHorizonUrl,
  validateSorobanRpcUrl,
  validateTimeout,
  validateContractId,
} from './config';

// ─── Account Abstraction ─────────────────────────────────────────────────────
export type {
  AccountIdentity,
  Signer,
  ExternalSignerAdapter,
  LocalSignerConfig,
  AccountAbstraction,
  ReadOnlyAccount,
  SigningAccount,
} from './account';

export {
  LocalSigner,
  createLocalSigner,
  createReadOnlyAccount,
  createLocalAccount,
  createAccountWithSigner,
  // Capability check: type guard narrowing AccountAbstraction to SigningAccount
  canSignTransaction,
} from './account';

// ─── Utils ──────────────────────────────────────────────────────────────────
export {
  validatePublicKey,
  validateSecretKey,
  validateAmount,
  validateMemo,
  // Typed memo validation (issue #240)
  validateMemoInput,
  safeValidateMemo,
  normalizeMemo,
  buildMemo,
  MEMO_TEXT_MAX_BYTES,
  MEMO_HASH_HEX_LENGTH,
  MEMO_ID_MAX,
  SUPPORTED_MEMO_TYPES,
  validateTransactionHash,
  stroopsToXLM,
  xlmToStroops,
  // Safe amount model (issue #270)
  SafeAmount,
  parseAmount,
  parsePositiveAmount,
  safeParseAmount,
  fromStroops,
  toStroops,
  formatStroops,
  STROOPS_PER_UNIT,
  AMOUNT_DECIMALS,
  MAX_STROOPS,
  truncateAddress,
  // Explorer Links
  getAccountExplorerLink,
  getTransactionExplorerLink,
  getOperationExplorerLink,
  // Redaction
  redactSecretKey,
  redactSensitiveValue,
  // Result helpers
  toSuccessResult,
  toFailureResult,
  toResult,
  toEnhancedSuccessResult,
  toEnhancedFailureResult,
  toEnhancedResult,
  // Asset helpers
  findAssetBalance,
  formatAsset,
  parseAssetString,
  areAssetsEqual,
  // Balance display normalisation (issue #447)
  normalizeBalanceDisplay,
  formatBalanceDisplay,
  formatBalanceAssetLabel,
  // Security helpers
  redactSensitive,
} from './utils';


export type {
  BalanceDisplayStatus,
  BalanceDisplayReason,
  BalanceDisplayOptions,
  BalanceDisplayInput,
  NormalizedBalanceDisplay,
} from './utils';
