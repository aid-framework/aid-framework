/**
 * The failure mode of `plan()`.
 *
 * `Generator.plan` returns a `Plan`, which has no diagnostics channel, and the
 * diagnostic codes the SDK defines are a closed union owned by `@aid/generator-sdk`.
 * A target that cannot express the IR it was handed therefore throws, carrying every
 * problem it found rather than the first one: a generator author who fixes one path
 * per run is how a silent mis-generation survives to a review.
 */

import type { PlanProblem } from './validate.js';

export class PyFastApiPlanError extends Error {
  readonly problems: readonly PlanProblem[];

  /** The distinct reason codes, sorted, for stable assertions in tests. */
  readonly codes: readonly string[];

  constructor(problems: readonly PlanProblem[]) {
    const codes = [...new Set(problems.map((problem) => problem.code))].sort();
    const lines = problems.map(
      (problem) => `- [${problem.code}] ${problem.path}: ${problem.message}`,
    );
    super(`the py-fastapi target cannot generate this IR:\n${lines.join('\n')}`);
    this.name = 'PyFastApiPlanError';
    this.problems = problems;
    this.codes = codes;
  }
}
