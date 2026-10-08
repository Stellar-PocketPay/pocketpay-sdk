/**
 * inspect.ts — safe inspection of a signed transaction before submission.
 * ──────────────────────────────────────────────────────────────────────────────
 * A consumer that has just signed a transaction usually wants to confirm what
 * it is about to send. Until now the only complete view of a built envelope was
 * `SignedTransaction.xdr` — the whole thing, signatures included.
 *
 * That field is exactly what the SDK already classifies as unsafe to surface:
 * `DIAGNOSTICS_SENSITIVE_KEYS` in `src/diagnostics/types.ts` lists `xdr`,
 * `signedXDR`, `envelope`, `signature` and `signatures` among the keys always
 * replaced with `[REDACTED]`. So this module **reads** the envelope and never
 * echoes it:
 *
 *  - no XDR, no raw signatures, no key material of any kind
 *  - signatures are reported as a count plus their 4-byte hints, which identify
 *    a signer only to someone who already knows the public key
 *  - amounts go through the exact stroop formatter rather than `parseFloat`
 *  - memos report their type, not just their text
 *
 * Field names follow `TransactionSummary` on the read side, so a transaction
 * inspected before submission and the same transaction fetched back from
 * Horizon describe themselves the same way.
 */

import * as StellarSDK from '@stellar/stellar-sdk';
import { PocketPayError } from '../types';
import type { MemoType } from '../types';
import { ErrorCode, ERROR_CODES } from '../errors/codes';
import { formatStroops } from '../utils/amount';
import { formatMemoForDisplay } from '../utils/memo';

/** A signature present on the envelope, described without exposing it. */
export interface SignatureSummary {
  /**
   * The signature hint: the last four bytes of the signer's public key, hex
   * encoded. Enough to match against a known public key, not enough to derive
   * one.
   */
  readonly hint: string;
}

/** One operation, summarised. */
export interface OperationSummary {
  /** Index of the operation within the transaction. */
  readonly index: number;
  /** Stellar operation type, e.g. `payment`. */
  readonly type: string;
  /** Per-operation source account, when it overrides the transaction source. */
  readonly sourceAccount?: string;
  /** Destination, for operations that have one. */
  readonly destination?: string;
  /** Amount as an exact decimal string, for operations that carry one. */
  readonly amount?: string;
  /** Asset code, or `XLM` for native. */
  readonly asset?: string;
  /** Asset issuer, for issued assets. */
  readonly assetIssuer?: string;
}

/** Safe, readable metadata for a built transaction. */
export interface SignedTransactionSummary {
  /** Source account of the transaction. */
  readonly sourceAccount: string;
  /** Transaction hash, hex encoded. */
  readonly hash: string;
  /** Sequence number the envelope was built against. */
  readonly sequence: string;
  /** Total fee in stroops, as declared in the envelope. */
  readonly feeStroops: string;
  /** The same fee as an exact decimal string. */
  readonly fee: string;
  /** Number of operations. */
  readonly operationCount: number;
  /** Per-operation detail. */
  readonly operations: readonly OperationSummary[];
  /** Memo payload rendered as a string, when present. */
  readonly memo?: string;
  /** Memo type, mirroring `TransactionSummary.memoType`. */
  readonly memoType?: MemoType;
  /** Network passphrase the envelope is bound to. */
  readonly networkPassphrase: string;
  /** Friendly network name when the passphrase is a known one. */
  readonly network?: 'testnet' | 'mainnet';
  /** How many signatures the envelope carries. */
  readonly signatureCount: number;
  /** The signatures, described by hint only. */
  readonly signatures: readonly SignatureSummary[];
  /** Whether the envelope carries at least one signature. */
  readonly isSigned: boolean;
  /** Time bounds, when the envelope declares them. */
  readonly timeBounds?: { readonly minTime: string; readonly maxTime: string };
  /** True when this is a fee-bump envelope. */
  readonly isFeeBump: boolean;
  /**
   * Account paying the fee. Differs from `sourceAccount` only on a fee-bump
   * envelope, where a third party covers the inner transaction's fee.
   */
  readonly feeSource?: string;
}

