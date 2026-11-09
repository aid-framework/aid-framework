/**
 * IR v0.1 shapes (`docs/design.md` §7.2).
 *
 * Every top-level collection in §7.2 is present in the IR, always — never omitted and
 * never `undefined`, even when the spec leaves it out. That stability is what let each
 * phase fill a collection without a breaking reshape, and it is why an empty array means
 * "the spec declared none" rather than "not implemented". Every spec section now
 * populates: `types`, `models`, `prompts`, `tools`, `pipelines`, and `evals` from the
 * start, the retrieval surface adds `stores`, `retrievers`, and `memory`, and the agent
 * surface adds `agents`, `guardrails`, and `deployments`. `embeddings` is the exception:
 * it has no spec section at all, derived instead from the models that declare the
 * `embeddings` capability. `observability` and `runtime` are objects carrying defaults,
 * not arrays.
 */

import type { ModelCapability, RequiredCapability } from './capabilities.js';
import type { PolicyExpr } from './policy/index.js';
import type { PredicateNode } from './predicate/index.js';

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
  'gemini',
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

/**
 * Runs the arm a `choice` decision's answer names.
 *
 * Unlike `branch`, whose `when` sees only the caller's Principal, `input` is a template
 * over earlier bindings, so a route may depend on what a previous step produced. The
 * decision is asked once per step, and exactly one arm runs.
 */
