# `examples/scenarios/`

Four specs, each a whole delivery situation rather than a language tour. They exist to be read and
copied. Three are the *smallest* spec that answers "what does this look like for a finance team, for a
sales team, and for a hospital's prior-authorization desk"; the fourth, `warranty-claims`, is
deliberately the opposite — one document that uses every shipped capability at once, so that the width
of the framework is visible in a single place rather than assembled from four. Unlike the golden trees
in the parent directory, the generated code is not committed — each is compiled by `aid gen` when you
want it, and every one passes `aid validate` today or `packages/cli/test/scenarios.test.ts` fails.

They are chosen to cover both market segments. `invoice-intake` and `sales-outreach` are
`profile: standard`: the shortest path in, where the defaults are the answer and declaring a cloud
control is optional. `prior-auth-review` is `profile: enterprise`: the same compiler, but audit,
identity, private networking and an approval policy are required and the build is refused without
them. `warranty-claims` is `enterprise` too, and is the one to read once the others have made the
language familiar.

Run any of them from its own directory. `aid gen` writes into the directory you run it from, so
running it from inside `app/` produces `app/app/generated/`.

## `invoice-intake/` — standard profile, structured extraction

A payables team receives invoices as unstructured text in three shapes and needs the same five fields
in a ledger. One prompt, one struct, one guardrail and one eval gate; the route, request schema,
retries, structured-output enforcement and trace are generated. `invoice_pii` runs on both the input
and the output stage, because a supplier who pastes a personal email into an invoice body gets it
echoed back in the extracted `vendor` field. The `overridable` block pins what a per-customer overlay
may move — region, model, and the eval's regression ceiling — so the same spec serves many customers
without a fork.

```bash
cd examples/scenarios/invoice-intake
node ../../../packages/cli/dist/cli.js validate app/app.spec.yaml
node ../../../packages/cli/dist/cli.js gen --dry-run
```

## `sales-outreach/` — standard profile, a human at the write step

A draft-then-send agent. The interesting part is the tool: `send_email` declares
`sideEffects: write`, `requiresConfirmation: true`, `idempotency: key` and a scope check, so the agent
pauses for a reviewer before anything leaves the building and retrying a resumed run does not send the
message twice. A third guardrail runs at the `tool-call` stage rather than on text, because the
payload worth policing is the one on its way out of the process. The budget is bounded
(`maxSteps: 6`, `maxCostBudget: 0.25`), which is what lets `aid gen` emit the agent at all.

```bash
cd examples/scenarios/sales-outreach
node ../../../packages/cli/dist/cli.js validate app/app.spec.yaml
node ../../../packages/cli/dist/cli.js gen --dry-run
```

## `prior-auth-review/` — enterprise profile, every delivery control declared

A prior-authorization desk. Not a different feature set from the two above so much as a different
standard of proof: the deployment is region-pinned to `eu-central-1`, authenticates with OIDC, claims
a private placement with `declared-only` egress, ships audit records to CloudWatch for 730 days, and
requires two named approvers before a production change. Traces export over OTLP and feedback is
captured with the `rationale` field redacted and a retention window. The eval carries a promotion
policy, so improving the prompt is a gated change rather than an edit.

It is pinned to `specVersion: "0.33"` on purpose, and that pin is part of the lesson. At that version
`network.private: true` was read by the profile gate and by no emitter, so the document *claims* a
private placement it does not get: the emitted load balancer is public and its ingress rule opens
`0.0.0.0/0`. The key was retired rather than promoted in 0.37, because a version bump must not move
live traffic, and `ingress: internal` is what actually selects the private subnets — which is why
`warranty-claims` below writes it. Read [the migrations](../../docs/migration.md) before copying a
deployment block out of this one.

Delete `audit`, `identity`, `network` or `approvals` from the deployment and `aid validate` refuses the
document with `ir/profile-audit`, `ir/profile-identity`, `ir/profile-network` or
`ir/profile-approvals` respectively. That is the whole point of the profile, and it is what
`packages/cli/test/scenarios.test.ts` asserts by mutating the built IR.

```bash
cd examples/scenarios/prior-auth-review
node ../../../packages/cli/dist/cli.js validate app/app.spec.yaml
node ../../../packages/cli/dist/cli.js gen --dry-run
```

## `warranty-claims/` — enterprise profile, one document at full width

