/**
 * IR v0.1 shapes (`docs/design.md` §7.2).
 *
 * Every top-level collection in §7.2 is present in the IR, always. Phase 0 populates
 * `types`, `models`, `prompts`, `tools`, `pipelines`, and `evals`; the retrieval
 * surface adds `stores` and `retrievers` and derives `embeddings` from the models that
 * declare the `embeddings` capability. The rest are **present and empty (`[]`)** by
 * design, never omitted and never `undefined`: that stability is what lets a later
 * phase fill them without a breaking reshape. They are empty for two different
 * reasons, and the difference matters. `agents`, `guardrails`, `memory`, and
 * `deployments` are spec sections the DSL defines but defers (`DEFERRED_SECTIONS`), so
 * a spec cannot populate them yet. `embeddings` has no spec section at all: it is
 * IR-only scaffolding, derived rather than declared, declared here so §7.2's shape is
 * complete. `observability` and `runtime` are objects carrying defaults, not arrays.
 */

import type { ModelCapability, RequiredCapability } from './capabilities.js';
import type { PolicyExpr } from './policy/index.js';

/** IR format version. Semver, independent of the spec's `specVersion`. */
export const IR_VERSION = '0.1.0';

export const PRIMITIVE_TYPES = ['string', 'number', 'integer', 'boolean'] as const;

export type PrimitiveType = (typeof PRIMITIVE_TYPES)[number];

/**
 * A resolved type reference: `named` carries the declared type id and whether it
 * resolved, so a generator never re-resolves the spec.
 */
export type TypeRef =
  | { kind: 'primitive'; name: PrimitiveType; list: boolean }
  | { kind: 'named'; name: string; list: boolean; resolved: boolean };

export interface TypeField {
  name: string;
  type: TypeRef;
  required: boolean;
  description?: string;
  enum?: (string | number | boolean)[];
  minimum?: number;
  maximum?: number;
  /** Marks the field as sensitive; trace redaction must cover it. */
  sensitive?: boolean;
}

export interface TypeShape {
  id: string;
  kind: 'struct';
  description?: string;
  fields: TypeField[];
}

/**
 * The derived identity of an IR node (§5.2). Identities come from the declared
 * id — and the prompt version — never from content or ordering, so an unrelated
 * edit cannot churn an identity and therefore cannot churn a diff.
 */
export function modelIdentity(id: string): string {
  return `model:${id}`;
}

export function promptIdentity(id: string, version: number): string {
  return `prompt:${id}@${version}`;
}

export function toolIdentity(id: string): string {
  return `tool:${id}`;
}

export function pipelineIdentity(id: string): string {
  return `pipeline:${id}`;
}

/** Free-form, generator-specific annotation. Spec v0.1 declares `citations` only. */
export interface Trait {
  name: string;
  value?: unknown;
}

/**
 * Traits a retriever can declare in spec v0.1. A generator may emit behavior only
 * for a trait it recognizes, so an unrecognized one is dropped rather than kept
 * and silently ignored.
 */
export const RETRIEVAL_TRAITS = ['citations'] as const;

/** §7.2's provider union plus the two Phase 0 spec spellings. */
export const PROVIDERS = [
  'openai',
  'openai-compatible',
  'anthropic',
  'azure',
  'bedrock',
  'google',
  'ollama',
  'vllm',
  'fake',
  'custom',
] as const;

export type Provider = (typeof PROVIDERS)[number];

export function isProvider(value: string): value is Provider {
  return (PROVIDERS as readonly string[]).includes(value);
}

export interface ModelParams {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  seed?: number;
  stop?: string[];
}

export interface ModelLimits {
  /** Context window. The spec spells this `limits.maxInputTokens`. */
  contextTokens: number;
  maxOutputTokens?: number;
  rpm?: number;
  tpm?: number;
}

/** Per-million-token prices. Resolved from `src/catalog/models.json`. */
export interface CostProfile {
  inputPerMTok: number;
  outputPerMTok: number;
}

/**
 * The opt-in semantic cache: an explicit threshold and TTL, so no spec can enable
 * semantic caching and inherit a silent default for either.
 */
export interface SemanticCacheShape {
  /** Minimum cosine similarity (0..1) a new prompt must reach against a cached one. */
  threshold: number;
  /** How long (seconds) a cached response may be reused before it is invalidated. */
  ttlSeconds: number;
}

