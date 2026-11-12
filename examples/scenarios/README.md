# `examples/scenarios/`

Three specs, each a whole delivery situation rather than a language tour. They exist to be read and
copied: the smallest spec that answers "what does this look like for a finance team, for a sales team,
and for a hospital's prior-authorization desk". Unlike the golden trees in the parent directory, the
generated code is not committed — each is compiled by `aid gen` when you want it, and every one passes
`aid validate` today or `packages/cli/test/scenarios.test.ts` fails.

They are chosen to cover both market segments. `invoice-intake` and `sales-outreach` are
`profile: standard`: the shortest path in, where the defaults are the answer and declaring a cloud
control is optional. `prior-auth-review` is `profile: enterprise`: the same compiler, but audit,
identity, private networking and an approval policy are required and the build is refused without
them.

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
standard of proof: the deployment is region-pinned to `eu-central-1`, authenticates with OIDC, runs
private with `declared-only` egress, ships audit records to CloudWatch for 730 days, and requires two
named approvers before a production change. Traces export over OTLP and feedback is captured with the
`rationale` field redacted and a retention window. The eval carries a promotion policy, so improving
the prompt is a gated change rather than an edit.

Delete `audit`, `identity`, `network` or `approvals` from the deployment and `aid validate` refuses the
document with `ir/profile-audit`, `ir/profile-identity`, `ir/profile-network` or
`ir/profile-approvals` respectively. That is the whole point of the profile, and it is what
`packages/cli/test/scenarios.test.ts` asserts by mutating the built IR.

```bash
cd examples/scenarios/prior-auth-review
node ../../../packages/cli/dist/cli.js validate app/app.spec.yaml
node ../../../packages/cli/dist/cli.js gen --dry-run
```

## What is yours to write

Every scenario declares a tool whose `handler.kind` is `business` — `send_email`,
`record_determination`. The generator emits the typed contract, the policy hooks and the call site;
the body of that function is yours, in `app/business/`, and the ownership boundary means a later
`aid gen` does not touch it. Sending mail and recording clinical determinations are things no compiler
can invent.

## Where to read next

- [Delivery playbook](../../docs/guide/delivery.md) — profiles, per-customer overlays, approvals and the improvement loop, end to end.
- [Delivery controls walkthrough](../../docs/walkthroughs/delivery-controls.md) — the enterprise controls in this tree, one at a time.
- [Spec reference](../../docs/reference/spec.md) — every key these specs use.
