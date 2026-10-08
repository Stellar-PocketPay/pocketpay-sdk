/**
 * Stellar PocketPay SDK — Offline Transaction Preparation
 *
 * Provides support for preparing transactions offline before signing and later submission.
 * This module defines what can be prepared without network access and what requires
 * network state, enabling workflows where transaction preparation and signing happen
 * separately from submission.
 *
 * Offline Preparation Model
 * ────────────────────────────────────────────────────────────────────────────────
 *
 * CAN BE PREPARED OFFLINE (no network required):
 * - Transaction operations (payment, manage data, etc.)
 * - Memo construction
 * - Asset specifications
 * - Timebounds (can use estimated or provided values)
 * - Basic input validation
 *
 * REQUIRES NETWORK STATE (must be fetched or provided):
 * - Source account sequence number (CRITICAL - required for transaction validity)
 * - Account balance verification (optional but recommended)
 * - Fee estimation (optional - can use default BASE_FEE)
 * - Trustline verification for issued assets (optional but recommended)
 *
 * Workflow
 * ────────────────────────────────────────────────────────────────────────────────
 *
 * 1. PREPARE OFFLINE: Build transaction operations and metadata without network
 * 2. FETCH STATE: Get sequence number and optional account data (can be done later)
 * 3. BUILD: Assemble the transaction with sequence number and timebounds
 * 4. SIGN: Sign the transaction (can be done offline with local keys)
 * 5. SUBMIT: Submit to Horizon (requires network access)
 *
 * This enables use cases like:
 * - Air-gapped signing (prepare on online machine, sign on offline machine)
 * - Multi-party coordination (prepare transaction, get signatures from multiple parties)
 * - Delayed submission (prepare now, submit when network is available)
 * - Transaction queuing (prepare multiple transactions, submit in batch)
 */

import * as StellarSDK from '@stellar/stellar-sdk';
import { getHorizonServer, getNetworkPassphrase, resolveConfig } from '../config';
import {
  StellarAssetSpec,
  PocketPayError,
  SDKConfig,
  PocketPayResult,
  FeeEstimate,
} from '../types';
import { validatePublicKey, validateSecretKey, validateAmount, validateMemoInput, buildMemo, wrapError, toResult } from '../utils';
import { withTimeout, fetchFeeEstimate } from '../network';
import { submitWithGuard } from './guarded-submit';
import { ErrorCategory, ErrorCode, ERROR_CODES } from '../errors';
import { validateSequenceValue, isSequenceStale } from '../account/sequence';
import { canSignTransaction, type AccountAbstraction, type Signer } from '../account';

// ─── Type Definitions ───────────────────────────────────────────────────────────

/**
 * Payment operation that can be prepared offline.
 */
export interface OfflinePaymentOperation {
  /** Destination account public key */
  destination: string;
  /** Amount to send (as string for precision) */
  amount: string;
  /** Asset specification (native XLM or issued asset) */
  asset: StellarAssetSpec;
}

/**
 * Transaction preparation parameters that can be provided offline.
 */
export interface OfflineTransactionParams {
  /** Source account public key */
  sourcePublicKey: string;
  /** Payment operations to include in the transaction */
  operations: OfflinePaymentOperation[];
  /** Optional memo text (max 28 bytes) */
  memo?: string;
  /** Optional timebounds (if not provided, defaults will be used) */
  timebounds?: {
    /** Minimum timestamp (Unix seconds) */
    minTime?: number;
    /** Maximum timestamp (Unix seconds) */
    maxTime?: number;
  };
  /** Base fee in stroops (if not provided, uses network default) */
  baseFee?: string;
}

/**
 * Network state required to complete transaction building.
 * Some of this can be fetched later, some must be provided.
 */
export interface NetworkState {
  /** Source account sequence number (REQUIRED for valid transaction) */
  sequence: string;
  /**
   * Epoch milliseconds at which `sequence` was read from Horizon.
   *
   * Preparation deliberately splits fetching state from building, so a snapshot
   * can sit unused while other transactions consume the account's sequence.
   * Without this marker there was no way to tell a fresh snapshot from one that
   * had already been superseded. Absent when the sequence was supplied manually.
   */
  fetchedAt?: number;
  /** Current base fee from network (optional - can use default) */
  currentFee?: string;
  /** Detailed fee estimation containing high/standard/low tiers */
  feeEstimate?: FeeEstimate;
  /** Account balance information (optional - for validation) */
  balance?: {
    /** Native XLM balance */
    native: string;
    /** Minimum balance required */
    minimum: string;
  };
}

