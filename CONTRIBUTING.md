# Contributing to PocketPay SDK

Thank you for your interest in contributing! Whether you're fixing a bug, improving docs, or adding a new feature, your help is welcome and appreciated. This guide will get you set up and show you what we expect from contributions.

---

## Table of Contents

- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Available Commands](#available-commands)
- [Project Structure](#project-structure)
- [Code Style](#code-style)
- [Writing Tests](#writing-tests)
- [Branching and Commits](#branching-and-commits)
- [Pull Request Checklist](#pull-request-checklist)
- [Payment-Period Communication](#payment-period-communication)
- [Reporting Issues](#reporting-issues)

---

## Getting Started

1. **Fork** the repository on GitHub.
2. **Clone** your fork locally:
   ```bash
   git clone https://github.com/<your-username>/pocketpay-sdk.git
   cd pocketpay-sdk
   ```
3. **Install dependencies** (Node.js ≥ 18 required):
   ```bash
   npm install
   ```
4. **Copy the environment template** and fill in any values you need for local testing:
   ```bash
   cp .env.example .env
   ```

---

## Development Setup

The SDK targets the Stellar Testnet by default. Most tests are unit-level and do not require a live network connection, but if you're working on Horizon or Soroban integration you can set the relevant URLs in your `.env` file.

| Variable | Description |
|---|---|
| `STELLAR_NETWORK` | `testnet` or `mainnet` (default: `testnet`) |
| `STELLAR_HORIZON_URL` | Override the default Horizon endpoint |
| `STELLAR_SOROBAN_RPC_URL` | Override the default Soroban RPC endpoint |
| `VAULT_CONTRACT_ID` | Deployed vault contract ID for Soroban tests |

> ⚠️ Never commit real secret keys. The `.env` file is gitignored for your protection.

---

## Available Commands

```bash
# Build the SDK (outputs to dist/)
npm run build

# Run all tests once
npm test

# Run tests in watch mode during development
npm run test:watch

# Type-check without emitting files
npm run lint

# Pre-submission verification (lint, tests, coverage, build — run before opening a PR)
npm run presubmit

# Coverage baseline report (HTML + JSON + module summary)
npm run coverage:baseline

# Pre-PR verification (same checks + docs/CI reminders + acceptance criteria checklist)
npm run verify:pr

# Start the dev watcher
npm run dev
```

---

## Project Structure

```
src/
  config/       SDK configuration and network defaults
  payments/     XLM payment logic
  soroban/      Soroban vault contract interactions
  transactions/ Transaction building and history
  types/        Shared TypeScript types
  utils/        Helper utilities
  wallet/       Wallet creation and management
  index.ts      Public API surface

tests/
  fixtures/     Shared test data (accounts, transactions, payments)
  *.test.ts     Test files mirroring the src/ modules

docs/           Extended documentation (error handling, logging, security)
examples/       Runnable usage examples
```

---

## Code Style

- The project is written in **TypeScript** with strict mode enabled.
- Run `npm run lint` before pushing — this type-checks the full source tree.
- Match the naming and file conventions already present in `src/`.
- Keep functions focused and add JSDoc comments for any exported API.
- Do not introduce new dependencies without following the [Dependency Review Standards](./docs/dependency-review.md) and discussing in the issue first.

---

## Writing Tests

Tests live in `tests/` and use [Vitest](https://vitest.dev/). We use fixtures in `tests/fixtures/` to keep test data consistent.

- **Write tests for any behaviour change or new feature.** Bug fixes should include a regression test.
- Keep tests isolated — avoid relying on live network calls. Mock external requests where needed.
- Use the existing fixture helpers (`tests/fixtures/accounts.ts`, `transactions.ts`, etc.) rather than hardcoding data.
- Follow the [SDK Module Test Matrix](./docs/module-test-matrix.md) for required unit, fixture, error-path, and integration coverage per module (wallet, payments, transactions, vault, config, utils).
- See the [Test-First Contribution Guide](./docs/test-first-guide.md) for copy-paste example tests per module (wallet, payments, transactions, vault, config, errors), explicit negative-path expectations, and the rules for when a PR may ship without new tests.
- Run `npm run coverage:baseline` and review uncovered lines in changed modules (see [coverage-baseline.md](./docs/coverage-baseline.md)).

Run the suite before opening a PR:

```bash
npm test
```

For a structured pre-PR pass that also checks build output, surfaces docs/CI
reminders from your git diff, and prints issue acceptance criteria, run:

```bash
npm run verify:pr
```

Before that (or as the minimum CI-parity gate), always run:

```bash
npm run presubmit
```

See [Pre-submission Verification](./docs/pre-submission-verification.md) and
[Pre-PR Verification](./docs/pre-pr-verification.md).

All tests must pass. ✅

---

## Branching and Commits

Use a descriptive branch name that references the issue:

```
feat/contributing-guide-6
fix/soroban-error-handling-42
docs/update-readme-15
```

Commit messages should be clear and in the imperative mood:

```
Add CONTRIBUTING.md for SDK contributors
Fix wallet keypair type mismatch on mainnet
```

Keep commits focused — one logical change per commit makes reviews easier.

---

## Contributor Security Checklist

The PocketPay SDK handles sensitive cryptographic keys and financial transactions. If your PR modifies files in `src/wallet/`, `src/transactions/`, `src/network/`, `src/soroban/`, or `src/vault/`, you must adhere to the following:

- **Dependency Auditing**: Ensure no new dependencies are introduced without strict review (see [Dependency Review Standards](./docs/dependency-review.md)). Avoid arbitrary supply chain risks.
- **Secure Memory Management**: Do not log, export, or leak secret keys, seed phrases, or sensitive payloads into variables that could be captured by stack traces or error boundaries.
- **Secure RNG**: If generating entropy, use cryptographically secure random number generators (CSPRNG) exclusively.
- **Error Handling**: Sanitize all error outputs before they are thrown to the host application to prevent secret leakage.

---

## Pull Request Checklist

Before opening a PR, run through this list:

- [ ] `npm run presubmit` passes (lint, circular deps, tests, coverage, build)
- [ ] `npm run verify:pr` passes (or `npm run lint` + `npm test` at minimum)
- [ ] `npm run lint` passes with no errors
- [ ] `npm test` passes with no failures
- [ ] New behaviour is covered by tests
- [ ] Relevant docs (`docs/`, `README.md`) are updated if needed
- [ ] The PR description explains **what** changed and **why**
- [ ] The PR references the related issue (e.g. `Closes #6`)
- [ ] No `.env` or secret values are committed
- [ ] **I have reviewed the [Contributor Security Checklist](#contributor-security-checklist) and verified my code introduces no secret leakage or insecure dependencies.**
- [ ] **I have completed the [Contributor Self-Review Form](.github/checklists/contributor-self-review.template.md)**

## Contributor Self-Review

Before requesting review or expecting payment approval, complete the [Contributor Self-Review Form](.github/checklists/contributor-self-review.template.md). This helps you evaluate your work objectively and ensures nothing is missed.

The self-review covers:
- Requirements review
- Implementation completeness
- Testing evidence
- CI status
- Documentation
- Known limitations

> **Tip:** Copy the template to `.github/checklists/contributor-self-review-<issue-number>.md` and fill it in as you work on your contribution.

---

## Contribution Quality Gate

Maintainers use the [Contribution Quality Gate](./docs/contribution-quality-gate.md) before approving issue PRs. It is a repeatable checklist covering:

- Meaningful implementation (completeness, not just patch size)
- Tests (including failure paths)
- CI status
- Documentation
- Issue acceptance criteria

The checkbox form lives at [`.github/checklists/contribution-quality-gate.md`](.github/checklists/contribution-quality-gate.md). The guide includes examples of **incomplete** vs **acceptable** work.

Contributors should read that guide before opening a PR. Maintainers should not approve until the checklist passes. A merged PR is still **not** automatic payment approval.

---

## Payment-Period Communication

Before requesting a reward or repeatedly asking about payment status, review the
[SDK Payment-Period Communication Policy](./docs/payment-period-communication.md)
and [Evaluation Readiness Index](./docs/evaluation-readiness.md).
An affirmative compensation claim is appropriate for eligible delivered work,
but duplicate cross-channel demands or harassment are not. Keep one canonical
claim/PR thread, include the actual evidence and program decision, and follow
the sponsor's stated review and payout process. A merge is not automatic reward
approval, and this guidance does not waive or forfeit any claim.

---

## Reporting Issues

Found a bug or have a feature idea? [Open an issue](https://github.com/Stellar-PocketPay/stellar-pocketpay-sdk/issues) and fill in as much detail as you can:

- What you expected to happen
- What actually happened
- Steps to reproduce
- SDK version and Node.js version

---

We appreciate every contribution, no matter the size. Thanks for helping make PocketPay SDK better! 🚀
