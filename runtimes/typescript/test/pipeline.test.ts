/**
 * The pipeline engine: an immutable context threaded through named async steps.
 *
 * The ceiling this module accepts is part of the contract, so what is asserted here is
 * exactly that ceiling: sequential, no branching, no retries, and an early exit that is a
 * *success* rather than a failure.
 */

import { describe, expect, it } from 'vitest';

import { Pipeline, PipelineContext, PipelineError, STEPS_KEY, StopPipeline } from '../src/index.js';
import { at, failure } from './support.js';

describe('PipelineContext', () => {
  it('starts empty, or with the values it is given', () => {
    expect(new PipelineContext().values).toEqual({});
    expect(new PipelineContext({ a: 1 }).values).toEqual({ a: 1 });
  });

  it('reads a key, and falls back when it is absent', () => {
    const context = new PipelineContext({ a: 1 });
    expect(context.get('a')).toBe(1);
    expect(context.get('absent')).toBeUndefined();
    expect(context.get('absent', 'fallback')).toBe('fallback');
  });

  it('falls back only when the key is absent, not when it holds undefined', () => {
    const context = new PipelineContext({ a: undefined });
    // `get` is a dictionary lookup, as in the reference runtime: a present key wins.
    expect(context.get('a', 'fallback')).toBeUndefined();
    expect(context.get('absent', 'fallback')).toBe('fallback');
  });

  it('requires a present key, naming the one that is missing', () => {
    const context = new PipelineContext({ a: 1 });
    expect(context.require('a')).toBe(1);
    expect(() => context.require('missing')).toThrow(PipelineError);
    expect(() => context.require('missing')).toThrow(/missing/);
  });

  it('merges without mutating the original', () => {
    const original = new PipelineContext({ a: 1 });
    const merged = original.withValues({ b: 2 });

    expect(merged.values).toEqual({ a: 1, b: 2 });
    expect(original.values).toEqual({ a: 1 });
  });

  it('drops named keys without mutating the original', () => {
    const original = new PipelineContext({ a: 1, b: 2 });
    const trimmed = original.without('a');

    expect(trimmed.values).toEqual({ b: 2 });
    expect(original.values).toEqual({ a: 1, b: 2 });
  });

  it('ignores a key it was asked to drop twice', () => {
    expect(new PipelineContext({ a: 1 }).without('absent', 'a').values).toEqual({});
  });
});

