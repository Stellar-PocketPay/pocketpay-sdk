import { TransactionSummary, TransactionDirection, TransactionStatus } from './transaction';
export * from './transaction';
export * from './balance';
export * from './auth';
export * from './simulation';
export * from './payment-intent';

/**
 * Stellar PocketPay SDK — Type Definitions
 *
 * All shared types, interfaces, and enums used across the SDK.
 */

// ─── Network ────────────────────────────────────────────────────────────────

/** Supported Stellar networks */
export type StellarNetwork = 'testnet' | 'mainnet';

/** Identifies where a configuration value was resolved from. */
export type ConfigSource = 'override' | 'env' | 'default';

/** Safe configuration source metadata representing origin of each setting. */
export interface ConfigSourceMetadata {
  network: ConfigSource;
  horizonUrl: ConfigSource;
  sorobanRpcUrl: ConfigSource;
  timeout: ConfigSource;
  contractId?: ConfigSource;
  featureFlags?: Record<string, ConfigSource>;
}

/** Known experimental feature flags in PocketPay SDK. */
export type FeatureFlagKey =
  | 'experimentalVault'
  | 'experimentalSorobanEvents'
  | 'experimentalMultiAssetVault'
  | 'experimentalAsyncSigner'
  | 'experimentalVaultLocks'
  | (string & {});

/** Map of feature flag keys to boolean enablement status. */
export type FeatureFlagsConfig = Record<string, boolean>;

/** SDK configuration options */
export interface SDKConfig {
  /** Network to connect to (default: "testnet") */
  network: StellarNetwork;
  /** Horizon server URL (auto-resolved if omitted) */
  horizonUrl: string;
  /** Soroban RPC URL (auto-resolved if omitted) */
  sorobanRpcUrl: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Soroban contract ID for vault operations (optional) */
  contractId?: string;
  /** Feature flags for experimental SDK capabilities (default: all disabled) */
  featureFlags?: FeatureFlagsConfig;
}

/** Fully resolved SDK configuration including feature flags and safe config source metadata. */
export interface ResolvedSDKConfig {
  network: StellarNetwork;
  horizonUrl: string;
  sorobanRpcUrl: string;
  timeout: number;
  contractId?: string;
  featureFlags: Record<string, boolean>;
  sources: ConfigSourceMetadata;
}

/** Severity assigned to a configuration validation issue. */
export type ConfigIssueSeverity = 'error' | 'warning';

/** A structured error or warning produced while validating SDK configuration. */
export interface ConfigValidationIssue {
  severity: ConfigIssueSeverity;
  field: keyof SDKConfig;
  code: string;
  message: string;
  value?: unknown;
}

/** Complete, non-throwing result returned by configuration validation. */
export interface ConfigValidationResult {
  valid: boolean;
  issues: ConfigValidationIssue[];
  errors: ConfigValidationIssue[];
  warnings: ConfigValidationIssue[];
  config?: ResolvedSDKConfig;
}

// ─── Wallet ─────────────────────────────────────────────────────────────────

/** A newly created or imported Stellar keypair */
export interface WalletKeypair {
  /** Stellar public key (G...) */
  publicKey: string;
  /** Stellar secret key (S...) — handle with extreme care */
  secretKey: string;
}

/** Balance entry for a single asset */
export interface AssetBalance {
  /** Asset code (e.g. "XLM", "USDC") */
  asset: string;
  /** Balance amount as a string (to preserve precision) */
  balance: string;
  /** Asset issuer public key (empty for native XLM) */
  issuer: string;
}

/** Full account balance response */
export interface AccountBalance {
  /** The queried public key */
  publicKey: string;
  /** Array of asset balances */
  balances: AssetBalance[];
  /** Native XLM balance (convenience shortcut) */
  nativeBalance: string;
}

// ─── Balance Result (discriminated union) ───────────────────────────────────

/**
 * Result of {@link getBalanceOrUnfunded} — a discriminated union on `status`.
 *
 * Use `result.status` to branch without try/catch:
 * - `"funded"` — the account exists on-chain; `balance` is populated.
 * - `"unfunded"` — Horizon returned 404; the account has never been funded.
 *
 * Any unexpected Horizon failure (5xx, network error, etc.) is still thrown
 * as a {@link PocketPayError} so genuine errors are never silently swallowed.
 *
 * @example
 * ```ts
 * const result = await getBalanceOrUnfunded(wallet.publicKey);
 * if (result.status === 'funded') {
 *   console.log('XLM balance:', result.balance.nativeBalance);
 * } else {
 *   // result.status === 'unfunded'
 *   console.log('Wallet not yet funded — call fundTestnetAccount()');
 * }
 * ```
 */
