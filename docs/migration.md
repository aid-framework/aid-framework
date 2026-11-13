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

## 0.31 to 0.32: the checkpoint a pause hands back

An agent that pauses returns a checkpoint, and a caller hands it back to `POST /agents/resume` to
continue the run. That made the checkpoint a bearer capability over the call it holds: whoever held
it could approve a refund. 0.32 makes the checkpoint signed and expiring, and adds the two fields
that say where the key and the replay record come from.

> **What 0.32 protects, and what it does not.** A signed checkpoint cannot be edited into a
> different call, and an expired one cannot be presented late. A *replay* -- the same checkpoint
> presented twice -- is refused only where the document declares a `state` store, because the
> record of a spent nonce has to outlive the process that issued it. Without a store, `standard`
> accepts a signed-but-replayable checkpoint and `ir/resume-replay-weak` warns about it; under
> `enterprise` that warning is an error. No hosted service is involved either way: the record
> lives in the store the document already names.

### What 0.32 adds

| Construct | What it says |
| --- | --- |
| `state.signingKeyEnv` | The environment variable holding the checkpoint signing key. A name, never a value. |
| `state.checkpointTtlMinutes` | How long an issued checkpoint may be presented. Omitted means 15 minutes. |

Both are accepted on the document's `state` and on an agent's own `state`, and an agent that
declares neither inherits the document's. The generated resume route now refuses a checkpoint it
did not sign, one past its deadline, and one the store has already spent, each as a `403` whose
`detail.reason` names which of the three it was.

### Nothing to do for a 0.31 document

Nothing in the language moved: a 0.31 document still parses, and every rule below is scoped to
`specVersion: "0.32"` and above or to the `enterprise` profile. A 0.31 document that pauses keeps
the behaviour it was written against, and `aid validate` warns with `ir/resume-unsigned` and
`ir/resume-replay-weak` so the gap is visible rather than silent.

### What a 0.32 document must declare

| Refusal | What is missing | The fix |
| --- | --- | --- |
| `ir/resume-unsigned` | Under `profile: enterprise`, an agent that can pause and no `signingKeyEnv`. | Declare `state.signingKeyEnv`, and set the variable it names in the deployment. |
| `ir/resume-replay-weak` | Under `profile: enterprise`, an agent that can pause and no durable `state`. | Declare a `state` store, `postgres` for more than one replica. |
| `ir/resume-key-conflict` | Two pausing agents naming different signing keys, stores or deadlines. | One checkpoint format: make the declarations agree. |
| `ir/resume-key-alias` | A `signingKeyEnv` whose name already holds another declared credential, or one declared again in `deployment.env`. | Name a variable of its own, and declare it only through `signingKeyEnv`. |

### Why the key is a name and not a value

Every credential in a spec is a variable name: `models.*.apiKeyEnv`, `state.urlEnv`,
`observability.endpointEnv`. The signing key follows the same rule, so a document moves between
environments without edit and no secret enters git. The deploy plan lifts the name into the
release as a secret, which is why declaring the same name in `deployment.env` is refused rather
than merged: one name would otherwise mean two things in one plan.

### Why the deadline is separate from `ttlHours`

`ttlHours` is how long a saved run is kept. `checkpointTtlMinutes` is how long the capability to
approve it lives. They answer different questions -- a run may be resumable for a week while the
approval it is waiting on expires in fifteen minutes -- so collapsing them would let a long
retention silently extend every approval.

## 0.32 to 0.33: who verifies the token

`deployments[].identity` has named an OIDC issuer since 0.26, and the reference read as though the
generated app checked tokens against it. It never did: the signing keys belong to the customer's
identity provider, and a generator that shipped a verifier would be shipping a half-configured one.
What the generated app emits is the *seam* -- a `current_principal` dependency that returns the
anonymous principal -- and the application replaces it. 0.33 adds the field that says who does the
replacing, so the responsibility is declared instead of implied.

> **What 0.33 is.** A declaration and a gate, not a generator. `verifiedBy` names a module path, a
> gateway or a service; it never holds a secret and AID never calls it. `enterprise` refuses a
> deployment that declares `identity` without it, which is the whole enforcement. Nothing about
> token verification is generated, before this version or after it.

### What 0.33 adds

| Construct | What it says |
| --- | --- |
| `deployments[].identity.verifiedBy` | Which component turns a token into a principal. A name, not a credential. |

