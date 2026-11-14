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

<!-- boundary-table:start -->

| Concern | What the build refuses | What is generated | What you provide | Residual risk if you provide nothing |
| --- | --- | --- | --- | --- |
| Profile selection | `ir/profile-unknown` (refusal) — a profile AID does not define | The profile's requirements, as refusals on every deployment | The choice: `standard` or `enterprise` | `standard` ships with weaker required controls, by design |
| Region pin | `ir/profile-region` (refusal) — enterprise with no region pinned | The region in the OpenTofu modules | The region, and the residency obligation it satisfies | Nothing places data in a region you did not name; the obligation itself is yours |
| Audit sink | `ir/profile-audit` (refusal) — enterprise with no audit sink pinned<br>`ir/audit-target` (refusal) — an audit sink the cloud a deployment names cannot serve | The log group or sink, and the archive only when the document pins one | The sink you already own, its retention, and someone who reads it | AID emits the sink, never its contents or its policy |
| Private network | `ir/profile-network` (refusal) — enterprise with no `network.private` flag | The container module builds a two-AZ VPC with one NAT gateway when you do not supply `vpc_id`; the agent runtime is generated with `network_mode = "PUBLIC"` | Your VPC, its two private subnet ids, the egress rules, the peering and the DNS | `network.private: true` satisfies the profile gate, and no module reads it: a task that must not reach the internet is your configuration, not the flag |
| Input and output guardrails | `ir/profile-guardrail` (refusal) — enterprise with no guardrail inspecting model output<br>`ir/security-input-guardrail` (refusal) — caller text reaching a prompt with no input guardrail | The guardrail call, before the model and after it | The class, threshold and fallback | A classifier is not a policy: its accuracy is the limit |
| Redaction of recorded text | `ir/security-redaction-incomplete` (refusal) — a trace config that is on but does not redact a sensitive field<br>`ir/feedback-pii` (refusal) — a feedback signal with no retention, or a persistent one whose `pii.redact` misses a sensitive field | The redaction at the recording boundary, and the same set applied by `aid trace export` | The field names, and the fields' owners in your data | A value that arrives only in prose has no field to match and is recorded as written |
| Change approval | `ir/profile-approvals` (refusal) — enterprise production with no approval policy, or one that cannot gate<br>`ir/hitl-side-effect` (refusal) — a side-effecting tool with no approval policy<br>`ir/resume-owner-unbound` (refusal or warning) — a pausable agent whose deployment names no `identity.verifiedBy`; `enterprise` from spec 0.34 refuses it; `standard` warns | The pause, the signed checkpoint and the resume route | Someone to approve, and authentication in front of `/agents/resume` | A checkpoint proves the app issued it, not that the holder should have it |
| Identity and token verification | `ir/profile-identity` (refusal) — enterprise with no identity, or an identity kind AID does not define<br>`ir/identity-verified-by` (refusal) — enterprise with an identity and no named verifier | One `current_principal` dependency, whose default principal is anonymous | The verifier itself, named in `identity.verifiedBy` | **Nothing verifies a token until you do.** The gate proves you named who does |
| Authorization | `ir/security-missing-auth` (refusal) — a side-effecting tool with no auth in its policy<br>`ir/security-unauthenticated-path` (refusal) — a route that reaches a writing tool with no authentication<br>`ir/policy-syntax` (refusal) — a policy expression that does not parse | The policy check, evaluated per request, with a separate registered code for each of the 20 parse and predicate failures it can report | The principal it evaluates against, from your verifier | A policy requiring a signed-in caller refuses rather than trusts, but only if the principal is real |
| Durable state | `ir/agents-state-store` (refusal) — a writing agent with no durable state, or a `state` block AID cannot use<br>`ir/resume-replay-weak` (refusal or warning) — a pausable agent with no store to claim a nonce in; enterprise refuses it; `standard` warns | The nonce claimed in the store the `state` block names, so a replay is refused across replicas and restarts | The database, and persisting the paused run if it must outlive the process | Under `standard` the checkpoint is signed but replayable; `enterprise` refuses that document |
| Secrets | `ir/security-store-secret` (refusal) — a store whose `uri` is a literal connection string<br>`ir/resume-unsigned` (refusal or warning) — a pausable agent with no checkpoint signing key; `enterprise` at spec 0.32 or later refuses it; `standard`, and `enterprise` before 0.32, warn<br>`ir/resume-key-conflict` (refusal) — pausable agents naming different keys, stores or lifetimes behind one resume route<br>`ir/resume-key-alias` (refusal) — a signing key variable that already holds another credential | Environment-variable references in the infra, never the value | The value in your secret store, and a rotation plan | Rotating the signing key invalidates the checkpoints outstanding at that moment |
| Model pinning and cost | `ir/cost-profile-unknown` (refusal or warning) — an eval pricing a model or knowledge base that has no cost profile; a declared budget makes it a refusal; without one it warns<br>`ir/cost-budget-exceeded` (warning) — an eval estimated above its declared budget | The pinned model id and the spend recorded per run | The version bump when a pin changes, and the pricing when a provider moves | A pin holds the id, not the behaviour behind it |
| Eval coverage | `ir/eval-uncovered` (refusal or warning) — an HTTP pipeline that no gate.ci eval claims; `enterprise` at spec 0.31 or later refuses it; everything else warns<br>`ir/eval-metric-vacuous` (refusal) — a metric that can only pass: a ceiling the agent already enforces, or an approval on an agent that never pauses | The offline evaluator, its cases and its baseline comparison | The cases, and the curation that keeps them honest | An eval measures the cases it was given |
| Trajectory evals | `ir/eval-trajectory` (refusal) — an agent eval whose target cannot run one | An evaluator that scores the calls a run made: reachable tools, order, step count, cost, and whether an approval was respected | A recorded run when you want a model that is not scripted | A scripted trajectory verifies policy and plumbing, **not** model behaviour |
| Observability export | `ir/observability-export` (refusal) — activity exported with `trace` off, or enterprise with no export<br>`ir/alerts-unexported` (refusal) — alerts declared with no signal exported for a collector to read<br>`ir/alerts-unproduced` (refusal) — an alert whose metric nothing in the build records | The OTel spans and the declared dashboards and alerts as code | A collector endpoint, and calling `metrics_export_status()` for the alerts to fire | Traces are opt-in; an undeclared signal has no dashboard |
| Promotion and self-improvement | `ir/promotion-regression` (refusal) — a quality allowance on an eval measuring no quality metric<br>`ir/promotion-cost` (refusal) — a cost allowance on an eval with no cost ceiling, or a build where no target records spend<br>`ir/promotion-approval` (refusal) — an enterprise promotion with no recorded approval | Nothing that deploys: the comparison, and the gate result | The approval, and the merge that carries it | Nothing auto-promotes; the record in the tree is what an auditor reads |
| Deployment | `ir/cloud-unsupported` (refusal) — a cloud AID does not provision<br>`ir/deploy-target-unknown` (refusal) — a deployment target that is not one of the clouds<br>`ir/cloud-conflict` (refusal) — deployments naming different clouds for one module set<br>`ir/region-target` (refusal) — a region the cloud a deployment names does not offer<br>`cli/infra-cloud-conflict` (refusal) — a `--cloud` flag that disagrees with the spec the modules were generated from | The modules, the generated CI, and the plan | The account, the apply, and the rollback | AID plans and generates; it never applies for you |

<!-- boundary-table:end -->

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

Policies, predicates and the `ir/policy-*`<!-- docs-claims: family; the policy, predicate and data-access refusals share this prefix --> family are generated and evaluated per request, and
`ir/security-unauthenticated-path` refuses a path that authenticates nothing. The evaluation is
only as good as the principal it sees, so this row is the identity row's consequence.

- **You provide:** the principal populated before the policy runs.
- **If you provide nothing:** policies that require a signed-in caller refuse. Policies that do
  not require one run against an anonymous principal, which is what they asked for.

### Resume checkpoints: signed, expiring, and still a capability

A pausable agent must name a signing key (`state.signingKeyEnv`, never an inline value). The
generated resume route refuses a checkpoint it did not sign, one past its deadline, and — where
the document declares a durable `state` — one the store has already spent, each as one
opaque `403` whose body names no reason. Which check failed is logged against the agent id
and the checkpoint nonce, not returned: the caller holds the checkpoint, so a reason is a
hint for tuning the next attempt.

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
