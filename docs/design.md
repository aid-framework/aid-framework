# Polyglot AI App Framework — Design Document

**Name:** AID Framework (command: `aid`)
**Status:** Draft v0.2 — AI-project edition
**Goal:** Let developers *declare* an AI app — models, prompts, tools, retrieval, agents, evals, guardrails — and generate idiomatic, runnable AI services across multiple stacks, so they spend their time on domain prompts, domain tools, and evaluation criteria instead of plumbing.

---

## 1. Vision

> One declarative spec -> idiomatic, runnable AI apps in N stacks, with a clean seam for the developer's business logic (prompts, tools, eval rubrics) and a safety net that actually works for probabilistic systems: **evals**.

The developer writes a spec (models, prompts, tools, retrievers, agents, pipelines, evals, guardrails). The CLI emits a working AI service: provider gateway, prompt registry, structured-output boundaries, RAG ingestion + retrieval, agent loop, tool executor, guardrails middleware, tracing, and an eval harness wired into CI. The developer then fills in only the `business/` tier — their prompts, their tools, their domain rules.

---

## 2. Problem Statement (AI-specific)

Every AI app re-implements the same non-differentiating plumbing, and it is *more* boilerplate than a CRUD app, not less:

- Provider adapters (OpenAI / Anthropic / Azure / Bedrock / Google / Ollama / vLLM) + auth + retries + streaming
- Rate limiting, token budgeting, cost accounting, fallbacks, model routing (cheap vs. strong)
- Prompt templating, versioning, few-shot assembly, and prompt caching
- Structured output enforcement (JSON Schema / zod / Pydantic) + parse-repair loops
- RAG: ingestion, chunking, embedding, vector store, hybrid search, reranking, context assembly, citations
- Agent loop: tool schema generation, tool execution, step/token/cost budgets, handoffs, human-in-the-loop
- Memory: conversation windowing, summarization/compaction, semantic memory
- Guardrails: moderation, PII redaction, prompt-injection/jailbreak defense
- Observability: span-level traces of every LLM/retrieval/tool call, replay, cost dashboards
- Caching: prompt cache, semantic cache, response cache
- **Evals**: datasets, LLM-as-judge, regression thresholds, CI gating
- Serving: streaming, concurrency, autoscaling, batch inference

That is 70–85% of a typical AI service, and none of it is the product. The framework makes that tier *generated, correct, traced, and regenerable*.

### Why now

Two shifts make this the right moment:

1. **Interfaces have stabilized** where it matters: provider HTTP APIs, **MCP** for tools, **OpenTelemetry GenAI** semantic conventions for tracing, JSON Schema for structured output. You can now build on stable layers instead of chasing hype.
2. **Deterministic generation for structure + assisted generation for intent.** Generate the structure deterministically; use LLMs to draft specs from prose and to stub business logic. Never use an LLM to generate structure.

### The hard truth about AI correctness

Generated **code** is deterministic (byte-stable, golden-file tested). Model **behavior** is not. A framework for AI apps must therefore ship *two* testing regimes from day one: golden files for codegen, and an **eval harness** for runtime behavior. A design that ignores this fails at the first model upgrade.

---

## 3. Goals & Non-Goals

### Goals

- Single stack-independent spec as the source of truth.
- Idiomatic generated output per stack — built *on top of* the ecosystem (LangGraph, LlamaIndex, Pydantic AI, Vercel AI SDK, Semantic Kernel), not reinventing it.
- **Edit-safe regeneration**: developer prompt/tool/eval work never fights the generator.
- **Eval-gated CI**: a spec change triggers evals; regressions block merges.
- Provider-agnostic with **pinned models** and capability negotiation.
- Cost, latency, and safety treated as first-class, machine-checkable properties.
- Full eject path (no lock-in).

### Non-Goals (for now)

- Training foundation models. (Phase 4 covers *fine-tuning pipelines*, not pretraining.)
- A general-purpose orchestration language that replaces LangGraph/DSPy/LlamaIndex.
- A hosted platform / inference service. We generate code that deploys anywhere.
- UI chat surfaces (deferred to Phase 4, optional).
- Achieving cross-provider *byte* determinism of outputs (impossible and undesirable) — determinism applies to codegen only.

---

## 4. Guiding Principles

1. **Thin generated, fat runtime.** Behavior lives in a hand-written runtime library per stack; the generator emits small, declarative glue. Keeps regeneration safe and output idiomatic.
2. **The IR is the product.** One normalized intermediate representation; every target consumes only it. Directly generating per-stack from the spec causes N divergent codebases within a month.
3. **Evals are the correctness net.** Codegen is verified by golden files; behavior is verified by eval suites with thresholds. A feature is not "done" until it has an eval.
4. **Pin models, abstract providers.** Model deprecation is the #1 maintenance tax. Bind logic to a stable alias; map aliases to pinned provider/model IDs; declare capabilities, not vendor names.
5. **Build on the ecosystem, don't replace it.** Emit LangGraph/DSPy/LlamaIndex/Pydantic AI for Python and the Vercel AI SDK for TS. Wrap their stable public APIs; keep our runtime thin so the orchestration lib can be swapped.
6. **Structured output is the contract.** Every LLM boundary that feeds code is schema-constrained; repair loops live in the runtime, not in app code.
7. **Cost & latency are first-class.** Budgets live in the IR, are enforced in the runtime, and are gated in CI.
8. **Tools are the new business seam** — and the new attack surface. Every tool declares a side-effect level, permissions, and (for destructive ones) confirmation.
9. **Every LLM call is traced.** Non-negotiable for debugging probabilistic systems. Adopt OTel GenAI semconv; never log raw PII.
10. **Three-tier ownership** (`generated/` · `business/` · hooks) with idempotent, byte-stable output — same discipline as any generator, applied to AI scaffolding.

---

## 5. Architecture

```text
┌───────────────────────────────────────────────────────────────────────┐
│  1. SPEC (source of truth)                                            │
│     models · prompts · tools · retrievers · agents · pipelines ·      │
│     evals · guardrails · memory · deployments                         │
└───────────────────────────────┬───────────────────────────────────────┘
                                │  parse + validate + capability-check
                                ▼
┌───────────────────────────────────────────────────────────────────────┐
│  2. IR  (stack-independent, normalized, versioned)                    │
│     THE CROWN JEWEL — every target consumes only this                 │
└───────────────────────────────┬───────────────────────────────────────┘
                                │  plan + emit
                                ▼
┌───────────────────────────────────────────────────────────────────────┐
│  3. GENERATOR PLUGINS  (one per target)                               │
│     py-fastapi · ts-vercel · dotnet-semantickernel · java-spring-ai   │
│     (emits against LangGraph / LlamaIndex / Pydantic AI / Vercel AI)  │
└───────────────────────────────┬───────────────────────────────────────┘
                                │  imports
                                ▼
┌───────────────────────────────────────────────────────────────────────┐
│  4. RUNTIME LIBRARIES (one per stack)  ← the real framework           │
│     model gateway · prompt registry · retrieval · agent loop ·        │
│     tool executor · memory · guardrails · eval harness · o11y/cost    │
└───────────────────────────────┬───────────────────────────────────────┘
                                │  driven by
                                ▼
┌───────────────────────────────────────────────────────────────────────┐
│  5. CLI   init · gen · dev · ingest · eval · trace · migrate · eject  │
└───────────────────────────────────────────────────────────────────────┘
```

### Why an IR (unchanged logic, new stakes)

- Targets stay simple: translate a known shape into code.
- Cross-cutting AI semantics — provider routing, token/cost budgets, structured-output contracts, guardrail stages, trace redaction — are resolved **once**.
- Adding a target (or a provider) touches one place.
- Tooling (spec LSP, RAG/agent graph visualizer, cost estimator, eval diff) is built on the IR alone.

**Reference model: Smithy** for the IR/traits/codegen split; **DSPy** for the "declare intent, compile the prompt" philosophy.

---

## 6. The Spec (developer-facing DSL)

Format: **YAML** for v0, with a JSON Schema for editor autocomplete and a typed DSL later. YAML is diffable and reviewable — important when prompts are part of the spec and reviewed like code.

### 6.1 Example — a RAG + tools support agent

