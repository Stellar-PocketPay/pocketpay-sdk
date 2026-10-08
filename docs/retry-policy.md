# Safe Retry Policy

This guide explains how to retry failed or uncertain transaction submissions without risking duplicate payments.

---

## The problem: unknown submission outcomes

When submitting a signed transaction to Stellar, the request can fail in three fundamentally different ways:

1. **Definite pre-processing rejection** — Horizon explicitly rate-limited the request (429) without processing it. The same signed envelope can be retried after backoff.
2. **Definitive rejection** — Horizon received the transaction and rejected it (`tx_bad_seq`, `tx_insufficient_balance`, etc.). Resubmitting the same envelope will always fail with the same result. You must build a new transaction.
3. **Unknown outcome** — a request timeout, HTTP 408 or 5xx (including 503), or connection drop occurred around submission. Horizon may already have accepted the envelope. **Poll by transaction hash first; do not treat a 503 as a definite rejection or a direct retry signal.**

The SDK represents these three cases as a discriminated union called `SubmissionOutcome`.

---

## SubmissionOutcome

```typescript
import type { SubmissionOutcome } from '@axionvera/pocketpay-sdk';
```

| `kind` | Meaning | Safe to resubmit same envelope? |
|---|---|---|
| `"success"` | Transaction confirmed on-chain. | N/A |
| `"retryable_failure"` | Explicit pre-processing rate limit (429). Same signed envelope can be sent again after backoff. | **Yes** |
| `"non_retryable_failure"` | Definitive rejection or expiry. Build a new transaction. | **No** |
| `"unknown_status"` | Timeout, network drop, or HTTP 408/5xx around submission. Must poll Horizon before deciding. | **No — poll first** |

### Checking outcomes

```typescript
import {
  classifySubmissionOutcome,
  isSafeToRetry,
  requiresStatusCheck,
  classifySubmitError,
  pollTransactionStatus,
} from '@axionvera/pocketpay-sdk';

// After a raw submission attempt:
try {
  await server.submitTransaction(tx);
  // success — build outcome manually
  const outcome = classifySubmissionOutcome(undefined, tx.hash().toString('hex'));
} catch (rawError) {
  const classified = classifySubmitError(rawError, tx.hash().toString('hex'));
  const outcome = classifySubmissionOutcome(classified);

  switch (outcome.kind) {
    case 'retryable_failure':
      // isSafeToRetry(outcome) === true
      // outcome.suggestedDelayMs gives a minimum wait in ms
      break;

    case 'non_retryable_failure':
      // Build a new transaction — the current envelope will never succeed
      break;

    case 'unknown_status':
      // requiresStatusCheck(outcome) === true
      // Poll before doing anything else
      const txRecord = await pollTransactionStatus(tx, { maxPollAttempts: 10 });
      break;
  }
}
```

### Helper predicates

```typescript
isSafeToRetry(outcome)       // true only for "retryable_failure"
requiresStatusCheck(outcome) // true only for "unknown_status"
```

---

## withRetryPolicy — automated safe retry loop

`withRetryPolicy` wraps `submitTransactionIdempotently` and applies structured exponential back-off. It respects the submission-safety contract automatically:

- **retryable_failure** → waits and retries (up to `maxAttempts` total).
- **non_retryable_failure** → throws immediately without further attempts.
- **unknown_status** → delegates to `submitTransactionIdempotently`'s internal status polling; **never blindly resubmits the envelope**.

```typescript
import { withRetryPolicy } from '@axionvera/pocketpay-sdk';

const result = await withRetryPolicy(signedTx, {
  maxAttempts: 4,         // includes the first attempt (default: 4)
  initialBackoffMs: 1000, // delay before attempt 2 (default: 1 000 ms)
  maxBackoffMs: 16000,    // back-off ceiling (default: 16 000 ms)
  backoffMultiplier: 2,   // doubles each retry (default: 2)
  jitter: true,           // add randomness to avoid thundering herd (default: true)
});

console.log('Confirmed in ledger', result.ledger);
```

### RetryPolicy fields

| Field | Type | Default | Description |
|---|---|---|---|
| `maxAttempts` | `number` | `4` | Total attempts including the first. Set to `1` to disable retries. |
| `initialBackoffMs` | `number` | `1000` | Delay in ms before the second attempt. |
| `maxBackoffMs` | `number` | `16000` | Upper cap on the inter-attempt delay. |
| `backoffMultiplier` | `number` | `2` | Multiplier applied per retry (`initialBackoffMs × multiplier^n`). |
| `jitter` | `boolean` | `true` | Randomises delay in `[0, computed]` to spread retries across clients. |
| `config` | `Partial<SDKConfig>` | — | SDK config overrides forwarded to Horizon calls. |
| `onAttempt` | `(attempt, outcome, delayMs) => void` | — | Callback invoked after every failed attempt. |

