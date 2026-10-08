# Network Resilience Layer

This is the top-level guide to how the SDK talks to the network: the client
abstraction, the typed errors it produces, how read-only calls differ from
state-changing ones, and how to check endpoint health. For the full status
code and result-code reference, see [Network Error Handling](./network-errors.md);
for the transaction retry state machine, see [Safe Retry Policy](./retry-policy.md).

## `NetworkClient`

All raw `fetch` calls in the SDK are expected to go through `NetworkClient` (or
`fetchWithTimeout`, which it's built on) rather than being made ad hoc from
individual modules. It centralises three things every call needs: a timeout
budget, JSON parsing, and typed error classification.

```ts
import { NetworkClient } from 'stellar-pocketpay-sdk';

const client = new NetworkClient({
  baseUrl: 'https://friendbot.stellar.org',
  defaultTimeoutMs: 10_000,
});

const data = await client.get('?addr=GABC...', { operation: 'Friendbot funding request' });
```

`get()` and `post()` both accept a per-call `timeoutMs` and `operation` label
(used in error messages and timeout-stage inference — see
[Timeout Classification](./timeout-classification.md)).

## Typed failure codes

`NetworkClient` classifies every failure into one of these codes before
throwing, so callers can branch on `error.code` / `error.retryable` instead of
inspecting HTTP status numbers or `error.message`:

| Code | When | Retryable |
|---|---|---|
| `REQUEST_TIMEOUT` | The SDK's own timeout budget elapsed (see `withTimeout`) | Yes (unless the stage is `submission`/`confirmation` — see below) |
| `NET_RATE_LIMITED` | HTTP 429 | Yes |
| `NET_UNREACHABLE` | HTTP 5xx, or the request never reached the endpoint (`ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `ENETUNREACH`, `EHOSTUNREACH`) | Yes |
| `HTTP_ERROR_<status>` | Any other non-2xx response (400, 401, 403, 404, …) | No |
| `NETWORK_ERROR` | An unrecognized fetch rejection | Depends — inspect `error.cause` |

All of the above are published, stable codes in `ERROR_CODES` (see
`src/errors/codes.ts`); use `describeError(code)` to get a safe user-facing
message and developer hint for any of them.

```ts
import { NetworkClient, describeError } from 'stellar-pocketpay-sdk';

try {
  await client.get('/accounts/GABC...');
} catch (error) {
  if (error instanceof PocketPayError) {
    const { safeMessage, retryable } = describeError(error.code);
    if (retryable) {
      // back off and retry the same read-only request
    }
  }
}
```

## Read-only calls vs. state-changing submission

**Read-only requests** (account lookups, fee stats, transaction history,
Friendbot funding) are safe to retry whenever `error.retryable` is `true`.
Nothing on the server changes state just because a GET was retried.

**Transaction submission is different.** A submission that times out or hits
`NET_UNREACHABLE` may or may not have reached the network — resubmitting
blindly risks a duplicate payment. The SDK never does this automatically:

- `submitTransactionIdempotently()` resolves this by polling Horizon for the
  transaction hash before deciding anything.
- `withRetryPolicy()` builds on that: it only resubmits the same envelope for
  `retryable_failure` outcomes, and always requires a status check
  (`requiresStatusCheck`) before any further action on `unknown_status`.

See [Safe Retry Policy](./retry-policy.md) for the full state machine. The
short version: **retry reads freely; never retry a submission without going
through `submitTransactionIdempotently` or `withRetryPolicy`.**

## Endpoint URL validation and support privacy

Network endpoints must use the exact `http:` or `https:` scheme with a host.
Scheme lookalikes such as `httpx:`, embedded URL credentials
(`user:password@`) and fragments are rejected during configuration validation.
The SDK reports typed configuration errors without echoing the supplied URL.

Live probes still use the full configured URL for transport. **Published
diagnostics, reachability results and configuration lifecycle hooks expose only
the origin** (scheme, host and port), not URL userinfo, paths, query parameters
or fragments. This is intentionally stricter than matching known token patterns:
an unknown custom query parameter can also carry credentials. Do not use the
redacted diagnostics URL as a request endpoint; retain the original validated
SDK configuration for network operations.

## Endpoint diagnostics

Two complementary tools are available, both safe to share with support —
neither ever includes secret keys, signed XDR, or response bodies.

### Config snapshot (no network calls)

`buildDiagnosticsReport()` returns a redacted snapshot of the resolved
configuration — network, Horizon/Soroban URLs, timeout, capability status —
without making any request:

```ts
import { buildDiagnosticsReport } from 'stellar-pocketpay-sdk';

const report = buildDiagnosticsReport({ network: 'testnet' });
```

### Live reachability probe (opt-in network calls)

`checkEndpointReachability(url)` and `probeConfiguredEndpoints(config)` make a
lightweight GET against an endpoint and report only whether it responded, how
long it took, and a typed error code if it didn't — never the response body:

```ts
import { probeConfiguredEndpoints } from 'stellar-pocketpay-sdk';

const diagnostics = await probeConfiguredEndpoints({ network: 'testnet' });
// { generatedAt, horizon: { url, reachable, latencyMs }, sorobanRpc: { ... } }
```

Because this makes real network calls, it is never invoked automatically by
`buildDiagnosticsReport()` — call it explicitly when you need to check live
connectivity (e.g. a support "test connection" button).

## Malformed configuration

Every network call resolves configuration through `resolveConfig()` /
`validatePocketPayConfig()` first, which validates the network name, Horizon
and Soroban RPC URLs, timeout, and contract ID before any request is made. An
invalid config throws (or, for `validatePocketPayConfig`, reports structured
issues) instead of silently falling back to a default — see
[SDK Configuration](./configuration.md) for the full validation rules.
