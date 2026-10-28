/**
 * Composite pipeline steps: `branch`, `parallel`, `map` and `reduce`.
 *
 * {@link Pipeline} is a sequential reducer, and it stays one. Each factory here returns
 * an ordinary {@link Step}, so a composite composes with the flat steps by the same rule
 * and replays unchanged on the streaming route, which inlines the pipeline instead of
 * driving it step by step.
 *
 * Six context keys are reserved for the family, and no step may bind a name equal to one
 * of them: `principal`, `limiter`, `item`, `index`, `depth` and `reduced`. The first
 * two are seeded by the application, the rest are written and removed by the composites
 * themselves, so an inner step can read `item` without a matching binding leaking to a
 * later sibling.
 *
 * Two bounds are enforced here and both fail the run rather than degrade it:
 *
 * - nesting, at {@link MAX_STEP_DEPTH}. The spec layer rejects a deeper pipeline before
 *   generation, so reaching this bound at run time means a hand-built pipeline, and the
 *   reason is named in the error.
 * - concurrency, through the application's one {@link ConcurrencyLimiter}. A fan-out
 *   with no limiter in the context raises rather than running unbounded, because the cap
 *   is what makes a fan-out safe and its absence is a wiring bug.
 *
 * This file mirrors `aid_runtime/control.py`.
 */

import { ConcurrencyLimiter, holdsSlot } from './concurrency.js';
import { PipelineError } from './errors.js';
import { repr } from './internal/json.js';
import { type Pipeline, type PipelineContext, STEPS_KEY } from './pipeline.js';
import { evaluatePolicy, type PolicyNode, Principal, policySource } from './policy.js';

/**
 * Deepest composite nesting a pipeline may declare.
 *
 * The spec layer owns this number and the generator *emits* it into the generated
 * package, so a generated app passes its own build's value; this default is what a
 * hand-written pipeline gets. A test reads the spec constant and holds the two
 * together, so a drift fails instead of diverging silently.
 */
export const MAX_STEP_DEPTH = 4;

/** Who the caller is, for `branch`. Seeded by the route. */
export const PRINCIPAL_KEY = 'principal';
/** The application's single limiter, from `deployments.concurrency`. */
export const LIMITER_KEY = 'limiter';
/** The current item and its position, written by `map`/`reduce` for one iteration. */
export const ITEM_KEY = 'item';
export const INDEX_KEY = 'index';
/** How many composites deep the current step is. */
export const DEPTH_KEY = 'depth';
/**
 * The binding `reduce` collects from each iteration. Reserved so a reduce body's own
 * binding cannot collide with the name the composite reads.
 */
export const REDUCED_KEY = 'reduced';

/** Names a composite owns. A spec binding equal to one of them is refused upstream. */
export const RESERVED_KEYS: ReadonlySet<string> = new Set([
  PRINCIPAL_KEY,
  LIMITER_KEY,
  ITEM_KEY,
  INDEX_KEY,
  DEPTH_KEY,
  REDUCED_KEY,
]);

/** A composite: always async, so `await step(context)` is well-typed. */
export type CompositeStep = (context: PipelineContext) => Promise<PipelineContext>;

type NewValues = Record<string, unknown>;
type Outcome = readonly [PipelineContext, NewValues];

/**
 * Name a composite's callable, so a trace and `Pipeline.of` identify it.
 *
 * `Pipeline` names a step by the callable's `name` and refuses two steps with the same
 * name, so a pipeline holding two `branch` composites must give them distinct names. The
 * generator passes one; the default is the kind.
 */
function named(step: CompositeStep, name: string | undefined): CompositeStep {
  if (name !== undefined) {
    Object.defineProperty(step, 'name', { value: name, configurable: true });
  }
  return step;
}

function depthOf(context: PipelineContext): number {
  const value = context.get(DEPTH_KEY, 0);
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0;
}

/** The context a nested step list runs in, or a named refusal past the bound. */
function enter(context: PipelineContext, maxDepth: number, where: string): PipelineContext {
  const depth = depthOf(context);
  if (depth >= maxDepth) {
    throw new PipelineError(
      `composite step ${where} is nested deeper than ${maxDepth} levels; ` +
        'nesting is bounded so a self-similar spec cannot recurse without end',
    );
  }
  return context.withValues({ [DEPTH_KEY]: depth + 1 });
}

function limiterFor(context: PipelineContext, where: string): ConcurrencyLimiter {
  const limiter = context.get(LIMITER_KEY);
  if (!(limiter instanceof ConcurrencyLimiter)) {
    throw new PipelineError(
      `step ${where} fans out but the pipeline context has no concurrency limiter; ` +
        'declare `concurrency` under a deployment in the spec so the generator seeds one',
    );
  }
  return limiter;
}