export type BalanceResult =
  | {
      /** Account exists and has been funded. */
      status: 'funded';
      /** The queried public key. */
      publicKey: string;
      /** Full account balance detail. */
      balance: AccountBalance;
    }
  | {
      /** Account does not exist on Horizon (never funded). */
      status: 'unfunded';
      /** The queried public key. */
      publicKey: string;
    };

// ─── Memo ───────────────────────────────────────────────────────────────────

/**
 * The memo types defined by the Stellar protocol.
 *
 *  - `none`   — no memo
 *  - `text`   — up to 28 **bytes** of UTF-8
 *  - `id`     — unsigned 64-bit integer
 *  - `hash`   — 32 bytes, supplied as 64 hex characters
 *  - `return` — 32 bytes, supplied as 64 hex characters
 */
export type MemoType = 'none' | 'text' | 'id' | 'hash' | 'return';

/**
 * A memo with an explicit type.
 *
 * Anywhere a memo is accepted you may pass a plain `string`, which is treated
 * as a `text` memo — the behaviour every caller had before typed memos existed.
 *
 * @example
 * ```ts
 * await sendXLM({ ...params, memo: 'invoice #42' });                  // text
 * await sendXLM({ ...params, memo: { type: 'id', value: '12345' } }); // id
 * ```
 */
export interface MemoInput {
  /** Which Stellar memo type to build. */
  type: MemoType;
  /**
   * The payload. Required for every type except `none`. `id` accepts a
   * decimal string, number, or bigint; `hash` and `return` take 64 hex chars.
   */
  value?: string | number | bigint;
}

// ─── Payments ───────────────────────────────────────────────────────────────

/** Parameters for sending an XLM payment */
export interface SendXLMParams {
  /** Secret key of the source account (S...) */
  sourceSecret: string;
  /** Public key of the destination account (G...) */
  destination: string;
  /** Amount of XLM to send (as string for precision, e.g. "10.5") */
  amount: string;
  /** Optional memo: text (max 28 bytes) or a typed {@link MemoInput} */
  memo?: string | MemoInput;
}

/**
 * Parameters for sending an issued asset (or native XLM) payment.
 *
 * This is the generalized form of {@link SendXLMParams} that adds an `asset`
 * field. Passing `{ code: 'XLM' }` (or `{ code: 'native' }`) is equivalent
 * to calling {@link sendXLM} — native XLM behaviour is fully preserved.
 *
 * For issued assets (e.g. USDC, EURT) the `asset.issuer` must be provided
 * and the destination account must hold an authorized trustline for the
 * asset before the payment can succeed.
 *
 * @example Native XLM (backwards-compatible path)
 * ```ts
 * await sendAsset({
 *   sourceSecret: wallet.secretKey,
 *   destination: receiverPublicKey,
 *   amount: '10',
 *   asset: { code: 'XLM' },
 * });
 * ```
 *
 * @example Issued asset (USDC)
 * ```ts
 * await sendAsset({
 *   sourceSecret: wallet.secretKey,
 *   destination: receiverPublicKey,
 *   amount: '50',
 *   asset: { code: 'USDC', issuer: usdcIssuerPublicKey },
 *   memo: 'invoice #42',
 * });
 * ```
 */
export interface SendAssetParams {
  /** Secret key of the source account (S...) */
  sourceSecret: string;
  /** Public key of the destination account (G...) */
  destination: string;
  /** Amount to send (as string for precision, e.g. "10.5") */
  amount: string;
  /**
   * Asset to send. Pass `{ code: 'XLM' }` for native XLM.
   * For issued assets supply both `code` and `issuer`.
   */
  asset: StellarAssetSpec;
  /** Optional memo: text (max 28 bytes) or a typed {@link MemoInput} */
  memo?: string | MemoInput;
  /**
   * When `true`, a preflight trustline check is run against Horizon before
   * building the transaction. Defaults to `true` for issued assets;
   * has no effect for native XLM (no trustline required).
   */
  skipTrustlineCheck?: boolean;
}

/** Parameters for previewing a payment without signing or submitting */
export interface PaymentPreviewParams {
  /** Public key of the source account (G...) */
  sourceAccount: string;
  /** Public key of the destination account (G...) */
  destination: string;
  /** Amount to send (as string for precision, e.g. "10.5") */
  amount: string;
  /**
   * Asset to send. Pass `{ code: 'XLM' }` for native XLM.
   * For issued assets supply both `code` and `issuer`.
   */
  asset?: StellarAssetSpec;
  /** Optional memo: text (max 28 bytes) or a typed {@link MemoInput} */
  memo?: string | MemoInput;
}

