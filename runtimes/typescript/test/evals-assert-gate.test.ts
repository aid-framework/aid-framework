/**
 * The TypeScript mirror of `runtimes/python/tests/test_evals_assert_gate.py`.
 *
 * A false assertion fails the gate, and no regression allowance can excuse it. The
 * gate is a statistical comparison: it tolerates a mean drop smaller than
 * `maxRegression`, and larger drops when the run's own spread explains them. An
 * `assert` metric scores 0 or 1, which is exactly the degenerate distribution that
 * machinery is weakest against. That is why an assert threshold carries an absolute
 * floor and why the floor is checked *before* the delta.
 */

import { describe, expect, it } from 'vitest';

import {
  AssertMetric,
  BaselineGate,
  Dataset,
  EvalBaseline,
  EvalCase,
  EvalRun,
  type GateResult,
  MetricBaseline,
  MetricRun,
  runEvaluation,
  Threshold,
} from '../src/index.js';

const DATASET = 'answers';
const VERSION = '1';

function run(...values: readonly number[]): EvalRun {
  return new EvalRun({
    dataset: DATASET,
    datasetVersion: VERSION,
    runs: values.length,
    metrics: [new MetricRun({ metric: 'assert', values })],
  });
}

function baseline(...values: readonly number[]): EvalBaseline {
  return new EvalBaseline({
    dataset: DATASET,
    datasetVersion: VERSION,
    model: 'fake-small-1',
    metrics: [MetricBaseline.fromValues('assert', values)],
  });
}

function gate(options: { maxRegression?: number; minMean?: number; alpha?: number }): BaselineGate {
  return new BaselineGate([new Threshold({ metric: 'assert', ...options })], { metrics: [] });
}

describe('the floor beats the allowance', () => {
  it('fails a false assertion even when the delta is within maxRegression', () => {
    // One case of four fails: the mean drops by 0.25, which a 0.5 allowance would wave
    // through. The floor is what makes the assertion mean anything.
    const result = gate({ maxRegression: 0.5, minMean: 1 }).evaluate(
      run(1, 1, 1, 0),
      baseline(1, 1, 1, 1),
    );
    expect(result.passed).toBe(false);
    expect(result.results[0]?.metric).toBe('assert');
  });

  it('says floor and not regression', () => {
    const result = gate({ maxRegression: 0.5, minMean: 1 }).evaluate(
      run(1, 1, 1, 0),
      baseline(1, 1, 1, 1),
    );
    const rationale = result.results[0]?.rationale ?? '';
    expect(rationale).toContain('absolute floor');
    expect(rationale).not.toContain('maxRegression');
  });

  it('fails a false assertion even when noise would explain the drop', () => {
    // A 0/1 metric on a small sample has a standard error wide enough that the z-test
    // alone cannot call this a regression. The floor does not care.
    const result = gate({ maxRegression: 1, minMean: 1, alpha: 0.05 }).evaluate(
      run(1, 0, 1),
      baseline(1, 1, 1),
    );
    expect(result.passed).toBe(false);
    expect(result.results[0]?.rationale).toContain('absolute floor');
  });

  it('passes when every case passes', () => {
    const result = gate({ maxRegression: 0.05, minMean: 1 }).evaluate(
      run(1, 1, 1, 1),
      baseline(1, 1, 1, 1),
    );
    expect(result.passed).toBe(true);
    expect(result.results[0]?.currentMean).toBe(1);
  });

  it('refuses a baseline that was itself below the floor', () => {
    // The floor is absolute, not relative to what was accepted last time.
    const result = gate({ maxRegression: 0.05, minMean: 1 }).evaluate(
      run(1, 1, 0),
      baseline(0, 1, 1),
    );
    expect(result.passed).toBe(false);
  });

  it('passes the same run once the floor is removed', () => {
    // The distinguishing row: identical distributions, floor removed. If this passed
    // too the floor would be inert, and the first test would be passing for some other
    // reason.
    const result = gate({ maxRegression: 0.5 }).evaluate(run(1, 1, 1, 0), baseline(1, 1, 1, 1));
    expect(result.passed).toBe(true);
  });

  it('validates the floor to the unit interval', () => {
    expect(() => new Threshold({ metric: 'assert', minMean: 1.5 })).toThrow();
  });
});

const PREDICATE = {
  kind: 'call',
  name: 'contains',
  args: [
    { kind: 'path', path: 'prediction' },
    { kind: 'string', value: 'refund' },
  ],
} as const;
const MESSAGE = 'must mention the refund';

function scoreDataset(): Dataset {
  return new Dataset({
    name: 'answers',
    version: '1',
    cases: [
      new EvalCase({ id: 'a', input: 'one', expected: 'a refund is on the way' }),
      new EvalCase({ id: 'b', input: 'two', expected: 'we cannot help' }),
    ],
  });
}

async function score(replies: Readonly<Record<string, string>>): Promise<EvalRun> {
  return await runEvaluation(
    scoreDataset(),
    async (entry) => replies[entry.id] ?? '',
    [new AssertMetric({ expr: PREDICATE, message: MESSAGE })],
    { runs: 1 },
  );
}

function passingBaseline(): EvalBaseline {
  return new EvalBaseline({
    dataset: 'answers',
    datasetVersion: '1',
    model: 'fake-small-1',
    metrics: [MetricBaseline.fromValues('assert', [1, 1])],
  });
}

/** What the generated module's entrypoint returns for this verdict. */
function exitCode(result: GateResult): number {
  return result.failures().length > 0 ? 1 : 0;
}

describe('a false assertion reaches the exit code', () => {
  // From the real metric to the process exit, not just to a verdict field.
  // `MetricResult.passed === false` is necessary and not sufficient: the phase exit
  // criterion is a non-zero exit from the generated eval module. These rows run the real
  // `AssertMetric` over a real dataset through `runEvaluation` and then through the
  // gate, and read the same `failures()` the generated entrypoint reads.

  it('exits non-zero for a false assertion against a passing baseline', async () => {
    const measured = await score({ a: 'a refund is on the way', b: 'we cannot help' });
    const gate = new BaselineGate(
      [new Threshold({ metric: 'assert', maxRegression: 0.05, minMean: 1 })],
      { metrics: [] },
    );

    const result = gate.evaluate(measured, passingBaseline());

    expect(result.passed).toBe(false);
    expect(exitCode(result)).toBe(1);
  });

  it('exits zero when every case passes', async () => {
    const measured = await score({
      a: 'a refund is on the way',
      b: 'we cannot help, no refund possible',
    });
    const gate = new BaselineGate(
      [new Threshold({ metric: 'assert', maxRegression: 0.05, minMean: 1 })],
      { metrics: [] },
    );

    const result = gate.evaluate(measured, passingBaseline());

    // The distinguishing row: the same wiring with a predicate that holds. Without it
    // the non-zero exit above could be produced by something other than the assertion.
    expect(result.passed).toBe(true);
    expect(exitCode(result)).toBe(0);
  });

  it('carries the declared message as the failure detail', async () => {
    const measured = await score({ a: 'a refund is on the way', b: 'we cannot help' });
    const missed = await new AssertMetric({ expr: PREDICATE, message: MESSAGE }).score(
      scoreDataset().case('b'),
      'we cannot help',
    );

    expect(measured.metrics[0]?.values).toEqual([0.5]);
    expect(missed.score).toBe(0);
    expect(missed.detail).toBe(MESSAGE);
  });
});
