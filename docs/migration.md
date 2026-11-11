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

> **What 0.27 declares but does not yet send.** `export: otlp` states that the spans belong in a
> collector. AID installs no OpenTelemetry exporter, adds no dependency to a generated project and
> writes no collector configuration, so the spans are still dropped. `/features` says so on the row
> itself. The declaration is enforced rather than decorative: the gate refuses a document whose
> export contradicts its tracing.

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

| Spec | Backward compatible | What it added |
| --- | --- | --- |
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
