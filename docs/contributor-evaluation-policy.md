# Contributor Evaluation Policy

This policy defines the review and reward expectations for PocketPay SDK issue work, including issues tracked by the GrantFox OSS campaign. It complements the existing [Evaluation Readiness Index](./evaluation-readiness.md), [Contribution Quality Gate](./contribution-quality-gate.md), and [Acceptance Criteria Traceability](./acceptance-criteria-traceability.md).

## Merge is not payment approval

A merged pull request means the repository accepted the contribution. It does **not** guarantee GrantFox reward approval or payment.

GrantFox evaluation happens after merge and remains a separate decision. Contributors should expect that evaluation to consider whether the issue was completed, whether the change is technically and editorially sound, whether required tests and CI checks were satisfied, and whether the pull request meets the repository's contribution standards.

Do not treat a merge notification, closed issue, or approving review as a payout confirmation.

## Contributor responsibilities before review

Before requesting review:

1. Read the issue's full acceptance criteria and map every criterion to a concrete change.
2. Keep the pull request focused on the claimed issue; do not replace required implementation with adjacent cleanup.
3. Complete the [Contributor Self-Review](../.github/checklists/contributor-self-review.template.md).
4. Follow the repository's testing guidance for the area you changed.
5. Run the contributor verification commands required by the repository, including `npm run verify:pr` / `npm run presubmit` where applicable.
6. Record any genuinely pre-existing CI failure or issue-scoped exception in the pull-request description instead of hiding it or weakening a gate.

Documentation-only work still has acceptance criteria. It does not require invented runtime tests, but links, commands, examples, and policy statements requested by the issue must be complete and internally consistent.

## Testing and CI expectations

The default expectation is that changes preserve the repository's automated quality gates.

- Behaviour changes should include the relevant success, failure, and regression coverage described by [Testing](./testing.md) and the [SDK Module Test Matrix](./module-test-matrix.md).
- Contributors should run the documented pre-PR verification flow and report the applicable result in the pull request.
- GitHub CI for the pull request should be green before approval, except for a clearly identified pre-existing or infrastructure failure that maintainers explicitly accept.
- Tests or checks must not be removed, skipped, or weakened merely to make a contribution appear green.

The [Contribution Quality Gate](./contribution-quality-gate.md) is the maintainer-facing source of truth for these checks.

## Acceptance-criteria completion

Issue acceptance criteria are part of the deliverable, not optional review suggestions.

A pull request should identify the related issue and make it easy for a reviewer to trace each criterion to the changed files or resulting behaviour. Use the [Acceptance Criteria Traceability](./acceptance-criteria-traceability.md) guidance and the repository checklist template.

If a criterion cannot be completed as written, raise that mismatch on the issue or pull request. Do not silently mark partial work as complete.

## Self-review and maintainer review

Contributor self-review happens before maintainer review. The self-review should catch missing criteria, unrelated scope, absent error paths, stale docs, and incomplete verification evidence.

Maintainers then apply the repository's quality gate to the actual diff, CI state, documentation impact, and issue criteria. A maintainer may hold a pull request for concrete missing items even when the implementation is otherwise useful.

Repository approval and GrantFox reward evaluation remain separate steps.

## GrantFox post-merge evaluation

For GrantFox-tracked issues:

1. Complete the issue and repository review process first.
2. Merge establishes that the contribution was accepted into the repository; it does not establish reward approval.
3. GrantFox evaluates the merged contribution under the campaign's evaluation process.
4. Reward status should be taken from the GrantFox/campaign decision, not inferred from GitHub merge state.

Contributors are responsible for keeping their payout identity and any campaign-required claim information accurate on the appropriate GrantFox or issue surface.

## Payment-period conduct

During evaluation or payment periods, keep payment discussion concise and on the canonical issue, pull request, or GrantFox claim surface.

Do **not** spam community channels, repeat the same payout-status question across multiple threads, or recruit unrelated maintainers/community members to escalate a routine payment check.

When a follow-up is necessary, make one useful message that includes the issue, merged pull request, and claim or payout identifier needed to resolve the question. Add another message only when there is new information or a maintainer/evaluator asks for it.

This keeps community channels usable and gives reviewers one auditable place to resolve the claim.

## Ready-for-evaluation checklist

Before treating a merged contribution as ready for GrantFox evaluation, confirm:

- [ ] Every issue acceptance criterion is completed or explicitly resolved with the maintainer.
- [ ] Contributor self-review is complete.
- [ ] Required tests and repository verification checks were handled according to the touched area.
- [ ] Pull-request CI is green or an accepted pre-existing/infrastructure exception is documented.
- [ ] Documentation and public-facing behaviour match the implementation.
- [ ] The merged PR and issue are linked clearly.
- [ ] GrantFox/payout identity information is present on the appropriate campaign surface.
- [ ] Payment follow-up, if any, stays on the canonical claim/review surface rather than community-channel spam.