/** Typed preview of a payment */
export interface PaymentPreview {
  /** Source account public key */
  sourceAccount: string;
  /** Destination account public key */
  destination: string;
  /** Amount to be sent */
  amount: string;
  /** Asset to be sent */
  asset: StellarAssetSpec;
  /** Memo payload if provided, rendered as a string */
  memo?: string;
  /**
   * Type of the memo that will be attached. Mirrors `TransactionSummary.memoType`
   * on the read side, so previews and fetched transactions describe memos the
   * same way. Absent when there is no memo.
   */
  memoType?: MemoType;
  /** Network the payment will be on */
  network: string;
  /** Estimated base fee in stroops */
  estimatedFee: string;
}

/** Result of a successful payment */
export interface PaymentResult {
  /** Whether the transaction was successful */
  success: boolean;
  /** Transaction hash */
  hash: string;
  /** Ledger number the transaction was included in */
  ledger: number;
  /** Fee charged in stroops */
  fee: string;
  /** Source account public key */
  sourceAccount: string;
  /** Destination account public key */
  destinationAccount: string;
  /** Amount sent */
  amount: string;
  /** Timestamp of the transaction */
  createdAt: string;
  /**
   * Asset that was sent. Present for issued-asset payments; absent (undefined)
   * for native XLM payments produced by {@link sendXLM} for backward
   * compatibility. Payments produced by {@link sendAsset} always include this
   * field.
   */
  asset?: StellarAssetSpec;
}

// ─── Transactions ───────────────────────────────────────────────────────────

/**
 * @deprecated Use {@link TransactionSummary}. Retained as an alias for
 * backward compatibility with existing consumers.
 */
export type TransactionRecord = TransactionSummary;
/** A single payment summary — the SDK's stable typed model for one payment operation. */
export interface PaymentSummary {
  /** Operation ID */
  id: string;
  /** Transaction hash this operation belongs to */
  transactionHash: string;
  /** Operation type */
  type: string;
  /** ISO 8601 timestamp */
  createdAt: string;
  /** Source account */
  from: string;
  /** Destination account */
  to: string;
  /** Amount transferred */
  amount: string;
  /** Asset code */
  asset: string;
  /** Asset issuer (empty for native) */
  assetIssuer: string;
  /** Horizon paging token (cursor) for this record */
  pagingToken: string;
}
/**
 * @deprecated Use {@link PaymentSummary}. Retained as an alias for
 * backward compatibility with existing consumers.
 */
export type PaymentRecord = PaymentSummary;
/** Paginated transaction list */
export interface TransactionList {
  /** Array of transaction summaries */
  records: TransactionSummary[];
  /** Number of records returned */
  count: number;
  /** Paging token of the last record, for fetching the next page (undefined when empty) */
  nextCursor?: string;
}
/** Paginated payment list */
export interface PaymentList {
  /** Array of payment summaries */
  records: PaymentSummary[];
  /** Number of records returned */
  count: number;
  /** Paging token of the last record, for fetching the next page (undefined when empty) */
  nextCursor?: string;
}

// ─── Transaction Filtering ───────────────────────────────────────────────────

/**


/**
 * Structural shape shared by {@link TransactionSummary} and
 * {@link PaymentSummary} that the pure filtering helpers operate on.
 *
 * Every field except `createdAt` is optional so the same helper functions
 * work across both record types — including records that lack asset or
 * counterparty data (e.g. a raw {@link TransactionSummary} has no `asset`).
 */
export interface FilterableTransaction {
  /** ISO 8601 timestamp used for date-range filtering */
  createdAt: string;
  /** Present on transaction records; the tx source account */
  sourceAccount?: string;
  /** Present on payment records; the sending account */
  from?: string;
  /** Present on payment records; the receiving account */
  to?: string;
  /** Present on payment records; the asset code (e.g. "XLM", "USDC") */
  asset?: string;
  /** Present on payment records; the asset issuer (empty for native XLM) */
  assetIssuer?: string;
}

/** Sort direction supported by {@link sortTransactionsByDate}. */
export type TransactionSortOrder = 'newest' | 'oldest';

/**
 * Minimal transaction-like shape accepted by the date sorting helper.
 *
 * `createdAt` is optional because callers may be sorting partially populated
 * API records. Missing and invalid dates are retained at the end of the result.
 */
