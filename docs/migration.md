---
description: "What each spec language version changed, what it costs, and the fix when aid validate refuses a document."
---

# Migrations

AID is pre-1.0, and every spec language version so far has been **additive**: a later version
accepts every document an earlier one accepted, and reads it the same way. Upgrading is therefore
usually a one-line edit to `specVersion`. This page records what each step changed, what a
document has to do to earn it, and what to do when the build refuses.

A construct that needs a later version is reported as `spec/not-supported`, naming the version it
needs and the property that triggered the rule. It is never silently dropped, and it never becomes
an "unknown key" — that would send you looking for a typo in a key that is spelled correctly.

## How to use this page

Run `aid validate` against the document. If it refuses with `spec/not-supported`, the message
names the version and the exact path. Bump `specVersion` to that version and no further: each
version is its own gate, and jumping ahead only means the next refusal is less specific.

Nothing here requires a hosted service, a network call, or an account. Every rule below is
enforced by the compiler against the document alone.

## 0.24 to 0.25: delivery profiles and placement

The first version that puts **where a deployment lands** in the spec instead of in the shell that
ran the apply, and the first that lets a document declare which class of customer it is built for.

### What 0.25 adds

| Construct | What it says |
| --- | --- |
| `profile` | A named bundle of controls. `standard` (the default, and what an absent `profile` means) or `enterprise`. |
| `deployments[].cloud` | The cloud this deployment lands in: `aws` or `gcp`. |
| `deployments[].region` | The region, and the residency pin. Checked against the region set of the deployment's cloud. |
| `deployments[].audit` | Where the audit record lands: a `sink` of `cloudwatch`, `s3`, `gcs` or `bigquery`, and an optional `retentionDays`. |

### Nothing to do

A document that declares `specVersion: "0.24"` is still accepted at 0.24, byte for byte. A
document that moves to 0.25 and uses none of the new keys generates the same output it did
before — there is no new module, no new file, and no new manifest hash. The keys are additive.

Bump the version when you want one of them, not on principle.

### Why you would bump

`profile: enterprise` is the reason. It is the first construct in AID that refuses a document for
being *unacceptable for a class of customer* rather than for being impossible. Declaring it and
then omitting the controls it promises is a build error, not a warning, and the gate names each
missing control separately so the fix is one line at a time:

- every deployment pins a `region`, so residency is a property of the spec rather than of
  whoever ran the deploy (`ir/profile-region`);
- every deployment pins an `audit` sink, so a record has a destination before it has contents
  (`ir/profile-audit`);
- the document declares at least one guardrail whose `stages` include `output`, so what the model
  says is inspected and not only what it is asked (`ir/profile-guardrail`).

Input guardrails are not restated by the profile: an HTTP pipeline that feeds caller text into a
prompt already requires one, and `ir/security-input-guardrail` owns that rule. Requiring it twice
would mean two diagnostics and one fix.

### What the fix looks like

A refusal reads:

```text
the profile gate rejected "prod": the enterprise profile requires every deployment to pin the region its data must stay in
```

and the hint names the edit. In the document:

```yaml
specVersion: "0.25"
profile: enterprise

guardrails:
  reply_pii:
    stages: [output]
    onFail: block

deployments:
  prod:
    target: container
    cloud: aws
    region: eu-central-1
    audit:
      sink: cloudwatch
      retentionDays: 400
    secrets: []
```

Three refusals to expect while getting there, each with a distinct code:

| Code | What happened | Fix |
| --- | --- | --- |
| `ir/region-target` | The region belongs to the other cloud. | Pin a region the pinned cloud offers. |
| `ir/audit-target` | The sink belongs to the other cloud. | `aws` creates `cloudwatch` and `s3`; `gcp` creates `gcs` and `bigquery`. |
| `ir/audit-conflict` | Two deployments name different audit destinations. | One environment has one destination: give both the same sink and retention, or split the spec. |

### The cloud flag and the cloud key

Before 0.25 the cloud was only a flag: `aid infra --cloud`, defaulting to `aws`. A spec may now
pin it.

