# Transaction Summary Mapper API Reference

## Overview

The transaction summary mapper converts raw Stellar Horizon transactions into a simplified format suitable for mobile UI consumption.

## Types

### TransactionSummary

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Unique transaction identifier |
| `txHash` | `string` | Stellar transaction hash |
| `direction` | `'incoming' \| 'outgoing'` | Transaction direction relative to the user |
| `amount` | `string` | Amount in the asset's smallest unit |
| `amountDisplay` | `string` | Human-readable formatted amount |
| `asset` | `string` | Asset code (XLM, USDC, etc.) |
| `counterparty` | `string` | Address of the other party |
| `memo` | `string?` | Transaction memo |
| `status` | `'pending' \| 'completed' \| 'failed'` | Transaction status |
| `createdAt` | `string` | ISO timestamp of the transaction |
| `timeAgo` | `string` | Human-readable relative time |
| `fee` | `string?` | Fee paid for the transaction |
| `rawType` | `string?` | Raw transaction type from Horizon |

## Functions

### mapTransactionToSummary

Maps a single raw transaction to a summary.

```ts
function mapTransactionToSummary(
  rawTransaction: RawHorizonTransaction,
  options: TransactionMapperOptions
): TransactionSummary
const summary = mapTransactionToSummary(rawTx, {
  userAccount: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890',
  formatAmounts: true,
});

console.log(summary.amountDisplay); // "10.5000000"
console.log(summary.timeAgo); // "2 hours ago"
function mapTransactionsToSummaries(
  rawTransactions: RawHorizonTransaction[],
  options: TransactionMapperOptions
): TransactionSummary[]
const summaries = mapTransactionsToSummaries(rawTxs, {
  userAccount: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890',
});

summaries.forEach((summary) => {
  console.log(`${summary.direction}: ${summary.amountDisplay} ${summary.asset}`);
});
const TransactionList = ({ transactions }) => {
  const summaries = mapTransactionsToSummaries(transactions, {
    userAccount: currentUser.address,
    formatAmounts: true,
  });

  return (
    <ul>
      {summaries.map((tx) => (
        <li key={tx.id}>
          <span>{tx.direction === 'incoming' ? '📥' : '📤'}</span>
          <span>{tx.amountDisplay} {tx.asset}</span>
          <span>{tx.counterparty}</span>
          <span>{tx.timeAgo}</span>
        </li>
      ))}
    </ul>
  );
};
const TransactionDetail = ({ transaction }) => {
  const summary = mapTransactionToSummary(transaction, {
    userAccount: currentUser.address,
  });

  return (
    <div>
      <h2>Transaction Details</h2>
      <p>Hash: {summary.txHash}</p>
      <p>Amount: {summary.amountDisplay} {summary.asset}</p>
      <p>From: {summary.direction === 'incoming' ? summary.counterparty : 'You'}</p>
      <p>To: {summary.direction === 'outgoing' ? summary.counterparty : 'You'}</p>
      <p>Status: {summary.status}</p>
      <p>Date: {summary.createdAt}</p>
      {summary.memo && <p>Memo: {summary.memo}</p>}
    </div>
  );
};
```

### previewPayment

Previews a payment without signing or submitting a transaction. This helper performs synchronous validation on the input parameters (public keys, amount, memo, asset spec) and returns a typed preview object suitable for UI confirmation screens.

```ts
import { previewPayment } from 'stellar-pocketpay-sdk';

const preview = await previewPayment({
  sourceAccount: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890',
  destination: 'G1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  amount: '50.5',
  asset: { code: 'USDC', issuer: 'GUSDCISSUER...' },
  memo: 'Invoice #42'
});

console.log(`Sending ${preview.amount} ${preview.asset.code}`);
console.log(`To: ${preview.destination}`);
console.log(`Network: ${preview.network}`);
console.log(`Estimated Fee: ${preview.estimatedFee} stroops`);
```

### checkTransactionReadiness

