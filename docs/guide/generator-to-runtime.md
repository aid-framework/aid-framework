# Generator to runtime

Generated code is thin on purpose. It imports a runtime library, wires the spec's specifics into
it, and stays readable. There is no framework control plane, no proxy and no sidecar: a generated
route calls into `aid_runtime` (Python) or `@aid-framework/runtime` (TypeScript) **in process**.

```python
from aid_runtime import GuardrailBlockedError, PipelineError
from aid_runtime import Pipeline

hello_pipeline = Pipeline.of(reply)
```

## The runtime's stated boundaries

The Python package opens by naming four deliberate limits, and they are worth reading before
assuming a feature exists:

- **Control flow is plain async code.** No graph, no scheduler, no orchestration engine.
- **Pydantic AI is used only for structured output.** Nothing else is delegated to it.
- **Streaming is SSE, served end to end.** A model and adapter that advertise the capability are
  served by `ModelGateway.stream`, which yields `data` frames. Anything that does not advertise it
  raises `CapabilityMismatchError` instead of pretending to stream.
- **One HTTP provider adapter and one fake.** Breadth of vendor coverage is not the goal; a
  narrow correct seam is.

## The pipeline is a reducer

`pipeline.py` documents the engine exactly: a sequential reducer over an **immutable** context.
Each step receives the context and returns the context, optionally enriched.

That shape is why composite steps compose with leaf steps by one rule. `control.py` provides
`branch`, `parallel`, `map_step` and `reduce_step`, and they communicate through reserved context
keys rather than extra arguments:

```python
from aid_runtime.control import DEPTH_KEY, INDEX_KEY, ITEM_KEY, LIMITER_KEY, PRINCIPAL_KEY
```

`MAX_STEP_DEPTH` bounds nesting, `PRINCIPAL_KEY` carries the authenticated caller that `branch`
reads, and `LIMITER_KEY` carries the one concurrency limiter every fan-out draws from. The
context also records what ran: `Pipeline.run` writes the executed steps under `STEPS_KEY`
(`"steps"`), which is what a trace and a test can assert against.

`StopPipeline`, raised from a step, ends the pipeline **successfully** and early. It is a
control-flow signal, not an error.

## Leaf steps take resolved inputs

`steps.py` builds the four leaves - `retrieve`, `tool`, `generate`, `emit` - as ordinary `Step`
values. The docstring states the boundary that keeps one rule in one place:

> Every factory takes its inputs **already resolved**: the query string, the argument mapping,
> the prompt values. Interpolating a spec template against the context is the *emitted step body's*
> job.

So <code v-pre>{{ ... }}</code> interpolation happens once, in generated code, and the runtime never re-implements
it. The same factories exist so a test or a conformance runner can drive one step kind without
re-writing its binding rule - which is where two implementations would drift apart.

## What each runtime module owns

| Module | Responsibility |
| --- | --- |
| `gateway.py` | Model aliases, params, fallbacks, `generate()` and `stream()`. |
| `prompts.py` | The prompt registry: versioned templates and their variable contracts. |
| `structured.py` | The retry loop that turns prose into a validated model (`run_structured`). |
| `tools.py` | `ToolExecutor`: validation, timeout, error outcomes, the `business/` mapping. |
| `agents/guardrails.py` | `GuardrailEngine` and `GuardrailVerdict` - the policy evaluator. The generated `app/generated/guardrails.py` supplies the declaration table, `ENGINE`, `enforce_guardrail` and `guardrail_block`. |
| `concurrency.py` | `ConcurrencyLimiter` - one cap per process. |
| `cost.py` | `Budget`, `CostLedger`, `estimate_cost_usd`, `SpendSummary`. |
| `evals/` | Dataset loading, metrics, the gate, the runner. |
| `retrieval/` | Chunking, embedding, hybrid search, rerank, citations, pgvector. |
| `agents/` | The agent loop, checkpoints, HITL, memory stores, `Principal`. |
| `tracing.py` | `get_tracer`, `record_exception`. |
| `cache.py` | `CompletionCache` - Python ships it; TypeScript does not. |

The TypeScript runtime is structurally parallel: `agents/`, `evals/`, `retrieval/`, `gateway.ts`,
`pipeline.ts`, `steps.ts`, `structured.ts`, `tools.ts`, `prompts.ts`, `concurrency.ts`,
`control.ts`, `cost.ts`, `tracing.ts`, `errors.ts` all exist under the same names. Where they
differ, they differ on purpose, not by omission - Python has `cache.py`, and TypeScript has
`internal/json.ts` and `internal/text.ts` for the same parsing concerns. The conformance suite is
what keeps the two honest rather than a convention: see [Conformance](../reference/conformance.md).

## Errors are a contract

`errors.py` defines the exceptions the generated routes branch on, and the mapping is stable:

- `GuardrailBlockedError` ? HTTP **400**, via `guardrail_block(exc)`.
- `PipelineError` ? HTTP **502**, because a downstream model or tool failed.
- `StructuredOutputError` (a `PipelineError`) ? **502**, after the retry loop exhausts its
  attempts. Seeing this against `provider: fake` is expected, not a bug.

That taxonomy is why a generated route is nine lines and still distinguishes "refused" from
"broke" - the distinction lives in the runtime's exception types, not in generated `if`s.

Read next: [Runtime to CLI](runtime-to-cli.md) - who drives all of this from a terminal.
