# Account Sequence and Concurrent Submission Safety

Every Stellar transaction carries the source account's sequence number, and the
network accepts exactly one transaction per sequence value. This page documents
how the SDK fetches, refreshes and invalidates sequences, what happens when two
intents race for the same account, and how to recognise and recover from a
stale-sequence rejection.

See also [Retry Policy](./retry-policy.md) and [Idempotency](./idempotency.md) —
this page covers the failure they cannot handle.

## The hazard

Building a transaction reads the account's current sequence and produces an
envelope for `sequence + 1`. If two intents on the same account read before
either submits, both build for the same value. The first submission succeeds and
the second is rejected with `tx_bad_seq`.

This is not a transient failure. The rejected envelope is permanently invalid:
its sequence is spent. **Resubmitting it can never succeed.** The only recovery
is to read a fresh sequence, rebuild, and re-sign.

Preparation makes this easier to hit. `prepareTransactionOffline` deliberately
separates fetching network state from building, so a snapshot can sit unused
while other transactions consume the account's sequence.

## Recognising a stale sequence

`classifySubmitError` maps `tx_bad_seq` to the published code
`TX_BAD_SEQUENCE`. Every other transaction result code keeps its existing
`TX_FAILED` classification.

```ts
import { classifySubmitError, requiresRebuild } from 'stellar-pocketpay-sdk';

try {
  await sendXLM(params);
} catch (rawError) {
  const error = classifySubmitError(rawError);

  if (requiresRebuild(error)) {
    sequences.invalidate(sourcePublicKey);
    await sendXLM(params); // rebuilt against a fresh sequence
  }
}
```

### Rebuild is not retry

`retryable`, `isRetryableError()` and `isSafeToRetry()` all mean *"the same
signed envelope may be sent again"*. A `TX_BAD_SEQUENCE` failure is **never**
safe to resubmit, so it is deliberately **not** marked retryable — treating it
as retryable would send a consumer into a resubmit loop that can never succeed.

Use `requiresRebuild(error)` to branch on it. The two concepts are separate:

| Helper | Question it answers |
| --- | --- |
| `isSafeToRetry(outcome)` | May I send this same envelope again? |
| `requiresRebuild(error)` | Must I build a new envelope from fresh state? |

## SequenceProvider

`SequenceProvider` caches sequence reads with a freshness marker and, on
request, serializes the intents that consume them.

```ts
import { SequenceProvider } from 'stellar-pocketpay-sdk';

const sequences = new SequenceProvider({ maxAgeMs: 15_000 });

const snapshot = await sequences.get(publicKey);
// { publicKey, sequence: '1234', fetchedAt: 1753650000000 }
```

| Method | Behaviour |
| --- | --- |
| `get(publicKey)` | Cached read; goes to Horizon when absent or stale. |
| `refresh(publicKey)` | Forces a re-read, replacing the cached value. |
| `invalidate(publicKey?)` | Drops one account, or all when called with no argument. |
| `peek(publicKey)` | Returns the cached snapshot without touching the network. |
| `loadAccount(publicKey)` | Returns a `StellarSDK.Account` ready for `TransactionBuilder`. |
| `withSequence(publicKey, task)` | Runs `task` with exclusive access to the account. |

Pass `maxAgeMs: 0` to disable caching and always read from Horizon.

## Serializing concurrent intents

`withSequence` runs tasks for one account one at a time and invalidates the
cached sequence after each, so the next task reads the account's real state.

```ts
await Promise.all([
  sequences.withSequence(publicKey, () => sendXLM(paymentA)),
  sequences.withSequence(publicKey, () => sendXLM(paymentB)),
]);
```

Different accounts do not block each other, and a failing task does not cascade
into the ones queued behind it — each caller sees only its own rejection.

### End-to-end lifecycle safety

`executeTransactionLifecycle(params, secretKey, options, config)` now uses
the SDK's shared `defaultSequenceProvider.withSequence(params.sourcePublicKey, ...)`
around its entire prepare/build/sign/guarded-submit sequence. Two concurrent
calls within one process for the **same** account no longer build against the
same pre-submit Horizon sequence; the next call waits until the previous
submission/polling attempt completes, then re-reads network state. Calls for
different accounts remain independent.