```yaml
specVersion: "0.1"
project:
  name: support-copilot
  namespace: acme.support

# ── Model aliases: logic binds to an alias, ops rebind to a pinned ID ──
models:
  fast:
    provider: openai
    modelId: gpt-4o-mini            # pinned; bump via review
    capabilities: [tool-calling, json-schema, streaming]
    params: { temperature: 0.2, maxTokens: 1024 }
  reasoning:
    provider: anthropic
    modelId: claude-sonnet-4         # pinned
    capabilities: [tool-calling, json-schema, vision, streaming, long-context]
  embed:
    provider: openai
    modelId: text-embedding-3-large
    capabilities: [embeddings]
routing:
  default: fast
  escalate: { from: fast, to: reasoning, when: "confidence < 0.6 or retries > 1" }

# ── Prompts: versioned, typed variables, schema-bound output ──
prompts:
  answer_ticket:
    version: 3
    model: fast
    template: |
      You are a support agent for {{product}}.
      Use the knowledge-base context and the tools available. Cite sources.
      <context>{{context}}</context>
      Customer: {{ticket}}
      If you are unsure, ask one clarifying question instead of guessing.
    variables:
      product: { type: string, required: true }
      context: { type: string }
      ticket:  { type: string, required: true }
    output: { kind: structured, schema: Answer }
    evals: [answer_quality]

# ── Tools: the business seam + the attack surface ──
tools:
  lookup_order:
    description: Look up an order by id
    input: OrderQuery
    output: Order
    sideEffects: read
    auth: "hasRole('support')"
    mcp: { server: orders, tool: get_order }
  issue_refund:
    description: Refund an order
    input: RefundRequest
    output: RefundResult
    sideEffects: destructive
    requiresConfirmation: true
    idempotency: key
    auth: "hasRole('billing')"
    handler: { kind: business, symbol: issue_refund }

# ── Retrieval: ingestion is a pipeline with its own boilerplate ──
retrievers:
  kb:
    source: { kind: s3, uri: "s3://acme-kb/*.md" }
    chunking: { strategy: recursive, size: 800, overlap: 120, keepMetadata: [title, url] }
    embedModel: embed
    store: pgvector
    topK: 8
    rerank: { model: bge-reranker-v2, topN: 4 }
    refresh: { mode: incremental, schedule: "0 */6 * * *" }

# ── Agents: instructions + tools + memory + budgets + guardrails ──
agents:
  support:
    instructions: answer_ticket
    model: fast
    tools: [lookup_order, issue_refund]
    retrievers: [kb]
    memory: [conversation]
    guardrails: [pii, injection]
    maxSteps: 8
    maxCostBudget: 0.25             # USD per run — enforced by the runtime
    structuredOutput: Answer
    humanInTheLoop:
      when: "tool.sideEffects == 'destructive'"
      channel: slack

# ── Evals: the correctness net ──
evals:
  answer_quality:
    target: agent:support
    dataset:
      source: synthetic
      seed: file://evals/tickets.seed.jsonl
      generator: { count: 200, model: reasoning }
    metrics:
      - { kind: llm-judge, rubric: faithfulness, model: reasoning, threshold: 0.85 }
      - { kind: tool-trace, expect: [lookup_order] }
      - { kind: cost, max: 0.03 }
    gate: { ci: true, maxRegression: 0.03 }

# ── Guardrails: generated middleware, staged ──
guardrails:
  pii:       { stages: [input, output, retrieval], policies: [pii-detect, pii-redact], action: redact }
  injection: { stages: [input, retrieval],            policies: [prompt-injection], action: block }

# ── Pipelines: the composition / entrypoints ──
pipelines:
  handle_ticket:
    trigger: { http: { method: post, path: /tickets/answer } }
    steps:
      - guard:    { guardrail: injection, stage: input }
      - retrieve: { retriever: kb, query: "{{ticket}}", as: context }
      - agent:    { agent: support, input: "{{ticket}}", as: answer }
      - guard:    { guardrail: pii, stage: output }
      - emit:     TicketAnswered

deployments:
  api:
    target: container
    streaming: true
    observability: { tracing: otel, redact: [customer_email] }
```

### 6.2 Spec surface, easiest -> hardest to abstract

| Tier | What | Difficulty | Notes |
| ------ | ------ | ----------- | ------- |
| 1 | Model aliases, provider wiring, params | Easy | Stable interfaces; high confidence |
| 2 | Prompt templating, variables, few-shot | Easy | Registry + rendering; version it |
| 3 | Structured output / schema binding | Easy–Medium | JSON Schema; repair loop in runtime |
| 4 | Tool declaration + schema generation | Medium | Interop via MCP; permissions matter |
| 5 | RAG ingestion + retrieval + rerank | Medium–Hard | Data-dependent quality; eval-driven |
| 6 | Agents, memory, budgets, HITL | Hard | Loop semantics; cost/safety enforcement |
| 7 | Eval suites + CI gating | Hard | Probabilistic thresholds; judge bias |
| 8 | Guardrails | Medium | Adopt engines; stage placement is subtle |
| 9 | Fine-tuning pipelines, serving | Hard | **Phase 4** |

### 6.3 Retrieval surface as implemented (Phase 1)

§6.1 is the north star and stays that way. Spec v0.1 implements the retrieval *subset* of it — the DSL
below is what `@aid/spec` accepts and `@aid/ir` resolves today. Tier 5 of the table above is what this
section, §7.2's retrieval shapes, and §7.4's retrieval rules deliver; the runtime that executes it is a
later layer.

```yaml
models:
  embed:                             # capability value added by the retrieval surface
    provider: fake                   # or openai | openai-compatible
    modelId: text-embedding-3-small
    capabilities: [embeddings]

stores:                              # new top-level section
  docs:
    kind: memory                     # the fully supported default
    dimensions: 1536
  docs_pg:
    kind: pgvector
    uri: env:PGVECTOR_URL            # required for pgvector, forbidden for memory
    dimensions: 1536

retrievers:                          # new top-level section
  handbook:
    source: { kind: file, uri: ./docs, glob: "**/*.md" }
    chunking: { strategy: recursive, size: 800, overlap: 100, keepMetadata: [path] }
    embedModel: embed
    store: docs
    index: { metric: cosine, hybrid: true }
    topK: 5
    rerank: { model: rerank, topN: 3 }
    refresh: { mode: full }
    traits: [citations]

evals:
  retrieval_quality:
    target: pipeline:answer
    metrics:
      - { kind: retrieval, expectDocs: [getting-started.md], k: 3 }   # added by the retrieval surface

pipelines:
  answer:
    steps:
      - retrieve: { retriever: handbook, query: "{{question}}", as: context }   # new step kind
      - generate: { prompt: answer, context: context }        # binds the retrieved items + citations
      - emit: Answer
```

**Deliberately deferred, while the schema keeps the enums** so that a spec can still name a deferred
feature and receive a precise `spec/not-supported` diagnostic naming the phase it belongs to, rather than
a generic schema failure:

| Deferred | Why it is not in this surface |
| --- | --- |
| `source.kind` other than `file` (`s3`, `http`, `db`, `mcp`) | reserved; only a local file source is implemented |
| `chunking.strategy: semantic` | needs an embedder-driven splitter, which is ingestion runtime |
| `refresh.mode: incremental` and any `schedule` | needs change detection and a scheduled ingest loop |
| rich `filters` expressions | needs a filter IR plus per-store translation |

`stores.kind` is `memory` or `pgvector`. `memory` is the only kind a required gate may depend on:
**every gate runs offline**, so `pgvector` is declarable (and carries a required `env:` uri, which is also
what keeps a literal DSN out of the IR) but is never *required* by a rule. The `aid ingest` command, the
hosted embedding adapter, and the pgvector adapter are later layers.

Two shape decisions worth stating explicitly:

- **No step-level `topK` on `retrieve`.** The candidate width belongs to the retriever's index, so a
  pipeline cannot quietly change what an eval measured.
- **`embeddings` is derived, not declared.** A spec never writes an embedding entry: giving a model the
  `embeddings` capability and pointing a retriever at it is what populates the IR collection. `rerank` is
  derived the same way from a retriever that declares a reranker, so a target that cannot rerank refuses
  the spec *before* codegen.

Any spec that declares a retriever must carry at least one eval with a `retrieval` metric (§7.4).

#### The wiring steps, as landed (L5c)

`rerank`, `guard` and `agent` are leaves: they compose with `branch`/`parallel`/`map`/`reduce` but never
open a scope, so `MAX_STEP_DEPTH` does not apply to them. Each is wiring onto a runtime surface that
already shipped, and each one narrows the design's shape where the shipped interface is narrower:

- **`rerank`** — the design's `input`/`topN`/`as` could not name a query, and `Reranker.rerank` takes
  one (`rerank(query, items, *, top_n)`). So the step is `{ over, query, model, topN, as }`: `over`
  names a binding that must hold a `RetrievalResult`, and `query` is a text template. It is narrowed to
  `RetrievalResult` on purpose — the runtime reorders `RetrievedItem`s and carries their citations, so a
  step over arbitrary JSON would have no provenance to preserve. `model` names a *reranker alias*, not a
  chat model, and only `lexical` ships: any other alias is refused **at validation**, so no model can
  appear to work and then raise at request time.
- **`guard`** — `{ guardrail, stage, text }` and it binds nothing (`as` is refused). `text` is
  stage-discriminated: a template at `input`/`output`, and a projection of a retrieval binding at
  `retrieval`. A step binds `input`/`output`/`retrieval`; `tool-call` is refused because the agent loop
  owns it and a step has no tool call to inspect. `block` is a 400 naming the guardrail; `escalate` and
  `redact` are refused, because `escalate` would be a second pause mechanism and pausing belongs to
  `agents[].humanInTheLoop`.
