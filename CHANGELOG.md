# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Opt-in SDK diagnostics (`src/diagnostics/`): redacted lifecycle hooks, `buildDiagnosticsReport`, and support guide (`docs/diagnostics.md`) for configuration, network, transaction, wallet, and vault observability without leaking secrets
- `buildAccountDiagnosticsReport(publicKey, options?)`: a support-safe report of one account's public state (funded/unfunded/error, native balance, estimated minimum balance) with a payment-readiness verdict and reason codes. Invalid account ids and provider error messages are never echoed. See "Account diagnostics report" in `docs/diagnostics.md` (#444)
- Added a signer capability architecture on top of the account abstraction layer: `AccountAbstraction` is now the discriminated union `ReadOnlyAccount | SigningAccount`, with `canSignTransaction()` as an explicit type-guard capability check.
- Added `ExternalSignerAdapter`, a typed extension point for future hardware/mobile/browser signers (contract only — no concrete adapter ships).
- Added `signWithAccount()`/`safeSignWithAccount()` to `src/transactions/offline-preparation.ts`, checking signer capability and signer/account match before signing an `AccountAbstraction`-held transaction.
- Added typed, registered error codes `TX_SIGNER_MISSING` and `TX_SIGNER_MISMATCH` for missing-signer and wrong-signer cases. Unsupported external signer adapters reuse the existing `UnsupportedFeatureError`/`assertCapability('signer.remote', ...)` capability standard rather than a new code.
- Added `docs/signing-boundaries.md` and [ADR-0004](./docs/adr/0004-signer-capability-architecture.md) documenting the signing-capability model and its guarantees.
- Initial SDK release with wallet management, XLM payments, and transaction history
- Soroban savings-vault helpers (`depositToVault`, `withdrawFromVault`, `getVaultBalance`)
- Network error handling with retry guidance
- Comprehensive documentation covering getting started, error handling, logging, security, and release preparation
- GitHub Actions CI pipeline
- Contribution guidelines
- Added a complete SDK release-readiness and migration system for maintainers, including release gates, public API review, security review, changelog policy, deprecation guidance, and a reusable migration-note template

### Security

- Prevented `LocalSigner` (and any `SigningAccount` holding one) from leaking the raw secret key bytes of its wrapped `@stellar/stellar-sdk` `Keypair` through `JSON.stringify()` or Node's `console.log()`/`util.inspect()`; both now surface only the public key.

[Unreleased]: https://github.com/Axionvera/pocketpay-sdk/compare/main...HEAD