export interface ModelShape {
  id: string;
  /** Stable identity `model:<id>`; derived from the id, never from content. */
  identity: string;
  provider: Provider;
  modelId: string;
  capabilities: ModelCapability[];
  params: ModelParams;
  limits: ModelLimits;
  costProfile?: CostProfile;
  /** Catalog key the cost came from, when one resolved. */
  costProfileId?: string;
  fallbacks: string[];
  cache?: { prompt?: boolean; semantic?: SemanticCacheShape };
  baseUrl?: string;
  apiKeyEnv?: string;
  description?: string;
  traits: Trait[];
}

export interface PromptVariable {
  name: string;
  type: TypeRef;
  required: boolean;
  /** Any JSON value; the spec's `variables.<name>.default` is unconstrained. */
  default?: unknown;
  description?: string;
  /** Marks the value as sensitive; trace redaction must cover it. */
  sensitive?: boolean;
}

export interface PromptOutput {
  kind: 'text' | 'json' | 'structured';
  schema?: TypeRef;
}

export interface PromptShape {
  id: string;
  version: number;
  /** Stable identity, `prompt:<id>@<version>`. */
  identity: string;
  model: string;
  template: string;
  variables: PromptVariable[];
  output: PromptOutput;
  params: ModelParams;
  examples: unknown[];
  guardrails: string[];
  evals: string[];
  traits: Trait[];
}

export type SideEffects = 'none' | 'read' | 'write' | 'destructive';

export type Idempotency = 'none' | 'key' | 'natural';

export interface ToolHandler {
  kind: 'generated' | 'business' | 'mcp';
  symbol?: string;
  mcp?: { server: string; tool: string };
}

export interface ToolShape {
  id: string;
  /** Stable identity `tool:<id>`; derived from the id, never from content. */
  identity: string;
  name: string;
  description: string;
  input: TypeRef;
  output: TypeRef;
  sideEffects: SideEffects;
  requiresConfirmation: boolean;
  /** Parsed policy, absent when the spec declared none or it failed to parse. */
  auth?: PolicyExpr;
  timeoutMs: number;
  retries: number;
  idempotency: Idempotency;
  handler: ToolHandler;
  traits: Trait[];
}

export type PipelineTrigger =
  | { kind: 'http'; method: string; path: string }
  | { kind: 'schedule'; schedule: string }
  | { kind: 'event'; event: string }
  | { kind: 'manual' };

export type StepInputValue =
  | { kind: 'literal'; value: string | number | boolean | null }
  | { kind: 'reference'; path: string[] }
  | { kind: 'template'; template: string };

export type StepInput = Record<string, StepInputValue>;

export interface GenerateStep {
  kind: 'generate';
  prompt: string;
  /** Model alias the prompt resolves to, inlined so a runtime need not re-resolve. */
  model: string;
  input: StepInput;
  as: string;
  /**
   * Binding whose retrieved items and citations are inlined into the prompt. The
   * referential gate resolves the name against the bindings in scope.
   */
  context?: string;
}

export interface ToolStep {
  kind: 'tool';
  tool: string;
  input: StepInput;
  as: string;
}

export interface EmitStep {
  kind: 'emit';
  event: string;
}

/**
 * A retrieval step. `query` stays the declared template text, because the runtime
 * interpolates it per request; the referential gate reads its placeholders to
 * reject a reference to a binding that does not exist yet.
 */
export interface RetrieveStep {
  kind: 'retrieve';
  retriever: string;
  query: string;
  as: string;
}

/**
 * Authorization branching. `when` is evaluated against the caller's Principal and
 * nothing else: the grammar has no operand for a context value, so a branch cannot
 * read what an earlier step produced. Data-driven control flow is `map`/`reduce`.
 */
export interface BranchStep {
  kind: 'branch';
  when: PolicyExpr;
  then: StepShape[];
  /** Absent when the spec declared no alternative; then the branch binds nothing. */
  else: StepShape[];
}

/** Each arm runs concurrently under the deployment's single concurrency cap. */
export interface ParallelStep {
  kind: 'parallel';
  branches: StepShape[][];
}

/** Applies `step` to every item of `over`, concurrently; binds the ordered results. */
export interface MapStep {
  kind: 'map';
  over: string;
  as: string;
  step: StepShape;
}

/**
 * Applies `prompt` to every item of `over`, concurrently, and binds the ordered list of
 * results. Combining them is a following `generate` step, so no merge strategy is
 * invented here.
 */
export interface ReduceStep {
  kind: 'reduce';
  over: string;
  prompt: string;
  /** Model alias the prompt resolves to, inlined so a runtime need not re-resolve. */
  model: string;
  as: string;
}

/**
 * Reorders the retrieved items bound by `over` against `query`.
 *
 * The runtime's `Reranker.rerank(query, items, *, top_n)` takes both a query and the
 * items, so the step names both rather than carrying the design's single `input`: one
 * field could not supply a query *and* say which binding is being reordered.
 */