It is projected into the IR, where the profile gate reads it, and no generated code reads it
at all: the field records a responsibility, so a reviewer sees next to the issuer and the
audience who is responsible for checking them, instead of an implied somebody.

### Nothing to do for a 0.32 document

A 0.32 document still parses and keeps its behaviour: no generated code depends on `verifiedBy`, so
its absence changes nothing at build time. `aid validate` reports `spec/not-supported` on a 0.32
document that *declares* the key, naming 0.33 as the version it needs, because reading it as absent
would report an undeclared responsibility when the author had declared one.

### What a 0.33 `enterprise` document must now declare

| Refusal | What is missing | The fix |
| --- | --- | --- |
| `ir/identity-verified-by` | Under `profile: enterprise`, an `identity` block with no `verifiedBy`. | Name what verifies tokens, such as `verifiedBy: app/business/principal.py` or `verifiedBy: api-gateway`. |

A `standard` document is unaffected: it may declare `identity` with or without the key, because
nothing gated on it. The refusal is version-gated to 0.33 and later for the reason every nested
field is -- a 0.32 document has no key to satisfy it with, and a gate no edit to the document could
satisfy is the approximation this layer refuses.

### Why the anonymous principal is the generated default

`Principal.authenticated` defaults to `False`, and the generated routes read the caller through one
dependency that returns `Principal.unauthenticated()`. Before this release both routes called the
runtime with no principal at all and the runtime filled in `Principal()` -- which defaulted to
authenticated -- so the seamed-out dependency was not merely unused, it was bypassed. A `write` tool
guarded by `isAuthenticated()` was reachable by anyone who could reach the route, which is the exact
failure such a policy exists to prevent. Every caller that wants to claim a caller now says so.

## 0.27 to 0.28: promoting a candidate, and the feedback that starts a loop

What a document is allowed to do with a candidate, and which feedback it takes back from its users.
Both keys are additive, so a 0.27 document is still a 0.27 document.