export interface SortableTransaction {
  /** Timestamp used for sorting, normally an ISO 8601 string. */
  createdAt?: string | Date | null;
}

/** Options for the combined {@link filterTransactions} helper. */
export interface FilterTransactionsOptions {
  /** Keep only records matching this direction relative to `account` */
  direction?: TransactionDirection;
  /**
   * Reference Stellar account (G...) used to resolve `direction` and
   * `counterparty`. Required for those two filters; ignored otherwise.
   */
  account?: string;
  /** Keep only records for this asset code (e.g. "XLM", "USDC"). */
  asset?: string;
  /** When filtering by asset, optionally scope to a specific issuer. */
  assetIssuer?: string;
  /** Keep only records created on or after this date (string or Date). */
  startDate?: string | Date;
  /** Keep only records created on or before this date (string or Date). */
  endDate?: string | Date;
  /** Keep only records whose counterparty equals this account (needs `account`). */
  counterparty?: string;
}

// ─── Transaction Polling ───────────────────────────────────────────────────

/** Status of a polled transaction */
export type TransactionPollStatus = 'success' | 'failure' | 'timeout' | 'unknown';

/** Configuration for polling a transaction */
export interface TransactionPollConfig {
  /** How often to poll in milliseconds (default: 2000) */
  interval?: number;
  /** Maximum time to wait in milliseconds (default: 30000) */
  timeout?: number;
}

/** Result of a transaction poll */
export interface TransactionPollResult {
  /** Final status of the transaction */
  status: TransactionPollStatus;
  /** Transaction hash */
  hash: string;
  /** Transaction record if it was found */
  transaction?: TransactionRecord;
  /** Error details if applicable */
  error?: string;
}

// ─── Soroban / Vault ────────────────────────────────────────────────────────

/** Parameters for a vault deposit */
export interface VaultDepositParams {
  /** Secret key of the depositor */
  sourceSecret: string;
  /** Amount to deposit (as string) */
  amount: string;
  /** Vault contract ID */
  contractId: string;
}

/** Parameters for a vault withdrawal */
export interface VaultWithdrawParams {
  /** Secret key of the withdrawer */
  sourceSecret: string;
  /** Amount to withdraw (as string) */
  amount: string;
  /** Vault contract ID */
  contractId: string;
}

/** Vault operation result */
export interface VaultResult {
  /** Whether the operation succeeded */
  success: boolean;
  /** Transaction hash (if submitted on-chain) */
  hash?: string;
  /** Resulting balance after operation */
  balance?: string;
  /** Error message if failed */
  error?: string;
}

/** Vault balance query params */
export interface VaultBalanceParams {
  /** Public key of the user */
  publicKey: string;
  /** Vault contract ID */
  contractId: string;
}

/** High-level invocation status for Soroban operations */
export type SorobanInvocationStatus =
  | 'success'
  | 'failed'
  | 'simulation_error'
  | 'error'
  | 'pending';

/** Parameters for configuring Soroban invocation result mapping */
export interface SorobanInvocationMapperOptions {
  /** Operation name (e.g. "deposit", "withdraw", "get_balance") */
  operation?: string;
  /** Contract ID associated with the invocation */
  contractId?: string;
  /** Optional requested amount string for context */
  amount?: string;
}

/** Stable typed SDK value for Soroban contract invocation results */
export interface SorobanInvocationResult<T = unknown> {
  /** High-level indicator of success */
  success: boolean;
  /** Invocation execution status */
  status: SorobanInvocationStatus;
  /** Parsed contract return value or typed output */
  result?: T;
  /** Human-readable error description when success is false */
  error?: string;
  /** Numeric or string error code from contract or RPC if available */
  errorCode?: string | number;
  /** On-chain transaction hash if transaction was submitted */
  hash?: string;
  /** Raw RPC response object preserved for advanced inspection */
  rawResponse?: unknown;
}

/** Specific operation types supported by vault mapping */
export type VaultOperationType = 'deposit' | 'withdraw' | 'get_balance';

/** Structured, typed result representation for vault operations */
export interface VaultMappedResult {
  /** Whether the vault operation succeeded */
  success: boolean;
  /** Execution status classification */
  status: SorobanInvocationStatus;
  /** Type of vault operation */
  operation: VaultOperationType;
  /** Transaction hash if submitted on-chain */
  hash?: string;
  /** Balance in XLM (for get_balance or post-op balance) */
  balance?: string;
  /** Raw balance in stroops / sub-units */
  rawStroops?: string;
  /** Amount processed in XLM for deposit / withdraw */
  amount?: string;
  /** Formatted error message on failure */
  error?: string;
  /** Classified error code on failure */
  errorCode?: string | number;
}


