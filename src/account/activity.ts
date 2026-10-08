/**
 * Stellar PocketPay SDK — normalized account activity.
 *
 * Projects the SDK's existing transaction, payment, receipt and vault result
 * types into one display-friendly history record without exposing raw network
 * responses or inventing a second submission/status taxonomy.
 */

import {
  TransactionDirection,
  TransactionStatus,
} from '../types';
import type {
  PaymentReceipt,
  PaymentSummary,
  TransactionSummary,
  VaultMappedResult,
} from '../types';

export type AccountActivityKind = 'payment' | 'transaction' | 'vault';
export type AccountActivityDirection = TransactionDirection | 'neutral';
export type AccountActivitySource =
  | 'payment_history'
  | 'transaction_history'
  | 'payment_receipt'
  | 'vault';

export interface AccountActivityRecord {
  /** Stable identifier derived from the source record; never random. */
  id: string;
  /** Broad activity family for UI grouping/filtering. */
  kind: AccountActivityKind;
  /** Reuses the SDK transaction status taxonomy. */
  status: TransactionStatus;
  /** Direction relative to the account being displayed. */
  direction: AccountActivityDirection;
  /** ISO-8601 timestamp used for history ordering. */
  createdAt: string;
  /** Where this normalized record came from. */
  source: AccountActivitySource;
  transactionHash?: string;
  pagingToken?: string;
  /** Asset-unit decimal for display; omitted when the source has only raw units. */
  amount?: string;
  /** Raw smallest-unit transaction quantity; do not present as asset units. */
  rawAmount?: string;
  asset?: string;
  assetIssuer?: string;
  counterparty?: string;
  memo?: string;
  operation?: string;
}

export interface VaultActivityInput {
  /** Existing typed vault result. */
  result: VaultMappedResult;
  /**
   * Timestamp supplied by the caller because VaultMappedResult deliberately
   * carries no clock field. Keeping it explicit makes normalization
   * deterministic and testable.
   */
  createdAt: string;
}

export interface NormalizeAccountActivityInput {
  /** Account the history is rendered for. */
  account: string;
  transactions?: readonly TransactionSummary[];
  payments?: readonly PaymentSummary[];
  receipts?: readonly PaymentReceipt[];
  vault?: readonly VaultActivityInput[];
}

export interface AccountActivityFilter {
  kind?: AccountActivityKind;
  status?: TransactionStatus;
  direction?: AccountActivityDirection;
  asset?: string;
}

function stableId(prefix: string, ...parts: Array<string | number | undefined>): string {
  const key = parts.find((part) => part !== undefined && String(part).length > 0);
  return prefix + ':' + (key === undefined ? 'unknown' : String(key));
}

function normalizeActivityStatus(value: unknown): TransactionStatus {
  return typeof value === 'string' &&
    Object.values(TransactionStatus).includes(value as TransactionStatus)
      ? (value as TransactionStatus)
      : TransactionStatus.UNKNOWN;
}

function transactionStatus(record: TransactionSummary): TransactionStatus {
  if (record.status !== undefined) {
    const status = normalizeActivityStatus(record.status);
    // Historical success is an observed ledger outcome. Contradictory runtime
    // status fields must never make a failed transaction look completed.
    if ((status === TransactionStatus.COMPLETED && record.successful === false) ||
        (status === TransactionStatus.FAILED && record.successful === true)) {
      return TransactionStatus.UNKNOWN;
    }
    return status;
  }
  if (record.successful === true) return TransactionStatus.COMPLETED;
  if (record.successful === false) return TransactionStatus.FAILED;
  return TransactionStatus.UNKNOWN;
}

function transactionDirection(
  record: TransactionSummary,
  account: string,
): AccountActivityDirection {
  if (record.direction !== undefined) {
    return record.direction as TransactionDirection;
  }
  if (record.sourceAccount === account) return TransactionDirection.OUTGOING;
  // Another source account proves only who initiated the transaction, not
  // that this account received value. Incoming requires explicit direction
  // from the mapper or a payment operation with a verified destination.
  return 'neutral';
}

function paymentDirection(
  record: PaymentSummary,
  account: string,
): AccountActivityDirection {
  if (record.from === account && record.to === account) return TransactionDirection.SELF;
  if (record.from === account) return TransactionDirection.OUTGOING;
  if (record.to === account) return TransactionDirection.INCOMING;
  return 'neutral';
}

