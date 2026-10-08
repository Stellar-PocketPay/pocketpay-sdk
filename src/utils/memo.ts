/**
 * memo.ts — transaction memo validation and construction.
 * ──────────────────────────────────────────────────────────────────────────────
 * Stellar defines five memo types, each with its own format rules:
 *
 *  | Type     | Payload                                      |
 *  | -------- | -------------------------------------------- |
 *  | `none`   | no payload                                   |
 *  | `text`   | up to 28 **bytes** of UTF-8                  |
 *  | `id`     | unsigned 64-bit integer                      |
 *  | `hash`   | 32 bytes, supplied as 64 hex characters      |
 *  | `return` | 32 bytes, supplied as 64 hex characters      |
 *
 * Before this module the SDK could only build `text` memos, while it could
 * already *read* `memo_type` back from Horizon (see `TransactionSummary`).
 * Anything that was not text failed the text byte-length check and surfaced as
 * "Memo text exceeds 28-byte limit", which described the wrong problem.
 *
 * Backwards compatibility: a bare `string` memo continues to mean `text`
 * everywhere, so existing callers are unaffected.
 */

import * as StellarSDK from '@stellar/stellar-sdk';
import { PocketPayError } from '../types';
import type { MemoInput, MemoType } from '../types';
import { ErrorCode, ERROR_CODES } from '../errors/codes';

/** Maximum payload size of a `text` memo, in bytes (not characters). */
export const MEMO_TEXT_MAX_BYTES = 28;

/** Required length of the hex payload for `hash` and `return` memos. */
export const MEMO_HASH_HEX_LENGTH = 64;

/** Largest value a `id` memo can carry (2^64 - 1). */
export const MEMO_ID_MAX = 18_446_744_073_709_551_615n;

/** The memo types this SDK can validate and build. */
export const SUPPORTED_MEMO_TYPES: readonly MemoType[] = [
  'none',
  'text',
  'id',
  'hash',
  'return',
] as const;

const HEX_PATTERN = /^[0-9a-fA-F]+$/;

/** Builds the typed error used for every memo failure. */
function memoError(reason: string, message: string): PocketPayError {
  const spec = ERROR_CODES[ErrorCode.TX_INVALID_MEMO];
  return new PocketPayError(message, ErrorCode.TX_INVALID_MEMO, {
    category: spec.category,
    safeMessage: spec.safeMessage,
    // A failed validation must not copy untrusted memo text into logs or UI error metadata.
    validation: { field: 'memo', reason },
  });
}

/**
 * Normalizes the two accepted memo shapes into a single {@link MemoInput}.
 *
 * A bare string is treated as a `text` memo, which is what every pre-existing
 * caller means. `undefined` and the empty string mean "no memo".
 *
 * @param memo - A memo string, a structured memo, or undefined
 * @returns The normalized memo, or `undefined` when there is no memo
 */
export function normalizeMemo(memo?: string | MemoInput): MemoInput | undefined {
  if (memo === undefined || memo === null) return undefined;

  if (typeof memo === 'string') {
    if (memo.length === 0) return undefined;
    return { type: 'text', value: memo };
  }

  if (typeof memo !== 'object') {
    throw memoError(
      'invalid_shape',
      `Invalid memo: expected a string or { type, value } object, got ${typeof memo}.`
    );
  }

  return memo;
}

/**
 * Validates a memo of any supported type.
 *
 * Unlike the legacy `validateMemo`, this reports *which* rule was broken —
 * an unsupported type is reported as such rather than as a length problem.
 *
 * @param memo - A memo string, a structured memo, or undefined for no memo
 * @returns true when the memo is valid (including "no memo")
 * @throws PocketPayError with code `TX_INVALID_MEMO` when the memo is invalid
 */
export function validateMemoInput(memo?: string | MemoInput): boolean {
  const normalized = normalizeMemo(memo);
  if (!normalized) return true;

  const { type, value } = normalized;

  if (!SUPPORTED_MEMO_TYPES.includes(type)) {
    throw memoError(
      'unsupported_type',
      `Unsupported memo type. Supported types: ${SUPPORTED_MEMO_TYPES.join(', ')}.`
    );
  }

  switch (type) {
    case 'none':
      if (value !== undefined) {
        throw memoError(
          'unexpected_payload',
          'A none memo must not include a value.'
        );
      }
      return true;

    case 'text': {
      if (typeof value !== 'string') {
        throw memoError('invalid_type', 'A text memo requires a string value.');
      }
      const byteLength = Buffer.byteLength(value, 'utf-8');
      if (byteLength > MEMO_TEXT_MAX_BYTES) {
        throw memoError(
          'too_long',
          `Memo text exceeds ${MEMO_TEXT_MAX_BYTES}-byte limit (got ${byteLength} bytes).`
        );
      }
      return true;
    }

    case 'id': {
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') {
        throw memoError('invalid_type', 'An id memo requires a string, number, or bigint value.');
      }
      if (typeof value === 'number' && !Number.isSafeInteger(value)) {
        throw memoError(
          'unsafe_number',
          'An id memo number must be a safe JavaScript integer; pass larger IDs as a decimal string or bigint.'
        );
      }
      const raw = String(value);
      if (!/^\d+$/.test(raw)) {
        throw memoError(
          'not_unsigned_integer',
          'An id memo must be an unsigned 64-bit integer.'
        );
      }
      if (BigInt(raw) > MEMO_ID_MAX) {
        throw memoError(
          'out_of_range',
          `An id memo must not exceed ${MEMO_ID_MAX} (2^64 - 1).`
        );
      }
      return true;
    }

    case 'hash':
    case 'return': {
      if (typeof value !== 'string') {
        throw memoError('invalid_type', `A ${type} memo requires a hex string value.`);
      }
      if (value.length !== MEMO_HASH_HEX_LENGTH) {
        throw memoError(
          'invalid_length',
          `A ${type} memo must be ${MEMO_HASH_HEX_LENGTH} hex characters (32 bytes), ` +
            `got ${value.length}.`
        );
      }
      if (!HEX_PATTERN.test(value)) {
        throw memoError(
          'not_hexadecimal',
          `A ${type} memo must contain only hexadecimal characters.`
        );
      }
      return true;
    }

    /* c8 ignore next 2 -- unreachable: the guard above rejects unknown types */
    default:
      return true;
  }
}

