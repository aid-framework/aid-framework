---
description: "A 0.28 enterprise spec that promotes a prompt without bumping it, spends a quality allowance on no metric, and keeps free-text feedback without a redaction rule -- three named refusals, their fixes, and the promotion that is then judged."
---

# Walkthrough: the promotion gate and the feedback it collects

Spec 0.28 adds the two halves of a self-improvement loop that can be **gated from git alone**: a
declared policy for promoting a candidate, and a declaration of the feedback a service takes back
from its users.

Neither half is a control plane. `evals[].gate.promotion` states what a candidate may cost in
quality and in spend; `observability.feedback` states which signals are collected and which fields
may ride along. AID judges both at build time and then stops: nothing promotes itself, nothing
deploys itself, and no server keeps the verdict.

This walkthrough starts from a document that passes, breaks it in four ways, and ends with
`aid eval --compare` judging a real candidate. Every console block below is real output from this
repository's CLI.

## The spec

Start from the enterprise claims desk:

```bash
cp ../../packages/spec/test/fixtures/valid/v28-feedback-promotion.spec.yaml claims-desk.spec.yaml
```

```console
$ aid validate claims-desk.spec.yaml
claims-desk.spec.yaml: ok (0 errors, 0 warnings)
```

Two parts of it matter here. The prompt is at version 2, and the eval's promotion policy records
version 1 as the accepted baseline:

```yaml
prompts:
  classify_claim:
    version: 2
    # ...

evals:
  triage_regression:
    # ...
    gate:
      ci: true
      promotion:
        allowedQualityDrop: 0.01
        allowedCostIncrease: 0.1
        baseline:
          prompt: classify_claim
          version: 1
        approval:
          by: [platform-lead]
          record: app/approvals/triage.md
```

`baseline` is **required**, not defaulted. The IR cannot see what the previous version's template
said, so the only way to know a template changed is for the document to name the version it replaced.
Without it the gate could not tell a bump from a no-op, and the CLI would compare a candidate
against whatever happened to be checked out.

## Promoting the version already in force

Move the baseline up to the version that is already declared, which is what an author does after
copying the block from the previous release:

```yaml
        baseline:
          prompt: classify_claim
          version: 2
```

```console
$ aid validate claims-desk.spec.yaml
claims-desk.spec.yaml: 1 error(s), 0 warning(s)
claims-desk.spec.yaml: error: the promotion gate rejected "triage_regression": baseline records "prompts.classify_claim" at version 2, and the document declares version 2 is the accepted baseline, so nothing has been bumped -- two different templates would share one identity [ir/prompt-version-stale]
    at evals.triage_regression.gate.promotion.baseline.version
    hint: bump prompts.classify_claim.version above 2 for the candidate, or move the baseline up once the new version is accepted
```

A promotion is a claim that a **different** thing is now better. Two different templates behind one
version number is exactly what the version counter exists to prevent, so equality is a refusal and
not a no-op.

## Rolling one back

The opposite mistake gets its own message, because the fix is different. Declare the prompt at
version 1 while the baseline records 2:

```yaml
prompts:
  classify_claim:
    version: 1
```

```console
$ aid validate claims-desk.spec.yaml
claims-desk.spec.yaml: 1 error(s), 0 warning(s)
claims-desk.spec.yaml: error: the promotion gate rejected "triage_regression": baseline records "prompts.classify_claim" at version 2, and the document declares version 1 is behind the accepted baseline 2, which is a rollback rather than a promotion -- two different templates would share one identity [ir/prompt-version-stale]
    at evals.triage_regression.gate.promotion.baseline.version
    hint: bump prompts.classify_claim.version above 2 for the candidate, or move the baseline up once the new version is accepted
```

Both readings are refused, and the message says which one it is, so the author is not left guessing
whether they bumped too little or went backwards. Rolling a prompt back is a real operation; it is
not a promotion, and the policy is not the mechanism for it.

Restore version 2 and the document passes again.

## A cost ceiling with nothing to check it against

`allowedCostIncrease` compares two cost measurements. The eval above records an `exact` metric and
a `cost` metric, so the ceiling has something to read. Take the cost metric away:

```yaml
    metrics:
      - kind: exact
        field: category
```

```console
$ aid validate claims-desk.spec.yaml
claims-desk.spec.yaml: 1 error(s), 0 warning(s)
claims-desk.spec.yaml: error: the promotion gate rejected "triage_regression": allowedCostIncrease is 0.1 but the eval measures no cost, so there is no baseline cost for the candidate to increase and the ceiling would be enforced against nothing [ir/promotion-cost]
    at evals.triage_regression.gate.promotion.allowedCostIncrease
    hint: add a `cost` metric with a `max` ceiling so both baselines record a cost, or drop allowedCostIncrease
```

