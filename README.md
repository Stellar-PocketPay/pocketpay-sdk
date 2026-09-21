# PocketPay SDK

Stellar-based payment SDK for the PocketPay ecosystem.

# PocketPay SDK

Stellar-based payment SDK for the PocketPay ecosystem.

## Project Status

This SDK is under active development and is **Testnet-focused**. Wallet
creation, XLM payments, and transaction/payment history are implemented and
tested against Stellar's public Testnet (Horizon + Friendbot).

The Soroban savings-vault helpers (`depositToVault`, `withdrawFromVault`,
`getVaultBalance`) are implemented in this SDK, but they call out to a
separate savings-vault smart contract that must be deployed independently —
see [Relationship to other repos](#relationship-to-other-repos) below. Treat
the vault helpers as pre-release: their contract-call shape may still change
as the contract itself evolves.

Nothing in this SDK has been audited or hardened for Mainnet/production use.
If you plan to use it beyond Testnet experimentation, review the code
yourself first — don't treat this as production-ready as-is.

## Relationship to other repos

PocketPay is split across three repos, each with a distinct job:

- **[Axionvera/pocketpay-sdk](.)** (this repo) — the TypeScript helper
  library in this document: wallet management, payments, transaction
  history, and Soroban vault call wrappers.
- **[Axionvera/pocketpay-mobile](https://github.com/Axionvera/pocketpay-mobile)**
  — the mobile app that consumes this SDK from its package root (see
  [Quick Start](#quick-start) below) to power the actual PocketPay user
  experience.
- **[Axionvera/pocketpay-contracts](https://github.com/Axionvera/pocketpay-contracts)**
  — the Soroban smart contracts, including the savings vault contract that
  the vault helpers in this SDK call into. The vault helpers here are only
  useful once a contract from that repo is deployed and its `VAULT_CONTRACT_ID`
  is supplied to the SDK.

## Installation

npm install @axionvera/pocketpay-sdk

## Documentation

- [Architecture](./docs/architecture.md) - How the SDK is organized, what each module owns, and how a call flows from the package root to Horizon/Soroban
- [SDK Package Boundary & Dependency Direction Map](./docs/dependency_direction_map.md) - Which module may import which, security-sensitive boundaries, and correct vs. incorrect import examples
- [SDK Roadmap](./docs/roadmap.md) - Directional plans and contributor opportunities across the SDK
- [Testing](./docs/testing.md) - Unit vs integration test lanes and the offline guarantee
- [Test Coverage Baseline](./docs/coverage-baseline.md) - Generate coverage reports and changed-module expectations (`npm run coverage:baseline`)
- [SDK Module Test Matrix](./docs/module-test-matrix.md) - Required unit, fixture, error-path, and integration tests per major module
- [Test-First Contribution Guide](./docs/test-first-guide.md) - Per-module test examples, happy/negative-path expectations, no-test justification rules, and local commands
- [Pre-PR Verification](./docs/pre-pr-verification.md) - Run `npm run verify:pr` before opening a pull request to confirm tests, docs, CI, and issue acceptance criteria
- [Acceptance Criteria Traceability](./docs/acceptance-criteria-traceability.md) - Format for mapping SDK changes to issue criteria in PRs
- [Pre-submission Verification](./docs/pre-submission-verification.md) - Run `npm run presubmit` before submitting a PR (lint, tests, coverage, build)
- [Contribution Quality Gate](./docs/contribution-quality-gate.md) - Maintainer checklist and examples of incomplete vs acceptable issue work before approval
- [Getting Started](./docs/getting-started.md) - Step-by-step guide to install, create wallets, fund accounts, check balances, and send payments
- [End-to-End App Integration Blueprint](./docs/app_integration_blueprint.md) - App-level flow combining config, diagnostics, wallet, account, payments, transactions, Soroban, vault, security, and typed error handling
- [Testnet Account Funding](./docs/testnet-funding.md) - Funding and activating Testnet accounts with Friendbot, confirming activation, and common unfunded-account errors
- [API Reference](./docs/api-reference.md) - Full reference with parameters, return types, and usage examples for every exported function
- [React Native Compatibility](./docs/react-native.md) - Integration guide for Expo and bare React Native: polyfills, Metro config, secure storage, and known limitations
- [Local Mobile Consumption](./docs/local-mobile-consumption.md) - Safely test unpublished SDK changes in `pocketpay-mobile`with tarballs, links, local paths, or workspaces
- [Transaction Date Formatting](./docs/transaction-timestamps.md) - Format of every `createdAt` timestamp returned by the SDK
- [Network Error Handling](./docs/network-errors.md) - Retry guidance for Horizon, Friendbot, and Soroban RPC failures
- [Network Resilience Layer](./docs/network-resilience.md) - The `NetworkClient` abstraction, typed timeout/rate-limit/unreachable errors, and endpoint reachability diagnostics
- [Safe Retry Policy](./docs/retry-policy.md) - Classifying submission outcomes, safe retry rules, and the `withRetryPolicy` API
- [Account Sequence & Concurrency Safety](./docs/sequence-safety.md) - Account sequence number handling, caching, stale sequence error classification, and in-process concurrency safety with SequenceProvider
- [Meaningful Change Review Guide](./docs/meaningful-change-review.md) - what counts as real SDK work: behaviour, modules, tests, acceptance criteria + reviewer checks
- [Evaluation Readiness Index](./docs/evaluation-readiness.md) - one page linking payment expectations, testing standard, CI guidance, acceptance criteria audit, self-assessment, and reviewer checklist before you open a PR or ask about payment status
- [Contributor Evaluation Policy](./docs/contributor-evaluation-policy.md) - post-merge GrantFox evaluation, payment-period conduct, self-review, maintainer review, testing/CI expectations, and acceptance-criteria completion
- [Error Handling](./docs/error-handling.md) - SDK error handling overview
- [Logging Guidance](./docs/logging.md) - Safe logging practices for SDK applications
- [SDK Diagnostics](./docs/diagnostics.md) - Opt-in redacted lifecycle hooks and support-safe reports
- [Logging: Transaction Payloads & Debug Mode](./docs/logging-payloads-and-debug.md) - Safely logging signed transaction XDR, memos, and debug output
- [Security Best Practices](./docs/security.md) - Key management and transaction safety
- [SDK Security Threat Model](./docs/security_threat_model.md) - Trust boundaries, secret handling, transaction submission risks, mitigation strategies, and consumer responsibilities
- [Signing Boundaries](./docs/signing-boundaries.md) - Detailed rules on secret boundaries, capability checking, and transaction signing limits
- [Dependency Review](./docs/dependency-review.md) - How SDK dependencies are evaluated, added, updated, and justified
- [Wallet Recovery Limitations](./docs/wallet-recovery-limitations.md) - What happens when keys are lost, what the SDK does not provide, and your application's responsibilities
- [Wallet Secret Export Policy](./docs/wallet-secret-export.md) - Supported local-key access, unsupported export behaviour, security risks, and consumer responsibilities
- [Soroban Vault](./docs/soroban-vault.md) - Savings vault helpers, configuration, and limitations
- [Trustline Validation](./docs/trustline-validation.md) - Pre-flight trustline verification and issued asset payment safety
- [Issued Asset Payments](./docs/issued-asset-payments.md) - Full guide to sending issued assets: asset identifiers, trustline setup, `sendAsset`, validation rules, and error reference
- [Multi-Asset Balance Model](./docs/multi-asset-balance-model.md) - Rich balance model for native XLM and issued credit assets with reserves and status taxonomy
- [Asset Formatting Rules](./docs/asset-formatting.md) - Guidance for displaying native and issued asset codes, issuers, balances, decimals, unknown assets, and UX warnings safely
- [SDK Release Readiness Checklist](./docs/release-checklist.md) - Repeatable release gates covering verification, public API review, security review, documentation, migration guidance, and publishing
- [SDK Migration System](./docs/sdk_migration_system.md) - Compatibility classifications, deprecation lifecycle, migration requirements, and maintainer review process
- [Migration Note Template](./docs/migration-note-template.md) - Reusable template for documenting breaking, configuration, runtime, and security-sensitive migrations
- [Changelog Policy](./docs/changelog-policy.md) - Rules for changelog categories, Semantic Versioning, breaking changes, security entries, and migration links
- [SDK Security Readiness Review](./docs/sdk_security_readiness_review.md) - Security review gates for secrets, signing, transactions, validation, networking, logging, dependencies, and public APIs
- [Transaction Lifecycle ADR](./docs/adr/0005-transaction-lifecycle.md) - Safety boundaries for preparation, signing, submission, confirmation, retries, and future transaction work
- [Architecture Decision Records](./docs/adr/) - Index of significant SDK design decisions and their rationale
- [Support Policy](./docs/support-policy.md) - Supported runtimes, versions, network status, and maintenance expectations
- [Dependency Review Standards](./docs/dependency-review.md) - Guidelines for evaluating, adding, and updating SDK dependencies
- [Changelog](./CHANGELOG.md) - Track changes across SDK versions

## Local Development

When developing the SDK and
[`Axionvera/pocketpay-mobile`](https://github.com/Axionvera/pocketpay-mobile)
side by side, follow the
[local mobile consumption guide](./docs/local-mobile-consumption.md). It
recommends testing a locally packed tarball so Metro sees the same package
layout that npm users receive, and also documents faster symlink-based
alternatives and their cleanup steps.

## Local Verification

Before submitting a pull request, run the pre-submission command:

```bash
npm run presubmit
```

This is the contributor-facing pre-submission command. It runs the same
CI-parity pipeline as `npm run verify`: **lint** → **circular-dependency check**
→ **unit tests** → **coverage** → **build**, stops at the first failure, and
prints fix guidance.

See [Pre-submission Verification](./docs/pre-submission-verification.md) for
usage and failure guidance. Details of each pipeline step also live in
[Local Verification Workflow](./docs/local-verification.md).

```bash
npm run verify   # same checks without step banners
```

## Pull Request Expectations

Every PR uses the
[PR template](./.github/PULL_REQUEST_TEMPLATE.md), which requires you to state
the related issue, implementation scope, **tests added** (or why tests don't
apply), the **`npm run verify` / `npm run presubmit`** output you ran locally, CI status, and
acceptance-criteria coverage. A merged PR is not automatically payment-approved;
reward eligibility is assessed separately. See [CONTRIBUTING.md](./CONTRIBUTING.md)
for the full checklist.


## Package Root Imports

Everything the SDK exposes is available from the package root — this is the
only supported entry point:

```typescript
import { createWallet, sendXLM, getBalance } from "stellar-pocketpay-sdk";
```

Deep imports (e.g. `stellar-pocketpay-sdk/wallet`) are **not supported** and
are not guaranteed to work across versions. Internal helpers that aren't
listed in the Features table above are implementation details and are not
part of the public API.

> [!CAUTION]
> `createWallet` generates a keypair but does not back it up — the SDK never
> persists a secret key anywhere. Losing it means losing access to the
> wallet permanently. Your application (or the user) must save it to secure
> storage right after creation. See
> [Wallet Creation](./docs/getting-started.md#2-wallet-creation),
> [Security Best Practices](./docs/security.md#wallet-backup-responsibility), and
> [Wallet Recovery Limitations](./docs/wallet-recovery-limitations.md).

## Response models

`getTransactions` and `getPayments` return SDK-owned typed models rather than
raw Horizon shapes, so consumers depend on a stable contract that will not
shift if Horizon's response format changes.

`TransactionSummary` fields: `hash`, `ledger`, `createdAt`, `sourceAccount`,
`fee`, `operationCount`, `successful`, `memo?`, `memoType`, `pagingToken`.

`PaymentSummary` fields: `id`, `transactionHash`, `type`, `createdAt`, `from`,
`to`, `amount`, `asset`, `assetIssuer`, `pagingToken`.

Both functions return a paginated list of the form
`{ records, count, nextCursor? }`. `nextCursor` is the paging token of the last
record and is `undefined` when the page is empty; pass it back to fetch the
following page.

```typescript
import { getTransactions } from "stellar-pocketpay-sdk";

const page = await getTransactions(publicKey, 10, "desc");
console.log(page.count, "transactions");
for (const tx of page.records) {
  console.log(tx.hash, tx.createdAt, tx.successful);
}
// page.nextCursor → cursor for the following page
```

The former `TransactionRecord` and `PaymentRecord` names remain exported as
aliases of `TransactionSummary` and `PaymentSummary` for backward
compatibility.

---

## Quick Start

import { PocketPay } from '@axionvera/pocketpay-sdk';
const sdk = new PocketPay({ network: 'testnet' });

==================================================
## Public API Compatibility
Before submitting changes to exported functions or types, review the [Public API Compatibility Checklist](docs/PUBLIC_API_COMPATIBILITY_CHECKLIST.md) to ensure backwards compatibility and proper migration guidance.
