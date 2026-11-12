---
name: aid-framework
description: Install and use AID Framework, which compiles one declarative YAML spec into a governed FastAPI or Next.js service. Use when a task involves app/app.spec.yaml, the aid CLI (validate, gen, dev, eval, infra, resolve, fleet, trace, eject, doctor), generated app/generated code, the ownership boundary with app/business, per-customer overlays, standard versus enterprise delivery controls, or choosing between the py-fastapi and ts-vercel targets.
---

# AID Framework

One YAML file (`app/app.spec.yaml`) declares models, prompts, tools, retrieval, agents, pipelines,
guardrails, evals and deployments. `aid gen` compiles it into a runnable service. `aid validate`
runs every build-time gate first, and refuses a spec that is impossible or unsafe with a named
diagnostic and the fix.

Three things decide how you work with it:

- **Gates are the product.** A refusal is the feature, not an error to route around. Never delete a
  construct to silence a gate; read the diagnostic's hint and satisfy it, or change the spec's intent
  deliberately.
- **There is no hosted control plane and no request proxy.** Everything is files, the CLI, and CI.
  Fleet features read from git.
- **The boundary is real.** The generator owns `app/generated/`. You own `app/business/`. Editing a
  generated file fails `aid doctor`, and the next `aid gen` overwrites it.

## Pick the scenario