/**
 * Prepared transaction that can be signed and submitted later.
 */
export interface PreparedTransaction {
  /** Source account public key */
  sourcePublicKey: string;
  /** Network passphrase */
  networkPassphrase: string;
  /** Transaction operations (serialized) */
  operations: OfflinePaymentOperation[];
  /** Optional memo */
  memo?: string | undefined;
  /** Timebounds */
  timebounds: {
    minTime: number;
    maxTime: number;
  };
  /** Base fee in stroops */
  baseFee: string;
  /** Network state used for preparation */
  networkState: NetworkState;
  /** Whether the transaction is ready to be built */
  readyToBuild: boolean;
  /** Transaction hash (calculated after building) */
  transactionHash?: string;
}

/**
 * Built but unsigned transaction ready for signing.
 */
export interface UnsignedTransaction {
  /** The Stellar SDK Transaction object (unsigned) */
  transaction: StellarSDK.Transaction;
  /** Network passphrase for signing */
  networkPassphrase: string;
  /** Source account public key */
  sourcePublicKey: string;
  /** Transaction hash (for verification) */
  hash: string;
}

/**
 * Signed transaction ready for submission.
 */
export interface SignedTransaction {
  /** The Stellar SDK Transaction object (signed) */
  transaction: StellarSDK.Transaction;
  /** Network passphrase */
  networkPassphrase: string;
  /** Transaction hash */
  hash: string;
  /** XDR representation of the signed transaction envelope */
  xdr: string;
}

/**
 * Summary of a transaction signing payload for user inspection.
 * Contains all necessary information to review before signing.
 */
export interface TransactionSigningSummary {
  /** Source account public key that will sign the transaction */
  source: string;
  /** Network passphrase (identifies which network this is for: mainnet, testnet, etc.) */
  network: string;
  /** Human-readable network name if recognized */
  networkName?: string;
  /** Base fee in stroops */
  fee: string;
  /** Human-readable fee in XLM (converted from stroops) */
  feeInXlm: string;
  /** Optional memo included with the transaction */
  memo?: string;
  /** List of operations included in the transaction */
  operations: Array<{
    /** Type of operation (only payment is currently supported) */
    type: 'payment';
    /** Destination account for the payment */
    destination: string;
    /** Amount being sent */
    amount: string;
    /** Asset code (XLM, USDC, etc.) */
    assetCode: string;
    /** Optional issuer for non-native assets */
    assetIssuer?: string | undefined;
    /** Human-readable summary of the operation */
    description: string;
  }>;
  /** Timebounds for the transaction (when it becomes valid and expires) */
  timebounds: {
    minTime: number;
    maxTime: number;
    /** ISO string of min time */
    validFrom: string;
    /** ISO string of max time */
    validUntil: string;
  };
  /** Total number of operations */
  operationCount: number;
  /** Transaction hash if available (only for built unsigned transactions) */
  transactionHash?: string;
  /** Whether the transaction is ready to be signed */
  canSign: boolean;
}

/**
 * Extracts a human-readable summary from a transaction signing payload
 * to allow users to review and confirm what they are about to sign.
 * 
 * @param payload - A PreparedTransaction or UnsignedTransaction to inspect
 * @returns A typed TransactionSigningSummary with all relevant information
 * @throws {PocketPayError} If the payload type is not supported
 */
