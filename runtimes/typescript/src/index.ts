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
 * - **Streaming is a capability, not a promise.** `Capability` includes it so a spec
 *   can require it and a gate can check it. The fake and OpenAI-compatible adapters
 *   implement `Provider.stream`, and `ModelGateway.stream` serves them as SSE frames;
 *   a model or adapter without the capability raises a {@link CapabilityMismatchError}
 *   rather than returning a buffered response. The Anthropic, Bedrock, Gemini, and
 *   Vertex adapters do not stream yet.
 * - **Four HTTP provider adapters and one fake.** OpenAI-compatible endpoints share
 *   one adapter because they share a wire format; Anthropic's Messages API,
 *   Bedrock's Converse API, and Vertex AI's `generateContent` each get their own
 *   because they do not. Breadth beyond those is still deferred: a narrow, correct
 *   seam is worth more than a wide shallow one.
 *
 * This file mirrors the Python package's `__all__`. The exports it adds beyond that
 * list are types a TypeScript consumer cannot avoid naming -- option bags, span
 * handles, tool handler and parameter types -- because there is no structural way to
 * pass them otherwise.
 */

export * from './agents/index.js';
export { ConcurrencyLimiter, holdsSlot } from './concurrency.js';
export type { CompositeStep, DecisionAsker, RouteDecision, RouteOptions } from './control.js';
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
  route,
} from './control.js';
export {
  Budget,
  CostLedger,
  estimateCostUsd,
  estimatePromptCostUsd,
  LedgerEntry,
  SpendSummary,
} from './cost.js';
export type {
  DecideOptions,
  DecisionAnswer,
  DecisionClientOptions,
  DecisionFetchLike,
  DecisionHttpResponse,
  DecisionQuestionOptions,
  DecisionResponse,
} from './decisions.js';
export {
  DEFAULT_TYPESAFE_BASE_URL,
  DecisionClient,
  DecisionQuestion,
  decisionCostUsd,
  decisionKey,
  isReproducibleModel,
  JEV_INPUT_USD_PER_MTOK,
  JEV_MOVING_ALIASES,
  TYPESAFE_API_KEY_ENVS,
  TYPESAFE_BASE_URL_ENV,
} from './decisions.js';
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
  AggregateBaseline,
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
  AssertMetric,
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
export { localTraceEnabled, TRACE_DIR_ENV } from './local-trace.js';
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
export type { AnthropicOptions } from './providers/anthropic.js';
export {
  ANTHROPIC_VERSION,
  AnthropicProvider,
  DEFAULT_ANTHROPIC_BASE_URL,
} from './providers/anthropic.js';
export type { Provider } from './providers/base.js';
export { supports } from './providers/base.js';
export type { BedrockOptions } from './providers/bedrock.js';
export {
  BEDROCK_SERVICE,
  BedrockProvider,
  defaultBedrockBaseUrl,
  rfc3986,
} from './providers/bedrock.js';
export type { FakeProviderOptions, Responder } from './providers/fake.js';
export { FakeProvider, ScriptedTurn } from './providers/fake.js';
export type { GeminiOptions } from './providers/gemini.js';
export { DEFAULT_GEMINI_BASE_URL, GEMINI_API_KEY_ENV, GeminiProvider } from './providers/gemini.js';
export type { FetchLike, OpenAICompatibleOptions } from './providers/http.js';
export { DEFAULT_BASE_URL, OpenAICompatibleProvider } from './providers/http.js';
export type { VertexOptions } from './providers/vertex.js';
export {
  DEFAULT_VERTEX_LOCATION,
  defaultVertexBaseUrl,
  METADATA_TOKEN_URL,
  VERTEX_TOKEN_ENV,
  VertexProvider,
} from './providers/vertex.js';
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
export type { Connector, RemoteFetch, RemoteResponse } from './retrieval/connectors.js';
export {
  FileConnector,
  HttpConnector,
  openConnector,
  S3Connector,
  SourceDocument,
} from './retrieval/connectors.js';
export type { Embedder } from './retrieval/embedding.js';
export {
  BedrockEmbedder,
  EmbeddingBatch,
  embedderFor,
  estimateTokens,
  FakeDeterministicEmbedder,
  GeminiEmbedder,
  OpenAICompatibleEmbedder,
  VertexEmbedder,
} from './retrieval/embedding.js';
export {
  compileFilters,
  FILTER_OPERATORS,
  Filter,
  matches,
  matchesAll,
  metadataFields,
  parseFilter,
} from './retrieval/filters.js';
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
export type { RetrieverSeam } from './steps.js';
export {
  EMITTED_KEY,
  emitStep,
  generateStep,
  resolveSource,
  retrieveStep,
  toolStep,
} from './steps.js';
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
  StreamChunk,
  TokenUsage,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from './types.js';
