<!--
  SDK PR Template — testing-evidence edition.
  Fill every section. PRs without testing evidence may be returned for revision.
-->

## Related Issue

<!-- Reference the issue this PR resolves. Use "Closes #NNN" to auto-close. -->
- Closes #

## Implementation Scope

<!-- What problem does this solve, and which modules did you touch? Be specific. -->
- **Problem addressed:**
- **Modules changed:** (e.g. `src/payments/validation.ts`, `src/errors/index.ts`)
- **Public API impact:** (none / new export / breaking change — explain if breaking)

## Tests Added / Changed

<!-- REQUIRED. If tests are genuinely not applicable (docs-only, config-only),
     state why clearly — do not leave this blank. -->
- [ ] New tests added: (list files, e.g. `tests/validation.test.ts`)
- [ ] Failure paths covered: (negative inputs, error classification, edge cases)
- [ ] Docs-only / config-only PR — tests not applicable because:

## Commands Run (local verification)

<!-- Run `npm run presubmit` (or `npm run verify`) and paste the result.
     This is the single local gate that mirrors CI:
     lint -> circular check -> tests -> coverage -> build.
     Prefer also pasting `npm run coverage:baseline` for changed-module context
     (see docs/coverage-baseline.md). -->
- [ ] `npm run presubmit` passed locally (or `npm run verify`)
- [ ] `npm run coverage:baseline` reviewed for changed modules (or N/A: docs-only)

```
<paste `npm run presubmit` / `npm run coverage:baseline` output summary here>
```

## CI Status

<!-- Confirm the checks on the PR are green. If any are red, explain why and
     link the run. -->
- [ ] All CI checks are passing (or red-only for a documented, pre-existing reason)
- CI run link (if needed):

## Acceptance Criteria Coverage

<!-- Copy EVERY issue acceptance criterion verbatim. Evidence from this exact
     PR head only. See .github/checklists/acceptance-criteria.template.md and
     docs/acceptance-criteria-traceability.md. Give incomplete rows a reason. -->

| Criterion | Implementation evidence | Test evidence or justified N/A | Documentation impact | Status |
| --- | --- | --- | --- | --- |
| (Exact issue criterion) | (Changed source path/behavior) | (Case and observed result, or N/A reason) | (Docs path or N/A) | Complete / Partial / Blocked |

<!-- Explain all non-Complete rows with remaining work, owner/follow-up issue,
     and whether the gap blocks this issue's acceptance. -->

## Contributor Self-Review

<!-- Complete the self-review form before requesting review.
     See .github/checklists/contributor-self-review.template.md -->
- [ ] Self-review form completed and attached

## Contribution Quality Gate

<!-- Contributors: confirm your PR is ready for the maintainer quality gate.
     Maintainers: run the checklist before approving.
     See docs/contribution-quality-gate.md and
     .github/checklists/contribution-quality-gate.md -->
- [ ] I reviewed the [Contribution Quality Gate](../docs/contribution-quality-gate.md) and believe this PR meets it
- [ ] Implementation is complete (not a stub / docs-only when behaviour was required)
- [ ] Tests, CI, docs, and acceptance criteria sections above are filled

## Reviewer Notes

<!-- Anything a reviewer should know: design decisions, trade-offs, follow-ups,
     or areas you're unsure about. -->
-

<!--
  Reminder: a merged PR is NOT automatically payment-approved. Reward
  eligibility is assessed separately (see the campaign's contribution terms).
  Maintainers: do not approve until the Contribution Quality Gate checklist
  passes (.github/checklists/contribution-quality-gate.md).
-->