// ─── Friendbot / Funding ────────────────────────────────────────────────────

/**
 * Result of funding a testnet account via Friendbot.
 *
 * @remarks **Testnet only.** Friendbot is not available on Stellar mainnet.
 *
 * @example
 * ```ts
 * const result = await fundTestnetAccount(wallet.publicKey);
 * if (result.success) {
 *   console.log('Funded!', result.hash, 'ledger:', result.ledger);
 * }
 * ```
 */
export interface FundResult {
  /** Whether the funding request was successful */
  success: boolean;

  /**
   * The Stellar public key (G...) that was funded.
   * Always present, mirrors the input public key for easy destructuring.
   */
  publicKey: string;

  /**
   * Transaction hash of the Friendbot funding transaction.
   * Present on success; used to look up the transaction on a block explorer.
   */
  hash?: string | undefined;

  /**
   * Friendbot's internal operation/record ID.
   * Useful as a fallback identifier when `hash` is not available.
   */
  friendbotId?: string | undefined;

  /**
   * Ledger sequence number the funding transaction was included in.
   * Present on success.
   */
  ledger?: number | undefined;

  /**
   * ISO 8601 timestamp of when the funding transaction was created.
   * Present on success.
   */
  createdAt?: string | undefined;

  /**
   * Fee charged by the Friendbot transaction (in stroops).
   * Present on success.
   */
  feeCharged?: string | undefined;

  /**
   * The Friendbot's own source account public key.
   * Present on success; useful for audit purposes.
   */
  friendbotAccount?: string | undefined;

  /**
   * Human-readable error message when `success` is `false`.
   * Contains the Friendbot HTTP status and response body on HTTP errors.
   */
  error?: string | undefined;
}

// ─── Result Wrappers ────────────────────────────────────────────────────────

/**
 * A typed success result. Returned by safe wrapper functions when an
 * operation completes without throwing.
 *
 * @typeParam T - The value type on success
 *
 * @example
 * ```ts
 * const result = await safeGetBalance(publicKey);
 * if (result.ok) {
 *   console.log(result.value.nativeBalance);
 * }
 * ```
 */
export interface SuccessResult<T> {
  /** Always `true` — use this to narrow to `SuccessResult<T>` */
  ok: true;
  /** The successful return value */
  value: T;
}

/**
 * A typed failure result. Returned by safe wrapper functions when an
 * operation throws. The original `PocketPayError` is always preserved.
 *
 * @example
 * ```ts
 * const result = await safeGetBalance(publicKey);
 * if (!result.ok) {
 *   console.error(result.error.code, result.error.message);
 * }
 * ```
 */
export interface FailureResult {
  /** Always `false` — use this to narrow to `FailureResult` */
  ok: false;
  /** The `PocketPayError` that caused the failure */
  error: PocketPayError;
}

/**
 * A discriminated union of {@link SuccessResult} and {@link FailureResult}.
 *
 * Check the `ok` property to narrow to the correct variant:
 * - `ok === true`  → `SuccessResult<T>` — access `.value`
 * - `ok === false` → `FailureResult`    — access `.error`
 *
 * @typeParam T - The value type on success
 *
 * @example
 * ```ts
 * const result: PocketPayResult<AccountBalance> = await safeGetBalance(key);
 * if (result.ok) {
 *   console.log(result.value.nativeBalance);
 * } else {
 *   console.error(result.error.code);
 * }
 * ```
 */
export type PocketPayResult<T> = SuccessResult<T> | FailureResult;

// ─── Errors ─────────────────────────────────────────────────────────────────

/** Metadata for validation errors to identify the field and reason */
export interface ValidationMetadata {
  /** The input field that failed validation (e.g., 'publicKey', 'amount') */
  field: string;
  /** The reason validation failed (e.g., 'invalid_format', 'too_long') */
  reason: string;
  /** Optional: The value that was provided (never include secrets!) */
  value?: string | number | undefined;
}

/**
 * Lifecycle stage at which an SDK timeout elapsed.
 *
 *  - `preparation`  — reading account state or simulating; nothing was sent.
 *  - `submission`   — the transaction may or may not have reached the network.
 *  - `confirmation` — it was sent; its final status is still unknown.
 *  - `unknown`      — the stage could not be determined.
 *
 * `submission` and `confirmation` leave the outcome undetermined, so they are
 * reported as `TX_STATUS_UNKNOWN` rather than a retryable timeout.
 */
