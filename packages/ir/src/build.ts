/**
 * The builder: a validated spec document value -> IR v0.1.
 *
 * The builder never throws for a user-recoverable condition. It applies Phase 0
 * defaults (so generated code never supplies a default of its own), sorts every
 * object-derived collection by stable id (so YAML key order cannot change the IR),
 * and reports `ir/*` diagnostics through the same shape every other gate uses.
 */

import { errorDiagnostic, formatPath, SPEC_VERSION } from '@aid-framework/spec';
import {
  deriveRequiredCapabilities,
  isModelCapability,
  SPEC_MODEL_CAPABILITY_MAP,
} from './capabilities.js';
import { catalogCostProfile, catalogModel } from './catalog/index.js';
import { IR_DIAGNOSTIC_CODES, type IrDiagnostic } from './diagnostics.js';
import { parsePolicyExpr } from './policy/index.js';
import { parsePredicateExpr } from './predicate/index.js';
import {
  AGENT_ENGINES,
  AGENT_ON_BUDGET_EXHAUSTED,
  AGENT_RUNTIME_PLATFORMS,
  AGENT_STATE_KINDS,
  type AgentEngine,
  type AgentOnBudgetExhausted,
  type AgentRuntimePlatform,
  type AgentShape,
  type AgentStateKind,
  type AgentStateShape,
  ALERT_AGGREGATES,
  ALERT_METRICS,
  ALERT_WINDOWS,
  type AlertShape,
  AUDIT_SINKS,
  type AuditSink,
  BEDROCK_CONTENT_FILTERS,
  BEDROCK_CONTENT_STRENGTHS,
  BEDROCK_PII_ENTITIES,
  type BedrockContentFilter,
  type BedrockContentStrength,
  type BedrockGuardrailPolicy,
  type BedrockPiiEntity,
  type BranchStep,
  DECISION_ON_ERROR,
  DECISION_QUESTION_TYPES,
  DEFAULT_MAX_CONTEXT_TOKENS,
  DEFAULT_OBSERVABILITY,
  DEFAULT_PROFILE,
  DEFAULT_RUNTIME,
  DEPLOY_TARGETS,
  DEPLOYMENT_EGRESS,
  DEPLOYMENT_IDENTITY_KINDS,
  type DecisionOnError,
  type DecisionQuestionType,
  type DecisionShape,
  type DeploymentApprovalsShape,
  type DeploymentAuditShape,
  type DeploymentEgress,
  type DeploymentIdentityKind,
  type DeploymentIdentityShape,
  type DeploymentImageShape,
  type DeploymentNetworkShape,
  type DeploymentRuntimeShape,
  type DeploymentShape,
  decisionIdentity,
  type EmbeddingShape,
  type ErrorPolicy,
  type EvalShape,
  type EvalTarget,
  type FeedbackShape,
  type FeedbackSignalShape,
  type GatewayAuthorizerShape,
  type GatewayShape,
  type GatewayTargetShape,
  type GenerateStep,
  GUARDRAIL_DECISION_ACTIONS,
  type GuardrailDecisionAction,
  type GuardrailShape,
  type GuardStep,
  type Idempotency,
  IMAGE_REGISTRIES,
  IMAGE_REGISTRY_FIELDS,
  type IR,
  IR_VERSION,
  imageRegistry,
  isAlertAggregate,
  isAlertMetric,
  isAlertWindow,
  isFeedbackSignalKind,
  isGuardrailPolicyKind,
  isIndexMetric,
  isKnowledgeBaseEngine,
  isProvider,
  isVectorStoreKind,
  type KnowledgeBaseShape,
  type LocalRetrieverShape,
  type ManagedRetrieverShape,
  type MapStep,
  type MemoryShape,
  type MetricShape,
  MODEL_ARMOR_CONFIDENCES,
  MODEL_ARMOR_RAI_FILTERS,
  type ModelArmorConfidence,
  type ModelArmorGuardrailPolicy,
  type ModelArmorRaiFilter,
  type ModelLimits,
  type ModelParams,
  type ModelShape,
  modelIdentity,
  type ObservabilityShape,
  type PipelineShape,
  type PipelineTrigger,
  PRIMITIVE_TYPES,
  PROFILES,
  type PrimitiveType,
  type Profile,
  type ProjectShape,
  type PromotionShape,
  type PromptOutput,
  type PromptShape,
  type PromptVariable,
  type Provider,
  pipelineIdentity,
  promptIdentity,
  RETRIEVAL_TRAITS,
  type RegistryImageFields,
  type RetrieverShape,
  type RetrieveStep,
  type RouteStep,
  type SemanticCacheShape,
  type SideEffects,
  SPEC_CLOUDS,
  type SpecCloud,
  type StepInput,
  type StepInputValue,
  type StepShape,
  type ToolHandler,
  type ToolShape,
  type ToolStep,
  type Trait,
  type TypeField,
  type TypeRef,
  type TypeShape,
  toolIdentity,
  type VectorStoreShape,
} from './shapes.js';

export const DEFAULT_TARGET = 'py-fastapi';
export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
export const DEFAULT_TOOL_RETRIES = 0;
export const DEFAULT_IDEMPOTENCY: Idempotency = 'none';
export const DEFAULT_EVAL_MAX_REGRESSION = 0;
export const DEFAULT_EVAL_SAMPLES = 5;
/**
 * Retrieval defaults. The spec schema requires every one of these fields, so they
 * are only reached by a value that skipped validation; they mirror the §6 example
 * rather than inventing a policy a valid spec could disagree with.
 */
export const DEFAULT_SOURCE_KIND = 'file';
export const DEFAULT_CHUNK_STRATEGY = 'recursive';
export const DEFAULT_CHUNK_SIZE = 800;
export const DEFAULT_CHUNK_OVERLAP = 0;
export const DEFAULT_INDEX_METRIC = 'cosine';
export const DEFAULT_RETRIEVER_TOP_K = 5;
export const DEFAULT_REFRESH_MODE = 'full';
/** Same posture as the retrieval defaults: reached only by a value that skipped validation. */
export const DEFAULT_MEMORY_TOKEN_BUDGET = 4096;

const BINDING_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const TYPE_NAME_PATTERN = /^([A-Za-z][A-Za-z0-9]*)(\[\])?$/;
const EVAL_TARGET_PATTERN = /^([a-z][a-z0-9-]*):([a-z][a-z0-9_]{0,63})$/;
const SOLE_PLACEHOLDER_PATTERN = /^\s*\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}\s*$/;

export interface BuildOptions {
  file?: string;
}

export interface BuildResult {
  ir: IR;
  diagnostics: IrDiagnostic[];
}

/** Resolves `TypeRef`s eagerly, so a generator never has to re-read the spec. */
export interface BuildContext {
  file?: string;
  diagnostics: IrDiagnostic[];
  /** Declared type names, used to resolve every `TypeRef` eagerly. */
  typeNames: Set<string>;
}

export function buildIR(value: unknown, options: BuildOptions = {}): BuildResult {
  const root = asRecord(value) ?? {};
  const context: BuildContext = {
    file: options.file,
    diagnostics: [],
    typeNames: new Set(Object.keys(asRecord(root.types) ?? {})),
  };

  const project = buildProject(root.project);
  const types = buildTypes(root.types, context);
  const models = buildModels(root.models);
  const prompts = buildPrompts(root.prompts, context);
  const tools = buildTools(root.tools, context);
  const stores = buildStores(root.stores);
  const retrievers = buildRetrievers(root.retrievers);
  const knowledgeBases = buildKnowledgeBases(root.knowledgeBases);
  const gateways = buildGateways(root.gateways);
  const memory = buildMemory(root.memory);
  const guardrails = buildGuardrails(root.guardrails);
  const decisions = buildDecisions(root.decisions);
  const state = buildState(root.state, ['state'], context);
  const agents = buildAgents(root.agents, context, state);
  const deployments = buildDeployments(root.deployments, context);
  const embeddings = buildEmbeddings(models);
  const sensitive = sensitiveNames({ types, prompts });
  const observability = buildObservability(root.observability, sensitive);
  const promptModels = new Map(prompts.map((prompt) => [prompt.id, prompt.model]));
  const pipelines = buildPipelines(root.pipelines, observability, sensitive, promptModels, context);
  const evals = buildEvals(root.evals, context);

  const ir: IR = {
    irVersion: IR_VERSION,
    specVersion: asString(root.specVersion) ?? SPEC_VERSION,
    profile: buildProfile(root.profile, context),
    project,
    types,
    models,
    prompts,
    tools,
    retrievers,
    knowledgeBases,
    gateways,
    embeddings,
    stores,
    memory,
    agents,
    // `state` is the one conditional top level key: a document that declares no durable
    // store has nowhere to put a paused run, so there is no store to describe. It is
    // spread rather than assigned after the literal so its position stays between
    // `agents` and `pipelines` while an undeclared store leaves no key at all.
    ...(state === undefined ? {} : { state }),
    pipelines,
    evals,
    guardrails,
    decisions,
    deployments,
    observability,
    runtime: { ...DEFAULT_RUNTIME },
    requiredCapabilities: [],
  };
  ir.requiredCapabilities = deriveRequiredCapabilities(ir);

  return { ir, diagnostics: context.diagnostics };
}
function buildProject(raw: unknown): ProjectShape {
  const record = asRecord(raw) ?? {};
  const name = asString(record.name) ?? '';
  const namespace = asString(record.namespace) ?? name;
  const targets = asStringArray(record.targets);
  return {
    name,
    namespace,
    description: asString(record.description),
    targets: targets.length === 0 ? [DEFAULT_TARGET] : targets,
  };
}

function buildTypes(raw: unknown, context: BuildContext): TypeShape[] {
  const record = asRecord(raw) ?? {};
  return sortedKeys(record).map((id) => {
    const entry = asRecord(record[id]) ?? {};
    const fields = asRecord(entry.fields) ?? {};
    return {
      id,
      kind: 'struct' as const,
      description: asString(entry.description),
      fields: sortedKeys(fields).map((fieldName) =>
        buildTypeField(fieldName, asRecord(fields[fieldName]), context),
      ),
    };
  });
}

function buildTypeField(name: string, raw: unknown, context: BuildContext): TypeField {
  const record = asRecord(raw) ?? {};
  const field: TypeField = {
    name,
    type: buildTypeRef(record.type, context),
    required: asBoolean(record.required) ?? false,
    description: asString(record.description),
    minimum: asNumber(record.minimum),
    maximum: asNumber(record.maximum),
  };
  const values = Array.isArray(record.enum)
    ? record.enum.filter(
        (item): item is string | number | boolean =>
          typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean',
      )
    : undefined;
  if (values !== undefined) field.enum = values;
  if (record.sensitive === true || isSensitiveName(name)) field.sensitive = true;
  return field;
}

