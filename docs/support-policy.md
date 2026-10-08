# SDK Support Policy

This document defines what the PocketPay SDK officially targets, what is
experimental, and what is not yet supported.

---

## Supported Node.js versions

| Range | Status |
| --- | --- |
| **Node.js 18.x** | Supported (minimum; `>=18.0.0` per `package.json` `engines`) |
| **Node.js 20.x** | Supported |
| **Node.js 22.x** | Supported — CI runs on Node 22, the primary target |
| **Node.js < 18** | Not supported |

The SDK uses `ES2020` as its compilation target. If you are on an older Node
release, you may need a polyfill for modern JavaScript features.

## Supported TypeScript version

| Version | Status |
| --- | --- |
| **TypeScript 5.x** | Supported — tested against `^5.8.3` |
| **TypeScript < 5** | Not supported — the SDK uses features that require TypeScript 5+ |

The SDK ships with declaration files (`d.ts`), so it works in any TypeScript
5+ project. Strict mode (`strict: true`) is enabled in the SDK's own build and
is recommended for consumers as well, but is not required.

## Supported Stellar SDK version

| Version | Status |
| --- | --- |
| **`@stellar/stellar-sdk` 13.x** | Supported — pinned to `^13.1.0` |

The SDK depends on `@stellar/stellar-sdk` for Horizon interaction and Soroban
RPC. Other versions of `stellar-sdk` are not tested and may not work.

## Supported runtimes

| Runtime | Status |
| --- | --- |
| **Node.js** | ✅ Primary target |
| **Bun** | Untested — may work, but no guarantees |
| **Deno** | Untested — may work, but no guarantees |
| **React Native / Expo** | ⚠️ Experimental — the SDK imports Node.js globals (`Buffer`, `process.env`). A Metro shim or polyfill is required. Not tested in CI. |
| **Browser** | ⚠️ Experimental — same Node.js global dependency. Not tested in CI. |

## Network support

| Network | Status |
| --- | --- |
| **Stellar Testnet** | ✅ Fully supported — all features are developed and tested against public Testnet (Horizon + Friendbot) |
| **Stellar Mainnet** | ⚠️ Experimental — the SDK functions produce valid mainnet transactions when configured with `network: 'mainnet'`, but **no mainnet-specific testing or hardening has been done**. See [testing](./docs/testing.md) for the test lane split. |

> **Testnet-first:** This SDK is built for Testnet experimentation. Before
> moving to Mainnet, review the [Security Best Practices](./docs/security.md)
> and audit the SDK yourself. Nothing here has been audited or hardened for
> Mainnet/production use.

## Soroban vault helpers

| Feature | Status |
| --- | --- |
| `depositToVault` | ⚠️ Pre-release — the contract-call shape may change as the savings-vault contract evolves. Requires a separately deployed contract (see [Axionvera/pocketpay-contracts](https://github.com/Axionvera/pocketpay-contracts)). |
| `withdrawFromVault` | ⚠️ Pre-release — same caveat as above. |
| `getVaultBalance` | ⚠️ Pre-release — same caveat as above. |

The vault helpers are **not** covered by the unit test suite's offline guard
(they rely on an integration test lane). Treat them as pre-release until the
savings-vault contract is stable and the helpers have dedicated unit tests.

## Package entry point

The **only** supported entry point is the package root:

```typescript
import { createWallet, sendXLM, getBalance } from '@axionvera/pocketpay-sdk';
```

Deep imports (e.g. `@axionvera/pocketpay-sdk/wallet`) are **not supported**
and are not guaranteed to work across versions. Internal helpers not listed in
the SDK's public API surface are implementation details.

## Module system

| Format | Status |
| --- | --- |
| **CommonJS** (`require`) | ✅ Supported — the package compiles to CommonJS |
| **ESM** (`import`) | ✅ Supported — TypeScript and bundlers resolve the types, but the published artifact is CommonJS. ESM-only runtimes may need a compatible loader. |

## Expo / mobile caveats

The SDK is consumed by **[Axionvera/pocketpay-mobile](https://github.com/Axionvera/pocketpay-mobile)**,
which imports it from its package root using Metro. If you are integrating the
SDK into an Expo or React Native project:

1. You may need a `buffer` polyfill (the SDK uses `Buffer` internally).
2. `dotenv` is loaded at import time — ensure environment variables are
   configured for your target platform.
3. Soroban vault helpers depend on `@stellar/stellar-sdk`'s Soroban RPC
   client, which may need additional Metro configuration.

These caveats apply to the current state of the SDK; improvements for
non-Node runtimes are tracked as future work.

## CI / test coverage

| Lane | What it covers |
| --- | --- |
| **Unit tests** (default) | All mocked/offline. Run with `npm run test`. |
| **Integration tests** | Real Testnet calls (Friendbot, Horizon). Run with `npm run test:integration`. |
| **Type-check** | `tsc --noEmit` — full project. |
| **Build** | `tsc` — produces `dist/`. |

CI runs on **Node 22** via GitHub Actions. See `.github/workflows/ci.yml`.

## Safe support diagnostics

When filing or answering support requests about SDK behaviour, use the opt-in
diagnostics APIs documented in [diagnostics.md](./diagnostics.md):

- `buildDiagnosticsReport()` — shareable JSON snapshot (config, network,
  capabilities, vault readiness) with secrets redacted.
- `buildAccountDiagnosticsReport(publicKey)` — the same snapshot plus public
  account state and a payment-readiness verdict with reason codes.
- `enableDiagnostics({ hooks })` — lifecycle events that never include secret
  keys, mnemonics, or signed XDR.

Do **not** ask users for secret keys, seed phrases, or signed transaction
envelopes.

## Maintenance status

| Aspect | Status |
| --- | --- |
| Active development | ✅ Yes — the SDK is under active development for PocketPay |
| Bug fixes | ✅ Reported via [GitHub Issues](https://github.com/Axionvera/pocketpay-sdk/issues) |
| Semantic versioning | ✅ The SDK follows semver — breaking changes bump the major version |
| Deprecation notices | ⚠️ Breaking changes are flagged in release notes; formal deprecation warnings are not yet implemented |
| Long-term support | ❌ No LTS guarantees — the SDK is pre-1.0 in maturity |

---

*This policy is a living document. As the SDK matures, version ranges and
support tiers will be updated. Open an issue or PR to propose changes.*