The same argument applies one field over. `allowedQualityDrop` is a budget over a **quality** metric,
so a policy whose eval records only `cost` and `latency` is refused by `ir/promotion-regression`: an
allowance no metric can spend is how a stale budget survives a release.

## Feedback that could keep a customer's address

Now the other half. The document collects three signals, and `correction` is the only one that
stores prose:

```yaml
observability:
  feedback:
    signals:
      rating:
        kind: thumbs
      correction:
        kind: correction
      handoff:
        kind: escalation
    pii:
      redact:
        - subject
    retentionDays: 90
    persistent: true
```

Add an `email` field to the output type, which is a name AID already treats as sensitive:

```yaml
types:
  TicketClassification:
    kind: struct
    fields:
      category:
        type: string
        required: true
      email:
        type: string
        required: true
```

```console
$ aid validate claims-desk.spec.yaml
claims-desk.spec.yaml: 1 error(s), 0 warning(s)
claims-desk.spec.yaml: error: the feedback gate rejected this document: signal "correction" stores free text under pii.redact entries that do not cover email, and the store is declared as persistent [ir/feedback-pii]
    at observability.feedback.pii.redact
    hint: add email to observability.feedback.pii.redact, or take the text signal out of the persistent store
```

Sensitivity is **inferred**, not asserted: `email`, `phone`, `token`, `card_number` and the rest of
the name list are marked when the IR is built. A gate that only read a `sensitive: true` flag would
protect the fields an author remembered to label, which is the same set the gate already knew about.

The `thumbs` and `escalation` signals carry no text, so neither pulls in this rule. Refusing them
would make the honest, minimal signal the expensive one.

Add the field to the redaction list and the document passes:

```yaml
    pii:
      redact:
        - subject
        - email
```

## Keeping it forever

The second feedback refusal is about duration rather than content. A persistent store with no
retention limit keeps whatever it is given:

```yaml
    persistent: true
```

```console
$ aid validate claims-desk.spec.yaml
claims-desk.spec.yaml: 1 error(s), 0 warning(s)
claims-desk.spec.yaml: error: the feedback gate rejected this document: the feedback store is declared persistent with no retentionDays, so every signal it receives is kept indefinitely [ir/feedback-pii]
    at observability.feedback.retentionDays
    hint: set a retentionDays limit, or `persistent: false` to keep feedback for the request only
```

A spec may say it keeps feedback forever, but it may not say it by omission. Neither field is
defaulted, in either direction, for the same reason: a default retention window is a policy nobody
wrote, and a default `persistent: false` would silently drop the signals a `persistent: true` was
there to keep.

## Judging a candidate

The gate keeps a document coherent. It does not measure anything. Measuring is
`aid eval`, and 0.28 adds a second mode to it: `--compare` reads two **recorded** baselines and
applies the policy.

They are two runs, not one, because recording replaces the accepted side of the comparison:

```console
$ aid eval claims-desk.spec.yaml --baseline --compare accepted.baseline.json --candidate candidate.baseline.json
<spec>: error: --compare and --baseline are separate runs: one records a baseline, the other judges a candidate against one. [cli/eval-compare-pair-required]
    hint: Record with `aid eval --baseline`, then compare with `aid eval --compare <accepted> --candidate <candidate>`.
```

Each file is the baseline `aid eval --baseline` writes:

```json
{
  "dataset": "evals/triage.jsonl",
  "dataset_version": "3",
  "model": "gpt-4o-mini",
  "metrics": [
    { "metric": "exact", "runs": 40, "mean": 0.95, "stdev": 0.01 },
    { "metric": "cost", "runs": 40, "mean": 0.3, "stdev": 0.0 }
  ],
  "note": "recorded by aid eval --baseline"
}
```

A candidate that lost half a point, against an allowance of one:

```console
$ aid eval claims-desk.spec.yaml --compare accepted.baseline.json --candidate candidate.baseline.json
promotion of eval "triage_regression" over dataset evals/triage.jsonl@3

  ok   exact            accepted  95.00%  candidate  94.50%  change   -0.50%  allowance 1.00%

  verdict: refused
<spec>: error: The promotion was refused: "triage_regression" requires a recorded approval at app/approvals/triage.md, and that file is missing or empty. [cli/eval-compare-approval-missing]
    at evals.triage_regression.gate.promotion.approval.record
    hint: Commit the approval record at app/approvals/triage.md, signed off by one of: platform-lead.
<spec>: warning: allowedCostIncrease (10.00%) was not judged: a recorded baseline carries quality metrics only, because the runtime measures no cost metric yet. [cli/eval-compare-cost-unjudged]
    at evals.triage_regression.gate.promotion.allowedCostIncrease
    hint: Cost ceilings are enforced per request by the gateway budget the spec declares; the promotion cost check is listed as not built in docs/features.md.
```

