---
description: "The delivery boundary, row by row: what the build refuses with a named diagnostic, what is generated for you, what stays yours to provide, and the risk that remains if you provide nothing."
---

# What AID enforces, and what stays yours

A customer's security review asks one question about every control: *who enforces this, and
what happens if it is missing?* This page answers it in the same shape for every concern, so
the answer can be read rather than inferred from the generated tree.

The rule the table keeps is the project's rule. **A row whose second column is empty is not a
control**: it is a concern you own, and saying so is more useful than a green checkmark. Nothing
in the fourth column is a caveat hidden in generated code — every one of them is either refused
at build time or written down here, in [the delivery playbook](./delivery.md), and in the
reference page for the construct.

## The boundary in one table

| Concern | What the build refuses | What is generated | What you provide | Residual risk if you provide nothing |
| --- | --- | --- | --- | --- |
| Profile selection | `ir/profile-unknown` — a profile AID does not define | The profile's requirements, as refusals on every deployment | The choice: `standard` or `enterprise` | `standard` ships with weaker required controls, by design |
| Region pin | `ir/profile-region` — `enterprise` with no `region` | The region in the OpenTofu modules | The region, and the residency obligation it satisfies | Nothing places data in a region you did not name; the obligation itself is yours |
| Audit sink | `ir/profile-audit` — `enterprise` with no `audit`; `ir/audit-target` — a sink the cloud cannot serve | The log group or sink, and the archive only when the document pins one | The sink you already own, its retention, and someone who reads it | AID emits the sink, never its contents or its policy |
| Private network | `ir/profile-network` — `enterprise` with no `network.private` | A two-AZ VPC, private task subnets, one NAT gateway | Egress rules, peering and DNS | One NAT gateway is an availability choice, not an accident |
| Input and output guardrails | `ir/profile-guardrail` — `enterprise` with no guardrail inspecting model output; `ir/security-input-guardrail` — no input guardrail where a policy needs one | The guardrail call, before the model and after it | The class, threshold and fallback | A classifier is not a policy: its accuracy is the limit |
| Redaction of recorded text | `ir/security-redaction-incomplete` — an agent run whose trace config is on but does not redact a field the spec marks sensitive; `ir/feedback-pii` — a persistent text signal whose `pii.redact` misses one of those fields | The redaction at the recording boundary, and the same set applied by `aid trace export` | The field names, and the fields' owners in your data | A value that arrives only in prose has no field to match and is recorded as written |
| Change approval | `ir/profile-approvals` — `enterprise` production with no approval policy; `ir/hitl-side-effect` — a side-effecting tool with no approval | The pause, the signed checkpoint and the resume route | Someone to approve, and authentication in front of `/agents/resume` | A checkpoint proves the app issued it, not that the holder should have it |
| Identity and token verification | `ir/profile-identity` — `enterprise` with no `identity`; `ir/identity-verified-by` — no named verifier | One `current_principal` dependency, whose default principal is anonymous | The verifier itself, named in `identity.verifiedBy` | **Nothing verifies a token until you do.** The gate proves you named who does |
| Authorization | `ir/security-missing-auth` — a tool or policy that needs a caller; `ir/security-unauthenticated-path` — a path with no authentication; `ir/policy-syntax` — a policy that does not parse, with nine siblings naming the specific parse error | The policy check, evaluated per request | The principal it evaluates against, from your verifier | A policy requiring a signed-in caller refuses rather than trusts, but only if the principal is real |
| Durable state | `ir/agents-state-store` — a writing agent with no store; `ir/resume-replay-weak` — a pausable agent with no store, which `enterprise` refuses and `standard` warns about | The nonce claimed in the store the `state` block names, so a replay is refused across replicas and restarts | The database, and persisting the paused run if it must outlive the process | Under `standard` the checkpoint is signed but replayable; `enterprise` refuses that document |
| Secrets | `ir/security-store-secret` — a store whose `uri` is a literal connection string; `ir/resume-unsigned` — a pausable agent with no signing key, refused under `enterprise` and flagged under `standard`; `ir/resume-key-conflict` — pausable agents naming different keys behind one resume route; `ir/resume-key-alias` — a signing key that already holds another credential | Environment-variable references in the infra, never the value | The value in your secret store, and a rotation plan | Rotating the signing key invalidates the checkpoints outstanding at that moment |
| Model pinning and cost | `ir/cost-profile-unknown` — a model, or a fallback, with no cost profile; `ir/cost-budget-exceeded` warns when an eval's estimate is above its declared budget (a flag, not a refusal) | The pinned model id and the spend recorded per run | The version bump when a pin changes, and the pricing when a provider moves | A pin holds the id, not the behaviour behind it |
| Eval coverage | `ir/eval-uncovered` — an HTTP pipeline with no `gate.ci` eval claiming it, a warning that becomes an error under `enterprise` from spec `0.31`; `ir/eval-metric-vacuous` — a metric that can only pass: a step ceiling at or above the agent's own `maxSteps`, or an approval metric on an agent that never pauses | The offline evaluator, its cases and its baseline comparison | The cases, and the curation that keeps them honest | An eval measures the cases it was given |
| Trajectory evals | `ir/eval-trajectory` — an agent eval on a target that cannot run one | An evaluator that scores the calls a run made: reachable tools, order, step count, cost, and whether an approval was respected | A recorded run when you want a model that is not scripted | A scripted trajectory verifies policy and plumbing, **not** model behaviour |
| Observability export | `ir/observability-export` — `enterprise` with no export, or `export: otlp` with `trace` off; `ir/alerts-unexported` — alerts declared with nothing exporting their series; `ir/alerts-unproduced` — an alert whose metric nothing in the build records | The OTel spans and the declared dashboards and alerts as code | A collector endpoint, and calling `metrics_export_status()` for the alerts to fire | Traces are opt-in; an undeclared signal has no dashboard |
| Promotion and self-improvement | `ir/promotion-regression`, `ir/promotion-cost` — a candidate that regresses quality or exceeds the cost ceiling; `ir/promotion-approval` — a promotion with no recorded approval | Nothing that deploys: the comparison, and the gate result | The approval, and the merge that carries it | Nothing auto-promotes; the record in the tree is what an auditor reads |
| Deployment | `ir/cloud-unsupported` — a cloud AID does not provision; `ir/deploy-target-unknown` — a name that is not a cloud; `ir/cloud-conflict`, `ir/region-target` — deployments that cannot share a module set; `cli/infra-cloud-conflict` — a `--cloud` that disagrees with the spec | The modules, the generated CI, and the plan | The account, the apply, and the rollback | AID plans and generates; it never applies for you |

