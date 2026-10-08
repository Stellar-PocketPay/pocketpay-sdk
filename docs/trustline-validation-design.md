# Trustline validation contract and failure boundaries (issue #184)

This document defines the **application-facing design contract** for issued-asset trustline preflight in the PocketPay SDK. The existing [trustline guide](./trustline-validation.md) covers usage; this document specifies which statements are local facts, which depend on Horizon, how callers handle failures, and what preflight cannot guarantee.

## Responsibility and sequence

1. **Local validation, no network:** validate the destination public key; check issued-asset code (1–12 alphanumerics), issuer public key, and positive amount (at most seven fractional digits). Native `XLM` / `native` must not have an issuer.
2. **Native asset:** `checkDestinationTrustline` returns `{ valid: true, status: 'native_xlm' }` without requesting Horizon. This means *no trustline required*, **not** that the destination exists or an XLM payment will succeed. The ordinary payment path still performs its own network/submission checks.
3. **Issued asset:** resolve the configured Horizon endpoint and fetch the destination account. A 404 means the account is unfunded/nonexistent on that network. For an existing account, match **both** asset code and issuer, verify trustline authorization, and check available capacity against the proposed amount.
4. **Payment handoff:** `sendAsset` applies the issued-asset preflight by default. The optional `skipTrustlineCheck` flag bypasses that extra query, not the ledger's trustline rules; do not silently enable it after a failed preflight.

The SDK does not create or authorize trustlines, sign a ChangeTrust transaction for a recipient, reserve a recipient's capacity, or submit payment retries while performing this preflight. The **destination account holder** normally establishes their own trustline; issuer authorization can require action by the **issuer**. Do not ask the sender to sign for the destination.

## Stable statuses and app actions

| Status | `valid` | Code | Appropriate UX / recovery |
| --- | --- | --- | --- |
| `native_xlm` | true | — | No trustline is required; continue standard XLM payment checks |
| `valid` | true | — | Issued-asset preflight passed at the observed ledger state |
| `account_not_found` | false | `UNFUNDED_DESTINATION` | Ask recipient to activate/fund the destination on this network |
| `missing_trustline` | false | `MISSING_TRUSTLINE` | Ask recipient to add a trustline to the exact asset code **and issuer** |
| `not_authorized` | false | `TRUSTLINE_NOT_AUTHORIZED` | Explain that issuer authorization may be required; do not auto-submit |
| `limit_exceeded` | false | `TRUSTLINE_LIMIT_EXCEEDED` | Display available capacity; recipient may need to raise limit/reduce balance |
| Invalid local input | thrown | `INVALID_PUBLIC_KEY`, `INVALID_ASSET*`, `INVALID_AMOUNT*` | Correct user input without initiating a network call |
| Horizon timeout, 5xx or malformed trustline data | thrown | `TRUSTLINE_CHECK_ERROR` or network error | Show a temporary inability to verify; **do not** treat this as trustline validity |

Use `safeCheckDestinationTrustline` for a `PocketPayResult` wrapper when UI code needs nonthrowing control flow. Use `verifyPaymentTrustlineOrThrow` when an invalid trustline must interrupt an existing payment pipeline with a structured `PocketPayError`.

## Capacity and precision

Stellar issued-asset amounts have **seven fractional decimal digits**. Horizon exposes `balance` and `limit` as decimal strings. Parse them as exact integer units of 10⁻⁷; compute

`availableUnits = max(0, limitUnits - balanceUnits)`

and compare the payment's integer units against that value. Never use `parseFloat`, binary floats, or round-to-display values to authorize a payment. A maximum-size limit such as `922337203685.4775807` and a balance of `922337203685.4775806` leave exactly `0.0000001` capacity.

Malformed, missing, negative or over-precision Horizon amounts must **fail closed** rather than produce `valid: true`. The public `availableCapacity` string uses exactly seven fractional decimal places for display; a UI can localize a *copy* but must not round it up for payment authorization.

The authorization flag check is conservative: a balance record with `is_authorized === false` or `is_authorized_to_maintain_liabilities === false` is treated as not authorized. The chain, not this preflight, remains definitive on other nuanced asset flags.

## Consumer example

```ts
import { safeCheckDestinationTrustline, sendAsset } from '@axionvera/pocketpay-sdk';

const check = await safeCheckDestinationTrustline(
  destinationPublicKey,
  { code: 'USDC', issuer: usdcIssuerPublicKey },
  { amount: '0.0000001', config: { network: 'testnet' } },
);
if (!check.ok) {
  // Network or validation failure: no payment was submitted.
  showVerificationUnavailable(check.error.code);
} else if (!check.value.valid) {
  // Show check.value.status and check.value.availableCapacity when available.
  showRecipientTrustlineProblem(check.value);
} else {
  // If the payer chooses to proceed, sendAsset performs its normal checks
  // and on-chain submission, which may still fail after ledger state changes.
  await sendAsset({
    sourceSecret: senderSecret,
    destination: destinationPublicKey,
    amount: '0.0000001',
    asset: { code: 'USDC', issuer: usdcIssuerPublicKey },
  }, { network: 'testnet' });
}
```

### Failure and security boundaries

- Preflight is a **point-in-time observation**. A destination can remove trust, change authorization, or consume capacity before the submitted transaction is included. Surface the final transaction error independently; never infer settlement from `valid: true`.
- The **network is explicit**. Checking a recipient on Testnet says nothing about Mainnet. Do not mix cached trustline reads across networks, asset issuers, or destinations.
- Offline validation failures should not initiate Horizon requests. A timeout, 429, or 5xx is an **unknown check outcome**, not proof that the trustline is absent. Do not automatically bypass checks to get a payment through.
- Diagnostic text must not contain source signing secrets, signed envelopes or sensitive tokens. Trustline error codes and status are suitable for UI branching; raw exception bodies and endpoint credentials are not.
- Do not add an automatic retry around submission merely because preflight passed. Reconcile an uncertain payment outcome via existing guarded submission/transaction polling before any retry.

## Acceptance / review matrix

| Boundary | Expected behavior |
| --- | --- |
| Native XLM, no issuer | Local `native_xlm`; no trustline Horizon call |
| Invalid issuer, malformed code or amount | Local validation failure |
| Issued destination 404 | `account_not_found` without a submission |
| Asset code matches but issuer differs | `missing_trustline` |
| Existing but unauthorized trustline | `not_authorized` |
| Capacity exhausted or amount exceeds it by one unit | `limit_exceeded` |
| Large valid balance with one unit spare | `valid` and `availableCapacity: '0.0000001'` |
| Invalid Horizon decimal or transient network failure | Throw/nonthrowing wrapper failure; never approve |
| Ledger state changes after preflight | Payment submission determines final success/failure |

See `tests/trustline.test.ts` for the focused existing mock-Horizon boundary regressions. This document records API semantics and the implementation's known testnet-focused boundary; it does not claim a production audit or live-mainnet verification.
