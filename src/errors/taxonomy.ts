/**
 * taxonomy.ts — consumer-facing helpers for the PocketPay error standard.
 *
 *  - getErrorCategory(code) / describeError(code)  → stable metadata
 *  - redactSensitive(text)                         → scrub secret material
 *  - redactError(error)                            → safe, loggable clone
 *
 * Redaction is mandatory before logging or surfacing raw error text. Secret
 * Stellar keys (S...), raw secrets, and address-like material must never leave
 * the SDK boundary un-redacted.
 */

import {
  ErrorCategory,
  ErrorCode,
  ERROR_CODES,
  type ErrorCodeValue,
  isKnownErrorCode,
} from './codes';
import { PocketPayError } from '../types';

/** Stellar secret keys (S...) — must never be logged or surfaced. */
const SECRET_PATTERN = /[S][A-Za-z0-9]{55,}/g;
/** Generic long alphanumeric blobs that look like secrets/tokens. */
const TOKEN_PATTERN = /\b[A-Za-z0-9+/]{40,}={0,2}\b/g;

/**
 * Removes secret material from an arbitrary string. Returns a copy with secret
 * keys and long token-like blobs replaced by `[REDACTED]`.
 */
export function redactSensitive(input: string): string {
  if (!input) return input;
  // Secrets (Stellar S... keys) take precedence and are replaced with a marker
  // that contains no long alphanumeric run, so the token pattern below won't
  // re-match it.
  let out = input.replace(SECRET_PATTERN, '[[SECRET]]');
  // Redact any remaining long token-like blobs.
  out = out.replace(TOKEN_PATTERN, '[REDACTED_TOKEN]');
  // Final pass turns the secret marker into the public label.
  out = out.replace(/\[\[SECRET\]\]/g, '[REDACTED_SECRET]');
  return out;
}

/** Returns the category for a known code, or SDK for unknown codes. */
export function getErrorCategory(code: string): ErrorCategory {
  if (isKnownErrorCode(code)) {
    return ERROR_CODES[code].category;
  }
  return ErrorCategory.SDK;
}

export interface ErrorDescription {
  code: string;
  category: ErrorCategory;
  retryable: boolean;
  httpStatus?: number;
  /** User-safe summary (never contains secrets). */
  safeMessage: string;
  developerHint: string;
  /** True when `code` is part of the published standard. */
  known: boolean;
}

/**
 * Returns structured, consumer-safe metadata for an error code. For codes not
 * in the published standard, returns SDK-level defaults so callers can always
 * rely on a non-null description.
 */
export function describeError(code: string): ErrorDescription {
  if (isKnownErrorCode(code)) {
    const spec = ERROR_CODES[code as ErrorCodeValue];
    return {
      code,
      category: spec.category,
      retryable: spec.retryable,
      httpStatus: spec.httpStatus,
      safeMessage: spec.safeMessage,
      developerHint: spec.developerHint,
      known: true,
    };
  }
  return {
    code,
    category: ErrorCategory.SDK,
    retryable: false,
    safeMessage: 'An unexpected error occurred.',
    developerHint: 'Code is not part of the published standard; redact and report.',
    known: false,
  };
}

/**
 * Produces a redacted, log-safe copy of an error. The returned object exposes
 * `safeMessage`, the stable `code`, `category`, and `retryable` so consumers can
 * branch without touching raw `message`. Raw `message`/`cause` are redacted.
 */
/**
 * Reads untrusted Error fields without assuming runtime TypeScript annotations.
 * Malformed getters, proxies and nonstring data must never interrupt logging.
 */
function safeDiagnosticText(read: () => unknown, fallback: string): string {
  try {
    const value = read();
    return typeof value === 'string' ? redactSensitive(value) : fallback;
  } catch {
    return fallback;
  }
}

export function redactError(error: unknown): {
  name: string;
  code: string;
  category: ErrorCategory;
  retryable: boolean;
  safeMessage: string;
  message: string;
  statusCode?: number;
  transactionHash?: string;
} {
  let typed = false;
  try {
    typed = error instanceof PocketPayError;
  } catch {
    // Malformed JavaScript Proxy prototype traps must not break safe logging.
  }

  if (typed) {
    const pocketError = error as PocketPayError;
    const candidateCode = safeDiagnosticText(() => pocketError.code, '');
    const code = isKnownErrorCode(candidateCode)
      ? candidateCode
      : ErrorCode.SDK_INTERNAL;
    const desc = describeError(code);

    let statusCode: number | undefined;
    try {
      const rawStatus = pocketError.statusCode;
      if (typeof rawStatus === 'number' && Number.isFinite(rawStatus)) {
        statusCode = rawStatus;
      }
    } catch {
      // An unreadable numeric field is not trusted log metadata.
    }

    let transactionHash: string | undefined;
    try {
      const rawHash = pocketError.transactionHash;
      if (typeof rawHash === 'string') {
        transactionHash = /^[0-9a-f]{64}$/i.test(rawHash)
          ? rawHash
          : redactSensitive(rawHash);
      }
    } catch {
      // The hash is optional; don't invoke an unsafe accessor again.
    }

    return {
      name: safeDiagnosticText(() => pocketError.name, 'PocketPayError'),
      code,
      category: desc.category,
      retryable: desc.retryable,
      safeMessage: desc.safeMessage,
      message: safeDiagnosticText(() => pocketError.message, 'An unexpected error occurred.'),
      statusCode,
      transactionHash,
    };
  }

  let isNativeError = false;
  try {
    isNativeError = error instanceof Error;
  } catch {
    // A throwing getPrototypeOf trap does not make the error loggable.
  }
  return {
    name: isNativeError
      ? safeDiagnosticText(() => (error as Error).name, 'Error')
      : 'Error',
    code: ErrorCode.SDK_INTERNAL,
    category: ErrorCategory.SDK,
    retryable: false,
    safeMessage: 'An unexpected error occurred.',
    message: safeDiagnosticText(
      () => isNativeError ? (error as Error).message : String(error),
      'Unable to format thrown error value.',
    ),
  };
}

/** Convenience: is the given code retryable per the standard? */
export function isRetryableCode(code: string): boolean {
  if (isKnownErrorCode(code)) {
    return ERROR_CODES[code as ErrorCodeValue].retryable;
  }
  return false;
}
