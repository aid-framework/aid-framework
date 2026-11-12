# RFC 0003 — Agents at scale, round 3: verification and the agent-eval gap

| Field | Value |
| --- | --- |
| Status | **Draft — awaiting review** |
| Author | Agent-assisted verification, 2026 |
| Phase | 0 (verify only). No feature code in this document. |
| Affects | `ir` gates, both generators, `runtimes/python`, `cli` (`eval`, `trace export`), `docs/`, `site/scripts/features-data.mjs` |
| Supersedes | nothing; continues [RFC 0001](./0001-agents-at-scale.md) and [RFC 0002](./0002-agents-at-scale-round-2.md) |

> **Nothing proposed here is built.** Every statement about current behaviour cites the file
> and line that proves it or the command whose output produced it. Where round 2 and this
> round disagree, this round wins: round 2 was written before `0.1.152`, which shipped the
> producer round 2 declared missing.

---

## 0. Summary

Five checks, run against `origin/main` at `b99c88f` (release `0.1.156`):

| # | Check | Verdict |
| --- | --- | --- |
| 1 | Alarm producer exists and one alert traces end to end | **PASS**, one example-level gap |
| 2 | `aid trace export` applies redaction, PII rules, staging path | **FAIL** — redaction is documented and does not exist |
| 3 | PRs #183/#184, templates on 0.30, `customers/` overlay, `aid fleet` on fresh init, registry entries | **PASS** |
| 4 | Release and PR titles agree with the spec changelog | **FAIL** — two artifacts say `0.19`, the changelog says `0.25` |
| 5 | Homepage/features/reference agree on version | **PASS** — derived, test-pinned, deployed value correct |

Three findings decide the round:

1. **The alarm defect is fixed, not pending.** `0.1.152` shipped the producer: a
   `MeterProvider` behind `configure_metrics()`, four instruments, and a recording point at
   each place the deploy plan derives a budget. `ir/alerts-unproduced` refuses an alert whose
   series the chosen target never writes. **Phase A is therefore mostly already shipped**, and
   is reduced below to three small corrections.
2. **The one real lie is redaction.** `docs/reference/spec.md:851` says `observability.redact`
   strips fields "from a span before it leaves the process". The runtime says the opposite in
   as many words (`runtimes/python/src/aid_runtime/tracing.py:197`: *"Nothing here redacts."*),
   and `aid trace export` applies no rule from either `observability.redact` or
   `observability.feedback.pii`. This is Phase D, and it is the only FAIL that is a false
   claim rather than a label.
3. **The main blocker is unchanged.** The generator still refuses every `agent:` eval target
   and every `tool-trace` metric (`packages/ir/src/gates/observability.ts:79-115`), because no
   generated runner reports the tool calls a case made. Phase B is the work that matters and
   is the largest item in this plan.

---

## 1. Method

Executed in the worktree, not read off the brief:

- Searched the whole tree for `MeterProvider`, `configure_metrics`, `OTLPMetricExporter` and
  `record_agent_run`, then read the producer, the gate, the derivation, the emitter, the
  fixture and the registry entry that each belongs to.
- Read all of `packages/cli/src/commands/trace-export.ts` and grepped it for
  `redact`/`pii` — zero occurrences. Read the two declaration sites of the field
  (`spec.md`, `tracing.py`) against every consumer of `observability.redact`.
- Scaffolded both golden-path templates into throwaway directories
  (`aid init support-copilot --template support-copilot`,
  `aid init ent --template enterprise-approvals`) and ran `aid validate app/app.spec.yaml`
  and `aid fleet` in each.
- Listed all 250 pull requests and filtered titles on `/spec\s*0\.\d+/`; fetched 100 release
  bodies and compared each spec-version label to `docs/reference/spec-changelog.md`.
- Fetched the deployed site and read `site/.vitepress/config.mts` and
  `site/scripts/support-data.mjs` to find where each published number comes from.

---

## 2. Item 1 — the alarm producer — **PASS**

One alert, traced from the document to the resource that watches it:

