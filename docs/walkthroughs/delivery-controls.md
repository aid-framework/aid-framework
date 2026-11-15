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

Every console block below is real output from this repository's CLI, re-captured against the current
one. Two later changes to the language are visible in that output and are not the subject of this
walkthrough:

- `network.private` is retired from 0.37. The placement the tier asks for is `network.ingress:
  internal` with an `allowFrom` list, and the hints below say so even for this 0.26 document.
- A document before 0.32 that has a pausable agent also carries `ir/resume-unsigned`, because a
  0.26 document cannot name a checkpoint signing key and the resume route therefore accepts any
  well-formed checkpoint. It is shown in full in the first block and elided in the others; the
  error and warning counts are the real ones, so they say `2 warning(s)` where the elision stands.

The fixture stays at `specVersion: "0.26"` because it exists to demonstrate the 0.26 controls
themselves, which a 0.26-only document is the shortest way to read.

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
claims-desk.spec.yaml: 2 error(s), 2 warning(s)
claims-desk.spec.yaml: warning: the eval-coverage gate flagged this pipeline: "refund" is served over HTTP but no eval with gate.ci: true targets it [ir/eval-uncovered]
    at pipelines.refund
    hint: add an eval targeting "pipeline:refund" and set gate.ci: true
claims-desk.spec.yaml: error: the guardrails gate rejected "issue_refund": the tool has sideEffects "write" but no declared guardrail covers it at the "tool-call" stage [ir/guardrail-coverage]
    at tools.issue_refund.sideEffects
    hint: add a guardrail with stages: [tool-call] whose tools list is empty or names "issue_refund"
claims-desk.spec.yaml: warning: the resume gate flagged "claims_adjudicator": this agent can pause, the document names no checkpoint signing key, and specVersion "0.26" is before 0.32 -- so POST /agents/resume accepts any well-formed checkpoint and a caller can approve the held call [ir/resume-unsigned]
    at agents.claims_adjudicator.state
    hint: set specVersion: "0.32" and declare `state: { kind: postgres, urlEnv: DATABASE_URL, signingKeyEnv: AID_CHECKPOINT_KEY }`; before 0.32 a document cannot name the key, so this cannot be enforced
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
claims-desk.spec.yaml: ok (0 errors, 2 warnings)
claims-desk.spec.yaml: warning: the eval-coverage gate flagged this pipeline: "refund" is served over HTTP but no eval with gate.ci: true targets it [ir/eval-uncovered]
    at pipelines.refund
    hint: add an eval targeting "pipeline:refund" and set gate.ci: true
claims-desk.spec.yaml: warning: the resume gate flagged "claims_adjudicator": this agent can pause, the document names no checkpoint signing key, and specVersion "0.26" is before 0.32 -- so POST /agents/resume accepts any well-formed checkpoint and a caller can approve the held call [ir/resume-unsigned]
    at agents.claims_adjudicator.state
    hint: set specVersion: "0.32" and declare `state: { kind: postgres, urlEnv: DATABASE_URL, signingKeyEnv: AID_CHECKPOINT_KEY }`; before 0.32 a document cannot name the key, so this cannot be enforced
```

The first warning is the same one this spec carried before 0.26 and is unrelated to the controls; the
second is the pre-0.32 checkpoint warning described at the top. Both are shown because the blocks
below are not quietly shorter than a real run, and because a reader who copies the fixture and sees
two warnings should find them explained rather than suspect a broken build.

## What 0.26 requires of `enterprise`

| Requirement | Diagnostic | Scope |
| --- | --- | --- |
| A declared `identity` | [`ir/profile-identity`](#refusal-1-the-three-missing-controls) | Every deployment |
| `network.ingress: internal` (or the pre-0.37 `network.private: true`) | [`ir/profile-network`](#refusal-2-declared-but-wrong) | Every deployment |
| An `approvals` policy that can be satisfied | [`ir/profile-approvals`](#refusal-2-declared-but-wrong) | Every deployment |
| A `state` store for an agent that can call a writing tool | [`ir/agents-state-store`](#refusal-3-an-agent-that-writes-with-no-record-of-a-spent-pause) | Every such agent |
| No `requiresApproval` on a tool with no side effects | [`ir/approval-step-tool`](#refusal-4-asking-a-human-to-approve-a-read) | Every profile |

The first three extend the `profile` gate that 0.25 shipped. The last two are new gates — `state` and
`approvals` — and the approval one runs for **every** profile, because pausing a run to ask about a
read is a mistake in a standard deployment too.

The three `profile` requirements and the state gate are scoped to `specVersion: "0.26"` and above: a
0.25 document has no key to satisfy them with, and holding it to a rule it cannot express would make
it unsatisfiable. The approval-step gate is not version-checked; it keys off `requiresApproval`, a
construct no document before 0.26 can write, so there is nothing to scope.

## Refusal 1: the three missing controls

Delete `identity`, `network` and `approvals` from the deployment:

```console
$ aid validate claims-desk.spec.yaml
claims-desk.spec.yaml: 3 error(s), 2 warning(s)
claims-desk.spec.yaml: warning: the eval-coverage gate flagged this pipeline: "refund" is served over HTTP but no eval with gate.ci: true targets it [ir/eval-uncovered]
    at pipelines.refund
    hint: add an eval targeting "pipeline:refund" and set gate.ci: true