function paymentCounterparty(
  record: PaymentSummary,
  account: string,
): string | undefined {
  if (record.from === account && record.to === account) return account;
  if (record.from === account) return record.to || undefined;
  if (record.to === account) return record.from || undefined;
  return undefined;
}

function assignOptional(
  target: AccountActivityRecord,
  values: Partial<Omit<AccountActivityRecord, 'id' | 'kind' | 'status' | 'direction' | 'createdAt' | 'source'>>,
): AccountActivityRecord {
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== '') {
      (target as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return target;
}

/**
 * Normalizes one Horizon payment operation. A returned Horizon payment record
 * is already ledger history, so its status is completed.
 */
export function mapPaymentSummaryToActivity(
  record: PaymentSummary,
  account: string,
): AccountActivityRecord {
  const activity: AccountActivityRecord = {
    id: stableId('payment', record.id, record.transactionHash, record.pagingToken),
    kind: 'payment',
    status: TransactionStatus.COMPLETED,
    direction: paymentDirection(record, account),
    createdAt: record.createdAt,
    source: 'payment_history',
  };

  return assignOptional(activity, {
    transactionHash: record.transactionHash,
    pagingToken: record.pagingToken,
    amount: record.amount,
    asset: record.asset,
    assetIssuer: record.assetIssuer,
    counterparty: paymentCounterparty(record, account),
    operation: record.type,
  });
}

/**
 * Normalizes one transaction-history record. Explicit mapper status/direction
 * wins; otherwise the stable Horizon success/source fields are used.
 */
export function mapTransactionSummaryToActivity(
  record: TransactionSummary,
  account: string,
): AccountActivityRecord {
  const activity: AccountActivityRecord = {
    id: stableId('transaction', record.hash, record.txHash, record.id, record.pagingToken),
    kind: 'transaction',
    status: transactionStatus(record),
    direction: transactionDirection(record, account),
    createdAt: record.createdAt,
    source: 'transaction_history',
  };

  return assignOptional(activity, {
    transactionHash: record.hash ?? record.txHash,
    pagingToken: record.pagingToken,
    // TransactionSummary.amount is smallest-unit, while amountDisplay is the
    // already-scaled amount. Keep both without ever relabeling raw units.
    amount: record.amountDisplay,
    rawAmount: record.amount,
    asset: record.asset,
    counterparty: record.counterparty,
    memo: record.memo,
    operation: record.rawType,
  });
}

/**
 * Normalizes a submission/Soroban payment receipt. Receipt statuses are
 * preserved exactly, including pending and unknown.
 */
export function mapPaymentReceiptToActivity(
  receipt: PaymentReceipt,
  account: string,
): AccountActivityRecord {
  // PaymentReceipt includes a destination but NOT the originating account.
  // Destination===account therefore does not prove a self-payment; it could
  // be an incoming transfer from someone else. Keep the direction neutral.
  const direction: AccountActivityDirection =
    receipt.destination && receipt.destination !== account
      ? TransactionDirection.OUTGOING
      : 'neutral';

  const activity: AccountActivityRecord = {
    id: receipt.transactionHash
      ? stableId('receipt', receipt.transactionHash)
      : receiptFallbackId(receipt),
    kind: 'payment',
    status: normalizeActivityStatus(receipt.status),
    direction,
    createdAt: receipt.createdAt,
    source: 'payment_receipt',
  };

  return assignOptional(activity, {
    transactionHash: receipt.transactionHash,
    amount: receipt.amount,
    asset: receipt.asset,
    counterparty: receipt.destination !== account ? receipt.destination : undefined,
    memo: receipt.memo,
    operation: receipt.operation,
  });
}

/**
 * Hash the observable receipt fields when Horizon has not assigned a
 * transaction hash. Time alone is not an identity: independent pending
 * submissions can be observed during the same millisecond.
 *
 * Use a deterministic fingerprint rather than embedding memos or destinations
 * in UI keys. Identical source receipts remain indistinguishable until the
 * caller supplies a transaction hash (no artificial sequence is invented).
 */
function receiptFallbackId(receipt: PaymentReceipt): string {
  const fields = JSON.stringify([
    receipt.createdAt,
    receipt.source,
    receipt.operation ?? null,
    receipt.destination ?? null,
    receipt.amount ?? null,
    receipt.asset ?? null,
    receipt.memo ?? null,
    receipt.status,
    receipt.actionRequired,
  ]);
  let fingerprint = 0x811c9dc5;
  for (let i = 0; i < fields.length; i += 1) {
    fingerprint = Math.imul(fingerprint ^ fields.charCodeAt(i), 0x01000193);
  }
  return `receipt:${receipt.createdAt}:${(fingerprint >>> 0).toString(16).padStart(8, '0')}`;
}

function vaultStatus(result: VaultMappedResult): TransactionStatus {
  // An incompatible success flag/status pair is not confirmed evidence.
  switch (result.status) {
    case 'success':
      return result.success === true ? TransactionStatus.COMPLETED : TransactionStatus.UNKNOWN;
    case 'pending':
      return result.success === true ? TransactionStatus.UNKNOWN : TransactionStatus.PENDING;
    case 'failed':
    case 'error':
    case 'simulation_error':
      return result.success === false ? TransactionStatus.FAILED : TransactionStatus.UNKNOWN;
    default:
      return TransactionStatus.UNKNOWN;
  }
}

function vaultDirection(result: VaultMappedResult): AccountActivityDirection {
  switch (result.operation) {
    case 'deposit':
      return TransactionDirection.OUTGOING;
    case 'withdraw':
      return TransactionDirection.INCOMING;
    case 'get_balance':
      return 'neutral';
    default:
      return 'neutral';
  }
}

/**
 * Normalizes a vault result. The caller supplies createdAt because the vault
 * result intentionally contains no timestamp.
 */
export function mapVaultResultToActivity(input: VaultActivityInput): AccountActivityRecord {
  const { result, createdAt } = input;
  const activity: AccountActivityRecord = {
    id: result.hash
      ? `vault:${result.hash}:${result.operation}`
      : `vault:${result.operation}:${createdAt}`,
    kind: 'vault',
    status: vaultStatus(result),
    direction: vaultDirection(result),
    createdAt,
    source: 'vault',
  };

  return assignOptional(activity, {
    transactionHash: result.hash,
    amount: result.amount ?? result.balance,
    asset: 'XLM',
    operation: result.operation,
  });
}

/**
 * Builds one reverse-chronological history from existing SDK result types.
 *
 * Valid timestamps sort newest-first; equal valid timestamps preserve insertion
 * order. Invalid timestamps are retained after valid records in insertion order.
 */
export function normalizeAccountActivity(
  input: NormalizeAccountActivityInput,
): AccountActivityRecord[] {
  const records: AccountActivityRecord[] = [
    ...(input.transactions ?? []).map((record) =>
      mapTransactionSummaryToActivity(record, input.account)),
    ...(input.payments ?? []).map((record) =>
      mapPaymentSummaryToActivity(record, input.account)),
    ...(input.receipts ?? []).map((record) =>
      mapPaymentReceiptToActivity(record, input.account)),
    ...(input.vault ?? []).map(mapVaultResultToActivity),
  ];

  return records
    .map((record, index) => ({ record, index }))
    .sort((left, right) => {
      const leftTime = Date.parse(left.record.createdAt);
      const rightTime = Date.parse(right.record.createdAt);
      const leftValid = !Number.isNaN(leftTime);
      const rightValid = !Number.isNaN(rightTime);

      if (leftValid && rightValid) {
        if (leftTime === rightTime) return left.index - right.index;
        return rightTime - leftTime;
      }
      if (leftValid) return -1;
      if (rightValid) return 1;
      return left.index - right.index;
    })
    .map(({ record }) => record);
}

/** Pure client-side filtering for an already-normalized history. */
export function filterAccountActivity(
  records: readonly AccountActivityRecord[],
  filter: AccountActivityFilter,
): AccountActivityRecord[] {
  return records.filter((record) => {
    if (filter.kind !== undefined && record.kind !== filter.kind) return false;
    if (filter.status !== undefined && record.status !== filter.status) return false;
    if (filter.direction !== undefined && record.direction !== filter.direction) return false;
    if (filter.asset !== undefined && record.asset !== filter.asset) return false;
    return true;
  });
}
