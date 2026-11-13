---
description: "The order of operations for shipping one agent to many customers: a golden path, one overlay per customer, a fleet view, a fleet report, and a gated improvement loop."
---

# Delivering to many customers

You have one agent to run for twenty customers. They differ in region, model and budget
ceiling, and the enterprise ones are held to controls the others are not. The wrong answer is
twenty forks of one repository: they drift, and the control you added in March reaches
nineteen of them.

This page is the order of operations AID is built around. One reviewed base spec, one small
file per customer, and every gate run from git in the customer's own CI. Nothing here needs a
service to be running.

## The shape of a delivery

```text
  app/app.spec.yaml          the base: the agent, its gates, and what a customer may change
  customers/acme.yaml        one overlay per customer: only the paths the base opened
  customers/acme.spec.yaml   the resolved document this customer actually deploys
  artifacts/<customer>/      that customer's trace sink and recorded baseline, downloaded
```

The base is the artifact you review. The overlay is the customer's intent. The resolved spec is
the effect, committed beside the overlay so a reviewer sees both. `artifacts/` is the only part
that is not source, and it is a directory of files rather than a backend.

## 1. Start from a golden path

Two templates ship, and both are re-validated in this repository's tests, so neither can
scaffold a project the gates would reject.

| Template | Profile | What it gives you |
| --- | --- | --- |
| `support-copilot` | `standard` | One triage agent, one reply prompt, guardrails on both sides, and an eval whose gate refuses a quality regression |
| `enterprise-approvals` | `enterprise` | The same service with a pinned region, an audit sink, an identity reference, a private network and a production approval policy |

```console
$ aid init desk --template enterprise-approvals
$ cd desk
$ aid validate
app/app.spec.yaml: ok (0 errors, 0 warnings)
```

`--template` goes through the same lowering and validation as any other spec, which is why the
validate above is a formality and not a leap of faith. Pick `standard` when the customer has no
opinion about where the data sits; pick `enterprise` when the contract has a residency clause,
because the profile is what makes the region pin and the audit sink non-optional.

## 2. Decide what a customer may change

The base names the paths a customer is allowed to decide, and the bounds each one is held to.
Everything else is fixed in the base.

```yaml
overridable:
  deployments.prod.region:
    from: [eu-central-1, us-east-1, ap-southeast-2]
  models.triage.modelId:
    from: [gpt-4o-mini, gpt-4.1-mini]
  agents.triage_agent.maxCostBudget:
    max: 2.5
  deployments.prod.audit.retentionDays:
    max: 730
```

Four rules govern this block, and each one is a refusal rather than a convention:

- **Not listed is not overridable.** An overlay that edits any other path is refused by name
  (`overlay/path-not-overridable`), so a customer file cannot quietly set a field you never
  considered per-customer.
- **A listed path does not open what is beneath it.** There is no wildcard and no "nearby path"
  inference. Listing `deployments.prod.region` says nothing about `deployments.prod.cloud`.
- **`from` is a closed set and `max` is a ceiling.** `max` may be lowered freely and raised not
  at all; a value outside either bound is `overlay/value-out-of-bounds`, and the message says
  which bound was hit.
- **A control cannot be weakened by default.** Lowering a guardrail from `block` to `flag` or
  shortening an audit retention is `overlay/weakens-control` unless the base author wrote
  `allowWeaken: true` on that exact path. `allowWeaken` buys a weaker *value* and never the
  absence of a check: an overlay that removes an eval with `gate.ci: true` is refused no matter
  what the base permits (`overlay/removes-eval`).

That last rule is the whole point of the block. "The customer asked for something looser" stays
a visible, reviewed diff in the base repository instead of an edit buried in a customer file.

## 3. One overlay per customer

An overlay names its base and only the differences:

```yaml
# customers/acme.yaml
base: ../app/app.spec.yaml
customer: acme-eu
profile: enterprise
overrides:
  deployments.prod.region: ap-southeast-2
  models.triage.modelId: gpt-4.1-mini
  agents.triage_agent.maxCostBudget: 1.5
```

```console
$ aid resolve customers/acme.yaml --out customers/acme.spec.yaml
wrote customers/acme.spec.yaml (3 overrides applied)
```

The resolved file is a plain spec: it carries the customer's region and model, the customer's
ceiling, and the base's guardrails, identity, network and approval policy. Commit it. It is what
deploys, and it is what the customer's pull request is reviewed against.

Then make drift a build failure rather than a discovery:

```console
aid resolve customers/acme.yaml --check
```

