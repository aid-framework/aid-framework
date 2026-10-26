/**
 * The generator's pure half: IR in, a file list out, nothing written.
 *
 * `planPyFastApi` is the only place that decides which files this target produces. It
 * validates before it emits, so a declaration the target cannot express stops
 * generation instead of being silently dropped or silently ignored (see `./validate.ts`
 * for the decision table and the reason each rejection exists).
 *
 * The result is a canonical value: files are sorted by path, so byte-identical output
 * is a property of the IR rather than of the order these emitters happen to be called
 * in. `emit` is the identity on the sorted plan -- the plan already holds the bytes,
 * which is what makes the golden test, the determinism test and the drift check all
 * measurable without a filesystem.
 */

import type { GeneratedFile, Plan } from '@aid/generator-sdk';
import type { IR } from '@aid/ir';

import { emitAgents, hasAgents } from './emit/agents.js';
import { emitBusinessToolSeed, emitContractsInit, emitToolContract } from './emit/contracts.js';
import { emitDeps } from './emit/deps.js';
import { emitEval, emitEvalsInit } from './emit/evals.js';
import { emitGatewayInit, emitGatewayModels } from './emit/gateway.js';
import { emitGuardrails, hasGuardrails } from './emit/guardrails.js';
import { emitObservability } from './emit/observability.js';
import { orderedEvals, orderedPipelines, orderedPrompts, orderedTools } from './emit/order.js';
import { emitBusinessInit, emitGeneratedInit } from './emit/package.js';
import { emitPipelines } from './emit/pipelines.js';
import { emitBusinessPromptsInit, emitPromptModule, emitPromptsInit } from './emit/prompts.js';
import { emitRetrieval } from './emit/retrieval.js';
import { emitSchemas } from './emit/schemas.js';
import { emitSse } from './emit/sse.js';
import { emitBusinessToolsInit, emitToolAdapter, emitToolsInit } from './emit/tools.js';
import { PyFastApiPlanError } from './errors.js';
import { streams } from './streaming.js';
import { checkPlan } from './validate.js';

/** Code-unit order, so the plan does not depend on locale. */
function byPath(left: GeneratedFile, right: GeneratedFile): number {
  if (left.path < right.path) return -1;
  if (left.path > right.path) return 1;
  return 0;
}

/**
 * Every file this target emits for `ir`, in canonical order.
 *
 * The tree is laid out as design §8.3 describes: `generated/` is entirely this
 * generator's, `business/` holds only the seams a developer is meant to edit, and the
 * two `__init__.py` files that make the package importable belong to it as well.
 * Nothing above `generated/` or `business/` is planned -- `validatePlan` refuses a path
 * outside the managed roots, so `app/main.py` and the app's packaging are the
 * application's own files rather than generation output.
 */
export function filesFor(ir: IR): GeneratedFile[] {
  const prompts = orderedPrompts(ir);
  const tools = orderedTools(ir);
  /* The negotiation module exists when a route reads it, and a guardrail module when a
   * declaration needs one -- a file nothing imports is a file a reader has to explain. */
  const servesStreams = orderedPipelines(ir).some((pipeline) => streams(ir, pipeline));
  return [
    emitGeneratedInit(ir),
    emitSchemas(ir),
    emitObservability(ir),
    emitDeps(ir),
    emitGatewayModels(ir),
    emitGatewayInit(),
    ...(hasAgents(ir) ? [emitAgents(ir)] : []),
    ...(hasGuardrails(ir) ? [emitGuardrails(ir)] : []),
    ...(servesStreams ? [emitSse()] : []),
    ...tools.map((tool) => emitToolAdapter(ir, tool)),
    emitToolsInit(ir),
    ...prompts.map((prompt) => emitPromptModule(prompt)),
    emitPromptsInit(ir),
    ...emitPipelines(ir),
    emitContractsInit(),
    ...tools.map((tool) => emitToolContract(tool)),
    emitEvalsInit(ir),
    ...orderedEvals(ir).map((evaluation) => emitEval(ir, evaluation)),
    ...emitRetrieval(ir),
    emitBusinessInit(ir),
    emitBusinessToolsInit(ir),
    ...tools.map((tool) => emitBusinessToolSeed(tool)),
    emitBusinessPromptsInit(),
  ].sort(byPath);
}

/**
 * The plan for `ir`.
 *
 * Every problem this target found is reported at once -- `PyFastApiPlanError.codes` is
 * the sorted, deduplicated set -- because a generator that reveals one unsupported
 * declaration per run is how a half-generated application reaches a review.
 */
export function planPyFastApi(ir: IR): Plan {
  const problems = checkPlan(ir);
  if (problems.length > 0) {
    throw new PyFastApiPlanError(problems);
  }
  return { files: filesFor(ir) };
}

/** A plan's files as a `path -> content` map, for golden comparison and drift checks. */
export function fileMap(plan: Plan): Map<string, string> {
  return new Map(plan.files.map((file) => [file.path, file.content]));
}
