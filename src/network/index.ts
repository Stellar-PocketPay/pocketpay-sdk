/**
 * Stellar PocketPay SDK — Network Module
 * 
 * @security See the [SDK Security Threat Model](../../docs/security_threat_model.md) 
 * for mitigation strategies regarding TLS downgrades, endpoint spoofing, 
 * and safe retry policies to prevent duplicate submissions.
 */
import { PocketPayError } from '../types';
import type { TimeoutStage } from '../types';
import { wrapError } from '../utils';
import { ErrorCode, ERROR_CODES } from '../errors/codes';
import { redactEndpointUrl } from '../diagnostics/redact';

const FALLBACK_TIMEOUT_MS = 30_000;

/**
 * Low-level socket/DNS error codes that mean the endpoint itself could not
 * be reached — distinct from a request that reached the server and merely
 * timed out or was rate-limited. Node, browsers, and undici all surface
 * these on `error.code` or a wrapped `error.cause.code`.
 */
const UNREACHABLE_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
]);

/** Extracts a low-level network error code from a raw fetch rejection. */
function nativeErrorCode(error: unknown): string | undefined {
  const err = error as { code?: unknown; cause?: { code?: unknown } };
  return (
    (typeof err?.code === 'string' && err.code) ||
    (typeof err?.cause?.code === 'string' && err.cause.code) ||
    undefined
  );
}

/**
 * Builds a typed `NET_UNREACHABLE` error for a socket/DNS-level failure,
 * i.e. the request never reached the endpoint at all.
 */
function unreachableError(operation: string, cause: Error): PocketPayError {
  const spec = ERROR_CODES[ErrorCode.NET_UNREACHABLE];
  return new PocketPayError(
    `${operation} could not reach the endpoint: ${cause.message}`,
    ErrorCode.NET_UNREACHABLE,
    { category: spec.category, safeMessage: spec.safeMessage, cause },
    undefined,
    true,
  );
}

/**
 * Builds a typed error for a non-2xx HTTP response. 429 maps to
 * `NET_RATE_LIMITED` and 5xx maps to `NET_UNREACHABLE` (the endpoint is up
 * but not currently serving requests); both are retryable. Other statuses
 * keep the existing `HTTP_ERROR_<status>` code for backward compatibility.
 */
function httpStatusError(operation: string, status: number, detail: string): PocketPayError {
  const msg = detail
    ? `${operation} failed with status ${status}: ${detail}`
    : `${operation} failed with status ${status}`;

  if (status === 429) {
    const spec = ERROR_CODES[ErrorCode.NET_RATE_LIMITED];
    return new PocketPayError(
      msg,
      ErrorCode.NET_RATE_LIMITED,
      { statusCode: status, category: spec.category, safeMessage: spec.safeMessage },
      undefined,
      true,
    );
  }

  if (status >= 500) {
    const spec = ERROR_CODES[ErrorCode.NET_UNREACHABLE];
    return new PocketPayError(
      msg,
      ErrorCode.NET_UNREACHABLE,
      { statusCode: status, category: spec.category, safeMessage: spec.safeMessage },
      undefined,
      true,
    );
  }

  return new PocketPayError(msg, `HTTP_ERROR_${status}`, status);
}

/**
 * Infers the lifecycle stage from the operation label a caller already passes.
 *
 * Every timeout in the SDK flows through {@link withTimeout}, whose first
 * argument names the operation. That name was only ever interpolated into the
 * message, so the stage the caller already knew was discarded. Call sites may
 * also state the stage explicitly, which always wins.
 */
export function inferTimeoutStage(operation: string): TimeoutStage {
  const label = operation.toLowerCase();
  if (label.includes('submission')) return 'submission';
  if (label.includes('status request') || label.includes('confirmation')) return 'confirmation';
  if (
    label.includes('account lookup') ||
    label.includes('simulation') ||
    label.includes('preparation')
  ) {
    return 'preparation';
  }
  return 'unknown';
}

/**
 * Builds the timeout error for an operation, carrying its stage.
 *
 * Submission and confirmation timeouts leave the transaction's outcome
 * genuinely unknown — it may already be on-chain — so they are reported as
 * `TX_STATUS_UNKNOWN`, which `isUnknownStatusError()` recognises. Every other
 * stage keeps the long-standing `REQUEST_TIMEOUT` code so existing consumers
 * are unaffected.
 *
 * Note these are deliberately **not** mapped to `NET_TIMEOUT`: that code is
 * `retryable: true`, and blindly resubmitting a payment whose outcome is
 * unknown risks paying twice.
 */
function timeoutError(
  operation: string,
  timeoutMs: number,
  stage: TimeoutStage = inferTimeoutStage(operation),
): PocketPayError {
  const outcomeUnknown = stage === 'submission' || stage === 'confirmation';
  const code = outcomeUnknown ? ErrorCode.TX_STATUS_UNKNOWN : 'REQUEST_TIMEOUT';
  const spec = outcomeUnknown
    ? ERROR_CODES[ErrorCode.TX_STATUS_UNKNOWN]
    : ERROR_CODES[ErrorCode.REQUEST_TIMEOUT];

  return new PocketPayError(
    `${operation} timed out after ${timeoutMs}ms`,
    code,
    {
      category: spec.category,
      safeMessage: spec.safeMessage,
      timeout: { stage, operation, timeoutMs },
    },
  );
}

/**
 * Applies SDK timeout handling to promise-based network operations.
 */