/**
 * Resolves a `fieldType` string against the spec's declared type names. An
 * unresolvable name is kept as `resolved: false`; the referential gate reports it
 * with the document path, so this stays a pure projection.
 */
export function buildTypeRef(raw: unknown, context: BuildContext): TypeRef {
  const text = asString(raw) ?? '';
  const match = TYPE_NAME_PATTERN.exec(text);
  if (match === null) {
    return { kind: 'named', name: text, list: false, resolved: false };
  }
  const name = match[1] as string;
  const list = match[2] === '[]';
  if ((PRIMITIVE_TYPES as readonly string[]).includes(name)) {
    return { kind: 'primitive', name: name as PrimitiveType, list };
  }
  return { kind: 'named', name, list, resolved: context.typeNames.has(name) };
}

function buildModels(raw: unknown): ModelShape[] {
  const record = asRecord(raw) ?? {};
  return sortedKeys(record).map((id) => {
    const entry = asRecord(record[id]) ?? {};
    const modelId = asString(entry.modelId) ?? id;
    const explicitCostProfile = asString(entry.costProfile);
    const resolved = catalogCostProfile(modelId, explicitCostProfile);
    const catalog = catalogModel(modelId);

    const model: ModelShape = {
      id,
      identity: modelIdentity(id),
      provider: asProvider(entry.provider),
      modelId,
      capabilities: asStringArray(entry.capabilities)
        // The spec's `capabilities` enum is closed to four spellings that all map onto the
        // model vocabulary, so no spec-derived caller reaches this filter: `checkSpecText`
        // rejects anything else first, and `lowerSpec` returns before calling `buildIR`.
        // It stays because `buildIR` takes `unknown` and promises `ModelCapability[]`, so a
        // caller that skips validation gets a silent drop rather than a mistyped IR.
        .map(mapSpecCapability)
        .filter(isModelCapability),
      params: buildParams(entry.params),
      limits: buildLimits(entry.limits, catalog?.limits),
      fallbacks: asStringArray(entry.fallbacks),
      traits: [],
    };
    if (resolved !== undefined) {
      model.costProfile = resolved.profile;
      model.costProfileId = resolved.id;
    } else if (explicitCostProfile !== undefined) {
      model.costProfileId = explicitCostProfile;
    }
    const cache = buildCache(entry.cache);
    if (cache !== undefined) model.cache = cache;
    const baseUrl = asString(entry.baseUrl);
    const apiKeyEnv = asString(entry.apiKeyEnv);
    const description = asString(entry.description);
    if (baseUrl !== undefined) model.baseUrl = baseUrl;
    if (apiKeyEnv !== undefined) model.apiKeyEnv = apiKeyEnv;
    if (description !== undefined) model.description = description;
    return model;
  });
}

function buildCache(raw: unknown): ModelShape['cache'] | undefined {
  const record = asRecord(raw);
  if (record === undefined) return undefined;
  const prompt = asBoolean(record.prompt);
  const semantic = buildSemanticCache(record.semantic);
  return prompt === undefined && semantic === undefined ? undefined : { prompt, semantic };
}

function buildSemanticCache(raw: unknown): SemanticCacheShape | undefined {
  const record = asRecord(raw);
  if (record === undefined) return undefined;
  const threshold = asNumber(record.threshold);
  const ttlSeconds = asNumber(record.ttlSeconds);
  if (threshold === undefined || ttlSeconds === undefined) return undefined;
  return { threshold, ttlSeconds };
}

function mapSpecCapability(value: string): string {
  const mapped: Record<string, string> = SPEC_MODEL_CAPABILITY_MAP;
  return mapped[value] ?? value;
}

function asProvider(raw: unknown): Provider {
  const value = asString(raw);
  return value !== undefined && isProvider(value) ? value : 'fake';
}

function buildParams(raw: unknown): ModelParams {
  const record = asRecord(raw) ?? {};
  const params: ModelParams = {};
  const temperature = asNumber(record.temperature);
  const topP = asNumber(record.topP);
  const maxTokens = asNumber(record.maxTokens);
  const seed = asNumber(record.seed);
  if (temperature !== undefined) params.temperature = temperature;
  if (topP !== undefined) params.topP = topP;
  if (maxTokens !== undefined) params.maxTokens = maxTokens;
  if (seed !== undefined) params.seed = seed;
  const stop = asStringArray(record.stop);
  if (stop.length > 0) params.stop = stop;
  return params;
}

function buildLimits(raw: unknown, catalogLimits?: ModelLimits): ModelLimits {
  const record = asRecord(raw) ?? {};
  const limits: ModelLimits = {
    contextTokens:
      asNumber(record.maxInputTokens) ?? catalogLimits?.contextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS,
  };
  const maxOutputTokens = asNumber(record.maxOutputTokens) ?? catalogLimits?.maxOutputTokens;
  const rpm = asNumber(record.rpm) ?? catalogLimits?.rpm;
  const tpm = asNumber(record.tpm) ?? catalogLimits?.tpm;
  if (maxOutputTokens !== undefined) limits.maxOutputTokens = maxOutputTokens;
  if (rpm !== undefined) limits.rpm = rpm;
  if (tpm !== undefined) limits.tpm = tpm;
  return limits;
}

function buildPrompts(raw: unknown, context: BuildContext): PromptShape[] {
  const record = asRecord(raw) ?? {};
  return sortedKeys(record).map((id) => {
    const entry = asRecord(record[id]) ?? {};
    const outputRecord = asRecord(entry.output) ?? {};
    const kind = asString(outputRecord.kind) ?? 'text';
    const version = asNumber(entry.version) ?? 1;
    return {
      id,
      version,
      identity: promptIdentity(id, version),
      model: asString(entry.model) ?? '',
      template: asString(entry.template) ?? '',
      variables: buildPromptVariables(entry.variables, context),
      output: buildPromptOutput(kind, outputRecord.schema, context),
      params: {},
      examples: [],
      guardrails: [],
      evals: [],
      traits: [],
    };
  });
}

/** `schema` is declared only for `structured`, so no other kind carries a TypeRef. */
function buildPromptOutput(kind: string, schema: unknown, context: BuildContext): PromptOutput {
  if (kind === 'structured') return { kind: 'structured', schema: buildTypeRef(schema, context) };
  if (kind === 'json') return { kind: 'json' };
  return { kind: 'text' };
}

function buildPromptVariables(raw: unknown, context: BuildContext): PromptVariable[] {
  const record = asRecord(raw) ?? {};
  return sortedKeys(record).map((name) => {
    const entry = asRecord(record[name]) ?? {};
    const variable: PromptVariable = {
      name,
      type: buildTypeRef(entry.type ?? 'string', context),
      required: asBoolean(entry.required) ?? false,
    };
    const description = asString(entry.description);
    if (description !== undefined) variable.description = description;
    if (entry.sensitive === true || isSensitiveName(name)) variable.sensitive = true;
    if ('default' in entry && isJsonValue(entry.default)) variable.default = entry.default;
    return variable;
  });
}

/** Guards against `undefined`/functions leaking into the IR via a hand-written document. */
function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== 'object') return false;
  return Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function buildTools(raw: unknown, context: BuildContext): ToolShape[] {
  const record = asRecord(raw) ?? {};
  return sortedKeys(record).map((id) => {
    const entry = asRecord(record[id]) ?? {};
    const handlerRecord = asRecord(entry.handler) ?? {};
    const authSource = asString(entry.auth);
    const sideEffects = asSideEffects(entry.sideEffects);
    const tool: ToolShape = {
      id,
      identity: toolIdentity(id),
      name: id,
      description: asString(entry.description) ?? '',
      input: buildTypeRef(entry.input, context),
      output: buildTypeRef(entry.output, context),
      sideEffects,
      // A destructive tool requires confirmation unless the spec says otherwise.
      requiresConfirmation: asBoolean(entry.requiresConfirmation) ?? sideEffects === 'destructive',
      timeoutMs: asNumber(entry.timeoutMs) ?? DEFAULT_TOOL_TIMEOUT_MS,
      retries: asNumber(entry.retries) ?? DEFAULT_TOOL_RETRIES,
      idempotency: asIdempotency(entry.idempotency),
      handler: buildToolHandler(handlerRecord),
      traits: [],
    };
    if (authSource !== undefined) {
      const parsed = parsePolicyExpr(authSource, {
        path: ['tools', id, 'auth'],
        file: context.file,
      });
      context.diagnostics.push(...parsed.diagnostics);
      if (parsed.ast !== undefined) tool.auth = parsed.ast;
    }
    return tool;
  });
}

function buildToolHandler(record: Record<string, unknown>): ToolHandler {
  const kind = asString(record.kind);
  if (kind === 'generated' || kind === 'mcp') {
    const handler: ToolHandler = { kind };
    const symbol = asString(record.symbol);
    if (symbol !== undefined) handler.symbol = symbol;
    const mcp = asRecord(record.mcp);
    if (mcp !== undefined) {
      handler.mcp = { server: asString(mcp.server) ?? '', tool: asString(mcp.tool) ?? '' };
    }
    return handler;
  }
  const handler: ToolHandler = { kind: 'business' };
  const symbol = asString(record.symbol);
  if (symbol !== undefined) handler.symbol = symbol;
  return handler;
}

function asSideEffects(raw: unknown): SideEffects {
  const value = asString(raw);
  return value === 'read' || value === 'write' || value === 'destructive' || value === 'none'
    ? value
    : 'none';
}

function buildStores(raw: unknown): VectorStoreShape[] {
  const record = asRecord(raw) ?? {};
  return sortedKeys(record).map((id) => {
    const entry = asRecord(record[id]) ?? {};
    const store: VectorStoreShape = {
      id,
      kind: asStoreKind(entry.kind),
      traits: [],
    };
    const uri = asString(entry.uri);
    const dimensions = asNumber(entry.dimensions);
    if (uri !== undefined) store.uri = uri;
    if (dimensions !== undefined) store.dimensions = dimensions;
    return store;
  });
}

function asStoreKind(raw: unknown): VectorStoreShape['kind'] {
  const value = asString(raw);
  return value !== undefined && isVectorStoreKind(value) ? value : 'memory';
}

