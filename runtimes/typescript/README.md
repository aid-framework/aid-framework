# `@aid-framework/runtime`

The TypeScript runtime for [AID Framework](https://github.com/aid-framework/aid-framework): the library a
generated application calls at runtime. Pin a model, run a prompt, call a tool, trace it, stay inside a budget,
and prove that quality did not regress.

Generated code is thin glue. This is where the behaviour lives — which is why it is a normal dependency of the
generated app, not part of the compiler.

## Install

```sh
npm install @aid-framework/runtime
```

Requires Node.js 24 or newer. Ships as ESM with TypeScript declarations. `zod` is used for structured output and
nothing else.

## Quick start

A gateway resolves aliases to pinned models, enforces budgets, records cost and opens a span per call:

```ts
import {
  Budget, ModelGateway, OpenAICompatibleProvider, PinnedModel,
} from '@aid-framework/runtime';

const gateway = new ModelGateway({
  providers: {
    'openai-compatible': new OpenAICompatibleProvider({ apiKey: process.env.OPENAI_API_KEY }),
  },
  aliases: {
    small: new PinnedModel({
      alias: 'small',
      spec: {
        name: 'gpt-4o-2024-08-06',
        provider: 'openai-compatible',
        contextWindow: 128_000,
        maxOutputTokens: 4_096,
        cost: { inputPer1kUsd: 0.0025, outputPer1kUsd: 0.01 },
      },
    }),
  },
  budget: new Budget({ maxUsd: 5, scope: 'nightly' }),
});

const result = await gateway.generate('small', { prompt: 'hello' });

result.text;
result.usage;
result.costUsd;
result.attempts;  // every alias tried, in order
result.fellBack;
```

**An alias resolves to an exact, pinned model id.** That is not cosmetic: a baseline recorded against `gpt-4o`
means nothing if the alias floats to a later snapshot on the next run. An unknown alias therefore raises
`UnknownModelAliasError` rather than falling through to a provider default.

## A pipeline

Control flow is plain async TypeScript. There is no graph engine and no orchestration framework: a generated app
is ordinary code that is easy to read, step through and test.

```ts
import { Pipeline, PipelineContext } from '@aid-framework/runtime';

const pipeline = new Pipeline([
  { name: 'load', run: (ctx) => ctx.withValues({ question: ctx.require('request').question }) },
  { name: 'answer', run: async (ctx) => ({ answer: await ask(ctx.require('question')) }) },
]);

const result = await pipeline.run(new PipelineContext({ request }));
```

`PipelineContext` is immutable — `get` / `require` / `withValues` — so a step cannot mutate what an earlier step
observed, and a failed run's state stays inspectable. Each step runs in its own span; a step that throws aborts
the run with the original error chained; `StopPipeline` is the supported early exit. A pipeline rejects an empty
or duplicate-named step list at construction.

Composite steps — `branch`, `parallel`, `mapStep`, `reduceStep` — are provided as step builders, with bounded
nesting (`MAX_STEP_DEPTH`).

## What is in the package

| Area | Exports | Notes |
| --- | --- | --- |
| Types | `Message`, `ModelSpec`, `PinnedModel`, `TokenUsage`, `CompletionRequest`, `CompletionResponse`, `Capability` | The vocabulary everything else is typed against |
| Errors | `AidRuntimeError` and 25 subclasses | One base, so an app catches framework refusals in one place |
| Gateway | `ModelGateway`, `estimateUsage` | Pinned aliases, capability negotiation, ordered fallback, budget preflight |
| Providers | `OpenAICompatibleProvider`, `FakeProvider`, `supports` | One HTTP adapter, one deterministic fake, plus the `Provider` protocol |
| Decisions | `DecisionClient`, `DecisionQuestion`, `decisionKey` | TypeSafe AI (Jev) typed decisions: `choice`, `score`, and `noul` answers |
| Cost | `Budget`, `CostLedger`, `estimateCostUsd` | Pre-call enforcement, per-call ledger entries, spend summaries |
| Tracing | `getTracer`, `llmSpan`, `recordUsage`, `recordCost`, `recordException` | OTel GenAI semantic conventions; AID values namespaced `aid.*` |
| Prompts | `PromptRegistry`, `PromptTemplate`, `Example` | Versioned registry, typed rendering, few-shot assembly |
| Tools | `Tool`, `ToolExecutor`, `validateArguments` | Schema-validated dispatch over a documented JSON-Schema subset |
| Structured output | `buildAgent`, `parseStructured`, `runStructured`, `repairPrompt` | Parse/repair loop over zod schemas |
| Pipelines | `Pipeline`, `PipelineContext`, `StopPipeline`, `branch`, `parallel`, `mapStep`, `reduceStep` | Sequential reducer over an immutable context |
| Concurrency | `ConcurrencyLimiter`, `holdsSlot` | Bounded in-flight work, including inside composite steps |
| Policy | `evaluatePolicy`, `Principal`, `POLICY_BUILTINS` | Tool-auth expressions, fail-closed |
| Agent loop | `agents/*` | Native loop: transfer vs. delegate, budgets, degrade, memory, HITL checkpoint |
| Evals | `Dataset`, `EvalCase`, `runEvaluation`, `BaselineGate`, `EvalBaseline` | N-run sampling and the statistical gate |
| Metrics | `ExactMatch`, `NormalizedContains`, `JsonSchemaValid`, `LlmJudge` | Plus `defaultMetrics` and `metricNames` |
| Retrieval | `Retriever`, `RetrievalGate`, `chunkDocument`, `openConnector`, `createStore`, `fuse` | Connectors, chunkers, embedders, stores, hybrid search, reranking, citations |

## Model pinning and capability checks

`gateway.require(alias, capabilities)` checks **both** sides — the model's declared capabilities and the
adapter's ability to serialize them — and returns the pinned model. A model that supports tool calling behind an
adapter that does not serialize tool definitions cannot tool-call, and `CapabilityMismatchError` names what is
missing rather than failing later at the provider.

`generate(alias, request, { fallbacks })` tries the alias, then each fallback **in the order given**. Fallbacks
are ordered, not conditional, and `result.attempts` reports what was actually tried.

## Streaming

`gateway.stream(alias, request)` is an `AsyncGenerator<string, void, undefined>` that yields **SSE frames**, not
bare deltas: each chunk is a `data: {...}` frame with a `delta` field, and the generator ends with one terminal
frame carrying `done: true`, the finish reason, the model and the provider. A route can pipe it straight into a
`Response` with `text/event-stream`.

The same pre-flight a `generate` call performs runs first. `require(alias, ['streaming'])` refuses a model or
adapter without the capability with `CapabilityMismatchError`, and the budget check runs before the provider is
called. An adapter that advertises streaming without implementing `Provider.stream` fails with
`ConfigurationError` — advertising a capability is not the same as honouring it.

Usage and cost are charged once, when the provider stream completes. A stream that fails mid-flight charges
nothing, so a partial response is never billed as a complete one. When the adapter reports no usage, usage is
estimated from the emitted text rather than recorded as zero. Abandoning the iterator (`return()`) closes the
provider iterator and releases the concurrency slot immediately, so a client that disconnects cannot starve the
limiter.

The fake and OpenAI-compatible adapters implement streaming. Anthropic, Bedrock, Gemini and Vertex do not yet,
and a route that requires streaming on them is refused rather than buffered.

## Decisions are not chat

`DecisionClient` calls TypeSafe AI's Jev (`POST /v1/systemone`), which takes a state plus typed questions and
returns typed answers instead of prose. It is deliberately not in `providers/`: every provider there maps
messages to text, and Jev has no text surface, so a pipeline cannot select it as the model that writes an answer.

```ts
import { DecisionClient, DecisionQuestion } from '@aid-framework/runtime';

const client = new DecisionClient();
const response = await client.decide({
  model: 'jev-1.14.0',
  state: { message },
  questions: {
    triage: new DecisionQuestion({
      type: 'choice',
      instructions: 'Which team should handle this',
      criteria: ['billing', 'technical'],
    }),
  },
});
response.answers.triage?.choice;
```

The key is `TYPESAFE_API_KEY` (Vercel's spelling, `TYPESAFE_AI_API_KEY`, is accepted too); `TYPESAFE_BASE_URL`
overrides the host. Two rules matter more than they look: a `noul` answer carries `noul` and **no confidence
field at all**, so a branch on confidence must refuse it rather than default to zero; and
`decide({ ..., reproducible: true })` refuses the moving aliases `jev-latest` and `jev-preview`, which is what
eval scoring needs. Only 429/529 are retried, honouring `retry-after`.

## Evals gate on statistics, not equality

A model is *expected* to vary between runs, so a metric comparing two runs for equality is either always red or
measuring nothing. Non-determinism is the property the gate is built to tolerate:

```ts
import { BaselineGate, runEvaluation, ExactMatch, defaultMetrics } from '@aid-framework/runtime';

const run = await runEvaluation(dataset, runner, defaultMetrics(), { runs: 5 });
const verdict = new BaselineGate(thresholds).evaluate(run, baseline);

verdict.passed;
verdict.metrics; // per-metric z-score, allowance and outcome
```

`runEvaluation` samples the runner **N times** and reports per-run metric means, so one unlucky run does not
decide the verdict. `EvalBaseline.fromRun(run)` stores per metric the sample count, mean and spread; the gate
compares with a one-sided normal test. A metric passes by clearing `minMean`, by staying within `maxRegression`
of the baseline, or by regressing only within sampling noise.

`LlmJudge` is implemented and never CI-required: a gate that depends on one non-deterministic call inside the
gate you are trying to trust is the problem the design avoids.

The arithmetic matches the Python runtime exactly — the same z-critical table, the same baseline comparison, the
same sampling semantics — because a gate whose statistics differed per language would let a TypeScript
regression pass a Python baseline.

## Retrieval

`retrieval/*` is IR-driven: `bindingFromSpec(retriever, { embedding, store })` folds the IR's `retrievers`,
`embeddings` and `stores` entries into one `RetrieverBinding`, which a `Retriever` then ingests and searches.

Chunk ids are content hashes, so re-ingesting the same input produces the same ids and a no-op diff.
`FakeDeterministicEmbedder` hashes with SHAKE-128 and `chunkIdFor` with SHA-256, which is what lets a retrieval
gate run in CI with no network and no key.

`RetrievalMetric` (`RecallAtK`, `MeanReciprocalRank`, `CitationGrounding`) is a separate protocol from `Metric`,
because retrieval scores a *retrieved set* rather than a single string. Retrieval is sampled through
`RetrievalGate.sample(...)` into a standard `EvalRun` and judged by the unchanged `BaselineGate`.

## Limits, stated plainly

- **Streaming covers the OpenAI-compatible wire and the fake.** The Anthropic, Bedrock, Gemini and Vertex
  adapters do not implement `Provider.stream`, so a route that needs it is refused with
  `CapabilityMismatchError` rather than answered with one buffered body.
- **One HTTP provider and one fake.** Breadth of vendor coverage is a later concern; a narrow, correct seam is
  worth more than a wide shallow one.
- `PgVectorStore` needs a live `vector` extension and is not exercised by CI; the in-memory store carries the
  store tests, and both share the same `VectorStore` protocol and `similarity` semantics.

## API

The full surface is the package's named exports; the table above is the map. The one deliberate asymmetry with
the Python runtime is `providers/fake.ts`, which derives its accuracy draw from a SHA-256 hash of
`seed:index:prompt` rather than CPython's Mersenne Twister, because string seeding there is a CPython
implementation detail with no portable equivalent. The draw is still deterministic and still varies per call
index, which is the property the gate depends on.

## Related packages

- [`aid-runtime-python`](https://pypi.org/project/aid-runtime-python/) — the same runtime for Python
- [`@aid-framework/generator-ts-vercel`](https://www.npmjs.com/package/@aid-framework/generator-ts-vercel) — the
  generator that emits apps against this runtime
- [`@aid-framework/cli`](https://www.npmjs.com/package/@aid-framework/cli) — `aid`

## License

[Apache-2.0](https://github.com/aid-framework/aid-framework/blob/main/LICENSE). Code generated by AID Framework is
not subject to this license.