- **`agent`** — `{ agent, text, as }`, and `text` is one rendered template. The step is a fresh run of
  the declared agent: no thread is opened or resumed, and its cost and tokens land on the enclosing
  run's `CostLedger` (`build_runtime` shares the gateway). A target that declares `humanInTheLoop` is
  refused at validation — a pipeline cannot pause, and auto-resuming would be inventing a decision.

What a `guard` step adds depends on the stage, and the honest answer is that it is often not the first
enforcement. `input` is checked inline by every generated route, `retrieval` by every generated
retriever as it returns each passage, and `output` by every `generate` step. A `guard` step re-checks a
payload the route tables do not see: an agent's own prose (its thread applies only the guardrails the
agent lists). That is the case `examples/guarded-reply` demonstrates; in `examples/support-copilot` the
retrieval-stage step is redundant by construction, because the retriever has already inspected every
passage the step re-checks.

**`human` is retired, not deferred.** A pipeline step cannot pause, and the run that owns a checkpoint is
the agent's, so `agents[].humanInTheLoop` is the replacement spelling. A `human` step is rejected with a
diagnostic that names it.

**`assert` is eval-time only, and now implemented there.** It is not a step kind and never becomes one:
a predicate that fails a single prediction is a measurement, not a control-flow decision, so it lives
in `evals.<id>.metrics[]` as `{ kind: 'assert'; expr: string; message: string }`. The expression is
compiled by the IR into a closed predicate AST — the same arrangement as `PolicyExpr`, and for the same
reason: an assertion is not `eval`, and a spec never contains code. It reads only `prediction`,
`case.id`, and `case.metadata.<name>`, calls only `contains`, `startswith`, `endswith`, and `length`,
and admits `==`, `!=`, and numeric ordering. A name the case does not bind raises rather than reading as
false, because a typo that silently failed every case would be the exact failure mode this project
exists to prevent. The list of deferred step kinds is therefore empty, and
`packages/spec/test/phase-exit.test.ts` is what keeps it empty.

---

## 7. The IR (Intermediate Representation)

### 7.1 Design requirements

- **Closed-world, fully resolved.** No unresolved refs at codegen time.
- **Explicit over implied.** Defaults materialized once, not per generator.
- **Capability-driven.** Every node declares what it needs; generators declare what they support; mismatches fail **before** codegen.
- **Versioned + serializable** (JSON) with an `irRange` contract.
- **Trait/annotation channel** for stack specifics without polluting core semantics.
- **Stable IDs** so regeneration is deterministic and diffs are meaningful.

### 7.2 Shape

```ts
type IR = {
  irVersion: string;               // semver, e.g. "1.0"
  specVersion: string;
  project: { name: string; namespace: string; targets: string[] };
  types:        TypeShape[];       // enums, structs, unions
  models:       ModelShape[];
  prompts:      PromptShape[];
  tools:        ToolShape[];
  retrievers:   RetrieverShape[];
  embeddings:   EmbeddingShape[];
  stores:       VectorStoreShape[];
  memory:       MemoryShape[];
  agents:       AgentShape[];
  pipelines:    PipelineShape[];
  evals:        EvalShape[];
  guardrails:   GuardrailShape[];
  deployments:  DeploymentShape[];
  observability: ObservabilityShape;
  runtime:      RuntimeShape;
};

type Capability =
  | 'tool-calling' | 'json-schema' | 'streaming' | 'vision' | 'audio'
  | 'embeddings' | 'rerank' | 'long-context' | 'reasoning' | 'prompt-cache';

type ModelShape = {
  id: string;                      // alias, e.g. "fast"
  provider: 'openai'|'anthropic'|'azure'|'bedrock'|'google'|'ollama'|'vllm'|'custom';
  modelId: string;                 // PINNED vendor id
  capabilities: Capability[];
  params: { temperature?: number; topP?: number; maxTokens?: number; seed?: number; stop?: string[] };
  limits: { contextTokens: number; maxOutputTokens?: number; rpm?: number; tpm?: number };
  costProfile?: { inputPerMTok: number; outputPerMTok: number };
  fallbacks: string[];             // ordered model aliases
  cache?: { prompt?: boolean; semantic?: boolean };
  traits: Trait[];
};

type PromptShape = {
  id: string; version: number;
  template: string;                // typed, mustache/handlebars
  variables: { name: string; type: TypeRef; required: boolean; default?: unknown }[];
  output: { kind: 'text'|'json'|'structured'; schema?: TypeRef };
  model: string;                   // alias
  params?: Partial<ModelShape['params']>;
  examples?: { input: unknown; output: unknown }[];
  guardrails: string[];
  evals: string[];
  traits: Trait[];
};

type ToolShape = {
  id: string; name: string; description: string;
  input: TypeRef; output: TypeRef;
  sideEffects: 'none'|'read'|'write'|'destructive';
  requiresConfirmation: boolean;
  auth?: PolicyExpr;
  timeoutMs?: number; retries: number; idempotency: 'none'|'key';
  handler: { kind: 'generated'|'business'|'mcp'; symbol?: string; mcp?: { server: string; tool: string } };
  traits: Trait[];
};

type RetrieverShape = {
  id: string;
  source: { kind: 'file'|'s3'|'http'|'db'|'mcp'; uri: string; glob?: string };
  chunking: { strategy: 'fixed'|'recursive'|'semantic'|'code'; size: number; overlap: number; keepMetadata: string[] };
  embedModel: string;
  store: string;                   // vector store id
  index: { metric: 'cosine'|'dot'|'l2'; hybrid: boolean; params?: Record<string, unknown> };
  topK: number;
  rerank?: { model: string; topN: number };
  filters?: string[];
  refresh: { mode: 'full'|'incremental'; schedule?: string };
  traits: Trait[];
};

// Populated by derivation, not by a spec section: a spec gives a model the
// `embeddings` capability and points a retriever at it (see §6.3).
type EmbeddingShape = {
  id: string;                      // the model alias that declares `embeddings`
  provider: 'openai'|'openai-compatible'|'fake'|...;
  modelId: string;                 // PINNED vendor id
  dimensions?: number;             // must agree with every store the retriever writes to
  costProfile?: { inputPerMTok: number; outputPerMTok: number };
  traits: Trait[];
};

type VectorStoreShape = {
  id: string;
  kind: 'memory'|'pgvector'|'qdrant'|'pinecone'|'weaviate'|'custom';
  uri?: string;                    // `env:NAME` for a hosted store; absent for `memory`
  dimensions?: number;
  traits: Trait[];
};

type AgentShape = {
  id: string; name: string;
  instructions: string;            // prompt ref
  model: string;
  tools: string[];
  retrievers: string[];
  memory: string[];
  guardrails: string[];
  structuredOutput?: TypeRef;
  maxSteps: number;
  maxTokensBudget?: number;
  maxCostBudget?: number;          // USD
  handoffs: string[];              // other agent ids; transfer of control (this agent stops talking)
  delegates: string[];             // other agent ids this one may delegate a sub-task to (control returns)
  engine: AgentEngine;             // who owns the loop; `deepagents` needs a pinned version
  engineVersion?: string;
  /** v0.2 only. `fail` (default) is a hard stop; `degrade` steps one rung down the alias ladder. */
  onBudgetExhausted?: 'fail' | 'degrade';
  humanInTheLoop?: { when: PolicyExpr; channel: string };
  traits: Trait[];
};

type PipelineShape = {
  id: string;
  trigger: { http?: { method: string; path: string } } | { schedule: string } | { event: string } | { manual: true };
  steps: StepShape[];
  errorPolicy: { retries: number; fallback?: string; deadLetter?: string };
  observability?: { trace: boolean; redact: string[] };
};

type StepShape =
  | { kind: 'retrieve'; retriever: string; query: string; as: string }  // no step-level topK: see §6.3
  | { kind: 'generate'; prompt: string; model?: string; input?: unknown; context?: string; as: string; stream?: boolean }
  // The design's `input`/`topN`/`as` could not name a query, and `Reranker.rerank` takes
  // one: `over` names the binding to reorder and `query` is the text scored against.
  // `model` selects a reranker, not a chat model, and only `lexical` ships (§6.3).
  | { kind: 'rerank';   over: string; query: string; model: string; topN: number; as: string }
  // The design's `input: unknown` has no consumer: the step renders one template string.
  | { kind: 'agent';    agent: string; text: string; as: string }
  | { kind: 'tool';     tool: string; input: unknown; as: string }
  | { kind: 'branch';   when: PolicyExpr; then: StepShape[]; else?: StepShape[] }
  | { kind: 'parallel'; branches: StepShape[][] }
  | { kind: 'map';      over: string; step: StepShape }
  | { kind: 'reduce';   over: string; prompt: string; as: string }
  // Binds nothing. `text` is a template at `input`/`output` and a projection of a
  // retrieval binding at `retrieval`; `tool-call` is refused because it is agent-scoped
  // (§6.3, "guard steps").
  | { kind: 'guard';    guardrail: string; stage: 'input'|'output'|'retrieval'; text: string }
  // `assert` is *not* a step shape, though the original design sketched it here. A
  // predicate that fails one prediction is a measurement, not a control-flow decision,
  // so it is a `Metric` below; naming it as a pipeline step is refused.
  // `human` is retired, not deferred: a pipeline cannot pause, and a pause belongs to the
  // run that owns a checkpoint. `agents[].humanInTheLoop` is the replacement spelling.
  | { kind: 'emit';     event: string };

type EvalShape = {
  id: string; name: string;
  target: string;                  // "agent:support" | "prompt:x" | "pipeline:y"
  dataset: { source: 'inline'|'file'|'synthetic'; cases?: unknown[]; uri?: string;
             generator?: { count: number; model: string } };
  metrics: Metric[];
  thresholds: { pass: number; warn: number };
  gate: { ci: boolean; maxRegression: number; minMean?: number };  // max allowed drop vs. baseline, plus an absolute floor
  costBudget?: number;
  latencyBudgetP95Ms?: number;
  traits: Trait[];
};

type Metric =
  | { kind: 'exact'; field?: string }
  | { kind: 'contains'; value: string }
  | { kind: 'json-schema'; schema: TypeRef }
  | { kind: 'semantic-similarity'; threshold: number; embedModel: string }
  | { kind: 'llm-judge'; rubric: string; model: string; threshold: number }
  | { kind: 'tool-trace'; expect: string[]; order?: 'strict'|'any' }
  | { kind: 'retrieval'; expectDocs: string[]; k: number }
  | { kind: 'cost'; max: number }
  | { kind: 'latency'; p95Ms: number }
  // A closed predicate over the prediction and its case; see §6.3. `message` is quoted
  // verbatim in the failure detail, and an eval carrying one must declare
  // `gate.minMean: 1`, because a 0/1 metric cannot be judged by delta alone.
  | { kind: 'assert'; expr: string; message: string };

type GuardrailShape = {
  id: string;
  stages: ('input'|'output'|'retrieval'|'tool-call')[];
  // The closed vocabulary accepted today: pii-detect, pii-redact, prompt-injection,
  // jailbreak, moderation, toxicity, secret-scan. `allowlist`, `schema` and `custom`
  // are design intent, not yet accepted - naming one is a spec error until the layer
  // that can evaluate it lands.
  policies: GuardrailPolicyKind[];
  action: 'block'|'redact'|'flag'|'escalate';
  redact: string[];               // field names the `redact` action removes
  tools: string[];                // tools covered; empty means every tool on the stage
  onFail: { message: string; fallbackPrompt?: string; log: boolean };
  traits: Trait[];
};

type MemoryShape = {
  id: string;
  kind: 'buffer'|'window'|'summary'|'semantic'|'episodic'|'vector';
  // `session` was renamed `thread` (the unit a run resumes, as in the agent runtimes'
  // checkpointer); `tenant` is deferred with the multi-tenant control plane (Phase 3).
  scope: 'thread'|'user'|'global';
  tokenBudget: number;
  summarizeModel?: string;
  store?: string;
  // A declared store id or `in-process`; the `memory/refs` gate resolves it.
  backend?: string;
  ttl?: string;
  redact: string[];
  traits: Trait[];
};

type DeploymentShape = {
  id: string;
  target: 'serverless'|'container'|'batch'|'edge';
  streaming: boolean;
  concurrency?: number;
  autoscale?: { min: number; max: number; metric: string };
  secrets: string[];
  env: { name: string; value?: string; secret?: boolean }[];
  traits: Trait[];
};
```

