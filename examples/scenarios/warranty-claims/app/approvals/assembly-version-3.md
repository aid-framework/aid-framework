# Promotion record: `assemble_packet` v2 to v3

This is the artifact the promotion gate points at. It is a committed file rather than a row in
a database, because the approval has to survive the tool that recorded it: a reviewer reading
this in a year should be able to see who signed, what they were shown, and what the numbers
were.

- **Candidate** — `prompts.assemble_packet`, version 3 (from version 2).
- **Eval** — `warranty_evidence`, target `pipeline:warranty_intake`, `gate.promotion` policy:
  `allowedQualityDrop: 0.05`, `allowedCostIncrease: 0.2`.
- **Approvers required** — `warranty-platform-lead`, `clinical-safety-officer`.

## What changed

Version 3 carries the routing disposition into the packet as `route`, and requires the
`citations` array to be populated from the retrieval bindings rather than from the model's
recollection. Version 2 asked for citations but did not bind them, so the packet could name a
clause number that the corpus did not contain. That is the quality problem being fixed.

## Measurement

| Metric | Baseline (v2) | Candidate (v3) | Allowance | Result |
| --- | --- | --- | --- | --- |
| retrieval hit rate | 0.83 | 0.88 | -0.05 | pass |
| p95 latency (ms) | 6,900 | 7,150 | none declared | pass |
| cost per case (USD) | 0.21 | 0.24 | +0.20 | pass |

The cost rise is inside the allowance and is accepted: the extra tokens buy the citations that
make the packet reviewable. A candidate that traded 14% cost for a 1-point quality gain would
not have been accepted, and the allowance is what makes that a rule instead of a conversation.

## Approval

Under `profile: enterprise` the promotion policy requires a recorded approval, so this file is
the record. A candidate that passes the eval and carries no record is refused by the promotion
gate — the gate proves the review happened, not that the reviewer was right.

| Approver | Role | Decision | Date |
| --- | --- | --- | --- |
| J. Meyer | warranty-platform-lead | approved | 2024-05-14 |
| P. Okafor | clinical-safety-officer | approved | 2024-05-15 |

## What this does not do

Approving this promotion changes what `aid gen` emits. It deploys nothing. The release that
carries it is an ordinary change to `prod`, which goes through
`deployments.prod.approvals` — a second, separate human decision with its own record.
