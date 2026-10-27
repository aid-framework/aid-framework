/**
 * `app/generated/control.py`: the bounds the generated app runs with.
 *
 * Two layers enforce the composite family's bounds and they cannot share a constant:
 * the spec gate is TypeScript and runs at build time, the step functions are Python and
 * run per request. So this module *emits* both numbers into the generated package
 * instead of letting the runtime carry a second hand-copied literal -- the same way the
 * generated eval emits its sample count. `control.test.ts` asserts the emitted
 * `MAX_STEP_DEPTH` equals the spec layer's, so a drift fails a test rather than letting
 * the build accept a pipeline the app would then refuse, or the reverse.
 *
 * The module itself only exists when the spec declares a composite step: an app with a
 * flat pipeline has no bound to read and should not carry a name for one.
 */

import type { IR, PipelineShape, StepShape } from '@aid/ir';
import { isCompositeStep, MAX_STEP_DEPTH } from '@aid/ir';

import { pythonNumber } from '../python.js';
import { assemble, HEADER, importFrom } from '../template.js';
import type { EmittedFile } from './file.js';
import { GENERATED_ROOT, generated } from './file.js';
import { pythonDoc } from './text.js';

export const CONTROL_PATH = `${GENERATED_ROOT}/control.py`;

/** The emitted name of the cap, for the modules that have to reference it. */
export const CONCURRENCY_LIMIT = 'CONCURRENCY_LIMIT';

/** The emitted name of the principal a generated route seeds when it has no auth layer. */
export const ANONYMOUS_PRINCIPAL = 'ANONYMOUS_PRINCIPAL';

/**
 * The context keys `aid_runtime.control` owns, spelled here so generated code can seed them.
 *
 * A generated app seeds its context by literal key, so a rename in the runtime would
 * otherwise quietly stop seeding anything at all -- the composite would fail at request
 * time with a missing key rather than at generation time. `control.test.ts` reads
 * `runtimes/python/src/aid_runtime/control.py` and asserts these match it, which is
 * the only mechanism that can hold across the language boundary.
 */
export const DEPTH_KEY = 'depth';
export const INDEX_KEY = 'index';
export const ITEM_KEY = 'item';
export const LIMITER_KEY = 'limiter';
export const PRINCIPAL_KEY = 'principal';
export const REDUCED_KEY = 'reduced';

/** Every key the control family owns, in the order the runtime declares them. */
export const RESERVED_KEYS: readonly string[] = [
  DEPTH_KEY,
  INDEX_KEY,
  ITEM_KEY,
  LIMITER_KEY,
  PRINCIPAL_KEY,
  REDUCED_KEY,
];

/**
 * The sub-steps a composite step owns.
 *
 * Every walker over step shapes -- the gates, the validator, the emitter, this module --
 * needs the same answer, so it is written once here rather than four times.
 */
export function childrenOf(step: StepShape): StepShape[] {
  if (step.kind === 'branch') return [...step.then, ...(step.else ?? [])];
  if (step.kind === 'parallel') return step.branches.flat();
  if (step.kind === 'map') return [step.step];
  return [];
}

/** Every step of these pipelines, depth first, composites included. */
export function everyStep(pipelines: readonly PipelineShape[]): StepShape[] {
  const steps: StepShape[] = [];
  const walk = (list: readonly StepShape[]): void => {
    for (const step of list) {
      steps.push(step);
      walk(childrenOf(step));
    }
  };
  for (const pipeline of pipelines) walk(pipeline.steps ?? []);
  return steps;
}

/** Whether these pipelines declare any composite step at all. */
export function hasComposite(pipelines: readonly PipelineShape[]): boolean {
  return everyStep(pipelines).some((step) => isCompositeStep(step));
}

/** Whether any step fans out, which is what makes a concurrency cap mandatory. */
export function hasFanOut(pipelines: readonly PipelineShape[]): boolean {
  return everyStep(pipelines).some(
    (step) => step.kind === 'parallel' || step.kind === 'map' || step.kind === 'reduce',
  );
}

/**
 * Whether any step branches on the caller's principal.
 *
 * A route seeds a principal only when something reads it, so an app that never branches
 * does not carry the seeding -- and, more importantly, so the seeding exists exactly
 * where its default would otherwise decide an authorization question.
 */
export function hasBranch(pipelines: readonly PipelineShape[]): boolean {
  return everyStep(pipelines).some((step) => step.kind === 'branch');
}

/**
 * The one cap, or `undefined` when no deployment declares one.
 *
 * The smallest declared `concurrency` is the effective cap, so a deployment cannot widen
 * another's bound: the app holds one limiter and one number has to describe it.
 */
export function concurrencyCap(ir: IR): number | undefined {
  const declared = ir.deployments
    .map((deployment) => deployment.concurrency)
    .filter((value): value is number => value !== undefined);
  return declared.length === 0 ? undefined : Math.min(...declared);
}

export function emitControl(ir: IR): EmittedFile {
  const cap = concurrencyCap(ir);
  const lines: string[] = [
    '#: Deepest composite nesting the build accepted. The spec gate refuses a deeper',
    '#: pipeline before generation, so this is the bound the app was built against rather',
    '#: than a second copy of it; `aid_runtime.control` keeps its own default for a',
    '#: hand-written pipeline.',
    `MAX_STEP_DEPTH = ${pythonNumber(MAX_STEP_DEPTH)}`,
  ];
  if (hasFanOut(ir.pipelines)) {
    lines.push(
      '',
      '#: The cap every fan-out draws from: the smallest `concurrency` any deployment',
      '#: declares, so no single deployment can widen the bound the others run under.',
      ...(cap === undefined
        ? ['#: No deployment declared one; the spec gate rejects a fan-out before this point.']
        : [`CONCURRENCY_LIMIT = ${pythonNumber(cap)}`]),
    );
  }
  if (hasBranch(ir.pipelines)) {
    lines.push(
      '',
      '#: Who a `branch` is evaluated for. A generated app has no auth layer of its own,',
      '#: so the caller is anonymous *and unauthenticated*: `isAuthenticated()` is false,',
      '#: which is the closed answer. A default `Principal()` would be authenticated, so',
      '#: every auth-shaped predicate would take its `then` arm for everyone.',
      'ANONYMOUS_PRINCIPAL = Principal(authenticated=False)',
    );
  }
  return generated(
    CONTROL_PATH,
    assemble([
      HEADER,
      pythonDoc('Bounds the generated app takes from the spec. Do not edit.'),
      hasBranch(ir.pipelines) ? importFrom('aid_runtime', ['Principal']) : undefined,
      lines.join('\n'),
    ]),
  );
}