- The spec wins. An agreeing `--cloud` is accepted and ignored.
- A **disagreeing** `--cloud` is refused as `cli/infra-cloud-conflict` rather than dropped, so
  nobody deploys to the wrong cloud by running the command they always ran.
- A spec that pins nothing keeps consulting `--cloud`, and `aws` when that is absent — the exact
  behaviour before the key existed.
- Two deployments pinning **different** clouds is a separate refusal, `ir/cloud-conflict`,
  because one module set targets one cloud.

This is the one place 0.25 can refuse a command that used to succeed. It refuses only when the
document and the flag actively disagree, which is the case where one of the two is wrong.

## 0.25 to 0.26: the delivery controls

The control surface an `enterprise` delivery needs before a run can pause, be audited and be
resumed. Every key is additive, so a 0.25 document is still a 0.25 document; what changes is what
an `enterprise` document must now say.

> **What 0.26 gates but does not yet generate.** This release lands the schema, the IR projection
> and the gates. The generated app does not yet emit the durable store, the identity check or the
> approval pause, so `state`, `identity`, `network`, `approvals` and `requiresApproval` are
> **validated and refused when wrong, and pending in the generators**. `/features` says so on the
> row itself. Declaring them is safe — nothing is silently ignored — but do not plan a rollout
> that depends on the pause resuming yet.

### What 0.26 adds

| Construct | What it says |
| --- | --- |
| `state` | The durable store a paused run waits in: `kind` of `redis` or `postgres`, `urlEnv` naming the environment variable that holds the connection string, and an optional `ttlHours`. |
| `agents[].state` | An agent's own store. It replaces the document store rather than merging with it, so a kind and a connection string cannot disagree. |
| `deployments[].identity` | Where a caller is authenticated: `issuer`, `audience`, and the `subjectClaim` / `rolesClaim` / `scopesClaim` that become the runtime `Principal`. |
| `deployments[].network` | `private` (required — see below), an optional `vpcId` / `subnetIds` / `privateEndpoints`. |
| `deployments[].approvals` | The change-control policy for production: `environment`, `requiredApprovals`, and an optional `preventSelfReview`. |
| `pipelines[].steps[].requiresApproval` | A pipeline tool step that stops and asks a human before it runs. |

### Nothing to do for 0.25 documents

A document at `specVersion: "0.25"` is read exactly as before. The new `enterprise` requirements
and the `state` gate are both scoped to `specVersion: "0.26"`, because 0.25 has no `state` key to
satisfy them with — holding the old version to the new rule would make every existing enterprise
document unsatisfiable.

### What a 0.26 `enterprise` document must now declare

| Refusal | What is missing | The fix |
| --- | --- | --- |
| `ir/profile-identity` | No `deployments[].identity`. | Name the issuer, the audience, and the claim that carries the subject. |
| `ir/profile-network` | No `deployments[].network`, or `private: false`. | Declare `network: { private: true }`. |
| `ir/profile-approvals` | A production deployment with no `approvals`. | Declare `approvals: { environment: production, requiredApprovals: 2 }`. |
| `ir/agents-state-store` | An agent that reaches a `write` or `destructive` tool with no store. | Add `state`, on the agent or on the document. |

### Why `network.private` is required rather than defaulted

An omitted `private` is reported, not read as `false`. Whether traffic stays inside a VPC is a
decision about a customer's data, and a default would make the decision for the author silently.
Under `enterprise`, `private: false` is refused as well, because the profile promises otherwise.

### The two new non-profile refusals

`ir/approval-step-tool` refuses an approval in front of a **read** — a tool whose `sideEffects` is
neither `write` nor `destructive` — and refuses a pause in a document that declares no store,
because a run with nowhere to wait would never resume. It applies to every profile: asking a human
to approve a read teaches them to approve without reading, which is worse than no pause at all.

## 0.26 to 0.27: trace export and agent eval targets

Where a deployment's spans belong, and an eval that can name an agent. Both keys are additive, so a
0.26 document is still a 0.26 document.