| Step | Where |
| --- | --- |
| `observability.alerts[].metric` is a closed enum | `packages/ir/src/shapes.ts:497-502` (`ALERT_METRICS`), mirrored in the schema at `packages/spec/src/schema/spec.schema.json:2126` |
| The gate refuses an alert with no exporter, no producer, or an uninterpretable aggregate | `packages/ir/src/gates/observability.ts:217` — `ir/alerts-unexported` (:233), `ir/alerts-unproduced` (:257), `ir/alerts-aggregate` (:271) |
| A test pins the enum to the derivation | `packages/ir/test/gates/alerts.test.ts:34-46` asserts `ALERT_METRICS` equals the `DeployAlarm['metric']` keys; `:195-229` asserts the four refusals and their hints |
| The deploy plan derives each alarm from a declared budget | `packages/ir/src/deploy-plan.ts:600-630` |
| The emitter writes the provider resource | `packages/cli/src/infra/modules/alerts.ts`; byte-asserted at `packages/cli/test/fixtures/infra/generated/modules/alerts/main.tf:18` (`metric_name = "agent.cost"`) |
| The metric is *recorded* by the runtime | `runtimes/python/src/aid_runtime/metrics.py:38` (`METRIC_NAMES`), `:55`/`:62` (the `aid.agent.id` / `aid.eval.id` dimensions the alarms filter on), `:107` `record_agent_run`, `:122` `record_eval_case` |
| The metric is *exported* by the runtime | `runtimes/python/src/aid_runtime/telemetry.py:255` `configure_metrics()` — `MeterProvider` + `OTLPMetricExporter`, installed only when called |
| The generated app exposes the call | `examples/support-copilot/app/generated/observability.py:111` `metrics_export_status()` |
| The target declares it can write series | `packages/generators/py-fastapi/src/manifest.ts:65-68` declares the `metrics` capability |

The "valid document, silent alarm" case from RFC 0002 §0 is now refused rather than silent:
`alertsGate` emits `ir/alerts-unproduced` naming the target that would have written nothing,
and `ts-vercel` — which declares no `metrics` capability — refuses every alert for that reason.

**Two gaps, both small, neither a runtime defect:**

- **The golden path never turns it on.** `examples/support-copilot/app/main.py:13,20` and
  `examples/guarded-reply/app/main.py:12,18` call `tracing_export_status()` and never
  `metrics_export_status()`, which is generated three lines away in the same module
  (`examples/support-copilot/app/generated/observability.py:111`). A team that copies the
  template gets spans and no series, so its alarms still never fire. The ownership boundary is
  correct — the ASGI entrypoint is the developer's — but the only worked example of that
  entrypoint does not show the second call.
- **The `ts-vercel` refusal is not in the support matrix.** `docs/reference/support.md` has no
  target-capability section at all (headings at `:9`, `:23`, `:36`, `:59`), so the one place a
  reader looks for "what does this target refuse" is silent about alerts.

Verdict: **PASS** on the runtime and the gate; the two gaps above become Phase A′.

---

## 3. Item 2 — `aid trace export` — **FAIL**

What holds, verified by reading `packages/cli/src/commands/trace-export.ts` end to end:

- Refuses a missing `--dataset`, an unparseable `--filter`, a directory with no exportable
  payloads, and an existing output file without `--force` (`writeFileSync` with `flag: 'wx'`,
  `EEXIST` → `traceExportWouldOverwrite`).
- Writes canonical, Python-compatible JSON (`sort_keys`, `ensure_ascii`), so a regenerated
  dataset diffs cleanly against one the Python `Dataset` wrote.
- Tags every exported case `['trace-export','unreviewed']`, which correctly says `expected` is
  a recording of behaviour and not a judgement.
- `docs/reference/cli.md:228-247` documents the command truthfully: it makes no redaction
  claim, so there is nothing to retract there.

What fails:

| Gap | Evidence |
| --- | --- |
| **G1 — redaction is documented and does not exist.** `spec.md:851` says `redact` names "the fields to strip from a span before it leaves the process" | `tracing.py:197-200` states *"Nothing here redacts. A captured prompt is captured as it was sent … the spec's `pii.redact` governs the deployed feedback path, not this local switch."* The runtime is right; the reference is wrong |
| **G2 — `observability.redact` has no transformer consumer.** Every consumer validates or reports; none strips | Consumers are `packages/ir/src/gates/security.ts:130`, `py-fastapi/src/validate.ts:204`, `ts-vercel/src/validate.ts:280` (gates) and `py-fastapi/src/emit/observability.ts:63`, `ts-vercel/src/emit/infrastructure.ts:375` (report emitters). The list reaches the generated metadata report and stops there |
| **G3 — `observability.feedback.pii` is not applied on export.** The feedback gate refuses an under-covering redaction set *for the deployed feedback path*, and nothing carries that set into `aid trace export` | The command mentions neither `pii` nor `redact`; a case's recorded prompt is copied verbatim |
| **G4 — no staging-path concept.** The brief's "write only to a staging path (never into a gating dataset)" does not exist in any form; `--out` writes wherever it is told | `trace-export.ts` accepts any path; its only protection is the overwrite refusal. The convention that `datasets/` is a gating input lives nowhere in code or docs |
| **G5 — no gate prevents exporting a field the spec marks sensitive.** A trace directory is not a spec input, so no gate sees it | Nothing in `packages/ir/src/gates/` reads a dataset |

The honest reading: **capture is deliberately unredacted and the operator owns that choice**
(`AID_TRACE_CONTENT`, `tracing.py:190-220`), which is defensible for a local debugging switch.
What is not defensible is a reference page telling a reader the spec field strips fields
"before it leaves the process" while the export command — the one path that moves captured text
into a file that may become a gating dataset — applies no rule from that field.

Phase D exists for these five gaps, and G1 is a doc correction that can ship before the code.

---

## 4. Item 3 — templates, overlays, fleet, registry — **PASS**