export interface RerankStep {
  kind: 'rerank';
  /** Binding holding the retrieval result to reorder; the referential gate types it. */
  over: string;
  query: string;
  /** Reranker alias, not a `models[]` id: only the lexical reranker exists today. */
  model: string;
  topN: number;
  as: string;
}

/**
 * Runs one declared guardrail against one payload at one stage.
 *
 * Binds nothing: a `flag` verdict is observability only, and the actions that could
 * change the payload are refused when the pipeline is validated.
 */
export interface GuardStep {
  kind: 'guard';
  guardrail: string;
  stage: 'input' | 'output' | 'retrieval' | 'tool-call';
  /**
   * Stage-discriminated. At `input`/`output` this is template text handed to the
   * guardrail as the payload; at `retrieval` it is a single reference to a retrieval
   * binding, whose chunk passages are what `check_retrieval` inspects.
   */
  text: string;
}

/**
 * Runs a declared agent to completion and binds its answer.
 *
 * The step owns a fresh run of the agent: it opens no thread and resumes nothing, so a
 * target that can pause is refused where the pipeline is validated.
 */
export interface AgentStep {
  kind: 'agent';
  agent: string;
  /** User turn for the run; the agent's own instructions stay with the agent. */
  text: string;
  as: string;
}

export type StepShape =
  | GenerateStep
  | RetrieveStep
  | ToolStep
  | EmitStep
  | BranchStep
  | ParallelStep
  | MapStep
  | ReduceStep
  | RerankStep
  | GuardStep
  | AgentStep;

/** The composite kinds: the four that nest other steps and so can recurse. */
export const COMPOSITE_STEP_KINDS = ['branch', 'parallel', 'map', 'reduce'] as const;

/** The step kinds that contain other steps, so every walker has one guard to reach for. */
export type CompositeStep = BranchStep | ParallelStep | MapStep | ReduceStep;

export function isCompositeStep(step: { kind: StepShape['kind'] }): step is CompositeStep {
  return (COMPOSITE_STEP_KINDS as readonly string[]).includes(step.kind);
}

/**
 * Deepest composite nesting a pipeline may declare. The spec layer owns the number and
 * rejects a deeper pipeline before generation; the generator *emits* it into the
 * generated package (`aid_runtime.control` keeps a default for hand-written use), so a
 * drift between build and runtime fails a test instead of diverging silently.
 */
export { MAX_STEP_DEPTH } from '@aid/spec';

export interface ErrorPolicy {
  retries: number;
  fallback?: string;
  deadLetter?: string;
}

export interface ObservabilityShape {
  trace: boolean;
  redact: string[];
}

export interface PipelineShape {
  id: string;
  /** Stable identity `pipeline:<id>`; derived from the id, never from content. */
  identity: string;
  description?: string;
  trigger: PipelineTrigger;
  steps: StepShape[];
  errorPolicy: ErrorPolicy;
  /** Resolved from the top-level `observability` during normalization. */
  observability: ObservabilityShape;
}

export const EVAL_TARGET_KINDS = ['pipeline', 'prompt'] as const;

export type EvalTargetKind = (typeof EVAL_TARGET_KINDS)[number];

export interface EvalTarget {
  kind: EvalTargetKind;
  id: string;
  /** The `kind:id` form as declared. */
  qualified: string;
  /** False when `qualified` is not a `kind:id` pair with a known kind. */
  valid: boolean;
}

export interface EvalDataset {
  source: 'inline' | 'file' | 'synthetic';
  uri?: string;
}

export type MetricShape =
  | { kind: 'exact'; field: string }
  | { kind: 'contains'; field: string; value?: string }
  | { kind: 'json-schema'; schema: TypeRef }
  | { kind: 'tool-trace'; expect: string[]; ordered: boolean }
  | { kind: 'cost'; max: number }
  | { kind: 'latency'; maxMs: number }
  | { kind: 'llm-judge'; rubric: string; field?: string; model?: string; threshold?: number }
  | { kind: 'retrieval'; expectDocs: string[]; k: number };

export interface EvalGate {
  ci: boolean;
  maxRegression: number;
  samples: number;
}

export interface EvalShape {
  id: string;
  description?: string;
  target: EvalTarget;
  dataset: EvalDataset;
  metrics: MetricShape[];
  gate: EvalGate;
  /** Tightest `cost` metric `max`, in the run's currency. */
  costBudget?: number;
  latencyBudgetP95Ms?: number;
  traits: Trait[];
}

export interface ProjectShape {
  name: string;
  namespace: string;
  description?: string;
  targets: string[];
}