function buildKnowledgeBases(raw: unknown): KnowledgeBaseShape[] {
  const record = asRecord(raw) ?? {};
  return sortedKeys(record).map((id) => {
    const entry = asRecord(record[id]) ?? {};
    const dataSource = asRecord(entry.dataSource) ?? {};
    const chunking = asRecord(entry.chunking) ?? {};
    const vectorStore = asRecord(entry.vectorStore) ?? {};
    const engine = asKnowledgeBaseEngine(entry.engine);
    const base: KnowledgeBaseShape = {
      id,
      engine,
      dataSource: {
        kind: asDataSourceKind(dataSource.kind, engine),
        uri: asString(dataSource.uri) ?? '',
      },
      chunking: {
        strategy: asManagedChunkStrategy(chunking.strategy),
        size: asNumber(chunking.size) ?? DEFAULT_CHUNK_SIZE,
        overlap: asNumber(chunking.overlap) ?? DEFAULT_CHUNK_OVERLAP,
      },
      embedModel: asString(entry.embedModel) ?? '',
      filterable: asStringArray(entry.filterable),
      vectorStore: { kind: vectorStore.kind === 'existing' ? 'existing' : 'provisioned' },
    };
    const arn = asString(vectorStore.arn);
    if (arn !== undefined) base.vectorStore.arn = arn;
    return base;
  });
}

function asKnowledgeBaseEngine(raw: unknown): KnowledgeBaseShape['engine'] {
  const value = asString(raw);
  return value !== undefined && isKnowledgeBaseEngine(value) ? value : 'aws-bedrock';
}

/** The engine→bucket binding the schema refuses; the IR defaults to the engine's own. */
function asDataSourceKind(
  raw: unknown,
  engine: KnowledgeBaseShape['engine'],
): KnowledgeBaseShape['dataSource']['kind'] {
  const value = asString(raw);
  if (value === 's3' || value === 'gcs') return value;
  return engine === 'vertex-rag' ? 'gcs' : 's3';
}

function asManagedChunkStrategy(raw: unknown): KnowledgeBaseShape['chunking']['strategy'] {
  const value = asString(raw);
  return value === 'recursive' || value === 'code' ? value : 'fixed';
}

function buildGateways(raw: unknown): GatewayShape[] {
  const record = asRecord(raw) ?? {};
  return sortedKeys(record).map((id) => {
    const entry = asRecord(record[id]) ?? {};
    const declared = Array.isArray(entry.targets) ? entry.targets : [];
    const gateway: GatewayShape = {
      id,
      authorizer: asGatewayAuthorizer(asRecord(entry.authorizer) ?? {}),
      // A target with no `name` is already a schema error; dropping it here keeps the IR
      // from carrying an unnamed resource the emitters would have to manufacture a name for.
      targets: declared.flatMap((target) => {
        const built = buildGatewayTarget(asRecord(target) ?? {});
        return built === undefined ? [] : [built];
      }),
    };
    const description = asString(entry.description);
    if (description !== undefined) gateway.description = description;
    return gateway;
  });
}

function asGatewayAuthorizer(raw: Record<string, unknown>): GatewayAuthorizerShape {
  if (raw.kind !== 'jwt') return { kind: 'awsIam' };
  return {
    kind: 'jwt',
    discoveryUrl: asString(raw.discoveryUrl) ?? '',
    audience: asStringArray(raw.audience),
  };
}

function buildGatewayTarget(entry: Record<string, unknown>): GatewayTargetShape | undefined {
  const id = asString(entry.name);
  if (id === undefined) return undefined;
  const description = asString(entry.description);
  const described = (shape: GatewayTargetShape): GatewayTargetShape =>
    description === undefined ? shape : { ...shape, description };

  if (entry.kind === 'mcpServer') {
    const mcpServer = asRecord(entry.mcpServer) ?? {};
    return described({
      id,
      source: { kind: 'mcpServer', endpoint: asString(mcpServer.endpoint) ?? '' },
    });
  }

  const openApiSchema = asRecord(entry.openApiSchema) ?? {};
  const inline = asString(openApiSchema.inline);
  // The schema already makes `uri` and `inline` exclusive, so the first one present wins
  // and the module never has to choose between two sources at apply time.
  if (inline !== undefined) {
    return described({ id, source: { kind: 'openApiSchema', schema: { inline } } });
  }
  const uri = asString(openApiSchema.uri) ?? '';
  const bucketOwnerAccountId = asString(openApiSchema.bucketOwnerAccountId);
  return described({
    id,
    source: {
      kind: 'openApiSchema',
      schema: bucketOwnerAccountId === undefined ? { uri } : { uri, bucketOwnerAccountId },
    },
  });
}

function buildRetrievers(raw: unknown): RetrieverShape[] {
  const record = asRecord(raw) ?? {};
  return sortedKeys(record).map((id) => {
    const entry = asRecord(record[id]) ?? {};
    const knowledgeBase = asString(entry.knowledgeBase);
    if (knowledgeBase !== undefined) return buildManagedRetriever(id, entry, knowledgeBase);

    const source = asRecord(entry.source) ?? {};
    const chunking = asRecord(entry.chunking) ?? {};
    const index = asRecord(entry.index) ?? {};
    const refresh = asRecord(entry.refresh) ?? {};

    const retriever: LocalRetrieverShape = {
      kind: 'local',
      id,
      source: buildRetrieverSource(source),
      chunking: {
        strategy: asChunkStrategy(chunking.strategy),
        size: asNumber(chunking.size) ?? DEFAULT_CHUNK_SIZE,
        overlap: asNumber(chunking.overlap) ?? DEFAULT_CHUNK_OVERLAP,
        keepMetadata: asStringArray(chunking.keepMetadata),
      },
      embedModel: asString(entry.embedModel) ?? '',
      store: asString(entry.store) ?? '',
      index: {
        metric: asIndexMetric(index.metric),
        hybrid: asBoolean(index.hybrid) ?? false,
      },
      topK: asNumber(entry.topK) ?? DEFAULT_RETRIEVER_TOP_K,
      refresh: buildRefresh(refresh),
      traits: buildRetrievalTraits(entry.traits),
    };

    const rerank = asRecord(entry.rerank);
    if (rerank !== undefined) {
      retriever.rerank = {
        model: asString(rerank.model) ?? '',
        topN: asNumber(rerank.topN) ?? retriever.topK,
      };
    }
    const filters = asStringArray(entry.filters);
    if (filters.length > 0) retriever.filters = filters;
    const params = asRecord(index.params);
    if (params !== undefined) retriever.index.params = params;
    return retriever;
  });
}

/**
 * A managed retriever keeps the query shape and nothing else. The spec layer already
 * refuses a local pipeline key beside `knowledgeBase`, so the only fields read here are
 * the ones that still run in this process.
 */
function buildManagedRetriever(
  id: string,
  entry: Record<string, unknown>,
  knowledgeBase: string,
): ManagedRetrieverShape {
  const retriever: ManagedRetrieverShape = {
    kind: 'managed',
    id,
    knowledgeBase,
    topK: asNumber(entry.topK) ?? DEFAULT_RETRIEVER_TOP_K,
    traits: buildRetrievalTraits(entry.traits),
  };
  const rerank = asRecord(entry.rerank);
  if (rerank !== undefined) {
    retriever.rerank = {
      model: asString(rerank.model) ?? '',
      topN: asNumber(rerank.topN) ?? retriever.topK,
    };
  }
  const filters = asStringArray(entry.filters);
  if (filters.length > 0) retriever.filters = filters;
  return retriever;
}

function buildRetrieverSource(raw: Record<string, unknown>): LocalRetrieverShape['source'] {
  const value = asString(raw.kind);
  const kind: LocalRetrieverShape['source']['kind'] =
    value === 's3' || value === 'http' || value === 'db' || value === 'mcp' ? value : 'file';
  const source: LocalRetrieverShape['source'] = { kind, uri: asString(raw.uri) ?? '' };
  const glob = asString(raw.glob);
  if (glob !== undefined) source.glob = glob;
  return source;
}

function buildRefresh(raw: Record<string, unknown>): LocalRetrieverShape['refresh'] {
  const mode = asString(raw.mode);
  const refresh: LocalRetrieverShape['refresh'] = {
    mode: mode === 'incremental' ? 'incremental' : DEFAULT_REFRESH_MODE,
  };
  const schedule = asString(raw.schedule);
  if (schedule !== undefined) refresh.schedule = schedule;
  return refresh;
}

function asChunkStrategy(raw: unknown): LocalRetrieverShape['chunking']['strategy'] {
  const value = asString(raw);
  return value === 'fixed' || value === 'semantic' || value === 'code'
    ? value
    : DEFAULT_CHUNK_STRATEGY;
}

function asIndexMetric(raw: unknown): LocalRetrieverShape['index']['metric'] {
  const value = asString(raw);
  return value !== undefined && isIndexMetric(value) ? value : DEFAULT_INDEX_METRIC;
}

function buildRetrievalTraits(raw: unknown): Trait[] {
  return asStringArray(raw)
    .filter((name): name is (typeof RETRIEVAL_TRAITS)[number] =>
      (RETRIEVAL_TRAITS as readonly string[]).includes(name),
    )
    .map((name) => ({ name }));
}

/**
 * One entry per model declaring `embeddings`, keyed by the model alias so
 * `retriever.embedModel` and `store.dimensions` can be checked against it.
 */
function buildEmbeddings(models: ModelShape[]): EmbeddingShape[] {
  return models
    .filter((model) => model.capabilities.includes('embeddings'))
    .map((model) => {
      const embedding: EmbeddingShape = {
        id: model.id,
        provider: model.provider,
        modelId: model.modelId,
        traits: [],
      };
      const dimensions = catalogModel(model.modelId)?.dimensions;
      if (dimensions !== undefined) embedding.dimensions = dimensions;
      if (model.costProfile !== undefined) embedding.costProfile = model.costProfile;
      return embedding;
    });
}

function asIdempotency(raw: unknown): Idempotency {
  const value = asString(raw);
  return value === 'key' || value === 'natural' || value === 'none' ? value : DEFAULT_IDEMPOTENCY;
}

