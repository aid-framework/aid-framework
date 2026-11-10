# RFC 0001 — Agents at scale: delivering AID services to many customers

| Field | Value |
| --- | --- |
| Status | **Draft — awaiting review** |
| Author | Agent-assisted audit, 2026 |
| Phase | 0 (audit + design). No feature code in this RFC. |
| Affects | `spec` 0.19 → 0.23, `ir` 0.2.0 → 0.6.0, `cli`, both generators, `runtimes/python`, `runtimes/typescript` |
| Supersedes | nothing |

> **Nothing in this document is built.** Every construct, gate and command below is a
> proposal. Where a section describes something that already exists, it cites the file that
> proves it. Where it describes something proposed, it says so. This distinction is the whole
> point of Principle 4 in the brief, and it is the reason the audit came before the design.

---

## 0. Summary of findings

**The brief's assumption about agent depth is wrong, in AID's favour.** The brief says "today
agents/tools appears to be a single generated tool loop." It is not. AID already ships: an
agent step loop with a *required* `maxSteps`, token and cost budgets with a one-rung `degrade`
escape hatch, handoffs *and* delegated sub-agents with cycle detection, human-in-the-loop pause
and resume, four memory tiers, guardrail escalation that can block a run, and a configurable
engine seam (`native` / `deepagents`). Six gates cover that surface alone. Capability area B is
therefore *much* narrower than the brief assumes — it needs a state store and step-level
approval, not a loop.

**The largest genuine gap is F, then E.** Nothing exists for multi-customer repeatability (no
overlay, no template, no fleet view) and nothing exists for gated self-improvement (no trace →
dataset export, no candidate comparison, no promotion gate). Observability (D) is half-built in
an interesting way: the runtime already emits OpenTelemetry GenAI spans, but nothing installs a
provider, so it is a no-op by default; there are no dashboards and no fleet aggregation.
Harness (C) is strong on single-turn evals and honest about its own limits — `tool-trace`,
`cost` and `latency` metrics are *declarable and refused at generation* with a stated reason,
which is exactly the honesty pattern a trajectory-eval phase should replace.

**The single smallest first increment is `profile`.** One top-level enum key, three enterprise
controls that reuse constructs the spec already has or that need only a scalar, one scalar to give
the customer's own cloud a home in the spec (so a region can be checked against the right region
set), five gates, two goldens, one walkthrough. It needs no runtime change and no new CLI verb, it
bumps `specVersion` to `0.19` additively (absent `profile` means `standard`, and a spec with no
`cloud` keeps consulting `--cloud`, so no existing spec changes meaning), and it establishes the
*shape* the following four phases hang off.

### 0.1 Where the brief contradicts the repository

| Brief assumption | Reality | Evidence |
| --- | --- | --- |
| "agents/tools appears to be a single generated tool loop" | Agent loop with budgets, handoffs, delegation, HITL pause/resume, memory, engines, guardrail escalation | `runtimes/python/src/aid_runtime/agents/loop.py`, `state.py`, `engine.py`, `policy.py` |
| "Design step-level human approval (pause/resume)" as a gap | Run-level and tool-level approval exist; `/agents/resume` exists; pipeline *step* approval does not | `packages/ir/src/gates/hitl.ts`, `aid.guardrail`/`aid.hitl` span attributes in `tracing.py` |
| "Design bounded autonomy (max steps, max cost, allowed tools)" | All three exist: `maxSteps` is **required**, `maxTokensBudget`/`maxCostBudget` gated, agent `tools` is an allowlist | `packages/ir/src/gates/agents.ts` |
| "Design retries/timeouts/idempotency" | Already in the spec: `tools[].timeoutMs`, `retries`, `idempotency` | `docs/reference/spec.md` tool section |
| "Standardize traces on OpenTelemetry export (opt-in)" | OTel **API** already used with GenAI semconv; no provider/exporter is ever installed, and no spec key selects one | `runtimes/python/src/aid_runtime/tracing.py` |
| "Evaluate whether additional cloud/target support (e.g. Azure, Kubernetes) belongs here" | Out of scope for this RFC. Adding a cloud is a capability-matrix problem with its own phase; profiles should not smuggle it in | `CLOUD_TARGETS` in `packages/ir/src/shapes.ts` (`aws`, `gcp` only) |
| "five capability areas below" | The brief lists **six** (A–F). This RFC covers all six | — |

### 0.2 Verified current state (the numbers this RFC holds itself to)

| Fact | Value | Source of truth |
| --- | --- | --- |
| Spec language version | `0.18` | `packages/spec/src/schema/spec.schema.json` |
| IR version | `0.1.0` | `packages/ir/src/build.ts` |
| Build-time gates | **17** | `packages/ir/src/gates/index.ts` (`GATES`) |
| Diagnostic codes | **70** under `ir/`, plus `spec/` and `cli/` namespaces | `packages/ir/src/diagnostics.ts` |
| CLI commands | **13** (`init`, `validate`, `gen`, `dev`, `guard`, `migrate`, `ingest`, `eval`, `cost`, `trace`, `doctor`, `eject`, `infra`) | `packages/cli/src/main.ts` (`COMMANDS`) |
| Conformance corpus | 77 cases over 41 operations, both runtimes | `conformance/corpus.json` |
| Deployment targets | `aws` → batch/container/edge/serverless; `gcp` → batch/container/serverless | `CLOUD_TARGETS`, `packages/ir/src/gates/deploy.ts` |
| Eval metric kinds | 10 declarable; **7 measured**, 3 refused with a reason (`tool-trace`, `cost`, `latency`) | `packages/generators/py-fastapi/src/metrics.ts` |
| Observability | IR-only (`DEFAULT_OBSERVABILITY = { trace: true, redact: [] }`); **no spec section**, no tracer provider installed | `packages/ir/src/shapes.ts`, `runtimes/python/src/aid_runtime/tracing.py` |
| Profiles / overlays / regions / dashboards / promotion | **none of these exist** | repo-wide search |