export function getTransactionSigningSummary(
  payload: PreparedTransaction | UnsignedTransaction
): TransactionSigningSummary {
  // Extract common fields from either payload type
  let sourcePublicKey: string;
  let networkPassphrase: string;
  let baseFee: string;
  let memo: string | undefined;
  let operations: OfflinePaymentOperation[];
  let timebounds: { minTime: number; maxTime: number };
  let transactionHash: string | undefined;
  let canSign: boolean;

  if ('transaction' in payload) {
    // This is an UnsignedTransaction
    sourcePublicKey = payload.sourcePublicKey;
    networkPassphrase = payload.networkPassphrase;
    baseFee = String(payload.transaction.fee);
    memo = payload.transaction.memo?.value?.toString();
    transactionHash = payload.hash;
    canSign = true;
    
    // Extract operations from the Stellar SDK transaction
    operations = payload.transaction.operations.map((op: any) => {
      if (op.type === 'payment') {
        return {
          destination: op.destination,
          amount: op.amount,
          asset: {
            code: op.asset.code,
            issuer: op.asset.issuer || undefined
          }
        };
      }
      throw new PocketPayError(
        `Unsupported operation type in transaction: ${op.type}`,
        'UNSUPPORTED_OPERATION',
        // `operationType` is not a PocketPayError option; the detail belongs in
        // validation metadata. See the repository-fix note in the PR.
        { validation: { field: 'operationType', reason: 'unsupported', value: op.type } }
      );
    });
    
    // Extract timebounds from the transaction
    timebounds = {
      minTime: payload.transaction.timeBounds?.minTime ? parseInt(payload.transaction.timeBounds.minTime) : 0,
      maxTime: payload.transaction.timeBounds?.maxTime ? parseInt(payload.transaction.timeBounds.maxTime) : 0
    };
  } else {
    // This is a PreparedTransaction
    sourcePublicKey = payload.sourcePublicKey;
    networkPassphrase = payload.networkPassphrase;
    baseFee = payload.baseFee;
    memo = payload.memo;
    operations = payload.operations;
    timebounds = payload.timebounds;
    transactionHash = payload.transactionHash;
    canSign = payload.readyToBuild;
  }

  // Resolve network name from passphrase
  let networkName: string | undefined;
  if (networkPassphrase === StellarSDK.Networks.PUBLIC) {
    networkName = 'Stellar Mainnet';
  } else if (networkPassphrase === StellarSDK.Networks.TESTNET) {
    networkName = 'Stellar Testnet';
  } else if (networkPassphrase === StellarSDK.Networks.FUTURENET) {
    networkName = 'Stellar Futurenet';
  } else if (networkPassphrase === StellarSDK.Networks.STANDALONE) {
    networkName = 'Local Standalone Network';
  } else {
    networkName = 'Custom Network';
  }

  // Convert fee from stroops to XLM (1 XLM = 10^7 stroops)
  const feeInStroops = parseInt(baseFee, 10);
  const feeInXlm = (feeInStroops / 10000000).toFixed(7);

  // Process operations into summary format
  const summarizedOperations = operations.map(op => {
    const isNative = !op.asset.issuer || op.asset.code.toUpperCase() === 'XLM';
    const assetCode = isNative ? 'XLM' : op.asset.code;
    const description = `Send ${op.amount} ${assetCode} to ${op.destination.substring(0, 8)}...`;
    
    return {
      type: 'payment' as const,
      destination: op.destination,
      amount: op.amount,
      assetCode,
      assetIssuer: isNative ? undefined : op.asset.issuer,
      description
    };
  });

  // Format timebounds as ISO strings
  const validFrom = new Date(timebounds.minTime * 1000).toISOString();
  const validUntil = new Date(timebounds.maxTime * 1000).toISOString();

  return {
    source: sourcePublicKey,
    network: networkPassphrase,
    networkName,
    fee: baseFee,
    feeInXlm,
    memo,
    operations: summarizedOperations,
    timebounds: {
      ...timebounds,
      validFrom,
      validUntil
    },
    operationCount: summarizedOperations.length,
    transactionHash,
    canSign
  };
}

/**
 * Transaction submission result.
 */
export interface SubmissionResult {
  /** Whether the submission was successful */
  success: boolean;
  /** Transaction hash */
  hash: string;
  /** Ledger number (if successful) */
  ledger?: number;
  /** Fee charged (if successful) */
  fee?: string;
  /** Error message (if failed) */
  error?: string;
  /** Error code (if failed) */
  errorCode?: string;
}

// ─── Offline Preparation Functions ─────────────────────────────────────────────

/**
 * Prepares a transaction offline without network access.
 *
 * This function validates inputs and constructs the transaction structure,
 * but cannot build the final transaction without the source account sequence number.
 *
 * @param params - Transaction preparation parameters
 * @param config - SDK config (for network passphrase)
 * @returns Prepared transaction (not yet ready to build)
 */
