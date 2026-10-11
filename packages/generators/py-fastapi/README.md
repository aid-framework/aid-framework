# `py-fastapi` generator

The **Phase 0 reference target**: turns the IR into a small FastAPI service wired to the
[`aid-runtime-python`](../../../runtimes/python/) runtime. Generated code is declarative glue — model aliases,
prompt templates, request and response models, routes, tool adapters, eval definitions — and every behaviour
it calls already exists in the runtime ([`docs/design.md` §4](../../../docs/design.md), principle 1: *thin
generated, fat runtime*).

The only input is the IR. `plan` is a pure function of it: nothing here reads a spec file, a template
directory, the environment or the clock, so the same IR always produces the same bytes.

**Emits against** ([`§8.1`](../../../docs/design.md)):

| Key | Value | Why |
| --- | --- | --- |
| `structuredOutput` | `pydantic` | Response models are Pydantic models, so a structured-output call is validated by the runtime's gateway |
| `tracing` | `otel-genai` | Spans follow the OTel GenAI semantic conventions |
| `orchestration` | *absent* | Phase 0 control flow is **plain async**. Orchestration frameworks are deferred to Phase 2 ([`§14`](../../../docs/design.md)), and declaring nothing is what keeps the choice swappable |

`emitsAgainst` is the declaration that makes two targets comparable: a target emitting Pydantic models and an
OTel tracer is not interchangeable with one emitting Zod and Langfuse. This package declares it in
`src/manifest.ts` rather than aliasing the SDK's copy, and a test asserts the two are deeply equal, so either
side drifting is a failing check.

**Emits** (19 files per generated app — [`§8.3`](../../../docs/design.md)):

- **Model gateway wiring** — `gateway/models.py`: one alias per declared model, with provider, model id and
  cost profile, validated against the runtime's adapter registry.
- **Prompt registry wiring** — `prompts/<prompt>.py`: the template, its version, and the typed values it
  interpolates.
- **One structured-output endpoint** — `requests.py`, `schemas.py`, `routes/<pipeline>.py` and
  `pipelines/<pipeline>.py`: the request model, the response model, the route, and the plain-async pipeline
  that renders the prompt, calls the gateway, runs the tool and shapes the response.
- **One tool** — `tools/<tool>.py` plus `contracts/<tool>.py`: a Pydantic-validated adapter over a handler you
  own. The handler itself is seeded once and then yours.
- **One eval** — `evals/<eval>.py`: the dataset loader, the stored baseline, the JSON-schema metric and the
  baseline gate, delegating every statistic to `aid_runtime.evals`.
- **`observability.py`** and **`deps.py`** — tracer setup and the dependency container that the route and the
  eval both build from, so the eval measures the prompt the app actually renders.

Packaging and the entrypoint are **not** generated: `pyproject.toml`, `app/main.py`, the dataset and baseline
JSON, and the tests are hand-written in the example, because a plan may only write into the two managed tiers
below.

**Layout and ownership** ([`§8.4`](../../../docs/design.md)):

| Path | Owner | On regeneration |
| --- | --- | --- |
| `app/generated/**` | the generator | overwritten, never merged |
| `app/business/**` | you | created once if missing, then **never** touched |
| `app/aid.manifest.json` | the generator | rewritten from the plan; not a planned artifact itself |

A generated file whose bytes no longer match the hash recorded in the manifest is **drift**: regeneration
reports it as an error, leaves your edit in place, and writes the content it wanted beside it as
`<path>.aid-rej`. `--force` discards the edit instead (with a warning), and `--prune` deletes generated files
the plan no longer produces ([`§10`](../../../docs/design.md)).

**Determinism** ([`§8.2`](../../../docs/design.md)): output is path-sorted, LF-only, with one trailing newline,
no timestamps, no absolute paths and no machine names. `checkDeterminism` in the generator SDK is the lint that
holds this; a test in this package plans the example twice and compares bytes.

**Not responsible for:** runtime behaviour — the gateway, prompt registry, tool executor, tracing, the eval
harness and the baseline statistics all live in [`runtimes/python/`](../../../runtimes/python/).

**Status:** implemented for the Phase 0 scope. Driven programmatically from this package's tests and from
`scripts/generate-example.mjs`; the CLI that exposes it as `aid gen` is the next layer, not this one.

**Scope boundary:** the generator rejects what it cannot express rather than emitting something broken
([`§4`](../../../docs/design.md), capability negotiation) — retrieval, memory, guardrails, multi-step agent
loops, streaming *bodies* (the capability is declared, not implemented), `llm-judge` as a required CI gate,
latency and cost budgets, and eval metrics selected by field or value.

**Tests:** `test/golden.test.ts` (the example's committed tree *is* the golden fixture), `test/drift.test.ts`
(regeneration safety across both tiers), `test/eval-gate.test.ts` (the gate stays statistical) and
`test/target.test.ts` (this manifest against the SDK's). The example app and its runtime tests are in
[`examples/support-copilot/`](../../../examples/support-copilot/).

Reference: [`docs/design.md` §8](../../../docs/design.md) (generator plugin model),
[`§9`](../../../docs/design.md) (runtime libraries), [`§6.1`](../../../docs/design.md) (example spec),
[`§12`](../../../docs/design.md) (testing), [`§14`](../../../docs/design.md) (roadmap).
