/**
 * Gate 2 — normalization.
 *
 * `normalize` is a total, pure, idempotent function that materializes every default
 * into the IR, resolved from the top-level `observability` downwards. Its existence
 * is what lets generated code never supply a default of its own: the gate re-runs it
 * and reports anything the builder left implicit, so "the IR is normalized" is a
 * checked property rather than a hope.
 */

import { DEFAULT_EVAL_MAX_REGRESSION, DEFAULT_EVAL_SAMPLES, sensitiveNames } from '../build.js';
import { catalogModel } from '../catalog/index.js';
import { IR_DIAGNOSTIC_CODES, type IrDiagnostic } from '../diagnostics.js';
import { canonicalJson } from '../serialize.js';
import {
  DEFAULT_MAX_CONTEXT_TOKENS,
  DEFAULT_OBSERVABILITY,
  DEFAULT_RUNTIME,
  type EvalShape,
  type IR,
  type ModelShape,
  modelIdentity,
  type ObservabilityShape,
  PHASE_0_PROVIDERS,
  type PipelineShape,
  pipelineIdentity,
  promptIdentity,
  type StepShape,
  type ToolShape,
  toolIdentity,
} from '../shapes.js';
import { type GateOptions, type GateResult, reporter, type SuppressedCheck } from './contract.js';

const SUPPRESSED: SuppressedCheck[] = [];

type Reporter = ReturnType<typeof reporter>;

/**
 * Materializes every default the builder may have left implicit. Applying it twice is
 * a no-op: each rule only ever fills an absent value, and no rule depends on the order
 * another ran in, so normalization is idempotent and order-independent.
 */
export function normalize(ir: IR): IR {
  const normalized = structuredClone(ir) as IR;
  const observability = normalizeObservability(
    normalized.observability,
    sensitiveNames(normalized),
  );

  normalized.observability = observability;
  normalized.runtime = { ...DEFAULT_RUNTIME, ...normalized.runtime };
  normalized.models = normalized.models.map(normalizeModel);
  normalized.prompts = normalized.prompts.map((prompt) => ({
    ...prompt,
    identity: promptIdentity(prompt.id, prompt.version),
    params: prompt.params ?? {},
    examples: prompt.examples ?? [],
    guardrails: prompt.guardrails ?? [],
    evals: prompt.evals ?? [],
    traits: prompt.traits ?? [],
  }));
  normalized.tools = normalized.tools.map(normalizeTool);
  normalized.pipelines = normalized.pipelines.map((pipeline) =>
    normalizePipeline(pipeline, observability),
  );
  normalized.evals = normalized.evals.map(normalizeEval);

  return normalized;
}

function normalizeObservability(
  raw: ObservabilityShape | undefined,
  inherited: readonly string[],
): ObservabilityShape {
  return {
    trace: raw?.trace ?? DEFAULT_OBSERVABILITY.trace,
    redact: [...(raw?.redact ?? inherited)],
  };
}

function normalizeModel(model: ModelShape): ModelShape {
  return {
    ...model,
    identity: modelIdentity(model.id),
    capabilities: [...model.capabilities],
    params: model.params ?? {},
    limits: {
      ...model.limits,
      contextTokens: model.limits?.contextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS,
    },
    fallbacks: [...(model.fallbacks ?? [])],
    traits: model.traits ?? [],
  };
}

function normalizeTool(tool: ToolShape): ToolShape {
  return {
    ...tool,
    identity: toolIdentity(tool.id),
    requiresConfirmation: tool.requiresConfirmation || tool.sideEffects === 'destructive',
    traits: tool.traits ?? [],
  };
}

function normalizePipeline(pipeline: PipelineShape, inherited: ObservabilityShape): PipelineShape {
  return {
    ...pipeline,
    identity: pipelineIdentity(pipeline.id),
    steps: pipeline.steps.map(normalizeStep),
    errorPolicy: {
      retries: pipeline.errorPolicy?.retries ?? 0,
      fallback: pipeline.errorPolicy?.fallback,
      deadLetter: pipeline.errorPolicy?.deadLetter,
    },
    observability: normalizeObservability(pipeline.observability, inherited.redact),
  };
}