### 7.3 Materialization rules (examples)

- Model alias -> concrete pinned `provider` + `modelId` + resolved `limits`/`costProfile` at IR build.
- `routing.escalate` -> IR records an ordered fallback chain + escalation predicate; runtime owns the decision; generator only wires it.
- Structured output -> a generated schema artifact + the runtime's parse-repair boundary; generator emits the binding, not the retry loop.
- `retrievers.kb` -> IR gains an ingestion DAG node + an index definition; `aid ingest` drives it.
- `guardrails` on a prompt/agent/pipeline -> IR attaches stage-tagged middleware; the runtime invokes them at the right points.
- `maxCostBudget` / `maxTokensBudget` -> IR carries budget nodes the runtime enforces and the eval harness asserts.
- Policy expressions are parsed once into a `PolicyExpr` AST so every target compiles identical semantics.

### 7.4 IR validation (build-time gates)

The six gates below are Phase 0's; the retrieval surface adds **exactly one retrieval rule to each**, so
the retrieval contract is enforced by the same six gates rather than a seventh. Every rule runs offline:
no network, no key, no database.

1. **Referential integrity** — every ref resolves (prompts, tools, models, retrievers, stores, memory, guardrails, pipelines). *Retrieval:* a retriever's `store` and `embedModel` resolve, its `rerank.model` resolves if declared, a `retrieve` step's `retriever` resolves, an embedding model actually declares `embeddings`, and a `generate` step's `context` binding is in scope.
2. **Normalization** — model aliases resolved; defaults materialized; enums expanded; naming canonical. *Retrieval:* `index.metric` is in the vocabulary, and a store's `dimensions` must agree with the embedding model that writes to it.
3. **Capability negotiation** — a prompt requiring `json-schema` must bind to a model declaring it; a target that cannot express cursor-style streaming or `long-context` fails loudly *before* codegen. *Retrieval:* `embeddings` and `rerank` are **derived** from the IR's own content, and the target must declare each one it does not implement. `rerank` is separate from `embeddings` because a target can serve a retriever without being able to rerank.
4. **Cost/latency sanity** — estimated per-run cost vs. declared budgets; warn/fail on models without a `costProfile`. *Retrieval:* a `retrieve` step is charged `topK` chunks × the tokens in one chunk to the embedding model that serves it, so a wide `topK` over large chunks shows up in the estimate instead of being free by omission.
5. **Security gates** — every `write`/`destructive` tool has an `auth`; every pipeline touching untrusted input has an input guardrail; every trace config redacts declared PII fields. Fail-closed by default. *Retrieval:* a store's `uri` must be `env:NAME`, and no store or retriever may carry a literal DSN or an inline credential in its authority — a literal fails **closed**.
6. **Eval coverage** — every agent/prompt marked `ci` has a dataset and at least one metric; a spec change without a linked eval warns. *Retrieval:* a spec that declares a retriever must carry at least one eval with a `retrieval` metric, because an `exact-match` eval only sees the answer retrieval fed into and says nothing about whether the right chunks came back.

### 7.5 Agent runtime semantics (Phase 2 L2)

An agent's `engine: native` runs a loop the framework owns: model call, tool calls, observations, repeat
until a terminal answer, `maxSteps`, or a budget breach. The loop consumes the emitted IR the same way
the pipeline runtime does and goes through the model gateway, so fallback, cost accounting and tracing
apply to agent runs by construction rather than by a second implementation.

#### Transfer is not delegation

These are two different control-flow shapes, and the IR gives them two different fields because
collapsing them into one word ("handoff") hides the difference that matters to whoever has to debug it.

| | `handoffs` — **transfer** | `delegates` — **delegation** |
| --- | --- | --- |
| Runtime primitive | `_transfer` (`transfer_to_<agent>` tool) | `_delegate` (`delegate_to_<agent>` tool) |
| Who holds the conversation afterwards | the target agent | the calling agent |
| Context the target sees | the caller's messages, minus system prompts | a fresh `[system, user(message)]` |
| Control returns to the caller? | no — the caller never runs again | yes, as one tool observation |
| `RunResult.agent_id` | the target | the caller |
| `RunResult.path` | grows by the target | unchanged |
| Who produces the final answer | the target | the caller |

Read the last three rows as the observable contract: after a **transfer** the run belongs to the target
(`agent_id` is the target, `path` is `[caller, target]`), and after a **delegate** it still belongs to the
caller (`agent_id` is the caller, `path` is `[caller]`, and the target's answer arrives as a `tool`
message the caller may ignore). A reader who confuses the two will expect the wrong agent in the trace and
the wrong message history at the next turn. The runtime primitive names are deliberately mechanical
(`transfer_to_*` / `delegate_to_*`, `_transfer` / `_delegate`) so that neither reads as a synonym for the
other.

Both refuse to re-enter an agent already on the run's `path`, so a cycle is a named error rather than
infinite recursion. An agent may not list the same target in both fields, and may not target itself —
both are build-time gate failures.

#### Budgets: hard failure by default, bounded degrade on request (closes open question #7)

A budget breach is a **hard failure**. The runtime raises `BudgetExceededError` and the run stops; it does
not silently continue cheaper, because a run that quietly produces a different answer under a different
model is worse than one that stops and says so. This is enforced by the gateway's preflight *and* by the
ledger, so a single call cannot overshoot its ceiling.

An agent may opt into `onBudgetExhausted: 'degrade'`, which routes the *next* step to the next cheaper
alias in the declared ladder instead of failing. The degrade is deliberately small:

- **One documented step.** The runtime picks the first strictly cheaper fallback of the agent's alias.
  There is no retry loop and no cascade: if that step also breaches, the run fails hard. A "keep trying
  cheaper models" loop would turn a cost control into an unbounded search with an unbounded bill.