---

## 1. Method

I read, rather than trusted: the closed JSON Schema and its version history; the IR shapes and
the builder; all 17 gate implementations and the diagnostic table; the CLI command table and the
`init`/`eval`/`trace`/`cost` commands; both generators' plan/validate/emit layers; the Python
runtime's agent, eval, guardrail, retrieval and tracing modules; `docs/features.md`,
`docs/reference/spec.md`, `docs/reference/cli.md`, `docs/reference/support.md`,
`docs/design.md`; and the site scripts that *generate* the support and features pages from
source (`site/scripts/support-data.mjs`, `features-data.mjs`) so that I could see what the docs
are mechanically prevented from claiming.

That last item matters for every phase in this RFC: the honesty requirement in the brief is not
a discipline the authors remember, it is a build step. `support-data.mjs` parses
`SERVED_PROVIDERS`, `CLOUD_TARGETS`, the schema's `specVersion` enum, the diagnostic code tables
and the generator manifests out of source, so a support claim cannot be written that the
compiler does not back. `scripts/docs-claims.mjs` refuses a doc that names a command the CLI does
not have, a target that is not registered, a flag a command does not accept, or a capability a
target does not declare. **Every proposal below therefore has to arrive with its data-source
change, or its own documentation is unbuildable.** That constraint is a feature; it is also why
the phase plan is small-increment-first.

---

## 2. Non-negotiable principles, applied

The brief sets six. Each proposal in this RFC is checked against them, and where a proposal
*strains* one, the strain is named rather than hidden.

1. **Gates are the product.** Every capability below lands with a named diagnostic that refuses
   an impossible or unsafe *configuration*, not just an unsafe spec. The commercial argument for
   AID is that a platform team can hand the tool to twenty application teams and the tool will
   refuse the twentieth team's mistake at build time.
2. **No hosted control plane, no request proxy, no runtime lock-in.** Every fleet feature is
   files + CLI + CI. `aid fleet` reads a directory and prints a table; it has no server. The
   improvement loop's state is git. Traces are files until an operator points an OTel exporter
   at their own backend.
3. **Ownership boundary.** New generated artifacts are split the usual way: plumbing in
   `app/generated/`, anything a customer should ever want to change in `app/business/`, and
   `aid eject` flips any of them.
4. **Honesty about maturity.** §10 lists what is *specified but not built*, per phase. The
   features page gains a `since` for everything shipped, and proposed-but-unshipped constructs do
   not appear in the spec at all. A construct exists in the schema only when a gate or a generator
   honours it — which is why §4.3 gives run state its own `state` key instead of reusing `stores`.
5. **Reproducible output.** Every phase adds byte-asserted fixtures and updates
   `test/golden.test.ts` / `digests.json`. Profile resolution is a pure function of
   `(spec, overlay)`, so the resolved spec is itself a golden.
6. **Versioned language.** `profile` is additive but still bumps `specVersion` to `0.19`, because
   the schema is closed: a `0.18` spec that writes `profile` must be told it needs `0.19` by
   `spec/not-supported`, not silently accepted. No phase renames or removes a key, but two phases
   change what an existing construct *admits* — 0.21 widens `evals.*.target` from `pipeline:` only,
   and 0.19 adds `deployments[].cloud` where `--cloud` already existed — so both carry a migration
   note in §7 even though neither invalidates an existing spec.

---

## 3. Gap analysis, A–F

### A. Tier profiles

**Exists:** nothing. `profile`/`tier` appears nowhere. What exists is a set of *individual*
controls that a profile could bundle: `deployments[].secrets`, `guardrails[]`, budgets,
`deployments[].target`, and region only inside `deployments[].image` as a registry host
component. Nor is there a home for `cloud`: the choice between `aws` and `gcp` is a CLI flag
(`aid infra --cloud`, defaulting to `aws`), so the customer's own cloud is not recorded in the
artifact that gets reviewed. A profile cannot require a customer's cloud be honoured while the
spec has nowhere to say what it is.

**Missing, and it is the important part:** there is no way to say "this service is for an
enterprise customer, and therefore it is *not allowed* to be built without an audit trail." Every
current gate answers "is this spec internally consistent?" None answers "is this spec acceptable
*for this class of customer*?" That is the gap, and it is a gate gap, not a feature gap.

**Design decision — spec key, not overlay file.** Three options were considered:

| Option | Rejected because |
| --- | --- |
| `profile` only in an overlay file (F) | The resolved spec would then be the only artifact with the profile, and every tool that reads a spec — `validate`, `eval`, `doctor`, conformance fixtures, the features page — would need overlay awareness. The profile is a property of the *deployment*, and a spec is the unit we validate. |
| `profile` per deployment | A project that is enterprise-grade is enterprise-grade everywhere; splitting it invites a spec where one deployment is audited and its sibling is not, with no way to state the intent. |
| **Top-level `profile` (chosen)** | One place to read, one place to gate, and overlays (F) set it per customer. |

**Profile requirement sets grow by version.** This is the honest-increment mechanism. An
enterprise profile at `0.19` requires exactly the three controls `0.19` can enforce (region, audit
sink, input+output guardrails). `0.20` adds identity and private networking to the same
requirement list; `0.21` adds production approval policy. At no point does the gate require a
construct the schema cannot express — which would be a gate nobody can pass.

### B. Workflow and agent depth