function buildPipelines(
  raw: unknown,
  observability: ObservabilityShape,
  sensitive: readonly string[],
  promptModels: Map<string, string>,
  context: BuildContext,
): PipelineShape[] {
  const record = asRecord(raw) ?? {};
  return sortedKeys(record).map((id) => {
    const entry = asRecord(record[id]) ?? {};
    const declaredTrigger = asRecord(entry.trigger) ?? {};
    const httpTrigger = asRecord(declaredTrigger.http);
    const trigger: PipelineTrigger =
      httpTrigger === undefined && declaredTrigger.manual === true
        ? { kind: 'manual' }
        : buildHttpTrigger(httpTrigger ?? {});
    const pipeline: PipelineShape = {
      id,
      identity: pipelineIdentity(id),
      trigger,
      steps: buildStepList(entry.steps, promptModels, context, ['pipelines', id, 'steps']),
      errorPolicy: buildErrorPolicy(entry.errorPolicy),
      observability: buildObservability(entry.observability, sensitive, observability),
    };
    const description = asString(entry.description);
    if (description !== undefined) pipeline.description = description;
    return pipeline;
  });
}

/** The HTTP trigger's defaults; also what a pipeline with no `trigger` at all gets. */
function buildHttpTrigger(trigger: Record<string, unknown>): PipelineTrigger {
  return {
    kind: 'http',
    method: asString(trigger.method) ?? 'post',
    path: asString(trigger.path) ?? '/',
  };
}

function buildErrorPolicy(raw: unknown): ErrorPolicy {
  const record = asRecord(raw) ?? {};
  return {
    retries: asNumber(record.retries) ?? 0,
    fallback: asString(record.fallback),
    deadLetter: asString(record.deadLetter),
  };
}

function buildStepList(
  raw: unknown,
  promptModels: Map<string, string>,
  context: BuildContext,
  path: readonly (string | number)[],
): StepShape[] {
  return asArray(raw).map((step, index) =>
    buildStep(step, promptModels, context, [...path, index]),
  );
}

function buildStep(
  raw: unknown,
  promptModels: Map<string, string>,
  context: BuildContext,
  path: readonly (string | number)[],
): StepShape {
  const record = asRecord(raw) ?? {};
  const generate = asRecord(record.generate);
  if (generate !== undefined) {
    const prompt = asString(generate.prompt) ?? '';
    const step: GenerateStep = {
      kind: 'generate',
      prompt,
      model: promptModels.get(prompt) ?? '',
      input: buildStepInput(generate.input),
      as: asString(generate.as) ?? '',
    };
    const contextName = asString(generate.context);
    if (contextName !== undefined) step.context = contextName;
    return step;
  }
  const retrieve = asRecord(record.retrieve);
  if (retrieve !== undefined) {
    return buildRetrieveStep(retrieve);
  }
  const tool = asRecord(record.tool);
  if (tool !== undefined) {
    const step: ToolStep = {
      kind: 'tool',
      tool: asString(tool.tool) ?? '',
      input: buildStepInput(tool.input),
      as: asString(tool.as) ?? '',
    };
    const requiresApproval = asBoolean(tool.requiresApproval);
    if (requiresApproval !== undefined) step.requiresApproval = requiresApproval;
    return step;
  }
  const branch = asRecord(record.branch);
  if (branch !== undefined) {
    return buildBranchStep(branch, promptModels, context, [...path, 'branch']);
  }
  const route = asRecord(record.route);
  if (route !== undefined) {
    return buildRouteStep(route, promptModels, context, [...path, 'route']);
  }
  const parallel = asRecord(record.parallel);
  if (parallel !== undefined) {
    const arms = asArray(parallel.branches);
    return {
      kind: 'parallel',
      branches: arms.map((arm, index) =>
        buildStepList(arm, promptModels, context, [...path, 'parallel', 'branches', index]),
      ),
    };
  }
  const map = asRecord(record.map);
  if (map !== undefined) {
    const body = asRecord(map.step) ?? {};
    const mapStep: MapStep = {
      kind: 'map',
      over: asString(map.over) ?? '',
      as: asString(map.as) ?? '',
      step: buildStep(body, promptModels, context, [...path, 'map', 'step']),
    };
    return mapStep;
  }
  const reduce = asRecord(record.reduce);
  if (reduce !== undefined) {
    const prompt = asString(reduce.prompt) ?? '';
    return {
      kind: 'reduce',
      over: asString(reduce.over) ?? '',
      prompt,
      model: promptModels.get(prompt) ?? '',
      as: asString(reduce.as) ?? '',
    };
  }
  const rerank = asRecord(record.rerank);
  if (rerank !== undefined) {
    return {
      kind: 'rerank',
      over: asString(rerank.over) ?? '',
      query: asString(rerank.query) ?? '',
      model: asString(rerank.model) ?? '',
      topN: asNumber(rerank.topN) ?? 0,
      as: asString(rerank.as) ?? '',
    };
  }
  const guard = asRecord(record.guard);
  if (guard !== undefined) {
    return {
      kind: 'guard',
      guardrail: asString(guard.guardrail) ?? '',
      stage: (asString(guard.stage) ?? 'input') as GuardStep['stage'],
      text: asString(guard.text) ?? '',
    };
  }
  const agent = asRecord(record.agent);
  if (agent !== undefined) {
    return {
      kind: 'agent',
      agent: asString(agent.agent) ?? '',
      text: asString(agent.text) ?? '',
      as: asString(agent.as) ?? '',
    };
  }
  const emit = asRecord(record.emit);
  return { kind: 'emit', event: asString(emit?.event) ?? '' };
}

/**
 * The spec layer already rejected a `when` the grammar cannot parse, so a parse failure
 * here means the two layers disagree. It still has to yield a `BranchStep`, because
 * `StepShape` has no "broken" variant: an unparsable predicate becomes the constant
 * `false`, so the failure closes the arm rather than opening it.
 */
function buildBranchStep(
  branch: Record<string, unknown>,
  promptModels: Map<string, string>,
  context: BuildContext,
  path: readonly (string | number)[],
): BranchStep {
  const source = asString(branch.when) ?? '';
  const parsed = parsePolicyExpr(source, { path: [...path, 'when'], file: context.file });
  context.diagnostics.push(...parsed.diagnostics);
  return {
    kind: 'branch',
    when: parsed.ast ?? { kind: 'boolean', value: false },
    // biome-ignore lint/suspicious/noThenProperty: the branch shape names its taken arm `then`.
    then: buildStepList(branch.then, promptModels, context, [...path, 'then']),
    else: buildStepList(branch.else, promptModels, context, [...path, 'else']),
  };
}

/**
 * The spec layer already refused a route the schema cannot express, so an empty `on`
 * here means the layers disagree. It is still built faithfully: the runtime fails a
 * route with no arm for the answer, which is the same closed door.
 */
function buildRouteStep(
  route: Record<string, unknown>,
  promptModels: Map<string, string>,
  context: BuildContext,
  path: readonly (string | number)[],
): RouteStep {
  const on: Record<string, StepShape[]> = {};
  for (const [label, arm] of Object.entries(asRecord(route.on) ?? {})) {
    on[label] = buildStepList(arm, promptModels, context, [...path, 'on', label]);
  }
  const step: RouteStep = {
    kind: 'route',
    decision: asString(route.decision) ?? '',
    input: asString(route.input) ?? '',
    on,
  };
  if (route.default !== undefined) {
    step.default = buildStepList(route.default, promptModels, context, [...path, 'default']);
  }
  const as = asString(route.as);
  if (as !== undefined) step.as = as;
  return step;
}

/** `query` stays as declared: the runtime interpolates it per request. */
export function buildRetrieveStep(retrieve: Record<string, unknown>): RetrieveStep {
  return {
    kind: 'retrieve',
    retriever: asString(retrieve.retriever) ?? '',
    query: asString(retrieve.query) ?? '',
    as: asString(retrieve.as) ?? '',
  };
}

function buildStepInput(raw: unknown): StepInput {
  const record = asRecord(raw) ?? {};
  const input: StepInput = {};
  for (const key of sortedKeys(record)) {
    input[key] = buildStepInputValue(record[key]);
  }
  return input;
}

/**
 * `{{ name }}` alone is a reference; a string with several placeholders is kept
 * as a template. The gate resolves the roots, so nothing is guessed here.
 */
function buildStepInputValue(raw: unknown): StepInputValue {
  if (raw === null) return { kind: 'literal', value: null };
  if (typeof raw === 'number' || typeof raw === 'boolean') return { kind: 'literal', value: raw };
  if (typeof raw !== 'string') return { kind: 'literal', value: String(raw) };

  const sole = SOLE_PLACEHOLDER_PATTERN.exec(raw);
  if (sole !== null) return { kind: 'reference', path: (sole[1] as string).split('.') };
  if (raw.includes('{{')) return { kind: 'template', template: raw };
  return { kind: 'literal', value: raw };
}

const MEMORY_KINDS = ['buffer', 'window', 'summary', 'semantic', 'episodic', 'vector'] as const;
const MEMORY_SCOPES = ['thread', 'user', 'global'] as const;
const GUARDRAIL_STAGES = ['input', 'output', 'retrieval', 'tool-call'] as const;
const GUARDRAIL_ACTIONS = ['block', 'redact', 'flag', 'escalate'] as const;

function buildMemory(raw: unknown): MemoryShape[] {
  const record = asRecord(raw) ?? {};
  return sortedKeys(record).map((id) => {
    const entry = asRecord(record[id]) ?? {};
    const memory: MemoryShape = {
      id,
      kind: asMemoryKind(entry.kind),
      scope: asMemoryScope(entry.scope),
      tokenBudget: asNumber(entry.tokenBudget) ?? DEFAULT_MEMORY_TOKEN_BUDGET,
      redact: asStringArray(entry.redact),
      traits: [],
    };
    const summarizeModel = asString(entry.summarizeModel);
    const store = asString(entry.store);
    const backend = asString(entry.backend);
    const ttl = asString(entry.ttl);
    if (summarizeModel !== undefined) memory.summarizeModel = summarizeModel;
    if (store !== undefined) memory.store = store;
    if (backend !== undefined) memory.backend = backend;
    if (ttl !== undefined) memory.ttl = ttl;
    return memory;
  });
}

/** Unknown kinds collapse to the cheapest tier rather than passing through. */
function asMemoryKind(raw: unknown): MemoryShape['kind'] {
  const value = asString(raw);
  return (MEMORY_KINDS as readonly string[]).includes(value ?? '')
    ? (value as MemoryShape['kind'])
    : 'buffer';
}

function asMemoryScope(raw: unknown): MemoryShape['scope'] {
  const value = asString(raw);
  return (MEMORY_SCOPES as readonly string[]).includes(value ?? '')
    ? (value as MemoryShape['scope'])
    : 'thread';
}