/** Anything this module can inspect. */
export type InspectableTransaction =
  | StellarSDK.Transaction
  | StellarSDK.FeeBumpTransaction
  | string
  | { transaction: StellarSDK.Transaction | StellarSDK.FeeBumpTransaction; networkPassphrase?: string };

/** Builds the typed error used when an envelope cannot be read. */
function inspectionError(reason: string, message: string): PocketPayError {
  const spec = ERROR_CODES[ErrorCode.TX_BUILD_FAILED];
  return new PocketPayError(message, ErrorCode.TX_BUILD_FAILED, {
    category: spec.category,
    safeMessage: spec.safeMessage,
    validation: { field: 'transaction', reason },
  });
}

/** Maps a Stellar memo onto its SDK type and a printable payload. */
function summariseMemo(
  memo: StellarSDK.Memo | undefined
): { memo?: string; memoType?: MemoType } {
  if (!memo || memo.type === StellarSDK.MemoNone) return {};

  const byType: Record<string, MemoType> = {
    [StellarSDK.MemoText]: 'text',
    [StellarSDK.MemoID]: 'id',
    [StellarSDK.MemoHash]: 'hash',
    [StellarSDK.MemoReturn]: 'return',
  };

  const memoType = byType[memo.type];
  const value = memo.value;

  let rendered: string | undefined;
  if (typeof value === 'string') {
    rendered = value;
  } else if (value && typeof (value as Buffer).toString === 'function') {
    // Hash and return memos are 32 raw bytes; hex is the readable form.
    rendered =
      memoType === 'hash' || memoType === 'return'
        ? (value as Buffer).toString('hex')
        : (value as Buffer).toString('utf-8');
  }

  if (memoType === 'text' && rendered !== undefined) {
    rendered = formatMemoForDisplay({ type: 'text', value: rendered });
  }

  return { memo: rendered, memoType };
}

/** Names the network when the passphrase is one of the two well-known ones. */
function friendlyNetwork(passphrase: string): 'testnet' | 'mainnet' | undefined {
  if (passphrase === StellarSDK.Networks.TESTNET) return 'testnet';
  if (passphrase === StellarSDK.Networks.PUBLIC) return 'mainnet';
  return undefined;
}

/** Summarises a single operation without reaching into anything sensitive. */
function summariseOperation(
  operation: StellarSDK.Operation,
  index: number
): OperationSummary {
  const base: OperationSummary = {
    index,
    type: operation.type,
    sourceAccount: operation.source,
  };

  const withAsset = operation as unknown as {
    destination?: string;
    amount?: string;
    asset?: StellarSDK.Asset;
  };

  const asset = withAsset.asset;
  return {
    ...base,
    destination: withAsset.destination,
    amount: withAsset.amount,
    asset: asset ? (asset.isNative() ? 'XLM' : asset.getCode()) : undefined,
    assetIssuer: asset && !asset.isNative() ? asset.getIssuer() : undefined,
  };
}

/**
 * Parses whatever the caller supplied into a Stellar transaction.
 *
 * A base64 XDR string needs the network passphrase to be rebuilt, so it must be
 * supplied alongside.
 */
function resolveTransaction(
  input: InspectableTransaction,
  networkPassphrase?: string
): StellarSDK.Transaction | StellarSDK.FeeBumpTransaction {
  if (typeof input === 'string') {
    if (!networkPassphrase) {
      throw inspectionError(
        'missing_network_passphrase',
        'Inspecting an XDR string requires the network passphrase it was built for.'
      );
    }
    try {
      return StellarSDK.TransactionBuilder.fromXDR(input, networkPassphrase);
    } catch {
      // The underlying error can quote envelope bytes; it is deliberately not
      // forwarded.
      throw inspectionError('invalid_xdr', 'The supplied value is not a valid transaction envelope.');
    }
  }

  if (input && typeof input === 'object' && 'transaction' in input) {
    return input.transaction;
  }

  if (
    input instanceof StellarSDK.Transaction ||
    input instanceof StellarSDK.FeeBumpTransaction
  ) {
    return input;
  }

  throw inspectionError(
    'unsupported_input',
    'Cannot inspect this value: expected a Transaction, a SignedTransaction, or an XDR string.'
  );
}

