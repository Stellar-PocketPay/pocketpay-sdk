import {
  TransactionSummary,
  TransactionDirection,
  TransactionStatus,
  RawHorizonTransaction,
  RawHorizonOperation,
  TransactionMapperOptions,
} from '../types/transaction';
import { safeParseAmount } from '../utils/amount';

/**
 * Maps a raw Horizon transaction to a transaction summary
 * 
 * @param rawTransaction - Raw transaction from Horizon
 * @param options - Mapping options
 * @returns A transaction summary for UI consumption
 * 
 * @example
 * ```ts
 * const summary = mapTransactionToSummary(rawTx, {
 *   userAccount: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890',
 *   formatAmounts: true,
 * });
 * ```
 */
export function mapTransactionToSummary(
  rawTransaction: RawHorizonTransaction,
  options: TransactionMapperOptions
): TransactionSummary {
  const { userAccount, formatAmounts = true } = options;

  // Determine direction and counterparty from operations
  const { direction, counterparty } = determineDirectionAndCounterparty(
    rawTransaction.operations,
    userAccount
  );

  // Extract amount and asset from operations
  const { amount, asset } = extractAmountAndAsset(
    rawTransaction.operations,
    direction
  );

  // Determine status
  const status = rawTransaction.successful
    ? TransactionStatus.COMPLETED
    : TransactionStatus.FAILED;

  // Format amount for display
  const amountDisplay = formatAmounts
    ? formatDisplayAmount(amount, asset)
    : amount;

  // Calculate time ago
  const timeAgo = getTimeAgo(rawTransaction.created_at);

  return {
    id: rawTransaction.id,
    txHash: rawTransaction.tx_hash,
    direction,
    amount,
    amountDisplay,
    asset,
    counterparty,
    memo: rawTransaction.memo,
    status,
    createdAt: rawTransaction.created_at,
    timeAgo,
    fee: rawTransaction.fee_charged,
    rawType: rawTransaction.operations[0]?.type,
  };
}

/**
 * Maps multiple raw Horizon transactions to summaries
 */
export function mapTransactionsToSummaries(
  rawTransactions: RawHorizonTransaction[],
  options: TransactionMapperOptions
): TransactionSummary[] {
  return rawTransactions.map((tx) =>
    mapTransactionToSummary(tx, options)
  );
}

/**
 * Determines the transaction direction and counterparty
 * from the operations and user account
 */
function determineDirectionAndCounterparty(
  operations: RawHorizonOperation[],
  userAccount: string
): { direction: TransactionDirection; counterparty: string } {
  // Find the payment operation
  const paymentOp = operations.find(
    (op) => op.type === 'payment' || op.type === 'create_account'
  );

  if (!paymentOp) {
    return {
      direction: TransactionDirection.INCOMING,
      counterparty: 'Unknown',
    };
  }

  // Check if user is the source or destination
  const isSource = paymentOp.source_account === userAccount;
  const isDestination = paymentOp.to === userAccount;

  if (isSource) {
    return {
      direction: TransactionDirection.OUTGOING,
      counterparty: paymentOp.to || 'Unknown',
    };
  } else if (isDestination) {
    return {
      direction: TransactionDirection.INCOMING,
      counterparty: paymentOp.source_account || 'Unknown',
    };
  }

  // Fallback: check all operations
  for (const op of operations) {
    if (op.from === userAccount) {
      return {
        direction: TransactionDirection.OUTGOING,
        counterparty: op.to || 'Unknown',
      };
    }
    if (op.to === userAccount) {
      return {
        direction: TransactionDirection.INCOMING,
        counterparty: op.from || 'Unknown',
      };
    }
  }

  return {
    direction: TransactionDirection.INCOMING,
    counterparty: 'Unknown',
  };
}

/**
 * Extracts the amount and asset from operations
 */
function extractAmountAndAsset(
  operations: RawHorizonOperation[],
  direction: TransactionDirection
): { amount: string; asset: string } {
  // Find the payment operation
  const paymentOp = operations.find(
    (op) => op.type === 'payment' || op.type === 'create_account'
  );

  if (!paymentOp) {
    return { amount: '0', asset: 'XLM' };
  }

  // For create_account operations, the amount is the starting balance
  const amount = paymentOp.amount || paymentOp.starting_balance || '0';

  // Determine asset
  let asset = 'XLM'; // Default
  if (paymentOp.asset_type !== 'native') {
    asset = paymentOp.asset_code || 'XLM';
  }

  return { amount, asset };
}

/**
 * Formats a display amount with proper decimal places
 */
function formatDisplayAmount(amount: string, asset: string): string {
  // Exact: Horizon amounts are 7-decimal strings, and the shared parser keeps
  // every digit where parseFloat(...).toFixed(7) rounds above 2^53 stroops.
  const parsed = safeParseAmount(amount);
  if (parsed.valid) {
    return parsed.amount.toString();
  }

  // Inputs the shared parser rejects keep their previous formatting.
  const numAmount = parseFloat(amount);
  
  if (isNaN(numAmount)) {
    return '0.00';
  }

  // Different assets may have different decimals
  // XLM has 7 decimals, USDC has 7, etc.
  const decimals = 7; // Default for XLM
  
  return numAmount.toFixed(decimals);
}

/**
 * Calculates a relative time string (e.g., "2 hours ago")
 */
function getTimeAgo(isoTimestamp: string): string {
  const now = new Date();
  const past = new Date(isoTimestamp);
  const diffMs = now.getTime() - past.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffDay > 0) {
    return `${diffDay} day${diffDay > 1 ? 's' : ''} ago`;
  }
  if (diffHour > 0) {
    return `${diffHour} hour${diffHour > 1 ? 's' : ''} ago`;
  }
  if (diffMin > 0) {
    return `${diffMin} minute${diffMin > 1 ? 's' : ''} ago`;
  }
  return 'Just now';
}