/** Drop the iteration keys, so nothing a composite added reaches a later sibling. */
function escapeIteration(context: PipelineContext): PipelineContext {
  return context.without(DEPTH_KEY, ITEM_KEY, INDEX_KEY, REDUCED_KEY);
}

/**
 * Run one iteration and return its context with only the bindings it added.
 *
 * Only the added names come back, so a composite hands its siblings the bindings the
 * spec declared and nothing else. The inner run records its own `steps`; it is excluded
 * here because the outer `Pipeline.run` writes that key itself when the composite
 * returns, and an inner list would otherwise be read as a binding.
 */
async function runBody(body: Pipeline, context: PipelineContext): Promise<Outcome> {
  const result = await body.run(context);
  const added: NewValues = {};
  for (const [key, value] of Object.entries(result.values)) {
    if (!Object.hasOwn(context.values, key) && !RESERVED_KEYS.has(key) && key !== STEPS_KEY) {
      added[key] = value;
    }
  }
  return [result, added] as const;
}

/**
 * Run every worker, in the order given, whatever order they finish in.
 *
 * `Promise.allSettled` returns results positionally, so the caller's ordering rule is
 * input order even when the last worker finishes first.
 *
 * A worker inside a slot this context already holds runs its siblings one at a time
 * instead of acquiring a second slot: the limiter is shared with the gateway and the
 * tool executor, so a worker that acquired again while its own body waited for the
 * gateway would deadlock at a cap of one. Serialising keeps the cap and cannot deadlock,
 * which is the trade this family makes at nesting depth two.
 */
async function fanOut(workers: ReadonlyArray<() => Promise<Outcome>>): Promise<Outcome[]> {
  if (holdsSlot()) {
    const serial: Outcome[] = [];
    for (const worker of workers) serial.push(await worker());
    return serial;
  }
  const settled = await Promise.allSettled(workers.map((worker) => worker()));
  // Every worker is awaited even after one fails, so nothing is left running and the
  // error that surfaces is the first in input order rather than the first to finish.
  for (const entry of settled) {
    if (entry.status === 'rejected') throw entry.reason;
  }
  return settled.map((entry) => (entry as PromiseFulfilledResult<Outcome>).value);
}

/**
 * Run `then` when the caller's principal satisfies `when`, else `otherwise`.
 *
 * `when` is a `PolicyExpr` AST, evaluated against the principal and nothing else: the
 * grammar has no operand for a context value, so a branch cannot read what an earlier
 * step produced. It is a plain mapping rather than a parsed object so the generated code
 * passes the AST the IR already carries, and {@link evaluatePolicy} stays the only
 * evaluator.
 *
 * No principal in the context is an error, not a false. Defaulting would decide an
 * authorization question for a caller nobody identified.
 */
export function branch(options: {
  readonly when: PolicyNode;
  readonly then: Pipeline;
  readonly otherwise?: Pipeline;
  readonly maxDepth?: number;
  readonly name?: string;
}): CompositeStep {
  const { when, then, otherwise, maxDepth = MAX_STEP_DEPTH, name } = options;

  // Named `_branch` by default, matching the reference runtime, so `steps` reads alike.
  const run = async function _branch(context: PipelineContext): Promise<PipelineContext> {
    const principal = context.get(PRINCIPAL_KEY);
    if (!(principal instanceof Principal)) {
      throw new PipelineError(
        `branch needs a principal in the pipeline context to evaluate ${repr(
          policySource(when),
        )}; none was seeded`,
      );
    }
    const nested = enter(context, maxDepth, `branch (${policySource(when)})`);
    const chosen = evaluatePolicy(when, principal) ? then : otherwise;
    if (chosen === undefined) {
      // No alternative declared: the branch binds nothing at all.
      return escapeIteration(context);
    }
    const [, added] = await runBody(chosen, nested);
    return escapeIteration(context.withValues(added));
  };

  return named(run, name);
}

/**
 * Run every arm concurrently under the shared cap, then merge what they bound.
 *
 * A failing arm fails the whole run: the results are inspected in input order and the
 * first failure is raised, so which error surfaces does not depend on which arm happened
 * to fail first. Two arms binding the same new name is an error rather than a silent
 * last-writer-wins, because the winning value would depend on completion order and the
 * ordering rule exists to remove that.
 */