- **Fail closed at build time.** `degrade` with no cheaper alias available is a gate error, not a runtime
  surprise — the spec author learns at build time that the escape hatch has nowhere to go.
- **Observable.** Each degraded step is recorded in `StepRecord.degraded_from`, and `RunResult.degraded`
  lists the `(from, to)` pairs, so a reader of the trace can see the run did not answer on the alias it was
  declared with. A checkpointed (paused) run carries its current alias, so resuming re-routes from where
  it was instead of snapping back to the dear alias.

`onBudgetExhausted` is a v0.2 field. It appears in no v0.1 emitted artefact, so v0.1 golden outputs are
byte-identical to before this layer.

#### Memory and human-in-the-loop

Memory is in-process plus exactly one store-backed adapter — no plugin taxonomy. `scope: thread` is the
checkpointer unit: it is trimmed to its `tokenBudget` and never written to a store, because a thread's
history *is* the run's message list. `scope: user` and `scope: global` read and write the store, and are
rendered as one extra system message, so memory injection is visible as a change in the request the model
receives rather than as hidden state.

A run pauses when the agent declares `humanInTheLoop` and the caller does not satisfy its `when` policy.
The pause returns a checkpoint carrying the completed steps, the pending tool call and the current alias;
`resume(checkpoint, decision)` continues from there. The pause is a span *event* (`aid.hitl`) rather than
an attribute, because a run may pause and resume more than once and an attribute would keep only the last
decision.

### 7.6 Guardrails and tool permissioning (Phase 2 L3)

The IR has carried the guardrails *declaration* since Phase 2 L1: stages, policy kinds, an action, the
fields a redaction may touch. L3 adds the half that decides: `runtimes/python/src/aid_runtime/agents/
guardrails.py`. Every detector in it is a regular expression, so a verdict is deterministic and
reproducible offline — no model, no network, no seed — and a spec that passes today passes tomorrow.

#### Four stages, in the order a run meets them

| Stage | When it runs | Payload the detectors see |
| --- | --- | --- |
| `input` | before the model sees the user's turn | the turn's text |
| `retrieval` | around the chunks a retriever would splice into the prompt | the results joined by newlines — *not* the query, whose own check is `input` |
| `tool-call` | before a tool's handler body runs | the call's argument values, keyed by argument name |
| `output` | after the model answers | the answer text |

The input stage runs once per frame. A paused run that resumes does **not** re-run it, which matters
because a second pass could block text the human already approved; the loop-level tests count the
`input` records across a pause and a resume to keep that true.

`retrieval` is the stage with the least human in it: a run may have no channel to ask. A `block`
verdict raises, an `escalate` verdict *also* raises — with a message saying there is no human channel —
rather than silently treating "I wanted to ask someone" as "carry on". A `redact` verdict rewrites the
retrieved item in place.

#### Four actions

| Action | Effect | Observable |
| --- | --- | --- |
| `block` | the run stops with `GuardrailBlockedError` naming the guardrail, the stage and the message | raised at the stage's seam |
| `redact` | the fields named in `redact` are masked in the payload; the run continues on the masked text | the masked payload is what the next stage and the tool body receive |
| `flag` | the run continues unchanged; the match is recorded but decides nothing | `RunResult.guardrails`, `aid.guardrail` spans |
| `escalate` | the run pauses for a human (`PendingApproval.escalation`); a rejected escalation ends `BLOCKED` with the guardrail's message and never the held text | the pause, the decision, the record |

A redaction is replaced with `[REDACTED:<policy>]`, not `***`, so a log line says *why* the text
vanished. Only `pii-detect`, `pii-redact` and `secret-scan` are redactable: the other policies match
*intent*, and masking an intent phrase does not make the request safe. Asking for a redaction over an
intent policy is refused rather than quietly misapplied.

#### Fail closed, in three places

1. **A policy with no evaluator is a block.** A guardrail naming a policy this runtime cannot evaluate
   raises `GuardrailBlockedError` naming the policy. There is no path from "the check could not run" to
   "no violation found".
2. **A redaction that does not clean the payload is a block.** After masking, the engine re-runs the
   detectors over the result. A spec that declares `redact: [answer]` for a payload whose violation is
   in another field would otherwise "redact" successfully while shipping the violation, so a surviving
   match raises instead of returning text it could not clean.
3. **An unknown action is refused.** `GuardrailDefinition.action` is a string read out of JSON, and the
   deciding step finds a `block` by equality — so an unrecognised action could not decide a block and
   would fall through to "not block", an allow nobody declared. The engine validates membership against
   the closed vocabulary and raises `ConfigurationError`.

#### Evaluation order, and what `flag` is for

When several guardrails apply at one stage the engine walks them in **declaration order** and collects
every one that fired; the first that fired decides. There is exactly one exception, and it is deliberate:
**any `block` outranks declaration order** — the first `block` decides regardless of where it was
declared. Ordering is about which of two *comparable* actions wins, and "stop the run" is not comparable
to "let it continue with a note". Without the exception an author could neuter a strict guardrail by
declaring a permissive one first, which is the kind of ordering dependency nobody audits.

This records the decision the Phase 2 plan listed as an open question (evaluation order, and whether
`flag` may be ignored), so it is written down here rather than inferred from the code:

- **A `flag` cannot be ignored — and it does not stop anything.** A flag means a detector matched. The
  run continues because the spec said it may, and the record lands on `RunResult.guardrails` and on the
  `aid.guardrail` span event. Its consumers are the reader of a run result: an eval, a log shipper, a
  reviewer. It is not an allow, and nothing downstream may treat its presence as permission.
- Every firing guardrail is recorded, not only the deciding one, so a `flag` next to a `block` still
  reaches the audit trail.

Both halves are pinned: a test swaps the declaration order of two guardrails and asserts the deciding
record changes, while another asserts a `block` keeps winning wherever it is declared.

**Only `block` is exempt.** `escalate`, `redact` and `flag` are comparable with one another, so
declaration order alone decides between them: a `flag` declared before an `escalate` flags and does not
escalate, and a `flag` declared before a `redact` does not mask the payload. Redaction is not an
independent pass over every firing guardrail — it runs only when the deciding action is `redact` — so a
`redact` that loses to a `flag` leaves the matched text in place. That consequence is intended: an
unconditional redaction pass would let a guardrail rewrite a payload under an action the author did not
select, and would make the deciding action describe one rule rather than the verdict. The losing record
is still collected, so an operator can see which declaration decided and which merely fired.

Both consequences are pinned beside the ordering tests: swapping `flag` and `escalate` changes which one
decides, and a `redact` declared after a `flag` leaves the payload untouched where the same `redact`
declared first masks it.

#### Tool permissioning

`ToolShape` already carried `sideEffects`, `requiresConfirmation` and `auth`. L3 makes them binding at
call time. Every tool call is authorized before any handler body runs, deny by default:

1. **The agent's `tools` list is the grant.** A tool the runtime has registered but the agent did not
   declare is refused — there is no implicit wildcard.
2. **A tool absent from the IR is refused,** because its side effects and auth policy are unknown.
3. **`auth` is evaluated now, against the principal on this call,** not at build time: `auth` is a
   question about the caller, and the caller is only known now. An undecidable policy is a denial —
   `PolicyEvaluationError` means the evaluator could not answer, and "could not answer" must never
   render as "allowed".
4. **A `write`/`destructive` tool with no `auth` policy is denied,** so a side effect cannot be called
   with no authorization at all.

The proof is behavioural, not textual: the tests register handlers that increment a counter and assert
the counter is still zero after a refused call, so "the handler body never ran" is measured rather than
inferred from an exception type.

#### The red-team corpus

`runtimes/python/tests/redteam/` holds the safety suite as *data*: fixtures with recorded `provenance`,
categorised prompt-injection / jailbreak / PII / tool-abuse, plus a seeded variant generator. It runs
inside the existing `python` CI job because it is a pytest module — no extra job.

The generator is content-seeded (`{seed}:{policy}:{payload}`), so adding a fixture cannot renumber the
others, and it never touches the network, the clock or the environment. Case folding is applied only to
the policies whose patterns are compiled `IGNORECASE`; folding the credential patterns would test a
claim the detector never made.

Two honest limits are part of the suite, not omitted from it. Recall here is a **regression check on
documented patterns**, not an independent estimate of coverage against unseen attacks — the module
docstring says so. And one test pins a paraphrase that the patterns *do* miss, so the blind spot is
visible, and says what to do if it ever starts passing.

### 7.7 The agent engine seam (Phase 2 L4)

`engine` selects the orchestration *backend* per agent. It is not a second IR and not a second gateway.
`native` is the default and stays the only backend both runtimes ship; `deepagents` is an optional
Python backend, installed with `pip install 'aid-runtime-python[deepagents]'`, and its presence changes
nothing for an agent that does not ask for it.

#### Where the seam is

