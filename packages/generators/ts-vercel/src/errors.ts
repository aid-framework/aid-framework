/**
 * The error a caller sees when the IR cannot be emitted for this target.
 *
 * Planning refuses rather than emitting a half-wired tree: a generated app that boots
 * but silently drops a step is worse than one that never got written.
 */

import type { PlanProblem } from './validate.js';

export class TsVercelPlanError extends Error {
  readonly problems: readonly PlanProblem[];

  constructor(problems: readonly PlanProblem[]) {
    const lines = problems.map(
      (problem) => `  - ${problem.code} at ${problem.path}: ${problem.message}`,
    );
    super(`cannot emit ts-vercel from this IR:\n${lines.join('\n')}`);
    this.name = 'TsVercelPlanError';
    this.problems = [...problems];
  }
}