export function prepareTransactionOffline(
  params: OfflineTransactionParams,
  config?: Partial<SDKConfig>,
): PreparedTransaction {
  // Validate inputs
  validatePublicKey(params.sourcePublicKey);
  
  for (const op of params.operations) {
    validatePublicKey(op.destination);
    validateAmount(op.amount);
    validateAssetSpecOffline(op.asset);
  }
  
  validateMemoInput(params.memo);

  const cfg = resolveConfig(config);
  const networkPassphrase = getNetworkPassphrase(cfg.network);

  // Default timebounds: valid for 5 minutes from now (estimated)
  const now = Math.floor(Date.now() / 1000);
  const timebounds = params.timebounds || {
    minTime: now,
    maxTime: now + 300, // 5 minutes
  };
  
  // Ensure timebounds has both values
  const finalTimebounds = {
    minTime: timebounds.minTime ?? now,
    maxTime: timebounds.maxTime ?? (now + 300),
  };

  // Default base fee
  const baseFee = params.baseFee || String(StellarSDK.BASE_FEE);

  return {
    sourcePublicKey: params.sourcePublicKey,
    networkPassphrase,
    operations: params.operations,
    memo: params.memo,
    timebounds: finalTimebounds,
    baseFee,
    networkState: {
      sequence: '', // Not yet provided
    },
    readyToBuild: false, // Needs sequence number
  };
}

/**
 * Validates asset specification offline.
 */
function validateAssetSpecOffline(asset: StellarAssetSpec): boolean {
  if (!asset || typeof asset !== 'object') {
    throw new PocketPayError('Invalid asset specification object', 'INVALID_ASSET', {
      validation: { field: 'asset', reason: 'invalid_object' },
    });
  }

  const code = (asset.code || '').trim();
  if (!code) {
    throw new PocketPayError('Asset code is required', 'INVALID_ASSET_CODE', {
      validation: { field: 'asset.code', reason: 'empty' },
    });
  }

  const isNative = code.toUpperCase() === 'XLM' || code.toLowerCase() === 'native';

  if (isNative) {
    if (asset.issuer && asset.issuer.trim().length > 0) {
      throw new PocketPayError('Native XLM asset must not specify an issuer', 'INVALID_ASSET', {
        validation: { field: 'asset.issuer', reason: 'native_asset_has_issuer', value: asset.issuer },
      });
    }
    return true;
  }

  // Issued asset code validation: 1-12 alphanumeric characters
  if (!/^[a-zA-Z0-9]{1,12}$/.test(code)) {
    throw new PocketPayError(
      `Invalid asset code: "${code}". Must be 1-12 alphanumeric characters.`,
      'INVALID_ASSET_CODE',
      {
        validation: { field: 'asset.code', reason: 'invalid_format', value: code },
      },
    );
  }

  if (!asset.issuer || asset.issuer.trim().length === 0) {
    throw new PocketPayError(
      `Issued asset "${code}" requires an issuer public key (G...).`,
      'MISSING_ASSET_ISSUER',
      {
        validation: { field: 'asset.issuer', reason: 'missing' },
      },
    );
  }

  validatePublicKey(asset.issuer);
  return true;
}

// ─── Network State Functions ─────────────────────────────────────────────────────

/**
 * Fetches the network state required to complete transaction building.
 *
 * This function makes a Horizon call to get the source account's sequence number
 * and optional balance information.
 *
 * @param publicKey - Source account public key
 * @param config - SDK config
 * @returns Network state including sequence number
 */
export async function fetchNetworkState(
  publicKey: string,
  config?: Partial<SDKConfig>,
): Promise<NetworkState> {
  validatePublicKey(publicKey);

  const cfg = resolveConfig(config);
  const server = getHorizonServer(config);

  try {
    const [account, feeEstimate] = await Promise.all([
      withTimeout(
        'Horizon account lookup for transaction preparation',
        cfg.timeout,
        server.loadAccount(publicKey),
      ) as any,
      fetchFeeEstimate(config)
    ]);

    return {
      sequence: account.sequence,
      fetchedAt: Date.now(),
      currentFee: feeEstimate.baseFee,
      feeEstimate,
      balance: {
        native: account.balances?.find((b: any) => b.asset_type === 'native')?.balance || '0',
        minimum: '2.5', // Minimum reserve on Stellar
      },
    };
  } catch (error) {
    if ((error as any)?.response?.status === 404) {
      throw new PocketPayError(
        `Source account not found: ${publicKey}. It may not be funded yet.`,
        'ACCOUNT_NOT_FOUND',
        404
      );
    }
    throw wrapError(error, 'Failed to fetch network state', 'NETWORK_STATE_ERROR');
  }
}