`agents/engine.py` owns the whole decision in one function, `check_engine(agent)`, which `agents/loop.py`
calls before any run. The order is deliberate, and every branch either runs or fails closed with a named
error — nothing falls through to the native loop, because an `engine` field that silently means "native"
is worse than no field at all.

| Check | Outcome |
| --- | --- |
| `native` | the loop runs |
| an unrecognised engine name | `ConfigurationError` |
| `handoffs` declared | `AgentHandoffUnsupportedError` |
| `engineVersion` differs from the pinned release | `DeepAgentsVersionMismatchError` |
| the optional extra is absent | `DeepAgentsUnavailableError` |

#### The adapter is the budget guarantee

Deep Agents calls a LangChain chat model, so `agents/chat_model.py` exposes our `ModelGateway` as a
`BaseChatModel`. Every model call made inside the harness — a subagent's included — therefore still
passes through alias resolution, ordered fallback, the cost ledger, the budget check and the `chat`
span. Without that adapter the budget would quietly stop applying the moment an agent selected this
engine, which is precisely the defect class this project exists to prevent. Three tests assert the
guarantee *inside* a harness run — fallback, budget breach and span emission — rather than against the
adapter in isolation.

The adapter is also the only tool funnel. `bind_tools` filters through an allow-list built from the
agent's declared tools, and Deep Agents routes every tool it can call — bundled ones included — through
`bind_tools`. A `deepagents` agent therefore cannot reach the harness's filesystem or shell tools by
asking for them in a prompt.

#### Mapping, and the mismatch it refuses

| AID requirement | Deep Agents primitive | Behaviour |
| --- | --- | --- |
| agent loop | `create_deep_agent` | direct |
| `delegates` | `subagents` / `task` | delegation with an isolated context; the caller resumes and authors the answer |
| `handoffs` (transfer) | *none* | refused by name, never degraded |
| memory `user` / `global` | backend over our `MemoryStore` | our store stays the source of truth |
| memory `thread` | LangGraph checkpointer | internal; our checkpoint remains the public pause/resume type |
| HITL | `interrupt_on` | `humanInTheLoop.when` is evaluated by us before an interrupt is armed; approve / edit / reject arrive as our checkpoint decisions |
| `maxSteps` | graph recursion limit | translated, with a per-call ceiling in the adapter; exhaustion reports the same status the native loop reports |
| token and cost budgets | *none* | ours, through the adapter |
| guardrails | *none* | ours, wrapped around input, output and tool calls |
| tracing | LangSmith, optional | our OTel spans are required; LangSmith is absent and off |

Transfer is the one requirement with no primitive. `subagents` delegate *and return*; control never
moves, so emulating transfer with a delegate would change who authors the final answer. Transfer
therefore stays native-only, and a `deepagents` agent that declares `handoffs` fails closed with
`AgentHandoffUnsupportedError` — pinned by a test and by a conformance case, not by this paragraph.

#### The pin

`engineVersion` must name the release the runtime was built against. `DEEPAGENTS_PIN` in
`agents/engine.py` is the single authoritative value; the exact-pinned extra (`deepagents==0.7.32`)
repeats it for the installer and nothing else does. The comparison runs at run time in both directions
— a declared version this runtime was not built for, and an agent that names none — and each fails
closed. That comparison is the reason the IR gate refuses `engine: deepagents` without a pinned
`engineVersion` in the first place: an unpinned engine is a backend whose behaviour can change under a
stored eval baseline.

#### Not in this layer

No filesystem, shell or skills tools: they are disabled by default, are not enabled here, and are never
enabled in required CI. No streaming under this engine — the adapter's `_astream` raises, because a
half-supported path would emit neither a span nor a ledger entry. No LangSmith. And no TypeScript
parity: the `agent.engine` conformance cases are scoped to Python with a recorded reason naming L6,
where the TypeScript runtime gains its own agent backend.

---

## 8. Generator Plugin Model

### 8.1 Interface

```ts
interface Generator {
  name: string;                       // 'py-fastapi'
  target: string;                     // 'python'
  version: string;
  irRange: string;                    // semver range, e.g. '^1.0'
  capabilities: TargetCapability[];   // streaming, tool-calling, cursor-memory, otel, ...
                                      // streaming is withheld from every target until L5, where
                                      // the runtimes stop raising FeatureDeferredError; a target
                                      // declares only what it can actually emit.
  emitsAgainst: {                     // the ecosystem libs it generates against
    orchestration?: 'langgraph' | 'llamaindex' | 'dspy' | 'vercel-ai' | 'semantic-kernel';
    structuredOutput?: 'pydantic' | 'instructor' | 'zod';
    tracing?: 'otel-genai' | 'langfuse' | 'langsmith';
  };
  output: { root: string; generatedDir: string };
  plan(ir: IR, ctx: GenContext): Plan;      // pure: IR -> intended file set (no writes)
  emit(plan: Plan, ctx: GenContext): GeneratedFile[];
  optionsSchema?: JSONSchema;
}
```

`plan()` before `emit()` stays — it enables `--dry-run`, drift detection, and deterministic testing without touching disk.

### 8.2 Determinism contract

- No timestamps, host names, or random IDs in output (fixed via seeded/hashed schemes).
- Stable ordering (models/prompts/tools/pipelines sorted by stable ID).
- Formatter-normalized output (Ruff/Black, Prettier). **Note:** the contract applies to *generated code*, never to model output.

### 8.3 Output layout (per generated AI app)

```text
app/
├── generated/              # generator-owned — NEVER edit (banner + hash)
│   ├── gateway/            # provider adapters, routing, budgets
│   ├── prompts/            # rendered registry + schemas
│   ├── retrieval/          # ingestion DAG, retriever bindings
│   ├── agents/             # agent loop wiring, tool schemas
│   ├── pipelines/          # step graph + entrypoints
│   ├── guardrails/         # staged middleware
│   └── evals/              # eval harness + datasets wiring
├── business/               # developer-owned — generated once, never touched
│   ├── prompts/            # prompt overrides / variants
│   ├── tools/              # domain tool implementations (the seam)
│   └── rubrics/            # domain eval criteria
├── evals/                  # datasets + baselines (developer-owned)
├── aid.manifest.json      # per-file hashes + ownership + generator version
├── app.spec.yaml
└── <stack files>           # pyproject.toml / package.json, config, entrypoint
```

### 8.4 The seam (how generated code calls business logic)

The IR marks a handler `{ kind: 'business' }`. Generated wiring imports a **stable, generated interface** the developer implements:

```python
# generated/contracts/issue_refund.py   (generator-owned)
from typing import Protocol
class IssueRefundTool(Protocol):
    async def __call__(self, ctx: ToolContext, req: RefundRequest) -> RefundResult: ...
ISSUE_REFUND = "issue_refund"   # DI token
```

```python
# business/tools/issue_refund.py        (developer-owned, generated ONCE if missing)
from generated.contracts.issue_refund import IssueRefundTool, ToolContext, RefundRequest, RefundResult
class IssueRefund(IssueRefundTool):
    async def __call__(self, ctx: ToolContext, req: RefundRequest) -> RefundResult:
        # === your business logic here ===
        ...
```

The runtime resolves the token via DI, enforces `auth`/`requiresConfirmation`/`idempotency`, traces the call, and hands control to the developer. Generated files are never edited by hand; business files are never overwritten.

---

## 9. Runtime Libraries (per stack)

The runtime is the real framework. One library per stack, versioned independently, thin over ecosystem libs.

**Model Gateway**

- Provider adapters (OpenAI/Anthropic/Azure/Bedrock/Google/Ollama/vLLM) with a unified streaming interface.
- Alias -> pinned model resolution; capability negotiation; ordered fallbacks; escalation routing (cheap -> strong).
- Retries + backoff, rate-limit/token-bucket, prompt cache, semantic cache, token + cost accounting.

**Prompt Registry**

- Versioned prompts, typed rendering, few-shot assembly.
- Structured-output enforcement (JSON Schema/Pydantic/zod) + parse-repair loop.

**Retrieval**

- Connectors + chunkers + embedders; vector store adapters (pgvector first); hybrid search; rerank; context assembly with citations.

**Agent Runtime**

- Loop over ecosystem orchestration (LangGraph/LlamaIndex/Pydantic AI/Vercel AI SDK); tool-schema generation; tool executor; step/token/cost budgets; handoffs; HITL interrupts; memory.

**Guardrails Engine**

- Stage-aware policy evaluation (input/output/retrieval/tool-call); adopt existing engines (Guardrails AI / NeMo Guardrails / provider moderation).

**Eval Harness**

- Datasets, metrics (incl. LLM-as-judge), thresholds, baseline diffing, CI gating, synthetic dataset generation.

**Observability & Cost**

- OTel GenAI spans per LLM/retrieval/tool call; replay; PII redaction in traces; cost/latency dashboards. Integrate Langfuse/LangSmith/Phoenix rather than rebuild.

**Non-responsibility:** the runtime contains no app-specific prompts, tools, or rubrics.

---

## 10. Regeneration, Drift & Safety

