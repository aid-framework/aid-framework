/**
 * The promotion gate — the four checks that make a declared promotion policy mean
 * something before anyone measures a candidate.
 *
 * A `gate.promotion` block is a promise about a future release, and every part of it can
 * be unanswerable while looking complete. The four checks here are the ones that are
 * answerable from the document alone, and each names a different missing piece:
 *
 *   - `baseline.version` must be *behind* the prompt's declared version. A promotion that
 *     names the version already in the spec has nothing to promote, and a template edited
 *     without a bump would make two different prompts answer to one identity. This is the
 *     whole content of `ir/prompt-version-stale` that a document can settle: the IR cannot
 *     see what version 4's template used to say, so the rule enforces the bump that keeps
 *     the question from arising.
 *   - a promotion needs a quality metric to have a quality allowance. `allowedQualityDrop`
 *     governs the mean of *quality* metrics, so an eval that measures only `cost` or
 *     `latency` has an allowance that governs nothing.
 *   - a cost ceiling needs a cost measurement. `allowedCostIncrease` is a fraction of a
 *     baseline cost, so an eval with no `cost` metric has no baseline cost to increase and
 *     the ceiling would be enforced against nothing.
 *   - under `profile: enterprise` the promotion needs a recorded approval. A promotion is
 *     a change to what an accepted release does, which is what the profile's change control
 *     exists to name.
 *
 * The numbers themselves are not measured here. `aid eval --compare` applies the policy to
 * two recorded baselines; a build-time gate can only refuse a policy that could never be
 * applied. That division is deliberate: a gate that invented a cost figure would be
 * approximating, which is the one thing this design does not do.
 */

import { specVersionAtLeast } from '@aid-framework/spec';
import { IR_DIAGNOSTIC_CODES, type IrDiagnostic } from '../diagnostics.js';
import type { EvalShape, IR, MetricShape, PromptShape } from '../shapes.js';
import { type GateOptions, type GateResult, NO_SUPPRESSIONS, reporter } from './contract.js';

/** The spec version that first let a document declare a promotion policy. */
export const EVAL_PROMOTION_MIN_VERSION = '0.28';

/** The metric kinds that score an answer rather than describe a run. */
const NON_QUALITY_METRIC_KINDS = new Set<MetricShape['kind']>(['cost', 'latency']);

function isQualityMetric(metric: MetricShape): boolean {
  return !NON_QUALITY_METRIC_KINDS.has(metric.kind);
}

export function promotionGate(ir: IR, options: GateOptions): GateResult {
  const diagnostics: IrDiagnostic[] = [];
  const report = reporter(options);
  if (!specVersionAtLeast(ir.specVersion, EVAL_PROMOTION_MIN_VERSION)) {
    return { diagnostics, suppressed: NO_SUPPRESSIONS };
  }

  const prompts = new Map(ir.prompts.map((prompt) => [prompt.id, prompt]));

  for (const evalShape of ir.evals) {
    const promotion = evalShape.gate.promotion;
    if (promotion === undefined) continue;

    const path = ['evals', evalShape.id, 'gate', 'promotion'];
    const stale = staleVersionDiagnostic(evalShape, prompts, report, path);
    if (stale !== undefined) {
      diagnostics.push(stale);
      // The version, the allowance and the cost ceiling all describe the same candidate.
      // Once the candidate has no distinct identity, every other complaint is about a
      // release that cannot be named, so the reader gets one diagnostic and a fix.
      continue;
    }
    diagnostics.push(...policyDiagnostics(ir, evalShape, report, path));
  }

  return { diagnostics, suppressed: NO_SUPPRESSIONS };
}

/**
 * The candidate must declare a version *ahead* of the accepted one. Equal is the case the
 * rule exists for; behind is a rollback, which is not a promotion and would silently
 * compare a release against a NEWER baseline.
 */
function staleVersionDiagnostic(
  evalShape: EvalShape,
  prompts: Map<string, PromptShape>,
  report: ReturnType<typeof reporter>,
  path: string[],
): IrDiagnostic | undefined {
  const promotion = evalShape.gate.promotion;
  if (promotion === undefined) return undefined;
  const baseline = promotion.baseline;
  const prompt = prompts.get(baseline.prompt);

  if (prompt === undefined) {
    return report.error({
      code: IR_DIAGNOSTIC_CODES.refUnresolved,
      message: `the promotion gate rejected "${evalShape.id}": baseline names prompt "${baseline.prompt}", which this document does not declare`,
      path: [...path, 'baseline', 'prompt'],
      hint: `declare prompts.${baseline.prompt}, or name the prompt whose accepted version this candidate replaces`,
    });
  }

  if (prompt.version > baseline.version) return undefined;

  const relation =
    prompt.version === baseline.version
      ? `version ${prompt.version} is the accepted baseline, so nothing has been bumped`
      : `version ${prompt.version} is behind the accepted baseline ${baseline.version}, which is a rollback rather than a promotion`;
  return report.error({
    code: IR_DIAGNOSTIC_CODES.promptVersionStale,
    message: `the promotion gate rejected "${evalShape.id}": baseline records "prompts.${baseline.prompt}" at version ${baseline.version}, and the document declares ${relation} -- two different templates would share one identity`,
    path: [...path, 'baseline', 'version'],
    hint: `bump prompts.${baseline.prompt}.version above ${baseline.version} for the candidate, or move the baseline up once the new version is accepted`,
  });
}

function policyDiagnostics(
  ir: IR,
  evalShape: EvalShape,
  report: ReturnType<typeof reporter>,
  path: string[],
): IrDiagnostic[] {
  const diagnostics: IrDiagnostic[] = [];
  const promotion = evalShape.gate.promotion;
  if (promotion === undefined) return diagnostics;

  if (!evalShape.metrics.some(isQualityMetric)) {
    diagnostics.push(
      report.error({
        code: IR_DIAGNOSTIC_CODES.promotionRegression,
        message: `the promotion gate rejected "${evalShape.id}": allowedQualityDrop is ${promotion.allowedQualityDrop} but the eval measures no quality metric, so the allowance governs nothing`,
        path: [...path, 'allowedQualityDrop'],
        hint: 'add a metric that scores the answer (exact, contains, json-schema, llm-judge, decision, retrieval or assert), or drop the promotion policy',
      }),
    );
  }

  if (promotion.allowedCostIncrease !== undefined && evalShape.costBudget === undefined) {
    diagnostics.push(
      report.error({
        code: IR_DIAGNOSTIC_CODES.promotionCost,
        message: `the promotion gate rejected "${evalShape.id}": allowedCostIncrease is ${promotion.allowedCostIncrease} but the eval declares no cost ceiling, so neither baseline records a spend comparison the allowance could govern`,
        path: [...path, 'allowedCostIncrease'],
        hint: 'add a `cost` metric with a `max` ceiling so both baselines score that ceiling, or drop allowedCostIncrease',
      }),
    );
  }

  if (ir.profile === 'enterprise' && promotion.approval === undefined) {
    diagnostics.push(
      report.error({
        code: IR_DIAGNOSTIC_CODES.promotionApproval,
        message: `the promotion gate rejected "${evalShape.id}": profile "enterprise" requires a recorded approval for a promotion, and the candidate declares none`,
        path: [...path],
        hint: 'add `approval: { by: [<who>], record: <committed path> }`, or promote under `profile: standard`',
      }),
    );
  }

  return diagnostics;
}
