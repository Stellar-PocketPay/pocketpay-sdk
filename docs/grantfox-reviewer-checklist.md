# GrantFox PR Reviewer Checklist

Use this checklist when reviewing PocketPay SDK pull requests attached to a
GrantFox issue or campaign. It is a reviewer workflow built on the repository's
existing quality, verification, and acceptance-traceability rules; it does not
replace them.

> **Merge status and reward status are separate.** A merge means the repository
> accepted the code or documentation. It does not guarantee GrantFox or campaign
> payment approval.

## Review inputs

Before reviewing, have all of the following open:

- the linked GitHub issue and its current acceptance criteria,
- the pull request diff at the **current head commit**,
- the PR's test / verification evidence and hosted CI checks,
- the [Contribution Quality Gate](./contribution-quality-gate.md),
- the [Acceptance Criteria Traceability](./acceptance-criteria-traceability.md)
  guidance.

Review the submitted head, not an earlier green commit or stale PR description.

## 1. Issue linkage and scope

- [ ] The PR links the intended issue (prefer `Closes #<issue>` when it should
      close that issue).
- [ ] The implementation addresses the issue itself rather than nearby cleanup.
- [ ] Unrelated refactors, formatting churn, generated output, and dependency
      changes are absent or explicitly justified.
- [ ] The PR description says what changed and why.

**HOLD** when the issue cannot be matched to the submitted work.

## 2. Meaningful implementation

- [ ] Behaviour issues contain the required behaviour in the owning module;
      comments, types, docs, or stubs alone are not treated as implementation.
- [ ] Bug fixes address the root cause rather than only masking the observed
      symptom.
- [ ] Documentation / developer-experience issues are completed end-to-end:
      the requested guide or checklist exists and is discoverable from the
      requested contributor surface.
- [ ] No acceptance criterion is satisfied only by an unsupported claim in the
      PR description.

Use [Meaningful Change Review](./meaningful-change-review.md) and the
[Contribution Quality Gate](./contribution-quality-gate.md) for examples.

## 3. Tests and verification

- [ ] Behaviour changes have focused tests for the changed behaviour and
      relevant failure paths.
- [ ] A regression fix includes a regression test when the repository can
      exercise the failure deterministically.
- [ ] Documentation-only work does **not** add fake product tests merely to
      create a test count; instead, verify links, paths, commands, and claims
      against the repository.
- [ ] The PR records the relevant verification commands actually run.
- [ ] Hosted CI is checked on the current PR head. Any missing, skipped, or
      pre-existing failing check is described accurately instead of being
      reported as green.

The normal contributor gate is `npm run verify:pr` / `npm run presubmit`;
reviewers should judge exceptions by scope rather than accepting unexplained
omissions.

## 4. Acceptance-criteria traceability

For every issue acceptance criterion:

- [ ] The PR gives a status and concrete evidence location.
- [ ] Behaviour criteria point to implementation and test evidence.
- [ ] Documentation criteria point to the requested published/discoverable
      documentation.
- [ ] Partial, skipped, or out-of-scope criteria are explicitly explained.

Use the table format in
[Acceptance Criteria Traceability](./acceptance-criteria-traceability.md).
An unexplained incomplete criterion is a **HOLD**.

## 5. Security and public-contract review

When the diff touches a sensitive or public boundary:

- [ ] Secret keys, credentials, signed payloads, and sensitive error internals
      are not newly exposed or logged.
- [ ] Wallet, transaction, network, Soroban, and vault changes respect the
      contributor security checklist in [CONTRIBUTING.md](../CONTRIBUTING.md).
- [ ] New dependencies are justified through
      [Dependency Review](./dependency-review.md).
- [ ] Public API changes preserve compatibility or include the required
      migration/deprecation guidance.

Mark non-applicable items as such; do not manufacture security work for a
documentation-only change.

## 6. Documentation and operational truth

- [ ] Public behaviour, commands, and configuration are documented when they
      changed.
- [ ] Examples match current APIs and repository paths.
- [ ] Validation statements distinguish local checks from hosted CI.
- [ ] Known limitations are stated rather than hidden behind broad claims.

## 7. Reviewer verdict

A GrantFox review ends in one of two repository verdicts:

### PASS

Use PASS only when every applicable acceptance criterion is complete, the
implementation is meaningful, the evidence matches the current head, and no
unresolved correctness/security blocker remains.

### HOLD

Use HOLD when a concrete requirement is missing. State the exact blocking item
and the evidence needed to clear it; avoid vague requests for "more tests" or
"more polish" when the issue does not require them.

Suggested review note:

```text
GrantFox review: PASS | HOLD
Issue: #<number>
Head reviewed: <sha>
Acceptance criteria: <complete/total>
Verification: <commands/checks actually observed>
Blocking items: <none or exact remaining items>
```

## Related reviewer resources

- [Contribution Quality Gate](./contribution-quality-gate.md)
- [Acceptance Criteria Traceability](./acceptance-criteria-traceability.md)
- [Pre-PR Verification](./pre-pr-verification.md)
- [Meaningful Change Review](./meaningful-change-review.md)
- [SDK Security Readiness Review](./sdk_security_readiness_review.md)