claims-desk.spec.yaml: error: the profile gate rejected "prod": the enterprise profile requires an approval policy for production changes [ir/profile-approvals]
    at deployments.prod
    hint: add `approvals: { require: [<team>], minApprovers: 1 }` so a change to this environment waits for a human
claims-desk.spec.yaml: error: the profile gate rejected "prod": the enterprise profile requires a declared identity integration, so the deployment knows whose token it is checking [ir/profile-identity]
    at deployments.prod
    hint: add `identity: { kind: oidc, issuer: https://<your-idp> }` so callers arrive with a verifiable principal
claims-desk.spec.yaml: error: the profile gate rejected "prod": the enterprise profile requires private networking, and this deployment does not place the workload in one [ir/profile-network]
    at deployments.prod.network
    hint: add `network: { ingress: internal, allowFrom: [<your CIDR>] }`, or set `profile: standard` if the workload is meant to be internet-reachable directly
claims-desk.spec.yaml: warning: the resume gate flagged "claims_adjudicator": this agent can pause, the document names no checkpoint signing key, and specVersion "0.26" is before 0.32 -- so POST /agents/resume accepts any well-formed checkpoint and a caller can approve the held call [ir/resume-unsigned]
    at agents.claims_adjudicator.state
    hint: set specVersion: "0.32" and declare `state: { kind: postgres, urlEnv: DATABASE_URL, signingKeyEnv: AID_CHECKPOINT_KEY }`; before 0.32 a document cannot name the key, so this cannot be enforced
```

Three errors, three keys, all on one deployment. The region and audit requirements from 0.25 are
already satisfied here because this spec pins both.

The network hint names `ingress: internal` and `allowFrom`, not `private: true`, because a boolean
cannot say *which* networks may reach the service. `private: true` is still read on a document this
old -- refusal 2 below leans on that -- but it is answered with the placement spelling.

## Refusal 2: declared, but wrong

The interesting failures are the ones where the key is present and the value is not what the tier
asks for. Turn private networking off explicitly:

```yaml
network:
  private: false
```

```console
$ aid validate claims-desk.spec.yaml
claims-desk.spec.yaml: 1 error(s), 2 warning(s)
claims-desk.spec.yaml: warning: the eval-coverage gate flagged this pipeline: "refund" is served over HTTP but no eval with gate.ci: true targets it [ir/eval-uncovered]
    at pipelines.refund
    hint: add an eval targeting "pipeline:refund" and set gate.ci: true
claims-desk.spec.yaml: error: the profile gate rejected "prod": the enterprise profile requires private networking, and this deployment declares `network.private: false` [ir/profile-network]
    at deployments.prod.network.private
    hint: replace it with `network.ingress: internal` and the networks allowed to reach the service, or set `profile: standard` if the workload is meant to be internet-reachable directly
claims-desk.spec.yaml: # ... ir/resume-unsigned, elided (see the first block)
```

The message differs from the one above on purpose, and so does the path. A missing key is a control
that was never declared; `false` is a control that was declared and switched off. The first fix is to
add a block, the second is to change a value, and the diagnostic says which one you have. `private` is
required by the schema rather than defaulted for the same reason: whether traffic leaves a customer's
network is not a decision a default should make silently.

`private: false` is one of three refusals the same branch of the gate can produce: no `network` block
at all, `private: false`, or an `ingress: public` that the document does not contradict. The third
exists because 0.37 gave `network` a placement to spell, and `ingress: public` is a stated intent
rather than a missing one — the same distinction as `false` against absent.

What this 0.26 document's projection records, further down, is `private: true` beside
`ingress: "public"`. That is the whole reason the flag was replaced: it was read by the profile gate
and by nothing else, so the emitted ingress rule opened to `0.0.0.0/0` regardless of what it said.
Staying at 0.26 keeps that inert meaning, which is why the walkthrough can demonstrate it; from 0.37
the parser refuses `network.private` outright with `spec/not-supported`, and the placement has to be
said as `ingress: internal` plus the `allowFrom` networks that may reach it.

Now ask for more sign-offs than there are reviewers:

```yaml
approvals:
  require: [security, platform]
  minApprovers: 3
