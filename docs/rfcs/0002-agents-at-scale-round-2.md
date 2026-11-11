# RFC 0002 — Agents at scale, round 2: verification, re-ranking, next increments

| Field | Value |
| --- | --- |
| Status | **Draft — awaiting review** |
| Author | Agent-assisted verification, 2026 |
| Phase | 0 (verify + design). No feature code in this RFC. |
| Affects | `runtimes/python`, `ir` gates, `cli`, both generators, `docs/`, `site/scripts/features-data.mjs` |
| Supersedes | nothing; extends [RFC 0001](./0001-agents-at-scale.md) |

> **Nothing proposed here is built.** Every claim about current behaviour cites the file and
> line that proves it, and every proposal is labelled as a proposal. Where round 1 and this
> round disagree, this round wins, because this round ran the thing.

---

## 0. Summary of findings

Round 1 shipped eight phases against the assumption that observability was "half-built". It
is not half-built. **The alarm feature shipped in 0.1.149 cannot fire, and the repository's
own documentation says so in one section and denies it in another.**

Five checks were run. Four pass. The fifth is a real defect:

| # | Check | Verdict |
| --- | --- | --- |
| 1 | Golden-path templates run end to end | **PASS**, two frictions |
| 2 | Generated alarms are correct | **FAIL** — no producer for the four series exists |
| 3 | Every target refuses what it cannot emit | **PASS**, undocumented in the support matrix |
| 4 | Agent evals are refused, not silently degraded | **PASS** — and the refusal is correct |
| 5 | Published counts match what is shipped | **FAIL (partial)** — mechanism is right, registry is incomplete |

The defect, stated plainly:

- `runtimes/python/src/aid_runtime/telemetry.py:176-178` installs a `TracerProvider`, a
  `BatchSpanProcessor` and an `OTLPSpanExporter`. There is no `MeterProvider` anywhere in
  `runtimes/` or `packages/`, no span-to-metric connector, and no collector configuration
  generated or documented. A repository-wide search for `MeterProvider`,
  `meter_provider`, `spanmetrics` and `metrics_exporter` returns nothing.
- `docs/features.md:595` states this correctly: *"the runtime publishes no metrics at all:
  the only telemetry it emits is spans."*
- `docs/features.md:421`, fifteen hundred lines away, claims the opposite about the same
  feature: *"The metric list is closed to the four series the deploy plan already derives
  (`agent.cost`, `agent.tokens`, `eval.cost`, `eval.latency.p95`), so an alarm cannot watch
  a number nothing produces."*
- The gate that is supposed to prevent this, `alertsGate`
  (`packages/ir/src/gates/observability.ts:213`), refuses alerts only when `export` is not
  `otlp`, and its hint reads *"so the spans reach a collector"*. It presumes a collector
  derives the series. Nothing does. **A document that satisfies the gate still ships four
  inert alarms**, each reporting no data forever, which the features page itself identifies
  as the failure mode that "reads as healthy".

The second finding is a spec dead-end rather than a lie. `ir/src/gates/promotion.ts:134`
refuses `gate.promotion.allowedCostIncrease` unless the eval declares a `cost` metric; a
`cost` metric is refused at generation by
`packages/generators/py-fastapi/src/metrics.ts:121` with the reason *"the runtime has no
latency metric; a p95 budget is a declared Phase 0 deferral"*. Both refusals are honest, and
together they make a cost ceiling in a promotion policy **unreachable through any valid
document**. Round 1 called self-improvement the highest-value gap; round 2 shows the cost
half of it is not merely unbuilt, it is unbuildable.

## 1. Method

Everything below was executed in the worktree, not read off the brief:

- Scaffolded both golden-path templates into throwaway directories (`aid init --template
  support-copilot`, `aid init --template enterprise-approvals`), then ran `aid validate`,
  `aid gen`, `aid gen --check`, `aid infra gen` and `aid infra gen --check` in each.
- Exercised the overlay path: wrote `customers/acme.yaml` against the base spec, ran
  `aid resolve customers/acme.yaml`, `aid fleet`, `aid report`, and a deliberately invalid
  overlay to capture the refusal.
- Ran `aid infra gen --cloud gcp` against an AWS-pinned spec to capture the cloud-conflict
  refusal, then switched the spec to GCP (`region: europe-west3`, `audit.sink: gcs`,
  `specVersion: "0.30"`) and re-ran to confirm the emitted alarm resources.
- Read the runtime exporter, the tracing attribute schema, the eval models, the gate
  implementations and the generator metric mapping directly.
- Audited `site/scripts/features-data.mjs` against the constructs that `spec.md`
  documents, the IR gates and both generators actually support.

