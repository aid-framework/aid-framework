/**
 * Which prompt and model an eval measures.
 *
 * Both generators need the same answer -- the Python one to emit `MODEL` into the eval
 * module, the TypeScript one for the same reason -- and the answer is a function of the IR
 * alone. It lives here rather than in either generator because a second copy of this
 * decision is a second place for it to drift, and because nothing here renders code: it is
 * the same kind of question `runGates` answers, asked before emission rather than after.
 *
 * `Phase 0` gates one prompt against one model per eval. A pipeline that renders two
 * prompts, or one prompt against two models, is a pipeline whose score is a blend of two
 * measurements: the failures of either half would be reported against the other's id, so
 * the target is refused rather than averaged.
 */

import type { EvalShape, IR, PromptShape } from './shapes.js';

/** The prompt an eval measures, and the one model it is measured against. */
export interface EvalSubject {
  /** The prompt the eval renders, and whose single variable a dataset row fills. */
  readonly prompt: PromptShape;
  /** The model alias the app pins for that prompt, which is what the eval samples. */
  readonly model: string;
}

/** Why an eval has no single subject. Both codes are `PlanProblemCode`s in every generator. */
export type EvalSubjectProblemCode = 'unresolved-reference' | 'unsupported-eval-target';

/** Either the subject of an eval, or the single reason it has none. */
export type EvalSubjectResult =
  | { readonly ok: true; readonly subject: EvalSubject }
  | { readonly ok: false; readonly code: EvalSubjectProblemCode; readonly message: string };

/** Code-unit ordering, never `localeCompare`, so output is byte-identical everywhere. */
function compareIds(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Every model alias a prompt is pinned to by a `generate` step in any pipeline. */
export function modelsUnderTest(ir: IR, promptId: string): string[] {
  const aliases = new Set<string>();
  for (const pipeline of ir.pipelines) {
    for (const step of pipeline.steps) {
      if (step.kind === 'generate' && step.prompt === promptId) aliases.add(step.model);
    }
  }
  return [...aliases].sort(compareIds);
}

/** `prompt@model`, deduplicated and sorted, so a repeated step is one subject. */
function distinctSubjects(
  ir: IR,
  target: EvalShape['target'],
): { prompt: string; model: string }[] {
  const pairs: { prompt: string; model: string }[] = [];
  if (target.kind === 'prompt') {
    for (const model of modelsUnderTest(ir, target.id)) pairs.push({ prompt: target.id, model });
  } else {
    const pipeline = ir.pipelines.find((item) => item.id === target.id);
    for (const step of pipeline?.steps ?? []) {
      if (step.kind === 'generate') pairs.push({ prompt: step.prompt, model: step.model });
    }
  }
  const seen = new Set<string>();
  const distinct: { prompt: string; model: string }[] = [];
  for (const pair of pairs) {
    const key = `${pair.prompt}\u0000${pair.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    distinct.push(pair);
  }
  return distinct.sort(
    (left, right) => compareIds(left.prompt, right.prompt) || compareIds(left.model, right.model),
  );
}

/**
 * The prompt and model an eval measures, or why it measures none.
 *
 * The spec language names a `pipeline:` or `prompt:` target, and from 0.27 it can also
 * name an `agent:` one, while the IR can name a prompt directly, so every form has to
 * resolve here. An agent is refused by name: it *is* declared, so reporting it as
 * undeclared would be a lie, and what is missing is a runner that carries a trajectory
 * rather than a declaration the document failed to make.
 *
 * A pure function of the IR on purpose: every rejection below is a branch a unit test can
 * reach without a spec file, a model or a filesystem.
 */
export function evalSubject(ir: IR, evaluation: EvalShape): EvalSubjectResult {
  const target = evaluation.target;
  if (target === undefined || !target.valid) {
    return {
      ok: false,
      code: 'unsupported-eval-target',
      message:
        `evaluation targets a 'pipeline:', 'prompt:' or 'agent:' target, and ` +
        `'${target?.qualified ?? '<none>'}' is none of them`,
    };
  }
  if (target.kind === 'agent') {
    return {
      ok: false,
      code: 'unsupported-eval-target',
      message:
        `'${target.qualified}' names an agent, and this build emits an eval over a prompt, not ` +
        'over an agent run: an agent eval needs a runner that carries a trajectory, which is ' +
        "not built yet; score the pipeline that runs it with a 'pipeline:' target",
    };
  }
  const declared =
    target.kind === 'prompt'
      ? ir.prompts.some((prompt) => prompt.id === target.id)
      : ir.pipelines.some((pipeline) => pipeline.id === target.id);
  if (!declared) {
    return {
      ok: false,
      code: 'unresolved-reference',
      message: `${target.kind} '${target.id}' is not declared`,
    };
  }
  const subjects = distinctSubjects(ir, target);
  if (subjects.length > 1) {
    const rendered = subjects.map((pair) => `${pair.prompt} on ${pair.model}`).join(', ');
    return {
      ok: false,
      code: 'unsupported-eval-target',
      message:
        `'${target.qualified}' renders ${subjects.length} prompts (${rendered}), and Phase 0 gates ` +
        'one prompt on one model per eval; declare a separate eval per prompt',
    };
  }
  const only = subjects[0];
  if (only === undefined) {
    return {
      ok: false,
      code: 'unresolved-reference',
      message:
        `'${target.qualified}' renders no prompt, so there is nothing to measure: an eval reads ` +
        "the dataset's input as the one variable the prompt renders",
    };
  }
  const prompt = ir.prompts.find((item) => item.id === only.prompt);
  if (prompt === undefined) {
    return {
      ok: false,
      code: 'unresolved-reference',
      message: `prompt '${only.prompt}' is not declared`,
    };
  }
  return { ok: true, subject: { prompt, model: only.model } };
}