```

```console
$ aid validate claims-desk.spec.yaml
claims-desk.spec.yaml: 1 error(s), 2 warning(s)
claims-desk.spec.yaml: warning: the eval-coverage gate flagged this pipeline: "refund" is served over HTTP but no eval with gate.ci: true targets it [ir/eval-uncovered]
    at pipelines.refund
    hint: add an eval targeting "pipeline:refund" and set gate.ci: true
claims-desk.spec.yaml: error: the profile gate rejected "prod": `approvals.minApprovers` is 3 but `approvals.require` names 2 ("security", "platform"), so no change could ever be approved [ir/profile-approvals]
    at deployments.prod.approvals.minApprovers
    hint: set minApprovers to at most 2, or name 3 reviewers in `require`
claims-desk.spec.yaml: # ... ir/resume-unsigned, elided (see the first block)
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
stateless.spec.yaml: 2 error(s), 2 warning(s)
stateless.spec.yaml: error: the state gate rejected "claims_adjudicator": it can call "issue_refund" (write), which has side effects, and it declares no durable state, so the first resume of a paused write is remembered only by the process that issued it -- a replayed answer reaches a second replica, or a restarted one, and is accepted [ir/agents-state-store]
    at agents.claims_adjudicator.state
    hint: add `state: { kind: postgres, urlEnv: DATABASE_URL }` to the agent or to the document, so the checkpoint nonce is claimed where the store already points and the app has a declared place to persist a paused run (AID generates the claim, not the persistence)
stateless.spec.yaml: error: the approval gate rejected "refund": step 0 waits for approval and the document declares no durable state store, so the pending decision has no declared place to live and the checkpoint nonce is remembered only in the process that issued it [ir/approval-step-tool]
    at state
    hint: add a top-level `state: { kind: postgres, urlEnv: DATABASE_URL }` so the checkpoint nonce is claimed durably and the app has a declared place to persist the paused run (AID generates the claim, not the persistence)
stateless.spec.yaml: warning: the eval-coverage gate flagged this pipeline: "refund" is served over HTTP but no eval with gate.ci: true targets it [ir/eval-uncovered]
    at pipelines.refund
    hint: add an eval targeting "pipeline:refund" and set gate.ci: true
stateless.spec.yaml: # ... ir/resume-unsigned, elided (see the first block)
```

Two gates noticed the same missing store, because two things depend on it. The first names the agent
and the tool that made it necessary; the second names the pipeline and the step that would pause. The
second one's path is `state`, not the pipeline, because that is the key you have to add — the first
one's path is the agent's own `state`, because that is where an override would go.

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
readapproval.spec.yaml: 1 error(s), 2 warning(s)
readapproval.spec.yaml: error: the approval gate rejected "refund": step 0 sets requiresApproval on "lookup_claim", which has no side effects, so the pause asks a human to approve a read [ir/approval-step-tool]
    at pipelines.refund.steps[0].tool.requiresApproval
    hint: set requiresApproval only on tools whose sideEffects is write or destructive; a read needs no sign-off
readapproval.spec.yaml: # ... ir/eval-uncovered and ir/resume-unsigned, elided
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
fixed.spec.yaml: ok (0 errors, 2 warnings)
```

## What the passing spec projects into the IR

The controls are projected, so a reader of the IR can see them without re-reading the spec. This is
the real IR for the passing document, cut down to the deployments, the agent and the refund
pipeline's steps:

```json
{
  "profile": "enterprise",
  "specVersion": "0.26",
  "state": { "kind": "postgres", "ttlHours": 168, "urlEnv": "DATABASE_URL" },
  "deployments": [
    {
      "id": "prod",
      "target": "container",
      "cloud": "aws",
      "region": "eu-central-1",
      "audit": { "retentionDays": 400, "sink": "cloudwatch" },
      "identity": { "kind": "oidc", "issuer": "https://login.example.com", "audience": "aid-claims" },
      "network": { "egress": "declared-only", "ingress": "public", "private": true },
      "approvals": { "minApprovers": 2, "require": ["security", "platform"] },
      "secrets": ["OPENAI_API_KEY", "DATABASE_URL"]
    }
  ],
  "agents": [
    {
      "id": "claims_adjudicator",
      "state": { "kind": "postgres", "ttlHours": 24, "urlEnv": "DATABASE_URL" }
    }
  ],
  "pipelines": [
    {
      "id": "refund",
      "steps": [
        {
          "as": "record",
          "input": { "claim": { "kind": "reference", "path": ["event", "claim"] } },
          "kind": "tool",
          "tool": "lookup_claim"
        },
        {
          "as": "receipt",
          "input": { "claim": { "kind": "reference", "path": ["event", "claim"] } },
          "kind": "tool",
          "requiresApproval": true,
          "tool": "issue_refund"
        }
      ]
    }
  ]
}
```

Four things in that projection are worth more than the values themselves.

**The controls are per deployment.** `audit`, `identity`, `network` and `approvals` sit inside each
`deployments` entry, one set per environment, because a customer can run a staging deployment that is
publicly reachable and a production one that is not. The gate names the environment that failed for
the same reason.

**The step approval is on the step.** `requiresApproval` appears on `issue_refund` and not on
`lookup_claim`, which is refusal 4's fix surviving into the projection. There is no parallel list of
paused steps to drift out of sync with the pipeline; the pause is a property of the step that pauses.

**`state` is per document, and an agent override replaces it rather than merging.** The document
store keeps `ttlHours: 168`; the agent's `ttlHours: 24` replaces the whole block, which is why both
entries repeat `kind` and `urlEnv`. An adjudication run is finished or abandoned within a day while
the record of it is kept a week, and no generated file can read a `kind` from one declaration and a
`urlEnv` from another.

**The network block keeps both spellings for a 0.26 document.** `private: true` sits next to
`ingress: "public"` in that projection, and that is precisely why the flag was replaced: it never
moved the workload anywhere. This is the same honesty as the approvals table — the build records what
you declared, and a boolean that reads as a placement while projecting a public ingress is the kind of
claim that should not be left in the language.

**Then the honest part.** The controls above are generated, not merely declared. The region pin and
the audit sink reach the OpenTofu modules, `requiresApproval` reaches the generated tool step, a
checkpoint is signed once the document is new enough to name a key, a declared `state` is where the
claim nonce is claimed, and the generated service serves a resume route that continues a paused run
after a restart. The delivery-controls row of [`docs/features.md`](../features.md) is the maintained
statement of that, and it is generated rather than written by hand.

What no build can do is *verify* what you declared: that the issuer exists, that the private network
is actually peered, that the named reviewers are real people with real shifts. Those are properties
of your platform, and the honest way to report them is as declared inputs you have wired, not as
controls the compiler proved.

This particular fixture also does not compile, for three reasons none of which is a delivery control:

```console
$ aid gen
<spec>: error: prompt 'classify_claim' declares variables (subject) that the agent loop never renders, so the model would receive the template verbatim; declare a variable-free prompt for an agent to use [unsupported-agent]
    at agents.claims_adjudicator.instructions
<spec>: error: a pipeline 'tool' step calls this tool inline and the pipeline route has no authorization hook, so this predicate would not be enforced there; remove the declaration, drop the pipeline step, or reach the tool from an agent only [unsupported-tool-auth]
    at tools.issue_refund.auth
<spec>: error: a pipeline 'tool' step calls this tool inline and the pipeline route has no confirmation flow, so this guard would not be enforced there; remove the declaration, drop the pipeline step, or reach the tool from an agent only [unsupported-tool-confirmation]
    at tools.issue_refund.requiresConfirmation
```

That is the split to expect from the two commands. `validate` answers whether a spec is well-formed
and allowed; `gen` answers whether the chosen target can express it. A fixture written to exercise
five gates collects refusals from the second question too, and each of these is the framework
declining to emit a route on which a guardrail you declared would silently not run.

AID does not claim a capability it has not written, and it does not refuse a spec for omitting
something it cannot generate. Both halves of that are testable, which is why the counts and the
projection above are captured output rather than prose.

Read next: [the enterprise profile](enterprise-profile.md) for the 0.25 controls these extend, or
[the spec reference](../reference/spec.md#top-level-keys) for `identity`, `network`, `approvals` and
`state`.
