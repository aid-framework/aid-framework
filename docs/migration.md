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

## Version history

| Spec | Backward compatible | What it added |
| --- | --- | --- |
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
