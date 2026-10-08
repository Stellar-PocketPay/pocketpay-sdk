# Transaction Queue

PocketPay's transaction queue is an **in-process FIFO coordination primitive** for
applications that need to serialize payment or vault work for the same signing
account.

It complements the SDK's transaction lifecycle and sequence-safety helpers. It
does not replace them: the queue controls local callback order, while Stellar
sequence values, guarded submission, status reconciliation, and idempotency are
still handled by the transaction/network layers.

## When to use it

Use one shared queue for work that competes for the same Stellar account
sequence, for example:

- two payment requests triggered close together;
- a payment followed by a vault action from the same signer;
- mobile UI actions that must remain ordered while the first request is still
  awaiting network state.

Do not create a new queue per button press. Separate queue instances do not
coordinate with each other.

## Public API

```ts
import {
  createTransactionQueue,
  type TransactionQueueHandle,
  type TransactionQueueResult,
  type TransactionQueueSnapshot,
  type TransactionQueueState,
} from 'stellar-pocketpay-sdk';
```

Queue states are:

| State | Meaning |
| --- | --- |
| `queued` | Accepted locally and waiting for every earlier item. |
| `running` | The callback has started. It may already have performed network I/O. |
| `completed` | The callback returned a value. This does **not** by itself mean an on-chain transaction was confirmed. |
| `failed` | The callback threw; the error is captured in the queue result and later items continue. |
| `cancelled` | The item was removed before its callback started. |

## FIFO ordering

`enqueue()` assigns a monotonic local sequence and starts callbacks strictly in
that order. Only one callback runs at a time.

```ts
const queue = createTransactionQueue();

const first = queue.enqueue(
  () => sendFirstPayment(),
  { id: 'checkout:104:first' },
);

const second = queue.enqueue(
  () => sendSecondPayment(),
  { id: 'checkout:104:second' },
);

const firstResult = await first.result;
const secondResult = await second.result;
```

The second callback will not start until the first callback has settled, even
when the first callback fails.

### Build with fresh network state

Enqueue the *operation*, not an already-built envelope. Fetching sequence/fee
state too early can make a transaction stale before it reaches the front of the
queue.

Good:

```ts
queue.enqueue(
  () => enhancedSendXLM(
    {
      sourceSecret,
      destination,
      amount,
      memo,
    },
    sdkConfig,
  ),
  { id: `payment:${paymentIntentId}` },
);
```

Avoid building and signing several envelopes first and merely queueing their
submission. Use the existing lifecycle/sequence helpers at execution time.

## Cancellation semantics

Cancellation is deliberately narrow:

```ts
const handle = queue.enqueue(
  () => enhancedSendXLM(params, sdkConfig),
  { id: 'payment:104' },
);

// Works only while state === 'queued'.
const cancelled = handle.cancel();
```

- A queued item can be cancelled and its callback never runs.
- A running item cannot be cancelled through this API; `cancel()` returns
  `false`.
- A completed/failed/cancelled item stays terminal.
- `clearPending()` cancels every item that has not started.

This boundary is intentional. Once a callback starts, it may have built, signed,
or submitted a transaction. Stopping JavaScript work cannot prove the Stellar
transaction was cancelled. If submission status is unknown, use the SDK's
status-reconciliation/polling path rather than treating local cancellation as an
on-chain rollback.

## Failure handling

Queue terminal state describes the **local callback**, not the final ledger
state.

```ts
const handle = queue.enqueue(
  () => enhancedSendXLM(params, sdkConfig),
  { id: 'payment:105' },
);

const terminal = await handle.result;

if (terminal.state === 'failed') {
  // The callback threw before returning an SDK result.
  reportLocalFailure(terminal.error);
} else if (terminal.state === 'cancelled') {
  showCancelledBeforeStart();
} else {
  // The callback completed. Inspect the SDK-level result independently.
  if (terminal.value.ok) {
    showReceipt(terminal.value.value);
  } else {
    handlePaymentFailure(
      terminal.value.error,
      terminal.value.recoveryHints ?? [],
    );
  }
}
```

A `failed` item does not poison the queue. The next queued callback starts
after the failure is captured.

For transaction lifecycle APIs that can return an unresolved/unknown submission
state, a queue-level `completed` result still requires the application to
inspect that returned lifecycle value and poll before retrying.

## Stable IDs and observability

Optional IDs make queue state usable in UI/support tooling:

```ts
const handle = queue.enqueue(
  () => submitBusinessOperation(),
  {
    id: `invoice:${invoiceId}`,
    onStateChange(snapshot) {
      renderQueueState(snapshot.state);
    },
  },
);

console.log(handle.snapshot());
console.log(queue.listSnapshots());
```

IDs cannot be reused during the lifetime of a queue instance. State hooks are
best-effort: hook exceptions are ignored so logging/telemetry cannot interrupt
transaction ordering.

Snapshots expose local timestamps and enqueue sequence only. Never place secret
keys, signed XDR, raw transaction envelopes, authorization headers, or other
sensitive payloads in the queue ID or state hook.

## Consumer responsibilities and limits

The queue is intentionally local and non-durable:

- it does not coordinate across browser tabs, app processes, servers, or
  devices;
- it does not survive process restart;
- it does not reserve Stellar sequence numbers;
- it does not provide distributed locking;
- it does not make a non-idempotent operation idempotent;
- it cannot reverse a submitted transaction;
- it does not convert callback completion into ledger confirmation.

A backend with multiple workers needs a durable/distributed ordering mechanism
outside this SDK. Mobile and single-process applications should still refresh
network state when each queued callback begins.

## Payment and vault integration pattern

A single signer can share one queue across payment and vault work:

```ts
const queue = createTransactionQueue();

const payment = queue.enqueue(
  () => enhancedSendXLM(paymentParams, sdkConfig),
  { id: 'order:104:payment' },
);

const vault = queue.enqueue(
  () => depositToVault(vaultParams, sdkConfig),
  { id: 'order:104:vault-deposit' },
);

const paymentTerminal = await payment.result;
const vaultTerminal = await vault.result;
```

The vault callback cannot start until the payment callback settles locally.
Each callback remains responsible for its own validation, fresh sequence/network
state, signing, guarded submission, and result interpretation.

## Related guidance

- [Transaction Lifecycle ADR](./adr/0005-transaction-lifecycle.md)
- [Account Sequence & Concurrency Safety](./sequence-safety.md)
- [Safe Retry Policy](./retry-policy.md)
- [Signing Boundaries](./signing-boundaries.md)
- [Soroban Vault](./soroban-vault.md)