**Exists (more than the brief assumes):** required `maxSteps`; `maxTokensBudget`/`maxCostBudget`
enforced in the runtime ledger; `onBudgetExhausted: degrade` stepping exactly one rung down a
declared alias ladder, recorded as `degraded_from`; `handoffs` and `delegates` with cycle
detection (`ir/agents-handoff-cycle`); HITL pause/resume with `PendingApproval`, `HumanDecision`,
`AgentCheckpoint` carrying completed steps across the pause; per-agent `tools` allowlist;
`tools[].timeoutMs`/`retries`/`idempotency`; memory tiers; `engine: native|deepagents`.

**Genuinely missing:**

1. **Durable run state.** `AgentCheckpoint` is a *value* the caller carries. There is no
   server-side store, so a run that pauses cannot survive a pod restart, and a run longer than a
   request cannot resume at all. Enterprise customers ask for exactly this ("a claim decision may
   take three days and two approvals").
2. **Pipeline-step approval.** Approval exists for *agent tool calls*. A pipeline that calls a
   write tool as a plain step has no pause point. Enterprise change control wants "approve before
   refund is issued," which is a pipeline concern.
3. **Bounded autonomy per run.** Budgets are per *agent invocation*. There is no ceiling on a
   whole *run* across steps, delegations and retries, so a delegation loop can multiply a
   per-agent budget.

**Design decision — keep tool bodies in `business/`.** Every proposal here generates plumbing,
typed contracts and policy hooks only. The approval *record* is generated; the approver *check*
is a `business/` function. The state store is a generated interface with a SQLite default and a
`business/` override, not a generated database.

### C. Harness: evals, guardrails, cost

**Exists:** 10 metric kinds, 7 measured; `gate.ci`, `gate.maxRegression`, `gate.samples`,
`gate.minMean`; baseline recording (`aid eval --baseline`); the eval-coverage gate warning on an
uncovered HTTP pipeline and on retrievers with no retrieval metric; four guardrail stages
(`input`, `output`, `retrieval`, `tool-call`) with four actions and a documented tie-break
(`block` outranks declaration order); a red-team corpus with a meta-test that empties every
detector and asserts zero recall, so the suite cannot pass vacuously; model pricing catalog and
`ir/cost-profile-unknown`.

**Missing:**

1. **Trajectory metrics.** `tool-trace`, `cost` and `latency` are declarable and *refused at
   generation* with a reason. So multi-step agent behaviour — "did it call the right tools, in
   order, within N steps, at what cost" — is not measurable today. For agents at scale this is
   the single most valuable harness gap, because single-turn exact-match says nothing about a
   five-step run.
2. **Per-agent eval coverage.** Coverage is checked per *pipeline*. An agent declared and reached
   by a pipeline can carry no eval of its own and nothing complains.
3. **Fallback pricing.** An agent may name a cheaper fallback alias; the cost gate refuses an
   *unpriced model* when a budget is declared, but a fallback alias that resolves to an unpriced
   model is not specifically refused — and it is the model that only ever runs when money is
   already a problem.

### D. Observability at fleet level

**Exists:** GenAI-semconv span attributes for model calls, token counts, cost, guardrail events,
HITL events and agent steps (`gen_ai.*` plus an `aid.*` namespace in
`runtimes/python/src/aid_runtime/tracing.py`); a local JSONL sink (`local_trace.py`,
`local-trace.ts`); `aid trace` and `aid cost` reading that sink; redaction enforced by a gate
(`ir/security-redaction-incomplete`).

**Missing:** a spec section at all — `observability` exists only in the IR
(`DEFAULT_OBSERVABILITY`), so nothing in a spec can currently express trace intent or redaction
(it arrives as an IR default). And a tracer *provider*: the API is used correctly and produces
spans that go nowhere, so in a real deployment there is no export at all — this is the widest gap
between "instrumented" and "observable." Also missing: any spec key selecting an exporter;
dashboards or alerts as code; and any aggregation across more than one project directory
(`aid cost` takes one `dir`).

**Design decision — opt-in, env-configured endpoint, never in the spec.** An exporter endpoint is
environment configuration (`OTEL_EXPORTER_OTLP_ENDPOINT`), not a spec value, because it differs
per customer environment and must not be needed to generate. The spec declares *intent* (`export:
otlp`), the environment supplies the *address*. This keeps Principle 2: AID never becomes the
backend.

### E. Self-improving loop

**Exists:** nothing end-to-end. The pieces that could be composed: `aid trace` reads runs;
`aid eval --baseline` stores a baseline; prompts carry an integer `version`; models are pinned by
id; `evals[].gate` can gate a regression.

**Missing:** the loop itself. No trace→dataset export, no `--compare baseline candidate`, no
promotion gate, no approval record for a promotion, no feedback-signal intake, and no PII rule for
feedback. This is the highest-value gap per unit of effort in the whole brief, because it is the
difference between "we build you an agent" and "we run you twenty agents that get better."

**Design decision — the loop is files and gates; promotion is a spec diff.** A candidate is a
branch whose spec differs in prompt text, model alias or tool config. `aid eval --compare` writes
a comparison report file. Promotion is a gate over that file. Nothing auto-deploys: the last step
is a human merging a PR, and under `enterprise` the merge requires a recorded approval.

### F. Multi-customer repeatability

**Exists:** nothing. Every customer today means a forked spec. `aid init` writes one starter spec
and accepts `--from <spec>`; there is no `--template` and no second template to offer.

**Missing:** the overlay mechanism, the "base marks a control overridable" concept, the templates,
and the fleet summary. This is the gap that actually blocks the brief's business goal: without
overlays, twenty customers is twenty divergent copies of a spec, and every gate improvement has to
be applied twenty times by hand.

**Design decision — overlay is a separate artifact with its own diagnostics namespace.** An
overlay is not a spec; it is a *delta* applied to a base spec. Resolving it produces a spec. So
its failures are not `ir/` failures (the IR is fine — it is the wrong IR), and they get an
`overlay/` namespace. The strict rule: an overlay may only touch paths the base declares
`overridable`, and may never *weaken* a control (lower a budget, drop an eval, downgrade a
guardrail action, widen a tool allowlist) unless the base explicitly permits that weakening at
that path.

---

## 4. Proposed spec additions

All examples assume `specVersion: "0.19"` unless stated. Only new keys are annotated; anything
unannotated already exists.

### 4.1 `profile` (0.19) — capability A

```yaml
specVersion: "0.19"
profile: enterprise          # NEW. standard | enterprise. Absent means standard.

project:
  name: claims-triage

deployments:                     # a map keyed by deployment name, like every section
  prod:
    target: serverless
    secrets: [OPENAI_API_KEY]    # required today; these are names, never values
    cloud: aws                   # NEW (0.19). aws | gcp.
    region: eu-central-1         # NEW (0.19). Placement and residency pin.
    audit:                       # NEW (0.19). Where the audit record lands.
      sink: cloudwatch           # cloudwatch | s3 | gcs | bigquery
      retentionDays: 365
```

`region` is deliberately a deployment scalar and not a project one: region is a property of
placement, and one project may legitimately place `prod` in `eu-central-1` and `dev` in
`us-east-1`. `region` is validated against `CLOUD_TARGETS` so `region: eu-central-1` on a `gcp`
deployment is a build error naming the valid set, not a module that fails at apply time.

`cloud` has no home in the spec today: the only way to choose it is `aid infra --cloud`, which is a
CLI flag that defaults to `aws` (design §11). That is wrong for bring-your-own-cloud, where the cloud
is a property of the *customer's* deployment and belongs in review, not in whoever's shell ran the
apply. The precedence rule keeps existing specs byte-identical:

- spec declares no `cloud` → `--cloud`, or `aws` when absent. Exactly today's behaviour.
- spec declares `cloud` → the spec wins, and a conflicting `--cloud` is refused with
  `ir/cloud-conflict` rather than silently ignored. Passing `--cloud` that agrees is not an error.

### 4.2 Enterprise identity, network, approval (0.20) — capability A, continued

```yaml
specVersion: "0.20"
profile: enterprise

deployments:
  prod:
    target: container
    secrets: [OPENAI_API_KEY, DATABASE_URL]
    cloud: aws
    region: eu-central-1
    identity:                      # NEW (0.20). Reference, never a secret.
      kind: oidc                   # oidc | saml
      issuer: https://login.example.com
      audience: aid-claims
    network:                       # NEW (0.20). Private placement.
      private: true
      egress: declared-only        # declared-only | open
    approvals:                     # NEW (0.20). Change control, not runtime HITL.
      require: [security, platform]
      minApprovers: 2
      environments: [prod]
```

`identity.issuer` is an issuer URL, and `secrets` entries remain *names* of secrets — no credential
value can enter the spec, and a literal-looking value keeps failing `ir/security-store-secret`-style
checks. The same rule governs `network` and `approvals`: they are references to things the customer
already runs (an IdP, a VPC, a code-review policy), never material AID would provision behind their
back. Nothing here creates a control plane — `identity` compiles into the generated app's token
validation, and `approvals` compiles into a required-reviewers rule in the generated CI.

### 4.3 Durable runs and step approval (0.20) — capability B

```yaml
specVersion: "0.20"

agents:
  claims_adjudicator:
    name: Claims adjudicator
    instructions: claims_prompt     # a prompt id, as today
    model: reasoning
    tools: [lookup_policy, issue_refund]
    maxSteps: 12                    # already required today
    maxCostBudget: 2.50
    state:                          # NEW (0.20). Durable run state.
      kind: postgres                # postgres | sqlite
      urlEnv: DATABASE_URL          # a name, not a value
      ttlHours: 168
    humanInTheLoop:
      when: "true"
      channel: approval-queue

pipelines:
  refund:
    trigger:
      http: { method: post, path: /refunds }
    steps:
      - tool:
          tool: issue_refund
          input:
            claim: "{{ event.claim }}"
          as: receipt
          requiresApproval: true    # NEW (0.20). Pause before this write step.
```

`state` does **not** reuse `stores`, and the reason is a real constraint rather than taste: `stores`
is a vector store — `kind` is `memory | pgvector`, `dimensions` is required, and the normalize gate
compares that width against the embedding model's. Run state has no width and is not embedded, so
putting it there would either force a meaningless `dimensions` or break the invariant the normalize
gate enforces. `urlEnv` rather than a URL follows the existing `models.*.apiKeyEnv` precedent: the
spec names the environment variable, and the value stays in the platform.

`requiresApproval` generalises the existing tool-level `requiresConfirmation` from "ask the
caller in the moment" to "stop the run and wait for a recorded decision," which is what an
approval queue needs. The generated plumbing is the pause/resume route, the `Approval` typed
contract and the state-store interface; the *decision* is a `business/` function.

### 4.4 Trajectory metrics (0.21) — capability C

`tool-trace`, `cost` and `latency` already exist in the schema and are refused at generation.
`0.21` implements them in the runtime and moves the refusal from the generator to the gate layer
so the message is a gate diagnostic rather than a codegen error.

An eval's `target` is a single string today, and its pattern is `^pipeline:[a-z][a-z0-9_]{0,63}$` —
the schema says so in as many words: *"Only pipelines are evaluable in Phase 0."* There is no
`agent:` target to extend, so trajectory evals require widening that alternation rather than filling
in an existing slot. This is the one addition in the RFC that changes what an existing key means, so
it carries a version bump and a migration note even though no existing spec becomes invalid.

```yaml
evals:
  refund_trajectory:
    description: Whether the adjudicator calls the tools it should, in order, within budget.
    target: agent:claims_adjudicator   # NEW (0.21). Today the pattern admits pipeline: only.
    dataset:
      source: file
      uri: evals/refund_trajectory.jsonl
    metrics:
      - kind: tool-trace               # declarable today; refused at generation
        expect: [lookup_policy, issue_refund]
        ordered: true
      - kind: cost                     # declarable today; refused at generation
        max: 0.40                      # per-task cost ceiling, in the schema already
      - kind: latency                  # declarable today; refused at generation
        maxMs: 20000
    gate:
      ci: true
      maxRegression: 0.05
```

The metric keys are not new: `tool-trace` requires `expect` (with optional `ordered`), `cost` requires
`max`, and `latency` requires `maxMs`. All three are *already declarable and already refused at
generation*, so this phase adds no schema surface for them — it adds the runtime measurement and the
gate diagnostic, which is the smaller and more honest change.

### 4.5 OTel export intent (0.21) — capability D

`observability` is **not a spec section today**: it exists only in the IR
(`DEFAULT_OBSERVABILITY` in `packages/ir/src/shapes.ts`, always `{ trace: true, redact: [] }`).
So this phase *introduces* the spec section and carries `trace` and `redact` into it, rather than
adding a key to something already declarable.

```yaml
observability:                 # NEW section (0.21). Today only the IR has this shape.
  trace: true                  # carried from the IR default once the section exists
  redact: [email]
  export: otlp                 # NEW (0.21). otlp | none. Address comes from the environment.
```

### 4.6 Feedback and promotion (0.22) — capability E

```yaml
specVersion: "0.22"

observability:                 # the section introduced at 0.21
  trace: true
  feedback:                    # NEW (0.22). Declared signals, with PII rules.
    signals: [thumbs, correction, escalation-outcome]
    stateUrlEnv: DATABASE_URL  # a name, not a value
    pii:
      redact: [email, phone, national-id]
      retentionDays: 90

prompts:
  triage:
    version: 4                 # already required, and already a pinned identity
    model: fast                # prompt:<name>@<version>
    template: |
      Decide the claim and record the outcome.
    output:
      kind: text

evals:
  triage_regression:
    target: pipeline:answer_ticket
    dataset:
      source: file
      uri: evals/triage_regression.json
    metrics:
      - kind: exact
        field: category
    gate:
      ci: true
      maxRegression: 0.05
      promotion:               # NEW (0.22). Refuses a candidate that regresses.
        allowedQualityDrop: 0.01
        maxCostIncrease: 0.10
        requireApproval: true  # enterprise: always true
```

Pinning is **half-built already**, and the RFC is more useful for saying exactly which half.
`prompts.<name>.version` is required, and `normalize.ts` builds the node identity as
`promptIdentity(id, version)` — so the registry key exists and a prompt revision does not move the IR
node id. What is missing is the other half: **no gate compares the template text to the version**, so
a template can be edited with the version left at `4` and nothing refuses it. `0.22` adds
`ir/prompt-version-stale`, which hashes each template (the manifest already hashes generated files)
and refuses a changed hash at an unchanged version. That is the promotion gate applied to the
cheapest artifact in the spec, and it is the prerequisite for the eval-budget promotion below.

`feedback.stateUrlEnv` follows the same name-not-value rule as `state.urlEnv` above.

### 4.7 Overlays and templates (0.23) — capability F

Overlays are **not** part of the spec schema. They are a separate file type with their own schema and
their own diagnostics, so a bad overlay reads `overlay/...` and never pretends to be an IR failure.
The base spec gains exactly one key, though, and that is a deliberate exception worth stating rather
than hiding: `overridable`. A customer file can never add a key to a spec — that is what keeps the
compiled IR closed and what makes `aid validate` on the resolved spec meaningful — but the *base
author* declares the contract in the spec, because a base spec copied out of its contract file would
otherwise silently accept every override.

```yaml
# customers/acme.yaml — an overlay, not a spec
base: ../specs/support-copilot.yaml
customer: acme
profile: enterprise
overrides:
  project.name: acme-support
  deployments.prod.region: eu-central-1
  deployments.prod.audit.sink: cloudwatch
  models.fast.modelId: claude-haiku-4-5     # pinned per customer
  agents.triage_agent.maxCostBudget: 0.75   # may only move within the base's bound
```

```yaml
# in the base spec: the only paths an overlay may touch, and how far
overridable:                    # NEW (0.23). The one key this phase adds to the spec.
  project.name: true
  deployments.prod.region: true
  deployments.prod.audit.sink: true
  models.fast.modelId: { from: [claude-haiku-4-5, gpt-5-mini] }
  agents.triage_agent.maxCostBudget: { max: 1.00 }
```

A path not listed is not overridable. A listed path is overridable *within its declared bound*.
Weakening is a distinct, explicit permission (`allowWeaken: true`) that the base author writes
per path, so "the customer asked for a cheaper guardrail" is a visible diff in the base repo
rather than an edit buried in a customer file.

---

## 5. New gates and their exact diagnostics

House voice, matched to existing gates: `the <name> gate rejected "<id>": <what is wrong>` with a
`hint` that is the fix. Every message names the artifact and the field so a reader can find it.

### 0.19 — profile (5 codes)

| Code | Sev | Message | Hint |
| --- | --- | --- | --- |
| `ir/profile-region` | error | `the profile gate rejected "claims-triage": profile "enterprise" requires a region pin, and deployment "prod" declares none` | `add region to deployments.prod, or set profile: standard` |
| `ir/profile-audit` | error | `the profile gate rejected "claims-triage": profile "enterprise" requires an audit sink, and deployment "prod" declares none` | `add audit.sink to deployments.prod (s3, cloudwatch, gcs, bigquery)` |
| `ir/profile-guardrail` | error | `the profile gate rejected "claims-triage": profile "enterprise" requires an input and an output guardrail, and no declared guardrail has stages [output]` | `declare a guardrail with stages: [output]; a guardrail applies by stage, so one declaration covers every pipeline` |
| `ir/region-target` | error | `the profile gate rejected "prod": region "eu-central-1" is not a region for cloud "gcp"` | `gcp regions: europe-west1, us-central1, …` |
| `ir/cloud-conflict` | error | `the infra command rejected "claims-triage": deployment "prod" pins cloud "aws" and --cloud "gcp" was passed, so the generated modules would not match the spec` | `drop --cloud, which is only needed when the spec declares no cloud` |

`ir/cloud-conflict` is new because `cloud` moves into the spec in this phase while `aid infra --cloud`
already exists and defaults to `aws`. Two sources of truth for the same value is exactly the kind of
ambiguity this repo refuses rather than resolves silently.

Also: writing `profile` in a `0.18` spec yields the existing `spec/not-supported`, naming `0.19`
— the standard upgrade path, no new code.

### 0.20 — identity, network, approval, durable runs (5 codes)

| Code | Sev | Message | Hint |
| --- | --- | --- | --- |
| `ir/profile-identity` | error | `the profile gate rejected "claims-triage": profile "enterprise" requires a declared identity integration, and deployment "prod" declares none` | `add identity (kind oidc/saml plus issuer) to deployments.prod` |
| `ir/profile-network` | error | `the profile gate rejected "claims-triage": profile "enterprise" requires private networking, and deployment "prod" declares network.private: false` | `set network.private: true, or set profile: standard` |
| `ir/profile-approvals` | error | `the profile gate rejected "claims-triage": profile "enterprise" requires an approval policy for production changes, and deployments.prod declares no approvals` | `add approvals with require and minApprovers to deployments.prod` |
| `ir/agents-state-store` | error | `the state gate rejected "claims_adjudicator": it can call issue_refund, which has side effects, and it declares no durable state, so a paused run cannot outlive the process` | `add state with kind and urlEnv, or remove the write tool` |
| `ir/approval-step-tool` | error | `the approval gate rejected "refund": step 2 sets requiresApproval on "lookup_policy", which has no side effects` | `set requiresApproval only on tools whose sideEffects is write or destructive` |

### 0.21 — trajectory metrics, cost fallback, export (4 codes)

| Code | Sev | Message | Hint |
| --- | --- | --- | --- |
| `ir/eval-agent-coverage` | error (enterprise), warning (standard) | `the eval-coverage gate flagged this agent: "claims_adjudicator" is reachable from an HTTP pipeline but no eval targets it` | `add an eval with target: agent:claims_adjudicator and gate.ci: true` |
| `ir/eval-trajectory-coverage` | error (enterprise) | `the eval-coverage gate rejected "claims_adjudicator": profile "enterprise" requires a trajectory eval, and this agent's evals declare no tool-trace metric` | `add a tool-trace metric with the tools and order this agent must call` |
| `ir/cost-fallback-profile` | error | `the cost gate rejected "claims_adjudicator": onBudgetExhausted names fallback "fast", and "fast" resolves to a model with no price, so degrading cannot be shown to be cheaper` | `add the model to the pricing catalog, or name a priced fallback` |
| `ir/observability-export` | error (enterprise) | `the observability gate rejected "claims-triage": profile "enterprise" requires trace export, and observability.export is none` | `set observability.export: otlp and configure OTEL_EXPORTER_OTLP_ENDPOINT in the environment` |

The generator's current refusals for `tool-trace`/`cost`/`latency` are *replaced* by runtime
support in this phase; if any remain unimplemented for a specific target, the refusal moves to
`ir/eval-metric-unmeasured` in the gate layer with the same reason text, so the honesty survives
the move.

### 0.22 — self-improvement (5 codes)

| Code | Sev | Message | Hint |
| --- | --- | --- | --- |
| `ir/prompt-version-stale` | error | `the promotion gate rejected "triage": the template changed since version 4 was recorded, and the version was not bumped, so two different prompts share one identity` | `bump prompts.triage.version to 5, or revert the template` |
| `ir/promotion-regression` | error | `the promotion gate rejected "triage": candidate version 5 loses 0.031 on triage_regression against baseline version 4, and allowedQualityDrop is 0.010` | `improve the candidate, or raise allowedQualityDrop with a recorded reason` |
| `ir/promotion-cost` | error | `the promotion gate rejected "triage": candidate version 5 costs 0.42 per run against a 0.40 ceiling, an increase of 12% over allowedCostIncrease 10%` | `reduce the candidate's cost or raise maxCostIncrease` |
| `ir/feedback-pii` | error | `the feedback gate rejected "claims-triage": signal "correction" stores free text under pii.redact entries that do not cover national-id, and the store is declared as persistent` | `add national-id to observability.feedback.pii.redact, or set retentionDays to 0` |
| `ir/promotion-approval` | error (enterprise) | `the promotion gate rejected "triage": profile "enterprise" requires a recorded approval for a promotion, and the candidate declares none` | `record an approval for this candidate, or promote under profile: standard` |

### 0.23 — overlays (4 codes, new `overlay/` namespace)

| Code | Sev | Message | Hint |
| --- | --- | --- | --- |
| `overlay/base-missing` | error | `the overlay gate rejected "acme": base "../specs/support-copilot.yaml" does not exist` | `check the relative path from the overlay file` |
| `overlay/path-not-overridable` | error | `the overlay gate rejected "acme": overrides "deployments.prod.replicas" is not an overridable path in the base spec` | `add deployments.prod.replicas to the base spec's overridable block` |
| `overlay/weakens-control` | error | `the overlay gate rejected "acme": it changes "guardrails.output_pii.action" from "block" to "flag", which relaxes a control, and the base does not permit weakening at that path` | `mark the path allowWeaken: true in the base, or keep the base action` |
| `overlay/removes-eval` | error | `the overlay gate rejected "acme": it removes eval "triage_regression", which gate.ci requires, and the base does not permit that path` | `overlays may not remove a CI-gating eval; add a stricter eval instead` |

---

## 6. Generated artifacts, per addition

The ownership rule is unchanged: plumbing is `app/generated/`, everything a customer may want to
change is `app/business/`, `aid eject` flips any file. New artifacts per phase:

| Phase | `app/generated/` | `app/business/` | Infra / CI |
| --- | --- | --- | --- |
| 0.19 | `profile.py` reconciliation record; `region`/`audit` threaded into the deployment descriptor | — | region variable into the module set; audit sink resource (`aws_cloudwatch_log_group` / `google_logging_project_sink`); `--confirm-prod` unchanged |
| 0.20 | `approvals.py` pause/resume plumbing; `run_state.py` state-store interface (SQLite default); `Approval` typed contract; resume route | `approval_policy.py` (the decision); `run_state` override hook | approval gate on the prod environment in generated CI; private-network flags in the module set |
| 0.21 | trajectory metric wiring; `observability.py` gains exporter setup reading env | `judge.py` (unchanged) | dashboards-as-code for the supported clouds; `aid report` reads files |
| 0.22 | promotion report writer; feedback intake route | `feedback.py` (what a signal *means*) | promotion gate job in generated CI; approval record for enterprise |
| 0.23 | resolved spec (a build artifact, not code) | — | per-customer env roots; `aid fleet` reads them |

Every generated file above is added to the manifest with hashes, to the byte-asserted fixtures,
and to the eject table for both targets.

---

## 7. Backward compatibility and migration

| Phase | specVersion | Breaking for existing specs? | IR version | Migration note |
| --- | --- | --- | --- | --- |
| 1 | 0.18 → **0.19** | No. `profile` absent = `standard`; `cloud`/`region`/`audit` are new optional keys, and a spec with no `cloud` keeps consulting `--cloud` exactly as today. | 0.1.0 → **0.2.0** (IR gains `profile`) | Note that `cloud` may now live in the spec, and that a spec pinning it refuses a conflicting `--cloud` (`ir/cloud-conflict`). |
| 2 | 0.19 → **0.20** | No. New optional keys. | → 0.3.0 | None. |
| 3 | 0.20 → **0.21** | No. Two meaning changes, both widening: the generator refusals for `tool-trace`/`cost`/`latency` become measurements (a spec previously rejected now generates), and `evals.*.target` admits `agent:` as well as `pipeline:`. | → 0.4.0 | Note that those refusals are lifted and what now enforces them (`ir/eval-metric-unmeasured`), plus the `agent:` target. |
| 4 | 0.21 → **0.22** | No. New optional keys, plus `ir/prompt-version-stale`, which can refuse a spec that passes today if its template drifted without a version bump. | → 0.5.0 | Note the prompt-version rule explicitly, naming the diagnostic. |
| 5 | 0.22 → **0.23** | No. Overlays are a new artifact type; the spec gains only `overridable`. | → 0.6.0 | None. |

`IR_VERSION` bumps are mechanical (both in-repo generators declare an `irRange`), and the IR
goldens (`packages/ir/test/__golden__/full.ir.json`, `retrieval.ir.json`) are regenerated
deliberately, as a reviewable diff, in the same commit.

Each phase ends with the full suite green *and* `aid gen --check` clean for every example and
golden, so "no regressions in generated output for existing specs" is a test result rather than a
claim.

---

## 8. What AID will still refuse to be

Unchanged, and re-stated because the brief asks for it to stay honest:

- **No hosted control plane.** `aid fleet` reads a directory. There is no AID server, no
  database of customers, no dashboard AID hosts.
- **No request proxy.** Inference still goes from the generated app to the provider.
- **No runtime lock-in.** Generated code remains plain and dependency-light; `aid eject` leaves
  you with an application, not a dependency on AID.
- **No auto-deploy from self-improvement.** Promotion is a merged PR that passed a gate. Under
  `enterprise`, it also carries a recorded approval.
- **No model hosting, no fine-tuning** in phases 0.19–0.24 (unchanged from `design.md` Phase 4).
- **No secrets in specs.** Identity issuers and audit sinks are references and names.
- **No Azure or Kubernetes in these phases.** That is a capability-matrix phase with its own
  refusals, and smuggling it into profiles would make an "enterprise" spec quietly
  unbuildable for half the targets.

---

## 9. Prioritized phases, with effort

Effort assumes one engineer familiar with the codebase, and includes schema, IR, gates, fixtures,
tests, docs, features-page data and a walkthrough — the phase-exit definition from the brief.

| # | Phase | Value | Effort | Smallest shippable increment |
| --- | --- | --- | --- | --- |
| **1** | **`profile` + `cloud` + region + audit + guardrail requirement (0.19)** | Establishes the tier concept and the first "acceptable *for this class of customer*" gate. Unlocks every later phase's enterprise controls. | **4–5 d** | `profile: enterprise` refuses a spec with no region pin, no audit sink, or a served pipeline missing an input or output guardrail — with the fix in the hint. |
| 2 | Identity, private network, approval policy, durable runs, step approval (0.20) | The enterprise control set is complete enough to pass a security review; long-running runs survive a restart. | 8–10 d | `state` (`kind` + `urlEnv`) + `ir/agents-state-store`; `requiresApproval` on a pipeline write step. |
| 3 | Trajectory evals, per-agent coverage, fallback pricing, OTel export + `aid report` (0.21) | Agents become measurable; fleets become comparable without a backend. | 10–12 d | `tool-trace` measured end-to-end for one agent, replacing the generator refusal. |
| 4 | Feedback signals + promotion gate (0.22) | The self-improving loop closes, gated and approved. | 8–10 d | `aid eval --compare baseline candidate` writes a report a gate can read. |
| 5 | Overlays, `aid resolve`, `aid fleet`, two templates (0.23) | Twenty customers, one base spec. | 10–12 d | One overlay with one overridable path, resolved by `aid gen --overlay`. |

**Total: ~42–49 days.** Sequences chosen so each phase is independently valuable and
independently revertable.

### 9.1 Recommended first increment (Phase 1, detailed)

The smallest thing that is genuinely shippable and not a stub:

1. **Schema** — `profile` enum (`standard`, `enterprise`), `deployments[].cloud`,
   `deployments[].region`, `deployments[].audit`; `specVersion` `0.19`. Valid/invalid fixtures both
   directions.
2. **IR** — `profile` on `IR`, `cloud`/`region`/`audit` on the deployment shape; `IR_VERSION` →
   `0.2.0`; goldens regenerated as a reviewable diff.
3. **Gates** — `profile.ts` with the five codes in §5, registered in `GATES`; diagnostics added to
   `IR_DIAGNOSTIC_CODES`.
4. **Generators** — thread `cloud`/`region`/`audit` into the deployment descriptor for both targets;
   emit the audit sink resource in the AWS and GCP module sets, and honour the spec's `cloud` over
   `--cloud` (refusing a conflict). Byte-asserted fixtures.
5. **Docs** — `spec.md` entries; `features.md` with `since: 0.19` and the five refusals;
   `site/scripts/features-data.mjs` additions (the page does not build without them);
   `support.md` regenerated.
6. **Walkthrough** — `docs/walkthroughs/enterprise-profile.md`: start from a spec that
   `aid validate` refuses with `ir/profile-audit`, fix it, show the gate pass, then show
   `ir/profile-guardrail` and its fix.
7. **Tests** — five gate unit tests, one fixture pair per construct, one golden, and a
   determinism check.

**Why this first:** it is pure schema + IR + gate + docs with exactly one infra emission per
cloud, it needs no runtime change and no new CLI verb, it makes the enterprise tier *mean
something* on day one, and it produces the five diagnostics the later phases extend. It also
proves the phase-exit loop (schema → IR → generator → gate → fixture → docs → walkthrough) on a
small surface before it is applied to something with a runtime dimension.

`cloud` rides along in Phase 1 rather than getting its own phase because `ir/region-target` cannot
validate a region without knowing which cloud's region set to check it against. Splitting them would
mean shipping a gate that guesses.

**Explicit non-goal for Phase 1:** an enterprise profile will *not* require identity, private
networking or approval policy. Those land in Phase 2 with the constructs that can satisfy them.
Requiring them now would make the profile unpassable, which is worse than incomplete.

---

## 10. What is specified here but not built

For the CLI reference and the features page, at the end of this RFC:

| Construct / command | Status |
| --- | --- |
| `profile`, `deployments[].cloud`, `.region`, `.audit` | proposed, 0.19, not built |
| `deployments[].identity`, `.network`, `.approvals` | proposed, 0.20, not built |
| `agents[].state`, step `requiresApproval` | proposed, 0.20, not built |
| `tool-trace` / `cost` / `latency` measured | declarable, **refused at generation today**; proposed 0.21 |
| `observability` as a spec section, `.export: otlp` | **no spec section today** (IR-only); proposed 0.21 |
| `observability.feedback`, `evals[].gate.promotion` | proposed, 0.22, not built |
| `prompts[].version` | **exists and is required**, and forms `prompt:<name>@<version>`; the staleness gate is proposed 0.22 |
| `overridable`, overlays, `aid resolve`, `aid fleet`, `--template` | proposed, 0.23, not built |

---

## 11. Open questions for review

1. **Is `profile` the right word?** The alternatives are `tier` and `class`. `profile` reads best
   next to "an overlay selects the profile per customer," but it collides slightly with
   `onBudgetExhausted`'s "cost profile" in `ir/cost-profile-unknown`. Acceptable, or rename?
2. **Should `standard` be forbidden from enterprise-only keys?** My recommendation is *no* — a
   standard-profile spec may declare region and audit (it is stricter than required, which is
   fine) — but the alternative (standard must not) makes the profile a real mutual exclusion.
3. **Should the enterprise guardrail requirement be expressed per pipeline or per stage?** The
   audit settled this one by constraint rather than preference: guardrails are declared globally
   with `stages` and are *not* attached to pipelines (`pipeline` has only `description`, `trigger`,
   `steps`), so the enforceable form is "the spec declares at least one `input` guardrail and at
   least one `output` guardrail." Per-pipeline attachment would be a schema change of its own and
   is not proposed here. Confirm that global-stage is the intended reading of the requirement.
4. **Overlay scope.** I have overlays touching five path families (name, region, audit sink,
   `models.*.modelId`, budget). Is *tool allowlist* likewise overridable per customer, or is that
   the line where a fork is the honest answer?
5. **`aid fleet` output.** Table, JSON, or both? It has to be readable in CI logs and machine
   readable for a platform team's own dashboard.
6. **Where does the promotion approval record live?** A file in the repo next to the candidate, or
   an entry in the customer overlay? The file is simpler; the overlay would make "who approved
   what for whom" one query.

---

## 12. Decision requested

Approve Phase 1 as described in §9.1 (`profile` + `cloud` + region + audit + guardrail
requirement, `specVersion` 0.19, `IR_VERSION` 0.2.0, five diagnostics, both generators, fixtures,
docs, features page, one walkthrough) and I will implement it end to end on this branch. Or redirect
the sequencing — for example to Phase 5's overlays first if multi-customer throughput is worth more
right now than tier enforcement. I recommend Phase 1 first, for the reason in §9.1: it proves the
full phase-exit loop on the smallest surface, and every later phase extends its requirement list
rather than inventing a new one.
