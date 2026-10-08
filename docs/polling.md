# Transaction Polling

`pollTransaction` checks Horizon for a submitted transaction by hash. It only
performs read-only status lookups: it never submits or resubmits the transaction.

```ts
import { pollTransaction } from 'stellar-pocketpay-sdk';

const controller = new AbortController();

const result = await pollTransaction(txHash, {
  interval: 2_000,
  timeout: 30_000,
  maxAttempts: 15,
  signal: controller.signal,
});

if (result.state === 'confirmed') {
  console.log('Confirmed', result.transaction);
} else if (result.state === 'failed') {
  console.error('Failed on ledger', result.transaction);
} else if (result.state === 'pending') {
  console.warn('Still pending when polling stopped');
} else {
  console.warn('Status could not be determined', result.error);
}
```

## Result model

The result intentionally exposes two related fields:

- `state`: `confirmed | failed | pending | unknown` -- the last ledger state
  observed.
- `status`: `success | failure | timeout | unknown` -- the backwards-compatible
  completion status of the polling operation.
- `attempts`: number of Horizon status lookups performed.

Before contacting Horizon, the helper requires a valid 64-character hexadecimal
transaction hash. Empty, non-string, malformed and secret-like inputs return
`status: 'unknown'`, `state: 'unknown'`, `attempts: 0` and an empty reported
hash. This prevents invalid hashes from being mislabelled `pending` and does
not repeat caller-provided secrets in diagnostics. Hostile provider error
getters/proxies are treated as unknown with fixed safe error text, never
transaction settlement evidence.

A Horizon `404 Not Found` means the transaction is not visible in a ledger yet,
so it is treated as `pending` and polling continues. Retryable lookup failures,
such as rate limiting or an indeterminate network timeout, remain inside the
same attempt and time bounds and do not erase a previously observed ledger
state. Only a Horizon record whose transaction hash matches the **requested hash** and whose `successful` field is a real boolean can establish `confirmed` or `failed`. Mismatched hashes, missing response objects, and malformed success flags are **unknown**, not evidence of settlement; polling may retry them within its existing attempt and deadline limits. Non-retryable transport lookup failures map to `unknown`. This protection does not submit or retry a transaction.

When polling stops because of `timeout` or `maxAttempts`, inspect `state` to
distinguish a transaction that was still pending from an indeterminate network
status.

## Bounds and cancellation

- `interval` defaults to 2 seconds.
- `timeout` defaults to 30 seconds and is a wall-clock bound, including time
  spent waiting for the active Horizon lookup.
- Responses arriving after that deadline are ignored. Long timing values use
  bounded timer chunks so Node's timer limit cannot expire them prematurely.
- `maxAttempts` is optional. When omitted, a safe bound is derived from
  `timeout / interval`, preserving the existing time-based behaviour.
- `signal` accepts an `AbortSignal`. Aborting rejects with an `AbortError`
  and stops scheduling further status lookups.
- Positive finite timing and attempt values are rounded down to integers with
  a minimum of one; other values use the documented defaults or derived bound.

Cancellation only affects polling. It does not cancel, retry, or resubmit the
original transaction. A lookup already in progress may finish in the underlying
Horizon transport, but its late result cannot restart or change the completed poll.