/**
 * Updates a prepared transaction with network state.
 *
 * This adds the sequence number and makes the transaction ready to build.
 *
 * @param prepared - Previously prepared transaction
 * @param networkState - Network state from fetchNetworkState or manual input
 * @returns Updated prepared transaction ready to build
 */
export function updateWithNetworkState(
  prepared: PreparedTransaction,
  networkState: NetworkState,
): PreparedTransaction {
  if (!networkState.sequence) {
    throw new PocketPayError(
      'Network state must include sequence number',
      ErrorCode.TX_BAD_SEQUENCE,
      {
        category: ERROR_CODES[ErrorCode.TX_BAD_SEQUENCE].category,
        safeMessage: ERROR_CODES[ErrorCode.TX_BAD_SEQUENCE].safeMessage,
        validation: { field: 'sequence', reason: 'required' },
      },
    );
  }

  // A manually supplied sequence used to reach the builder unchecked; a
  // malformed value only surfaced at submission time as an opaque failure.
  validateSequenceValue(networkState.sequence);

  return {
    ...prepared,
    networkState,
    readyToBuild: true,
  };
}

// ─── Transaction Building Functions ─────────────────────────────────────────────

/**
 * Reports whether a prepared transaction's sequence snapshot has aged out.
 *
 * Returns `false` when the sequence was supplied manually, since there is no
 * read time to compare against — the caller owns freshness in that case.
 *
 * @param prepared - A prepared transaction
 * @param maxAgeMs - Maximum acceptable age of the snapshot
 */
export function isPreparedSequenceStale(
  prepared: PreparedTransaction,
  maxAgeMs?: number,
): boolean {
  const fetchedAt = prepared.networkState?.fetchedAt;
  if (fetchedAt === undefined) return false;
  return isSequenceStale({ fetchedAt }, maxAgeMs);
}

/** Options accepted by {@link buildUnsignedTransaction}. */
export interface BuildUnsignedOptions {
  /**
   * Reject the build when the sequence snapshot is older than `maxSequenceAgeMs`.
   *
   * Off by default so existing callers are unaffected. Turn it on when several
   * intents may share one account and a superseded snapshot would otherwise
   * produce a `tx_bad_seq` only at submission time.
   */
  enforceSequenceFreshness?: boolean;
  /** Age threshold used when `enforceSequenceFreshness` is set. */
  maxSequenceAgeMs?: number;
}

/**
 * Builds an unsigned transaction from a prepared transaction.
 *
 * This function requires the prepared transaction to have network state (sequence number).
 *
 * @param prepared - Prepared transaction with network state
 * @param options - Optional sequence-freshness enforcement
 * @returns Unsigned transaction ready for signing
 */