export type TimeoutStage = 'preparation' | 'submission' | 'confirmation' | 'unknown';

/** Context describing where and when a timeout elapsed. */
export interface TimeoutMetadata {
  /** Lifecycle stage the timeout interrupted. */
  stage: TimeoutStage;
  /** The operation label passed to `withTimeout`. */
  operation: string;
  /** The timeout budget that elapsed, in milliseconds. */
  timeoutMs: number;
}

/** Custom SDK error with additional context */
export class PocketPayError extends Error {
  /** Machine-readable error code */
  public readonly code: string;
  /** HTTP status code (if applicable) */
  public readonly statusCode?: number | undefined;
  /** Original error that caused this error */
  public readonly cause?: Error | undefined;
  /** Validation metadata (if this is a validation error) */
  public readonly validation?: ValidationMetadata | undefined;
  /** Transaction hash (if associated with a transaction) */
  public readonly transactionHash?: string | undefined;
  /** Whether the operation is safe to retry */
  public readonly retryable?: boolean | undefined;
  /**
   * High-level error category (Wallet / Payment / Transaction / Network /
   * Soroban / Vault / SDK). Added for the public error taxonomy standard;
   * optional for backwards compatibility.
   */
  public readonly category?: string | undefined;
  /**
   * User-safe summary that never contains secrets. Added for the public error
   * taxonomy standard; optional — falls back to `message` when absent.
   */
  public readonly safeMessage?: string | undefined;
  /**
   * Where a timeout elapsed, when this error is one. Lets consumers pick a
   * recovery action without parsing the message.
   */
  public readonly timeout?: TimeoutMetadata | undefined;

  constructor(
    message: string,
    code: string,
    arg3?: number | {
      statusCode?: number;
      cause?: Error;
      validation?: ValidationMetadata;
      category?: string;
      safeMessage?: string;
      timeout?: TimeoutMetadata;
    },
    arg4?: Error | string,
    arg5?: string | boolean,
    arg6?: boolean,
    arg7?: { category?: string; safeMessage?: string }
  ) {
    super(message);
    this.name = 'PocketPayError';
    this.code = code;

    if (typeof arg3 === 'object' && arg3 !== null) {
      this.statusCode = arg3.statusCode;
      this.cause = arg3.cause;
      this.validation = arg3.validation;
      this.category = arg3.category;
      this.safeMessage = arg3.safeMessage;
      this.timeout = arg3.timeout;
    } else {
      this.statusCode = arg3 as number | undefined;
      if (typeof arg4 === 'object') {
        this.cause = arg4 as Error;
      }
    }

    if (typeof arg4 === 'string') {
      this.transactionHash = arg4;
      this.retryable = typeof arg5 === 'boolean' ? arg5 : false;
    } else if (typeof arg5 === 'string') {
      this.transactionHash = arg5;
      this.retryable = typeof arg6 === 'boolean' ? arg6 : false;
    } else if (typeof arg5 === 'boolean') {
      this.retryable = arg5;
    }

    // Allow callers to pass an explicit taxonomy object as the final arg.
    if (arg7) {
      if (arg7.category) this.category = arg7.category;
      if (arg7.safeMessage) this.safeMessage = arg7.safeMessage;
    }

    Object.setPrototypeOf(this, PocketPayError.prototype);
  }
}

/** Options for cursor-based pagination on list queries. */
export interface PaginationOptions {
  /** Max records to return (default: 10) */
  limit?: number;
  /** Sort order by ledger time (default: "desc") */
  order?: 'asc' | 'desc';
  /** Horizon paging token to start after (for fetching the next page) */
  cursor?: string;
}


// ─── Result Warning & Recovery Hint ─────────────────────────────────────────

/**
 * A non-fatal warning attached to a successful or failed result.
 */
export interface ResultWarning {
  /** Machine-readable warning code */
  code: string;
  /** Human-readable description */
  message: string;
  /** Optional structured metadata */
  metadata?: Record<string, unknown>;
}

/**
 * An actionable suggestion for mitigation or recovery.
 */
export interface RecoveryHint {
  /** Well-known action string */
  action: string;
  /** Human-readable description */
  message: string;
  /** Whether the operation is safe to retry automatically */
  retryable?: boolean;
  /** Suggested delay in milliseconds before retrying */
  suggestedDelayMs?: number;
  /** Optional structured metadata */
  metadata?: Record<string, unknown>;
}

