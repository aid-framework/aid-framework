---
description: "A 0.26 enterprise spec that names its controls but declares them unusably, refused five times by named diagnostics, then fixed."
---

# Walkthrough: delivery controls

Spec 0.26 gives the `enterprise` profile three more things to declare — the identity it trusts, a
private placement, and the reviewers a production change needs — and gives every profile a durable
run store and a way to pause a step for approval.

Declaring them is not the same as declaring them *usably*. A `network.private: false` is a control
that was turned off. An `approvals` policy that asks for three sign-offs from two named reviewers can
never be satisfied. An approval pause in front of a read teaches an operator to approve without
reading. Each of those is refused, and this walkthrough collects the refusals.

Every console block below is real output from this repository's CLI.

## The spec

Start from an enterprise adjudicator whose agent can issue refunds:

```bash
cp ../../packages/spec/test/fixtures/valid/v26-controls.spec.yaml claims-desk.spec.yaml
```

It declares a `write` tool, an `identity`, a `network`, an `approvals` policy and a run `state`. It
does not pass yet, and the two reasons are not about 0.26 at all — AID has always refused a
side-effecting tool that anyone can call, and refused one no guardrail covers:

```console
$ aid validate claims-desk.spec.yaml
claims-desk.spec.yaml: 2 error(s), 1 warning(s)
claims-desk.spec.yaml: warning: the eval-coverage gate flagged this pipeline: "refund" is served over HTTP but no eval with gate.ci: true targets it [ir/eval-uncovered]
    at pipelines.refund
    hint: add an eval targeting "pipeline:refund" and set gate.ci: true
claims-desk.spec.yaml: error: the guardrails gate rejected "issue_refund": the tool has sideEffects "write" but no declared guardrail covers it at the "tool-call" stage [ir/guardrail-coverage]
    at tools.issue_refund.sideEffects
    hint: add a guardrail with stages: [tool-call] whose tools list is empty or names "issue_refund"
claims-desk.spec.yaml: error: the security gate rejected this tool: "issue_refund" has sideEffects "write" but declares no auth, so it is callable by anyone [ir/security-missing-auth]
    at tools.issue_refund.auth
    hint: declare a policy such as isAuthenticated() and hasScope('x')
```

Add the scope and a `tool-call` guardrail, and it passes:

```yaml
tools:
  issue_refund:
    # ...
    auth: hasScope('claims:write')

guardrails:
  toolcall:
    stages: [tool-call]
    policies: [pii-detect]
    action: block
    onFail:
      message: The claim payload was rejected by the tool-call guardrail.
      log: true
```

```console
$ aid validate claims-desk.spec.yaml
claims-desk.spec.yaml: ok (0 errors, 1 warnings)
claims-desk.spec.yaml: warning: the eval-coverage gate flagged this pipeline: "refund" is served over HTTP but no eval with gate.ci: true targets it [ir/eval-uncovered]
    at pipelines.refund
    hint: add an eval targeting "pipeline:refund" and set gate.ci: true
```

That warning is the same one this spec carried before 0.26 and is unrelated to the controls; it is
shown so the blocks below are not quietly shorter than a real run.

## What 0.26 requires of `enterprise`