export interface RouteStep {
  kind: 'route';
  /** Declared decision id; the spec validator guarantees its type is `choice`. */
  decision: string;
  /** Template text the decision classifies. */
  input: string;
  /** Label to the steps that answer it. Covers every label unless `default` exists. */
  on: Readonly<Record<string, StepShape[]>>;
  /** The arm for a label `on` leaves out; absent when `on` covers everything. */
  default?: StepShape[];
  /** Binding for the chosen label, when a later step needs to name the path. */
  as?: string;
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
  | AgentStep
  | RouteStep;

/** The composite kinds: the five that nest other steps and so can recurse. */
export const COMPOSITE_STEP_KINDS = ['branch', 'parallel', 'map', 'reduce', 'route'] as const;

/** The step kinds that contain other steps, so every walker has one guard to reach for. */
export type CompositeStep = BranchStep | ParallelStep | MapStep | ReduceStep | RouteStep;

export function isCompositeStep(step: { kind: StepShape['kind'] }): step is CompositeStep {
  return (COMPOSITE_STEP_KINDS as readonly string[]).includes(step.kind);
}

/**
 * Deepest composite nesting a pipeline may declare. The spec layer owns the number and
 * rejects a deeper pipeline before generation; the generator *emits* it into the
 * generated package (`aid_runtime.control` keeps a default for hand-written use), so a
 * drift between build and runtime fails a test instead of diverging silently.
 */
export { MAX_STEP_DEPTH } from '@aid-framework/spec';

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
  | { kind: 'retrieval'; expectDocs: string[]; k: number }
  | { kind: 'decision'; decision: string }
  | { kind: 'assert'; expr: PredicateNode; message: string };

export interface EvalGate {
  ci: boolean;
  maxRegression: number;
  samples: number;
  /**
   * Absolute floor on every metric's mean, checked before the maxRegression delta.
   *
   * Absent unless the spec declared it, so an eval that does not carry one serializes
   * exactly as it did before this property existed.
   */
  minMean?: number;
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
 * The managed engines a knowledge base can use. Each reads its own cloud's bucket and
 * answers only from its own cloud, because the credentials are the cloud's.
 */
export const KNOWLEDGE_BASE_ENGINES = ['aws-bedrock', 'vertex-rag'] as const;

export type KnowledgeBaseEngine = (typeof KNOWLEDGE_BASE_ENGINES)[number];

export function isKnowledgeBaseEngine(value: string): value is KnowledgeBaseEngine {
  return (KNOWLEDGE_BASE_ENGINES as readonly string[]).includes(value);
}

/**
 * A managed knowledge base: the cloud owns ingestion, chunking, embedding, the vector
 * store and the index. The runtime only asks it for chunks, so this shape carries no
 * `source`/`store`/`index` of its own — those would be a second, unchecked pipeline.
 */
export interface KnowledgeBaseShape {
  id: string;
  engine: KnowledgeBaseEngine;
  dataSource: { kind: 's3' | 'gcs'; uri: string };
  chunking: { strategy: 'fixed' | 'recursive' | 'code'; size: number; overlap: number };
  /** A model alias that must declare `embeddings` on the engine's own cloud. */
  embedModel: string;
  /** Metadata keys the filter contract may use; drives the sidecar convention. */
  filterable: string[];
  /**
   * `provisioned` has the emitted module create a store; `existing` points at one the
   * operator already pays for and carries the `arn`. A managed base is never a local
   * `VectorStoreShape`, because the engine owns it.
   */
  vectorStore: { kind: 'provisioned' | 'existing'; arn?: string };
}

/**
 * Shaped per design §7.2 and populated from the `retrievers` spec section. This is the
 * declaration only; the generated runtime owns chunking, embedding, and search.
 */
export interface LocalRetrieverShape {
  kind: 'local';
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
 * A retriever bound to a managed knowledge base. It has no `source`, `chunking`,
 * `embedModel`, `store`, `index` or `refresh`: those describe a pipeline the local
 * runtime performs, and the cloud performs this one. What survives is the query shape
 * — `topK`, the optional reranker and filters — because those still run here.
 */
export interface ManagedRetrieverShape {
  kind: 'managed';
  id: string;
  /** Id of a `KnowledgeBaseShape`. Resolved by the `retrievers/knowledge-bases` gate. */
  knowledgeBase: string;
  topK: number;
  rerank?: { model: string; topN: number };
  filters?: string[];
  traits: Trait[];
}

export type RetrieverShape = LocalRetrieverShape | ManagedRetrieverShape;

export function isManagedRetriever(retriever: RetrieverShape): retriever is ManagedRetrieverShape {
  return retriever.kind === 'managed';
}

/**
 * The local half of the union, as a predicate so a `.filter()` narrows the element type.
 * Every emitter that spells a source, chunking, store or index needs the narrowing;
 * without it each one would restate a cast.
 */
export function isLocalRetriever(retriever: RetrieverShape): retriever is LocalRetrieverShape {
  return retriever.kind === 'local';
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

/**
 * The question types Jev answers. Closed on purpose: each one has its own reply shape
 * and its own criteria rule, so a spec may not name a fourth.
 */
export const DECISION_QUESTION_TYPES = ['choice', 'score', 'noul'] as const;

export type DecisionQuestionType = (typeof DECISION_QUESTION_TYPES)[number];

/**
 * What the runtime does when the decision call fails: an unreachable vendor is either
 * a closed door (`block`, the default for a gate) or an open one (`allow`).
 */
export const DECISION_ON_ERROR = ['allow', 'block'] as const;

export type DecisionOnError = (typeof DECISION_ON_ERROR)[number];

/**
 * A Jev decision point. Not a provider: there is no chat surface to map onto, so a
 * decision is a named question that a guardrail, a router, or an eval can ask.
 *
 * `criteria` carries the declared wire shape rather than a normalized one: a `choice`
 * question is a label -> description map, and a `score` question is an ordered list
 * where position is the score. Sorting the map is the build's job; order in the list
 * is meaning and is preserved.
 */
export interface DecisionShape {
  id: string;
  identity: string;
  provider: 'typesafe';
  model: string;
  type: DecisionQuestionType;
  instructions: string;
  criteria?: Record<string, string> | string[];
  onError: DecisionOnError;
  description?: string;
  traits: Trait[];
}

export function decisionIdentity(id: string): string {
  return `decision:${id}`;
}

/** The engines a guardrail's policy can live in. */
export const GUARDRAIL_ENGINES = ['builtin', 'bedrock', 'model-armor'] as const;

export type GuardrailEngine = (typeof GUARDRAIL_ENGINES)[number];

/** The content categories a managed guardrail filters, in AWS's order. */
export const BEDROCK_CONTENT_FILTERS = [
  'sexual',
  'violence',
  'hate',
  'insults',
  'misconduct',
  'prompt-attack',
] as const;

export type BedrockContentFilter = (typeof BEDROCK_CONTENT_FILTERS)[number];

/** How strongly the managed filter reacts to a category. */
export const BEDROCK_CONTENT_STRENGTHS = ['low', 'medium', 'high'] as const;

export type BedrockContentStrength = (typeof BEDROCK_CONTENT_STRENGTHS)[number];

/** The personal-information entities a managed guardrail can detect. */
export const BEDROCK_PII_ENTITIES = [
  'email',
  'phone',
  'name',
  'address',
  'ssn',
  'credit-card',
  'bank-account',
  'passport',
  'drivers-license',
  'ip-address',
  'url',
  'aws-access-key',
  'aws-secret-key',
] as const;

export type BedrockPiiEntity = (typeof BEDROCK_PII_ENTITIES)[number];

/**
 * The managed policy a `bedrock`-engine guardrail owns.
 *
 * The spec vocabulary is the DSL's, not AWS's: `prompt-attack` and `credit-card` are
 * mapped to the vendor's identifiers in one place, so a spec never spells an enum it
 * cannot see the effect of. `topics` maps a name to the definition the classifier is
 * given, because the definition *is* the policy.
 */
export interface BedrockGuardrailPolicy {
  content?: Partial<Record<BedrockContentFilter, BedrockContentStrength>>;
  topics?: Record<string, string>;
  words?: string[];
  pii?: BedrockPiiEntity[];
}

/** The responsible-AI categories a Model Armor template can filter. */
export const MODEL_ARMOR_RAI_FILTERS = ['sexual', 'hate', 'harassment', 'dangerous'] as const;

export type ModelArmorRaiFilter = (typeof MODEL_ARMOR_RAI_FILTERS)[number];

/** How confident a Model Armor filter must be before it refuses content. */
export const MODEL_ARMOR_CONFIDENCES = ['low-and-above', 'medium-and-above', 'high'] as const;

export type ModelArmorConfidence = (typeof MODEL_ARMOR_CONFIDENCES)[number];

/**
 * The managed policy a `model-armor`-engine guardrail owns.
 *
 * Unlike the Bedrock block, this one is optional: its absence is the 0.14 story,
 * where the operator created the template and the deployment only names it. When it
 * is present the deployment creates a `google_model_armor_template`, so every filter
 * the template can carry is stated here or left off -- there is no per-call policy
 * the way `ApplyGuardrail` has one.
 *
 * DLP inspect/deidentify templates and custom filter rules are deliberately absent:
 * both name resources this deployment does not create, so they stay operator inputs.
 */
export interface ModelArmorGuardrailPolicy {
  rai?: Partial<Record<ModelArmorRaiFilter, ModelArmorConfidence>>;
  promptInjection?: ModelArmorConfidence;
  maliciousUri?: boolean;
  sensitiveData?: boolean;
}

export interface GuardrailShape {
  id: string;
  /** Where the policy is evaluated; `builtin` when the document does not say. */
  engine: GuardrailEngine;
  /** The managed policy, when `engine` is `bedrock` and the spec owns it. */
  bedrock?: BedrockGuardrailPolicy;
  /** The template policy, when `engine` is `model-armor` and the spec owns it. */
  modelArmor?: ModelArmorGuardrailPolicy;
  stages: ('input' | 'output' | 'retrieval' | 'tool-call')[];
  policies: GuardrailPolicyKind[];
  action: 'block' | 'redact' | 'flag' | 'escalate';
  /**
   * The `choice` decision this guardrail asks at the input stage, if any. The
   * policy check still runs first; a decision is asked only when it is present.
   */
  decision?: string;
  /** Label → action for the decision answer, covering every declared label. */
  onDecision?: Record<string, GuardrailDecisionAction>;
  /** Answer confidence below this fails closed as a block. Absent means 0. */
  minConfidence?: number;
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

/**
 * The closed vocabulary of answers a decision-backed guardrail may map. It is
 * wider than `GuardrailShape['action']` by `allow` -- the one outcome that is *not*
 * a record -- and narrower by `redact`, because a label cannot name the field a
 * masking pass would rewrite.
 */
export const GUARDRAIL_DECISION_ACTIONS = ['allow', 'block', 'flag', 'escalate'] as const;

export type GuardrailDecisionAction = (typeof GUARDRAIL_DECISION_ACTIONS)[number];

/**
 * The deployment targets the spec schema admits, in the order it lists them.
 *
 * This is the single runtime list: `buildDeployments` reads it to refuse a target it
 * cannot represent, and a test pins it against the schema's `target` enum so a target
 * added to one side cannot be silently coerced on the other.
 */
export const DEPLOY_TARGETS = ['serverless', 'container', 'batch', 'edge'] as const;

export type DeploymentTarget = (typeof DEPLOY_TARGETS)[number];

/**
 * The registries a container image may be published to.
 *
 * Closed, and `ghcr.io` is the only entry for now: a generated release workflow pushes
 * with the `GITHUB_TOKEN` it already holds, while every other registry needs a
 * credential (an ECR role, a Docker Hub token) the spec cannot hold without inventing
 * one. Extending this list means adding the push path that makes the new entry true.
 */
export const IMAGE_REGISTRIES = ['ghcr.io'] as const;

export type ImageRegistry = (typeof IMAGE_REGISTRIES)[number];

/** Where the image for a container deployment is published; there is one image per project. */
export interface DeploymentImageShape {
  registry: ImageRegistry;
  /** Repository path under the registry, without the host: `acme/support-copilot`. */
  name: string;
}

/**
 * The managed agent runtimes a container service may be deployed onto, from spec 0.13.
 *
 * Both run the image `target: container` already builds, which is why this is a
 * destination rather than a second generation path: the platform schedules, isolates and
 * addresses the process the app already is.
 */
export const AGENT_RUNTIME_PLATFORMS = ['aws-agentcore', 'gcp-agent-platform'] as const;

export type AgentRuntimePlatform = (typeof AGENT_RUNTIME_PLATFORMS)[number];

/**
 * The cloud each platform runs on. The platform's credentials are the deploy's
 * credentials, so a platform and `--cloud` that disagree are refused instead of deployed
 * unreachable; keeping the mapping here means the refusal and the plan cannot disagree.
 */
export const RUNTIME_CLOUDS: Readonly<Record<AgentRuntimePlatform, 'aws' | 'gcp'>> = {
  'aws-agentcore': 'aws',
  'gcp-agent-platform': 'gcp',
};

/** A managed agent runtime, with the defaults the runtime enforces already applied. */
export interface DeploymentRuntimeShape {
  platform: AgentRuntimePlatform;
  /** AgentCore Memory. `false` on every platform that cannot create one. */
  memory: { shortTerm: boolean };
  /** Session lifetime in minutes; 480 when the spec names none. */
  session: { ttlMinutes: number };
}

export interface DeploymentShape {
  id: string;
  target: DeploymentTarget;
  streaming: boolean;
  concurrency?: number;
  autoscale?: { min: number; max: number; metric: string };
  secrets: string[];
  env: { name: string; value?: string; secret?: boolean }[];
  /**
   * Where a container image is published. Present only on a `target: container`
   * deployment, and only from spec 0.4: the registry is a closed set (`ghcr.io`), so a
   * release workflow can push with a token the repository already has.
   */
  image?: DeploymentImageShape;
  /**
   * The managed agent runtime this container service runs on, from spec 0.13. Present
   * only on `target: container`: the platform runs the image that target builds, so the
   * compute module is replaced rather than paired with it.
   */
  runtime?: DeploymentRuntimeShape;
  /**
   * The pipeline a `target: batch` job runs, by id, from spec 0.5. A batch deployment
   * runs exactly one pipeline once to completion, and that pipeline declares
   * `trigger: { manual: true }` so no route contradicts it. Absent on every other
   * target, whose entrypoint is the request rather than the deployment.
   */
  pipeline?: string;
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
  knowledgeBases: KnowledgeBaseShape[];
  embeddings: EmbeddingShape[];
  stores: VectorStoreShape[];
  memory: MemoryShape[];
  agents: AgentShape[];
  pipelines: PipelineShape[];
  evals: EvalShape[];
  guardrails: GuardrailShape[];
  decisions: DecisionShape[];
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
  'knowledgeBases',
  'embeddings',
  'stores',
  'memory',
  'agents',
  'pipelines',
  'evals',
  'guardrails',
  'decisions',
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
  knowledgeBases: 'knowledgeBases',
  memory: 'memory',
  agents: 'agents',
  guardrails: 'guardrails',
  decisions: 'decisions',
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

/**
 * Providers the shipped runtime adapters can actually serve. The IR's `Provider`
 * union is wider on purpose: the spec may declare any of them, and the `normalize`
 * gate is what refuses one nothing can serve.
 */
export const SERVED_PROVIDERS = [
  'anthropic',
  'bedrock',
  'gemini',
  'google',
  'openai',
  'openai-compatible',
  'fake',
] as const;

/** Phase 0 defaults for the two IR objects that are not collections. */
export const DEFAULT_OBSERVABILITY: ObservabilityShape = { trace: true, redact: [] };

export const DEFAULT_RUNTIME: RuntimeShape = { controlFlow: 'plain-async' };

export const DEFAULT_MAX_CONTEXT_TOKENS = 128_000;