/**
 * Validates a memo and returns the matching Stellar `Memo`.
 *
 * Returns `undefined` when there is no memo, so callers can skip `addMemo`.
 *
 * @param memo - A memo string, a structured memo, or undefined
 * @returns The Stellar memo to attach, or undefined for no memo
 * @throws PocketPayError with code `TX_INVALID_MEMO` when the memo is invalid
 */
export function buildMemo(memo?: string | MemoInput): StellarSDK.Memo | undefined {
  const normalized = normalizeMemo(memo);
  if (!normalized) return undefined;

  validateMemoInput(normalized);

  switch (normalized.type) {
    case 'none':
      return undefined;
    case 'text':
      return StellarSDK.Memo.text(String(normalized.value));
    case 'id':
      return StellarSDK.Memo.id(String(normalized.value));
    case 'hash':
      return StellarSDK.Memo.hash(String(normalized.value));
    case 'return':
      return StellarSDK.Memo.return(String(normalized.value));
    /* c8 ignore next 2 -- unreachable: validateMemoInput rejects unknown types */
    default:
      return undefined;
  }
}

/**
 * Non-throwing form of {@link validateMemoInput}.
 *
 * @param memo - A memo string, a structured memo, or undefined
 * @returns `{ valid: true }`, or `{ valid: false, error }` with the typed error
 */
export function safeValidateMemo(
  memo?: string | MemoInput
): { valid: true } | { valid: false; error: PocketPayError } {
  try {
    validateMemoInput(memo);
    return { valid: true };
  } catch (error) {
    if (error instanceof PocketPayError) return { valid: false, error };
    throw error;
  }
}

/**
 * Formats a validated memo for safe, single-line display.
 *
 * Text memos are JSON-escaped without the surrounding quotes so control
 * characters, quotes, and backslashes cannot alter the surrounding UI/log
 * line. Non-text memo payloads are already restricted to display-safe scalar
 * forms by {@link validateMemoInput} and are returned unchanged as strings.
 *
 * @param memo - A memo string, structured memo, or undefined
 * @returns A display-safe string, or undefined when there is no memo
 * @throws PocketPayError with code `TX_INVALID_MEMO` when the memo is invalid
 */
export function formatMemoForDisplay(memo?: string | MemoInput): string | undefined {
  const normalized = normalizeMemo(memo);
  if (!normalized) return undefined;

  validateMemoInput(normalized);
  if (normalized.type === 'none') return undefined;

  const value = String(normalized.value ?? '');
  if (normalized.type !== 'text') return value;

  return JSON.stringify(value).slice(1, -1)
    .replace(/\u0085/g, '\\u0085')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
    // JSON.stringify does not escape bidi formatting marks; render them as ASCII
    // escapes to keep memo text from visually reordering adjacent UI labels.
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, (mark) =>
      '\\u' + mark.charCodeAt(0).toString(16).padStart(4, '0')
    );
}

/**
 * Normalizes a memo returned by Horizon into the SDK's display representation.
 *
 * Horizon serializes hash and return memos as base64, while SDK callers supply
 * those same 32-byte payloads as 64 hexadecimal characters. Convert valid
 * Horizon binary memos back to canonical lowercase hex so a transaction reads
 * the same before submission and after fetching it from Horizon.
 *
 * Unknown or malformed upstream memo shapes are preserved rather than making a
 * transaction-history page fail as a whole.
 */
export function formatHorizonMemoForDisplay(
  memoType: string | undefined,
  memo: string | undefined
): string | undefined {
  if (memoType === undefined || memoType === 'none' || memo === undefined) {
    return undefined;
  }

  if (memoType === 'text' || memoType === 'id') {
    return formatMemoForDisplay({ type: memoType, value: memo });
  }

  if (memoType === 'hash' || memoType === 'return') {
    const bytes = Buffer.from(memo, 'base64');
    if (bytes.length !== 32 || bytes.toString('base64') !== memo) {
      return memo;
    }
    return formatMemoForDisplay({ type: memoType, value: bytes.toString('hex') });
  }

  return memo;
}