export function buildUnsignedTransaction(
  prepared: PreparedTransaction,
  options: BuildUnsignedOptions = {},
): UnsignedTransaction {
  if (!prepared.readyToBuild) {
    throw new PocketPayError(
      'Transaction is not ready to build - missing network state (sequence number)',
      'TRANSACTION_NOT_READY',
      {
        validation: { field: 'networkState.sequence', reason: 'required' },
      },
    );
  }

  if (
    options.enforceSequenceFreshness &&
    isPreparedSequenceStale(prepared, options.maxSequenceAgeMs)
  ) {
    throw new PocketPayError(
      'The prepared sequence snapshot is stale; refresh network state before building.',
      ErrorCode.TX_BAD_SEQUENCE,
      {
        category: ERROR_CODES[ErrorCode.TX_BAD_SEQUENCE].category,
        safeMessage: ERROR_CODES[ErrorCode.TX_BAD_SEQUENCE].safeMessage,
        validation: { field: 'networkState.sequence', reason: 'stale' },
      },
    );
  }

  // Create account object for TransactionBuilder
  const account = new StellarSDK.Account(
    prepared.sourcePublicKey,
    prepared.networkState.sequence,
  );

  // Build transaction
  const builder = new StellarSDK.TransactionBuilder(account, {
    fee: prepared.baseFee,
    networkPassphrase: prepared.networkPassphrase,
    timebounds: prepared.timebounds,
  });

  // Add operations
  for (const op of prepared.operations) {
    const asset = resolveAsset(op.asset);
    builder.addOperation(
      StellarSDK.Operation.payment({
        destination: op.destination,
        asset,
        amount: op.amount,
      }),
    );
  }

  // Add memo if provided
  if (prepared.memo) {
    const preparedMemo = buildMemo(prepared.memo);
    if (preparedMemo) builder.addMemo(preparedMemo);
  }

  const transaction = builder.build();
  const hash = transaction.hash().toString('hex');

  return {
    transaction,
    networkPassphrase: prepared.networkPassphrase,
    sourcePublicKey: prepared.sourcePublicKey,
    hash,
  };
}

/**
 * Resolves a StellarAssetSpec to a Stellar SDK Asset object.
 */
function resolveAsset(asset: StellarAssetSpec): StellarSDK.Asset {
  const code = asset.code.trim().toUpperCase();
  if (code === 'XLM' || asset.code.toLowerCase() === 'native') {
    return StellarSDK.Asset.native();
  }
  return new StellarSDK.Asset(asset.code, asset.issuer!);
}

// ─── Signing Functions ───────────────────────────────────────────────────────────

/**
 * Signs an unsigned transaction with a secret key.
 *
 * @param unsigned - Unsigned transaction
 * @param secretKey - Source account secret key
 * @returns Signed transaction ready for submission
 */
export function signTransaction(
  unsigned: UnsignedTransaction,
  secretKey: string,
): SignedTransaction {
  validateSecretKey(secretKey);

  const keypair = StellarSDK.Keypair.fromSecret(secretKey);
  const transaction = unsigned.transaction;

  // Verify the secret key matches the source public key
  if (keypair.publicKey() !== unsigned.sourcePublicKey) {
    throw new PocketPayError(
      'Secret key does not match source public key',
      'KEY_MISMATCH',
      {
        validation: { field: 'secretKey', reason: 'mismatch' },
      },
    );
  }

  // Sign the transaction
  transaction.sign(keypair);

  const hash = transaction.hash().toString('hex');
  const xdr = transaction.toEnvelope().toXDR('base64');

  return {
    transaction,
    networkPassphrase: unsigned.networkPassphrase,
    hash,
    xdr,
  };
}

/**
 * Signs an unsigned transaction using a `Signer` implementation.
 *
 * This enables integration with hardware wallets and other external signers.
 * Accepts the same `Signer` contract used by the account abstraction layer
 * (`src/account`) — a local keypair, or any future external signer adapter.
 *
 * @param unsigned - Unsigned transaction
 * @param signer - `Signer` implementation
 * @returns Signed transaction ready for submission
 * @throws {PocketPayError} `TX_SIGNER_MISMATCH` if the signer's public key
 *   does not match the transaction's source account.
 */
export async function signTransactionWithSigner(
  unsigned: UnsignedTransaction,
  signer: Signer,
): Promise<SignedTransaction> {
  // Verify the signer matches the source public key
  if (signer.publicKey !== unsigned.sourcePublicKey) {
    throw new PocketPayError(
      'Signer public key does not match source public key',
      ErrorCode.TX_SIGNER_MISMATCH,
      {
        category: ErrorCategory.Transaction,
        safeMessage: ERROR_CODES[ErrorCode.TX_SIGNER_MISMATCH].safeMessage,
        validation: { field: 'signer', reason: 'mismatch' },
      },
    );
  }

  // The Signer contract accepts/returns Transaction | FeeBumpTransaction so
  // it can also serve future fee-bump flows; this pipeline only ever hands it
  // a plain Transaction, and well-behaved signers preserve that concrete type.
  const signedTransaction = await signer.sign(unsigned.transaction, unsigned.networkPassphrase);
  const transaction = signedTransaction as StellarSDK.Transaction;
  const hash = transaction.hash().toString('hex');
  const xdr = transaction.toEnvelope().toXDR('base64');

  return {
    transaction,
    networkPassphrase: unsigned.networkPassphrase,
    hash,
    xdr,
  };
}