| You are… | Start with | Section |
| --- | --- | --- |
| Evaluating the framework | `npx @aid-framework/cli init my-app --gen` | [1](#1-try-it-without-cloning) |
| Starting a greenfield service | `aid init <dir> --template <name>` | [2](#2-start-a-new-service) |
| Bringing an existing spec | `aid init <dir> --from <spec>` | [3](#3-adopt-an-existing-spec) |
| Needing a TypeScript/Next.js service | `--target ts-vercel` | [4](#4-compile-the-typescript-target) |
| Serving it locally | `aid dev` | [5](#5-run-it-locally) |
| Delivering to many customers | `overridable`, `customers/`, `aid fleet` | [6](#6-deliver-one-spec-to-many-customers) |
| Passing an enterprise review | `profile: enterprise` | [7](#7-meet-an-enterprise-review) |
| Improving a live agent | `aid trace export`, `aid eval --compare` | [8](#8-improve-an-agent-without-auto-deploying) |
| Shipping infrastructure | `aid infra gen` | [9](#9-derive-the-infrastructure) |
| Owning a generated file | `aid eject` | [10](#10-take-ownership-of-a-generated-file) |
| Debugging a refusal | diagnostic code + hint | [Reading a refusal](#reading-a-refusal) |

## 1. Try it without cloning

The CLI is published. Node.js 24 or newer, no repository checkout:

```bash
npx @aid-framework/cli init my-app --gen
cd my-app
npx @aid-framework/cli validate
npx @aid-framework/cli dev
```

`init` writes `app/app.spec.yaml`, a README, and two CI workflows. `validate` runs spec parsing, the
IR build, and every gate. `--gen` compiles immediately, so a refusal arrives before you have read
anything.

The generated routers import the Python runtime. Outside `aid dev`, install it yourself:

```bash
pip install aid-runtime-python "fastapi>=0.115,<1" "uvicorn>=0.30,<1"
uvicorn app.main:app --reload
```

`app/main.py` is yours to write: a few lines mounting the generated routers. Nothing else in the
serving path is.

## 2. Start a new service

Two golden-path templates ship, and they differ by profile rather than by domain:

```bash
npx @aid-framework/cli init support-desk --template support-copilot --gen
npx @aid-framework/cli init claims-desk --template enterprise-approvals --gen
```

- `support-copilot` — `profile: standard`. One model, one reply prompt, guardrails on both sides, one
  eval whose gate can fail, and nothing to configure that the defaults answer. This is the mid-size
  path: managed services, low ops burden.
- `enterprise-approvals` — `profile: enterprise`. An OIDC identity provider, a private placement with
  declared-only egress, an audit sink with a retention floor, durable state, and a human approval
  before the write.

Both carry an `overridable` block, because a template is the base half of the overlay workflow in
[6](#6-deliver-one-spec-to-many-customers).

Neither template is a scaffold to strip. Delete a guardrail and the profile gate refuses the build,
which is the intended feedback.

## 3. Adopt an existing spec

```bash
npx @aid-framework/cli init legacy-app --from path/to/app.spec.yaml --gen
```

`--from` imports the spec you have instead of writing a starter, then runs every gate. A spec written
for an older spec language fails with `spec/not-supported` naming the version it needs; bump
`specVersion` and re-run rather than lowering what you ask for.

If the tree is already generated and only the toolchain changed:

```bash
npx @aid-framework/cli doctor
npx @aid-framework/cli gen --check
```

`doctor` reports drift between the spec, the committed tree and the installed versions. `gen --check`
writes nothing and exits non-zero when the tree does not match the spec — the same check CI runs, and
the one to put in your pipeline.

`gen` and `dev` write to `<cwd>/app/`, never to the spec's directory, and `init <dir>` creates
`<dir>/app/` under the current directory. Run them from the directory that *contains* `app/`: `my-app/`
for a generated project, `examples/support-copilot/` for a repo example. Run from inside `app/` and you
get `app/app/generated/`; run from the repository root and the tree lands in an unrelated `app/` there.
If a `gen` run succeeds but nothing you expected changed, check where you were standing before you
check the spec.

## 4. Compile the TypeScript target

`py-fastapi` is the default. The same spec compiles to a Next.js handler with `ts-vercel`:

```bash
npx @aid-framework/cli gen --target ts-vercel
```

The Next App Router shim is hand-written; the handler is generated. A spec may declare both targets, so
one declaration serves both stacks. `examples/support-copilot` and `examples/support-copilot-ts`
compile the same support-ticket domain with one target each, which is the comparison worth reading.

## 5. Run it locally

```bash
npx @aid-framework/cli dev
```

`dev` regenerates the tree and serves it on port 8000 with a reloader. `--no-gen` serves what is on
disk, `--no-reload` turns the reloader off, `--port` moves it.

To check the guardrails themselves against a red-team corpus, rather than waiting for a hostile
request:

```bash
npx @aid-framework/cli guard
```

## 6. Deliver one spec to many customers

Do not fork the spec per customer. The base spec marks the only paths a customer may move:

```yaml
overridable:
  deployments.api.region:
    from: [us-east-1, eu-west-1]
  models.fast.modelId:
    from: [gpt-4o-mini, gpt-4.1-mini]
  agents.triage_agent.maxCostBudget:
    max: 0.05
  evals.reply_quality.gate.maxRegression:
    max: 0.1
```

A customer overlay names the base and changes nothing else. Any path outside the block is refused.

```bash
npx @aid-framework/cli resolve customers/acme-eu.yaml --check
npx @aid-framework/cli fleet customers
```

`resolve` prints the concrete spec an overlay means — the reviewed artifact, one per customer.
`--check` fails when the committed resolved spec has drifted from its overlay, so review happens on
the diff rather than on trust. `fleet` reports every customer's profile, pins, ceilings and gate
status in one table, and is safe to run in CI because it reads files and nothing else.

Aggregate across deployments from their trace sinks:

```bash
npx @aid-framework/cli report customers --budget 500
```

`--budget` fails when the fleet total exceeds the ceiling. Full workflow:
[`docs/guide/delivery.md`](../../../docs/guide/delivery.md).

## 7. Meet an enterprise review

`profile: enterprise` is not a label. The profile gate refuses each missing control with its own
diagnostic, so an enterprise spec either has them or does not build:

| Control | Diagnostic when missing |
| --- | --- |
| Pinned region and cloud per deployment | `ir/profile-region` |
| Audit sink per deployment | `ir/profile-audit` |
| Declared identity integration (`identity`) | `ir/profile-identity` |
| Private networking (`network.private: true`) | `ir/profile-network` |
| Approval policy for production (`approvals`) | `ir/profile-approvals` |
| At least one guardrail inspecting model output | `ir/profile-guardrail` |

```yaml
profile: enterprise

deployments:
  prod:
    target: container
    cloud: aws
    region: eu-central-1
    audit:
      sink: cloudwatch
      retentionDays: 400
    identity:
      kind: oidc
      issuer: https://login.example.com
      audience: aid-claims
    network:
      private: true
      egress: declared-only
    approvals:
      require: [security, platform]
      minApprovers: 2
    secrets: [OPENAI_API_KEY]
```

Agents add bounded autonomy on top. An unbounded loop or an unbounded budget is a build error, and an
agent that can write declares both a ceiling and a pause:

```yaml
agents:
  claims_agent:
    name: Claims adjudicator
    instructions: adjudicate_claim
    model: triage
    tools: [issue_refund]
    guardrails: [inbound, tool_calls]
    maxSteps: 8
    maxCostBudget: 2.5
    humanInTheLoop:
      when: "not hasRole('auto_approver')"
      channel: claims-review
```

**Be honest about the boundary of these controls.** The gate checks the *document*, because that is
what a build can check without an account or a network call. It does not verify that the declared
issuer exists, that the private network is peered, or that the named reviewers are real people. Those
are properties of your platform. State them as declared, not as verified.

## 8. Improve an agent without auto-deploying

The improvement loop is file-based. Traces become a dataset, the dataset gates a candidate, a human
promotes it. Nothing deploys itself.

```bash
npx @aid-framework/cli trace export --dataset support_runs --version 2
npx @aid-framework/cli eval --baseline
npx @aid-framework/cli eval --compare baseline.json --candidate candidate.json
```

`trace export` turns recorded runs into `datasets/<name>.json`, which an eval can read.
`eval --baseline` records the accepted measurement. `eval --compare` applies the eval's
`gate.promotion` policy to an accepted and a candidate baseline and refuses a candidate that regresses
quality beyond `allowedQualityDrop`.

The quality allowance is judged. A declared cost ceiling is reported as unjudged, because no runtime
records cost — do not describe a passing `--compare` as having proven a cost bound.

Under `profile: enterprise` the promotion policy also requires a recorded approval, so promotion has a
name attached before it can land. Full workflow: [`docs/guide/delivery.md`](../../../docs/guide/delivery.md).

## 9. Derive the infrastructure

```bash
npx @aid-framework/cli infra gen
npx @aid-framework/cli infra plan --env dev
```

`infra gen` derives OpenTofu or CDK wiring from the spec; `infra plan` and `infra apply` drive the
backend. `--cloud aws|gcp` and `--iac tofu|cdk` select the module set, and `--confirm-prod` is
required before an apply can touch production.

Applying is an operator action with credentials. Do not run `infra apply` to answer a question — use
`infra gen` plus `--dry-run`, or `gen --check`, which need no account.

## 10. Take ownership of a generated file

When a generated file needs a hand edit that the spec cannot express, eject it rather than editing it
in place:

```bash
npx @aid-framework/cli eject app/generated/tools/lookup_customer.py --dry-run
```

`eject` moves the file into `app/business/` and stops generating it. The business tree is never
overwritten and never diffed by `gen --check`. Prefer changing the spec; eject is for the residue, and
each ejection is a piece of plumbing you now maintain.

## Reading a refusal

Every diagnostic carries a stable code, the path that caused it, and a hint. `aid validate --json`
gives the same document the CI gate reads.

```text
app/app.spec.yaml: 1 error(s), 0 warning(s)
app/app.spec.yaml: error: the agents gate rejected "pa_review_agent": it may take up to 10 steps but declares neither maxTokensBudget nor maxCostBudget, so nothing bounds what one run costs [ir/agents-budget]
    at agents.pa_review_agent.maxTokensBudget
    hint: declare maxTokensBudget or maxCostBudget, or set maxSteps: 1
```

Work the refusals in order. `spec/*` means the document cannot be parsed as this version of the
language, so fix that before an IR gate can say anything useful. A refusal under `ir/capability-*` or
`ir/target-*` means the named target cannot do what the spec asks — pick another target or drop the
construct; the framework will not emit a stub for it. Everything else is an `ir/*` gate: the spec
parsed, the target can express it, and the build is refusing on policy.

## What is gated, and what is only declared

Keep these apart in anything you write or tell a user:

- **Gated.** Spec version support, target capabilities, region and cloud consistency, audit sink
  validity, enterprise delivery controls, guardrail presence and stages, agent bounds, eval coverage
  and regression ceilings, cost profiles for every priced model, deploy plan validity.
- **Declared, not verified.** Identity issuers, network peering, reviewer identities, and secret
  values. The build refuses a spec that omits them; it cannot confirm they exist.
- **Generated but not yet protected.** An agent that can pause gets a `POST /agents/resume` route
  alongside `POST /agents/{agent_id}/run`. The checkpoint it accepts replays the conversation and the
  pending tool calls, so treat it as a bearer capability: the build proves the route exists, not that
  the caller is allowed to continue someone else's run. Put it behind your own authorizer before you
  expose it outside a trusted network.
- **Not generated.** Retrieval migrations are emitted for an operator to apply (`aid migrate`).
  Managed knowledge base re-ingestion is a request to the engine that owns it (`aid kb`). Neither
  runs on its own.

Anything else you are tempted to claim: check `docs/features.md`, which is generated from the
registry, and the CLI reference at `docs/reference/cli.md`.

## The tree

```text
<project>/
  app/
    app.spec.yaml          # you: the declaration
    business/              # you: tool bodies, domain code - never regenerated
    generated/             # the generator: routes, prompts, pipelines, gateway, evals
    aid.manifest.json      # hashes of every generated file; what `gen --check` compares
    evals/                 # you: the datasets the spec points at; `init` does not write them
    main.py                # you: a few lines mounting the generated routers
  customers/               # you: one overlay per customer
  infra/                   # the generator: appears after `aid infra gen`
```

If a generated file must change, change the spec and re-run `aid gen`. If the spec cannot express it,
`aid eject` and own the file.

## Where to read more

- [`docs/guide/getting-started.md`](../../../docs/guide/getting-started.md) — install and first build.
- [`docs/guide/writing-a-spec.md`](../../../docs/guide/writing-a-spec.md) — the declaration, section by section.
- [`docs/guide/generated-tree.md`](../../../docs/guide/generated-tree.md) — what lands where, and why.
- [`docs/guide/delivery.md`](../../../docs/guide/delivery.md) — overlays, fleet, promotion, approvals.
- [`docs/reference/spec.md`](../../../docs/reference/spec.md) — every key, generated from the schema.
- [`docs/reference/cli.md`](../../../docs/reference/cli.md) — every command and flag, generated from the CLI.
- [`examples/scenarios/`](../../../examples/scenarios/) — worked scenarios across both market segments.
- [`docs/features.md`](../../../docs/features.md) — what ships, generated from the registry.