/**
 * Produces safe, readable metadata for a built transaction.
 *
 * Accepts a `Transaction`, a `FeeBumpTransaction`, the SDK's
 * `SignedTransaction`, or a base64 XDR string — the last of which also needs
 * `networkPassphrase`.
 *
 * The result never contains XDR, raw signatures, or key material.
 *
 * @param input - The transaction, envelope wrapper, or XDR string
 * @param networkPassphrase - Required only when `input` is an XDR string
 * @returns Safe metadata describing the envelope
 * @throws PocketPayError when the value cannot be read as a transaction
 *
 * @example
 * ```ts
 * const summary = inspectSignedTransaction(signed);
 * console.log(summary.operationCount, summary.fee, summary.isSigned);
 * ```
 */
export function inspectSignedTransaction(
  input: InspectableTransaction,
  networkPassphrase?: string
): SignedTransactionSummary {
  const transaction = resolveTransaction(input, networkPassphrase);
  const isFeeBump = transaction instanceof StellarSDK.FeeBumpTransaction;

  const inner = isFeeBump
    ? (transaction as StellarSDK.FeeBumpTransaction).innerTransaction
    : (transaction as StellarSDK.Transaction);

  const signatures = transaction.signatures.map((signature) => ({
    hint: signature.hint().toString('hex'),
  }));

  // `fee` on the envelope is already a stroop count; format it exactly rather
  // than dividing through a float.
  const feeStroops = transaction.fee;
  let fee: string;
  try {
    fee = formatStroops(BigInt(feeStroops));
  } catch {
    fee = feeStroops;
  }

  const { memo, memoType } = summariseMemo(inner.memo);

  const timeBounds = inner.timeBounds
    ? { minTime: String(inner.timeBounds.minTime), maxTime: String(inner.timeBounds.maxTime) }
    : undefined;

  // A fee-bump envelope has no `source`: the inner transaction carries it and
  // the outer one names a separate fee payer.
  const feeSource = isFeeBump
    ? (transaction as StellarSDK.FeeBumpTransaction).feeSource
    : undefined;

  return {
    sourceAccount: inner.source,
    hash: transaction.hash().toString('hex'),
    sequence: inner.sequence,
    feeStroops,
    fee,
    operationCount: inner.operations.length,
    operations: inner.operations.map(summariseOperation),
    memo,
    memoType,
    networkPassphrase: transaction.networkPassphrase,
    network: friendlyNetwork(transaction.networkPassphrase),
    signatureCount: signatures.length,
    signatures,
    isSigned: signatures.length > 0,
    timeBounds,
    isFeeBump,
    feeSource,
  };
}

/**
 * Non-throwing form of {@link inspectSignedTransaction}.
 *
 * @param input - The transaction, envelope wrapper, or XDR string
 * @param networkPassphrase - Required only when `input` is an XDR string
 * @returns `{ valid: true, summary }`, or `{ valid: false, error }`
 */
export function safeInspectSignedTransaction(
  input: InspectableTransaction,
  networkPassphrase?: string
):
  | { valid: true; summary: SignedTransactionSummary }
  | { valid: false; error: PocketPayError } {
  try {
    return { valid: true, summary: inspectSignedTransaction(input, networkPassphrase) };
  } catch (error) {
    if (error instanceof PocketPayError) return { valid: false, error };
    throw error;
  }
}

/**
 * Matches the envelope's signature hints against public keys the caller knows.
 *
 * Hints are the last four bytes of a public key, so this identifies only
 * signers already supplied — it cannot reveal an unknown one.
 *
 * @param summary - A summary from {@link inspectSignedTransaction}
 * @param candidates - Public keys to test
 * @returns The candidates whose hint appears on the envelope
 */
export function matchSignersByHint(
  summary: SignedTransactionSummary,
  candidates: readonly string[]
): string[] {
  const hints = new Set(summary.signatures.map((signature) => signature.hint));
  const matched: string[] = [];

  for (const candidate of candidates) {
    try {
      const hint = StellarSDK.Keypair.fromPublicKey(candidate).signatureHint().toString('hex');
      if (hints.has(hint)) matched.push(candidate);
    } catch {
      // Not a valid public key; skip rather than fail the whole match.
    }
  }
  return matched;
}