/**
 * Signs an unsigned transaction using an {@link AccountAbstraction}, checking
 * signing **capability before** attempting to sign.
 *
 * This is the capability-checked entry point for the offline preparation
 * pipeline: it verifies the account can sign (typed `TX_SIGNER_MISSING` if
 * not — e.g. a read-only account) and that the attached signer matches the
 * transaction's source account (typed `TX_SIGNER_MISMATCH` if not) before
 * ever calling into the signer. Delegates to {@link signTransactionWithSigner}
 * once both checks pass, so behaviour is identical to calling it directly
 * with `account.signer`.
 *
 * @param unsigned - Unsigned transaction
 * @param account - The account abstraction to sign with (read-only or signing)
 * @returns Signed transaction ready for submission
 * @throws {PocketPayError} `TX_SIGNER_MISSING` if `account` has no signer attached.
 * @throws {PocketPayError} `TX_SIGNER_MISMATCH` if `account.publicKey` does not
 *   match the transaction's source account.
 *
 * @example
 * ```ts
 * const readOnly = createReadOnlyAccount('GXXX...');
 * await signWithAccount(unsigned, readOnly); // throws TX_SIGNER_MISSING
 *
 * const wallet = createLocalAccount('SXXX...');
 * const signed = await signWithAccount(unsigned, wallet); // signs normally
 * ```
 */
export async function signWithAccount(
  unsigned: UnsignedTransaction,
  account: AccountAbstraction,
): Promise<SignedTransaction> {
  if (!canSignTransaction(account)) {
    throw new PocketPayError(
      `Account ${account.publicKey} has no signer attached and cannot sign transactions.`,
      ErrorCode.TX_SIGNER_MISSING,
      {
        category: ErrorCategory.Transaction,
        safeMessage: ERROR_CODES[ErrorCode.TX_SIGNER_MISSING].safeMessage,
        validation: { field: 'account', reason: 'no_signer_attached' },
      },
    );
  }

  if (account.publicKey !== unsigned.sourcePublicKey) {
    throw new PocketPayError(
      'Signer does not match the transaction source account.',
      ErrorCode.TX_SIGNER_MISMATCH,
      {
        category: ErrorCategory.Transaction,
        safeMessage: ERROR_CODES[ErrorCode.TX_SIGNER_MISMATCH].safeMessage,
        validation: { field: 'account', reason: 'signer_mismatch' },
      },
    );
  }

  return signTransactionWithSigner(unsigned, account.signer);
}

// ─── Submission Functions ───────────────────────────────────────────────────────

/**
 * Submits a signed transaction to Horizon.
 *
 * @param signed - Signed transaction
 * @param config - SDK config
 * @returns Submission result
 */
export async function submitSignedTransaction(
  signed: SignedTransaction,
  config?: Partial<SDKConfig>,
): Promise<SubmissionResult> {
  if (signed.transaction.signatures.length === 0) {
    return {
      success: false,
      hash: signed.hash,
      error: ERROR_CODES[ErrorCode.TX_UNSIGNED].safeMessage,
      errorCode: ErrorCode.TX_UNSIGNED,
    };
  }

  const cfg = resolveConfig(config);
  const server = getHorizonServer(config);

  try {
    // Guarded submission (issue #305). The staged pipeline submitted straight
    // to Horizon, so a timeout here surfaced as a failure even though the
    // signed envelope may already have reached the network. Routing through
    // `submitTransactionIdempotently` polls instead. The deadline covers the
    // default polling budget (10 attempts × 2000 ms) so the timeout wrapper
    // cannot abort the polling that makes this safe.
    const result = await submitWithGuard(signed.transaction, {}, config);

    const resultObj = result as any;
    return {
      success: true,
      hash: resultObj.hash,
      ledger: resultObj.ledger,
      fee: resultObj.fee_charged || String(StellarSDK.BASE_FEE),
    };
  } catch (error) {
    const horizonError = error as any;
    
    if (horizonError?.response?.data?.extras?.result_codes) {
      const codes = horizonError.response.data.extras.result_codes;
      return {
        success: false,
        hash: signed.hash,
        error: `Payment failed with transaction result code: ${codes.transaction}`,
        errorCode: codes.transaction,
      };
    }

    if (horizonError?.response?.status === 404) {
      return {
        success: false,
        hash: signed.hash,
        error: 'Source account not found',
        errorCode: 'ACCOUNT_NOT_FOUND',
      };
    }

    return {
      success: false,
      hash: signed.hash,
      error: horizonError?.message || String(error),
      errorCode: 'SUBMISSION_ERROR',
    };
  }
}