Checks whether a payment is ready to sign, without building, signing or submitting anything (issue #441). Takes the source **public** key. Returns a typed `TransactionReadiness` with `ready`, every blocker and warning (each with a stable `code`), and the status of each check. Never throws for bad input or Horizon failures; those are blockers. See [Transaction readiness](./transaction-readiness.md) for every code and the limitations.

```ts
import { checkTransactionReadiness } from 'stellar-pocketpay-sdk';

const readiness = await checkTransactionReadiness({
  sourceAccount: wallet.publicKey,
  destination,
  amount: '50',
  asset: { code: 'USDC', issuer: usdcIssuer },
  memo: 'Invoice #42',
});

if (!readiness.ready) {
  console.log(readiness.blockers.map((b) => `${b.code}: ${b.message}`));
}
```

### validateSendXLMParams

Non-throwing input validation for `sendXLM`. Runs the same preflight checks `sendXLM` performs internally (secret key format, destination key format, amount, memo, self-payment) and returns a structured result rather than throwing on the first failure. Pure: no Horizon calls, no signing, no transaction submission.

```ts
function validateSendXLMParams(params: SendXLMParams): SendXLMValidationResult;

type SendXLMValidationResult =
  | { ok: true }
  | { ok: false; errors: ValidationError[] };

interface ValidationError {
  code:
    | 'INVALID_SECRET_KEY'
    | 'INVALID_PUBLIC_KEY'
    | 'INVALID_AMOUNT'
    | 'INVALID_AMOUNT_PRECISION'
    | 'INVALID_MEMO'
    | 'SELF_PAYMENT';
  field: 'sourceSecret' | 'destination' | 'amount' | 'memo';
  reason: string;
  message: string;
}
```

Consumers should branch on `err.code`; codes are part of the public contract, messages are not. See `docs/getting-started.md` for a form-integration example.

## Wallet Import API

### `importWallet(secretKey)`
Imports an existing wallet from a Stellar secret key (S...).
- **Throws**: `PocketPayError` (`INVALID_SECRET_KEY`) with typed validation reason (`not_a_string`, `missing`, `invalid_prefix`, `invalid_length`, `invalid_format`).

### `safeImportWallet(secretKey)`
Safely attempts to import a wallet without throwing.
- **Returns**: `PocketPayResult<WalletKeypair>` (`{ ok: true, value }` or `{ ok: false, error }`).

### `enhancedImportWallet(secretKey)`
Imports a wallet and returns an enhanced result with warnings and recovery hints.
- **Returns**: `EnhancedPocketPayResult<WalletKeypair>`.

### `safeEnhancedImportWallet(secretKey)`
Imports a wallet and returns an enhanced result with warnings and recovery hints without throwing.
- **Returns**: `EnhancedPocketPayResult<WalletKeypair>`.

## Account Sequence & Concurrency API

### `SequenceProvider`

Caches account sequence numbers with freshness tracking and serializes transaction intents per account.

```ts
import { SequenceProvider } from 'stellar-pocketpay-sdk';

const sequences = new SequenceProvider({ maxAgeMs: 15_000 });
```

- **`get(publicKey: string): Promise<SequenceSnapshot>`**: Returns cached sequence if fresh, otherwise fetches from Horizon.
- **`refresh(publicKey: string): Promise<SequenceSnapshot>`**: Bypasses cache and fetches fresh sequence from Horizon.
- **`invalidate(publicKey?: string): void`**: Evicts cached snapshot for an account, or all accounts if omitted.
- **`peek(publicKey: string): SequenceSnapshot | undefined`**: Returns cached snapshot without network calls.
- **`loadAccount(publicKey: string): Promise<StellarSDK.Account>`**: Builds a `StellarSDK.Account` ready for transaction building.
- **`withSequence<T>(publicKey: string, task: () => Promise<T>): Promise<T>`**: Serializes build and submit tasks sequentially for a given account within the process.

### `validateSequenceValue(sequence: unknown): boolean`

Validates that a candidate sequence number is a valid unsigned decimal integer. Throws `PocketPayError` with `ErrorCode.TX_BAD_SEQUENCE` on invalid values.

### `requiresRebuild(error: unknown): boolean`

Returns `true` if an error corresponds to a stale sequence (`ErrorCode.TX_BAD_SEQUENCE`), indicating that the transaction envelope must be rebuilt with a fresh sequence number rather than blindly resubmitted.