export interface RuntimeShape {
  /** Phase 0 executes generated pipelines as plain sequential async control flow. */
  controlFlow: 'plain-async';
  orchestration?: string;
}

/**
 * Shaped per design §7.2. Populated from the `retrievers` spec section as of the
 * retrieval surface; the collections that remain deferred (`agents`, `guardrails`,
 * `memory`, `deployments`) are empty, since an empty array is otherwise
 * indistinguishable from "not implemented".
 */
export interface RetrieverShape {
  id: string;
  source: { kind: 'file' | 's3' | 'http' | 'db' | 'mcp'; uri: string; glob?: string };
  chunking: {
    strategy: 'fixed' | 'recursive' | 'semantic' | 'code';
    size: number;
    overlap: number;
    keepMetadata: string[];
  };
  embedModel: string;
  /** Vector store id. */
  store: string;
  index: { metric: IndexMetric; hybrid: boolean; params?: Record<string, unknown> };
  topK: number;
  /** A deterministic lexical reranker in Phase 1, named by a model alias. */
  rerank?: { model: string; topN: number };
  filters?: string[];
  refresh: { mode: 'full' | 'incremental'; schedule?: string };
  traits: Trait[];
}

/**
 * One per model that declares the `embeddings` capability, so a runtime can pick an
 * embedder without re-reading `models`. Embeddings have no spec section of their
 * own; the model alias is the id, which keeps `retriever.embedModel` resolvable.
 */
export interface EmbeddingShape {
  id: string;
  provider: Provider;
  modelId: string;
  dimensions?: number;
  costProfile?: CostProfile;
  traits: Trait[];
}

/** The vector-distance metrics the IR models. Spec v0.1 can declare any of them. */
export const INDEX_METRICS = ['cosine', 'dot', 'l2'] as const;

export type IndexMetric = (typeof INDEX_METRICS)[number];

export function isIndexMetric(value: string): value is IndexMetric {
  return (INDEX_METRICS as readonly string[]).includes(value);
}

/** Vector store kinds the IR models. Spec v0.1 can declare `memory` and `pgvector`. */
export const VECTOR_STORE_KINDS = [
  'memory',
  'pgvector',
  'qdrant',
  'pinecone',
  'weaviate',
  'custom',
] as const;

export type VectorStoreKind = (typeof VECTOR_STORE_KINDS)[number];

export function isVectorStoreKind(value: string): value is VectorStoreKind {
  return (VECTOR_STORE_KINDS as readonly string[]).includes(value);
}

export interface VectorStoreShape {
  id: string;
  kind: VectorStoreKind;
  /** `env:NAME` for a hosted store; absent for `memory`. */
  uri?: string;
  dimensions?: number;
  traits: Trait[];
}

export interface MemoryShape {
  id: string;
  kind: 'buffer' | 'window' | 'summary' | 'semantic' | 'episodic' | 'vector';
  scope: 'thread' | 'user' | 'global';
  tokenBudget: number;
  summarizeModel?: string;
  store?: string;
  /** A declared store id or `in-process`; resolved by the `memory/refs` gate. */
  backend?: string;
  ttl?: string;
  redact: string[];
  traits: Trait[];
}

/** Who owns the agent loop. `deepagents` requires a pinned `engineVersion`. */
export const AGENT_ENGINES = ['native', 'deepagents'] as const;

export type AgentEngine = (typeof AGENT_ENGINES)[number];

/** What happens when an agent's budget is exhausted. `fail` is the default. */
export const AGENT_ON_BUDGET_EXHAUSTED = ['fail', 'degrade'] as const;

export type AgentOnBudgetExhausted = (typeof AGENT_ON_BUDGET_EXHAUSTED)[number];

export interface AgentShape {
  id: string;
  name: string;
  /** Prompt ref supplying the agent's instructions. */
  instructions: string;
  model: string;
  tools: string[];
  retrievers: string[];
  memory: string[];
  guardrails: string[];
  structuredOutput?: TypeRef;
  maxSteps: number;
  maxTokensBudget?: number;
  /** USD. */
  maxCostBudget?: number;
  /**
   * `fail` (the default) makes a budget breach a hard failure. `degrade` steps
   * once to the first cheaper fallback alias; the `agents/budget-degrade` gate
   * rejects it without a cost ceiling and a strictly cheaper alias.
   */
  onBudgetExhausted?: AgentOnBudgetExhausted;
  /** Other agent ids this agent may transfer the conversation to. */
  handoffs: string[];
  /** Other agent ids this agent may delegate a sub-task to. */
  delegates: string[];
  engine: AgentEngine;
  /** Pinned framework version; required when `engine` is `deepagents`. */
  engineVersion?: string;
  humanInTheLoop?: { when: PolicyExpr; channel: string };
  traits: Trait[];
}

