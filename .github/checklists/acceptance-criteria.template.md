# Acceptance Criteria Audit — Contributor Template

Copy this file to .github/checklists/issue-<number>.md for each issue PR.
Paste **every acceptance criterion verbatim** from its issue into its own row.
See docs/acceptance-criteria-traceability.md for guidance.

## Issue and scope

- **Issue:** #<!-- issue number -->
- **PR:** <!-- PR link -->
- **Source head:** <!-- actual commit SHA -->
- **In scope:** <!-- expected behavior, not only nearby changes -->
- **Out of scope:** <!-- limitations or "None" -->

## Per-criterion evidence

| Acceptance criterion (copy exact issue text) | Implementation evidence (paths/symbols) | Test evidence (cases/results or honest N/A) | Documentation impact (paths/N/A) | Status (Complete/Partial/Blocked/Out of scope) |
| --- | --- | --- | --- | --- |
| <!-- criterion 1 --> | <!-- source link / line --> | <!-- case and observed result, or N/A with reason --> | <!-- document link / N/A --> | <!-- actual status --> |
| <!-- criterion 2 --> | <!-- source link / line --> | <!-- case and observed result, or N/A with reason --> | <!-- document link / N/A --> | <!-- actual status --> |

Add rows until **every** issue criterion is represented. For documentation-only work,
state "N/A — no runtime behavior change" in test evidence. Never claim CI or
test success from tests authored but not run, old commits, or unrelated PRs.

## Incomplete, deferred, or blocked criteria

For every non-Complete row, identify the remaining work, evidence gap, owner
or follow-up issue, and whether it blocks acceptance. Do not hide omissions.

| Criterion | Remaining work / why incomplete | Follow-up owner or issue | Blocks acceptance? |
| --- | --- | --- | --- |
| <!-- issue criterion --> | <!-- missing behavior/tests/docs --> | <!-- owner or link --> | <!-- Yes or No, explain --> |

## Contributor confirmations

- [ ] All issue acceptance criteria appear in the five-column audit.
- [ ] Evidence targets the current PR source head, not a predecessor.
- [ ] Test evidence distinguishes results, unrun cases, and justified N/A.
- [ ] CI status reflects this exact PR commit; known failures are described.
- [ ] Public API, docs, security and other impacts are documented.
- [ ] Incomplete criteria include follow-up disposition and reviewers can
      distinguish partial work from accepted work.
- [ ] No secrets or environment files are committed.

This form does not establish issue acceptance, a GrantFox reward, or payment.
Those decisions are separate from having a merged PR.
