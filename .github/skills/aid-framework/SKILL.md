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
| Evaluating the framework | `npx @aid-framework/cli init my-app --template support-copilot --gen` | [1](#1-try-it-without-cloning) |
| Starting a greenfield service | `aid init <dir> --template <name>` | [2](#2-start-a-new-service) |
| Bringing an existing spec | `aid init <dir> --from <spec>` | [3](#3-adopt-an-existing-spec) |
| Needing a TypeScript/Next.js service | `--target ts-vercel` | [4](#4-compile-the-typescript-target) |
| Serving it locally | `aid dev` | [5](#5-run-it-locally) |
| Seeing what a spec declares | `aid visualize` | [11](#11-see-what-the-spec-declares) |
| Delivering to many customers | `overridable`, `customers/`, `aid fleet` | [6](#6-deliver-one-spec-to-many-customers) |
| Passing an enterprise review | `profile: enterprise`, `aid review` | [7](#7-meet-an-enterprise-review) |
| Improving a live agent | `aid trace export`, `aid eval --compare` | [8](#8-improve-an-agent-without-auto-deploying) |
| Shipping infrastructure | `aid infra gen` | [9](#9-derive-the-infrastructure) |
| Owning a generated file | `aid eject` | [10](#10-take-ownership-of-a-generated-file) |
| Debugging a refusal | diagnostic code + hint | [Reading a refusal](#reading-a-refusal) |

## 1. Try it without cloning

The CLI is published. Node.js 24 or newer, no repository checkout:

```bash
npx @aid-framework/cli init my-app --template support-copilot --gen
cd my-app
npx @aid-framework/cli validate
```

`init` writes `app/app.spec.yaml`, a README, and the template's own scaffolding (its `customers/`
overlay, and for `enterprise-approvals` a `app/business/principal.py` stub). With `--gen` it also
compiles, which adds the generated tree, the dependency manifests and the two CI workflows; `--gen`
compiles immediately, so a contradiction in the spec is refused before you have read anything.

Without `--template` the starter spec declares a project name and a target and nothing else. It
validates clean, because there is no construct to refuse, and it serves nothing, because it declares
no pipeline. Use a template when you want to watch a gate do its job.

Three things `aid gen` scaffolds for you and one it does not, and the one it does not is a named
refusal rather than a silent failure. The dependency manifests are generated: `pyproject.toml` and
`requirements.txt` for `py-fastapi`, `package.json` and `tsconfig.json` for `ts-vercel`, carrying
the AID runtime pinned alongside the linters and test tools. They are written once and are yours
afterwards — `aid gen` will not rewrite a file you have since edited, and `gen --check` does not
diff them — so adding a dependency is an ordinary edit that the next `gen` leaves alone. The
generated CI probes for `package.json` (`ts-vercel`) or `pyproject.toml` (`py-fastapi`) and *skips*
its lint/build/test job when neither exists; with the scaffold in place that job really runs, which
is why the emitted code is held to ruff and `tsc --noEmit`. The packaging path reads the same file:
`aid package` stages from `pyproject.toml` and `README.md` at the project root, and refuses with
`cli/package-stage-missing` when they are absent, so deleting the scaffold is what breaks a
package build. The entry point is yours, because only the application knows what to mount:

```python
# app/main.py - routing names come from app/generated/routes/__init__.py
from fastapi import FastAPI

from app.generated.routes.answer_message import answer_message_router

app = FastAPI(title="support-copilot")
app.include_router(answer_message_router)
```

and the install reads the scaffold rather than a hand-typed list. `dev` tries `python3`, then
`python`, then `uv` from `PATH`:

```bash
pip install -e ".[dev]"      # or: uv sync
npx @aid-framework/cli dev
```

The entry point is the one thing still missing, and no entry point is `cli/dev-entry-missing` at
`app/main.py`. An interpreter that cannot import both `aid_runtime` and `uvicorn` is
`cli/dev-uvicorn-missing`, which means the install above did not reach the interpreter `dev` picked.
Serving without `dev` works too: `uvicorn app.main:app --reload` with that same install.

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

Both emit routers and no application. Neither tree has an `app/main.py`: the entry point is yours to
write (see [1](#1-try-it-without-cloning)), and `aid dev` names the file it cannot find rather than
inventing one. Both do get a dependency manifest, so `pip install -e ".[dev]"` (or `uv sync`) is
enough to run the tests the generator wrote.

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

It needs an `app/main.py` to serve and an interpreter that can import `aid_runtime` and `uvicorn`; it
refuses with a code naming whichever is missing rather than starting a server that answers nothing.

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
  state.signingKeyEnv:
    from: [AID_CHECKPOINT_KEY, ACME_CHECKPOINT_KEY]
  state.urlEnv:
    from: [AID_STATE_DB, ACME_STATE_DB]
  agents.triage_agent.maxCostBudget:
    max: 0.05
  evals.reply_quality.gate.maxRegression:
    max: 0.1
```

A customer overlay names the base and changes nothing else. Any path outside the block is refused
with `overlay/path-not-overridable`, so the block is the whole of what a customer may move.

```bash
npx @aid-framework/cli resolve customers/acme-eu.yaml --check
npx @aid-framework/cli fleet customers
```

`resolve` prints the concrete spec an overlay means — the reviewed artifact, one per customer.
`--check` fails when the committed resolved spec has drifted from its overlay, so review happens on
the diff rather than on trust. `fleet` reports every customer's profile, pins, ceilings and gate
status in one table, and is safe to run in CI because it reads files and nothing else.

The `state.*` entries are the ones that earn their keep across a fleet, where the base declares
checkpoint state at all. A signing key and a state store are named in the spec by *environment
variable*, never by value, so opening those paths lets one base serve many customers while each
deployment names its own key and its own database. The value still lives in the environment; the
overlay moves only the name.

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
| Private network placement (`network.ingress: internal`) | `ir/profile-network` |
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
      ingress: internal
      allowFrom: [10.0.0.0/8]
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

The network controls have a second limit that is worth saying out loud. `network.ingress: internal`
and `network.egress: declared-only` are generated from spec 0.37 and 0.38 respectively, but what they
generate differs by target and by what the provider can express:

- A `container` deployment gets security-group rules. A group can *allow a set*, so `declared-only`
  admits DNS, HTTPS and the private ranges the workload lives in. It cannot say "everything except".
- A `kubernetes` deployment gets a `NetworkPolicy`, which *can* subtract: the internet rule carries
  `except: 169.254.0.0/16`, so the instance metadata endpoint is excluded by name.
- A `serverless` deployment accepts `declared-only` for the same reason a `container` one does, and
  the function is attached to the VPC you name behind its own restricted security group. Its
  `ingress`, however, is still refused: a function behind an HTTP API is reached by the internet.
  Egress bounds what it calls; nothing bounds who calls it. That asymmetry is also why the profile
  gate retargets an enterprise `serverless` deployment at `container` instead of telling it to
  declare a placement it can never have.
- A `NetworkPolicy` object is not enforcement. Calico, Cilium and Antrea implement the policy API;
  flannel alone accepts the object and blocks nothing. The generated chart says so in the template
  header and its README, and no build can observe which CNI your cluster runs.
- `egress: declared-only` on `edge` or `batch` is refused with `ir/network-egress-unsupported`.
  Targets that emit no workload egress rule do not get a declaration that looks like a control. The
  cloud is refused separately, at `infra gen` (`cli/infra-cloud-egress-unsupported`), because the IR
  gate cannot see `cloud` — a `serverless` deployment pinned to GCP gets no egress rule from the
  Cloud Run path, and a refusal written in the IR would be guessing at a value the overlay sets.

The one identity control the build *does* generate is the token check, and only when you ask for it by
name. `verifiedBy` has two meanings, and the difference is the whole point:

```yaml
identity:
  kind: oidc
  issuer: https://login.example.com
  audience: aid-claims
  verifiedBy: aid              # reserved literal: AID generates the verifier
  jwksUri: https://login.example.com/.well-known/jwks.json
  subjectClaim: sub
```

- `verifiedBy: <component>` is a *name*. It says your gateway or sidecar checks the token. AID
  generates nothing and cannot confirm the component does what the name suggests. This is the
  declared form and it is unchanged since spec 0.33.
- `verifiedBy: aid` is reserved from spec **0.35**. It makes the generated `current_principal`
  dependency call a `JwksVerifier` over the declared `jwksUri`, using the OIDC asymmetric algorithms
  only, with `iss`/`aud`/`exp` checked and a fail-closed `401`. `ir/identity-keys` refuses the literal
  without `jwksUri`, so the build cannot emit a verifier with nothing to check against.

It checks a bearer token's signature and claims. It does not prove the issuer is the one you meant —
the verifier trusts the `jwksUri` you declared — and SAML stays declared-only, because only the OIDC
key set is fetched. Say "the build generates the token check" when it does, and never more than that.

Print the split rather than restating it, so the reviewer gets a list and not a claim:

```bash
npx @aid-framework/cli review
```

`review` re-uses the `validate` pipeline and adds no gate of its own: it prints one line for what
the build proved and then every declaration it accepted without being able to check -- issuer,
audit sink and retention, region pin, placement and egress rule, approvers and the count required,
secret names -- each with the path that declared it. A spec the build refuses is refused here too,
because a pack for a spec that does not build would itemise controls the build never reached. It
reads files and nothing else, so it belongs in the review artifact your CI job uploads.

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
npx @aid-framework/cli infra gen --iac helm
npx @aid-framework/cli infra plan --env dev
```

`infra gen` derives OpenTofu or CDK wiring from the spec; `infra plan` and `infra apply` drive the
backend. `--cloud aws|gcp|azure` and `--iac tofu|cdk|helm` select the module set, and
`--confirm-prod` is required before an apply can touch production.

`azure` is served through the chart and nothing else: AID emits no Azure compute module, so an
Azure deployment sets `target: kubernetes`, pins `cloud: azure` and a region for the registry and
the `azure-monitor` audit sink, and installs the emitted chart on AKS. `--iac helm` is the backend
for `target: kubernetes` on any cloud; asking for `tofu` or `cdk` there is refused
(`cli/infra-kubernetes-backend-required`) because neither emits a chart. The chart ships no cluster,
ingress controller or certificate, and `readOnlyRootFilesystem` defaults off until you have run your
app against one.

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

## 11. See what the spec declares

```bash
npx @aid-framework/cli visualize                       # serve app/app.spec.yaml on 127.0.0.1:4321
npx @aid-framework/cli visualize --port 4400
npx @aid-framework/cli visualize --json                # print the graph, bind nothing
```

The first layer is the architecture - what the service is when it runs, in five fixed columns:
triggers (entry), declared identity plus the runtime gateway (identity), one box per deployment
(compute), the stores, knowledge bases and run state a pipeline actually reaches (data), and the
model providers, MCP servers, audit sinks and OTel collector they call (external). Edges are the
declared relationships only: `serves` (a trigger to each deployment that runs it), `connects` (a box
to what it calls), `records` (an audit sink, with its retention). A secret is a name on the
deployment, not a box, because the spec never names the store.

Below it sit the other two layers. The process layer is one lane per pipeline, its steps left to
right in the order the list declares them, the arms of a branch stacked under the step that chooses
between them, and a header naming the deployments that serve the pipeline - or saying that none
does. The inventory layer is one column per construct group - document, contract, service, agents,
prompts, models, tools, retrieval, guardrails, evals, infra - one node per declaration and one edge
per reference the document actually makes: a prompt to its model, an agent step to the tool it
names, a pipeline to the agents it calls. A reference to something the spec never declared has no
node to land on, which is what the picture is for. Run order is drawn only where the declaration
states it (list adjacency, arm membership), never inferred from which node happens to sit where.

Selecting a box opens its detail: the facts the declaration states, what it stands for in the
inventory, and - for a deployment, trigger, store, model or tool - the request path that reaches it,
step by step, with the guardrail stage, redaction, approval, retrieval and fan-out facts declared at
that point. A compute box carries the pipelines it serves by the same rule that draws its `serves`
arrow, so anything that runs a request opens onto that request. Selecting a flow row switches to the
process layer with that step drawn.

The page comes out of the CLI binary: no hosted backend, no CDN, no install. `1`-`4` switch layer
(Architecture, Process, Inventory, everything), `f` or `0` refits, `Escape` clears, drag pans, wheel
zooms, and a legend row hides that edge kind. A spec that a gate refuses renders the diagnostics
with their codes, paths and hints instead of a graph - the picture and the build read the same
document, so a picture of a spec that does not build would be misleading.

Layers are shown one at a time, so an arrow that leaves the layer you are looking at has nowhere to
land - the box at its far end is not drawn. The page drops that arrow in the single-layer views and
draws every one of them under `everything`, where both ends are present. Nothing is lost with the
arrow: the selected box lists every reference it takes part in, by kind and direction, and a chip on
it switches to the layer the other end lives in.

A spec you have not checked out can be drawn without installing anything: the documentation site's
[Visualize](https://aid-framework.github.io/aid-framework/visualize) page takes a pasted spec or an
uploaded file and compiles it in the browser through that same read, lower and gate path. Nothing is
sent anywhere, so the graph on the page is the graph the build would produce, refusals included.

`--json` emits the same graph, layout and request paths the page fetches, so a scene can be
asserted in CI. Treat this as a view of the declaration, not of a running service: it draws what the
spec says, which is exactly what the gates judge.

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
language, so fix that before an IR gate can say anything useful. A capability refusal means the
build cannot honour the construct: `ir/target-unknown` for a target no capability declaration covers,
`ir/capability-unknown` for a capability name outside the vocabulary, and `ir/capability-missing`
when the target is real but does not declare what the IR requires. Pick another target or drop the
construct — the framework will not emit a stub for it. Everything else is an `ir/*` gate: the spec
parsed, the target can express it, and the build is refusing on policy.

## What is gated, and what is only declared

Keep these apart in anything you write or tell a user:

- **Gated.** Spec version support, target capabilities, region and cloud consistency, audit sink
  validity, enterprise delivery controls, guardrail presence and stages, agent bounds, eval coverage
  and regression ceilings, cost profiles for every priced model, deploy plan validity, and the shape
  of a generated verifier (`verifiedBy: aid` needs `jwksUri`, an OIDC issuer, and one verifier per app).
- **Declared, not verified.** Identity issuers and their key sets, network peering, reviewer
  identities, and secret values. The build refuses a spec that omits them; it cannot confirm they
  exist. The generated verifier (`verifiedBy: aid`) narrows this to the token itself: it checks the
  signature and the claims against the `jwksUri` you declared, so it proves the token was signed by
  *that* key set — not that the key set belongs to the issuer you had in mind.
- **Generated but not yet protected.** An agent that can pause gets a `POST /agents/resume` route
  alongside `POST /agents/{agent_id}/run`, and the checkpoint it accepts replays the conversation and
  the pending tool calls, so whoever holds it can continue that run. The checkpoint itself is
  defended: it is signed with the key `state.signingKeyEnv` names, it expires after
  `checkpointTtlMinutes`, and it is claimed once in the declared store — an edited checkpoint and a
  spent one are answered by the same opaque 403, with the reason written to the operator log rather
  than returned. What no generated code proves is that the *caller* may submit it. Put the route
  behind your own authorizer before exposing it outside a trusted network.
  A spec that declares a `state` block gets a second route beside it,
  `POST /agents/runs/{run_id}/resume`, and the pause is written to that store rather than only handed
  back — so the run survives the request, the replica and the restart, and the `run_id` the response
  reports is what names it. Naming the run in the path is the point: the body carries the decision
  and nothing else, so a caller cannot pair one run's id with another run's checkpoint, and an id
  that never existed and one already spent are answered by the same opaque 403. That route does not
  close the gap above — it proves the app issued that run, not that this caller may continue it.
  Two declarations decide how much of that holds. With no `state` block there is no store at all, so
  a spent checkpoint is refused only in the worker that issued it: `enterprise` refuses that spec and
  `standard` warns with `ir/resume-replay-weak`. And because the signer is built per request, a
  declared-but-unset signing key is not a startup failure — it refuses every resume instead.
- **Not generated.** Retrieval migrations are emitted for an operator to apply (`aid migrate`).
  Managed knowledge base re-ingestion is a request to the engine that owns it (`aid kb`). Neither
  runs on its own.

Anything else you are tempted to claim: check `docs/features.md`, which is generated from the
registry, and the CLI reference at `docs/reference/cli.md`. For one concrete spec, `aid review`
prints this split as two lists -- what the build proved, and what it only accepted as declared. For which claims are backed by an app
that actually boots — and which jobs do the booting — read
[`docs/guide/boundary.md`](../../../docs/guide/boundary.md); the end-to-end job boots the two
examples, not every tree `init` can emit.

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
  pyproject.toml           # the generator once, then you: the dependencies and tool config
  requirements.txt         # the same, for a plain `pip install -r`
  tests/                   # the generator once: a smoke test `pytest` can fail on
  customers/               # you: one overlay per customer
  infra/                   # the generator: appears after `aid infra gen`
```

With `--target ts-vercel` the first three root entries are `package.json`, `tsconfig.json` and
`app/`. The scaffold is written once and never diffed, so a dependency you add survives the next
`aid gen` - only `app/generated/` is regenerated.

If a generated file must change, change the spec and re-run `aid gen`. If the spec cannot express it,
`aid eject` and own the file.

## Where to read more

- [`docs/guide/getting-started.md`](../../../docs/guide/getting-started.md) — install and first build.
- [`docs/guide/writing-a-spec.md`](../../../docs/guide/writing-a-spec.md) — the declaration, section by section.
- [`docs/guide/generated-tree.md`](../../../docs/guide/generated-tree.md) — what lands where, and why.
- [`docs/guide/delivery.md`](../../../docs/guide/delivery.md) — overlays, fleet, promotion, approvals.
- [`docs/guide/boundary.md`](../../../docs/guide/boundary.md) — what the build refuses, and what it only declares.
- [`docs/reference/spec.md`](../../../docs/reference/spec.md) — every key, generated from the schema.
- [`docs/reference/cli.md`](../../../docs/reference/cli.md) — every command and flag, generated from the CLI.
- [`examples/scenarios/`](../../../examples/scenarios/) — worked scenarios across both market segments. `warranty-claims` is the full-width one to read once a spec starts to grow.
- [`docs/features.md`](../../../docs/features.md) — what ships, generated from the registry.