// ─── Enhanced Result Wrappers ───────────────────────────────────────────────

export interface EnhancedSuccessResult<T> {
  ok: true;
  value: T;
  warnings?: ResultWarning[];
  recoveryHints?: RecoveryHint[];
}

export interface EnhancedFailureResult {
  ok: false;
  error: PocketPayError;
  warnings?: ResultWarning[];
  recoveryHints?: RecoveryHint[];
}

export type EnhancedPocketPayResult<T> = EnhancedSuccessResult<T> | EnhancedFailureResult;

// ─── Trustline Validation ───────────────────────────────────────────────────

/**
 * Specification of a Stellar asset (Native XLM or an issued asset).
 *
 * For native XLM: `code` is `"XLM"` or `"native"`, `issuer` is omitted or empty.
 * For issued assets: `code` is 1-12 alphanumeric characters, `issuer` is the Stellar public key (G...).
 */
export interface StellarAssetSpec {
  /** Asset code (e.g. "XLM", "USDC", "EURT") */
  code: string;
  /** Stellar public key (G...) of the asset issuer (empty/omitted for native XLM) */
  issuer?: string | undefined;
}

/** Status discriminant for trustline verification results. */
export type TrustlineStatus =
  | 'valid'               // Destination can receive the payment
  | 'native_xlm'          // Native XLM requires no trustline check
  | 'missing_trustline'   // Destination account has no trustline for this asset
  | 'not_authorized'      // Trustline exists but issuer authorization is lacking
  | 'limit_exceeded'      // Payment amount exceeds remaining trustline capacity
  | 'account_not_found';  // Destination account does not exist / unfunded

/**
 * Result of a destination trustline verification check.
 */
export interface TrustlineCheckResult {
  /** Whether the destination account is ready to receive the issued asset payment */
  valid: boolean;
  /** Granular status code indicating the trustline validation outcome */
  status: TrustlineStatus;
  /** Destination Stellar public key (G...) */
  destination: string;
  /** The asset specification evaluated */
  asset: StellarAssetSpec;
  /** Current balance held by destination for this asset (if trustline exists) */
  currentBalance?: string;
  /** Maximum trustline limit configured by destination (if trustline exists) */
  limit?: string;
  /** Remaining capacity (`limit - currentBalance`) for this asset (if trustline exists) */
  availableCapacity?: string;
  /** Whether the trustline is authorized by the issuer (if issuer requires auth) */
  isAuthorized?: boolean;
  /** Machine-readable error code if `valid` is `false` */
  errorCode?: string;
  /** Human-readable explanation of the validation result */
  message?: string;
}

/** Options for trustline verification checks */
export interface TrustlineCheckOptions {
  /** Optional payment amount (as decimal string) to test against trustline capacity */
  amount?: string;
  /** Optional SDK config overrides */
  config?: Partial<SDKConfig>;
}

// ─── Retry Policy ────────────────────────────────────────────────────────────

/**
 * The classified outcome of a single transaction submission attempt.
 *
 * Use the `kind` discriminant to branch:
 *
 * - `"success"` — the transaction was accepted and confirmed on-chain.
 * - `"retryable_failure"` — the failure is transient (e.g. rate-limit, transient
 *   network glitch). It is safe to submit the **same signed transaction** again.
 * - `"non_retryable_failure"` — the transaction was definitively rejected
 *   (e.g. bad sequence number, insufficient balance). Retrying the same envelope
 *   will always fail. A new transaction must be built.
 * - `"unknown_status"` — a timeout or network error means we cannot tell whether
 *   the transaction reached validators. The transaction **must not** be blindly
 *   resubmitted; call {@link pollTransactionStatus} first or wait for
 *   {@link withRetryPolicy} to poll automatically.
 *
 * @example
 * ```ts
 * const outcome = classifySubmissionOutcome(error);
 * switch (outcome.kind) {
 *   case 'success':            // handle success
 *   case 'retryable_failure':  // safe to resubmit same envelope
 *   case 'non_retryable_failure': // rebuild transaction
 *   case 'unknown_status':     // poll before deciding
 * }
 * ```
 */
