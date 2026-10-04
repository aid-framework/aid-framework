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

```
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
    memory: [session]
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
|------|------|-----------|-------|
| 1 | Model aliases, provider wiring, params | Easy | Stable interfaces; high confidence |
| 2 | Prompt templating, variables, few-shot | Easy | Registry + rendering; version it |
| 3 | Structured output / schema binding | Easy–Medium | JSON Schema; repair loop in runtime |
| 4 | Tool declaration + schema generation | Medium | Interop via MCP; permissions matter |
| 5 | RAG ingestion + retrieval + rerank | Medium–Hard | Data-dependent quality; eval-driven |
| 6 | Agents, memory, budgets, HITL | Hard | Loop semantics; cost/safety enforcement |
| 7 | Eval suites + CI gating | Hard | Probabilistic thresholds; judge bias |
| 8 | Guardrails | Medium | Adopt engines; stage placement is subtle |
| 9 | Fine-tuning pipelines, serving | Hard | **Phase 4** |

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
  handoffs: string[];              // other agent ids
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
  | { kind: 'retrieve'; retriever: string; query: string; topK?: number; as: string }
  | { kind: 'rerank';   input: string; model: string; topN: number; as: string }
  | { kind: 'generate'; prompt: string; model?: string; input?: unknown; as: string; stream?: boolean }
  | { kind: 'agent';    agent: string; input: unknown; as: string }
  | { kind: 'tool';     tool: string; input: unknown; as: string }
  | { kind: 'branch';   when: PolicyExpr; then: StepShape[]; else?: StepShape[] }
  | { kind: 'parallel'; branches: StepShape[][] }
  | { kind: 'map';      over: string; step: StepShape }
  | { kind: 'reduce';   over: string; prompt: string; as: string }
  | { kind: 'guard';    guardrail: string; stage: 'input'|'output'|'retrieval'|'tool-call' }
  | { kind: 'assert';   expr: string; message: string }        // eval-time only
  | { kind: 'human';    prompt: string; timeout: string }
  | { kind: 'emit';     event: string };

type EvalShape = {
  id: string; name: string;
  target: string;                  // "agent:support" | "prompt:x" | "pipeline:y"
  dataset: { source: 'inline'|'file'|'synthetic'; cases?: unknown[]; uri?: string;
             generator?: { count: number; model: string } };
  metrics: Metric[];
  thresholds: { pass: number; warn: number };
  gate: { ci: boolean; maxRegression: number };   // max allowed drop vs. baseline
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
  | { kind: 'latency'; p95Ms: number };

type GuardrailShape = {
  id: string;
  stages: ('input'|'output'|'retrieval'|'tool-call')[];
  policies: PolicyRef[];           // pii-detect, pii-redact, moderation, prompt-injection, jailbreak, allowlist, schema, custom
  action: 'block'|'redact'|'flag'|'escalate';
  onFail: { message: string; fallbackPrompt?: string; log: boolean };
  traits: Trait[];
};

type MemoryShape = {
  id: string;
  kind: 'buffer'|'window'|'summary'|'semantic'|'episodic'|'vector';
  scope: 'session'|'user'|'tenant'|'global';
  tokenBudget: number;
  summarizeModel?: string;
  store?: string;
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

1. **Referential integrity** — every ref resolves (prompts, tools, models, retrievers, stores, memory, guardrails, pipelines).
2. **Normalization** — model aliases resolved; defaults materialized; enums expanded; naming canonical.
3. **Capability negotiation** — a prompt requiring `json-schema` must bind to a model declaring it; a target that cannot express cursor-style streaming or `long-context` fails loudly *before* codegen.
4. **Cost/latency sanity** — estimated per-run cost vs. declared budgets; warn/fail on models without a `costProfile`.
5. **Security gates** — every `write`/`destructive` tool has an `auth`; every pipeline touching untrusted input has an input guardrail; every trace config redacts declared PII fields. Fail-closed by default.
6. **Eval coverage** — every agent/prompt marked `ci` has a dataset and at least one metric; a spec change without a linked eval warns.

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

```
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
|---------|---------|
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
9. **Record/replay cassettes** — capture real LLM calls; replay deterministically in unit tests (VCR-style); live evals run nightly against pinned models.
10. **Generated-app E2E** — `aid init` a sample app, build it, run its eval suite, per target. If generated code doesn't run, CI is red.