`--check` exits non-zero when the committed resolved spec no longer matches the overlay it came
from. That is the check that catches the base moving under a customer who has not been
regenerated.

`profile` on an overlay is a checked label, not a second source of truth: it must match what the
resolved document actually declares (`overlay/profile-mismatch`). Raising one customer to
`enterprise` therefore means marking `profile` overridable in the base and setting it in the
overlay, so the stronger controls are gated on the resolved document instead of asserted by a
label.

## 4. The fleet view

```console
$ aid fleet
1 customer under customers

  customer  profile     models        region          ceiling  status
  acme-eu   enterprise  gpt-4.1-mini  ap-southeast-2  $1.50    ok
```

Discovery is by content, not by a directory convention, so overlays kept in more than one place
are still found. The gates are re-run rather than trusted, so `ok` means "passes every gate
today" and not "passed once". `--json` emits the same table as one document for a CI step that
wants to fail on the first `refused` row.

## 5. Measure the fleet

Each deployment's sink and recorded baseline download into one directory per customer, and one
command compares them:

```console
$ aid report artifacts
dir: artifacts
deployment        spans   traces         cost       p95   errors  evals
acme                  2        2   $18.400000     640ms        0  1 baseline(s): exact_match 0.82, cost_usd 0.0042
quiet-customer        —        —            —         —        —  —
zenith                1        1    $9.100000     520ms        0  —
total: 3 span(s) in 3 trace(s) across 2 of 3 deployment(s), $27.500000
```

Two things to read carefully. The dash on `quiet-customer` is **not** a zero: "we collected no
span" and "measured zero spend" are different facts, and only one of them is safe in a budget
conversation. The `2 of 3` on the total line is there for the same reason — a fleet total is an
aggregation over what was measured, so the number of measured deployments belongs beside it.

`--budget` turns the total into a ceiling that fails the job:

```console
aid report artifacts --budget 25
```

Nothing is uploaded and nothing is joined to the repository, so this runs unchanged on a CI
artifact download.

## 6. The improvement loop

This is the loop that makes a delivered agent get better instead of older: production traffic
becomes cases, cases become a candidate, and a candidate becomes a release only by passing a
gate. [Improving an agent over time](./improvement-loop.md) is the same loop as a standalone
playbook, with the order to run the commands in and what each one refuses.

**Capture runs with their text.** The trace sink records spans by default and payloads only when
you ask, because text at rest is your decision:

```console
AID_TRACE_DIR=traces AID_TRACE_CONTENT=1 python -m app.main
```

The document's `observability.redact` set is applied where the prompt is rendered: the model
still receives the real value and the text recorded says `[redacted:<name>]` in its place. A
customer identifier listed there reaches the model and never reaches the sink. It falls back to
the fields the IR already marks sensitive, so naming one more is an addition rather than a
rewrite. `aid trace export` applies the same set, plus anything in
`observability.feedback.pii.redact`, to what it writes. Under `profile: enterprise` it refuses to
export captured content when that set is empty (`cli/trace-export-enterprise-capture`): a
document that names nothing is declaring that nothing it records is sensitive, and the command
does not take that declaration at face value.

That is the pipeline path. An agent run has no rendered prompt to bind to, so it binds where values
arrive named: the arguments of the tool calls its model composes. A named argument is withheld from
the recorded copy and still reaches the model, so a tool call carrying `email` masks the address in
the trace while the tool body works with the real one. The set is re-derived from the transcript a
checkpoint carries, so a resumed run is protected too. Two limits stand:

- **Prose has no field name.** The runner is handed a plain string, so a value that enters only
  through the input text is recorded as written. If your prompts can carry a customer identifier
  and it arrives in prose rather than in a tool argument, redact before the value reaches the
  prompt, or leave payload capture off.
- **A document that declares no tool has nothing to bind.** `aid validate` refuses it
  (`unsupported-redact`) rather than emit a guarantee nothing keeps. Declare the tool whose
  arguments carry the fields, or serve the same work through a pipeline.

`aid trace export` holds an agent document to the same test, and does not accept
`observability.feedback.pii.redact` in its place: a set declared for stored signals says nothing about
what a trace already recorded.

What the set does not cover either way is a value you record by another route — your own log line,
or text a tool body writes somewhere. Redaction is a property of the prompt the gateway renders and
the export it performs, not of the whole process.

**Turn runs into a dataset.**

```console
aid trace export --dataset support_quality --from traces
```

One run is one case: the prompt it was first given, the answer it last produced, and the calls,
cost, wall time, model and tools beside it. The file is written in the same canonical form the
Python `Dataset` writes, so a regenerated dataset diffs cleanly.