This uses the already-shipped `SequenceProvider`, not a second lock or a
sequence-number allocator. The guarded end-to-end API is exported from the
package root, so application code can use it without importing private
`src/transactions/orchestrator` internals:

```ts
import { executeTransactionLifecycle } from 'stellar-pocketpay-sdk';

const outcome = await executeTransactionLifecycle(params, signerSecret);
if (outcome.state === 'unresolved') {
  // Poll the original transaction hash before starting another same-account intent.
}
```

Standalone `bindAndBuild`, manually assembled transactions, and one-shot
helpers still require callers to use a shared `SequenceProvider.withSequence`
explicitly if they may race with other intents. Exporting the lifecycle entry
point does not extend the sequence lock across processes or resolve unknown
network outcomes automatically.

**Horizon response identity is now authoritative.** The guarded lifecycle no
longer calls a response `confirmed` merely because it contains some hash or
because a local envelope hash can be computed. The returned hash must match
the exact signed transaction, and `successful` must be an explicit boolean
from Horizon. A matching `successful: false` is `rejected` and requires
rebuilding; a missing, malformed, conflicting, or incomplete response is
`unresolved` and requires status polling before any resubmission. A matching
`successful: true` is the only confirmed success path. This guards against
unrelated ledger records and unknown transaction status being presented to a
confirmation UI as settled.

**Unknown submission status is not a successful settlement.** When the lifecycle
returns `state: 'unresolved'` / `actionRequired: 'poll'`, do not initiate another
same-account intent until the previous transaction hash has been resolved
against the ledger. The process-local queue serializes calls but cannot make
an unresolved ledger outcome final. Cross-process and externally submitted
transactions still need separate coordination.

### ⚠️ The guarantee is per process

`withSequence` is backed by an in-memory promise chain. It coordinates intents
**inside a single process only**. It does not coordinate across workers,
containers, or machines.

If more than one process submits for the same account, you still need external
coordination — a distributed lock, a single-writer service, or one dedicated
account per worker. This SDK does not provide that, and no setting here makes
the in-memory chain safe across processes.

### Why sequences are not pre-allocated

Handing each caller `sequence + 1`, `sequence + 2`, … without waiting would
avoid serializing. It is not done here: a single failed submission leaves a gap,
and every later transaction in the batch becomes permanently invalid. Re-reading
after each use is slower and correct.

## Stale snapshots in offline preparation

`NetworkState` records `fetchedAt` when the sequence comes from
`fetchNetworkState`. It is absent when the sequence is supplied manually — the
caller owns freshness in that case.

```ts
import { isPreparedSequenceStale, buildUnsignedTransaction } from 'stellar-pocketpay-sdk';

if (isPreparedSequenceStale(prepared, 10_000)) {
  const fresh = await fetchNetworkState(publicKey);
  prepared = updateWithNetworkState(prepared, fresh);
}
```

Building can also enforce freshness directly. This is **off by default**, so
existing callers are unaffected:

```ts
buildUnsignedTransaction(prepared, {
  enforceSequenceFreshness: true,
  maxSequenceAgeMs: 10_000,
});
```

With enforcement on, a stale snapshot is rejected with `TX_BAD_SEQUENCE` and
`validation.reason === 'stale'` before the envelope is built, instead of failing
at submission.

Manually supplied sequences are validated as unsigned integers via
`validateSequenceValue`, so a malformed value is rejected at preparation time
rather than surfacing as an opaque submission failure.

## Safe usage patterns

1. **One writer per account.** The simplest safe design: never submit for the
   same account from two places at once.
2. **Serialize within a process** with `withSequence` when you cannot avoid
   concurrent intents.
3. **Invalidate after every submission**, successful or not, so the next intent
   reads real state.
4. **Branch on `requiresRebuild`**, not on retryability, when handling failures.
5. **Keep preparation windows short.** The longer a prepared transaction waits,
   the likelier its sequence is spent — enforce freshness if it may wait.
6. **Across processes, coordinate externally.** Nothing in this SDK makes
   multi-process submission on one account safe by itself.

## See also

- [Retry Policy](./retry-policy.md) — retrying failures that *are* retryable.
- [Idempotency](./idempotency.md) — avoiding duplicate submissions.
- [Error Standard](./error-standard.md) — the published error code registry.
- [Offline Transaction Preparation](./offline-transaction-preparation.md)