**Compatibility matrix tests** — spec x generator x runtime x model-alias versions.

---

## 13. Versioning & Compatibility

Five independently versioned artifacts:

| Artifact | Versioned by | Compatibility |
|----------|-------------|---------------|
| Spec / DSL | `specVersion` | Backward-compatible minor; migration tool for major |
| IR | `irVersion` | Generators declare `irRange` |
| Generator | own semver | Declares `irRange` + target runtime range + `emitsAgainst` lib ranges |
| Runtime lib | own semver | Declares IR/target range + supported provider SDK ranges |
| **Model alias binding** | ops config | Pins provider `modelId`; bumps are reviewed and eval-gated |

Rules: semver everywhere; a published compatibility matrix; `aid doctor` reports mismatches; unknown IR traits are preserved (forward-compatible), not dropped. **Model alias bumps are a first-class, reviewed change**: rebinding `fast` from one pinned ID to another must pass the linked evals before merge.

---

## 14. Roadmap

### Phase 0 — Foundations (MVP, prove the thesis)
- Spec v0.1 (models, prompts, tools, one pipeline) + JSON Schema.
- IR v0.x + validation + capability negotiation.
- CLI: `init`, `gen --dry-run`, `validate`.
- **One target: `py-fastapi`** emitting against **Pydantic AI** (structured output) + **LangGraph or plain async** for the loop, with **OTel GenAI** tracing.
- Generated: model gateway, prompt registry, one structured-output endpoint, one tool, one eval.
- Golden-file + determinism tests + a minimal eval harness. **Exit criteria: spec -> running traced AI endpoint with a passing eval gate.**

### Phase 1 — Retrieval + polyglot proof
- RAG: `aid ingest`, chunking/embedding/pgvector, hybrid + rerank, citations; retrieval evals.
- **Second target: `ts-vercel`** (Vercel AI SDK + zod).
- Extract the **cross-target conformance eval suite**; both runtimes pass it.

### Phase 2 — Production concerns
- Agents: full loop, handoffs, memory, HITL, budgets (token/cost/step) enforced in runtime.
- Guardrails engine + red-team safety suite; tool permissioning + least privilege.
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
|---|------|--------|-----------|
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
|---------|-------|------|
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
7. **Budget enforcement** — hard fail vs. graceful degrade (route to a cheaper alias) when a cost/latency budget is hit?
8. **Fine-tuning scope** — in-scope at Phase 4, or leave entirely to the ecosystem?
9. **Prompt rollout** — canary/A-B routing of prompt versions tied to live evals?
10. **Safety corpus** — build our own red-team suite or adopt an existing one?
11. **Plugin execution model** — in-process (TS/Python) vs. WASM/gRPC plugins? Determines the third-party generator ecosystem.

---

## 18. Immediate Next Steps

1. Ratify §4 principles — especially *evals are the correctness net* and *pin models / abstract providers* — and resolve §17 open questions #1 and #2.
2. Write the **spec JSON Schema** + the formal **IR JSON Schema** for the AI shapes (§7.2).
3. Build the Phase 0 spike: `py-fastapi` target, one agent + one retriever + one eval, with OTel tracing; prove spec -> running endpoint with a passing eval gate.
4. Stand up CI with **both** regimes — golden files *and* the eval harness plus cost/latency gates — before adding a second target.

> *The framework succeeds if a developer can declare their AI app once and get a correct, idiomatic, traced, evaluated, regenerable service — then spend all their time in `business/` on prompts, tools, and rubrics.*
