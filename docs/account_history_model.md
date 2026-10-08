# SDK Account Activity Normalisation & History Model

The SDK exposes a single, display-oriented account activity record that can combine existing transaction history, payment operations, submission receipts, and vault results without exposing raw Horizon/RPC payloads.

## Public API

- `mapTransactionSummaryToActivity(record, account)`
- `mapPaymentSummaryToActivity(record, account)`
- `mapPaymentReceiptToActivity(receipt, account)`
- `mapVaultResultToActivity({ result, createdAt })`
- `normalizeAccountActivity({ account, transactions, payments, receipts, vault })`
- `filterAccountActivity(records, filter)`

`AccountActivityRecord` carries a stable source-derived ID, activity kind, status, direction, timestamp, source family, and optional transaction hash / amount / asset / counterparty / memo / operation fields.

## Status rules

The model reuses `TransactionStatus`; it does not create a competing outcome taxonomy.

| Source | Mapping |
| --- | --- |
| Horizon payment history | `completed` (the operation already exists on-ledger) |
| Transaction summary | explicit `status` first; otherwise `successful=true/false` -> `completed/failed`; missing outcome -> `unknown` |
| Payment receipt | preserves `completed`, `pending`, `failed`, or `unknown` exactly |
| Vault result | `success -> completed`, `pending -> pending`, terminal error variants -> `failed` |

Unknown submission state is intentionally **not** rendered as failure. Consumers should preserve the receipt's `actionRequired` behavior in their transaction workflow and poll when the originating receipt says the status is unknown.

Malformed/unrecognized runtime status values become `unknown`, not a new arbitrary status. A transaction record saying both `status: completed` and `successful: false` (or the converse) becomes `unknown` rather than reporting contradictory ledger finality. Vault results must agree between `success` and `status` before a result is rendered completed or failed; conflicting flags remain `unknown` until reconciled.

## Direction rules

Payment history is relative to the supplied account:

- `from === account` -> outgoing
- `to === account` -> incoming
- self-payment -> self
- unrelated/incomplete records -> neutral

Transaction summaries prefer an explicit mapper direction. When it is absent, `sourceAccount === account` establishes outgoing activity; a different source alone **does not establish incoming** because the transaction may contain unrelated operations, so the direction stays neutral. Use actual payment-operation `from`/`to` fields or an explicitly mapped transaction direction to establish received activity. Vault deposits are outgoing, withdrawals incoming, and balance reads neutral.

**Receipts carry a destination but no source-account identity.** A receipt addressed to the displayed account therefore cannot prove a *self* transfer; it stays `neutral` and does not invent a counterparty. A different destination is displayed as outgoing under the caller's convention that these are that account's own submitted receipts; do not use receipt direction as independent account-ownership or ledger evidence. Use Horizon payment records for confirmed sender/receiver identity.

## Deterministic history

`normalizeAccountActivity` combines supplied arrays and sorts valid ISO timestamps newest-first. Invalid/equal timestamps preserve insertion order. No random ID or current clock is used.

Vault results have no timestamp in their existing public type, so the caller must provide `createdAt`; the normalizer does not invent one.

For list reconciliation, known transaction-hash receipts retain their `receipt:<hash>` identity. Hashless pending receipts instead derive a deterministic fingerprint from timestamp and observable receipt fields, so simultaneous distinct submissions do not all share the same UI key; memo/destination text is not embedded verbatim. Identical hashless source records cannot be distinguished without a real upstream identifier. Vault activities with a shared transaction hash include the vault operation in the ID (`vault:<hash>:<operation>`) so a deposit and withdrawal in one transaction remain separate rows.

## Example

```ts
const history = normalizeAccountActivity({
  account: wallet.publicKey,
  transactions: transactionPage.records,
  payments: paymentPage.records,
  receipts: pendingReceipts,
  vault: [
    { result: lastVaultResult, createdAt: vaultObservedAt },
  ],
});

const unresolved = filterAccountActivity(history, {
  status: TransactionStatus.PENDING,
});
```

## Display guidance and limitations

- Treat display `amount` as a decimal string; do not round it through JavaScript `number`. `TransactionSummary.amount` is in smallest units, so activity records use `amountDisplay` as display `amount` and preserve the original units as `rawAmount`. If `amountDisplay` is missing, display `amount` is omitted; never present `rawAmount` as an already scaled quantity.
- `assetIssuer` is present only where the source record provides one.
- A plain transaction history row may not include payment amount/counterparty details; fetch or supply payment operations when the UI needs those fields.
- A payment receipt is an attempt/result model, while Horizon payment history is confirmed ledger history. Both may refer to the same transaction hash; consumers that merge persistent history with transient receipts may deduplicate by transaction hash when that matches their product semantics.
- Vault `get_balance` is represented as neutral activity and uses the result balance as `amount`.
- Normalization is pure and local: it performs no network request, signing, submission, or polling.