Every `ir/*` diagnostic above is emitted by `aid validate`, which accepts `--json` if you would
rather script the review than read it. The one `cli/*` code is different in kind: the spec and
`--cloud` can each be valid alone, and only `aid infra` — the command that combines them — can
see that they disagree. `aid doctor` reports the conditions that are declared but unverifiable,
such as an alert whose metrics nobody exports.

## The four rows that decide your plan

The rest of the table is configuration. These four are work, and they are the ones a security
review will ask about first.

### Identity: the gate checks the declaration, not the token

AID generates one dependency, `current_principal`, and its default principal is anonymous and
unauthenticated. `identity.verifiedBy` names the entry point that replaces it. The enterprise
profile refuses a deployment that names an identity but not a verifier, so the claim is a
documented responsibility with a place to put the answer — not an implied feature.

- **You provide:** token verification, in `app/business/`, wired through the dependency.
- **If you provide nothing:** every request reaches the agent as an anonymous principal. A
  policy that requires a caller refuses the request, which is safe and also useless.
- **Read next:** [the delivery playbook](./delivery.md#the-enterprise-checklist), and the
  identity row of the [spec reference](../reference/spec.md#top-level-keys).

### Authorization: the policy is generated, the principal is yours

Policies, predicates and the `ir/policy-*` family are generated and evaluated per request, and
`ir/security-unauthenticated-path` refuses a path that authenticates nothing. The evaluation is
only as good as the principal it sees, so this row is the identity row's consequence.

- **You provide:** the principal populated before the policy runs.
- **If you provide nothing:** policies that require a signed-in caller refuse. Policies that do
  not require one run against an anonymous principal, which is what they asked for.

### Resume checkpoints: signed, expiring, and still a capability

A pausable agent must name a signing key (`state.signingKeyEnv`, never an inline value). The
generated resume route refuses a checkpoint it did not sign, one past its deadline, and — where
the document declares a durable `state` — one the store has already spent, each as a `403`
whose `detail.reason` says which.

- **You provide:** authentication in front of `/agents/resume`, and the checkpoint delivered to
  the person whose approval it asks for.
- **If you provide nothing:** the signature stops an edited checkpoint from approving a
  different call, and the deadline bounds a stolen one. Neither identifies the caller. A
  checkpoint is a bearer capability; treat it as a secret.
- **Read next:** [the delivery playbook](./delivery.md), which states the `standard` and
  `enterprise` positions side by side.

### Durable state: the store holds the nonce, not the run

The `state` block names a database, and the generated route claims the checkpoint's nonce there,
so a replay is refused across replicas and across restarts. The run itself is still carried by
the checkpoint, and the generated route hands it back to the caller.

- **You provide:** the database, and persistence of the paused run if it must survive the
  request that paused it.
- **If you provide nothing:** under `enterprise` the document is refused. Under `standard` the
  checkpoint is signed but replayable only by the process that issued it, and
  `ir/resume-replay-weak` says so at build time rather than leaving it to be discovered.
- **Read next:** [Durable run state](../features.md#durable-run-state) on the features page,
  which is where a construct that is declared and gated but not generated is listed rather than
  counted.

## The reviewer checklist

Run this in the customer's repository, before the review, in this order. Every step is a command
in the customer's own CI; no step needs a service to be running.

1. **The document builds, and the profile does what it claims.**
   `aid validate app/app.spec.yaml --json`. Read the diagnostics, not the exit code alone. An
   `enterprise` document that passes has, by construction, a region, an audit sink, a private
   network, an output guardrail, an identity with a verifier, approvals on production, and an
   export.
2. **Everything declared is produced.** `aid gen` and confirm the tree is unchanged. A declared
   alert with no exported metric is reported by `aid doctor`; a dashboard nobody feeds is worse
   than no dashboard.
3. **The generated tree is not the customer's.** Confirm the boundary has not moved:
   `app/generated/` is the generator's, `app/business/` is theirs, and `aid eject` transfers the
   first without breaking the second.
4. **Each customer resolves from one base.** `aid resolve customers/<c>.yaml --check` proves the
   overlay only writes paths the base opened. `aid fleet` prints the table across customers.
5. **Costs and evals are measured, not asserted.** `aid report` reads the artifacts directory and
   gives cost per customer and eval drift without a hosted backend.
6. **The four rows above have names against them.** Identity: who verifies the token. Resume:
   who is in front of `/agents/resume` and who receives a checkpoint. Durable state: which
   database, and whether paused runs survive a restart. Authorization: where the principal comes
   from.
7. **Promotion is a merge, not a switch.** Nothing in the loop deploys. The candidate's eval
   comparison passes, the approval is recorded, and the merge carries the pinned version.

If a step cannot be answered, the honest outcome is not a caveat in the review — it is a change
to the spec or a line in the customer's plan, and the gate that should have caught it is the one
to fix.

## What this page is not

It is not a compliance claim, and it does not replace the [support matrix](../reference/support.md):
a cloud or target AID does not generate is refused by name rather than approximated, and the
matrix is the list of what exists. It is also not a promise that every control above is
generated — the fourth column is the part that is yours, stated once, where a reviewer will look
for it.
