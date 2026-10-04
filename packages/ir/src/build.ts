/**
 * The builder: a validated spec document value -> IR v0.1.
 *
 * The builder never throws for a user-recoverable condition. It applies Phase 0
 * defaults (so generated code never supplies a default of its own), sorts every
 * object-derived collection by stable id (so YAML key order cannot change the IR),
 * and reports `ir/*` diagnostics through the same shape every other gate uses.
 */

import { SPEC_VERSION } from '@aid/spec';
import {
  deriveRequiredCapabilities,
  isModelCapability,
  SPEC_MODEL_CAPABILITY_MAP,
} from './capabilities.js';
import { catalogCostProfile, catalogModel } from './catalog/index.js';
import type { IrDiagnostic } from './diagnostics.js';
import { parsePolicyExpr } from './policy/index.js';
import {
  DEFAULT_MAX_CONTEXT_TOKENS,
  DEFAULT_OBSERVABILITY,
  DEFAULT_RUNTIME,
  type ErrorPolicy,
  type EvalShape,
  type EvalTarget,
  type Idempotency,
  type IR,
  IR_VERSION,
  isProvider,
  type MetricShape,
  type ModelLimits,
  type ModelParams,
  type ModelShape,
  modelIdentity,
  type ObservabilityShape,
  type PipelineShape,
  PRIMITIVE_TYPES,
  type PrimitiveType,
  type ProjectShape,
  type PromptOutput,
  type PromptShape,
  type PromptVariable,
  type Provider,
  pipelineIdentity,
  promptIdentity,
  type SideEffects,
  type StepInput,
  type StepInputValue,
  type StepShape,
  type ToolHandler,
  type ToolShape,
  type TypeField,
  type TypeRef,
  type TypeShape,
  toolIdentity,
} from './shapes.js';

export const DEFAULT_TARGET = 'py-fastapi';
export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
export const DEFAULT_TOOL_RETRIES = 0;
export const DEFAULT_IDEMPOTENCY: Idempotency = 'none';
export const DEFAULT_EVAL_MAX_REGRESSION = 0;
export const DEFAULT_EVAL_SAMPLES = 5;

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
  const sensitive = sensitiveNames({ types, prompts });
  const observability = buildObservability(root.observability, sensitive);
  const promptModels = new Map(prompts.map((prompt) => [prompt.id, prompt.model]));
  const pipelines = buildPipelines(root.pipelines, observability, sensitive, promptModels);
  const evals = buildEvals(root.evals, context);

  const ir: IR = {
    irVersion: IR_VERSION,
    specVersion: asString(root.specVersion) ?? SPEC_VERSION,
    project,
    types,
    models,
    prompts,
    tools,
    retrievers: [],
    embeddings: [],
    stores: [],
    memory: [],
    agents: [],
    pipelines,
    evals,
    guardrails: [],
    deployments: [],
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
  const semantic = asBoolean(record.semantic);
  return prompt === undefined && semantic === undefined ? undefined : { prompt, semantic };
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

function asIdempotency(raw: unknown): Idempotency {
  const value = asString(raw);
  return value === 'key' || value === 'natural' || value === 'none' ? value : DEFAULT_IDEMPOTENCY;
}

function buildPipelines(
  raw: unknown,
  observability: ObservabilityShape,
  sensitive: readonly string[],
  promptModels: Map<string, string>,
): PipelineShape[] {
  const record = asRecord(raw) ?? {};
  return sortedKeys(record).map((id) => {
    const entry = asRecord(record[id]) ?? {};
    const trigger = asRecord(asRecord(entry.trigger)?.http) ?? {};
    const pipeline: PipelineShape = {
      id,
      identity: pipelineIdentity(id),
      trigger: {
        kind: 'http' as const,
        method: asString(trigger.method) ?? 'post',
        path: asString(trigger.path) ?? '/',
      },
      steps: asArray(entry.steps).map((step) => buildStep(step, promptModels)),
      errorPolicy: buildErrorPolicy(entry.errorPolicy),
      observability: buildObservability(entry.observability, sensitive, observability),
    };
    const description = asString(entry.description);
    if (description !== undefined) pipeline.description = description;
    return pipeline;
  });
}

function buildErrorPolicy(raw: unknown): ErrorPolicy {
  const record = asRecord(raw) ?? {};
  return {
    retries: asNumber(record.retries) ?? 0,
    fallback: asString(record.fallback),
    deadLetter: asString(record.deadLetter),
  };
}

function buildStep(raw: unknown, promptModels: Map<string, string>): StepShape {
  const record = asRecord(raw) ?? {};
  const generate = asRecord(record.generate);
  if (generate !== undefined) {
    const prompt = asString(generate.prompt) ?? '';
    return {
      kind: 'generate',
      prompt,
      model: promptModels.get(prompt) ?? '',
      input: buildStepInput(generate.input),
      as: asString(generate.as) ?? '',
    };
  }
  const tool = asRecord(record.tool);
  if (tool !== undefined) {
    return {
      kind: 'tool',
      tool: asString(tool.tool) ?? '',
      input: buildStepInput(tool.input),
      as: asString(tool.as) ?? '',
    };
  }
  const emit = asRecord(record.emit);
  return { kind: 'emit', event: asString(emit?.event) ?? '' };
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

function buildEvals(raw: unknown, context: BuildContext): EvalShape[] {
  const record = asRecord(raw) ?? {};
  return sortedKeys(record).map((id) => {
    const entry = asRecord(record[id]) ?? {};
    const metrics = asArray(entry.metrics)
      .map((metric) => buildMetric(metric, context))
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
  if (kind !== 'pipeline' && kind !== 'prompt') {
    return { kind: 'pipeline', id, qualified, valid: false };
  }
  return { kind, id, qualified, valid: true };
}

function buildMetric(raw: unknown, context: BuildContext): MetricShape | undefined {
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
function buildObservability(
  raw: unknown,
  sensitive: readonly string[],
  inherited?: ObservabilityShape,
): ObservabilityShape {
  const fallbackRedact = inherited === undefined ? [...sensitive] : [...inherited.redact];
  const record = asRecord(raw);
  if (record === undefined) {
    return { trace: inherited?.trace ?? DEFAULT_OBSERVABILITY.trace, redact: fallbackRedact };
  }
  return {
    trace: asBoolean(record.trace) ?? inherited?.trace ?? DEFAULT_OBSERVABILITY.trace,
    redact: Array.isArray(record.redact) ? asStringArray(record.redact) : fallbackRedact,
  };
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
