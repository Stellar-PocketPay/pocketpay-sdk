# Network Error Handling Guide

This guide helps PocketPay SDK consumers handle transient failures from Stellar network services correctly.

> See [Network Resilience Layer](./network-resilience.md) for the `NetworkClient`
> abstraction, endpoint diagnostics, and how read-only retries differ from
> transaction submission.

## Overview

Stellar network calls can fail for different reasons. Some failures are temporary and should be retried. Others indicate a problem with the request or account state and should be shown to the user.

**Submission safety:** The retry/backoff tables and sample below apply to read-only lookups and queries. For a signed transaction submission, HTTP 408/5xx, network drops, and timeouts can leave an *unknown result* even when the server later accepts the payment. Use the SDK's transaction-hash polling/idempotency helper before any new submission. See [Safe Retry Policy](./retry-policy.md).

## Retryable Errors (Read-Only Operations)

These errors are temporary. Retry with exponential backoff (start at 1s, double each retry, max 5 attempts).

### Horizon

| Status | Meaning | Action |
|--------|---------|--------|
| 429 Too Many Requests | Rate limited | Retry after Retry-After header duration |
| 503 Service Unavailable | Horizon overloaded | Retry with backoff |
| 504 Gateway Timeout | Upstream timeout | Retry with backoff |
| ECONNRESET / ETIMEDOUT | Network interruption | Retry with backoff |
| REQUEST_TIMEOUT | SDK timeout during preparation or a plain read | Retry with backoff or increase `timeout` |
| 500 Internal Server Error | Transient Horizon issue | Retry once, then fail |
| NET_UNREACHABLE | Endpoint unreachable (5xx, ECONNREFUSED, DNS failure) — thrown by `NetworkClient`, `checkEndpointReachability` | Retry with backoff |
| NET_RATE_LIMITED | 429 — thrown by `NetworkClient` with the typed code instead of a raw HTTP status | Retry after Retry-After |

### Friendbot

| Error | Meaning | Action |
|-------|---------|--------|
| 429 Too Many Requests | Friendbot rate limit per address | Wait then retry |
| 503 Service Unavailable | Friendbot overloaded | Retry with backoff |
| ECONNREFUSED | Friendbot not reachable | Retry with backoff |
| REQUEST_TIMEOUT | SDK timeout during preparation or a plain read | Retry with backoff or increase `timeout` |

### Soroban RPC

| Status | Meaning | Action |
|--------|---------|--------|
| 429 Too Many Requests | RPC rate limited | Retry after Retry-After |
| 503 Service Unavailable | RPC overloaded | Retry with backoff |
| ECONNRESET / ETIMEDOUT | Network interruption | Retry with backoff |
| REQUEST_TIMEOUT | SDK timeout during preparation or a plain read | Retry with backoff or increase `timeout` |
| sendTransaction timeout | Transaction not yet confirmed | Poll getTransaction with backoff |

## Non-Retryable Errors

These errors indicate a problem the user or developer must fix. Do not retry.

### Horizon

| Status | Meaning | Action |
|--------|---------|--------|
| 400 Bad Request | Malformed request | Fix request parameters |
| 404 Not Found | Account or resource does not exist | Fund account first or check resource |
| 401 Unauthorized | Invalid or missing API key | Check API key configuration |
| 403 Forbidden | Access denied | Check permissions |

### Soroban RPC

| Status | Meaning | Action |
|--------|---------|--------|
| 400 Bad Request | Invalid transaction envelope | Fix transaction before submitting |
| 422 Unprocessable Entity | Transaction simulation failed | Check contract arguments |
| sendTransaction FAILED | Transaction execution failed | Check contract state and inputs |

## Transaction Submission Failures

| Error | Retryable | Action |
|-------|-----------|--------|
| tx_bad_seq | No | Use correct sequence number |
| tx_insufficient_balance | No | Fund source account |
| tx_insufficient_fee | No | Increase fee |
| tx_too_late | No | Rebuild with updated ledger bounds |
| tx_bad_auth | No | Check signatures |
| Timeout, HTTP 408/5xx or connection reset during submission | **Unknown — do not resubmit yet** | Poll transaction hash until confirmed, expired or explicitly rejected |
| TX_STATUS_UNKNOWN | **No** | SDK timeout during submission or confirmation — the outcome is undetermined. Poll before resending; see [Timeout Classification](./timeout-classification.md) |

## Example: Retry with Backoff (Read-only Calls Only)

Do not wrap transaction submission in this generic retry helper; use `submitTransactionIdempotently` / `withRetryPolicy` instead.

async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries = 5,
  baseDelayMs = 1000
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      if (attempt === maxRetries) throw error;
      if (isRetryable(error)) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        console.warn('Retryable error, retrying in ' + delay + 'ms:', error.message);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        throw error;
      }
    }
  }
  throw new Error('Max retries exceeded');
}

function isRetryable(error: any): boolean {
  if (error.status === 429 || error.status === 503 || error.status === 504) return true;
  if (error.code === 'REQUEST_TIMEOUT') return true;
  if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.code === 'ECONNREFUSED') return true;
  return false;
}

## Rate Limiting

Horizon and Soroban RPC enforce rate limits. When rate limited:
- Check the Retry-After header for wait duration
- Wait the specified time before retrying
- Consider implementing client-side throttling for high-volume applications

## Account Not Found

A 404 on account lookup means the account does not exist on the network. Fund it via Friendbot (testnet) or an exchange (mainnet) before retrying.