| Requirement | Diagnostic | Scope |
| --- | --- | --- |
| A declared `identity` | [`ir/profile-identity`](#refusal-1-the-three-missing-controls) | Every deployment |
| `network.private: true` | [`ir/profile-network`](#refusal-2-declared-but-wrong) | Every deployment |
| An `approvals` policy that can be satisfied | [`ir/profile-approvals`](#refusal-2-declared-but-wrong) | Every deployment |
| A `state` store for an agent that can call a writing tool | [`ir/agents-state-store`](#refusal-3-an-agent-that-writes-with-no-record-of-a-spent-pause) | Every such agent |
| No `requiresApproval` on a tool with no side effects | [`ir/approval-step-tool`](#refusal-4-asking-a-human-to-approve-a-read) | Every profile |

The first three extend the `profile` gate that 0.25 shipped. The last two are new gates — `state` and
`approvals` — and the approval one runs for **every** profile, because pausing a run to ask about a
read is a mistake in a standard deployment too.

All five are scoped to `specVersion: "0.26"`. A 0.25 document has no key to satisfy them with, and
holding it to a rule it cannot express would make it unsatisfiable.

## Refusal 1: the three missing controls

Delete `identity`, `network` and `approvals` from the deployment:

```console
$ aid validate enterprise.spec.yaml
enterprise.spec.yaml: 3 error(s), 1 warning(s)
enterprise.spec.yaml: error: the profile gate rejected "prod": the enterprise profile requires an approval policy for production changes [ir/profile-approvals]
    at deployments.prod
    hint: add `approvals: { require: [<team>], minApprovers: 1 }` so a change to this environment waits for a human
enterprise.spec.yaml: error: the profile gate rejected "prod": the enterprise profile requires a declared identity integration, so the deployment knows whose token it is checking [ir/profile-identity]
    at deployments.prod
    hint: add `identity: { kind: oidc, issuer: https://<your-idp> }` so callers arrive with a verifiable principal
enterprise.spec.yaml: error: the profile gate rejected "prod": the enterprise profile requires private networking, and this deployment does not place the workload in one [ir/profile-network]
    at deployments.prod.network
    hint: add `network: { private: true }`, or set `profile: standard` if the workload is meant to be internet-reachable directly
```

Three errors, three keys, all on one deployment. The region and audit requirements from 0.25 are
already satisfied here because this spec pins both.

## Refusal 2: declared, but wrong

The interesting failures are the ones where the key is present and the value is not what the tier
asks for. Turn private networking off explicitly:

```yaml
network:
  private: false
```

```console
$ aid validate enterprise.spec.yaml
enterprise.spec.yaml: 1 error(s), 1 warning(s)
enterprise.spec.yaml: error: the profile gate rejected "prod": the enterprise profile requires private networking, and this deployment declares `network.private: false` [ir/profile-network]
    at deployments.prod.network.private
    hint: set `network.private: true`, or set `profile: standard` if the workload is meant to be internet-reachable directly
```

The message differs from the one above on purpose, and so does the path. A missing key is a control
that was never declared; `false` is a control that was declared and switched off. The first fix is to
add a block, the second is to change a value, and the diagnostic says which one you have. `private` is
required by the schema rather than defaulted for the same reason: whether traffic leaves a customer's
network is not a decision a default should make silently.

Now ask for more sign-offs than there are reviewers:

```yaml
approvals:
  require: [security, platform]
  minApprovers: 3
```

```console
$ aid validate enterprise.spec.yaml
enterprise.spec.yaml: 1 error(s), 1 warning(s)
enterprise.spec.yaml: error: the profile gate rejected "prod": `approvals.minApprovers` is 3 but `approvals.require` names 2 ("security", "platform"), so no change could ever be approved [ir/profile-approvals]
    at deployments.prod.approvals.minApprovers
    hint: set minApprovers to at most 2, or name 3 reviewers in `require`
```

A policy that names two reviewers and requires three of them is not stricter, it is dead: every change
would wait forever. Emitting it as a workflow binding would look like governance and behave like an
outage, so it is refused at generate time with both numbers quoted back.

## Refusal 3: an agent that writes with no record of a spent pause

A live refund run can be paused mid-write. The checkpoint for that pause goes back to the caller, so
the run itself survives the request -- but the record that refuses a *second* resume of the same
checkpoint lives only in the process that issued it, so a replayed answer against another replica is
accepted and approves the held write a second time. Remove both `state` blocks:

```console
$ aid validate stateless.spec.yaml
stateless.spec.yaml: 2 error(s), 1 warning(s)
stateless.spec.yaml: error: the state gate rejected "claims_adjudicator": it can call "issue_refund" (write), which has side effects, and it declares no durable state, so the first resume of a paused write is remembered only by the process that issued it -- a replayed answer reaches a second replica, or a restarted one, and is accepted [ir/agents-state-store]
    hint: add `state: { kind: postgres, urlEnv: DATABASE_URL }` to the agent or to the document, so the checkpoint nonce is claimed where the store already points and the app has a declared place to persist a paused run (AID generates the claim, not the persistence)
stateless.spec.yaml: error: the approval gate rejected "refund": step 0 waits for approval and the document declares no durable state store, so the pending decision has no declared place to live and the checkpoint nonce is remembered only in the process that issued it [ir/approval-step-tool]
    hint: add a top-level `state: { kind: postgres, urlEnv: DATABASE_URL }` so the checkpoint nonce is claimed durably and the app has a declared place to persist the paused run (AID generates the claim, not the persistence)
```

Two gates noticed the same missing store, because two things depend on it. The first names the agent
and the tool that made it necessary; the second names the pipeline and the step that would pause. The
second one's path is `state`, not the pipeline, because that is the key you have to add.

`state` is declared once per document and may be overridden per agent. An override **replaces** the
document store rather than merging with it, so an agent's `kind` and its `urlEnv` can never come from
different declarations. `urlEnv` is a variable *name*, following the `models.*.apiKeyEnv` precedent:
no connection string enters the spec, the IR, or a generated file.

The state gate is enterprise-only. A standard deployment has no database to point at, and refusing
one for lacking a store it was never going to have would be a gate that only produces noise.

## Refusal 4: asking a human to approve a read

An approval pause is a control only if the thing being approved can change something. Add a read tool
and pause on it:

```yaml
steps:
  - tool:
      tool: lookup_claim
      input:
        claim: "{{event.claim}}"
      as: record
      requiresApproval: true
```

```console
$ aid validate readapproval.spec.yaml
readapproval.spec.yaml: 1 error(s), 1 warning(s)
readapproval.spec.yaml: error: the approval gate rejected "refund": step 0 sets requiresApproval on "lookup_claim", which has no side effects, so the pause asks a human to approve a read [ir/approval-step-tool]
    at pipelines.refund.steps[0].tool.requiresApproval
    hint: set requiresApproval only on tools whose sideEffects is write or destructive; a read needs no sign-off
```

The gate reads `sideEffects` and nothing else — not the tool's name, not its description. A reviewer
who is trained to click approve on a read is less likely to read the one that matters, so the pause is
refused where it is inert and the fix is to move it to the step that writes.

The path points at the exact step, `steps[0].tool.requiresApproval`, which matters once a pipeline has
several steps: the address is what tells you which one to edit.

## The passing spec

Move the pause to the refund and the document passes:

```yaml
steps:
  - tool:
      tool: lookup_claim
      input:
        claim: "{{event.claim}}"
      as: record
  - tool:
      tool: issue_refund
      input:
        claim: "{{event.claim}}"
      as: receipt
      requiresApproval: true
```

```console
$ aid validate fixed.spec.yaml
fixed.spec.yaml: ok (0 errors, 1 warnings)
```

## What the passing spec projects into the IR

The controls are projected, so a reader of the IR can see them without re-reading the spec. This is
the real IR for the passing document, with the pipelines and tools omitted:

```json
{
  "approvals": {
    "require": ["security", "platform"],
    "minApprovers": 2
  },
  "identity": {
    "kind": "oidc",
    "issuer": "https://login.example.com",
    "audience": "aid-claims"
  },
  "network": {
    "private": true,
    "egress": "declared-only"
  },
  "state": {
    "kind": "postgres",
    "urlEnv": "DATABASE_URL",
    "ttlHours": 168
  },
  "agentState": {
    "kind": "postgres",
    "urlEnv": "DATABASE_URL",
    "ttlHours": 24
  },
  "stepApprovals": [null, true]
}
```

`stepApprovals` is the refund pipeline's steps in order: the read is not paused, the write is.
`agentState` overrides the document `state` at a shorter `ttlHours`, because an adjudication run is
finished or abandoned within a day while the audit of it is kept a week.

**This is where the honesty matters.** The five diagnostics above refuse a bad declaration today,
and the controls reach the IR. The generators that would *act* on them — the durable store, the
identity claim check, the private-network module, the approval pause inside
`aid_runtime/pipeline.py` — are not in this release. `aid gen` on this document stops for reasons
that predate 0.26 (the py-fastapi target refuses a tool reached from both an agent and a pipeline
step), and even where it succeeds a declared control is validated and projected, then not consumed.

That gap is written down rather than left to be discovered: it is on the `/features` row for
delivery controls, in
[`docs/migration.md`](../migration.md#_0-25-to-0-26-the-delivery-controls), and in
the RFC's §10.2 (`docs/rfcs/0001-agents-at-scale.md`, which is not published with this site). AID
does not claim a capability it has not written, and it does not refuse a spec for omitting
something it cannot generate.

Read next: [the enterprise profile](enterprise-profile.md) for the 0.25 controls these extend, or
[the spec reference](../reference/spec.md#top-level-keys) for `identity`, `network`, `approvals` and
`state`.
