# Transaction readiness before signing

`checkTransactionReadiness` answers "is this payment ready to sign?" with a
typed result. It does not build, sign or submit anything. You can call it with
the source **public** key alone, before you ask the user (or a signer) for
approval.

```ts
import { previewPaymentWithReadiness, sendXLM } from 'stellar-pocketpay-sdk';

const { preview, readiness } = await previewPaymentWithReadiness({
  sourceAccount: wallet.publicKey,
  destination,
  amount: '25',
  memo: 'invoice #42',
});

showConfirmation(preview);

if (!readiness.ready) {
  for (const blocker of readiness.blockers) {
    showFieldError(blocker.field, blocker.message);
  }
  return;
}

for (const warning of readiness.warnings) showNotice(warning.message);

await sendXLM({ sourceSecret, destination, amount: '25', memo: 'invoice #42' });
```

`previewPaymentWithReadiness` is the confirmation-stage integration seam: it
builds the normal local preview and then runs the shared readiness validator for
that exact payment. The preview itself performs no Horizon lookup, so composing
the two does not duplicate a network preflight.

`sendXLM` and `sendAsset` still do not call the readiness check. Their
construction, signing, and submission behavior remains unchanged for existing
callers.

## Result

```ts
interface TransactionReadiness {
  ready: boolean;                       // true only if every check passed
  blockers: TransactionReadinessBlocker[];
  warnings: TransactionReadinessWarning[];
  checks: Record<TransactionReadinessCheck, 'passed' | 'failed' | 'skipped'>;
  network?: 'testnet' | 'mainnet';
  networkPassphrase?: string;
  fee?: string;                         // total fee bid, in stroops
  balance?: TransactionReadinessBalance; // the figures the balance check used
  checkedAt: string;                    // ISO 8601
}

interface TransactionReadinessBlocker {
  check: TransactionReadinessCheck;
  code: TransactionReadinessBlockerCode;
  field?: 'sourceAccount' | 'destination' | 'amount' | 'asset' | 'memo'
        | 'networkPassphrase' | 'fee' | 'config';
  message: string;    // safe to display
  cause?: string;     // the SDK code underneath, e.g. INVALID_PUBLIC_KEY, REQUEST_TIMEOUT
  retryable: boolean; // true for lookup failures and timeouts
}
```

Your code should branch on `code`. Messages are for display and their wording
can change.

The check never throws for bad input or a Horizon failure. Both come back as
blockers. Every check runs, so a form can show all of its problems at once.

`skipped` means a check could not run all the way because something it depends
on failed first. For example, the balance check is skipped when the source
account could not be loaded. A skipped check always comes with a blocker, so a
result with a skipped check is never `ready`.

## Checks

The checks run in `READINESS_CHECK_ORDER`, and blockers and warnings are
reported in the same order.

| Check | Blocker codes | What it looks at |
|---|---|---|
| `source` | `SOURCE_INVALID`, `SOURCE_NOT_FOUND`, `SOURCE_LOOKUP_FAILED` | The public key format (surrounding whitespace is rejected), and that the account exists on the network |
| `destination` | `DESTINATION_INVALID`, `DESTINATION_MUXED_UNSUPPORTED`, `DESTINATION_SELF_PAYMENT`, `DESTINATION_NOT_FOUND`, `DESTINATION_LOOKUP_FAILED` | The public key format, muxed `M...` addresses (the payment helpers accept `G...` only), self-payment, and that the account exists. A payment cannot create an account |
| `amount` | `AMOUNT_INVALID`, `AMOUNT_PRECISION` | A positive decimal, at most 7 decimal places, and no more than the protocol maximum |
| `asset` | `ASSET_INVALID`, `SOURCE_TRUSTLINE_MISSING`, `SOURCE_TRUSTLINE_NOT_AUTHORIZED`, `DESTINATION_TRUSTLINE_MISSING`, `DESTINATION_TRUSTLINE_NOT_AUTHORIZED`, `DESTINATION_TRUSTLINE_LIMIT_EXCEEDED` | The shape of the asset spec. For issued assets it also checks that each side holds an authorized trustline, and that the destination's limit minus its balance and buying liabilities covers the amount. An issuer needs no trustline to send or receive its own asset |
| `memo` | `MEMO_INVALID`, `MEMO_REQUIRED` | The memo type and length, and SEP-29 `config.memo_required` on the destination. Any memo other than `none` satisfies SEP-29 |
| `network` | `NETWORK_CONFIG_INVALID`, `NETWORK_PASSPHRASE_MISMATCH`, `NETWORK_LOOKUP_FAILED` | That the SDK configuration is valid, and that `networkPassphrase` (when given) matches the configured network. With `verifyHorizonNetwork: true` it also checks the passphrase Horizon reports at `GET /` |
| `fee` | `FEE_INVALID` | `fee` (when given) must be a whole number of stroops, at least 100, that fits in the 32-bit fee field |
| `balance` | `INSUFFICIENT_BALANCE`, `INSUFFICIENT_FEE_BALANCE` | Spendable XLM, meaning balance minus the minimum reserve and minus selling liabilities, must cover amount + fee (XLM payments) or the fee alone (issued assets). For issued assets, the spendable asset balance (balance minus selling liabilities) must cover the amount |