function buildGuardrails(raw: unknown): GuardrailShape[] {
  const record = asRecord(raw) ?? {};
  return sortedKeys(record).map((id) => {
    const entry = asRecord(record[id]) ?? {};
    const onFailRecord = asRecord(entry.onFail) ?? {};
    const onFail: GuardrailShape['onFail'] = {
      message: asString(onFailRecord.message) ?? '',
      log: asBoolean(onFailRecord.log) ?? false,
    };
    const fallbackPrompt = asString(onFailRecord.fallbackPrompt);
    if (fallbackPrompt !== undefined) onFail.fallbackPrompt = fallbackPrompt;

    const stages = asStringArray(entry.stages).filter(
      (stage): stage is GuardrailShape['stages'][number] =>
        (GUARDRAIL_STAGES as readonly string[]).includes(stage),
    );
    const action = asString(entry.action);
    const decision = asString(entry.decision);
    const onDecision = asRecord(entry.onDecision) ?? {};
    const guardrail: GuardrailShape = {
      id,
      engine:
        entry.engine === 'bedrock' || entry.engine === 'model-armor' ? entry.engine : 'builtin',
      stages,
      policies: asStringArray(entry.policies).filter(isGuardrailPolicyKind),
      action: (GUARDRAIL_ACTIONS as readonly string[]).includes(action ?? '')
        ? (action as GuardrailShape['action'])
        : 'block',
      redact: asStringArray(entry.redact),
      tools: asStringArray(entry.tools),
      onFail,
      traits: [],
    };
    if (decision !== undefined) guardrail.decision = decision;
    const outcomes: Record<string, GuardrailDecisionAction> = {};
    for (const label of Object.keys(onDecision).sort()) {
      const outcome = asString(onDecision[label]);
      if ((GUARDRAIL_DECISION_ACTIONS as readonly string[]).includes(outcome ?? '')) {
        outcomes[label] = outcome as GuardrailDecisionAction;
      }
    }
    if (Object.keys(outcomes).length > 0) guardrail.onDecision = outcomes;
    const minConfidence = asNumber(entry.minConfidence);
    if (minConfidence !== undefined) guardrail.minConfidence = minConfidence;
    const bedrock = buildBedrockPolicy(entry.bedrock);
    if (bedrock !== undefined) guardrail.bedrock = bedrock;
    const modelArmor = buildModelArmorPolicy(entry.modelArmor);
    if (modelArmor !== undefined) guardrail.modelArmor = modelArmor;
    return guardrail;
  });
}

/**
 * The managed policy block, with the closed vocabularies applied.
 *
 * Filtering an unknown category here is the same rule the detectors follow: the IR is a
 * published contract, so a producer that writes an enum this build does not know loses
 * the entry instead of shipping a policy the module would render as nothing. An empty
 * policy is `undefined`, which is how "the operator owns the guardrail" is spelled.
 */
function buildBedrockPolicy(raw: unknown): BedrockGuardrailPolicy | undefined {
  const record = asRecord(raw);
  if (record === undefined) return undefined;
  const policy: BedrockGuardrailPolicy = {};

  const content = asRecord(record.content);
  if (content !== undefined) {
    const filters: Partial<Record<BedrockContentFilter, BedrockContentStrength>> = {};
    for (const key of sortedKeys(content)) {
      if (!(BEDROCK_CONTENT_FILTERS as readonly string[]).includes(key)) continue;
      const strength = asString(content[key]);
      if (!(BEDROCK_CONTENT_STRENGTHS as readonly string[]).includes(strength ?? '')) continue;
      filters[key as BedrockContentFilter] = strength as BedrockContentStrength;
    }
    if (Object.keys(filters).length > 0) policy.content = filters;
  }

  const topics = asRecord(record.topics);
  if (topics !== undefined) {
    const definitions: Record<string, string> = {};
    for (const name of sortedKeys(topics)) {
      const definition = asString(topics[name]);
      if (definition !== undefined) definitions[name] = definition;
    }
    if (Object.keys(definitions).length > 0) policy.topics = definitions;
  }

  const pii = asStringArray(record.pii).filter((entity): entity is BedrockPiiEntity =>
    (BEDROCK_PII_ENTITIES as readonly string[]).includes(entity),
  );
  if (pii.length > 0) policy.pii = pii;

  const words = asStringArray(record.words);
  if (words.length > 0) policy.words = words;

  return Object.keys(policy).length > 0 ? policy : undefined;
}

/**
 * The Model Armor template policy, with the closed vocabularies applied.
 *
 * The same rule as the Bedrock block: an enum this build does not know is dropped
 * rather than passed through, and an empty policy is `undefined` -- which is how "the
 * operator owns the template" stays distinguishable from "the spec said nothing".
 * A `false` toggle is kept, because it is an explicit `DISABLED` rather than an
 * omission.
 */
function buildModelArmorPolicy(raw: unknown): ModelArmorGuardrailPolicy | undefined {
  const record = asRecord(raw);
  if (record === undefined) return undefined;
  const policy: ModelArmorGuardrailPolicy = {};

  const rai = asRecord(record.rai);
  if (rai !== undefined) {
    const filters: Partial<Record<ModelArmorRaiFilter, ModelArmorConfidence>> = {};
    for (const key of sortedKeys(rai)) {
      if (!(MODEL_ARMOR_RAI_FILTERS as readonly string[]).includes(key)) continue;
      const confidence = asString(rai[key]);
      if (!(MODEL_ARMOR_CONFIDENCES as readonly string[]).includes(confidence ?? '')) continue;
      filters[key as ModelArmorRaiFilter] = confidence as ModelArmorConfidence;
    }
    if (Object.keys(filters).length > 0) policy.rai = filters;
  }

  const promptInjection = asString(record.promptInjection);
  if ((MODEL_ARMOR_CONFIDENCES as readonly string[]).includes(promptInjection ?? '')) {
    policy.promptInjection = promptInjection as ModelArmorConfidence;
  }

  const maliciousUri = asBoolean(record.maliciousUri);
  if (maliciousUri !== undefined) policy.maliciousUri = maliciousUri;

  const sensitiveData = asBoolean(record.sensitiveData);
  if (sensitiveData !== undefined) policy.sensitiveData = sensitiveData;

  return Object.keys(policy).length > 0 ? policy : undefined;
}

function buildDecisions(raw: unknown): DecisionShape[] {
  const record = asRecord(raw) ?? {};
  return sortedKeys(record).map((id) => {
    const entry = asRecord(record[id]) ?? {};
    const type = asString(entry.type);
    const decision: DecisionShape = {
      id,
      identity: decisionIdentity(id),
      provider: 'typesafe',
      model: asString(entry.model) ?? '',
      type: (DECISION_QUESTION_TYPES as readonly string[]).includes(type ?? '')
        ? (type as DecisionQuestionType)
        : 'noul',
      instructions: asString(entry.instructions) ?? '',
      onError: (DECISION_ON_ERROR as readonly string[]).includes(asString(entry.onError) ?? '')
        ? (asString(entry.onError) as DecisionOnError)
        : 'block',
      traits: [],
    };

    const description = asString(entry.description);
    if (description !== undefined) decision.description = description;

    const criteria = entry.criteria;
    if (Array.isArray(criteria)) {
      // `score`: order is the score, so the list is preserved exactly as declared.
      decision.criteria = criteria
        .map((criterion) => asString(criterion))
        .filter((criterion): criterion is string => criterion !== undefined);
    } else if (asRecord(criteria) !== undefined) {
      // `choice`: labels are a set, so sorting keeps the serialized IR stable.
      const map = asRecord(criteria) ?? {};
      decision.criteria = Object.fromEntries(
        sortedKeys(map).map((label) => [label, asString(map[label]) ?? '']),
      );
    }
    return decision;
  });
}

function buildAgents(
  raw: unknown,
  context: BuildContext,
  projectState: AgentStateShape | undefined,
): AgentShape[] {
  const record = asRecord(raw) ?? {};
  return sortedKeys(record).map((id) => {
    const entry = asRecord(record[id]) ?? {};
    const agent: AgentShape = {
      id,
      name: asString(entry.name) ?? id,
      instructions: asString(entry.instructions) ?? '',
      model: asString(entry.model) ?? '',
      tools: asStringArray(entry.tools),
      retrievers: asStringArray(entry.retrievers),
      memory: asStringArray(entry.memory),
      guardrails: asStringArray(entry.guardrails),
      maxSteps: asNumber(entry.maxSteps) ?? 1,
      handoffs: asStringArray(entry.handoffs),
      delegates: asStringArray(entry.delegates),
      engine: asAgentEngine(entry.engine),
      traits: [],
    };

    // The project store is resolved into every agent that declares none, so a generator
    // reads one field instead of walking up to the document. An agent override replaces it
    // whole rather than merging: two stores with one field swapped would be a store whose
    // connection string and kind disagree.
    const state = buildState(entry.state, ['agents', id, 'state'], context) ?? projectState;
    if (state !== undefined) agent.state = state;

    const structuredOutput = asString(entry.structuredOutput);
    if (structuredOutput !== undefined) {
      agent.structuredOutput = buildTypeRef(structuredOutput, context);
    }
    const maxTokensBudget = asNumber(entry.maxTokensBudget);
    if (maxTokensBudget !== undefined) agent.maxTokensBudget = maxTokensBudget;
    const maxCostBudget = asNumber(entry.maxCostBudget);
    if (maxCostBudget !== undefined) agent.maxCostBudget = maxCostBudget;
    const onBudgetExhausted = asAgentOnBudgetExhausted(entry.onBudgetExhausted);
    if (onBudgetExhausted !== undefined) agent.onBudgetExhausted = onBudgetExhausted;
    const engineVersion = asString(entry.engineVersion);
    if (engineVersion !== undefined) agent.engineVersion = engineVersion;

    const humanInTheLoop = asRecord(entry.humanInTheLoop);
    if (humanInTheLoop !== undefined) {
      const parsed = parsePolicyExpr(asString(humanInTheLoop.when) ?? '', {
        path: ['agents', id, 'humanInTheLoop', 'when'],
        file: context.file,
      });
      context.diagnostics.push(...parsed.diagnostics);
      if (parsed.ast !== undefined) {
        agent.humanInTheLoop = {
          when: parsed.ast,
          channel: asString(humanInTheLoop.channel) ?? '',
        };
      }
    }
    return agent;
  });
}

function asAgentEngine(raw: unknown): AgentEngine {
  const value = asString(raw);
  return (AGENT_ENGINES as readonly string[]).includes(value ?? '')
    ? (value as AgentEngine)
    : 'native';
}