describe('Pipeline', () => {
  it('runs steps in order, threading the context', async () => {
    const seen: string[] = [];
    const pipeline = new Pipeline([
      [
        'first',
        (context) => {
          seen.push('first');
          return { total: context.get('total', 0) };
        },
      ],
      [
        'second',
        (context) => {
          seen.push('second');
          return { total: (context.require('total') as number) + 1 };
        },
      ],
    ]);

    const result = await pipeline.run({ total: 41 });

    expect(seen).toEqual(['first', 'second']);
    expect(result.get('total')).toBe(42);
  });

  it('records the steps that ran under the documented key', async () => {
    const pipeline = new Pipeline([
      ['a', () => ({})],
      ['b', () => ({})],
    ]);

    const result = await pipeline.run();
    expect(result.get(STEPS_KEY)).toEqual(['a', 'b']);
  });

  it('records nothing when step recording is disabled', async () => {
    const pipeline = new Pipeline([['a', () => ({})]], { recordSteps: false });
    expect((await pipeline.run()).get(STEPS_KEY)).toBeUndefined();
  });

  it('accepts a step that returns a full context', async () => {
    const pipeline = new Pipeline([['a', () => new PipelineContext({ done: true })]]);
    expect((await pipeline.run({ done: false })).get('done')).toBe(true);
  });

  it('replaces the context wholesale with the record a step returns', async () => {
    const pipeline = new Pipeline([
      ['first', () => ({ kept: 'yes', dropped: 'also yes' })],
      ['second', () => ({ kept: 'still yes' })],
    ]);

    // This matches the reference runtime: a returned mapping becomes the new context, so
    // a step that wants to preserve earlier values re-spreads them.
    const result = await pipeline.run({ initial: 'gone' });
    expect(result.values).toMatchObject({ kept: 'still yes' });
    expect(result.get('initial')).toBeUndefined();
    expect(result.get('dropped')).toBeUndefined();
  });

  it('treats a step that returns nothing as an empty context', async () => {
    const pipeline = new Pipeline([
      ['noop', () => undefined],
      ['null-op', () => null],
    ]);

    expect((await pipeline.run({ kept: 'yes' })).values).toEqual({ steps: ['noop', 'null-op'] });
  });

  it('starts from an empty context when run with nothing', async () => {
    const result = await new Pipeline([['a', () => ({ seen: 'yes' })]]).run();
    expect(result.get('seen')).toBe('yes');
  });

  it('starts from a plain record or a context', async () => {
    const identity = new Pipeline([['noop', (context) => context]]);
    // The identity step hands the same context back, so the step log accumulates on it.
    expect((await identity.run({ a: 1 })).values).toEqual({ a: 1, steps: ['noop'] });
    expect((await identity.run(null)).values).toEqual({ steps: ['noop'] });
    expect((await identity.run(new PipelineContext({ a: 1 }))).values).toEqual({
      a: 1,
      steps: ['noop'],
    });
    expect((await identity.run()).values).toEqual({ steps: ['noop'] });
  });

  it('refuses a pipeline with no steps', () => {
    expect(() => new Pipeline([])).toThrow(/a pipeline needs at least one step/);
  });

  it('refuses a duplicate step name', () => {
    expect(
      () =>
        new Pipeline([
          ['same', () => ({})],
          ['same', () => ({})],
        ]),
    ).toThrow(/duplicate step name 'same'/);
  });

  it('refuses a step that returns something no context can be made from', async () => {
    const pipeline = new Pipeline([
      [
        'bad',
        () => {
          // biome-ignore lint/suspicious/noExplicitAny: deliberately violating the contract
          return 42 as any;
        },
      ],
    ]);

    await expect(pipeline.run()).rejects.toThrow(
      /must return a PipelineContext, a mapping or None/,
    );
  });

  it('ends early and successfully on StopPipeline, keeping the work done so far', async () => {
    const reached: string[] = [];
    const pipeline = new Pipeline([
      [
        'first',
        () => {
          reached.push('first');
          return { kept: 'yes' };
        },
      ],
      [
        'guard',
        () => {
          reached.push('guard');
          throw new StopPipeline('nothing left to do');
        },
      ],
      [
        'never',
        () => {
          reached.push('never');
          return {};
        },
      ],
    ]);

    const result = await pipeline.run();

    expect(reached).toEqual(['first', 'guard']);
    expect(result.get('kept')).toBe('yes');
    // The stopping step ran, so it is recorded as having run.
    expect(result.get(STEPS_KEY)).toEqual(['first', 'guard']);
  });

  it('stops even when the reason is omitted', async () => {
    const pipeline = new Pipeline([
      ['guard', () => Promise.reject(new StopPipeline())],
      ['never', () => ({ reached: true })],
    ]);

    expect((await pipeline.run()).get('reached')).toBeUndefined();
  });

  it('aborts on any other error, naming the step and the real cause', async () => {
    const pipeline = new Pipeline([
      ['a', () => ({})],
      [
        'explode',
        () => {
          throw new TypeError('kaboom');
        },
      ],
      ['never', () => ({})],
    ]);

    const error = await failure(pipeline.run());

    expect(error).toBeInstanceOf(PipelineError);
    expect(error.message).toBe("step 'explode' failed: kaboom");
    expect(error.name).toBe('PipelineError');
  });

  it('propagates a thrown non-Error without losing the run', async () => {
    const pipeline = new Pipeline([
      [
        'weird',
        () => {
          // Throwing a non-Error is the case under test, not an accident; Biome has no
          // rule against it, so no suppression is needed.
          throw 'a bare string';
        },
      ],
    ]);

    await expect(pipeline.run()).rejects.toThrow(/step 'weird' failed: a bare string/);
  });

  it('awaits an async step', async () => {
    const pipeline = new Pipeline([
      [
        'slow',
        async () => {
          await Promise.resolve();
          return { ready: true };
        },
      ],
    ]);

    expect((await pipeline.run()).get('ready')).toBe(true);
  });

  it('exposes its step names in order', () => {
    const pipeline = new Pipeline([
      ['b', () => ({})],
      ['a', () => ({})],
    ]);

    expect(pipeline.stepNames).toEqual(['b', 'a']);
  });

  it('appends a step into a new pipeline, leaving the original alone', async () => {
    const base = new Pipeline([['a', (context) => ({ ...context.values, a: true })]]);
    const extended = base.add('b', (context) => ({ ...context.values, b: true }));

    expect(base.stepNames).toEqual(['a']);
    expect(extended.stepNames).toEqual(['a', 'b']);
    expect((await extended.run()).values).toMatchObject({ a: true, b: true });
    expect((await base.run()).get('b')).toBeUndefined();
  });

  it('keeps the options of the pipeline it was derived from', async () => {
    const extended = new Pipeline([['a', () => ({})]], { recordSteps: false }).add('b', () => ({}));
    expect((await extended.run()).get(STEPS_KEY)).toBeUndefined();
  });

  it('builds from bare callables, naming each by its function', async () => {
    function first(): Record<string, unknown> {
      return { first: true };
    }
    const pipeline = Pipeline.of(first, () => ({ second: true }));

    expect(at(pipeline.stepNames, 0)).toBe('first');
    expect((await pipeline.run()).get('second')).toBe(true);
  });

  it('is not thenable, so awaiting a pipeline does not run it', () => {
    // `then` would make `await pipeline` call a step with (resolve, reject).
    const pipeline = new Pipeline([['a', () => ({})]]);
    expect((pipeline as unknown as Record<string, unknown>).then).toBeUndefined();
  });
});
