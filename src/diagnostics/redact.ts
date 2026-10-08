/**
 * Strict redaction for diagnostics payloads.
 *
 * Combines a deny-list of sensitive object keys with string scrubbing for
 * Stellar secret keys (S...) and common token-like blobs. Always fail closed:
 * if unsure, redact.
 */

import {
  DIAGNOSTICS_SENSITIVE_KEYS,
  type DiagnosticsSensitiveKey,
} from './types';

const REDACTED = '[REDACTED]';

const SENSITIVE_KEY_SET: ReadonlySet<string> = new Set(
  DIAGNOSTICS_SENSITIVE_KEYS.map((k) => k.toLowerCase()),
);

/** Stellar secret key pattern (S + 55 base32 chars). */
const STELLAR_SECRET_RE = /\bS[A-Z2-7]{55}\b/g;

/** Long opaque tokens that often appear in headers / env dumps. */
const OPAQUE_TOKEN_RE = /\b(?:sk|pk|api)[_-][A-Za-z0-9_-]{16,}\b/gi;

/** Endpoint metadata keys are not generally secret, but their paths and query can be. */
function isEndpointKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_\s]/g, '');
  return normalized === 'horizonurl' || normalized === 'sorobanrpcurl';
}

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (SENSITIVE_KEY_SET.has(lower)) return true;

  // Exact normalized forms of deny-listed keys (strip separators).
  const normalized = lower.replace(/[-_\s]/g, '');
  for (const sensitive of DIAGNOSTICS_SENSITIVE_KEYS) {
    if (normalized === sensitive.toLowerCase().replace(/[-_\s]/g, '')) {
      return true;
    }
  }

  // Common suffix forms without matching boolean flags like `hasSecretKey`.
  if (
    /(?:^|_)(secret|secretkey|privatekey|mnemonic|seed|seedphrase|signedxdr|sourcesecret|password|passphrase|apikey)$/i.test(
      lower,
    )
  ) {
    return true;
  }

  return false;
}

/**
 * Scrub sensitive substrings from a free-form string.
 * Embedded Stellar secret keys are fully replaced (not partially truncated)
 * so support logs cannot reconstruct signing material.
 */
export function redactDiagnosticsString(value: string): string {
  let out = value.replace(STELLAR_SECRET_RE, REDACTED);
  out = out.replace(OPAQUE_TOKEN_RE, REDACTED);
  return out;
}

/**
 * Render only the origin of an endpoint in a support report or error.
 *
 * Credentials may be embedded in URL userinfo, path segments or arbitrary
 * query parameters, so pattern-only secret scrubbing is not sufficient.
 * The actual request URL is not modified by this formatter.
 */
export function redactEndpointUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
      !parsed.hostname
    ) {
      return '[INVALID ENDPOINT]';
    }
    return parsed.origin;
  } catch {
    return '[INVALID ENDPOINT]';
  }
}

/**
 * Deep-redact a value for diagnostics / support export.
 *
 * - Deny-listed object keys → `[REDACTED]`
 * - Strings → secret-key / token scrubbing
 * - Arrays / plain objects → recurse
 * - Error → `{ name, message: redacted }` (no stack by default)
 */
export function redactDiagnosticsValue<T>(value: T): T {
  return redactInternal(value, new WeakSet()) as T;
}

function redactInternal(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    return redactDiagnosticsString(value);
  }

  if (typeof value !== 'object') {
    return value;
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactDiagnosticsString(value.message),
    };
  }

  if (seen.has(value as object)) {
    return '[Circular]';
  }
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => redactInternal(item, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      out[key] = REDACTED;
    } else if (isEndpointKey(key) && typeof child === 'string') {
      // Redact arbitrary credentials even when they are not recognizable tokens.
      out[key] = redactEndpointUrl(child);
    } else {
      out[key] = redactInternal(child, seen);
    }
  }
  return out;
}

/**
 * Returns true when `key` is treated as sensitive by diagnostics redaction.
 * Useful in tests and for documenting the deny-list.
 */
export function isDiagnosticsSensitiveKey(
  key: string,
): key is DiagnosticsSensitiveKey | string {
  return isSensitiveKey(key);
}

export { REDACTED as DIAGNOSTICS_REDACTED_PLACEHOLDER };