> **What 0.28 declares but does not do.** `evals[].gate.promotion` states the policy a candidate
> must satisfy. Nothing promotes itself and nothing auto-deploys: `aid eval --compare` prints a
> verdict, and the merge that carries the bumped prompt version is the promotion. AID generates no
> feedback endpoint and stores no signal.
>
> **Corrected in 0.1.162.** This note used to add that no runtime measures cost, so a declared
> `allowedCostIncrease` was reported as unjudged on every comparison. That is no longer true: a
> recorded baseline now carries the spend and latency of the run that produced it, and
> `aid eval --compare` judges the allowance against those two numbers. A baseline that records no
> spend -- one recorded before this release, or by a runner that meters nothing -- is now a
> **refusal** rather than a warning, because a gate that cannot tell has not passed anything. If
> your CI compares baselines committed before 0.1.162, re-record them with `aid eval --baseline`.
> The [0.1.162 release note](#cost-allowance-release) lists every script-visible change.

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
| `ir/promotion-cost` | `allowedCostIncrease` on an eval that records no `cost` metric, so there is no baseline cost to increase; or on a build whose every target lacks the `metrics` capability, so nothing generated measures the spend. | Add a `cost` metric with a `max` ceiling, or drop the ceiling; or target a runtime that exports metrics. |
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

## 0.1.162: the cost allowance is judged {#cost-allowance-release}

This is a **release**, not a spec version. `specVersion` stays `0.31`: no key, enum value or
constraint changed. What changed is that `evals[].gate.promotion.allowedCostIncrease`, declarable
since `0.28`, is now applied instead of deferred.

### What changed

| Before | Now |
| --- | --- |
| A recorded baseline held a mean pass rate per metric and nothing else, so no dollar figure existed to compare. | `aid eval --baseline` also records the run's model spend and wall-clock time, as a mean and a sample standard deviation over the runs it took. |
| `aid eval --compare` could not compute the increase, so it printed a warning and left the allowance unjudged. | It computes the relative increase in spend between the accepted and candidate baselines, prints both figures and the move between them, and refuses a candidate above the allowance with `cli/eval-compare-cost-regressed`. |
| An unjudged allowance was a **warning**: the comparison passed. | It is a **failure**. A gate that could not measure has not passed anything, so `cli/eval-compare-cost-unjudged` fails the command and says to re-record. |
| `ir/promotion-cost` refused any document that declared `allowedCostIncrease`, on the grounds that nothing could judge it. | It refuses only what is still unjudgeable: an allowance with no `cost` ceiling on the eval, or an allowance where every target in the build lacks the `metrics` capability, so no generated app would ever write the number. A build with one measuring target passes. |

The distinction the runtime keeps is between **not metered** and **spent nothing**. The spend block
is written only when a run actually metered its calls; absent means "no measurement", and zero
means "a free run". Neither is inferred from the other, because reading a missing measurement as a
zero would let a candidate that was never priced through the gate.

### What you have to do

Re-record any baseline you intend to compare. A baseline committed before 0.1.162 carries no spend,
so `aid eval --compare` refuses it as unjudged rather than guessing:

```bash
aid eval --baseline evals/support-triage.baseline.json
```

Nothing else changes. A baseline you never compare can stay as it is -- the extra fields are
optional in the file format. When the spec declares no `allowedCostIncrease`, the comparison prints
exactly what it printed before, because the allowance is the only thing that adds a spend row.

### What this release still does not do

The allowance governs **spend**, not latency. A baseline records latency, and the comparison
reports it, but no `gate.promotion` key bounds it, so a slower candidate is not refused. The
per-case bound that does apply to spend is the separate `cost` metric's `max` ceiling, which is
compared like any other metric and is unrelated to the promotion allowance.

### Why there is no `specVersion` bump

Same reason as `0.1.150`, `0.1.160` and `0.1.161`: a bump is owed to a **spec language change**. The
edits here are descriptions in the JSON schema, behaviour in the runtime and the CLI, and one gate
rule narrowed. No document gains or loses a key.

## 0.1.165: an agent run redacts where its values arrive named {#agent-redaction-release}

This is a **release**, not a spec version. `specVersion` stays `0.33`: no key, enum value or
constraint changed. What changed is that `observability.redact` reaches a document that runs an
agent, which the previous release refused outright.

### What changed

| Before | Now |
| --- | --- |
| Any document that ran an agent and withheld a field failed the build with `unsupported-redact`, because a run has no rendered prompt to bind a value to. | An agent run binds the declared names against the arguments of the tool calls its model composes, recursing into nested objects and lists, and withholds those values from the copy a trace records while the model still receives them. The refusal survives only for a document that runs an agent and **declares no tool at all**, which has no argument to bind. |
| `aid trace export` refused enterprise capture only when `observability.redact` was empty, without looking at what the document actually ran. | It refuses an agent document under `profile: enterprise` on the same test, and does not accept `observability.feedback.redact` in its place: a set declared for stored signals says nothing about what a trace kept (`cli/trace-export-agent-unredacted`). |

### What the set does not reach

A value that enters a run only through prose. `AgentRuntime.run` is handed a plain string, so a
prompt-side identifier has no field name for the runner to match, and it is recorded as written.
Where that applies, redact before the value reaches the prompt or leave payload capture off.

A value recorded by another route -- your own log line, or text a tool body writes -- remains
outside the guarantee, exactly as it is for a pipeline.

### What you have to do

Nothing, unless you removed `observability.redact` to get past the old refusal. If you did, put it
back: an agent document that declares its tools now builds, and a document that declares none is
refused with the field names and both fixes in the message.

### Why there is no `specVersion` bump

A bump is owed to a **spec language change**. The grammar has accepted `observability.redact` since
`0.27`; this release makes an emitted runtime and a gate honour it for agents, and narrows one gate
rule. No document gains or loses a key.

## 0.1.166: capturing a run so CI can replay it {#trajectory-capture-release}

Replay has shipped since 0.27 and capture had not: `AID_EVAL_TRANSCRIPT` pointed the agent
evaluator at a recording, and nothing in AID wrote one. The only trajectory anyone could score
offline was the scripted one, so a case could show that an approval pause works against turns its
author wrote, and not that it works against turns a model drove.

`aid eval --record <path>` closes that. It is a real run -- the agent calls the provider the spec
pins -- that also writes every request and response to `<path>` in the shape `AID_EVAL_TRANSCRIPT`
reads, so the capture can be committed and the next run is offline:

```bash
aid eval --record app/evals/refund_trajectory.json --suite refund_trajectory app/app.spec.yaml
```

`AID_EVAL_RECORD` is the variable the flag sets, and the only other way to ask for a capture. There
is no mode in which a plain `aid eval`, a CI run or a generated service records: recording is
opt-in per run, and a green gate is not a reason to start writing files.

### What a green gate means now

Every agent eval prints one line after its summary, and it is the run that decides the meaning:

| `provenance:` | The turns came from |
| --- | --- |
| `scripted` | The `fake` provider, because the agent's model is declared on it |
| `live, capturing to <path>` | A real provider, and the turns were written to `<path>` |
| `recorded` | A transcript, replayed in order |
| `live` | A real provider, and nothing was written |

The line is printed, not gated on. A verdict that changed with the mode of a run would make one
suite mean two things, on a laptop and in CI.

A captured run is a real improvement in what a case can claim and it is still not a quality number.
It measures policy and plumbing against turns a model really produced; it does not measure how good
those turns were, and it describes the model and prompt that were pinned when the capture was taken.
Re-record when either changes. A stale recording is not a failing test, which is the problem with
it.

### The captures that are refused

Refusing a file that would mislead is the point, so both layers refuse rather than proceed. The
command raises `cli/eval-record-unsupported` before anything runs:

- `--record` beside `--compare`, because a comparison judges two baselines and a capture describes
  one run.
- `--record` unless exactly one suite runs, because one file cannot be the recording of several.
- `--record` on an eval whose target is not an `agent:`, because a pipeline has no trajectory --
  the same fact `ir/eval-trajectory` states for a trajectory metric.

The generated evaluator refuses with an `EvalError`, for the cases only a run can see:

- a capture while `AID_EVAL_TRANSCRIPT` is also set, because one run either replays or captures.
  Accepting both would write a file that describes one document while holding another's turns.
- a capture on an agent whose model is the `fake` provider, because the turns were never generated.
- a capture onto a path that already exists, because an appended transcript is a recording of
  nothing in particular.
- a capture of a run that made no model call, because an empty transcript replays forever and
  asserts nothing.

### What you have to do

Nothing. No generated file changes shape, and a document that was valid is still valid.

### Why there is no `specVersion` bump

The grammar has not moved. `evals[].target` has accepted `agent:<id>` since `0.27`, and a recording
was never a spec construct -- it is a file a run reads or writes. `--record` is a flag on an
existing command, so no document gains or loses a key.

## 0.1.167: the improvement loop, end to end {#improvement-loop-release}

Trace export, dataset wiring, `gate.promotion`, `eval --compare` and approval records all shipped
before this release. Exercising them in order is what a release note is for, and doing it turned up
two refusals that misreported why they refused.

No new capability is claimed. [Improving an agent over time](guide/improvement-loop.md) is the loop
written down as one ordered procedure -- traced run, export, curate, version, baseline, promote,
approve -- with the diagnostic that stops each step. Phase E is a correction plus a playbook, not a
feature.

### The approval refusal names the file it looked at

A `gate.promotion` approval record is resolved against the directory `aid` runs from, not against
the directory of the spec it is given. Running `aid eval --compare` from a repository root with a
customer spec passed by path therefore looked for the approval somewhere it was never going to be,
and said so in a way that read like a wrong approval rather than a wrong directory:

```text
The approval record for triage is missing or empty.
```

The message now says which file was absent, and distinguishes an absent file from an empty one,
because the fix is different (`cli/eval-compare-approval-missing`, exit 1):

```text
No approval record at C:\work\contoso\app\approvals\triage.md.
  An empty file is a refusal as well; this one does not exist.
  The path resolves against the directory you run `aid` from, not the spec's.
```

Nothing about what is accepted has changed. A missing approval, an empty one and one whose
`decision` is not `approved` are all refused, as they were.

### The `--compare` summary no longer says cost is unjudged

The flag summary still described the shape of a comparison from `0.28`, when no runtime recorded
cost, so it claimed cost "is reported as unjudged because no runtime records cost". A metered
baseline has carried a `cost` block since trajectory capture, and `judgeCostAllowance` has refused
an allowance neither file can judge since then, so the sentence outlived its own behaviour by two
releases and was quoted verbatim in the generated CLI reference.

The summary now says both allowances are judged and that one neither file can judge is refused
rather than passed. `docs/reference/cli.md` is generated from it, so the reference follows.

### What you have to do

Nothing. No generated file changes shape, no diagnostic is added or removed, and a document that
was valid is still valid. A pipeline whose baseline has no `cost` block still refuses to judge a
cost allowance -- that is the documented behaviour, not a regression.

### Why there is no `specVersion` bump

The grammar has not moved. Every construct the loop uses -- `observability.redact`,
`evals[].dataset`, `eval.gate.promotion`, `approvals.path`, `profile: enterprise` -- was already
accepted, and this release changes two sentences and one refusal message.