The minimum reserve follows Stellar's sponsored-reserve formula
`(2 + subentry_count + num_sponsoring - num_sponsored) * base_reserve`, floored
at zero. The readiness check takes `base_reserve` from the SDK's
`calculateNativeReserves(0)` helper, but applies the sponsorship terms before
flooring so sponsorship can cover the account's own two base reserves as well as
subentries.

### Warnings

Warnings do not block the payment, and a result with warnings can still be
`ready`.

| Code | When |
|---|---|
| `HIGH_FEE_RATIO` | For an XLM payment, the fee is more than 10% of the amount |
| `DESTINATION_IS_ISSUER` | An issued asset is being paid back to its issuer, which removes it from circulation |
| `NETWORK_ENDPOINT_MISMATCH` | The Horizon URL looks like it belongs to the other network. This comes from the same heuristic as `validatePocketPayConfig` |

## Parameters

| Field | Default | Notes |
|---|---|---|
| `sourceAccount` | — | The `G...` public key. Readiness never takes a secret. Messages for a malformed key never repeat the input, so a secret pasted into the wrong field does not end up in logs |
| `destination` | — | The `G...` public key |
| `amount` | — | A decimal string |
| `asset` | `{ code: 'XLM' }` | The same `StellarAssetSpec` that `sendAsset` takes |
| `memo` | none | A string or a typed `MemoInput` |
| `networkPassphrase` | not checked | The passphrase you are about to sign with, for example the network a wallet is connected to |
| `fee` | `BASE_FEE` (100) | The fee bid per operation, in stroops. `sendXLM` and `sendAsset` bid `BASE_FEE` |
| `verifyHorizonNetwork` | `false` | Adds one `GET /` request to Horizon |

The second argument is the usual `Partial<SDKConfig>` override.

## Limitations

A `ready: true` result describes the network at `checkedAt` as far as the
checks above can see. It is not a promise that the transaction will succeed.

- **No protection against races.** Balances, trustlines, authorization flags,
  reserves and the destination's data entries can all change between the check
  and submission, for example when another transaction from the same account
  lands first. The network makes the final decision.
- **Sequence numbers are not checked or reserved.** Use the sequence-safety
  helpers (`SequenceProvider`, `isSequenceStale`) and guarded submission for
  that.
- **No fee bumps or surge pricing.** The check only confirms that the fee you
  bid can be paid. It does not say whether that bid is enough to get into a
  ledger under surge pricing (use `fetchFeeEstimate` for that), and it does not
  model fee-bump transactions or a separate fee source.
- **Signers and thresholds are not checked.** Use `mapAuthRequirements` on the
  built envelope, which is the only place threshold analysis is possible.
- **Only one native or issued `payment` operation is checked.** Path payments,
  create-account, account merges, claimable balances, multi-operation
  transactions and Soroban invocations are out of scope.
- **Muxed accounts are rejected, not resolved.** The SDK payment helpers accept
  `G...` destinations only, so an `M...` destination is a blocker.
- **The reserve uses the SDK model.** The base reserve is fixed at 0.5 XLM, as
  in `calculateNativeReserves`. If the network changes the base reserve, the
  figures will be off until that helper is updated.
- **Issuer flags are not checked beyond the trustline.** The check reads
  `is_authorized` on each trustline. It does not read the issuer account's
  flags such as clawback, auth-required or auth-revocable, and it does not
  check the issuer's home domain or `stellar.toml`.
- **The `NETWORK_ENDPOINT_MISMATCH` warning is a URL heuristic.** For an
  authoritative answer, set `verifyHorizonNetwork: true`.
- **The answer comes from one Horizon server.** If Horizon is lagging or
  misconfigured, the check can be wrong too.