Every case is tagged `unreviewed`, and that tag is operative rather than decorative: `expected`
is what the run happened to output, so an `exact-match` eval over it measures *stability*, not
quality. A `gate.ci: true` eval refuses a dataset that still carries the tag, naming the cases, so
a trace export cannot reach a release without a person having looked at it. The next step is that
person editing the file — deleting the cases whose answer was bad, fixing the ones that are
nearly right, and dropping the tag. `aid trace export` refuses to invent a curated dataset for
you, which is also why there is no flag that feeds traces straight into an eval. An eval with
`gate.ci: false` may use an unreviewed dataset as it is, which is how you get a number to look at
before you have curated anything.

**Record the candidate and compare it.**

```console
$ cp app/evals/classify_promotion.baseline.json accepted.json
$ aid eval --baseline
$ cp app/evals/classify_promotion.baseline.json candidate.json
$ aid eval --compare accepted.json --candidate candidate.json
verdict: refused
```

The first `cp` keeps the baseline currently in force under a second name; `--baseline` then
re-records it from the candidate tree, so the two files are the same measurement taken either
side of your change.

The spec states what a candidate is allowed to cost in quality and in spend:

```yaml
evals:
  classify_promotion:
    target: pipeline:answer_ticket
    dataset:
      source: file
      uri: evals/classify_quality.json
    metrics:
      - kind: json-schema
        schema: Answer
      - kind: cost
        max: 0.4
    gate:
      ci: true
      maxRegression: 0.05
      promotion:
        allowedQualityDrop: 0.01
        allowedCostIncrease: 0.1
        baseline: { prompt: classify_ticket, version: 1 }
        approval: { by: [platform-lead], record: app/approvals/classify.md }
```

`baseline` names the prompt version in force, and the candidate tree declares the next one, so
`prompt: classify_ticket, version: 1` beside a prompt now at `version: 2` is the comparison the
policy describes. Both directions are refused: a version equal to the one declared, because
nothing was bumped, and a lower one, because that is a rollback wearing the name of a promotion.

`--compare` reads that policy, judges the allowances, and exits non-zero on a regression. Both are
judged when both are stated: quality against `allowedQualityDrop`, and spend against
`allowedCostIncrease`, from the `cost` block the two baselines record. With no
`allowedCostIncrease` the comparison prints no cost row at all — exactly what it printed before
the allowance existed. Exit `2` means nothing was judged, which is not the same as a pass. Under
`profile: enterprise` the policy must name a committed approval record that exists and has
content.

**Know what a trajectory eval is measuring.** When the target is an agent, the eval can assert on
the steps the run took rather than only on its final answer — the step count it stayed within,
the tools it did and did not call, whether it actually stopped for approval. Those assertions read
the trace, so a scripted or recorded model reproduces them exactly. That makes such an eval a
check on *policy and plumbing*: the step ceiling is enforced, a forbidden tool is refused, an
approval really pauses the run. It does not measure model behaviour. A trajectory eval passing
tells you the guardrail wiring holds; it does not tell you the agent answers well, and it must not
be read as a quality number. Keep a separate quality metric, over real runs, for that.