export type SubmissionOutcome =
  | {
      /** Transaction accepted and confirmed by Stellar validators. */
      kind: 'success';
      /** Transaction hash returned by Horizon. */
      transactionHash: string;
    }
  | {
      /**
       * Transient failure — the same signed envelope may be resubmitted.
       *
       * On a transaction submission, only a definite pre-processing
       * rejection (such as HTTP 429) permits an immediate same-envelope retry.
       * HTTP 408/5xx and transport interruption require hash polling first.
       */
      kind: 'retryable_failure';
      /** The underlying SDK error. */
      error: PocketPayError;
      /**
       * Minimum suggested delay in milliseconds before the next attempt.
       * Derived from the error type; callers may apply additional jitter.
       */
      suggestedDelayMs: number;
    }
  | {
      /**
       * Definitive on-chain rejection — the same envelope will always fail.
       *
       * Causes include: `tx_bad_seq`, `tx_insufficient_balance`, `tx_bad_auth`,
       * and other Horizon result codes that indicate permanent failure.
       * A new transaction (new sequence number, re-signed) must be built.
       */
      kind: 'non_retryable_failure';
      /** The underlying SDK error containing Horizon result codes. */
      error: PocketPayError;
    }
  | {
      /**
       * Unknown outcome — the submission timed out or the network was
       * interrupted before a definitive response arrived.
       *
       * **Do not blindly resubmit.** The transaction may have been accepted
       * by validators already. Use {@link pollTransactionStatus} (or
       * {@link withRetryPolicy} which does this automatically) to determine
       * the real state before taking further action.
       */
      kind: 'unknown_status';
      /** The underlying SDK error (`code === 'TX_STATUS_UNKNOWN'`). */
      error: PocketPayError;
      /**
       * The transaction hash to poll on Horizon.
       * Defined whenever the hash was available at the time of submission.
       */
      transactionHash?: string;
    };

/**
 * Configuration for {@link withRetryPolicy}.
 *
 * Controls how many times the SDK will retry a submission and how long it
 * waits between attempts. Only {@link SubmissionOutcome | retryable_failure}
 * outcomes trigger a retry. `unknown_status` outcomes are resolved via
 * status polling rather than blind resubmission.
 *
 * @example
 * ```ts
 * const policy: RetryPolicy = {
 *   maxAttempts: 4,
 *   initialBackoffMs: 1_000,
 *   maxBackoffMs: 16_000,
 *   backoffMultiplier: 2,
 *   jitter: true,
 * };
 * const result = await withRetryPolicy(transaction, policy);
 * ```
 */
export interface RetryPolicy {
  /**
   * Total number of submission attempts, including the first.
   *
   * Must be ≥ 1. A value of 1 means "try once with no retries".
   * @default 4
   */
  maxAttempts: number;

  /**
   * Delay before the second attempt in milliseconds.
   *
   * Each subsequent attempt doubles this value (capped at `maxBackoffMs`).
   * @default 1000
   */
  initialBackoffMs: number;

  /**
   * Upper bound on the inter-attempt delay in milliseconds.
   * @default 16000
   */
  maxBackoffMs: number;

  /**
   * Multiplier applied to the delay on each retry.
   * @default 2
   */
  backoffMultiplier: number;

  /**
   * When `true`, adds a random fraction of the computed delay to reduce
   * thundering-herd effects when many clients retry simultaneously.
   * @default true
   */
  jitter: boolean;

  /**
   * Optional SDK config overrides forwarded to the underlying Horizon calls.
   */
  config?: Partial<SDKConfig>;

  /**
   * Optional callback invoked after each failed attempt.
   *
   * Useful for logging, metrics, or UI feedback.
   *
   * @param attempt - 1-based index of the attempt that just failed.
   * @param outcome - The classified outcome of this attempt.
   * @param delayMs - How long the policy will wait before the next attempt
   *   (0 if this was the last allowed attempt).
   */
  onAttempt?: (attempt: number, outcome: SubmissionOutcome, delayMs: number) => void;
}

/**
 * Result returned by {@link withRetryPolicy} when all attempts have been
 * exhausted without an unambiguous success.
 *
 * The `finalOutcome` tells callers why the policy gave up:
 * - `"non_retryable_failure"` — rejected on-chain; rebuild required.
 * - `"unknown_status"` — polling could not confirm status; manual check needed.
 * - `"retryable_failure"` — retries were exhausted; transient error persisted.
 */
export interface RetryPolicyExhaustedResult {
  /** Always `false` — the submission was not confirmed. */
  success: false;
  /** The outcome kind that caused the policy to give up. */
  finalOutcome: Exclude<SubmissionOutcome['kind'], 'success'>;
  /** The last error received. */
  error: PocketPayError;
  /** Number of attempts made. */
  attempts: number;
}
export * from './asset';
export * from './receipt';
export * from './lifecycle';
