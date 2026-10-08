# Evaluation Readiness Index

One page to check before you open a PR, and before you ask about payment
status on a GrantFox-sourced issue. Contributor quality guidance for this SDK
is intentionally split across several focused documents rather than one long
file — this page is the map.

If you've read everything linked here and satisfied it, your PR is ready for
review. If you haven't, start here rather than in README, the PR template, or
a support thread.

## 1. Payment expectations

- [SDK Payment-Period Communication Policy](./payment-period-communication.md) — SDK-specific guidance on a single canonical claim, contributor self-review, clear evidence, professional status requests, and preserving reward rights.

- [Meaningful Change Review Guide](./meaningful-change-review.md) — what
  counts as real SDK work. Size is not the bar; completeness is. Covers
  insufficient vs. acceptable examples and the reviewer criteria used on
  every PR.
- [Payment-Period Conduct Guidance](https://github.com/Axionvera/pocketpay-contracts/blob/main/docs/payment-period-conduct.md)
  *(in the `pocketpay-contracts` repo — shared across the PocketPay
  GrantFox campaign, not duplicated per-repo)* — how to communicate about
  payment status without repeating the same question across threads.

## 2. Testing standard

- [Testing](./testing.md) — unit vs. integration test lanes and the
  offline guarantee.
- [SDK Module Test Matrix](./module-test-matrix.md) — required unit,
  fixture, error-path, and integration tests per major module.
- [Test Coverage Baseline](./coverage-baseline.md) — generate coverage
  reports and changed-module expectations (`npm run coverage:baseline`).

## 3. CI guidance

- [Pre-PR Verification](./pre-pr-verification.md) — run `npm run verify:pr`
  before opening a pull request to confirm tests, docs, CI, and issue
  acceptance criteria.
- [Pre-submission Verification](./pre-submission-verification.md) — run
  `npm run presubmit` before submitting a PR (lint, tests, coverage, build).
- [Local Verification](./local-verification.md) — what the `npm run verify`
  pipeline actually checks, end to end.

## 4. Acceptance criteria audit

- [Acceptance Criteria Checklist template](../.github/checklists/acceptance-criteria.template.md) —
  copy this to `.github/checklists/issue-<number>.md`, paste the issue's
  acceptance criteria, and map each one to a concrete change before you
  open the PR.

## 5. Self-assessment

- [Contributor Self-Review Form](../.github/checklists/contributor-self-review.template.md) —
  complete this **before** requesting review or expecting payment approval.
  It's designed to catch the same gaps a maintainer would flag, earlier.

## 6. Reviewer checklist

- [Contribution Quality Gate](./contribution-quality-gate.md) — the same
  gate maintainers use before approving a PR: implementation, tests, CI
  status, docs, and acceptance criteria, with worked examples of what
  passes and what doesn't.
- [Contribution Quality Gate checklist](../.github/checklists/contribution-quality-gate.md) —
  the literal checkbox form maintainers fill in during review.

## Suggested order

1. Read [Meaningful Change Review](./meaningful-change-review.md) once, before
   you start writing code.
2. Copy the [Acceptance Criteria Checklist template](../.github/checklists/acceptance-criteria.template.md)
   and fill it in as you implement, not after.
3. Before opening the PR: run `npm run verify:pr`
   ([Pre-PR Verification](./pre-pr-verification.md)), then complete the
   [Contributor Self-Review Form](../.github/checklists/contributor-self-review.template.md).
4. If you're waiting on a review or payment decision, read
   [Payment-Period Conduct Guidance](https://github.com/Axionvera/pocketpay-contracts/blob/main/docs/payment-period-conduct.md)
   before posting a status question.