- PRs [#183](https://github.com/aid-framework/aid-framework/pull/183),
  [#184](https://github.com/aid-framework/aid-framework/pull/184) and
  [#185](https://github.com/aid-framework/aid-framework/pull/185) are all `MERGED`.
- Templates are on **`specVersion: "0.30"`** (`packages/cli/src/templates.ts:49` and `:179`),
  not 0.29, and both declare `overridable` (`:60`, `:190`).
- **`support-copilot` does scaffold `customers/`.** Fresh `aid init support-copilot --template
  support-copilot` produced `app/app.spec.yaml`, `README.md`, `customers/acme-eu.yaml`; the
  overlay emission is `templates.ts:546`.
- **`aid fleet` succeeds on a fresh init**, both templates:

  ```text
  customers/acme-eu.yaml →  1 customer under .
    acme-eu     standard    gpt-4o-mini  eu-west-1  $0.01  ok
  customers/contoso-us.yaml →  1 customer under .
    contoso-us  enterprise  gpt-4o-mini  us-east-1  $2.50  ok
  ```

  `aid validate app/app.spec.yaml` reports `ok (0 errors, 0 warnings)` in both.
- **`humanInTheLoop` and `state` are registered**: `site/scripts/features-data.mjs:254`
  (`human-in-the-loop`, since `0.1.27`) and `:262` (`durable-state`, since `0.1.143`).
  Counts are computed from the registry (`:777-783`) with a partition assertion, so the
  published total is not hand-maintained.

One mismatch worth recording, though it is not a defect: the **committed**
`examples/support-copilot/` tree has no `customers/` directory, while the scaffold does. The
example is a byte-asserted generation fixture and pinning an overlay into it would mean
regenerating that fixture for every overlay change; the scaffold is what a customer receives.
Phase E keeps the test on the scaffold and leaves the fixture alone.

---

## 5. Item 4 — release and PR title hygiene — **FAIL (two artifacts)**

`docs/reference/spec-changelog.md:16` is unambiguous: **`0.25` adds `profile`**.
`0.19` is the retriever's `refresh.mode: incremental` (`:22`). Every docs page that describes
the profile work says 0.25 — `migration.md:25-43`, `walkthroughs/enterprise-profile.md:23`,
`usage.md:527`, and RFC 0001's own as-shipped table (`0001-agents-at-scale.md:713`).

Scanned all 100 release bodies and 250 PR titles. Exactly two disagree:

| Artifact | Says | Should say |
| --- | --- | --- |
| Release `v0.1.142` body | "feat: spec 0.19 tier profiles, delivery placement and the audit sink (RFC 0001 Phase 1)" | `0.25` |
| PR #171 title | "feat: spec 0.19 tier profiles, delivery placement and the audit sink (RFC 0001 Phase 1)" | `0.25` |

Every other labelled PR agrees: #172 `0.26`, #174 `0.27`, #175 `0.28`, #176 `0.29`,
and #164 `0.23`, #167 `0.24`, #162 `0.21`, #163 `0.22`.

Remediation follows the brief: correct the docs (the docs are already correct), edit the PR
title in place, and add a **correction note** to the changelog rather than rewriting published
release history.

---

## 6. Item 5 — site version consistency — **PASS**

Nothing is hand-maintained, so nothing can drift:

| Published number | Source |
| --- | --- |
| Homepage "ship together at version **x**" | `docs/index.md:187` writes `{{ AID_VERSION }}`; `site/.vitepress/config.mts:33` substitutes it from `currentVersion()` |
| `currentVersion()` | derives from the shipped manifests, returns `null` rather than guess when they disagree (`site/.vitepress/config.mts:17-23`); `site-version.test.mjs:36-42` asserts every manifest agrees |
| Features page "The spec language is at `0.30`" | **generated**: `site/scripts/gen-reference.mjs:1003` interpolates `data.latestSpecVersion`, which is the last entry of `parseSpecVersions(schema)` (`site/scripts/support-data.mjs:348`) |
| Reference "The current spec language version is `0.30`" | generated from the same value (`gen-reference.mjs:919-921`) |
| Deployed homepage | reports **`0.1.156`**, matching the manifests |

Three tests hold it: the homepage must contain the token and must not contain a hardcoded
version; the homepage must stay free of spec-version strings, which is
also why the spec number lives on the reference instead; and the reference must state the
newest `SUPPORTED_SPEC_VERSIONS` entry (`site-version.test.mjs:45,49-62`).

There is no deploy-workflow or cache fault to report: the homepage and features page are
rendered from the same build that reads the manifests, and the deployed value is current.

---

## 7. Where this repository contradicts the brief

The brief says "verify, do not assume". Verified:

| Brief says | Repo says |
| --- | --- |
| Alarms FAIL; no `MeterProvider` anywhere; four series have no producer; gate accepts a silent alarm | **Fixed in `0.1.152`.** `telemetry.py:255`, `metrics.py:38-140`, `observability.ts:257`. Phase A is reduced to Phase A′ |
| Golden-path templates pinned to spec 0.29 | **0.30** (`templates.ts:49,179`) |
| `support-copilot` scaffolds no `customers/` overlay, so `aid fleet` fails on fresh init | **It does**, and `aid fleet` succeeds on both templates (`templates.ts:546`) |
| Registry undercounts `humanInTheLoop` and `state` | **Both registered** (`features-data.mjs:254,262`); counts are computed |
| A release note labels tier profiles "spec 0.19" (singular, vague) | Exactly **two** artifacts, both identified above; the docs are correct |
| `aid trace export` may not write to a staging path | There is no staging-path concept to violate — `--out` writes anywhere, which is gap G4 |
| CLI reference "now lists `aid trace export --dataset`" | It does (`cli.md:228-247`) and makes no redaction claim, so the false claim is only `spec.md:851` |

The one place the brief is more right than the repo: `observability.redact` **is** documented
as an active transform, and it is not one (item 2, G1).

---

## 8. Phase order, effort and the smallest first increment

Order is set by dependency, not by size: A′ and D-G1 are corrections to claims the repo already
makes and can ship first; B unblocks C (an agent baseline needs an agent runner to have produced
it); E carries whatever copy B and C make true.

| Phase | What actually remains | Effort | Smallest shippable increment |
| --- | --- | --- | --- |
| **A′** | Examples call `metrics_export_status()`; support matrix gains a target-capability section naming the `ts-vercel` alert refusal | **0.5 d** | Two example entrypoints, one table in `support.md`, no spec change |
| **B** | Generated `agent:` eval runner in `py-fastapi` (trajectory, handoffs, steps, cost, final answer); offline via the fake provider; three new deterministic metrics (`step-count`, `forbidden-tool`, `approval-respected`); narrow `ir/eval-trajectory`; add `ir/eval-coverage` for `enterprise` | **8–10 d** | One `agent:` eval that runs offline end to end and scores `tool-trace`, with the two remaining refusals narrowed to name their missing piece |
| **C** | `baseline` keyed by subject `{ kind: prompt\|agent, id, version }`; `RecordedBaseline` carries mean cost and latency per metric; `--compare` judges `allowedCostIncrease`; old baselines read as "not recorded" and refuse the cost judgement | **4–5 d** | `RecordedBaseline` with a `cost` field + `aid eval --compare` refusing a cost judgement it cannot make, instead of passing it |
| **D** | G1–G5: implement redaction (or correct the doc and delete the field's claim), apply `feedback.pii` on export, staging path, walkthrough of the full loop | **3–4 d** | Fix `spec.md:851` to describe what happens, then implement the filter in `tracing.record_content` / export |
| **E** | Template + fleet test, registry entries (done), the two label corrections, `docs/guide/delivery.md`, homepage copy the phases changed | **2–3 d** | The template/fleet integration test and the two label corrections, which need no feature code |

**The single smallest first increment is Phase A′.** It is under a day, needs no spec bump, and
turns a capability that already shipped into one the golden path actually exercises; today a
reader who follows the template copies an entrypoint that installs its tracer and forgets its
meter.

---

## 9. Open questions for review

1. **Q1 — does `observability.redact` become real, or does the claim go?** Option A implements
   it as a span/record filter in the runtime and applies the same set in `aid trace export`.
   Option B narrows the reference to what exists (the field governs the feedback store and the
   generated metadata report) and drops the "before it leaves the process" sentence. Option A
   is the honest reading of the profile promise; Option B is the honest description of the
   code. **Recommendation: A, with B as the doc correction that ships immediately** — an
   enterprise profile that promises an audit trail cannot leave the redaction of that trail
   undefined.
2. **Q2 — should the generated ASGI entrypoint call `metrics_export_status()`?** It would make
   alarms fire without a manual step, and it breaks the boundary that the entrypoint belongs to
   the developer (stated at `spec.md` §`observability`). **Recommendation: no** — fix the
   example and the template README instead, so the boundary stands and the golden path still
   shows both calls. Revisit only if a second customer hits it.
3. **Q3 — `ts-vercel` metrics.** Implement an OTLP metric exporter there, or keep the
   `ir/alerts-unproduced` refusal? **Recommendation: keep the refusal, document it in the
   support matrix** (Phase A′). The target's story is serverless and a collector is the
   customer's platform, which is exactly the kind of pair this framework refuses rather than
   approximates.
4. **Q4 — does Phase B need a spec bump?** `agent:` already parses from `0.27`
   (`spec.schema.json:900`), so the target itself is grammar, not new language. The three new
   eval metric kinds are new enum values, so they need `0.31` plus a spec-changelog entry and a
   migration note that reads "0.30 documents are unaffected; 0.31 adds metric kinds a 0.30
   document cannot spell". `ir/eval-trajectory` narrowing is not a language change.
5. **Q5 — the enterprise coverage rule.** `ir/eval-coverage` must be satisfiable by both
   templates on the day it lands, or `enterprise-approvals` stops validating. It needs to be
   satisfiable at `0.31` only, following the profile-requirement-set rule from RFC 0001 §3.
6. **Q6 — whom does `--filter agent=<id>` mean for an overlay?** Unchanged this round; noted
   because Phase C's subject key will have to answer the same question for baselines.

---

## 10. Appendix — reproductions

```sh
# Item 3: both templates on a fresh scaffold
aid init support-copilot --template support-copilot   # creates customers/acme-eu.yaml
cd support-copilot && aid validate app/app.spec.yaml  # ok (0 errors, 0 warnings)
aid fleet                                             # 1 customer, ok, exit 0

aid init ent --template enterprise-approvals          # creates customers/contoso-us.yaml
cd ent && aid validate app/app.spec.yaml              # ok (0 errors, 0 warnings)
aid fleet                                             # 1 customer, enterprise, ok, exit 0
```

```sh
# Item 4: the only spec labels that disagree with the changelog
gh release list --limit 14          # v0.1.142 body says spec 0.19
gh pr list --state all --limit 250  # #171 title says spec 0.19
# docs/reference/spec-changelog.md:16 -> 0.25 is `profile`
```

```sh
# Item 5: the deployed page and the manifests agree
curl -s https://aid-framework.github.io/aid-framework/ | grep -o '0\.1\.1[0-9][0-9]'  # 0.1.156
node -e "console.log(require('./release.config.json').packages.length)"               # manifests it reads
```

The "valid document, silent alarm" case is now covered by an existing test rather than a new
reproduction: `packages/ir/test/gates/alerts.test.ts:195-229` asserts the four refusals, and
`:34-46` fails if a metric is named without a derivation or derived without a name.