function asAgentOnBudgetExhausted(raw: unknown): AgentOnBudgetExhausted | undefined {
  const value = asString(raw);
  return (AGENT_ON_BUDGET_EXHAUSTED as readonly string[]).includes(value ?? '')
    ? (value as AgentOnBudgetExhausted)
    : undefined;
}

/**
 * The declared profile, or `standard` when the document declares none.
 *
 * An unrecognised value is reported rather than coerced. The schema already pins the enum,
 * so reaching this with a bad value means the document bypassed validation -- and a
 * profile decides which controls the gates require, so defaulting an unknown one to
 * `standard` would silently drop every requirement it was meant to impose.
 */
function buildProfile(raw: unknown, context: BuildContext): Profile {
  const declared = asString(raw);
  if (declared === undefined) return DEFAULT_PROFILE;
  if ((PROFILES as readonly string[]).includes(declared)) return declared as Profile;
  context.diagnostics.push(
    errorDiagnostic({
      code: IR_DIAGNOSTIC_CODES.profileUnknown,
      message: `profile "${declared}" is not one of ${PROFILES.join(', ')}`,
      path: ['profile'],
      hint: 'name `standard` or `enterprise`; the profile decides which controls the gates require, so an unknown one would require nothing',
    }),
  );
  return DEFAULT_PROFILE;
}

function buildDeployments(raw: unknown, context: BuildContext): DeploymentShape[] {
  const record = asRecord(raw) ?? {};
  return sortedKeys(record).map((id) => {
    const entry = asRecord(record[id]) ?? {};
    const target = asString(entry.target);
    const known = target !== undefined && (DEPLOY_TARGETS as readonly string[]).includes(target);
    if (!known) {
      // The spec schema already rejects this, so reaching it means the document bypassed
      // validation. Defaulting to `serverless` would let this projection invent the very
      // thing an infrastructure generator provisions, so it reports instead.
      context.diagnostics.push(
        errorDiagnostic({
          code: IR_DIAGNOSTIC_CODES.deployTargetUnknown,
          message: `deployment "${id}" declares target "${target ?? ''}", which is not one of ${DEPLOY_TARGETS.join(', ')}`,
          path: ['deployments', id, 'target'],
          hint: 'name one of the supported targets; the builder will not choose a resource type on your behalf',
        }),
      );
    }

    const deployment: DeploymentShape = {
      id,
      target: known ? (target as DeploymentShape['target']) : 'serverless',
      streaming: asBoolean(entry.streaming) ?? false,
      secrets: asStringArray(entry.secrets),
      env: buildDeploymentEnv(entry.env),
      traits: [],
    };
    const concurrency = asNumber(entry.concurrency);
    if (concurrency !== undefined) deployment.concurrency = concurrency;
    const autoscale = asRecord(entry.autoscale);
    if (autoscale !== undefined) {
      const min = asNumber(autoscale.min);
      const max = asNumber(autoscale.max);
      const metric = asString(autoscale.metric);
      const missing = [
        min === undefined ? '`min`' : undefined,
        max === undefined ? '`max`' : undefined,
        metric === undefined ? '`metric`' : undefined,
      ].filter((name): name is string => name !== undefined);
      if (missing.length > 0) {
        context.diagnostics.push(
          errorDiagnostic({
            code: IR_DIAGNOSTIC_CODES.deployAutoscaleIncomplete,
            message: `deployment "${id}" declares an autoscale block without ${missing.join(', ')}`,
            path: ['deployments', id, 'autoscale'],
            hint: 'declare `min`, `max` and `metric` together; a partial block would otherwise become a scaling policy this projection invented',
          }),
        );
      }
      deployment.autoscale = { min: min ?? 0, max: max ?? 1, metric: metric ?? '' };
    }
    const cloud = buildSpecCloud(entry.cloud, id, context);
    if (cloud !== undefined) deployment.cloud = cloud;
    const region = asString(entry.region);
    if (region !== undefined) deployment.region = region;
    const audit = buildDeploymentAudit(entry.audit, id, context);
    if (audit !== undefined) deployment.audit = audit;
    const identity = buildDeploymentIdentity(entry.identity, id, context);
    if (identity !== undefined) deployment.identity = identity;
    const network = buildDeploymentNetwork(entry.network, id, context);
    if (network !== undefined) deployment.network = network;
    const approvals = buildDeploymentApprovals(entry.approvals, id, context);
    if (approvals !== undefined) deployment.approvals = approvals;
    const image: DeploymentImageShape | undefined = buildDeploymentImage(entry.image, id, context);
    if (image !== undefined) deployment.image = image;
    const runtime = buildDeploymentRuntime(entry.runtime, id, context);
    if (runtime !== undefined) deployment.runtime = runtime;
    const pipeline = asString(entry.pipeline);
    if (pipeline !== undefined) deployment.pipeline = pipeline;
    return deployment;
  });
}

/**
 * The cloud a deployment pins, when it pins one.
 *
 * Absent is not an error: it means the spec did not decide, so the CLI's `--cloud` still
 * does, which is exactly the behaviour every document written before 0.25 relies on. A
 * value outside the enum is reported, because the projection would otherwise have to
 * choose a cloud for a deployment that named a different one.
 */
function buildSpecCloud(raw: unknown, id: string, context: BuildContext): SpecCloud | undefined {
  const declared = asString(raw);
  if (declared === undefined) return undefined;
  if ((SPEC_CLOUDS as readonly string[]).includes(declared)) return declared as SpecCloud;
  context.diagnostics.push(
    errorDiagnostic({
      code: IR_DIAGNOSTIC_CODES.deployTargetUnknown,
      message: `deployment "${id}" declares cloud "${declared}", which is not one of ${SPEC_CLOUDS.join(', ')}`,
      path: ['deployments', id, 'cloud'],
      hint: 'name a supported cloud, or drop `cloud` and pass `--cloud` to `aid infra`',
    }),
  );
  return undefined;
}

/**
 * The durable run store a document declares, for the project or for one agent.
 *
 * The schema already requires `kind` and `urlEnv`, so a missing one means the document
 * bypassed validation. It is reported rather than defaulted: a store is a deployment
 * commitment, and inventing a connection variable would point the generated code at a
 * database nobody declared.
 */
function buildState(
  raw: unknown,
  path: (string | number)[],
  context: BuildContext,
): AgentStateShape | undefined {
  const state = asRecord(raw);
  if (state === undefined) return undefined;
  const kind = asString(state.kind);
  const urlEnv = asString(state.urlEnv);
  if (kind === undefined || !(AGENT_STATE_KINDS as readonly string[]).includes(kind)) {
    context.diagnostics.push(
      errorDiagnostic({
        code: IR_DIAGNOSTIC_CODES.agentsStateStore,
        message: `${formatPath(path)} declares state kind "${kind ?? ''}", which is not one of ${AGENT_STATE_KINDS.join(', ')}`,
        path: [...path, 'kind'],
        hint: 'name `postgres` for a shared store or `sqlite` for a single-instance deploy',
      }),
    );
    return undefined;
  }
  if (urlEnv === undefined) {
    context.diagnostics.push(
      errorDiagnostic({
        code: IR_DIAGNOSTIC_CODES.agentsStateStore,
        message: `${formatPath(path)} declares a state store with no \`urlEnv\``,
        path: [...path, 'urlEnv'],
        hint: 'name the environment variable holding the connection string; a credential never enters the spec',
      }),
    );
    return undefined;
  }
  const shape: AgentStateShape = { kind: kind as AgentStateKind, urlEnv };
  const ttlHours = asNumber(state.ttlHours);
  if (ttlHours !== undefined) shape.ttlHours = ttlHours;
  return shape;
}

/**
 * The identity provider a deployment trusts.
 *
 * Projected as declared: whether the provider is one the customer can actually reach is
 * their provider's question, and the generated code only checks the claims it is told to.
 */
function buildDeploymentIdentity(
  raw: unknown,
  id: string,
  context: BuildContext,
): DeploymentIdentityShape | undefined {
  const identity = asRecord(raw);
  if (identity === undefined) return undefined;
  const kind = asString(identity.kind);
  const issuer = asString(identity.issuer);
  if (kind === undefined || !(DEPLOYMENT_IDENTITY_KINDS as readonly string[]).includes(kind)) {
    context.diagnostics.push(
      errorDiagnostic({
        code: IR_DIAGNOSTIC_CODES.profileIdentity,
        message: `deployment "${id}" declares identity kind "${kind ?? ''}", which is not one of ${DEPLOYMENT_IDENTITY_KINDS.join(', ')}`,
        path: ['deployments', id, 'identity', 'kind'],
        hint: 'name `oidc`, which covers every OIDC-compliant provider',
      }),
    );
    return undefined;
  }
  if (issuer === undefined) return undefined;
  const shape: DeploymentIdentityShape = { kind: kind as DeploymentIdentityKind, issuer };
  const audience = asString(identity.audience);
  if (audience !== undefined) shape.audience = audience;
  const rolesClaim = asString(identity.rolesClaim);
  if (rolesClaim !== undefined) shape.rolesClaim = rolesClaim;
  const scopesClaim = asString(identity.scopesClaim);
  if (scopesClaim !== undefined) shape.scopesClaim = scopesClaim;
  return shape;
}

/** How a deployment is reachable and what it may reach. */
function buildDeploymentNetwork(
  raw: unknown,
  id: string,
  context: BuildContext,
): DeploymentNetworkShape | undefined {
  const network = asRecord(raw);
  if (network === undefined) return undefined;
  // `private` is schema-required, so absence means validation was bypassed. Reading a
  // missing flag as `false` would emit a public deployment from a document that meant to
  // ask for a private one, so the builder reports instead of guessing.
  if (typeof network.private !== 'boolean') {
    context.diagnostics.push(
      errorDiagnostic({
        code: IR_DIAGNOSTIC_CODES.profileNetwork,
        message: `deployment "${id}" declares network placement with no boolean \`private\` flag`,
        path: ['deployments', id, 'network', 'private'],
        hint: 'set `private: true` for private placement or `private: false` to reach the internet directly',
      }),
    );
    return undefined;
  }
  const shape: DeploymentNetworkShape = { private: network.private };
  const egress = asString(network.egress);
  if (egress !== undefined && (DEPLOYMENT_EGRESS as readonly string[]).includes(egress)) {
    shape.egress = egress as DeploymentEgress;
  }
  return shape;
}