`aid.manifest.json` records per file: `path`, `owner` (`generated`|`business`), `sha256`, `generator`, `generatorVersion`.

Regeneration algorithm:

1. Plan the new file set.
2. For a `generated` file whose on-disk hash != recorded hash -> **user edited generated code**. Do not silently overwrite: write `.aid-rej` and fail with guidance (`aid eject <path>` or `--force`).
3. For a `business` file: create only if missing; never overwrite (prompt/tool/rubric work is sacred).
4. Write atomically; update the manifest.
5. Report `created / updated / unchanged / conflicts`.

Because prompts, tools, and rubrics are *code-reviewed artifacts*, they live in `business/` and `evals/` and are diffed like source.

`aid eject <path|node>` flips ownership to `business` and permanently excludes that artifact from generation.

---

## 11. CLI

| Command | Purpose |
| --------- | --------- |
| `aid init` | Scaffold a new AI app from a spec. |
| `aid gen [--target <t>] [--dry-run] [--force]` | Generate/regenerate code from spec. |
| `aid dev` | Generate + run locally (defaults to a local model like Ollama for cheap iteration). |
| `aid ingest [--retriever <id>]` | Run/refresh RAG ingestion pipelines. |
| `aid eval [--suite <id>] [--baseline]` | Run eval suites; diff vs. baseline; enforce gates. |
| `aid trace <run-id>` | Open/replay a traced run (replay with mocked model calls). |
| `aid cost [--since <date>]` | Cost/latency report from traces. |
| `aid guard --red-team <corpus>` | Run the safety/guardrail suite. |
| `aid migrate` | Generate/apply schema + vector-index migrations. |
| `aid eject <path>` | Take ownership of a generated artifact. |
| `aid doctor` | Diagnose drift, version mismatches, missing business files, stale prompts. |

All commands support `--json`; exit codes are CI-friendly.

---

## 12. Testing & Quality Strategy

The part most generator projects under-invest in — and the part AI makes mandatory.

**Two regimes, explicitly separated:**

**A. Codegen (deterministic)**

1. Spec/IR unit tests — parsing, normalization, capability negotiation, policy AST.
2. **Golden-file tests per generator** — fixture spec -> expected file tree; any diff is reviewable.
3. **Determinism test** — generate twice, assert byte-identical.
4. Drift tests — simulate user edits to `generated/`, assert conflict handling.

**B. Behavior (probabilistic)**
5. **Eval suites** — the analog of golden files: datasets + metrics + thresholds, run in CI, gated on `maxRegression`.
6. **Cross-target conformance evals** — one shared dataset + metrics that *every* runtime must pass. This is what keeps N targets honest.
7. **Cost & latency gates** — a prompt/model change that blows the budget or the p95 fails CI.
8. **Safety suite** — a red-team corpus of prompt-injection/jailbreak/PII cases the guardrails must block.
   Implemented in Phase 2 L3 as `runtimes/python/tests/redteam/` (§7.6): fixtures with recorded
   provenance, a seeded variant generator, a recall/false-positive threshold, and a meta-test that empties
   every detector and asserts the corpus then reports *zero* recall — so the suite cannot pass vacuously.
   It is a regression check on the detectors, not evidence about unseen attacks; a second test pins a
   paraphrase the patterns legitimately miss rather than leaving that limit implied.
9. **Record/replay cassettes** — capture real LLM calls; replay deterministically in unit tests (VCR-style); live evals run nightly against pinned models.
10. **Generated-app E2E** — `aid init` a sample app, build it, run its eval suite, per target. If generated code doesn't run, CI is red.

**Compatibility matrix tests** — spec x generator x runtime x model-alias versions.

### Cross-target conformance suite (Phase 1)

Item 6 is implemented as a shipped corpus, not as one suite per target. `conformance/corpus.json` at
the repository root holds the cases; each runtime gets a thin runner that executes them against the
real runtime code and emits a verdict. The corpus is the contract, the runners are its two consumers.
Expectations are not duplicated per language, because two copies would drift and each would then
agree with its own runtime rather than with the other one.

| Path | Role |
| --- | --- |
| `conformance/corpus.json` | The shared cases: `id`, `op`, `description`, `input`, `expect`. |
| `runtimes/python/tests/conformance/test_conformance.py` | Python consumer. Prints `corpus:` and `python: N/M`. |
| `runtimes/typescript/test/conformance/run.ts` | TypeScript consumer, and the comparator. Prints `corpus:` and `typescript: N/M`. |
| `.github/workflows/ci.yml` (`conformance`) | Runs both, then diffs the two verdict sets. |

Seven semantics are pinned bit for bit wherever they are numeric, all of them behaviour both runtimes
already implement — the suite adds no runtime features:

- **alias resolution** — a pinned alias to its concrete model, plus the closed failure modes.
- **budget accounting** — cost estimates, ledger totals, and the exact breach arithmetic.
- **prompt rendering** — padding, literal braces, missing and unused variables.
- **structured-output repair** — the repair loop's prompts and its terminal error.
- **retrieval ranking** — BM25, lexical rerank, and RRF scores against a fixed vector fixture.
- **eval-gate math** — `z_critical`, the baseline comparison, and the four rationale branches.
- **composite steps** — the arm a `branch` selects from a principal, the ceiling a `parallel`
  observes and the input-order merge it keeps when arms finish in reverse, the per-item bindings
  a `map` produces, the collection order a `reduce` preserves, and the depth bound all four share.

A case a runtime does not implement yet is scoped to the runtime that does, and the scope must carry
a reason naming the layer that lifts it: `runtimes: ["python"], reason: "..."`. A scope without a
reason fails both runners, so a gap is always visible rather than implied by silence. At present the
scoped cases are the agent loop, the guardrails engine and the memory stores, waiting on **L6b**, and
the `rerank`/`guard`/`agent` wiring steps, waiting on the **L6c** step drivers. Scope is never a way
to skip a case a runtime claims.

Each runner resolves the corpus path itself and prints what it resolved, and the job fails unless the
two resolved paths are identical and the case count each runtime reports equals the count the corpus
declares. A run that collected zero cases fails instead of passing vacuously — note that
`node --test <empty-directory>` exits 0 and reports one passing test, which is exactly the vacuity
this refuses. The comparator then requires equal populations, rejects an id emitted by only one
runtime, rejects unknown and duplicated ids, and rejects a field that differs in its last digit:
numbers compare within `1e-9`, so a drift in the sixth decimal is a failure rather than a rounding
artefact.

**Adding a case.** Add an entry to `conformance/corpus.json` and a handler branch for its `op` in both
runners. Run both, then set `expect` to the value they agree on. If they disagree, that is a
divergence to report and fix in the runtime — never an expectation to pick a winner for. Two things
are deliberately left out of the corpus: message wording that differs between the runtimes for
reasons unrelated to semantics (provider lists, known-name lists, validation-problem prose), and
behaviour that turns on one runtime's floating-point summation, such as `statistics.stdev` returning
an exact zero where a naive sum-of-squares returns `2e-16` over the same inputs.

---

## 13. Versioning & Compatibility

Five independently versioned artifacts:

| Artifact | Versioned by | Compatibility |
| ---------- | ------------- | --------------- |
| Spec / DSL | `specVersion` | Backward-compatible minor; migration tool for major |
| IR | `irVersion` | Generators declare `irRange` |
| Generator | own semver | Declares `irRange` + target runtime range + `emitsAgainst` lib ranges |
| Runtime lib | own semver | Declares IR/target range + supported provider SDK ranges |
| **Model alias binding** | ops config | Pins provider `modelId`; bumps are reviewed and eval-gated |

Rules: semver everywhere; a published compatibility matrix; `aid doctor` reports mismatches; unknown IR traits are preserved (forward-compatible), not dropped. **Model alias bumps are a first-class, reviewed change**: rebinding `fast` from one pinned ID to another must pass the linked evals before merge.

---

## 14. Roadmap

### Phase 0 — Foundations (MVP, prove the thesis)

*(Complete: spec v0.1, IR v0.1, the six build-time gates, the `py-fastapi` target, and the golden-file and
determinism tests are implemented.)*

- Spec v0.1 (models, prompts, tools, one pipeline) + JSON Schema.
- IR v0.x + validation + capability negotiation.
- CLI: `init`, `gen --dry-run`, `validate`.
- **One target: `py-fastapi`** emitting against **Pydantic AI** (structured output) + **LangGraph or plain async** for the loop, with **OTel GenAI** tracing.
- Generated: model gateway, prompt registry, one structured-output endpoint, one tool, one eval.
- Golden-file + determinism tests + a minimal eval harness. **Exit criteria: spec -> running traced AI endpoint with a passing eval gate.**

### Phase 1 — Retrieval + polyglot proof

*(In progress. The spec + IR layer ships first because it is the frozen contract the rest of the phase
consumes: §6.3's `stores`, `retrievers`, `retrieve` step, `embeddings` capability and `retrieval` metric
are in the DSL and the IR, each of the six §7.4 gates carries its one retrieval rule, and `embeddings` and
`rerank` are derived into `requiredCapabilities` so a target that cannot honour them refuses the spec
before codegen. The retrieval runtime, `aid ingest`, the `ts-vercel` target and the conformance suite are
the layers that follow.)*

