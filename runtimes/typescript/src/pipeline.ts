/**
 * A plain-async pipeline engine.
 *
 * This is the answer to "the loop". It is a sequential reducer over an immutable
 * context: each step receives the context and returns the context, optionally
 * enriched. No graph, no scheduler, no orchestration dependency.
 *
 * That is a deliberate ceiling. When branching, retries and human-in-the-loop
 * interrupts are real requirements an orchestration library is the right tool, but
 * adopting one before those requirements exist would place an unobservable graph
 * between the user and their own trace.
 */

import { PipelineError } from './errors.js';
import { repr } from './internal/json.js';
import { getTracer, recordException } from './tracing.js';

/** Context key under which {@link Pipeline.run} records the steps that ran, in order. */
export const STEPS_KEY = 'steps';

/** Thrown from a step to end the pipeline successfully and early. */
export class StopPipeline extends Error {
  readonly reason: string;

  constructor(reason = '') {
    super(reason || 'pipeline stopped');
    this.name = 'StopPipeline';
    this.reason = reason;
  }
}

/**
 * The value threaded through a pipeline.
 *
 * Immutable, so a step cannot mutate what an earlier step observed; it returns a new
 * context instead. That keeps a failed run's state inspectable and makes replaying a
 * pipeline reproducible.
 */
export class PipelineContext {
  readonly values: Readonly<Record<string, unknown>>;

  constructor(values: Readonly<Record<string, unknown>> = {}) {
    this.values = values;
  }

  get(key: string, fallback?: unknown): unknown {
    return Object.hasOwn(this.values, key) ? this.values[key] : fallback;
  }

  /** A value that must be present, or a {@link PipelineError} naming the key. */
  require(key: string): unknown {
    if (!Object.hasOwn(this.values, key)) {
      throw new PipelineError(`pipeline context has no ${repr(key)}`);
    }
    return this.values[key];
  }

  /** A new context with `values` merged over the current members. */
  withValues(values: Readonly<Record<string, unknown>>): PipelineContext {
    return new PipelineContext({ ...this.values, ...values });
  }

  /** A new context without the named keys. */
  without(...keys: readonly string[]): PipelineContext {
    const remaining: Record<string, unknown> = { ...this.values };
    for (const key of keys) delete remaining[key];
    return new PipelineContext(remaining);
  }
}

/**
 * What a step may produce: a new context, a record that *becomes* the new context, or
 * nothing for an empty one.
 *
 * A returned record replaces the context rather than merging into it, matching the
 * reference runtime: a step that wants to preserve earlier values re-spreads them.
 */
export type StepResult = PipelineContext | Record<string, unknown> | null | undefined;

/** A step: a callable from context to a step result. */
export type Step = (context: PipelineContext) => StepResult | Promise<StepResult>;

/** The shape of one pipeline entry. */
export type NamedStep = readonly [name: string, step: Step];

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asContext(value: unknown): PipelineContext {
  if (value instanceof PipelineContext) return value;
  if (value === null || value === undefined) return new PipelineContext();
  if (typeof value === 'object' && !Array.isArray(value)) {
    return new PipelineContext({ ...(value as Record<string, unknown>) });
  }
  throw new PipelineError(
    `a pipeline step must return a PipelineContext, a mapping or None, got ${
      value === null ? 'NoneType' : typeof value
    }`,
  );
}

/** Runs named steps in order, tracing each one. */
export class Pipeline {
  private readonly _steps: readonly NamedStep[];
  private readonly _tracerName: string;
  private readonly _recordSteps: boolean;

  constructor(
    steps: readonly NamedStep[],
    options: { readonly tracerName?: string; readonly recordSteps?: boolean } = {},
  ) {
    if (steps.length === 0) throw new PipelineError('a pipeline needs at least one step');
    const seen = new Set<string>();
    for (const [name] of steps) {
      if (seen.has(name)) throw new PipelineError(`duplicate step name ${repr(name)}`);
      seen.add(name);
    }
    this._steps = steps;
    this._tracerName = options.tracerName ?? 'aid_runtime';
    this._recordSteps = options.recordSteps ?? true;
  }

  get stepNames(): string[] {
    return this._steps.map(([name]) => name);
  }

  /** Build a pipeline from bare callables, naming each by its function. */
  static of(...steps: readonly Step[]): Pipeline {
    return new Pipeline(steps.map((step) => [step.name || 'anonymous', step] as const));
  }

  /**
   * A new pipeline with `step` appended. This instance is unchanged.
   *
   * Named `add` rather than Python's `then` because a `then` member makes the
   * object thenable: `await` on a Pipeline would invoke it with `(resolve,
   * reject)` and construct a nonsense step instead of leaving it alone.
   */
  add(name: string, step: Step): Pipeline {
    return new Pipeline([...this._steps, [name, step] as const], {
      tracerName: this._tracerName,
      recordSteps: this._recordSteps,
    });
  }

  /**
   * Execute every step, stopping early if one throws {@link StopPipeline}.
   *
   * A step that throws anything else aborts the run, and the original error's
   * message is carried into the {@link PipelineError} so the failure names both the
   * pipeline coordinate and the real cause.
   */
  async run(initial?: PipelineContext | Record<string, unknown> | null): Promise<PipelineContext> {
    let context = asContext(initial);
    const ran: string[] = [];
    const tracer = getTracer(this._tracerName);

    for (const [name, step] of this._steps) {
      const outcome = await tracer.startActiveSpan(
        `pipeline.${name}`,
        { attributes: { 'aid.pipeline.step': name } },
        async (
          span,
        ): Promise<
          | { readonly stopped: true }
          | { readonly stopped: false; readonly context: PipelineContext }
        > => {
          try {
            return { stopped: false, context: asContext(await step(context)) };
          } catch (error) {
            if (error instanceof StopPipeline) {
              if (error.reason.length > 0) {
                span.setAttribute('aid.pipeline.stop_reason', error.reason);
              }
              return { stopped: true };
            }
            recordException(span, error);
            throw new PipelineError(`step ${repr(name)} failed: ${messageOf(error)}`);
          }
        },
      );
      ran.push(name);
      if (outcome.stopped) return this.finish(context, ran);
      context = outcome.context;
    }

    return this.finish(context, ran);
  }

  private finish(context: PipelineContext, ran: readonly string[]): PipelineContext {
    return this._recordSteps ? context.withValues({ [STEPS_KEY]: [...ran] }) : context;
  }
}
