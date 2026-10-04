/**
 * IR v0.1 shapes (`docs/design.md` §7.2).
 *
 * Every top-level collection in §7.2 is present in the IR, always. The sections
 * Phase 0 populates are `types`, `models`, `prompts`, `tools`, `pipelines`, and
 * `evals`. The rest are **present and empty (`[]`)** by design, never omitted and
 * never `undefined`: that stability is what lets a later phase fill them without a
 * breaking reshape. They are empty for two different reasons, and the difference
 * matters. `agents`, `retrievers`, `guardrails`, `memory`, and `deployments` are
 * spec sections the DSL defines but Phase 0 defers (`DEFERRED_SECTIONS`), so a
 * spec cannot populate them yet. `embeddings` and `stores` have no spec section at
 * all: they are IR-only scaffolding, declared here so §7.2's shape is complete.
 * `observability` and `runtime` are objects carrying Phase 0 defaults, not arrays.
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

/** Free-form, generator-specific annotation. Phase 0 declares none. */
export interface Trait {
  name: string;
  value?: unknown;
}

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
  cache?: { prompt?: boolean; semantic?: boolean };
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

export type StepShape = GenerateStep | ToolStep | EmitStep;

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
  | { kind: 'llm-judge'; rubric: string; field?: string; model?: string; threshold?: number };

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
 * Deferred collections, shaped per design §7.2 and empty in Phase 0. They exist
 * now so a later phase can fill them without a breaking reshape; an empty array
 * is otherwise indistinguishable from "not implemented".
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
  index: { metric: 'cosine' | 'dot' | 'l2'; hybrid: boolean; params?: Record<string, unknown> };
  topK: number;
  rerank?: { model: string; topN: number };
  filters?: string[];
  refresh: { mode: 'full' | 'incremental'; schedule?: string };
  traits: Trait[];
}

/** IR-only scaffolding: the design defines no spec section or shape for embeddings. */
export interface EmbeddingShape {
  id: string;
  provider: Provider;
  modelId: string;
  dimensions?: number;
  costProfile?: CostProfile;
  traits: Trait[];
}

/** IR-only scaffolding: the design defines no spec section or shape for vector stores. */
export interface VectorStoreShape {
  id: string;
  kind: 'memory' | 'pgvector' | 'qdrant' | 'pinecone' | 'weaviate' | 'custom';
  uri?: string;
  dimensions?: number;
  traits: Trait[];
}

export interface MemoryShape {
  id: string;
  kind: 'buffer' | 'window' | 'summary' | 'semantic' | 'episodic' | 'vector';
  scope: 'session' | 'user' | 'tenant' | 'global';
  tokenBudget: number;
  summarizeModel?: string;
  store?: string;
  ttl?: string;
  redact: string[];
  traits: Trait[];
}

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
  /** Other agent ids. */
  handoffs: string[];
  humanInTheLoop?: { when: PolicyExpr; channel: string };
  traits: Trait[];
}

export interface GuardrailShape {
  id: string;
  stages: ('input' | 'output' | 'retrieval' | 'tool-call')[];
  policies: string[];
  action: 'block' | 'redact' | 'flag' | 'escalate';
  onFail: { message: string; fallbackPrompt?: string; log: boolean };
  traits: Trait[];
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

/** Spec section -> IR collection, for the sections Phase 0 populates. */
export const POPULATED_COLLECTION_BY_SECTION = {
  types: 'types',
  models: 'models',
  prompts: 'prompts',
  tools: 'tools',
  evals: 'evals',
  pipelines: 'pipelines',
} as const;

/** IR collections with no Phase 0 spec section: present and empty by design. */
export const IR_ONLY_COLLECTIONS = ['embeddings', 'stores'] as const;

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