export interface GuardrailShape {
  id: string;
  stages: ('input' | 'output' | 'retrieval' | 'tool-call')[];
  policies: GuardrailPolicyKind[];
  action: 'block' | 'redact' | 'flag' | 'escalate';
  /** Field names the `redact` action removes; required for that action. */
  redact: string[];
  /** Tools this guardrail covers; empty means every tool reaching the stage. */
  tools: string[];
  onFail: { message: string; fallbackPrompt?: string; log: boolean };
  traits: Trait[];
}

/**
 * The closed vocabulary of policy checks a guardrail may name. This is the L1 answer
 * to "no passthrough of unknown keys": a spec names one of these, the engine that
 * evaluates them ships in the guardrails layer, and nothing in between accepts a name
 * it does not know. Extending it is a deliberate edit here, not a spec-side string.
 */
export const GUARDRAIL_POLICY_KINDS = [
  'pii-detect',
  'pii-redact',
  'prompt-injection',
  'jailbreak',
  'moderation',
  'toxicity',
  'secret-scan',
] as const;

export type GuardrailPolicyKind = (typeof GUARDRAIL_POLICY_KINDS)[number];

export function isGuardrailPolicyKind(value: string): value is GuardrailPolicyKind {
  return (GUARDRAIL_POLICY_KINDS as readonly string[]).includes(value);
}

export interface DeploymentShape {
  id: string;
  target: 'serverless' | 'container' | 'batch' | 'edge';
  streaming: boolean;
  concurrency?: number;
  autoscale?: { min: number; max: number; metric: string };
  secrets: string[];
  env: { name: string; value?: string; secret?: boolean }[];
  traits: Trait[];
}

export interface IR {
  /** Semver of the IR format itself; independent of `specVersion`. */
  irVersion: string;
  specVersion: string;
  project: ProjectShape;
  types: TypeShape[];
  models: ModelShape[];
  prompts: PromptShape[];
  tools: ToolShape[];
  retrievers: RetrieverShape[];
  embeddings: EmbeddingShape[];
  stores: VectorStoreShape[];
  memory: MemoryShape[];
  agents: AgentShape[];
  pipelines: PipelineShape[];
  evals: EvalShape[];
  guardrails: GuardrailShape[];
  deployments: DeploymentShape[];
  observability: ObservabilityShape;
  runtime: RuntimeShape;
  /** Target capabilities the IR requires; derived from IR content by the gates. */
  requiredCapabilities: RequiredCapability[];
}

/** The IR's collection keys, i.e. every top-level key whose value is an array. */
export const IR_COLLECTIONS = [
  'types',
  'models',
  'prompts',
  'tools',
  'retrievers',
  'embeddings',
  'stores',
  'memory',
  'agents',
  'pipelines',
  'evals',
  'guardrails',
  'deployments',
] as const;

export type IrCollection = (typeof IR_COLLECTIONS)[number];

/** Spec section -> IR collection, for every section that populates one. */
export const POPULATED_COLLECTION_BY_SECTION = {
  types: 'types',
  models: 'models',
  prompts: 'prompts',
  tools: 'tools',
  stores: 'stores',
  retrievers: 'retrievers',
  memory: 'memory',
  agents: 'agents',
  guardrails: 'guardrails',
  deployments: 'deployments',
  evals: 'evals',
  pipelines: 'pipelines',
} as const;

/**
 * IR collections with no spec section: present and populated by derivation rather
 * than declared. Embeddings come from the models that declare the `embeddings`
 * capability, so a spec never names one.
 */
export const IR_ONLY_COLLECTIONS = ['embeddings'] as const;

/**
 * Supported spec sections that map to an IR object rather than a collection.
 * Together with `POPULATED_COLLECTION_BY_SECTION` these account for every
 * `SUPPORTED_SECTIONS` entry exactly once.
 */
export const NON_COLLECTION_SECTIONS = ['specVersion', 'project'] as const;

/** Providers Phase 0 can actually serve. The IR's `Provider` union is wider. */
export const PHASE_0_PROVIDERS = ['openai', 'openai-compatible', 'fake'] as const;

/** Phase 0 defaults for the two IR objects that are not collections. */
export const DEFAULT_OBSERVABILITY: ObservabilityShape = { trace: true, redact: [] };

export const DEFAULT_RUNTIME: RuntimeShape = { controlFlow: 'plain-async' };

export const DEFAULT_MAX_CONTEXT_TOKENS = 128_000;
