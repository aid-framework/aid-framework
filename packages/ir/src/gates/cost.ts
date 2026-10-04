/**
 * Gate 4 — cost.
 *
 * Cost profiles are resolved from the offline catalog in `src/catalog/models.json`, so
 * an estimate is deterministic and reproducible on a machine with no network. The gate
 * fails *closed* on an unpriced model that someone declared a budget for: an unpriced
 * model cannot be shown to fit a budget, and silently assuming it does is the failure
 * mode this gate exists to prevent.
 */

import { catalogCostProfile } from '../catalog/index.js';
import { IR_DIAGNOSTIC_CODES, type IrDiagnostic } from '../diagnostics.js';
import type { EvalShape, IR, ModelShape, PromptShape } from '../shapes.js';
import { type GateOptions, type GateResult, reporter, type SuppressedCheck } from './contract.js';

const SUPPRESSED: SuppressedCheck[] = [];

/** Rough tokens-per-character for a natural-language prompt. Fixed, so estimates compare. */
const CHARS_PER_TOKEN = 4;

/** Output tokens assumed when neither the params nor the catalog bound them. */
const DEFAULT_OUTPUT_TOKENS = 512;

/** One model's contribution to a target's estimated per-run cost. */
export interface ModelCostEstimate {
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Absent when no catalog profile resolved, i.e. the model is unpriced. */
  cost?: number;
}

export interface EvalCostEstimate {
  inputTokens: number;
  outputTokens: number;
  /** Absent when any model on the target's path is unpriced. */
  cost?: number;
  models: ModelCostEstimate[];
  /** The declared budget the estimate is compared against, when there is one. */
  budget?: number;
}

export function costGate(ir: IR, options: GateOptions): GateResult {
  const diagnostics: IrDiagnostic[] = [];
  const report = reporter(options);

  for (const evalShape of ir.evals) {
    const estimate = estimateEvalCost(ir, evalShape);
    if (estimate.models.length === 0) continue;

    if (estimate.cost === undefined) {
      const unpriced = estimate.models.filter((model) => model.cost === undefined);
      const named = unpriced.map((model) => model.model).join(', ');
      if (estimate.budget !== undefined) {
        diagnostics.push(
          report.error({
            code: IR_DIAGNOSTIC_CODES.costProfileUnknown,
            message: `the cost gate rejected this eval: "${evalShape.id}" declares a budget of ${estimate.budget}, but the costProfile of ${named} is unknown, so the budget cannot be enforced`,
            path: ['evals', evalShape.id, 'metrics'],
            hint: 'add the model to src/catalog/models.json, set models.<alias>.costProfile, or drop the budget',
          }),
        );
      } else {
        diagnostics.push(
          report.warn({
            code: IR_DIAGNOSTIC_CODES.costProfileUnknown,
            message: `the cost gate could not price this eval: the costProfile of ${named} is unknown, so "${evalShape.id}" has no cost estimate`,
            path: ['evals', evalShape.id, 'target'],
            hint: 'add the model to src/catalog/models.json, or set models.<alias>.costProfile',
          }),
        );
      }
      continue;
    }

    if (estimate.budget === undefined || estimate.cost <= estimate.budget) continue;
    diagnostics.push(
      report.warn({
        code: IR_DIAGNOSTIC_CODES.costBudgetExceeded,
        message: `the cost gate flagged this eval: "${evalShape.id}" is estimated at ${estimate.cost.toFixed(6)} per run, above its declared budget of ${estimate.budget}`,
        path: ['evals', evalShape.id, 'metrics'],
        hint: 'raise the budget, shorten the prompt, or cap maxTokens',
      }),
    );
  }

  return { diagnostics, suppressed: SUPPRESSED };
}

/**
 * The estimated per-run cost of one eval target: the sum over the models on the
 * target's path of its prompt tokens and its bounded output tokens.
 */
export function estimateEvalCost(ir: IR, evalShape: EvalShape): EvalCostEstimate {
  const prompts = new Map(ir.prompts.map((prompt) => [prompt.id, prompt]));
  const models = new Map(ir.models.map((model) => [model.id, model]));
  const used = promptsForTarget(ir, evalShape, prompts);
  const budget = evalShape.costBudget;

  const estimates = new Map<string, ModelCostEstimate>();
  for (const prompt of used) {
    const model = models.get(prompt.model);
    if (model === undefined) continue;
    const inputTokens = Math.ceil(prompt.template.length / CHARS_PER_TOKEN);
    const outputTokens =
      model.params?.maxTokens ?? model.limits?.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS;
    const existing = estimates.get(model.id);
    if (existing === undefined) {
      estimates.set(model.id, {
        model: model.id,
        inputTokens,
        outputTokens,
        cost: priceRun(model, inputTokens, outputTokens),
      });
    } else {
      existing.inputTokens += inputTokens;
      existing.outputTokens += outputTokens;
      existing.cost = priceRun(model, existing.inputTokens, existing.outputTokens);
    }
  }

  const parts = [...estimates.values()].sort((left, right) =>
    left.model < right.model ? -1 : left.model > right.model ? 1 : 0,
  );
  const inputTokens = parts.reduce((total, part) => total + part.inputTokens, 0);
  const outputTokens = parts.reduce((total, part) => total + part.outputTokens, 0);
  const priced = parts.every((part) => part.cost !== undefined);
  const result: EvalCostEstimate = { inputTokens, outputTokens, models: parts };
  if (priced) {
    result.cost = parts.reduce((total, part) => total + (part.cost ?? 0), 0);
  }
  if (budget !== undefined) result.budget = budget;
  return result;
}

function priceRun(
  model: ModelShape,
  inputTokens: number,
  outputTokens: number,
): number | undefined {
  const profile =
    model.costProfile ?? catalogCostProfile(model.modelId, model.costProfileId)?.profile;
  if (profile === undefined) return undefined;
  return (
    (inputTokens / 1_000_000) * profile.inputPerMTok +
    (outputTokens / 1_000_000) * profile.outputPerMTok
  );
}

function promptsForTarget(
  ir: IR,
  evalShape: EvalShape,
  prompts: Map<string, PromptShape>,
): PromptShape[] {
  if (evalShape.target.kind === 'prompt') {
    const prompt = prompts.get(evalShape.target.id);
    return prompt === undefined ? [] : [prompt];
  }

  const pipeline = ir.pipelines.find((entry) => entry.id === evalShape.target.id);
  if (pipeline === undefined) return [];
  const found: PromptShape[] = [];
  for (const step of pipeline.steps) {
    if (step.kind !== 'generate') continue;
    const prompt = prompts.get(step.prompt);
    if (prompt !== undefined) found.push(prompt);
  }
  return found;
}
