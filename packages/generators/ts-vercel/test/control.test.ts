/**
 * `generated/control.ts`: the values a pipeline run starts from.
 *
 * The module exists because a composite reads its limiter and its principal out of the
 * *context* rather than off an option: `branch`, `parallel`, `map` and `reduce` all call
 * `limiterFor(context)` and `branch` evaluates its `when` against `PRINCIPAL_KEY`, so a
 * route that ran `pipeline.run({ event })` would raise a configuration error the moment a
 * spec used any composite. Emitting the seeding once, in one module, is what keeps every
 * route from having to remember it.
 *
 * Every block ends with something shown to fail; a block that cannot fail is not a check.
 */

import { describe, expect, it } from 'vitest';

import { concurrencyLimit, controlModule, emitControl } from '../src/emit/control.js';
import { paths } from '../src/emit/file.js';
import { checkPlan } from '../src/index.js';
import { buildForSpecText, example } from './helpers.js';

/** A spec whose only interesting part is its `deployments` block. */
function specWithDeployments(deployments: string): string {
  return `specVersion: "0.2"

project:
  name: demo
  namespace: aid.demo
  targets:
    - ts-vercel

deployments:
${deployments}
`;
}

/** A spec with two deployments, so `Math.min` and the refusals both have something to read. */
function deployedIR(): ReturnType<typeof example>['ir'] {
  return buildForSpecText(
    specWithDeployments(`  wide:
    target: container
    concurrency: 8
    secrets: []
  narrow:
    target: container
    concurrency: 3
    secrets: []
`),
  ).ir;
}

/**
 * The IR with `mutate` applied to the `narrow` deployment.
 *
 * The refusals below are pinned against the IR rather than against spec text because the
 * spec layer rejects `concurrency: 0` first, and `streaming` is a field the spec layer
 * accepts. `checkDeployments` takes an IR and an IR can be authored as JSON without ever
 * passing through a spec, so the plan-layer refusal is the one that has to hold on its own.
 */
function mutatedDeployment(mutate: (deployment: Record<string, unknown>) => void) {
  const ir = structuredClone(deployedIR());
  // By id, not by position: the IR orders deployments itself, so an index here would
  // silently mutate a different deployment than the assertions name.
  const deployment = ir.deployments.find((candidate) => candidate.id === 'narrow');
  if (deployment === undefined) throw new Error('the spec produced no narrow deployment');
  mutate(deployment as unknown as Record<string, unknown>);
  return ir;
}

describe('the concurrency cap', () => {
  it('is one when the spec declares no deployment', () => {
    // The smallest cap any deployment declares, and one when none does: a composite must
    // still be given a limiter, and one is the only bound that assumes nothing about the
    // platform the spec never named.
    expect(example().ir.deployments).toEqual([]);
    expect(concurrencyLimit(example().ir)).toBe(1);
  });

  it('is the smallest declared cap, not the first', () => {
    // `Math.min`, not `[0]`: a spec may deploy to two platforms with different caps, and
    // the emitted fan-out has to stay inside the narrowest one. A first-wins bug would
    // pass a single-deployment test, so this one declares two, narrowest last.
    expect(concurrencyLimit(deployedIR())).toBe(3);
  });

  it('refuses a cap below one, which would deadlock the limiter', () => {
    // `ConcurrencyLimiter(0)` acquires a slot that is never released, so the first
    // composite would hang rather than fail. The refusal is a plan problem, which is the
    // only place it can be caught: the emitted module cannot test its own constant.
    const ir = mutatedDeployment((deployment) => {
      deployment.concurrency = 0;
    });

    const problems = checkPlan(ir);
    expect(problems.map((problem) => problem.code)).toContain('deployment-unsupported');
    expect(problems.find((problem) => problem.code === 'deployment-unsupported')?.path).toBe(
      'deployments.narrow.concurrency',
    );
  });

  it('refuses streaming, which the emitted route cannot honour', () => {
    // The route answers with one buffered body, so accepting `streaming: true` would emit
    // an app whose deployment declaration is a lie about how it responds.
    const ir = mutatedDeployment((deployment) => {
      deployment.streaming = true;
    });

    const problems = checkPlan(ir);
    expect(problems.map((problem) => problem.code)).toContain('deployment-unsupported');
    expect(
      problems.find((problem) => problem.code === 'deployment-unsupported')?.message,
    ).toContain('streaming');
  });

  it('accepts both deployments of a well-formed spec, so the refusals are not blanket', () => {
    // Without this, a check that refused every deployment would make the two above pass.
    expect(checkPlan(deployedIR())).toEqual([]);
  });
});

describe('the emitted module', () => {
  it('is the plan, at the path the manifest records', () => {
    const file = emitControl(example().ir);
    expect(file.path).toBe(paths.control);
    expect(file.content).toBe(controlModule(example().ir));
  });

  it('seeds the limiter and the principal, which is the whole reason it exists', () => {
    // Both keys, by name from the runtime rather than by string literal: the emitted code
    // has to agree with what `limiterFor` and `branch` read, and a rename in the runtime
    // has to break this module rather than silently seed nothing.
    const module = controlModule(example().ir);
    expect(module).toContain('LIMITER_KEY');
    expect(module).toContain('PRINCIPAL_KEY');
    expect(module).toContain('new ConcurrencyLimiter(CONCURRENCY_LIMIT)');
    expect(module).toContain(
      "import { ConcurrencyLimiter, LIMITER_KEY, PRINCIPAL_KEY, Principal } from '@aid/runtime';",
    );
  });

  it('carries the declared cap into the constant the limiter is built from', () => {
    const { ir } = buildForSpecText(
      specWithDeployments(`  api:
    target: container
    concurrency: 6
    secrets: []
`),
    );
    const module = controlModule(ir);
    expect(module).toContain('export const CONCURRENCY_LIMIT = 6;');
    // The cap is the only thing a deployment contributes to code, so a module that
    // declared the constant and did not use it would make the whole collection inert.
    expect(module).toContain('new ConcurrencyLimiter(CONCURRENCY_LIMIT)');
  });
});