export function withTimeout<T>(
  operation: string,
  timeoutMs: number | undefined,
  request: Promise<T>,
  stage?: TimeoutStage,
): Promise<T> {
  const effectiveTimeoutMs = timeoutMs ?? FALLBACK_TIMEOUT_MS;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(timeoutError(operation, effectiveTimeoutMs, stage)),
      effectiveTimeoutMs,
    );
  });

  return Promise.race([request, timeout]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

/**
 * Fetch wrapper that aborts when AbortController is available and otherwise
 * still rejects with the same timeout error for older runtimes.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit | undefined,
  operation: string,
  timeoutMs: number | undefined,
): Promise<Response> {
  const effectiveTimeoutMs = timeoutMs ?? FALLBACK_TIMEOUT_MS;

  if (typeof AbortController === 'undefined') {
    return withTimeout(operation, effectiveTimeoutMs, fetch(url, init));
  }

  const controller = new AbortController();
  let abortedByTimeout = false;
  const timeoutId = setTimeout(() => {
    abortedByTimeout = true;
    controller.abort();
  }, effectiveTimeoutMs);
  const abortFromCaller = () => controller.abort();
  init?.signal?.addEventListener('abort', abortFromCaller);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (abortedByTimeout) {
      throw timeoutError(operation, effectiveTimeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    init?.signal?.removeEventListener('abort', abortFromCaller);
  }
}

/**
 * Typed network client for making HTTP requests with consistent error handling,
 * timeout management, and response parsing.
 */
export class NetworkClient {
  private readonly baseUrl: string | undefined;
  private readonly defaultTimeoutMs: number;

  constructor(options?: { baseUrl?: string; defaultTimeoutMs?: number }) {
    this.baseUrl = options?.baseUrl;
    this.defaultTimeoutMs = options?.defaultTimeoutMs ?? FALLBACK_TIMEOUT_MS;
  }

  /**
   * Performs a GET request and parses the JSON response.
   */
  async get<T>(
    path: string,
    options?: {
      timeoutMs?: number;
      headers?: Record<string, string>;
      operation?: string;
    },
  ): Promise<T> {
    return this.request<T>(path, {
      method: 'GET',
      ...options,
    });
  }

  /**
   * Performs a POST request with JSON body and parses the JSON response.
   */
  async post<T>(
    path: string,
    body?: unknown,
    options?: {
      timeoutMs?: number;
      headers?: Record<string, string>;
      operation?: string;
    },
  ): Promise<T> {
    return this.request<T>(path, {
      method: 'POST',
      body,
      ...options,
    });
  }

  /**
   * Performs a generic HTTP request with JSON parsing and error handling.
   */
  private async request<T>(
    path: string,
    options: {
      method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
      body?: unknown;
      timeoutMs?: number;
      headers?: Record<string, string>;
      operation?: string;
    },
  ): Promise<T> {
    const url = this.baseUrl ? `${this.baseUrl}${path}` : path;
    const operation = options.operation || `${options.method} ${path}`;
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...options.headers,
    };

    const init: RequestInit = {
      method: options.method,
      headers,
    };

    if (options.body !== undefined) {
      init.body = JSON.stringify(options.body);
    }

    try {
      const response = await fetchWithTimeout(
        url,
        init,
        operation,
        timeoutMs,
      );

      if (!response.ok) {
        let errorBody: unknown;
        try {
          errorBody = await response.json();
        } catch {
          errorBody = await response.text();
        }
        const bodyStr =
          typeof errorBody === 'string'
            ? errorBody
            : (errorBody as any)?.detail || (errorBody as any)?.message || '';
        throw httpStatusError(operation, response.status, bodyStr);
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof PocketPayError) {
        throw error;
      }
      // A socket/DNS-level code means the endpoint itself is unreachable,
      // as opposed to a request that reached the server and failed there.
      if (error instanceof Error && UNREACHABLE_ERROR_CODES.has(nativeErrorCode(error) ?? '')) {
        throw unreachableError(operation, error);
      }
      throw wrapError(error, operation, 'NETWORK_ERROR');
    }
  }
}

/**
export { executeHorizonOperation, executeSorobanOperation } from './operations';

/** Result of an endpoint reachability probe. Contains no request/response bodies. */
export interface EndpointReachability {
  url: string;
  reachable: boolean;
  latencyMs?: number;
  /** Typed error code when unreachable (e.g. NET_UNREACHABLE, REQUEST_TIMEOUT). */
  errorCode?: string;
}

/**
 * Probes an endpoint with a lightweight GET and reports whether it responded,
 * without exposing response bodies, headers, or request payloads. Any HTTP
 * status (including 4xx/5xx) counts as "reachable" — this checks connectivity,
 * not application-level success.
 *
 * @param url - Endpoint to probe (e.g. a resolved Horizon or Soroban RPC URL)
 * @param timeoutMs - Probe timeout in milliseconds (default: 5000)
 */
export async function checkEndpointReachability(
  url: string,
  timeoutMs = 5_000,
): Promise<EndpointReachability> {
  const startedAt = Date.now();
  const reportUrl = redactEndpointUrl(url);
  try {
    await fetchWithTimeout(url, { method: 'GET' }, 'Endpoint reachability probe', timeoutMs);
    return { url: reportUrl, reachable: true, latencyMs: Date.now() - startedAt };
  } catch (error) {
    // A PocketPayError (e.g. REQUEST_TIMEOUT) already carries a typed code.
    // Any other rejection (ECONNREFUSED, ENOTFOUND, etc.) means the socket
    // or DNS lookup itself failed, which we surface uniformly as unreachable.
    const code = error instanceof PocketPayError ? error.code : ErrorCode.NET_UNREACHABLE;
    return { url: reportUrl, reachable: false, latencyMs: Date.now() - startedAt, errorCode: code };
  }
}

export { submitTransactionIdempotently, pollTransactionStatus } from './idempotency';
export { withRetryPolicy } from './retry-policy';
export { fetchFeeEstimate } from './fee';
export { executeHorizonOperation, executeSorobanOperation } from './operations';