### Handling exhaustion

When all attempts are consumed (or a non-retryable/unknown outcome terminates the loop early), `withRetryPolicy` throws a `PocketPayError`. The error carries an `exhaustedResult` property with full context:

```typescript
import {
  withRetryPolicy,
  PocketPayError,
  type RetryPolicyExhaustedResult,
} from '@axionvera/pocketpay-sdk';

try {
  await withRetryPolicy(signedTx, { maxAttempts: 4 });
} catch (error) {
  if (error instanceof PocketPayError && (error as any).exhaustedResult) {
    const { finalOutcome, attempts, error: lastError }
      = (error as any).exhaustedResult as RetryPolicyExhaustedResult;

    switch (finalOutcome) {
      case 'non_retryable_failure':
        // Transaction was definitively rejected.
        // Inspect lastError.code (e.g. 'PAYMENT_FAILED') for the reason.
        // Build a new transaction before retrying.
        console.error(`Rejected after ${attempts} attempt(s):`, lastError.message);
        break;

      case 'unknown_status':
        // Polling could not confirm whether the transaction landed.
        // DO NOT resubmit. Check the block explorer with lastError.transactionHash.
        console.error(
          `Status unknown for hash ${lastError.transactionHash}. Check explorer before retrying.`,
        );
        break;

      case 'retryable_failure':
        // Transient errors persisted through all retries.
        // Wait longer, then retry, or surface the failure to the user.
        console.error(`Transient error persisted through ${attempts} attempt(s).`);
        break;
    }
  }
}
```

### Progress logging with onAttempt

```typescript
await withRetryPolicy(signedTx, {
  maxAttempts: 4,
  onAttempt(attempt, outcome, delayMs) {
    if (outcome.kind === 'retryable_failure') {
      console.warn(`Attempt ${attempt} failed (${outcome.error.code}). Retrying in ${delayMs}ms…`);
    }
  },
});
```

---

## Outcome decision tree

```
Submission attempt
       │
       ├─ Success ──────────────────────────────────► Return result ✓
       │
       ├─ retryable_failure ────────────────────────► Backoff → retry
       │  (429, 503, transient errors)                (up to maxAttempts)
       │
       ├─ non_retryable_failure ────────────────────► Throw immediately ✗
       │  (PAYMENT_FAILED, TX_EXPIRED, bad_seq…)      (rebuild required)
       │
       └─ unknown_status ───────────────────────────► Poll Horizon
          (504, ETIMEDOUT, ECONNRESET…)                │
                                                       ├─ Found ──────► Return result ✓
                                                       ├─ Expired ────► Throw TX_EXPIRED ✗
                                                       └─ Unresolved ► Throw TX_STATUS_UNKNOWN ✗
```

---

## No blind resubmission

The key safety guarantee is:

> **An `unknown_status` outcome is never resolved by sending the same transaction again.** Status is first confirmed via `pollTransactionStatus`. Only after the polling window closes without finding the transaction (and `TX_EXPIRED` confirms it cannot land) is it safe to build a new transaction.

This prevents double-spending in applications that retry automatically on timeout.

---

## Relationship to idempotency helpers

`withRetryPolicy` builds on top of the lower-level helpers:

| Helper | Purpose |
|---|---|
| `classifySubmitError` | Maps raw Horizon/network errors → `PocketPayError` with `code`, `retryable`, `transactionHash`. |
| `classifySubmissionOutcome` | Maps a `PocketPayError` → `SubmissionOutcome` discriminated union. |
| `isSafeToRetry` | Predicate for `retryable_failure`. |
| `requiresStatusCheck` | Predicate for `unknown_status`. |
| `submitTransactionIdempotently` | Submit + auto-poll on timeout. Used internally by `withRetryPolicy`. |
| `pollTransactionStatus` | Manual status polling by transaction hash. |
| `withRetryPolicy` | Full retry loop combining all of the above. |

See [Idempotency Strategy](./idempotency.md) for a deeper dive into the polling mechanism.

---

## When not to use withRetryPolicy

- **Simple fire-and-forget payments** that use `sendXLM` already handle errors via the standard `PocketPayError` pattern. `withRetryPolicy` is for callers that build and sign transactions manually and need fine-grained retry control.
- **Non-idempotent operations** — if your application logic is not idempotent (e.g. incrementing a counter), adding automatic retries without application-level deduplication may produce incorrect results even when the transaction hash guarantee holds at the Stellar layer.
- **High-frequency trading / automated systems** — consider implementing your own policy with a circuit breaker to avoid cascading retries under sustained Horizon degradation.