A vehicle-warranty adjudication desk. The three scenarios above each answer "what is the shortest spec
that does this job"; this one answers "what does one spec look like when it does all of it at once".
It is still a single file: one HTTP pipeline of fourteen steps, six tools, three agents, two
retrievers, eight guardrails, one decision, five evals and two deployments.

- **Contracts.** `ClaimIntake` in, `ClaimPacket` out, and the intermediate structs — `VehicleRecord`,
  `RiskAssessment`, `PartOrder`, `OrderReceipt`, `PolicyCitation` — that steps bind along the way. The
  response model comes from what `emit` binds, so it is not hand-written.
- **A decision that routes.** `claim_path` is a `choice` rubric. An input guardrail reads it with a
  confidence floor and a fail-closed action, and a `route` step maps all four labels to four arms that
  each do their own write.
- **Two retrieval surfaces.** `policy_corpus` is a file-backed index with recursive chunking, hybrid
  search, metadata filters and citations; `policy_archive` is an `aws-bedrock` knowledge base
  re-ingested by the engine that owns it. Only one can sit at pipeline level, because a retrieval
  metric resolves to exactly one retriever — so that is where the measured index goes and the other is
  retrieved inside a fan-out.
- **Agents with bounds.** `adjudicator` delegates to `specialist`, carries `claim_thread` memory,
  pauses for a human before a write, and declares `maxSteps`, `maxCostBudget`, `maxTokensBudget` and a
  tool allow-list. `auditor` has no tools at all, which is what makes it the one agent a pipeline step
  may name: a step has no human to pause for.
- **All of the pipeline wiring.** `parallel`, `branch` on the caller's role, `route` into four writing
  arms, an `agent` step, `rerank`, `map` and `reduce` over the retrieved clauses, and one `generate`
  that assembles the structured answer.
- **Guardrails at every stage.** `input`, `output`, `retrieval` and `tool-call` — three tool-call
  guardrails, grouped by the argument names they redact, because a field can only be masked at a stage
  whose payload has that field.
- **Evals that can fail.** A published-schema eval carrying a cost ceiling and a promotion policy with
  a named approval record, a retrieval eval, and three trajectory evals that score the run — tool
  order, step count, forbidden tools, spend, and whether the pause was respected. No model judges a
  model.
- **Observability.** OTLP export with a redaction set, three alerts (agent cost, agent tokens, eval p95
  latency), and three declared feedback signals with PII redaction and a retention floor.
- **A gateway.** One MCP gateway federating an OpenAPI schema and an MCP server. Nothing in it enters
  the generated tool registry.
- **Two deployments from one declaration.** A container on the managed agent runtime — session,
  memory, gateway — and a Kubernetes placement of the same service. Both region-pinned, both private.

Two refusals it teaches by being broken:

- The managed runtime carries exactly one request shape, so the document declares exactly one
  `trigger.http` pipeline. A second route is a second service, not a second key.
- A retrieval metric resolves to exactly one retriever from its own pipeline's top-level steps, so a
  second index cannot be scored by the same metric. It is retrieved inside a fan-out instead, and this
  is written down rather than papered over.

```bash
cd examples/scenarios/warranty-claims
node ../../../packages/cli/dist/cli.js validate app/app.spec.yaml
node ../../../packages/cli/dist/cli.js gen --dry-run
```

Unlike the others, the tool bodies ship with it: `app/business/tools/` holds the six handlers, the
corpus under `app/business/policies/` is what the file-backed retriever ingests, and
`app/approvals/assembly-version-3.md` is the record the promotion policy names. A `gen` followed by
`aid dev` therefore runs against something rather than importing six missing modules.

## What is yours to write

Every scenario declares a tool whose `handler.kind` is `business` — `send_email`,
`record_determination`. The generator emits the typed contract, the policy hooks and the call site;
the body of that function is yours, in `app/business/`, and the ownership boundary means a later
`aid gen` does not touch it. Sending mail and recording clinical determinations are things no compiler
can invent. `warranty-claims` ships all six of its bodies, because a scenario that cannot be run is a
document rather than an example.

## Where to read next

- [Delivery playbook](../../docs/guide/delivery.md) — profiles, per-customer overlays, approvals and the improvement loop, end to end.
- [Delivery controls walkthrough](../../docs/walkthroughs/delivery-controls.md) — the enterprise controls in this tree, one at a time.
- [Spec reference](../../docs/reference/spec.md) — every key these specs use.