/** Who has to sign off before a change lands. */
function buildDeploymentApprovals(
  raw: unknown,
  id: string,
  context: BuildContext,
): DeploymentApprovalsShape | undefined {
  const approvals = asRecord(raw);
  if (approvals === undefined) return undefined;
  const require = asStringArray(approvals.require);
  const minApprovers = asNumber(approvals.minApprovers);
  // A policy with no reviewer or no threshold approves nothing, so the profile gate would
  // be satisfied by a document that asks no one. Both are schema-required; a missing one
  // here means validation was bypassed and the control does not exist.
  if (require.length === 0 || minApprovers === undefined) {
    const problem = require.length === 0 ? 'no required approvers' : 'no minApprovers threshold';
    context.diagnostics.push(
      errorDiagnostic({
        code: IR_DIAGNOSTIC_CODES.profileApprovals,
        message: `deployment "${id}" declares an approval policy with ${problem}`,
        path: ['deployments', id, 'approvals'],
        hint: 'list at least one reviewer in `require` and set `minApprovers` to how many must agree',
      }),
    );
    return undefined;
  }
  const shape: DeploymentApprovalsShape = { require, minApprovers };
  const environments = asStringArray(approvals.environments);
  if (environments.length > 0) shape.environments = environments;
  return shape;
}
/**
 * The audit destination a deployment declares.
 *
 * Only the shape is projected here; whether the sink belongs to the deployment's cloud is
 * the profile gate's question, because that is where the diagnostic can name the valid set.
 */
function buildDeploymentAudit(
  raw: unknown,
  id: string,
  context: BuildContext,
): DeploymentAuditShape | undefined {
  const audit = asRecord(raw);
  if (audit === undefined) return undefined;
  const sink = asString(audit.sink);
  if (sink === undefined || !(AUDIT_SINKS as readonly string[]).includes(sink)) {
    context.diagnostics.push(
      errorDiagnostic({
        code: IR_DIAGNOSTIC_CODES.auditTarget,
        message: `deployment "${id}" declares an audit sink "${sink ?? ''}", which is not one of ${AUDIT_SINKS.join(', ')}`,
        path: ['deployments', id, 'audit', 'sink'],
        hint: 'name one of the supported sinks; an audit record has to land somewhere the deploy can create',
      }),
    );
    return undefined;
  }
  const shape: DeploymentAuditShape = { sink: sink as AuditSink };
  const retentionDays = asNumber(audit.retentionDays);
  if (retentionDays !== undefined) shape.retentionDays = retentionDays;
  return shape;
}

function buildDeploymentImage(
  raw: unknown,
  id: string,
  context: BuildContext,
): DeploymentImageShape | undefined {
  const image = asRecord(raw);
  if (image === undefined) return undefined;
  const registry = asString(image.registry);
  const name = asString(image.name);
  const descriptor = registry === undefined ? undefined : imageRegistry(registry);
  if (registry === undefined || name === undefined || descriptor === undefined) {
    // The spec schema and its version gate both reject this, so reaching it means the
    // document bypassed validation. Dropping the image would make a deployment look
    // unpublishable when it declared otherwise, so the builder reports instead.
    const problem =
      registry === undefined
        ? 'no registry'
        : descriptor === undefined
          ? `registry "${registry}", which is not one of ${IMAGE_REGISTRIES.join(', ')}`
          : 'no name';
    context.diagnostics.push(
      errorDiagnostic({
        code: IR_DIAGNOSTIC_CODES.deployImageIncomplete,
        message: `deployment "${id}" declares an image with ${problem}`,
        path: ['deployments', id, 'image'],
        hint: `declare \`registry: ${IMAGE_REGISTRIES[0]}\` and a repository \`name\`; the builder will not choose a registry on your behalf`,
      }),
    );
    return undefined;
  }
  // The declared fields are part of the registry's contract, not an optional extra: a
  // registry whose login cannot be built is a workflow that fails on the first tag, so it
  // is refused here rather than emitted. A field the registry does not consume is refused
  // too -- a `ghcr.io` image carrying a Docker Hub token names a secret nothing reads.
  const fields: RegistryImageFields = {};
  const missing: string[] = [];
  const unknown: string[] = [];
  for (const field of descriptor.declares) {
    const value = asString(image[field]);
    if (value === undefined) missing.push(field);
    else fields[field] = value;
  }
  for (const field of IMAGE_REGISTRY_FIELDS) {
    if (!descriptor.declares.includes(field) && image[field] !== undefined) unknown.push(field);
  }
  if (missing.length > 0 || unknown.length > 0) {
    const problem =
      missing.length > 0
        ? `no ${missing.map((field) => `\`${field}\``).join(' or ')} for registry "${registry}"`
        : `\`${unknown.join('` and `')}\`, which registry "${registry}" does not consume`;
    context.diagnostics.push(
      errorDiagnostic({
        code: IR_DIAGNOSTIC_CODES.deployImageCredentials,
        message: `deployment "${id}" declares an image with ${problem}`,
        path: ['deployments', id, 'image'],
        hint:
          descriptor.declares.length === 0
            ? `drop the registry fields; \`${registry}\` is a registry the release workflow authenticates to with the GITHUB_TOKEN it already holds`
            : `declare ${descriptor.credentialHint}`,
      }),
    );
    return undefined;
  }
  // The host and the repository path are derived from the declared fields rather than
  // restated in the spec, so the two cannot disagree. Both are omitted when the registry
  // id already is the host, which keeps a `ghcr.io` or `docker.io` image byte-identical.
  const loginServer = descriptor.loginServer(fields);
  const repository = descriptor.repository?.(fields, name) ?? name;
  const loginFields =
    descriptor.loginFields === undefined
      ? undefined
      : Object.fromEntries(descriptor.loginFields.map((field) => [field, fields[field] ?? '']));
  return {
    registry: registry as DeploymentImageShape['registry'],
    name: repository,
    ...(loginServer === registry ? {} : { loginServer }),
    ...(loginFields === undefined ? {} : { loginFields }),
    ...(fields.usernameSecret === undefined ? {} : { usernameSecret: fields.usernameSecret }),
    ...(fields.tokenSecret === undefined ? {} : { tokenSecret: fields.tokenSecret }),
  };
}

function buildDeploymentRuntime(
  raw: unknown,
  id: string,
  context: BuildContext,
): DeploymentRuntimeShape | undefined {
  const runtime = asRecord(raw);
  if (runtime === undefined) return undefined;
  const platform = asString(runtime.platform);
  const known =
    platform !== undefined && (AGENT_RUNTIME_PLATFORMS as readonly string[]).includes(platform);
  if (!known) {
    // The spec schema and its version gate both reject this, so reaching it means the
    // document bypassed validation. Dropping the block would deploy to a compute module
    // the document asked not to have, so the builder reports instead.
    context.diagnostics.push(
      errorDiagnostic({
        code: IR_DIAGNOSTIC_CODES.deployRuntimeIncomplete,
        message: `deployment "${id}" declares a runtime with platform "${platform ?? ''}", which is not one of ${AGENT_RUNTIME_PLATFORMS.join(', ')}`,
        path: ['deployments', id, 'runtime', 'platform'],
        hint: `name one of ${AGENT_RUNTIME_PLATFORMS.join(', ')}; the builder will not choose a platform on your behalf`,
      }),
    );
    return undefined;
  }
  const typed = platform as AgentRuntimePlatform;
  const memory = asRecord(runtime.memory);
  const session = asRecord(runtime.session);
  const ttl = asNumber(session?.ttlMinutes);
  const built: DeploymentRuntimeShape = {
    platform: typed,
    // Managed short-term memory has a Terraform representation on both platforms: a
    // memory resource beside the runtime on AWS, a Memory Bank on the reasoning engine on
    // GCP. The flag is carried as the document asked rather than filtered by platform.
    memory: { shortTerm: asBoolean(memory?.shortTerm) ?? false },
    session: { ttlMinutes: ttl ?? 480 },
  };
  // The validator refuses a gateway on any other platform and refuses one no `gateways`
  // entry declares, so reaching here with an unreachable pairing means the document
  // bypassed validation. The field is carried only where it can be honoured.
  const gateway = asString(runtime.gateway);
  if (gateway !== undefined && typed === 'aws-agentcore') built.gateway = gateway;
  return built;
}

function buildDeploymentEnv(raw: unknown): DeploymentShape['env'] {
  const env: DeploymentShape['env'] = [];
  for (const item of asArray(raw)) {
    const record = asRecord(item);
    const name = asString(record?.name);
    if (record === undefined || name === undefined) continue;
    const entry: DeploymentShape['env'][number] = { name };
    const value = asString(record.value);
    const secret = asBoolean(record.secret);
    if (value !== undefined) entry.value = value;
    if (secret !== undefined) entry.secret = secret;
    env.push(entry);
  }
  return env;
}

function buildEvals(raw: unknown, context: BuildContext): EvalShape[] {
  const record = asRecord(raw) ?? {};
  return sortedKeys(record).map((id) => {
    const entry = asRecord(record[id]) ?? {};
    const metrics = asArray(entry.metrics)
      .map((metric, index) => buildMetric(metric, context, ['evals', id, 'metrics', index]))
      .filter((metric): metric is MetricShape => metric !== undefined);
    const gate = asRecord(entry.gate) ?? {};
    const dataset = asRecord(entry.dataset) ?? {};
    const budgets = metrics
      .filter((metric): metric is { kind: 'cost'; max: number } => metric.kind === 'cost')
      .map((metric) => metric.max);
    const latencies = metrics
      .filter((metric): metric is { kind: 'latency'; maxMs: number } => metric.kind === 'latency')
      .map((metric) => metric.maxMs);

    const evalShape: EvalShape = {
      id,
      description: asString(entry.description),
      target: buildEvalTarget(entry.target),
      dataset: { source: 'file', uri: asString(dataset.uri) ?? '' },
      metrics,
      gate: {
        ci: asBoolean(gate.ci) ?? false,
        maxRegression: asNumber(gate.maxRegression) ?? DEFAULT_EVAL_MAX_REGRESSION,
        samples: asNumber(gate.samples) ?? DEFAULT_EVAL_SAMPLES,
      },
      traits: [],
    };
    // Written only when declared, so every eval that predates `minMean` serializes
    // byte-identically.
    const minMean = asNumber(gate.minMean);
    if (minMean !== undefined) evalShape.gate.minMean = minMean;
    const promotion = buildPromotion(gate.promotion);
    if (promotion !== undefined) evalShape.gate.promotion = promotion;
    if (budgets.length > 0) evalShape.costBudget = Math.min(...budgets);
    if (latencies.length > 0) evalShape.latencyBudgetP95Ms = Math.min(...latencies);
    return evalShape;
  });
}