// ─── Complete Workflow Functions ───────────────────────────────────────────────

/**
 * Complete offline preparation workflow: prepare, fetch state, build, sign.
 *
 * This combines the steps for a typical offline preparation flow.
 *
 * @param params - Transaction preparation parameters
 * @param secretKey - Source account secret key
 * @param config - SDK config
 * @returns Signed transaction ready for submission
 */
export async function prepareAndSignTransaction(
  params: OfflineTransactionParams,
  secretKey: string,
  config?: Partial<SDKConfig>,
): Promise<SignedTransaction> {
  // 1. Prepare offline
  const prepared = prepareTransactionOffline(params, config);

  // 2. Fetch network state
  const networkState = await fetchNetworkState(params.sourcePublicKey, config);

  // 3. Update with network state
  const updated = updateWithNetworkState(prepared, networkState);

  // 4. Build unsigned transaction
  const unsigned = buildUnsignedTransaction(updated);

  // 5. Sign
  return signTransaction(unsigned, secretKey);
}

/**
 * Prepare transaction with manual sequence number (fully offline).
 *
 * This allows completely offline preparation if the sequence number is known.
 *
 * @param params - Transaction preparation parameters
 * @param sequence - Manual sequence number
 * @param config - SDK config
 * @returns Prepared transaction ready to build
 */
export function prepareTransactionWithManualSequence(
  params: OfflineTransactionParams,
  sequence: string,
  config?: Partial<SDKConfig>,
): PreparedTransaction {
  const prepared = prepareTransactionOffline(params, config);
  return updateWithNetworkState(prepared, { sequence });
}

// ─── Safe Wrappers ─────────────────────────────────────────────────────────────

/**
 * Non-throwing wrapper for fetchNetworkState.
 */
export async function safeFetchNetworkState(
  publicKey: string,
  config?: Partial<SDKConfig>,
): Promise<PocketPayResult<NetworkState>> {
  return toResult(
    () => fetchNetworkState(publicKey, config),
    'Failed to fetch network state',
    'NETWORK_STATE_ERROR',
  );
}

/**
 * Non-throwing wrapper for {@link signWithAccount}.
 *
 * Capability errors (`TX_SIGNER_MISSING`, `TX_SIGNER_MISMATCH`) are returned
 * as a typed failure result rather than thrown, same as any other
 * `PocketPayError` produced by the wrapped function.
 */
export async function safeSignWithAccount(
  unsigned: UnsignedTransaction,
  account: AccountAbstraction,
): Promise<PocketPayResult<SignedTransaction>> {
  return toResult(
    () => signWithAccount(unsigned, account),
    'Failed to sign transaction',
    'SIGNING_ERROR',
  );
}

/**
 * Non-throwing wrapper for submitSignedTransaction.
 */
export async function safeSubmitSignedTransaction(
  signed: SignedTransaction,
  config?: Partial<SDKConfig>,
): Promise<PocketPayResult<SubmissionResult>> {
  return toResult(
    () => submitSignedTransaction(signed, config),
    'Failed to submit transaction',
    'SUBMISSION_ERROR',
  );
}

/**
 * Non-throwing wrapper for prepareAndSignTransaction.
 */
export async function safePrepareAndSignTransaction(
  params: OfflineTransactionParams,
  secretKey: string,
  config?: Partial<SDKConfig>,
): Promise<PocketPayResult<SignedTransaction>> {
  return toResult(
    () => prepareAndSignTransaction(params, secretKey, config),
    'Failed to prepare and sign transaction',
    'PREPARATION_ERROR',
  );
}