- RAG: `aid ingest`, chunking/embedding/pgvector, hybrid + rerank, citations; retrieval evals.
- **Second target: `ts-vercel`** (Vercel AI SDK + zod).
- Extract the **cross-target conformance eval suite**; both runtimes pass it.

### Phase 2 — Production concerns

- Agents: full loop, handoffs, memory, HITL, budgets (token/cost/step) enforced in runtime.
- Guardrails engine + red-team safety suite; tool permissioning + least privilege. *(Landed in Python as
  L3 — §7.6: four stages, four actions, deny-by-default tool calls, offline corpus in CI. TypeScript
  parity is L6, so the TS runtime does not have this engine yet.)*
- Cost/latency dashboards; semantic + prompt caching; streaming + concurrency.

### Phase 3 — Business-logic focus (the payoff)

- `business/prompts` + `business/tools` + `business/rubrics` as first-class, reviewable tiers.
- **LLM-assisted authoring**: prose -> spec draft; spec -> tool + rubric stubs. Never structure.
- Eval-driven prompt optimization (borrow DSPy's compile step); baseline diffing; `aid doctor`, `eject`, upgrade codemods.

### Phase 4 — Ecosystem

- More targets (`dotnet-semantickernel`, `java-spring-ai`); plugin SDK + registry.
- Fine-tuning pipelines (dataset curation, PEFT/LoRA, serving) + model eval gates.
- **Optional** UI/chat tier (read-only-first, never full-CRUD-first).

### Phase 5 — Adoption

- Docs, per-stack quickstarts, migration guides, community generators + provider adapters.

---

## 15. Risks & Mitigations

| # | Risk | Impact | Mitigation |
| --- | ------ | -------- | ----------- |
| 1 | **Non-determinism** makes correctness fuzzy | No trustworthy CI | Two regimes: golden files (code) + eval suites w/ statistical thresholds (behavior); record/replay cassettes |
| 2 | **Model deprecation / churn** | Constant breakage | Pin `modelId`; bind logic to aliases; capability negotiation; ordered fallbacks; alias bumps are eval-gated |
| 3 | **Cost blowups** | Surprise bills, unhappy users | Budgets in IR; enforced in runtime; cost/latency gates in CI |
| 4 | **Prompt injection / tool misuse** | Data loss, exfiltration | Staged guardrails; tool side-effect levels; confirmation for destructive ops; least-privilege auth; red-team suite |
| 5 | **Eval data scarcity** | Nothing to gate on | Synthetic dataset generation + captured user feedback -> curated datasets |
| 6 | **Framework-on-framework fragility** (depends on LangChain/LangGraph internals) | Breakage on upgrades | Emit against stable public APIs only; keep runtime thin; make orchestration lib swappable via `emitsAgainst` |
| 7 | **Lowest-common-denominator across stacks** (Python ahead of TS for AI) | Weak output on one target | Capability negotiation; emit idiomatic per target; fail loudly on unsupported features |
| 8 | **RAG quality is data-dependent** | "It doesn't work" | Treat retrieval as tuning, not coding; retrieval evals; rerank + hybrid defaults |
| 9 | **Hype churn** | Wasted effort on fads | Depend only on stable layers (HTTP provider APIs, MCP, JSON Schema, OTel GenAI semconv) |
| 10 | **Lock-in fear** | Nobody starts | Full eject path; generated code is plain and dependency-light |
| 11 | **Judge bias** in LLM-as-judge evals | Misleading pass/fail | Cross-provider judges; calibrate against human labels; report confidence |
| 12 | **Scope explosion** (trying to own orchestration *and* evals *and* serving) | Never ships | Explicit non-goals; integrate evals/tracing/serving rather than rebuild |

---

## 16. Prior Art & Positioning

| Project | Model | Take |
| --------- | ------- | ------ |
| **DSPy** | Declarative signatures -> compiled/optimized prompts | **Closest philosophy** (declare intent, compile the prompt). We add full-app scaffold, polyglot targets, tools, retrieval, and eval-gated regeneration |
| **LangGraph / LlamaIndex / Haystack** | Orchestration runtimes | We **emit against** them; we own the IR + gateway + evals + codegen |
| **Pydantic AI / Instructor** | Typed, structured-output agents | Use as the structured-output runtime for the Python target |
| **Vercel AI SDK** | TS streaming/tools/providers | The TS target's runtime |
| **CrewAI / AutoGen** | Multi-agent orchestration | Source of patterns for handoffs/agent loop |
| **Semantic Kernel / Spring AI** | .NET/Java AI orchestration | Future targets |
| **Guardrails AI / NeMo Guardrails** | Guardrail engines | Integrate for policy evaluation |
| **Langfuse / LangSmith / Phoenix / W&B Weave** | Tracing + evals | Integrate; never rebuild |
| **promptfoo** | Eval CLI/datasets | Integrate for eval running |
| **Model Context Protocol (MCP)** | Tool interop | First-class tool binding |
| **vLLM / Ollama / TGI** | Local serving | Provider adapters; local-model-first dev story |
| **Smithy** | IR + traits + codegen plugins | Reference model for the IR/codegen core |

**Our wedge:** *one spec -> idiomatic AI apps in multiple stacks, with provider-agnostic models, eval-gated CI, and edit-safe business logic.* Nobody owns that intersection today: DSPy owns prompts; LangGraph owns orchestration; Langfuse owns tracing; nobody owns the end-to-end spec-to-app pipeline for AI.

---

## 17. Open Questions

1. **Own vs. delegate to LangGraph/DSPy/LlamaIndex?** (Recommend: own the IR + gateway + evals + codegen; delegate orchestration via `emitsAgainst`.)
2. **Eval gating policy** under non-determinism — how strict? (Recommend: N-run sampling, statistical thresholds, `maxRegression` vs. a stored baseline.)
3. **Judge model bias** — self-judge or cross-provider? How to calibrate to human labels?
4. **Provider abstraction depth** — lowest-common (OpenAI-compatible) vs. native features (Anthropic prompt caching, OpenAI structured outputs)? (Recommend: capability negotiation; native when declared and supported.)
5. **Local-first dev story** — default to Ollama for `aid dev`, hosted for prod?
6. **Default vector store** — pgvector (co-located, one fewer service) vs. a managed store? (Recommend: pgvector default.)
7. ~~**Budget enforcement** — hard fail vs. graceful degrade (route to a cheaper alias) when a cost/latency budget is hit?~~ **Closed in Phase 2 L2 (§7.5).** Hard failure is the default, because a run that silently answers on a different model is worse than one that stops. An agent may opt into `onBudgetExhausted: 'degrade'`, which steps exactly one rung down the declared alias ladder with no retry loop, must name a strictly cheaper fallback (enforced at build time, so the escape hatch cannot have nowhere to go), and is recorded in the trace as `degraded_from` so the degrade is observable rather than inferred.
8. **Fine-tuning scope** — in-scope at Phase 4, or leave entirely to the ecosystem?
9. **Prompt rollout** — canary/A-B routing of prompt versions tied to live evals?
10. ~~**Safety corpus** — build our own red-team suite or adopt an existing one?~~ **Closed in Phase 2 L3 (§7.6).** Own fixtures, with provenance recorded against public taxonomies (OWASP LLM Top 10, MITRE ATLAS) rather than a vendored third-party corpus: the suite has to hold *these* offline regex detectors to a standard and run with no network in CI, and an adopted corpus written against a classifier would have measured something this runtime does not claim. The categories are borrowed; the fixtures are ours, each with a checkable provenance field.
11. **Plugin execution model** — in-process (TS/Python) vs. WASM/gRPC plugins? Determines the third-party generator ecosystem.

Two decisions the Phase 2 plan listed as an open question are recorded in §7.6 rather than renumbered into this list: the **evaluation order** when several guardrails apply at one stage (declaration order, except that `block` outranks it, so a permissive guardrail cannot be declared first to neuter a strict one), and whether a **`flag` may be ignored** downstream (it may not be ignored, but it stops nothing — it is recorded on `RunResult.guardrails` and the `aid.guardrail` span for an eval, a log or a reviewer to consume).

---

## 18. Immediate Next Steps

1. Ratify §4 principles — especially *evals are the correctness net* and *pin models / abstract providers* — and resolve §17 open questions #1 and #2.
2. Write the **spec JSON Schema** + the formal **IR JSON Schema** for the AI shapes (§7.2).
3. Build the Phase 0 spike: `py-fastapi` target, one agent + one retriever + one eval, with OTel tracing; prove spec -> running endpoint with a passing eval gate.
4. Stand up CI with **both** regimes — golden files *and* the eval harness plus cost/latency gates — before adding a second target.

> *The framework succeeds if a developer can declare their AI app once and get a correct, idiomatic, traced, evaluated, regenerable service — then spend all their time in `business/` on prompts, tools, and rubrics.*
