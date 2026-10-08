# SDK Diagnostics and Safe Support Workflows

Opt-in diagnostics help apps and support engineers debug configuration, network
state, transaction lifecycle, wallet capability, and vault readiness **without**
leaking secret keys, seed phrases, signed XDR, or other sensitive material.

> [!CAUTION]
> Diagnostics are **off by default**. Never enable event hooks in production
> log pipelines that are not already scrubbed. Even with redaction, prefer the
> structured `buildDiagnosticsReport()` snapshot for support tickets over
> dumping raw console output.

## Quick start

```ts
import {
  enableDiagnostics,
  disableDiagnostics,
  buildDiagnosticsReport,
  createWallet,
  type DiagnosticsEvent,
} from 'stellar-pocketpay-sdk';

const events: DiagnosticsEvent[] = [];

enableDiagnostics({
  hooks: {
    onEvent: (event) => {
      // Already redacted — safe to forward to your logger
      console.debug('[pocketpay]', event.domain, event.type, event.data);
      events.push(event);
    },
  },
});

createWallet(); // emits wallet.created with publicKey only (no secretKey value)

const report = buildDiagnosticsReport({ network: 'testnet' });
// Attach `report` to a support ticket — it contains endpoint origins,
// capability status, and vault readiness flags, never signing material.

disableDiagnostics(); // clear hooks when done
```

Environment note: `POCKETPAY_DEBUG=true` alone does **not** start emitting
events. You must still call `enableDiagnostics` / `setDiagnosticsHooks`. Debug
mode expectations for application loggers remain documented in
[logging-payloads-and-debug.md](./logging-payloads-and-debug.md).

## What is safe vs never shared

| Value | In events / report? |
| --- | --- |
| Public key (`G…`), tx hash, ledger, network name, Horizon/Soroban endpoint origins | Yes |
| Capability status, vault readiness, timeout | Yes |
| Contract id (`C…`) when configured | Yes (on-chain public) |
| Secret key, mnemonic, seed, signed XDR, signatures, `sourceSecret` | **Never** — replaced with `[REDACTED]` |
| Memo text | Not included in diagnostics events by default |

Redaction is implemented by `redactDiagnosticsValue` using the deny-list in
`DIAGNOSTICS_SENSITIVE_KEYS`, plus string scrubbing for embedded `S…` keys.

## Account diagnostics report

`buildAccountDiagnosticsReport(publicKey, options?)` adds the state of one
public account and a coarse payment-readiness verdict to the support report
above. It is read-only. It does one Horizon account lookup and never signs or
submits anything.

```ts
import { buildAccountDiagnosticsReport } from 'stellar-pocketpay-sdk';

const report = await buildAccountDiagnosticsReport(wallet.publicKey, {
  config: { network: 'testnet' },
});

if (report.paymentReadiness.status !== 'ready') {
  console.warn(report.paymentReadiness.reasons); // e.g. ['ACCOUNT_UNFUNDED']
}
```

Account lookup failures do not throw. They are reported as
`account.status: 'error'`. Invalid `config` overrides still throw the same
validation error as `resolveConfig()` and `buildDiagnosticsReport()`.

### Reading the report

| Field | Meaning |
| --- | --- |
| `account.status` | `funded`, `unfunded` (Horizon 404: the account has never been funded), or `error` (the lookup failed, or the input was not a valid `G…` key) |
| `account.nativeBalance`, `account.assetCount` | Native XLM balance and number of balance entries, native included. Funded accounts only. |
| `account.estimatedMinimumBalance` | Lower bound of the protocol minimum balance: (2 + trustlines) × 0.5 XLM. Offers, extra signers, data entries, sponsorships and liabilities are not visible here and can raise the real minimum. |
| `account.errorCode`, `account.errorHttpStatus` | A stable code (for example `REQUEST_TIMEOUT`, `INVALID_PUBLIC_KEY` or `ACCOUNT_DIAGNOSTICS_ERROR`) and the Horizon HTTP status when one was available. `errorMessage` is a fixed SDK string. Provider error messages are never copied into the report. |
| `paymentReadiness.status` | `ready`, `not_ready`, or `unknown` (account state could not be loaded) |
| `paymentReadiness.reasons` | Why the account is not ready (see below). Empty when ready. |

