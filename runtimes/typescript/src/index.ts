/**
 * AID runtime for TypeScript: the execution half of a generated application.
 *
 * The AID framework generates an application from an IR that declares *what* the app
 * does. This package is what the generated code calls at runtime: pin a model, run a
 * prompt, call a tool, trace it, stay inside a budget, and prove that quality did not
 * regress.
 *
 * Design boundaries worth stating up front, because they are deliberate:
 *
 * - **Control flow is plain async TypeScript.** There is no graph or orchestration
 *   engine here. A generated app is ordinary code that is easy to read and to test.
 * - **zod is used only for structured output.** No other responsibility is delegated
 *   to it.
 * - **Streaming is declared, not implemented.** `Capability` includes it so a spec
 *   can require it and a gate can check it; calling `ModelGateway.stream` raises
 *   {@link FeatureDeferredError}.
 * - **One HTTP provider adapter and one fake.** Breadth of vendor coverage is a
 *   Phase 2 concern; a narrow, correct seam is worth more now than a wide shallow one.
 *
 * This file mirrors the Python package's `__all__`. The exports it adds beyond that
 * list are types a TypeScript consumer cannot avoid naming -- option bags, span
 * handles, tool handler and parameter types -- because there is no structural way to
 * pass them otherwise.
 */

export * from './agents/index.js';
export { ConcurrencyLimiter, holdsSlot } from './concurrency.js';
export type { CompositeStep } from './control.js';
export {
  branch,
  DEPTH_KEY,
  INDEX_KEY,
  ITEM_KEY,
  LIMITER_KEY,
  MAX_STEP_DEPTH,
  mapStep,
  PRINCIPAL_KEY,
  parallel,
  REDUCED_KEY,
  RESERVED_KEYS,
  reduceStep,
} from './control.js';
export {
  Budget,
  CostLedger,
  estimateCostUsd,
  estimatePromptCostUsd,
  LedgerEntry,
  SpendSummary,
} from './cost.js';
export {
  AgentBudgetDegradedError,
  AgentHandoffUnsupportedError,
  AgentTransferCycleError,
  AidRuntimeError,
  BudgetExceededError,
  CapabilityMismatchError,
  ConfigurationError,
  DeepAgentsEngineError,
  DeepAgentsMaxStepsError,
  DeepAgentsUnavailableError,
  DeepAgentsVersionMismatchError,
  EvalError,
  FeatureDeferredError,
  GateConfigurationError,
  GuardrailBlockedError,
  PipelineError,
  PolicyEvaluationError,
  PromptNotFoundError,
  PromptRenderError,
  ProviderError,
  ProviderResponseError,
  StructuredOutputError,
  ToolArgumentError,
  ToolExecutionError,
  ToolNotFoundError,
  ToolPermissionError,
  UnknownModelAliasError,
} from './errors.js';
export type { EvalCaseInit } from './evals/dataset.js';
export { Dataset, EvalCase } from './evals/dataset.js';
export type { BaselineGateOptions } from './evals/gate.js';
export {
  BaselineGate,
  EvalBaseline,
  EvalRun,
  GateResult,
  gateFromConfig,
  MetricBaseline,
  MetricGateResult,
  MetricRun,
  regressionZ,
  Threshold,
  zCritical,
} from './evals/gate.js';
export type { JudgeCall, Metric } from './evals/metrics.js';
export {
  defaultMetrics,
  ExactMatch,
  JsonSchemaValid,
  JudgeVerdict,
  LlmJudge,
  MetricResult,
  metricNames,
  NormalizedContains,
  normalize,
} from './evals/metrics.js';
export type { GatewayRunnerOptions, Runner } from './evals/runner.js';
export {
  CaseOutcome,
  DatasetRun,
  evaluateOnce,
  GatewayRunner,
  gatewayJudge,
  runEvaluation,
} from './evals/runner.js';
export type { AliasEntry, CallHook, ModelGatewayOptions } from './gateway.js';
export { estimateUsage, ModelGateway } from './gateway.js';
export type { NamedStep, Step, StepResult } from './pipeline.js';
export { Pipeline, PipelineContext, STEPS_KEY, StopPipeline } from './pipeline.js';
export type { PolicyNode } from './policy.js';
export {
  evaluatePolicy,
  POLICY_BUILTIN_ARITY,
  POLICY_BUILTINS,
  Principal,
  policySource,
} from './policy.js';
export { Example, PromptRegistry, PromptTemplate, RenderedPrompt } from './prompts.js';
export type { Provider } from './providers/base.js';
export { supports } from './providers/base.js';
export type { FakeProviderOptions, Responder } from './providers/fake.js';
export { FakeProvider, ScriptedTurn } from './providers/fake.js';
export type { FetchLike, OpenAICompatibleOptions } from './providers/http.js';
export { DEFAULT_BASE_URL, OpenAICompatibleProvider } from './providers/http.js';
export type { Chunker, MarkerGroups } from './retrieval/chunking.js';
export {
  CodeChunker,
  chunkDocument,
  chunkerFor,
  FixedChunker,
  RecursiveChunker,
} from './retrieval/chunking.js';
export {
  assembleContext,
  Citation,
  cite,
  RetrievalResult,
  RetrievedItem,
} from './retrieval/citations.js';
export type { Connector } from './retrieval/connectors.js';
export { FileConnector, openConnector, SourceDocument } from './retrieval/connectors.js';
export type { Embedder } from './retrieval/embedding.js';
export {
  EmbeddingBatch,
  embedderFor,
  estimateTokens,
  FakeDeterministicEmbedder,
  OpenAICompatibleEmbedder,
} from './retrieval/embedding.js';
export { RetrievalGate } from './retrieval/gate.js';
export {
  bm25Scores,
  fuse,
  lexicalRanking,
  RankedId,
  rrfScore,
  tokenize,
} from './retrieval/hybrid.js';
export type { RetrievalMetric } from './retrieval/metrics.js';
export {
  CitationGrounding,
  MeanReciprocalRank,
  RecallAtK,
  RetrievalCase,
  retrievalMetrics,
} from './retrieval/metrics.js';
export { PgVectorStore, parseVector, resolveUri, vectorLiteral } from './retrieval/pgvector.js';
export type { Reranker } from './retrieval/rerank.js';
export { LexicalReranker, lexicalScore, rerankerFor } from './retrieval/rerank.js';
export type { RetrieverOptions } from './retrieval/retriever.js';
export { DEFAULT_CANDIDATE_FACTOR, IngestReport, Retriever } from './retrieval/retriever.js';
export type { VectorStore } from './retrieval/stores.js';
export {
  createStore,
  InMemoryVectorStore,
  SearchHit,
  StoreRecord,
  similarity,
} from './retrieval/stores.js';
export type {
  ChunkingStrategy,
  DistanceMetric,
  RefreshMode,
  SourceKind,
  StoreKind,
} from './retrieval/types.js';
export {
  bindingFromSpec,
  Chunk,
  ChunkingSpec,
  chunkIdFor,
  DISTANCE_METRICS,
  EmbeddingCostProfile,
  EmbeddingSpec,
  IndexSpec,
  PinnedEmbedding,
  pinnedEmbedding,
  RefreshSpec,
  RerankSpec,
  RetrievalMetricSpec,
  RetrieverBinding,
  RetrieverSpec,
  ScoredChunk,
  SourceSpec,
  VectorStoreSpec,
} from './retrieval/types.js';
export type { AgentModel, StructuredOutput } from './structured.js';
export {
  buildAgent,
  formatProblems,
  parseStructured,
  repairPrompt,
  runStructured,
  StructuredAgent,
  structuredOutput,
} from './structured.js';
export type { ToolHandler, ToolParameters } from './tools.js';
export { Tool, ToolExecutor, validateArguments } from './tools.js';
export type { LlmSpanHandle, LlmSpanOptions } from './tracing.js';
export {
  ATTRIBUTES,
  aidAttributes,
  GEN_AI_OPERATION_CHAT,
  getTracer,
  llmSpan,
  recordCost,
  recordException,
  recordUsage,
} from './tracing.js';
export type { Capability, FinishReason, Role } from './types.js';
export {
  CompletionRequest,
  CompletionResponse,
  CostProfile,
  GenerationResult,
  Message,
  ModelSpec,
  PinnedModel,
  TokenUsage,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from './types.js';