Which turns fed the run decides how much the pass is worth, so every agent eval prints one
`provenance:` line after its summary: `scripted` when the spec's model is the `fake` provider,
`recorded` when the run replayed a transcript, `live` (with the capture path, when one was written)
when a model actually answered. `aid eval --record <path>` is how a recording is made — a real run
that also writes every request and response in the `AID_EVAL_TRANSCRIPT` shape that replay reads.
Recording is never automatic, in a local run, in CI or in a generated service: it is a per-run flag
and a per-run variable, and the walkthrough in
[exporting traces](../walkthroughs/observability-export.md#capturing-a-real-run-so-a-trajectory-eval-can-replay-it)
lists the combinations that are refused rather than allowed to produce a misleading file. A
recorded run measures the plumbing against turns a model really produced, but it still measures
only the run that was captured. Re-capture when the prompt, the model or a tool contract changes; a
stale recording is a statement about the model that was pinned when it was taken.

**Promote by merging.** Nothing in this loop deploys. Promotion is the gate pass plus the merge
that carries the bumped prompt version; the record in the tree is what an auditor reads later.
A quality allowance on an eval with no quality metric, a cost allowance on an eval with no `cost`
metric, or a cost allowance on a build whose runtime records no spend, are all refused at validate
time rather than discovered as a silent no-op.

## The enterprise checklist

Per customer you are claiming these controls. This is what each one costs and where it stands
today. [What AID enforces, and what stays yours](./boundary.md) carries the same rows in the
shape a reviewer asks for — the diagnostic that refuses it, what is generated, what you provide,
and the risk that remains — beside the checklist to run before the review.

| Control | What the spec declares | Refused when missing | What exists today |
| --- | --- | --- | --- |
| Profile | `profile: enterprise` | `ir/profile-unknown` | Gated, and it is what makes the rows below non-optional |
| Region pin | `deployments.<d>.region` | `ir/profile-region` | Gated and generated into the infra module |
| Audit sink | `deployments.<d>.audit` | `ir/profile-audit` | Gated and generated; the archive is declared only when the document pins one |
| Redaction of recorded text | `observability.redact` | `ir/security-redaction-incomplete` | Enforced by the pipeline at the render and by an agent run at its tool arguments, and honoured by `aid trace export` for both. Two stated limits: a value arriving only in prose, and a document that declares no tool, which the build refuses |
| Output guardrail | any guardrail inspecting model output | `ir/profile-guardrail` | Gated and generated |
| Private network | `deployments.<d>.network.private: true` | `ir/profile-network` | Gated and generated; a two-AZ VPC with private task subnets and one NAT gateway |
| Change approval | `deployments.<d>.approvals` for production | `ir/profile-approvals` | Gated and generated as a pause |
| Eval coverage | a `gate.ci` eval claiming each HTTP pipeline | `ir/eval-uncovered` | A warning under `profile: standard`, a refusal for `enterprise` from spec `0.31` |
| Identity | `deployments.<d>.identity` — issuer, audience, claims | `ir/profile-identity` | Gated only. **No token verification is generated** |
| Durable state | `state`, for an agent that can pause or call a writing tool | `ir/agents-state-store`; from spec `0.32`, `ir/resume-replay-weak` | Generated into the resume route, which keeps the record of a spent checkpoint there, so a replay is refused even after a restart. The paused run itself is still carried by the checkpoint, not by this store |

The identity row is the one that decides your deployment plan, so read it as an instruction rather
than a caveat:

- **You must put your own authentication in front of the app.** AID validates that you named an
  identity and generates nothing that verifies a token, so the identity check is yours to wire
  until it ships. An agent route reaches its tools with whatever principal the ASGI layer gives
  it; nothing is synthesized, and nothing is checked.

The checkpoint no longer travels unprotected. From spec `0.32` an agent that can pause is obliged
to name a signing key (`state.signingKeyEnv`), and the generated route refuses a checkpoint it did
not sign, one past its deadline, and -- where the document declares a durable `state` -- one the
store has already spent, each as a `403` whose `detail.reason` says which. Read the rest of this
row the same way as the identity one:

- **A checkpoint is still a capability, and still a secret.** Signing proves the app issued it; it
  does not prove the person presenting it should have it. The signature stops an edited checkpoint
  from approving a different call, the deadline bounds how long a stolen one is useful, and the
  store stops a replay -- none of the three identifies the caller. Front `/agents/resume` with the
  same authentication as the rest of the app, and hand the checkpoint only to the person whose
  approval it asks for.
- **Without a durable store, a replay still gets through.** Under `profile: standard` a document
  that pauses and declares no `state` gets a signed checkpoint whose replay is refused only by the
  process that issued it, and `ir/resume-replay-weak` says so at build time. `enterprise` refuses
  the same document outright.

Both are recorded in the reference and on the features page rather than left for an operator to
discover by reading generated code. Neither blocks a delivery: they are a line in your networking
plan and an environment variable in your release.

## Leave the boundary clean

Every artifact in this playbook is inside the ownership boundary, so `aid eject` still works:
the base spec, the overlays and the resolved specs are yours, `app/generated/` is the
generator's, and `app/business/` was always yours. Nothing here is a hosted service that a
future release can take away from you.

## What this is not

No control plane, no request proxy, no registry. `aid fleet` reads files and prints a table.
`aid report` reads a directory. `aid resolve` writes a file. Every gate above runs from
`aid validate` in the customer's own CI, and if the repository is deleted, nothing about a
deployment is lost.

Read next: [One base spec, one overlay per customer](../walkthroughs/overlays-and-fleet.md) for
the five refusals drawn out in full, [One report across every customer
deployment](../walkthroughs/fleet-report.md) for the report's own refusals, or [Trace export and
agent evals](../walkthroughs/observability-export.md) for the improvement loop end to end.
