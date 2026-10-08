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
// Attach `report` to a support ticket — it contains URLs, capability status,
// and vault readiness flags, never signing material.

disableDiagnostics(); // clear hooks when done
```

Environment note: `POCKETPAY_DEBUG=true` alone does **not** start emitting
events. You must still call `enableDiagnostics` / `setDiagnosticsHooks`. Debug
mode expectations for application loggers remain documented in
[logging-payloads-and-debug.md](./logging-payloads-and-debug.md).

## What is safe vs never shared

| Value | In events / report? |
| --- | --- |
| Public key (`G…`), tx hash, ledger, network name, Horizon/Soroban URLs | Yes |
| Capability status, vault readiness, timeout | Yes |
| Contract id (`C…`) when configured | Yes (on-chain public) |
| Secret key, mnemonic, seed, signed XDR, signatures, `sourceSecret` | **Never** — replaced with `[REDACTED]` |
| Memo text | Not included in diagnostics events by default |

Redaction is implemented by `redactDiagnosticsValue` using the deny-list in
`DIAGNOSTICS_SENSITIVE_KEYS`, plus string scrubbing for embedded `S…` keys.

## Lifecycle events (when enabled)

| Domain | Example `type` | Typical `data` |
| --- | --- | --- |
| `config` | `config.resolved` | network, URLs, timeout, `contractIdConfigured` |
| `wallet` | `wallet.created` / `wallet.imported` | `publicKey`, `hasSecretKey: true` |
| `transaction` | `transaction.submit.*` / `transaction.history.fetched` | txHash, counts — not envelopes |
| `network` | `network.retry.attempt` | attempt, outcome kind, delayMs, txHash |
| `vault` | `vault.readiness` | `ready`, operation, configuration flags |

## Observer isolation

Lifecycle hooks may be synchronous or async (`void | Promise<void>`). SDK
operations never await application observers. Errors from hook lookup, diagnostics
redaction (including throwing getters in supplied data), and synchronous or
rejected asynchronous observers are swallowed; an event that cannot be fully
redacted is dropped rather than delivering partially sanitized data.
Observers should handle their own delivery failures if support telemetry must
be retried or audited. Hook failures never indicate transaction settlement.

## Support workflow

1. Reproduce with diagnostics enabled in a **non-production** environment.
2. Call `buildDiagnosticsReport()` and save the JSON (no secrets).
3. Collect redacted event traces for the failing operation (`type` + `data`).
4. Share the report + event types with support — **never** paste wallet backups,
   seed phrases, or signed XDR.
5. Call `disableDiagnostics()` when finished.

## Related docs

- [Logging Guidance](./logging.md)
- [Logging: payloads and debug mode](./logging-payloads-and-debug.md)
- [Security Best Practices](./security.md)
- [Support Policy](./support-policy.md)
