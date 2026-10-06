# CI Pass Requirements

PocketPay SDK pull requests are expected to leave required verification in a
passing state. A failing check can affect contribution evaluation. A failure
caused by the PR should be repaired before approval instead of being treated as
complete because the implementation itself appears correct.

A merged PR is not automatically reward-approved; contribution and reward
evaluation remain separate.

## Local CI-parity gate

Before opening or updating a PR, run:

```bash
npm run presubmit
```

This executes the repository's local verification steps in order and stops at
the first failure:

| Step | Command | Typical failure |
| :--- | :--- | :--- |
| Type check | `npm run lint` | TypeScript errors or incompatible API use |
| Circular dependencies | `npm run check:circular` | New illegal import cycle |
| Unit tests | `npm test` | Behaviour or regression failure |
| Coverage | `npm run test:coverage` | Coverage runner/configuration failure |
| Build | `npm run build` | Package cannot compile to `dist/` |

`npm run verify` runs the same pipeline without the presubmit step banners.
After that gate passes, `npm run verify:pr` adds git-diff reminders and issue
acceptance-criteria checks. For network-sensitive changes, run
`npm run test:integration` when applicable.

The repository workflow dispatches PR validation to central automation when a
PR is opened, reopened, synchronized, or marked ready for review. A successful
local run reduces avoidable failures but does not replace the status reported
for the PR's current head commit.

## Handling failures

1. Reproduce the failure locally with the narrow command above when possible.
2. Fix the cause. Do not remove a meaningful test, weaken an assertion, or add
   an ignore simply to change the check result.
3. Re-run the failing command, then run `npm run presubmit` so later steps are
   not left unverified.
4. Push the repair and inspect CI on the new head. Evidence from an older commit
   does not establish the current revision.
5. Update the PR evidence when the repair changes implementation details or
   known limitations.

Common failures:

| Failure | First action |
| :--- | :--- |
| Type/lint | Run `npm run lint` and fix the reported TypeScript error |
| Circular dependency | Run `npm run check:circular` and break the cycle |
| Unit regression | Run `npm test` and repair the implementation or an actually incorrect expectation |
| Coverage runner | Run `npm run test:coverage` and inspect dependency/configuration errors |
| Build | Run `npm run build` and resolve emitted package/type errors |
| Integration/network | Run `npm run test:integration` when the changed surface requires it |
| Central automation/infrastructure | Keep the check unresolved, link the run, and request rerun or maintainer action |

## CI status language

Use the status actually observed on the current PR head:

- **Passing**: the relevant check completed successfully.
- **Failing**: the check completed with a failure and still needs resolution
  unless evidence shows it is unrelated to the PR.
- **Pending**, **queued**, **action required**, **cancelled**, and **not run** are
  not passing states. Record the limitation instead of calling CI green.
- A documented pre-existing or infrastructure failure should include evidence
  distinguishing it from the PR change. It is still not a successful run.

The PR template permits a documented pre-existing red check. That exception is
evidence-based, not a shortcut for a failure introduced by the contribution.

## Contributor expectations

Before requesting review:

- run `npm run presubmit` (or the equivalent `npm run verify` pipeline);
- run `npm run verify:pr` for acceptance-criteria and change reminders;
- run relevant integration verification for network-sensitive changes;
- fix PR-caused failures before requesting approval;
- fill the PR template's local-command and CI-status sections with observed
  results; for docs-only work, mark tests not applicable rather than inventing
  a test result; and
- watch remote checks after source updates instead of reusing older evidence.

## Reviewer responsibilities

Reviewers should verify the exact commit being approved, distinguish PR-caused
failures from documented base-branch or automation failures, request repair of
required failures attributable to the PR, and request rerun/maintainer action
when infrastructure prevents completion. Mergeability, a merge event, or an
unexecuted check is not proof that verification passed.

See [Pre-submission Verification](./pre-submission-verification.md),
[Pre-PR Verification](./pre-pr-verification.md), and the
[Contribution Quality Gate](./contribution-quality-gate.md).