/** Parses the qualified `kind:id` target form; `valid` is false when it is not one. */
export function buildEvalTarget(raw: unknown): EvalTarget {
  const qualified = asString(raw) ?? '';
  const match = EVAL_TARGET_PATTERN.exec(qualified);
  if (match === null) {
    return { kind: 'pipeline', id: qualified, qualified, valid: false };
  }
  const kind = match[1] as string;
  const id = match[2] as string;
  if (kind !== 'pipeline' && kind !== 'prompt' && kind !== 'agent') {
    return { kind: 'pipeline', id, qualified, valid: false };
  }
  return { kind, id, qualified, valid: true };
}

function buildMetric(
  raw: unknown,
  context: BuildContext,
  path: readonly (string | number)[],
): MetricShape | undefined {
  const record = asRecord(raw) ?? {};
  const kind = asString(record.kind);
  const field = asString(record.field);

  switch (kind) {
    case 'exact':
      return field === undefined ? undefined : { kind: 'exact', field };
    case 'contains': {
      if (field === undefined) return undefined;
      const value = asString(record.value);
      return value === undefined ? { kind: 'contains', field } : { kind: 'contains', field, value };
    }
    case 'json-schema':
      return { kind: 'json-schema', schema: buildTypeRef(record.schema, context) };
    case 'tool-trace':
      return {
        kind: 'tool-trace',
        expect: asStringArray(record.expect),
        ordered: asBoolean(record.ordered) ?? false,
      };
    case 'cost': {
      const max = asNumber(record.max);
      return max === undefined ? undefined : { kind: 'cost', max };
    }
    case 'latency': {
      const maxMs = asNumber(record.maxMs);
      return maxMs === undefined ? undefined : { kind: 'latency', maxMs };
    }
    case 'retrieval':
      return {
        kind: 'retrieval',
        expectDocs: asStringArray(record.expectDocs),
        // The cut-off is what the metric scores against; 1 is the narrowest reading
        // of a k the spec must declare anyway.
        k: asNumber(record.k) ?? 1,
      };
    case 'llm-judge': {
      const rubric = asString(record.rubric);
      if (rubric === undefined) return undefined;
      const metric: MetricShape = { kind: 'llm-judge', rubric };
      const model = asString(record.model);
      const threshold = asNumber(record.threshold);
      if (field !== undefined) metric.field = field;
      if (model !== undefined) metric.model = model;
      if (threshold !== undefined) metric.threshold = threshold;
      return metric;
    }
    case 'decision': {
      const decision = asString(record.decision);
      if (decision === undefined) return undefined;
      // No threshold: a score comes from a model, so `BaselineGate` refuses to gate on it
      // (`allow_nondeterministic` exists for local exploration only). Declaring one here
      // would be a knob the generated gate could never honor.
      return { kind: 'decision', decision };
    }
    case 'assert': {
      const message = asString(record.message);
      if (message === undefined) return undefined;
      const parsed = parsePredicateExpr(asString(record.expr) ?? '', {
        path: [...path, 'expr'],
        file: context.file,
      });
      context.diagnostics.push(...parsed.diagnostics);
      // An unparsable predicate is already an error diagnostic; dropping the metric
      // keeps the IR closed, and the caller treats the diagnostics as the failure.
      if (parsed.ast.kind === 'invalid') return undefined;
      return { kind: 'assert', expr: parsed.ast, message };
    }
    default:
      return undefined;
  }
}

/** Rejects a binding name that is not a lower-case identifier. */
export function isBindingName(value: string): boolean {
  return BINDING_PATTERN.test(value);
}

/**
 * Sensitivity is declared, or inferred from a name deny-list. Inference is
 * fail-closed on purpose: over-redacting a trace is recoverable, leaking one is
 * not, and spec v0.1 has no `sensitive` marker of its own.
 */
const SENSITIVE_NAME_PATTERN =
  /(pass(word|phrase)|secret|token|api_?key|private_?key|credential|ssn|social_security|credit_?card|card_?number|cvv|iban|email|phone|address|birth|dob)/i;

export function isSensitiveName(name: string): boolean {
  return SENSITIVE_NAME_PATTERN.test(name);
}

/** Sorted names of every field and variable the IR marks as sensitive. */
export function sensitiveNames(ir: { types: TypeShape[]; prompts: PromptShape[] }): string[] {
  const names = new Set<string>();
  for (const type of ir.types) {
    for (const field of type.fields) {
      if (field.sensitive === true) names.add(field.name);
    }
  }
  for (const prompt of ir.prompts) {
    for (const variable of prompt.variables) {
      if (variable.sensitive === true) names.add(variable.name);
    }
  }
  return [...names].sort();
}

const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g;

/** Every `{{ path }}` placeholder a prompt template references, deduplicated. */
export function templatePlaceholders(template: string): string[] {
  const names = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER_PATTERN)) {
    names.add((match[1] as string).split('.')[0] as string);
  }
  return [...names].sort();
}

/**
 * A declared `observability` is honoured as written; a synthesized one defaults
 * `redact` to the sensitive set. An explicit `redact` therefore wins, which is
 * what lets the security gate catch a trace config that narrows it too far.
 */
/**
 * A trace config with no `export` inherits the enclosing one exactly like `trace` and
 * `redact` do: a pipeline that narrows its redactions keeps recording where the project
 * records. `export` is written only when something declared it, so every IR built from a
 * document before spec 0.27 serializes byte-identically.
 */
function buildObservability(
  raw: unknown,
  sensitive: readonly string[],
  inherited?: ObservabilityShape,
): ObservabilityShape {
  // The top-level call is the only one that owns a process. A pipeline inherits when to
  // trace and what to redact; it does not inherit where spans are shipped, because a
  // pipeline inside a process does not ship them, and duplicating the destination onto
  // every pipeline would claim a decision each pipeline never made.
  const processWide = inherited === undefined;
  const record = asRecord(raw) ?? {};
  const declared = asString(record.export);
  const endpointEnv = asString(record.endpointEnv);
  const shape: ObservabilityShape = {
    trace: asBoolean(record.trace) ?? inherited?.trace ?? DEFAULT_OBSERVABILITY.trace,
    redact: Array.isArray(record.redact)
      ? asStringArray(record.redact)
      : [...(inherited?.redact ?? sensitive)],
  };
  if (processWide) {
    if (declared === 'otlp' || declared === 'none') shape.export = declared;
    if (endpointEnv !== undefined) shape.endpointEnv = endpointEnv;
    const feedback = buildFeedback(record.feedback);
    if (feedback !== undefined) shape.feedback = feedback;
    const alerts = buildAlerts(record.alerts);
    if (alerts !== undefined) shape.alerts = alerts;
  }
  return shape;
}

/**
 * The feedback intake is a process-wide declaration, like the export destination: a
 * pipeline does not take back signals separately from the app it lives in. Written only
 * when declared, so a 0.27 document's IR is byte-identical.
 */
function buildFeedback(raw: unknown): FeedbackShape | undefined {
  const record = asRecord(raw);
  if (record === undefined) return undefined;
  const signalRecords = asRecord(record.signals) ?? {};
  const signals: FeedbackSignalShape[] = Object.keys(signalRecords)
    .sort()
    .map((id) => {
      const entry = asRecord(signalRecords[id]) ?? {};
      const kind = asString(entry.kind) ?? '';
      const description = asString(entry.description);
      const signal: FeedbackSignalShape = {
        id,
        kind: isFeedbackSignalKind(kind) ? kind : 'thumbs',
      };
      if (description !== undefined) signal.description = description;
      return signal;
    });
  const pii = asRecord(record.pii);
  const shape: FeedbackShape = { signals, redact: asStringArray(pii?.redact) };
  const retentionDays = asNumber(record.retentionDays);
  if (retentionDays !== undefined) shape.retentionDays = retentionDays;
  const persistent = asBoolean(record.persistent);
  if (persistent !== undefined) shape.persistent = persistent;
  return shape;
}

/**
 * Alarm policies, written only when declared. Sorted by id so the IR and everything
 * derived from it are deterministic, and so the emitted module and the fixture that
 * asserts its bytes list the alarms in an order a reader can predict.
 *
 * Every field is schema-required, so the fallbacks here are unreachable for a document
 * that passed validation; they exist so the IR stays total rather than trusting a cast.
 * A metric outside the closed registry falls back to the first entry rather than being
 * kept, because a metric the derivation cannot back must never reach an emitter.
 */
function buildAlerts(raw: unknown): AlertShape[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const alerts: AlertShape[] = raw.map((entry) => {
    const record = asRecord(entry) ?? {};
    const metric = asString(record.metric) ?? '';
    const window = asString(record.window) ?? '';
    const aggregate = asString(record.aggregate) ?? '';
    const alert: AlertShape = {
      id: asString(record.id) ?? '',
      metric: isAlertMetric(metric) ? metric : ALERT_METRICS[0],
      window: isAlertWindow(window) ? window : ALERT_WINDOWS[0],
      aggregate: isAlertAggregate(aggregate) ? aggregate : ALERT_AGGREGATES[0],
      threshold: asNumber(record.threshold) ?? 0,
    };
    const source = asString(record.source);
    if (source !== undefined) alert.source = source;
    return alert;
  });
  return alerts.sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * A promotion policy, written only when declared. `allowedQualityDrop` and `baseline`
 * are schema-required, so the fallbacks here are unreachable for a document that passed
 * validation; they exist so the IR stays total rather than trusting a cast.
 */
function buildPromotion(raw: unknown): PromotionShape | undefined {
  const record = asRecord(raw);
  if (record === undefined) return undefined;
  const baselineRecord = asRecord(record.baseline) ?? {};
  const shape: PromotionShape = {
    allowedQualityDrop: asNumber(record.allowedQualityDrop) ?? 0,
    baseline: {
      prompt: asString(baselineRecord.prompt) ?? '',
      version: asNumber(baselineRecord.version) ?? 0,
    },
  };
  const allowedCostIncrease = asNumber(record.allowedCostIncrease);
  if (allowedCostIncrease !== undefined) shape.allowedCostIncrease = allowedCostIncrease;
  const approval = asRecord(record.approval);
  if (approval !== undefined) {
    shape.approval = {
      by: asStringArray(approval.by),
      record: asString(approval.record) ?? '',
    };
  }
  return shape;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/** Object keys in a deterministic order, so YAML key order never reaches the IR. */
export function sortedKeys(record: Record<string, unknown>): string[] {
  return Object.keys(record).sort();
}