Three things to read in that output.

**The table is the evidence.** `accepted`, `candidate`, the change and the allowance it was measured
against, so a reviewer does not have to trust the verdict word alone.

**The approval is a file.** Under `enterprise`, `gate.promotion.approval` names a path, and the run
refuses until that path exists and is not empty. There is no reviewer service and no webhook: the
record is a committed document, which is what makes it survive a branch, a rebase and a repo
transfer.

**The cost ceiling was not judged, and the run says so.** A recorded baseline carries quality metrics
only, because no runtime measures cost yet. Exiting zero while a declared ceiling went unchecked
would be the exact failure this project refuses, so the warning is printed on every comparison that
declares one.

A candidate that lost five points is refused on the number:

```console
$ aid eval claims-desk.spec.yaml --compare accepted.baseline.json --candidate losing.baseline.json
promotion of eval "triage_regression" over dataset evals/triage.jsonl@3

  FAIL exact            accepted  95.00%  candidate  90.00%  change   -5.00%  allowance 1.00%

  verdict: refused
<spec>: warning: allowedCostIncrease (10.00%) was not judged: a recorded baseline carries quality metrics only, because the runtime measures no cost metric yet. [cli/eval-compare-cost-unjudged]
    at evals.triage_regression.gate.promotion.allowedCostIncrease
    hint: Cost ceilings are enforced per request by the gateway budget the spec declares; the promotion cost check is listed as not built in docs/features.md.
<spec>: error: The promotion was refused: metric "exact" dropped 5.00% (95.00% accepted, 90.00% candidate), and gate.promotion.allowedQualityDrop on "triage_regression" is 1.00%. [cli/eval-compare-regressed]
    at evals.triage_regression.gate.promotion.allowedQualityDrop
    hint: Improve the candidate, or raise allowedQualityDrop in the spec and say why in the commit that raises it.
```

Record the approval and the same candidate is promotable:

```console
$ mkdir -p app/approvals
$ printf '# Approved\n\nplatform-lead, 2026-02-14.\n' > app/approvals/triage.md
$ aid eval claims-desk.spec.yaml --compare accepted.baseline.json --candidate candidate.baseline.json
promotion of eval "triage_regression" over dataset evals/triage.jsonl@3

  ok   exact            accepted  95.00%  candidate  94.50%  change   -0.50%  allowance 1.00%

  verdict: promotable
<spec>: warning: allowedCostIncrease (10.00%) was not judged: a recorded baseline carries quality metrics only, because the runtime measures no cost metric yet. [cli/eval-compare-cost-unjudged]
    at evals.triage_regression.gate.promotion.allowedCostIncrease
    hint: Cost ceilings are enforced per request by the gateway budget the spec declares; the promotion cost check is listed as not built in docs/features.md.
```

Exit `0` is a **verdict**, not a deployment. Merging the branch that carries the bumped prompt
version, the raised baseline and the approval record is the promotion. AID never runs that step for
you.

## What this build does not do

Being precise about the boundary is the point of the phase:

- **Nothing promotes itself.** `--compare` reports; the merge promotes. There is no auto-deploy path
  and no gate that could be satisfied by a bot.
- **No cost comparison.** `allowedCostIncrease` is declared, gated for coherence, and reported as
  unjudged on every run, because a recorded baseline carries quality metrics only.
- **No feedback route or storage is generated.** `observability.feedback` is a declaration the
  `feedback` gate checks. AID does not emit an endpoint that accepts a thumbs vote, does not write
  the table, and does not enforce `retentionDays` at runtime.
- **No prompt version history.** The gate compares the version in the document with the version in
  the policy. It does not know what the previous template said, which is why `baseline` names a
  version rather than relying on history.
- **No statistical comparison.** `--compare` applies the declared allowance to the recorded means.
  It does not run a significance test, and a candidate at the edge of the allowance is the author's
  judgement, not the tool's.

Everything above is recorded as a deliberate non-build in `docs/rfcs/0001-agents-at-scale.md` §10.4
rather than implied by a command that does not exist. What 0.28 ships — the promotion policy and the
feedback declaration — is counted on the [features page](../features.md), and the five refusals are
listed under [what AID refuses](../features.md#refused-on-purpose).