function normalizeStep(step: StepShape): StepShape {
  return step.kind === 'emit' ? step : { ...step, input: step.input ?? {} };
}

function normalizeEval(evalShape: EvalShape): EvalShape {
  return {
    ...evalShape,
    dataset: { ...evalShape.dataset },
    metrics: [...evalShape.metrics],
    gate: {
      ci: evalShape.gate.ci,
      maxRegression: evalShape.gate.maxRegression ?? DEFAULT_EVAL_MAX_REGRESSION,
      samples: evalShape.gate.samples ?? DEFAULT_EVAL_SAMPLES,
    },
    traits: evalShape.traits ?? [],
  };
}

/**
 * The dot-paths at which two IR values disagree, so the gate can say *which* default
 * is missing rather than only that the IR differs from its normalization. Keys present
 * on one side only are reported, which is how an unmaterialized default is caught.
 */
export function diffPaths(
  before: unknown,
  after: unknown,
  path: (string | number)[] = [],
): string[] {
  if (before === after) return [];
  if (Array.isArray(before) && Array.isArray(after)) {
    const length = Math.max(before.length, after.length);
    const found: string[] = [];
    for (let index = 0; index < length; index += 1) {
      found.push(...diffPaths(before[index], after[index], [...path, index]));
    }
    return found;
  }
  if (isRecord(before) && isRecord(after)) {
    const found: string[] = [];
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      found.push(...diffPaths(before[key], after[key], [...path, key]));
    }
    return found;
  }
  return path.length === 0 ? [] : [path.join('.')];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeGate(ir: IR, options: GateOptions): GateResult {
  const diagnostics: IrDiagnostic[] = [];
  const report = reporter(options);

  const normalized = normalize(ir);
  const missing = diffPaths(ir, normalized);
  if (missing.length > 0) {
    diagnostics.push(
      report.error({
        code: IR_DIAGNOSTIC_CODES.normalizationIncomplete,
        message: `the normalize gate rejected this IR: ${missing.length} value(s) were left implicit for the generator to invent, at ${missing.join(', ')}`,
        path: [],
        hint: 'every default is materialized during the build, so a generator never supplies one',
      }),
    );
  }

  for (const model of normalized.models) {
    checkModel(model, diagnostics, report);
  }

  return { diagnostics, suppressed: SUPPRESSED };
}

function checkModel(model: ModelShape, diagnostics: IrDiagnostic[], report: Reporter): void {
  if (!(PHASE_0_PROVIDERS as readonly string[]).includes(model.provider)) {
    diagnostics.push(
      report.error({
        code: IR_DIAGNOSTIC_CODES.providerUnsupported,
        message: `the normalize gate rejected this model: provider "${model.provider}" is not one of the providers Phase 0 serves (${PHASE_0_PROVIDERS.join(', ')})`,
        path: ['models', model.id, 'provider'],
      }),
    );
  }

  const limit =
    model.limits?.maxOutputTokens ?? catalogModel(model.modelId)?.limits?.maxOutputTokens;
  const requested = model.params?.maxTokens;
  if (limit === undefined || requested === undefined || requested <= limit) return;
  diagnostics.push(
    report.error({
      code: IR_DIAGNOSTIC_CODES.paramExceedsLimit,
      message: `the normalize gate rejected these params: model "${model.id}" requests maxTokens ${requested}, above the catalog limit of ${limit}`,
      path: ['models', model.id, 'params', 'maxTokens'],
      hint: 'lower the request, or pin a model whose limits allow it',
    }),
  );
}

export function isNormalized(ir: IR): boolean {
  return canonicalJson(ir) === canonicalJson(normalize(ir));
}