| Reason | What it means / what to do |
| --- | --- |
| `INVALID_PUBLIC_KEY` | The value passed was not a valid public key. It is shown as `[REDACTED]` and never echoed, in case it was a secret key or seed phrase. Ask for the `G…` address again. |
| `ACCOUNT_UNFUNDED` | The account does not exist on this network yet. Fund it (on testnet: `fundTestnetAccount`). Check that the app and the account are on the same network. |
| `NO_NATIVE_XLM_FOR_FEES` | The native balance does not exceed the estimated minimum balance by at least one base fee (100 stroops). Add XLM or remove unused trustlines. |
| `ACCOUNT_STATE_UNAVAILABLE` | The Horizon lookup failed. See `errorCode` / `errorHttpStatus` and `report.network`. `probeConfiguredEndpoints()` checks reachability. |
| `NETWORK_CONFIGURATION_UNAVAILABLE` | The network passphrase or Horizon URL could not be resolved. |

`ready` does not mean a payment will succeed. The report does not check the
destination, amount, asset trustlines (`checkDestinationTrustline`), sequence
freshness (`SequenceProvider`), or operation-specific rules. The normal
payment validation still runs when you build and submit.

For tests and offline tooling, inject the account source with
`{ lookup }`. Any function returning a `BalanceResult` works, including
`getBalanceOrUnfunded`. The returned top-level public key and the nested
funded-balance public key **must both match** the requested wallet; conflicting
provider/cache records result in a fixed, redacted account error and
`paymentReadiness.status: 'unknown'`, never another wallet's balance or a
false-ready status. An unfunded result for a different public key is rejected
the same way.

### Sharing the report safely

- The report is built from public data: the public key, native balance,
  counts, endpoint origins and capability flags. Endpoint URLs are reduced to
  their origin before the whole object passes through `redactDiagnosticsValue`.
- Share the object exactly as returned (`JSON.stringify(report, null, 2)`).
  Do not add wallet objects, secret keys, seed phrases, signed XDR, raw error
  objects or stack traces to it.
- Horizon and Soroban endpoint fields expose only URL origins (scheme, host,
  and port). Userinfo, path, query, and fragment components are removed before
  the report is returned.
- Balances are public on-chain, but a report still links an address to an
  amount. Share it only with the support channel that needs it.

## Lifecycle events (when enabled)

| Domain | Example `type` | Typical `data` |
| --- | --- | --- |
| `config` | `config.resolved` | network, URLs, timeout, `contractIdConfigured` |
| `wallet` | `wallet.created` / `wallet.imported` | `publicKey`, `hasSecretKey: true` |
| `transaction` | `transaction.submit.*` / `transaction.history.fetched` | txHash, counts — not envelopes |
| `network` | `network.retry.attempt` | attempt, outcome kind, delayMs, txHash |
| `vault` | `vault.readiness` | `ready`, operation, configuration flags |

## Support workflow

1. Reproduce with diagnostics enabled in a **non-production** environment.
2. Call `buildDiagnosticsReport()` and save the JSON (no secrets). For
   account or payment problems, use `buildAccountDiagnosticsReport(publicKey)`
   instead. It includes the same sections plus account state and payment
   readiness.
3. Collect redacted event traces for the failing operation (`type` + `data`).
4. Share the report + event types with support — **never** paste wallet backups,
   seed phrases, or signed XDR.
5. Call `disableDiagnostics()` when finished.

## Related docs

- [Logging Guidance](./logging.md)
- [Logging: payloads and debug mode](./logging-payloads-and-debug.md)
- [Security Best Practices](./security.md)
- [Support Policy](./support-policy.md)