Counts quoted in this document are from those runs.

## 2. Verification results

### Check 1 — Golden-path templates run end to end: PASS (two frictions)

| Step | `support-copilot` | `enterprise-approvals` |
| --- | --- | --- |
| `aid validate` | 0 errors, 0 warnings | 0 errors, 0 warnings |
| `aid gen` | 27 files | 30 files |
| `aid gen --check` | 0 created, 0 updated | 0 created, 0 updated |
| `aid infra gen` | 9 files | 14 files |
| `aid infra gen --check` | clean | clean |

The generated CI is real, not decorative: it runs `aid validate`, `aid gen --check`,
`aid doctor` and `aid infra gen --check`; `evals.yml` runs the eval module and
`aid cost --budget`; `infra-plan.yml` is plan-only and authenticates with OIDC.

The overlay flow works. `aid resolve customers/acme.yaml` applies the declared overrides and
reports them; `aid fleet` prints a one-row table with region, profile and pipeline counts;
an out-of-bounds overlay is refused with `overlay/value-out-of-bounds` and a fix hint naming
the allowed range. `aid report` walks a directory of deployments, prints `—` per deployment
with no trace files and a summary line ("measured: none of 3 deployment(s) has trace files
yet"), and exits 0 — the documented behaviour.

Two frictions, both worth fixing because they hit a first-time user:

1. **The templates lag the schema.** Both pin `specVersion: "0.29"`, so any 0.30 construct —
   including `observability.alerts`, the feature this round is auditing — is refused with
   `spec/not-supported` until the user bumps the version by hand. The golden path does not
   demonstrate the current release.
2. **`aid fleet` fails on a fresh golden path.** `aid init --template support-copilot`
   scaffolds no `customers/` directory, so `aid fleet` exits with `cli/fleet-no-overlays` —
   and that same hint text tells the user to run `aid init --template support-copilot` to
   see an example overlay. The instruction points at a template that does not contain one.

### Check 2 — Generated alarms are correct: **FAIL**

Alarm *generation* is sound. `aid infra gen --cloud gcp` on an AWS-pinned spec is refused
with `cli/infra-cloud-conflict` (exit 2) and a hint naming the pinned cloud; regenerating
after switching the spec to `cloud: gcp` emits a faithful `google_monitoring_alert_policy`
pair with the metric type, window and threshold the document declared. Regenerating for the
other cloud leaves the previous cloud's modules behind as `[generator/generated-drift]`
warnings rather than deleting them, which is the documented behaviour.

Alarm *semantics* are not sound, and this is the round's central finding:

- **No producer.** `telemetry.py:176-178` — `TracerProvider(resource=...)`,
  `BatchSpanProcessor(OTLPSpanExporter(endpoint=endpoint))`, `trace.set_tracer_provider`.
  The success detail string it returns says `"spans export to {endpoint}"`, which is exactly
  what it does. No metric pipeline is installed, in the runtime or in a collector.
- **The data to derive the series exists.** `runtimes/python/src/aid_runtime/tracing.py:57-89`
  already records `aid.cost.usd`, `aid.agent.id`, `aid.agent.steps`, `aid.agent.status`,
  `aid.tool.names`, `aid.hitl.*`, `aid.guardrail.*` and `aid.gateway.attempts` on spans. Every
  value the four alarm series need is computed during a run. Nothing turns it into metrics.
- **The gate's premise is false.** `alertsGate` (`observability.ts:213`) refuses
  `export != 'otlp'` with *"no collector derives the series they watch and every alarm would
  report no data forever"* and hints *"so the spans reach a collector"*. A collector is not
  shipped, is not generated, is not documented, and no `spanmetrics` configuration exists to
  hand a user. The gate accepts the configuration that produces inert alarms.
- **The reference overstates the safety.** `docs/reference/spec.md:854`: *"the gate refuses
  an alert whose `metric` no derived series backs … and — above all — an alert in a document
  whose spans never leave the process, because a collector cannot derive from what it is
  never sent."* The phrase "a collector cannot derive from what it is never sent" asserts
  that a collector *would* derive if it were sent. That is the sentence to fix or to make
  true.

Severity: an operator who trusts a generated paging alarm gets silence. In an enterprise
profile, where the alarm is the control the audit story rests on, that is the worst kind of
failure — the one that looks like health.

Honest note in the framework's favour: `features.md:595` and the alerts module's own
docstring both state the runtime publishes no metrics, and the CLI reference does not claim
a collector is generated. The defect is a **contradiction between two published claims plus a
gate whose remedy does not address its stated cause**, not a hidden lie. That is fixable in
either of two directions (§12).

### Check 3 — Every target refuses what it cannot emit: PASS, undocumented

`packages/generators/ts-vercel/src/validate.ts:262-286` refuses `export: otlp` with
`observability-export-unsupported` and a hint pointing at `py-fastapi`. The refusal is
correct and specific.

The gap is documentation. `docs/reference/targets.md` lists the `ts-vercel` capability row as
`otel`, `tool-calling`, `agents`, `cursor-memory`, and "Emits against … `tracing: otel-genai`",
with no statement that `export: otlp` is refused. A reader comparing targets sees the same
`otel` claim on both. The matrix is generated from the manifests, so the manifest is where
the capability vocabulary needs to distinguish *records spans* from *exports spans*.

### Check 4 — Agent evals are refused, not silently degraded: PASS

> **Read as a snapshot of the audit, not as current state.** Phase 3 (below, §5.3) shipped the
> runtime half this check found missing: `CaseOutcome` now carries an optional `Trajectory`, a
> runner may return `RunOutput`, and `cost` and `latency` are measured per case. What remains
> true is the refusal itself, on narrower grounds — no *generated* runner reports tool calls —
> and the `Runner` and `metrics.ts` line numbers quoted below have moved.

The gate works exactly as documented. `evalTrajectoryGate`
(`packages/ir/src/gates/observability.ts:79-118`) refuses `target.kind === 'agent'` with
`ir/eval-trajectory`, message *"names an agent, and this build emits evals over a prompt, not
over an agent run"*, hint *"an agent eval needs a runner that carries a trajectory, which is
not built yet"*. It separately refuses any `metric.kind === 'tool-trace'`.

Verified at the runtime level, and the reason is structural rather than incidental:

- `runtimes/python/src/aid_runtime/evals/runner.py:34` — `Runner = Callable[[EvalCase],
  Awaitable[str]]`. A case becomes **a string**.
- `evals/runner.py:36-47` — `CaseOutcome` carries `case_id`, `prediction: str`, `scores`.
  No steps, no tool calls, no cost, no latency, no handoffs, no approvals.
- `evals/dataset.py:20-27` — `EvalCase` carries `id`, `input`, `expected`, `tags`,
  `metadata: dict[str, str]`. `metadata` is the only free-form channel and it is not carried
  onto the outcome.

The generator is consistent with the gate: `packages/generators/py-fastapi/src/metrics.ts:1-20`
maps seven of the nine metric kinds and *rejects* `tool-trace`, `cost` and `latency` rather
than dropping them, each with a reason. `builtin` and `retrieval` are handled on separate
paths. The refusal surfaces are honest; the capability is absent.

Verified by construction: the §4.3 eval block was added to a copy of the `support-copilot`
spec at `specVersion: "0.30"` with two declared tools, and `aid validate` returned **exactly
one error — `ir/eval-trajectory` — and zero schema violations**. The grammar accepts
`target: agent:triage_agent`, `tool-trace` with `expect` and `ordered`, `cost.max` and
`latency.maxMs` today. Only the gate and the runtime stand between the language and the
feature.

One consequence the round-1 RFC did not identify: because `cost` is unmeasurable, the
promotion policy's cost ceiling is unreachable (§0). `packages/cli/src/commands/eval-compare.ts:412`
says so in a warning — *"a recorded baseline carries quality metrics only, because the
runtime measures no cost metric yet"* — and `ir/src/gates/promotion.ts:134` independently
refuses `allowedCostIncrease` when no `cost` metric is declared. The two rules are each
defensible and jointly unsatisfiable.

### Check 5 — Published counts match what is shipped: **FAIL (partial)**

The mechanism is right and worth keeping: `site/scripts/features-data.mjs` is the single
registry, the features page and the homepage counts are generated from it, and
`scripts/check-docs-claims.mjs` checks published prose against it. The counts are not
hand-maintained.

The registry is incomplete. The `agents` capability family maps only
`['agents', 'agentcore-gateway']` — shipped 2 — while the following are independently
evidenced as shipped:

| Construct | Evidence it is shipped | In the registry? |
| --- | --- | --- |
| `agents[].humanInTheLoop` | `packages/ir/src/gates/hitl.ts` (`ir/hitl-side-effect`), emitted by py-fastapi, used by the `enterprise-approvals` template, documented at `docs/reference/spec.md:644-647` | **No** |
| `agents[].state` | schema + `agentState` def, durable run store, `ttlHours` | No, under `agents` |
| `agents[].tools` tool contracts | `tool` def, typed contracts in `app/business/` | Partial |

`memory` is filed under `retrieval`, which is defensible, but it means the "agents" family
undercounts by at least three shipped constructs, one of which — step-level human approval —
is the single most valuable enterprise control AID ships. The homepage says "2" where the
truth is 5.

## 3. Re-ranked gaps

Round 1's ordering was: profiles, overlays/fleet, approval, OTel, alarms, report. That
ordering is now stale, because two of those shipped and one of them does not work.

| Rank | Gap | Evidence | Severity |
| --- | --- | --- | --- |
| 1 | Alarm series have no producer | §2 check 2 | **Critical** — a shipped paging control that cannot fire, contradicted by the repo's own docs |
| 2 | No trajectory or per-case cost in the eval runner | §2 check 4, `runner.py:34-47` | **High** — blocks agent evals, cost regression budgets, and the promotion cost ceiling |
| 3 | Registry undercounts shipped agent surface | §2 check 5 | **High** — a false count on the sales page, breaching the honesty principle in the cheap direction |
| 4 | Golden path lags the schema and has no overlay | §2 check 1 | **Medium** — first-run friction on the path that sells the product |
| 5 | Support matrix omits the exporter distinction | §2 check 3 | **Medium** — a correct refusal a reader cannot find |
| 6 | No trace → dataset path | no `aid trace export`, no `--from-traces` | **Medium** — the input side of self-improvement |
| 7 | No delivery playbook | no `docs/guide/delivery.md` | **Low** — the story exists in RFCs, not in the docs a customer reads |
| 8 | No Azure or Kubernetes target | capability matrix covers AWS/GCP/container | **Low, deliberate** — see §9 |

The ordering principle changes for this round. Round 1 ranked by *value of the new
capability*. Round 2 ranks by **distance between a published claim and a delivered
behaviour**, because that distance is the one thing a gates-are-the-product framework cannot
afford. Rank 1 is a false claim; ranks 3 and 5 are false counts; ranks 2, 4, 6, 7 are true
gaps.

## 4. Proposed changes

Four proposals, in the order they should ship. Only the third and fourth touch the spec
language, and only additively.

### 4.1 Make the alarms real (no spec change)

The four series are computable from values the runtime already computes for span attributes
(`tracing.py:57-89`). The fix is for the runtime to publish them, opt-in, on the same switch
that already governs export:

```yaml
observability:
  trace: true
  export: otlp
  endpointEnv: OTEL_EXPORTER_OTLP_ENDPOINT
  alerts:
    - id: high_cost_run
      metric: agent.cost
      window: 1h
      aggregate: sum
      threshold: 5.0
      source: triage_agent
```

That block validates today: with `specVersion: "0.30"` and an agent named `triage_agent`,
`aid validate` returns **0 errors, 0 warnings**. That is the defect stated as a fact — the
gate accepts a declaration whose four series nothing produces.

One runtime call, beside the existing one, in the generated
`app/generated/observability.py`:

```python
# generated; the developer's ASGI entrypoint calls these, never the library on import
tracing_export_status()   # shipped 0.1.150
metrics_export_status()   # proposed
```

`aid_runtime.telemetry.configure_metrics()` installs a `MeterProvider` with an OTLP metric
exporter over a periodic reader, with the same three gates the tracer has: no-op unless
called, `exporter-not-installed` if the `otlp` extra is absent, `already-configured` if a
meter provider is present. Recording points sit where the span attributes are already
computed:

| Series | Instrument | Recorded at |
| --- | --- | --- |
| `agent.cost` | counter, `aid.agent.id` label | agent run completion (`cost_usd` is already on the result) |
| `agent.tokens` | counter, same labels | agent run completion |
| `eval.cost` | counter, `aid.eval.id` label | eval case completion |
| `eval.latency.p95` | histogram, same labels | eval case completion |

No collector is generated and none is required: the app is the producer, and the endpoint
stays in the environment variable the spec already names. This keeps rule 2 (no hosted
control plane) and adds no infrastructure artifact, which is why it is the smaller fix
compared to generating a collector deployment with a `spanmetrics` connector.

Third-party backends that cannot compute a percentile from a histogram are a real
complication for `eval.latency.p95`. This RFC does **not** propose a gate for it, because
backend support was not verified (§11, open question 2).

### 4.2 Correct the two contradicting claims

Whichever direction §12 chooses, two published sentences change:

- `docs/features.md:421` — replace *"so an alarm cannot watch a number nothing produces"* with
  the mechanism, once it exists: the generated app publishes these four series when
  `export: otlp` is on, and the alarm's metric list is closed to them.
- `docs/reference/spec.md:854` — the phrase *"a collector cannot derive from what it is never
  sent"* must become a statement about the app, not a hypothetical collector.

If the fix-forward path is chosen these are corrections. If the retract path is chosen, the
alarms entry moves to the "refused, on purpose" section of the features page and
`observability.alerts` is refused outright until §4.1 ships.

### 4.3 Trajectory evals (no new spec keys required)

**The spec language already expresses this.** `metric` is a `oneOf` that includes:

- `tool-trace` — `expect: [tool names]`, `ordered: boolean`, unique items, at least one.
- `cost` — `max`, "maximum tolerated USD per case".
- `latency` — `maxMs`.

`evals[].target` already matches `^(pipeline|agent):[a-z][a-z0-9_]{0,63}$`, and its schema
description already states that `agent:<id>` "is what a trajectory metric would need". So the
Phase 3 change is **implementation, not grammar**:

```yaml
evals:
  triage_trajectory:
    target: agent:triage_agent
    dataset:
      source: file
      uri: evals/triage.jsonl
    metrics:
      - kind: tool-trace
        expect: [lookup_order, issue_refund]
        ordered: true
      - kind: cost
        max: 0.05
      - kind: latency
        maxMs: 20000
    gate:
      ci: true
      maxRegression: 0.02
      samples: 5
```

`gate.promotion` is deliberately absent from the snippet. Its `baseline` is
`{ prompt: <name>, version: <n> }` — a **prompt** identity — and an agent trajectory eval
scores an agent run, not a prompt. Promotion for agent evals needs a baseline identity that
is not prompt-keyed (§11, open question 5).

The tool names in `expect` must be declared. This was verified too: naming an undeclared tool
is refused today by `ir/metric-tool-unresolved` (*"the referential gate rejected this
tool-trace expectation: no tool named \"issue_refund\" exists"*), so the referential half of
trajectory evals is already enforced and Phase 3 inherits it rather than building it.

Runtime shape: a `Trajectory` value carried on the outcome rather than replacing it.
**Built**, and narrower than drafted: the metric only needs the ordered tool names, so the
record keeps names and nothing else. Arguments, per-step cost and per-step latency stay on
`StepRecord`, which `Trajectory` is derived from — duplicating them into a second model would
create two sources of truth for the same run.

```python
class Trajectory(BaseModel):
    calls: tuple[str, ...]              # ordered, flattened from each step's tool_names

class RunOutput(BaseModel):
    text: str                           # what a text metric scores
    trajectory: Trajectory = Trajectory()   # the opt-in; `Runner` may still return `str`

class CaseOutcome(BaseModel):
    ...
    trajectory: Trajectory | None = None   # additive; None when the runner reported none
```

Additive field, prompt-only evals unchanged, existing baselines still load. `tool-trace`
compares `trajectory.calls` against `expect` with `ordered` honoured. `cost` and `latency` did
**not** need the trajectory, so they shipped first: the harness already measures both around
the runner call.

Two details worth recording, because each is a place a gate could have gone wrong:

- `trajectory is None` (the runner reported nothing) is *not* the same as an empty
  trajectory (the run called no tools). `tool-trace` refuses the first and scores the second.
  Conflating them would let a trace assertion pass on every case by having nothing to compare.
- `cost` refuses an unmetered run rather than reading its `cost_usd` of `0.0`, because a
  ceiling that trusted that number would pass forever over a run it never measured.

`tool-trace` matching needed a semantic decision, resolved in §11 (open question 3).

### 4.4 Trace → dataset (CLI only)

New: `aid trace export --dataset triage_curated --from <dir> --filter agent=triage_agent`
writes a `Dataset`-shaped JSONL file from the JSONL spans `aid trace` already reads. Cases are
the successful runs; `expected` is derived from what the run did, not from a model. A second
flag, `aid eval --from-traces <file>`, skips writing and evaluates directly.

No spec change: `evals[].dataset.source` is currently a `const: "file"`, and a trace-derived
dataset is a file by the time eval reads it.

## 5. New gates and their exact diagnostics

Each gate below is new unless marked shipped. Message, path and hint are the strings to
implement, in the style the existing gates use.

### 5.1 `ir/alerts-unproduced` (proposed, Phase 2)

The gate that makes the alarm claim true. Refuses an alert series the generated app cannot
record. Complements the shipped `ir/alerts-unexported`, which only checks the export switch.

- **Codes:** `alertsUnproduced`
- **Message:** `the alerts gate rejected "{alert.id}": metric "{alert.metric}" has no recording point in this build, so the alarm would watch a series nothing writes and report no data forever`
- **Path:** `['observability', 'alerts', alert.id, 'metric']`
- **Hint:** generate for a target that records this series. `py-fastapi` publishes all four
  when `export: otlp` is declared and the `otlp` extra is installed; a target whose manifest
  lacks the `metrics` capability records none (`{target}`)

Target manifests gain a `metrics` capability so this is answerable from the manifest rather
than from a hard-coded generator list. `ts-vercel` already refuses `export: otlp`, so it is
unaffected in practice; the capability makes the matrix honest.

### 5.2 `ir/alerts-unexported` (shipped — hint corrected)

Stays, with its remedy rewritten to match its cause once §4.1 ships. Current hint: *"add
`export: otlp` and `endpointEnv: …` so the spans reach a collector, or remove the alerts
block"*. Proposed: *"add `export: otlp` and `endpointEnv: …` so the generated app publishes
the series, or remove the alerts block"*.

### 5.3 `ir/eval-trajectory` (shipped — narrowed, then lifted)

**Status after Phase 3's first increment: the runtime half is built, the generator half is
not, so the gate is unchanged.** `Trajectory`, `RunOutput` and `tool-trace` exist in
`aid-runtime` and are tested (`tests/test_evals_trajectory.py`), and a hand-written runner
can return a `RunOutput` to satisfy a `tool-trace` metric. What does not exist is a
*generated* runner that carries a trajectory: `evalSubject` in `@aid-framework/ir` still
refuses every `agent:` target, and a pipeline response still has no tool calls. Narrowing
this gate before that runner exists would let `aid validate` pass a spec that generation
then has to refuse, which moves the refusal rather than removing it. So the gate keeps its
current messages, and §5.3's narrowing moves to the increment that emits an agent eval.

To be done when the agent-eval emitter lands:

- **Codes:** `evalTrajectory` (unchanged code, new reason)
- **Message:** `the trajectory gate rejected "{eval.id}": it scores an agent run over its steps, and agent "{agent.id}" declares no maxSteps, so the trajectory has no ceiling to be measured against`
- **Path:** `['evals', eval.id, 'target']`
- **Hint:** set `maxSteps` on agent `{agent.id}`. The loop is refused unbounded at generation
  anyway (`ir/agents-budget`), and a trajectory eval needs the same ceiling to score against

For `pipeline:` targets the `tool-trace` refusal remains, with its existing hint, because a
pipeline response still carries no tool calls.

### 5.4 `ir/eval-coverage` (proposed, deferred)

Deferred with §5.3: an obligation to measure trajectories that nothing can emit would refuse
every enterprise spec that declares an agent, which is the opposite of the intended effect.
It lands in the same increment as the agent-eval emitter.

- **Codes:** `evalCoverage`
- **Message:** `the eval coverage gate rejected this deployment: profile enterprise requires a trajectory eval for every agent, and {n} agent(s) have none ({ids})`
- **Path:** `['evals']`
- **Hint:** add an eval with `target: agent:<id>` and a `tool-trace` metric for each. An
  enterprise deployment that changes prompted behaviour without a measured trajectory cannot
  show the change was not a regression

Scoped to spec 0.30 and above, like the other profile gates. `standard` profile: no
requirement.

### 5.5 `ir/promotion-cost` (shipped; the warning is reworded, not removed)

**Corrected.** This section originally said the `allowedCostIncrease` warning should be
deleted once §4.3 landed. It cannot be, and deleting it would have been the dishonest move.
A recorded baseline (`eval-compare.ts:39-52`) stores `metric`, `runs`, `mean` and `stdev` per
metric — a **pass rate**, never a dollar total — so "candidate spend rose by more than N%"
is not computable from the two files the comparison reads, whatever the runtime measures.
`cost` is compared like any other metric: as the *rate at which the declared ceiling held*.

What changed: the warning now says that, instead of claiming the runtime measures no cost
metric. Comparing dollars between baseline and candidate remains on the not-built list in
§10 and on the features page.

## 6. Generated artifacts, per addition

| Addition | Artifact | Where | Ownership |
| --- | --- | --- | --- |
| §4.1 metrics | `metrics_export_status()` + recording calls | `app/generated/observability.py` | generated, regenerated by `aid gen` |
| §4.1 metrics | `configure_metrics()` + instruments | `runtimes/python/src/aid_runtime/telemetry.py` + `metrics.py` | runtime package, versioned |
| §4.3 trajectory | `Trajectory`, `Step`, `Approval` models | `runtimes/python/src/aid_runtime/evals/` | runtime package |
| §4.3 trajectory | trajectory-aware eval module | `app/generated/evals/` | generated |
| §4.3 trajectory | `MAX_STEPS` / `COST_MAX` thresholds beside existing constants | `app/generated/evals/*.py` | generated, byte-asserted |
| §4.4 trace→dataset | nothing generated | CLI writes a user-owned dataset file | user-owned, in `app/business/evals/` by convention |

Tool bodies stay in `app/business/`. Every addition above regenerates cleanly under
`aid gen --check` and survives `aid eject`, which extends `eject`'s coverage to
`app/generated/evals/` — a directory that already exists, so no boundary change.

## 7. Backward compatibility and migration

- **§4.1** is additive and opt-in: nothing is installed on import, and `export: otlp`
  already means "send my telemetry". A document gains metrics only where it already declared
  where its telemetry goes. **No spec version bump.** A user who installs the `otlp` extra
  and calls `metrics_export_status()` starts getting series; one who does not is unchanged.
  This is the one change in the round with zero migration cost, which is why it goes first.
- **§4.3** adds an optional `trajectory` field to `CaseOutcome` and implements three metric
  kinds that are already in the schema. Existing baselines load unchanged (`trajectory`
  absent), and existing documents validate unchanged. Because nothing in the grammar
  changes, **no spec version bump is required**; the release still carries a minor version
  bump for the runtime and IR packages, with a changelog entry stating that
  `ir/eval-trajectory` no longer fires for `agent:` targets.
- **§4.4** is CLI-only and additive.
- **If the retract path is chosen instead for alarms** (§12), `observability.alerts` becomes
  a refusal. That *is* a behaviour change for a document that validates today, so it needs a
  spec minor bump, a migration note ("alerts are refused until the metric path ships"), and
  `aid validate` guidance naming the two ways out: remove the block, or pin the older spec
  version. This is why retraction is the more expensive option despite touching less code.

Reproducibility: every new generated artifact lands with byte-asserted fixtures, and the
existing `aid gen --check` CI step covers drift.

## 8. What AID will still refuse to be

Unchanged from RFC 0001, restated because this round adds temptation:

- **No hosted control plane, no request proxy.** The metric fix publishes from the app to an
  endpoint the customer names. It does not add a service operated by AID.
- **No generated collector.** A `spanmetrics` connector could derive all four series from
  spans with no runtime change, and would be a legitimate design. It is rejected here because
  it ships an artifact the customer must run and operate, which contradicts the low-ops
  promise of the standard profile.
- **No auto-promotion.** `aid eval --compare` refuses; a human merges.
- **No approval without a record.** `gate.promotion.approval` is required under enterprise.

## 9. Prioritized phases

Effort is agent-days for one agent working with the existing test harness, including tests
and fixtures. Ranges are honest uncertainty, not padding.

| Phase | Smallest shippable increment | Effort | Depends on |
| --- | --- | --- | --- |
| **1. Accuracy sweep** | Registry gains the three agent constructs, both templates move to 0.30, `support-copilot` gains a `customers/acme.yaml`, plus a test asserting every template validates and `aid fleet` succeeds | **S, 0.5–1 d** | — |
| **2. Make alarms real** | `configure_metrics()` + the four recording points + `metrics_export_status()`, with `ir/alerts-unproduced` and the corrected hint | **M, 3–4 d** | Phase 1 (docs) |
| **3. Trajectory evals** | *(partially shipped)* `cost`/`latency` measured end to end, plus `Trajectory`/`RunOutput`/`tool-trace` in the runtime with tests. Still open: the agent-eval emitter, `ir/eval-trajectory` narrowing, `ir/eval-coverage` | **L, 1.5–2 wk** | Phase 2 (cost instrument) |
| **4. Trace → dataset** | `aid trace export --dataset` writes a valid dataset from one agent's spans | **M, 4–6 d** | Phase 3 |
| **5. Delivery playbook** | `docs/guide/delivery.md`: template → overlay → fleet → report → improvement loop, with the enterprise checklist per control | **S, 1–2 d** | Phase 1 |

Phase 1 is the smallest increment and the cheapest honesty win: it fixes a false count, a
template that cannot express the current release, and a fleet demo that fails on first use.
Phase 2 is the one that stops a shipped control from lying.

Deliberately **not** phased: an Azure or Kubernetes target. The capability matrix already
refuses unsupported pairs by name, and adding a third cloud multiplies the alarm, audit and
network surfaces that phases 2–3 have just started telling the truth about. The matrix should
keep refusing it explicitly rather than the roadmap implying it.

## 10. What is specified here but not built

Total honesty, per principle 4. Nothing in this list is supported today, and no page may say
it is.

- **Metric emission.** Proposed in §4.1. Today: `export: otlp` exports spans only.
- **Any collector artifact or `spanmetrics` configuration.** Not built, not proposed.
- **A generated agent eval.** The runtime half of §4.3 is built — `Runner` may return a
  `RunOutput` carrying a `Trajectory`, `CaseOutcome` records it, and `tool-trace` scores it —
  but nothing emits one: `evalSubject` refuses every `agent:` target, so a spec cannot declare
  a trajectory eval that generation would honour.
- **`tool-trace` in a generated eval module.** Built in the runtime, refused by the generator
  for the reason above. `cost` and `latency` *are* measured from the numbers the harness
  collects around each case.
- **`gate.promotion.allowedCostIncrease` comparing dollars.** Declarable, gated both ways,
  still not computable: a recorded baseline stores a pass rate per metric, not a total. The
  warning now says that rather than describing a later phase.
- **`aid trace export`, `aid eval --from-traces`.** Proposed in §4.4.
- **`ir/eval-coverage`.** Proposed in §5.4. Deferred with the agent-eval emitter: it would
  otherwise refuse every enterprise spec that declares an agent.
- **Percentile alarms on a backend that cannot compute them from a histogram.** Unverified.
- **Azure and Kubernetes targets.** Not built, not proposed.
- **Generated dashboards.** Nothing exists; `aid report` is the fleet view and it reads files.

Shipped and verified this round, for contrast: templates end to end; overlays with
`aid resolve` and `aid fleet`; `aid report`; profile gates; HITL pause and resume; agent
budgets; the ts-vercel OTLP refusal; `ir/eval-trajectory`; `ir/alerts-unproduced`; the
promotion quality policy; alarms-as-infrastructure generation with real producers;
`cost`/`latency` eval metrics measured end to end.

Built in `aid-runtime` but not yet reachable from a spec: `Trajectory`, `RunOutput` and the
`tool-trace` metric.

## 11. Open questions for review

1. **Do the four series get published by the app, or derived by a collector?** §4.1 picks the
   app. The collector path needs no runtime change but ships an artifact to operate, which
   contradicts the standard profile's low-ops promise. Recommend the app.
2. **Percentile support.** `eval.latency.p95` as an OTLP histogram needs the backend to
   compute a percentile. CloudWatch and Cloud Monitoring differ here and neither was
   verified. Should an unsupported pairing be refused by name (`ir/alerts-percentile`) or
   documented? Recommend verifying first, then refusing only where clearly unsupported.
3. **`tool-trace` matching semantics.** **Resolved, in code.** `expect` is a subsequence
   when `ordered`, a set otherwise; extra tools are tolerated either way; a tool called twice
   satisfies an `expect` naming it once. The rationale is in the `ToolTrace` docstring: extra
   work is more than the minimum, so failing it would benchmark one exact transcript rather
   than a capability, and "how often" is a budget question `cost` answers. No `exact: true`
   was added — nothing asked for it.
4. **`Trajectory` on `CaseOutcome` versus a subclass.** **Resolved: the optional field.** It
   keeps one model and one baseline format, and it makes "the runner reported no trajectory"
   a state the metric can refuse rather than a type that cannot be constructed.
5. **What baseline identity does an agent eval promote against?** Still open, and it blocks
   nothing shipped this round: no generated agent eval exists yet. `gate.promotion.baseline`
   is `{ prompt, version }`, and an agent run is not a prompt. Options: allow
   `baseline: { agent: <id>, version: <n> }`, or key agent evals on the prompt the agent's
   first step uses. It must be decided in the increment that emits an agent eval.
6. **Retract or fix forward on alarms** — §12.

## 12. Decision requested

Everything below needs a decision before Phase 1 starts. Phases 1 and 5 are uncontroversial
and can start immediately on approval of this RFC.

**Decision 1 — the alarm defect.** Two ways to restore the truth:

- **(a) Fix forward (recommended).** Ship §4.1 in Phase 2, ~3–4 days. The feature becomes
  true, the docs become corrections, and the four series start feeding `aid report` and
  Phase 3's cost measurement. The false claim stands for the length of the phase.
- **(b) Retract now, fix later.** Refuse `observability.alerts` with a named diagnostic in a
  single small commit, move the features entry to "refused, on purpose", then do §4.1
  whenever. Costs a spec minor bump and two doc rewrites, and breaks a document that
  validates today.

Recommend **(a)**, with (b) as the fallback if Phase 2 slips. The defect is a gap between
claim and behaviour, not a safety hole — nothing fires, which is the failure mode, and
nobody is relying on a firing alarm yet.

**Decision 2 — open question 3** (`tool-trace` matching) needs an answer before Phase 3
starts, not before Phase 1.

**Decision 3 — approve phases 1–2 as one PR or two?** Recommend two: Phase 1 is docs,
registry and template data; Phase 2 is runtime and gates. Different reviewers, different
risk.

No feature code has been written for any phase. This RFC is the deliverable.