> **What 0.27 declared but did not send, until 0.1.150.** `export: otlp` states that the spans
> belong in a collector. 0.27 declared that without installing anything, so the spans were still
> dropped; release 0.1.150 added the exporter, in the runtime and behind an explicit call. See
> [0.1.150: the exporter 0.27 declared but did not install](#otel-exporter-release).
> No `specVersion` changed for it, because it changed no spec language.

### What 0.27 adds

| Construct | What it says |
| --- | --- |
| `observability` | A document-level block: `trace` (default `true`), `redact`, and `export` (`otlp` or `none`) with `endpointEnv`. |
| `evals[].target: agent:<id>` | The eval scores an agent run rather than a pipeline response. |

### Nothing to do for 0.26 documents

The block is optional and absent means what it always meant — trace, redact nothing, export
nowhere. The one new enterprise requirement is scoped to `specVersion: "0.27"`, so a 0.26
enterprise document keeps passing with no `observability` section at all, because it has no key
with which to satisfy a rule introduced after it. `evals[].target` accepts every value it accepted
before.

### What a 0.27 `enterprise` document must now declare

| Refusal | What is missing | The fix |
| --- | --- | --- |
| `ir/observability-export` | Records spans but names no destination — an audit trail that dies with the process. | `observability: { export: otlp, endpointEnv: OTEL_EXPORTER_OTLP_ENDPOINT }` |
| `ir/observability-export` | `export: otlp` beside `trace: false`, a destination for spans that are not recorded. | Record the spans, or drop the destination. |
| `ir/eval-trajectory` | An `agent:` eval target. | Target the pipeline that runs the agent: `target: pipeline:<id>`. |
| `ir/eval-trajectory` | A `tool-trace` metric. | Score the response with `exact`, `contains`, `json-schema`, `llm-judge` or `assert`. |

### Why `export` and `endpointEnv` require each other

A destination with no variable to read is a span that goes nowhere, and a variable with no
destination is a string nobody reads. Neither is defaulted: `endpointEnv` names the variable, and
guessing its name would generate an app that reads a variable the operator never set.

### Why `cost` and `latency` are not refused alongside `tool-trace`

The eval runner cannot score any of the three today, but `cost` and `latency` each carry a second
meaning this build does honour. A `cost` ceiling becomes the eval's `costBudget` and is checked
against a static estimate by the cost gate; a `latency` ceiling becomes `latencyBudgetP95Ms` and
reaches the deploy plan. Refusing them here would delete a working check to make a rhetorical
point. `tool-trace` has no second meaning and no consumer at all, so it is refused.

## 0.28 to 0.29: one base spec, one overlay per customer

Until 0.29 a spec was one document for one service. Delivering the same agent to twenty customers
meant twenty documents, and nothing said which differences were intended and which were drift.
0.29 adds the missing half: a base spec that names **what a customer may change**, and an overlay
that does it. Additive, so a 0.28 document is still a 0.28 document.

> **What 0.29 declares but does not do.** An overlay is a file, `aid resolve` is a local command,
> and `aid fleet` is a table over the tree. There is no control plane and no registry service: a
> customer deployment exists in git or it does not exist. `aid fleet` re-runs the gates over each
> resolved document, so `ok` means "passes today", not "is deployed" -- AID still holds no
> inventory of what is running.

### What 0.29 adds

| Construct | What it says |
| --- | --- |
| `overridable` | The exact document paths a customer overlay may set, and how far each may move: `true`, `from: [values]`, `max: <number>`, and a separate `allowWeaken` permission. |

### Nothing to do for 0.28 documents

`overridable` is an allowlist with no implicit entries, so a document that omits it accepts no
override at all and reads exactly as before. It is consumed by `aid resolve` before the IR is
built, so it reaches no generator and the generated output for every existing spec is unchanged:
no migration is required either to upgrade or to ignore the key.

### What a 0.29 base spec must declare to accept an overlay

Nothing is overridable until it is listed. To let a customer pick a region:

```yaml
overridable:
  deployments.main.region: { from: [us-east-1, eu-central-1] }
```

An overlay names the base it applies to, the customer, the profile, and the overrides:

```yaml
base: ../base.spec.yaml
customer: acme
profile: standard
overrides:
  deployments.main.region: eu-central-1
```

`aid validate` on an overlay reports the same diagnostics as on a resolved document, plus
`overlay/base-missing` when the base path does not resolve. The other five refusals --
`overlay/path-not-overridable`, `overlay/weakens-control`, `overlay/removes-eval`,
`overlay/value-out-of-bounds`, `overlay/profile-mismatch` -- come from the resolver, so they are
reported by `aid resolve` and by `aid fleet`.

### Why the allowlist matches exact paths

Listing `deployments.main.region` does not open `deployments.main` or anything else underneath it.
A path language with implicit children would mean the set of things a customer may change is only
knowable by simulation, and the point of the list is that it is readable in a diff. The same reason
rules out JSON Merge Patch semantics: the only deletion is an explicit `null` at a listed path, and
a deletion is a weakening.

### Why removing a `gate.ci` eval is un-buyable

`allowWeaken` lets a base author permit a **weaker value** at one path. It cannot permit dropping an
eval that `gate.ci` requires, under any form and whether or not the path is listed: if it could, the
gate would be advisory, and a customer overlay could remove the check that keeps their own deploy
honest. The refusal is `overlay/removes-eval`, and it covers both ways of losing the check: deleting
the eval (`evals.triage_regression: null`) and deleting the flag while keeping the eval
(`evals.triage_regression.gate.ci: null`).

### Why a bound is checked before a weakening

An override of `maxCostBudget: 9` against a `max: 2.5` ceiling is both above the bound and a
relaxation. AID reports `overlay/value-out-of-bounds`, because the bound is the more specific
answer and the weakening hint would advise setting `allowWeaken` -- a permission the base author
may grant and which would still not admit the value.

## 0.29 to 0.30: the alarms the plan was already able to derive

`observability` said where spans go. 0.30 says who gets paged when the numbers move the wrong way,
so the threshold lives in the diff instead of in a console click nobody reviewed.

> **What 0.30 declares but does not do.** AID generates the alarm resource and wires it to
> `alert_channel_ids`, which defaults to empty. Nothing pages anyone until an operator names a
> channel, no collector is deployed, and no exporter is installed in the runtime. `export: otlp` is
> still the declaration that a collector is in the path, not the collector itself.

### What 0.30 adds

| Construct | What it says |
| --- | --- |
| `observability.alerts` | One alarm per entry: `metric`, `window`, `aggregate`, `threshold`, and an optional `source` that narrows it to one agent or eval. |

### Nothing to do for 0.29 documents

The block is optional and the gate is scoped to `specVersion: "0.30"` and above, so a 0.29 document
passes untouched. Nothing new reaches a generator unless an alert is declared, and the emitted
OpenTofu and CDK trees for an earlier document are byte-identical: the module is only written when
`plan.alerts` is non-empty.

### What a 0.30 document must declare

| Refusal | What is missing | The fix |
| --- | --- | --- |
| `ir/alerts-unexported` | An alert with no `observability.export: otlp`, so no collector publishes the series it watches. | Add `export: otlp` and `endpointEnv`, or remove the alerts block. |
| `ir/alerts-aggregate` | A reduction the metric cannot answer, such as `p95` over a cost total. | Use `sum`, `average` or `max` for a quantity; `p95` only for a latency series. |
| `ir/alerts-source` | A `source` naming no declared agent or eval. | Name a declared id, or omit `source` to watch the whole environment. |

### Why the metric list is closed to four

`agent.cost`, `agent.tokens`, `eval.cost` and `eval.latency.p95` are exactly the series the deploy
plan already derives. Guardrail hit rate and approval latency are not on the list even though the
runtime records both, because it records them as span **events** and no derivation reads events: an
alert over either would validate, deploy and never fire. A closed enum is the only way to refuse
that at build time rather than discover it during an incident.

### Why `p95` is required for a latency and refused everywhere else

CloudWatch's `statistic` enum has no percentiles -- a percentile belongs in `extended_statistic` --
so a `p95` in the wrong field would be rejected by the provider at `tofu plan`, layers below the
document. The gate decides instead of defaulting: `p95` is required if and only if the metric is a
latency, so an alarm either names a reduction its metric has or does not build.

### Why `alert_channel_ids` defaults to empty

The compiler knows the metrics and the thresholds; it does not know your account ids. Inventing a
channel would page a stranger, so a generated alarm notifies nobody until an operator sets the
variable. This is documented rather than gated, because "not yet wired to a channel" is a normal
state during a first deploy.

## 0.30 to 0.31: scoring the run, not only the answer

A trajectory eval could already say which tools a case called and how much it cost. 0.31 adds the
three metrics that turn a run into something a regression can fail on, and makes the coverage rule
bite under `enterprise`.

> **What 0.31 declares but does not do.** All three metrics score an offline run driven by a
> scripted or recorded model, so they verify the policy and plumbing of a run -- which tools were
> reachable, in what order they were called, whether an approval was respected -- and not the
> quality of a model answer. Nothing here reads production traffic, and no metric measures a live
> run.

### What 0.31 adds

| Construct | What it says |
| --- | --- |
| `evals[].metrics[].kind: step-count` | `maxSteps`: the number of model calls this case should finish inside. |
| `evals[].metrics[].kind: forbidden-tool` | `forbid`: tools the run must never call, named from the document's own `tools`. |
| `evals[].metrics[].kind: approval-respected` | No fields. Passes only when the run asked for every decision the case scripted, paused nowhere else, and did nothing a reviewer rejected. |

### Nothing to do for 0.30 documents

The three kinds are new enum values, so a 0.30 document cannot have been written to use them, and
every rule below is scoped to `specVersion: "0.31"` and above. That includes the coverage
escalation, which leaves a 0.30 `enterprise` document with the warning it was written against. A
0.31 document declaring none of the new metrics emits the same evaluators as 0.30.

### What a 0.31 document must declare

| Refusal | What is missing | The fix |
| --- | --- | --- |
| `ir/eval-trajectory` | A run metric on a pipeline or prompt target, which returns a response with no trajectory. | Target the agent: `target: agent:<id>`. |
| `ir/eval-metric-vacuous` | A `step-count` ceiling at or above the agent's own `maxSteps`, which the agent's budget reaches first. | Set `maxSteps` below the agent's ceiling. |
| `ir/eval-metric-vacuous` | An `approval-respected` metric on an agent that declares no `humanInTheLoop` and calls no tool with `requiresConfirmation`. | Declare one of the two, or drop the metric. |
| `ir/metric-tool-unresolved` | A `forbid` entry that names no declared tool. | Name a tool from `tools`. |
| `ir/eval-uncovered` | Under `profile: enterprise`, an HTTP pipeline no eval with `gate.ci: true` targets. | Add a CI-gating eval, or declare `profile: standard`. |
| `ir/eval-uncovered` | Under `profile: enterprise`, a retrieval surface with no `retrieval` metric anywhere in the document. | Add one, or declare `profile: standard`. |

### Why a metric that cannot fail is refused

A metric that always passes is worse than no metric: it is a green check that costs a reviewer's
attention and answers nothing. Two of the three kinds have a document-visible way to be
unanswerable while looking complete. A `step-count` ceiling set at or above the agent's own
`maxSteps` is reached by the agent's budget first, so the run is stopped before the ceiling can be
exceeded. An `approval-respected` metric on an agent that never pauses has no decision to score: it
passes trivially or fails every case, and neither is a measurement.

`forbidden-tool` is deliberately not checked that way. Forbidding a tool the agent cannot reach is
a legitimate statement -- "this run must never delete a customer" is the point of the metric, not a
defect in it -- so the only refusal is a `forbid` entry that names no declared tool at all.

### Why the coverage escalation is version-gated

It turns a document that built yesterday into one that refuses today, and a profile that promises
change control should be able to say when it started requiring the measurement. Keying the
escalation to `specVersion` rather than to a flag also means an overlay cannot opt out of it: the
resolved document carries the version, so `enterprise` coverage is a property of what is delivered
rather than of who wrote it.

## 0.27 to 0.28: promoting a candidate, and the feedback that starts a loop

What a document is allowed to do with a candidate, and which feedback it takes back from its users.
Both keys are additive, so a 0.27 document is still a 0.27 document.

> **What 0.28 declares but does not do.** `evals[].gate.promotion` states the policy a candidate
> must satisfy. Nothing promotes itself and nothing auto-deploys: `aid eval --compare` prints a
> verdict, and the merge that carries the bumped prompt version is the promotion. AID generates no
> feedback endpoint and stores no signal, and no runtime measures cost, so a declared
> `allowedCostIncrease` is reported as unjudged on every comparison rather than checked against
> nothing.

### What 0.28 adds

| Construct | What it says |
| --- | --- |
| `observability.feedback` | The signals a service takes back (`thumbs`, `correction`, `escalation`), the fields they may carry (`pii.redact`), and how long they are kept (`retentionDays`, `persistent`). |
| `evals[].gate.promotion` | `allowedQualityDrop`, `allowedCostIncrease`, the `baseline` prompt version being replaced, and the `approval` an `enterprise` promotion requires. |

### Nothing to do for 0.27 documents

Both blocks are optional, and both gates are scoped to `specVersion: "0.28"` and above, so a 0.27
document keeps passing with neither key. Neither block is inherited by a pipeline: `feedback`
describes the process that serves the app, not one route through it.

### What a 0.28 document must declare

| Refusal | What is missing | The fix |
| --- | --- | --- |
| `ir/prompt-version-stale` | `gate.promotion.baseline` names the version already in force, so nothing was bumped. | Bump `prompts.<id>.version` above the baseline, or move the baseline up once the new version is accepted. |
| `ir/prompt-version-stale` | The declared prompt version is behind the baseline: a rollback wearing the name of a promotion. | Roll back deliberately; a promotion is forward. |
| `ir/promotion-regression` | `allowedQualityDrop` on an eval whose metrics are all `cost` or `latency`, so no quality metric can spend it. | Record a quality metric, or drop the allowance. |
| `ir/promotion-cost` | `allowedCostIncrease` on an eval that records no `cost` metric, so there is no baseline cost to increase. | Add a `cost` metric with a `max` ceiling, or drop the ceiling. |
| `ir/promotion-approval` | An `enterprise` promotion with no recorded approval. | Declare `approval: { by: [...], record: <path> }` and commit the record. |
| `ir/feedback-pii` | A persistent feedback store with no `retentionDays`, which keeps everything forever. | Set `retentionDays`, or `persistent: false`. |
| `ir/feedback-pii` | A `correction` signal, persistent, with a `pii.redact` list that misses a field the spec marks sensitive. | Add the field to `pii.redact`, or stop storing the text. |

### Why `baseline` is required

The IR cannot see what the previous version's template said, so "the template changed without a
bump" is undetectable from one document. Requiring `baseline: { prompt, version }` makes the claim
explicit and checkable: the declared version must be **strictly greater** than the baseline. A
default would let a policy pass while describing no candidate at all.

### Why `aid eval --compare` takes two runs

`--baseline` replaces the accepted side of the comparison, so combining it with `--compare` would
judge a file the same run just wrote. The CLI refuses the pair with
`cli/eval-compare-pair-required` instead of silently letting one win.

| Exit | Meaning |
| --- | --- |
| `0` | The candidate is promotable under the policy |
| `1` | Refused: a regression beyond the allowance, or a required approval record that is missing or empty |
| `2` | Nothing was judged: no policy, an ambiguous policy, a half pair, an unreadable baseline, or two different datasets |

A regression names the metric, both means and the allowance it was measured against, so the refusal
is a number rather than an adjective.

## 0.1.150: the exporter 0.27 declared but did not install {#otel-exporter-release}

This one is a **release**, not a spec version. `specVersion` stays `0.30`, and that is the point:
nothing that validated before is refused now, so nothing needs migrating. The declarations are the
same; what changed is that one of them can now be honoured.

### What changed

| Before | Now |
| --- | --- |
| `export: otlp` named a destination. Nothing was installed, so the spans were dropped. | `aid gen` for py-fastapi emits `tracing_export_status()` into `app/generated/observability.py`. Call it at startup and the spans go to the collector named by `endpointEnv`. |
| `ts-vercel` accepted `export: otlp` and dropped the spans. | `ts-vercel` refuses it with `observability-export-unsupported`, because it installs no exporter. It still records spans in-process. |

### What you have to do

If you generate with **py-fastapi** and declare `export: otlp`, add one line to your own entrypoint:

```python
from app.generated.observability import tracing_export_status

tracing_export_status("support-copilot")
```

Then install the extra, which is a separate dependency because not every deployment exports:

```console
pip install "aid-runtime-python[otlp]"
```

Regenerating does not write that line and does not need to: the ASGI entrypoint is yours. That is
the ownership boundary holding, not a gap — the generator emits the call *shape*, your `main.py`
makes the call. If you never call it, nothing is installed and behaviour is exactly what it was
before 0.1.150.

If you generate with **ts-vercel** and declare `export: otlp`, the build now refuses. Two ways out,
and the diagnostic names both: generate the document with py-fastapi, or declare `export: none`
and keep the spans in the process on purpose. Nothing silently changes behaviour — a document that
generated before still generates, unless it was declaring an export the target could never honour.

### Why the call is yours and not the generated app's

A library that installed a global tracer provider on import would decide telemetry for every
application embedding it, and `set_tracer_provider` cannot be undone. So the runtime installs an
exporter only when called, and the generated app exposes the call rather than making it. The cost
is one line in `main.py`; the alternative is a dependency that changes the behaviour of everything
that imports it.

### Why there is no `specVersion` bump

A version bump is owed to a **spec language change**. This added no key, no enum value and no
constraint — the JSON schema's only edits were descriptions, which the reference page quotes. A
document at `0.30` that validated before still validates, unchanged. Bumping the spec version here
would force every document to edit a line to gain nothing, which is exactly the "bump on principle"
this page tells you not to do.

## 0.1.160: `unreviewed` stops being a label {#unreviewed-cases-release}

This is a **release**, not a spec version. `specVersion` stays `0.31`: no key, enum value or
constraint changed. What changed is that a tag the export has always written now refuses something
in the place it was always meant to.

### What changed

| Before | Now |
| --- | --- |
| `aid trace export` tagged every case `unreviewed` and said so in the docs. The tag was advisory: an eval with `gate.ci: true` scored the cases and nothing looked at the tag. | The generated eval refuses a dataset that still carries `unreviewed` when `gate.ci: true`, naming up to five case ids and both ways forward. An advisory eval (`gate.ci` absent or false) still runs them. |
| `aid trace export` wrote a dataset without reading the spec. | It reads the spec first, applies `observability.redact` and `observability.feedback.pii`, and refuses an unreadable or gate-failing document, a document naming a field a trace must never carry, and any export under `profile: enterprise`. |

The refusal lives in the runtime `Dataset` layer, not in the exported module, so a module edited
after generation keeps it. It also means the check holds for a dataset assembled by hand, which is
why the export is not the only writer that meets it.

### What you have to do

If you exported a dataset and wired it into an eval that gates CI, that eval now refuses at
runtime. Two ways out, both named in the error: review each case and drop the `unreviewed` tag, or
take the eval out of the gate while the set is a draft. A hand-curated dataset is unaffected, and
so is an exported one that no gate reads yet.

If a script calls `aid trace export` outside the project root, it now needs `--spec` pointing at
the document. The default path is still `app/app.spec.yaml`, so a script running in the project
root needs no change.

### Why there is no `specVersion` bump

Same reason as `0.1.150`: a bump is owed to a **spec language change**. Both edits here are
descriptions in the JSON schema plus behaviour in the CLI and runtime. A document at `0.31` that
validated before still validates, byte for byte, and the only documents that newly refuse are ones
whose export could not have been honoured honestly.

| Spec | Backward compatible | What it added |
| --- | --- | --- |
| 0.30 | Yes | `observability.alerts`, the threshold each declared metric should page on |
| 0.29 | Yes | `overridable`, the paths a customer overlay may set and the bound each may move within |
| 0.28 | Yes | `observability.feedback` (`signals`, `pii.redact`, `retentionDays`, `persistent`); `evals[].gate.promotion` |
| 0.27 | Yes | `observability` (`trace`, `redact`, `export: otlp`, `endpointEnv`); `evals[].target` widened to `agent:<id>` |
| 0.26 | Yes | `state`; `deployments[].identity`, `.network`, `.approvals`; `requiresApproval` on a pipeline tool step |
| 0.25 | Yes | `profile`; `deployments[].cloud`, `.region`, `.audit` |
| 0.24 | Yes | `gateways` and `deployments[].runtime.gateway`, tools federated behind an AgentCore Gateway |
| 0.23 | Yes | `retrievers[].refresh.schedule`, scheduled re-ingestion |
| 0.22 | Yes | `chunking.strategy: semantic` |
| 0.21 | Yes | The `s3` and `http` retriever sources |
| 0.20 | Yes | `retrievers[].filters` |
| 0.19 | Yes | `retrievers[].refresh.mode: incremental` |
| 0.18 | Yes | `gcp.artifact-registry` images |
| 0.17 | Yes | `aws.ecr` images |
| 0.16 | Yes | Registries beyond `ghcr.io`, named by their repository secrets |
| 0.15 | Yes | The `modelArmor` policy block |
| 0.14 | Yes | `engine: model-armor` guardrails |
| 0.13 | Yes | `deployments[].runtime`, the managed agent runtimes |
| 0.12 | Yes | `knowledgeBases` and `retrievers[].knowledgeBase` |

The full per-version description, including what each version means for a construct that existed
earlier, is in the [`specVersion` row of the spec reference](./reference/spec.md#top-level-keys).

## 0.1.161: redaction stops being a declaration {#redaction-release}

This is a **release**, not a spec version. `specVersion` stays `0.31`: no key, enum value or
constraint changed. What changed is that a guarantee the spec has been able to declare since `0.27`
is now one the generated app keeps, in the place it was always meant to be kept.

### What changed

| Before | Now |
| --- | --- |
| `observability.redact` was refused everywhere. Any document that declared it failed the build with `unsupported-redact`, because no target applied the set, and the docs said so. | A pipeline honours it: the generated app replaces the value of each named field in the text it records with `[redacted:<name>]`, while the model still receives the original. The refusal survives only for a document that runs an **agent**, which has no render to bind a value to. |
| `aid trace export` refused a document whose withheld set was non-empty (`cli/trace-export-redaction-unapplied`), and refused any export under `profile: enterprise`. | It exports a document that withholds a field, because recording already removed those values before the trace was written. Under `profile: enterprise` it still refuses while the set is empty, because such a document has said nothing about what may leave. |

The redaction happens where the prompt is rendered, so it covers a value that was rendered into a
prompt and nothing else. A value the application records by another route -- its own log line, a
tool body it writes -- is outside the guarantee, and the spec reference says so rather than leaving
it to be discovered.

### What you have to do

Nothing. Every document that built before builds byte for byte the same, because a document that
declares no redaction emits no redaction table at all. If you removed `observability.redact` to get
past the old blanket refusal, you can put it back.

Two smaller consequences for scripts:

| Change | What to do |
| --- | --- |
| `cli/trace-export-redaction-unapplied` no longer exists. An export that withholds a field succeeds instead of failing. | Match on `cli/trace-export-enterprise-capture` if you were using the old code to detect "nothing may leave". It now fires only for an enterprise document that withholds nothing. |
| `aid trace export` reports the withheld set as `withheld` in its JSON output. | Read `withheld` rather than parsing the human-readable `policy:` line. |

A document that runs an agent stops here. The refusal names the fields it withholds and says the
work can be served through a pipeline, whose recorded prompt is redacted; there is no flag that
turns the guarantee on for an agent run, because the runner re-sends a transcript it assembled and
no emitted code could strip a value out of it.

### Why there is no `specVersion` bump

Same reason as `0.1.150` and `0.1.160`: a bump is owed to a **spec language change**. The edits here
are descriptions in the JSON schema plus behaviour in the generator, the CLI and the runtime. Every
change in direction is a refusal being **lifted**: documents refused before now build, and no
document that built before stops building.