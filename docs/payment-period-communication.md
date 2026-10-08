# Payment-period communication policy (SDK contributors)

This policy applies to discussions about review decisions and possible rewards for
PocketPay SDK contributions, including GrantFox OSS / FWC26 issues. It supplements
the [SDK Contribution Quality Gate](./contribution-quality-gate.md) and the
[shared PocketPay campaign conduct guidance](https://github.com/Axionvera/pocketpay-contracts/blob/main/docs/payment-period-conduct.md).

## Before contacting maintainers or a reward program

1. Confirm the issue, claim, and pull request all point to the **same actual
   contribution**, with the contributor identity and current code commit clear.
   Include the original issue link, PR link, claim receipt (if the workflow uses
   one), current head, acceptance-criteria summary, and actual verification
   evidence. Distinguish tests authored from tests actually run.
2. Review the [Contributor Self-Review Form](../.github/checklists/contributor-self-review.template.md)
   and [Contribution Quality Gate](./contribution-quality-gate.md). Fix gaps in
   source, documentation, requested checks, and issue requirements on the same
   original branch before asking why an incomplete PR has not been accepted.
3. Confirm the program's actual eligibility, claim, approval, payout-setup, and
   timing instructions. A GitHub merge or a "Maybe Rewarded" label alone does
   not mean a cash award has been approved, nor does it establish a dollar value.

## Communicate once, clearly, and in the appropriate place

- State your **affirmative compensation claim** for eligible delivered work.
  A request for status or payment does not waive, abandon, or relinquish the
  claim. Do not describe bounty work as a non-claim when compensation is sought.
- Prefer one concise, evidence-backed follow-up in the issue or pull request
  thread designated by the sponsor or platform. Link the existing record instead
  of creating duplicate issues, PRs, tickets, emails, or cross-channel requests.
- Wait for any program-published review or payment window before escalating;
  do not invent a deadline where the program provides none. After the window
  passes, provide a single factual follow-up with the contribution and claim
  identifiers, what action remains, and a request for the next expected step.
- Keep messages professional and focused on the specific eligibility, quality,
  merge, or payment decision. Repeated complaints, insults, threats, mass tagging
  and requests made solely to flood communication channels are not acceptable.
- If new information materially changes the case, update the canonical thread
  with that evidence. Do not erase past submissions, author attribution, claims,
  comments, acceptance records, or payment receipts.

## What reviewers and contributors should distinguish

| Stage | Evidence | What can be concluded |
| --- | --- | --- |
| Source delivered | Commit and readable PR | Contribution is available for review |
| Claim registered | Program or issue receipt | Compensation has been requested, not yet approved |
| Code merged | Sponsor merge receipt | Code was accepted into the repository, not necessarily reward-approved |
| Reward approved | Explicit program decision | A payable award may exist subject to terms and setup |
| Payment completed | Provider settlement receipt | Funds were reported as paid |

The sponsor and reward-program terms control any eligibility, deadlines,
disputes, approvals, and payment requirements. This communication guidance does
not add a waiver, change eligibility, block a good-faith appeal, or grant the
SDK maintainers authority over a separate program's payment decision.

For a practical pre-request checklist, use the
[Evaluation Readiness Index](./evaluation-readiness.md). Security concerns and
code defects should still be reported through their appropriate channels
regardless of the payment timetable.