export function parallel(options: {
  readonly branches: readonly Pipeline[];
  readonly maxDepth?: number;
  readonly name?: string;
}): CompositeStep {
  const { branches, maxDepth = MAX_STEP_DEPTH, name } = options;

  const run = async function _parallel(context: PipelineContext): Promise<PipelineContext> {
    if (branches.length === 0) return escapeIteration(context);
    const limiter = limiterFor(context, 'parallel');
    const nested = enter(context, maxDepth, 'parallel');

    const workers = branches.map(
      (arm) => (): Promise<Outcome> => limiter.run(() => runBody(arm, nested)),
    );
    const outcomes = await fanOut(workers);
    const merged: NewValues = {};
    for (const [, added] of outcomes) {
      for (const [key, value] of Object.entries(added)) {
        if (Object.hasOwn(merged, key)) {
          throw new PipelineError(
            `parallel arms both bind ${repr(key)}; a name may be bound by one arm`,
          );
        }
        merged[key] = value;
      }
    }
    return escapeIteration(context.withValues(merged));
  };

  return named(run, name);
}

/**
 * Run `step` once per item of `over`, binding the results in input order.
 *
 * `as` holds one mapping of the names the body bound for that item, so an item that
 * bound nothing contributes `{}` rather than vanishing: the list keeps the length of the
 * input. An empty or absent-over value binds an empty list.
 */
export function mapStep(options: {
  readonly over: string;
  readonly as: string;
  readonly step: Pipeline;
  readonly maxDepth?: number;
  readonly name?: string;
}): CompositeStep {
  const { over, as: as_, step, maxDepth = MAX_STEP_DEPTH, name } = options;

  const run = async function _map(context: PipelineContext): Promise<PipelineContext> {
    const items = itemsOf(context, over, 'map');
    const limiter = limiterFor(context, 'map');
    const nested = enter(context, maxDepth, `map over ${repr(over)}`);

    const workers = items.map((item, index) => (): Promise<Outcome> => {
      const iteration = nested.withValues({ [ITEM_KEY]: item, [INDEX_KEY]: index });
      return limiter.run(() => runBody(step, iteration));
    });
    const outcomes = await fanOut(workers);
    return escapeIteration(context.withValues({ [as_]: outcomes.map(([, added]) => added) }));
  };

  return named(run, name);
}

/**
 * Run `step` once per item of `over`, binding its {@link REDUCED_KEY} results.
 *
 * `step` is a one-step pipeline that renders the reduce prompt for one item and binds
 * `reduced`; the composite collects that binding into `as` in input order. Combining the
 * results is a following `generate` step, so this layer never invents a merge strategy.
 */
export function reduceStep(options: {
  readonly over: string;
  readonly as: string;
  readonly step: Pipeline;
  readonly maxDepth?: number;
  readonly name?: string;
}): CompositeStep {
  const { over, as: as_, step, maxDepth = MAX_STEP_DEPTH, name } = options;

  const run = async function _reduce(context: PipelineContext): Promise<PipelineContext> {
    const items = itemsOf(context, over, 'reduce');
    const limiter = limiterFor(context, 'reduce');
    const nested = enter(context, maxDepth, `reduce over ${repr(over)}`);

    const workers = items.map((item, index) => (): Promise<Outcome> => {
      const iteration = nested.withValues({ [ITEM_KEY]: item, [INDEX_KEY]: index });
      return limiter.run(async () => {
        const result = await step.run(iteration);
        if (!Object.hasOwn(result.values, REDUCED_KEY)) {
          throw new PipelineError(
            `reduce over ${repr(over)} produced no ${repr(REDUCED_KEY)} binding for item ${index}`,
          );
        }
        return [result, { [REDUCED_KEY]: result.require(REDUCED_KEY) }] as const;
      });
    });
    const outcomes = await fanOut(workers);
    return escapeIteration(
      context.withValues({ [as_]: outcomes.map(([, added]) => added[REDUCED_KEY]) }),
    );
  };

  return named(run, name);
}

/** The sequence a `map`/`reduce` iterates, refusing a missing or odd value. */
function itemsOf(context: PipelineContext, over: string, where: string): unknown[] {
  const value = context.require(over);
  if (!Array.isArray(value)) {
    throw new PipelineError(`${where} over ${repr(over)} needs a list, got ${typeName(value)}`);
  }
  return value;
}

/** The reference runtime's spelling of a type name, so both runtimes' errors read alike. */
function typeName(value: unknown): string {
  if (value === null) return 'NoneType';
  if (Array.isArray(value)) return 'list';
  if (typeof value === 'string') return 'str';
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float';
  if (typeof value === 'boolean') return 'bool';
  return 'dict';
}
