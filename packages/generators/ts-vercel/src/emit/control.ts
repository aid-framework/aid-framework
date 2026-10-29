/**
 * `generated/control.ts`.
 *
 * Emitted for every plan, because every emitted route seeds its pipeline from it: the
 * values here are what a run starts from, and a route that skipped them would run
 * differently from one that did. Only the composite steps depend on the two constants,
 * but the seeding is uniform so there is one code path rather than two.
 *
 * The split matters and is not cosmetic. The runtime's `branch`/`parallel`/`map`/
 * `reduce` take their concurrency limiter from the *context*, not from an option: each
 * one calls `limiterFor(context, …)`, which reads `LIMITER_KEY` and refuses to run when
 * it does not hold a `ConcurrencyLimiter`. So the cap is not something a step can pass
 * down — it has to be seeded into the `PipelineContext` before the first step runs,
 * which is why it lands here rather than in a step module. `deps.ts` cannot hold it
 * either: `Deps` is what a step reaches for, and by the time a step runs the composite
 * has already read the context.
 *
 * The principal is seeded for the same reason and one more: `branch`'s `when` is
 * evaluated against the principal and nothing else, and an app with no auth layer has
 * no other source for one. `Principal`'s defaults are the anonymous-but-authenticated
 * caller, so `isAuthenticated()` is true and both role and scope sets are empty — a
 * predicate is answered rather than left undefined.
 */

import type { IR } from '@aid/ir';
import { type EmittedFile, generated, paths } from './file.js';
import { importStatement, moduleText } from './text.js';

/**
 * The smallest `concurrency` any declared deployment asks for.
 *
 * The spec layer refuses a composite step in a document that declares no
 * `deployments.concurrency`, so a pipeline that reaches this emitter always has one to
 * read. The *smallest* wins rather than the first or the largest: a deployment is a
 * capacity promise, and a fan-out that drew from a larger one would run wider than the
 * narrowest platform that hosts the same app.
 */
export function concurrencyLimit(ir: IR): number {
  const declared = ir.deployments
    .map((deployment) => deployment.concurrency)
    .filter((value): value is number => value !== undefined);
  return declared.length === 0 ? 1 : Math.min(...declared);
}

/** The module body. */
export function controlModule(ir: IR): string {
  const imports = importStatement('@aid/runtime', [
    { name: 'ConcurrencyLimiter', type: false },
    { name: 'LIMITER_KEY', type: false },
    { name: 'PipelineContext', type: true },
    { name: 'PRINCIPAL_KEY', type: false },
    { name: 'Principal', type: false },
  ]);
  const limit = [
    '/**',
    ' * The smallest `concurrency` any deployment in this spec declares.',
    ' *',
    ' * Every composite step draws its fan-out from this one cap, so `parallel`, `map` and',
    ' * `reduce` cannot between them run wider than the narrowest platform the app runs on.',
    ' */',
    `export const CONCURRENCY_LIMIT = ${concurrencyLimit(ir)};`,
  ].join('\n');
  const principal = [
    '/**',
    ' * The caller a request runs as.',
    ' *',
    " * There is no auth layer, so the principal is `Principal`'s default: authenticated,",
    ' * with no roles and no scopes. A `branch` predicate is answered from this rather than',
    ' * left undefined, which is what makes `isAuthenticated()` true and `hasRole(...)`',
    ' * false instead of unanswered -- both are answers a spec may branch on.',
    ' */',
    'const PRINCIPAL = new Principal();',
    '',
    '/**',
    ' * The principal this run is seeded with.',
    ' *',
    ' * An `agent` step passes this to the agent loop, so an agent sees the same caller the',
    ' * pipeline around it branched on: its guardrails, its `humanInTheLoop` predicate and',
    ' * its memory key all price against one principal rather than two that happen to agree',
    ' * today. Falls back to the seeded default when a caller replaced the context, which is',
    ' * the same fallback the loop applies to an absent `principal`.',
    ' */',
    'export function principalOf(context: PipelineContext): Principal {',
    '  const found = context.get(PRINCIPAL_KEY);',
    '  return found instanceof Principal ? found : PRINCIPAL;',
    '}',
  ].join('\n');
  const seeded = [
    '/**',
    ' * The values a pipeline run starts from.',
    ' *',
    ' * `event` is the request the route parsed. The other two are seeded here, before',
    " * `Pipeline.run`, because the runtime's composites read them from the context:",
    ' * `branch`/`parallel`/`map`/`reduce` raise a configuration error when `LIMITER_KEY`',
    ' * holds no limiter, and `branch` evaluates its `when` against `PRINCIPAL_KEY` and',
    ' * nothing else. Neither is an option a step can pass down.',
    ' */',
    'export function seeded(event: unknown): Record<string, unknown> {',
    '  return {',
    '    event,',
    '    [LIMITER_KEY]: new ConcurrencyLimiter(CONCURRENCY_LIMIT),',
    '    [PRINCIPAL_KEY]: PRINCIPAL,',
    '  };',
    '}',
  ].join('\n');
  return moduleText(imports, limit, principal, seeded);
}

/** `generated/control.ts`. */
export function emitControl(ir: IR): EmittedFile {
  return generated(paths.control, controlModule(ir));
}
