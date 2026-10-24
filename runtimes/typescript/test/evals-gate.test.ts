/**
 * The statistical baseline gate.
 *
 * These are the load-bearing assertions of the whole package: the gate is what turns
 * "the score dropped" into a CI verdict, and it does so with a specific one-sided z
 * test rather than by comparing means. The arithmetic is transcribed from
 * `aid_runtime.evals.gate`, so every expectation here is a property of the *math* and
 * not of a provider's random draws -- which is what lets the two runtimes share these
 * assertions even though their fake providers sample differently.
 */

import { describe, expect, it } from 'vitest';
import type { Metric } from '../src/index.js';
import {
  BaselineGate,
  EvalBaseline,
  EvalRun,
  ExactMatch,
  EvalError as FrameworkEvalError,
  GateConfigurationError,
  gateFromConfig,
  LlmJudge,
  MetricBaseline,
  MetricResult,
  MetricRun,
  metricNames,
  regressionZ,
  Threshold,
  zCritical,
} from '../src/index.js';

function sample(values: readonly number[], metric = 'exact-match'): MetricRun {
  return new MetricRun({ metric, values });
}

function run(values: readonly number[], options: { runs?: number } = {}): EvalRun {
  return new EvalRun({
    dataset: 'capitals',
    datasetVersion: '1.0.0',
    runs: options.runs ?? values.length,
    metrics: [sample(values)],
  });
}

function baseline(values: readonly number[], metric = 'exact-match'): EvalBaseline {
  return new EvalBaseline({
    dataset: 'capitals',
    datasetVersion: '1.0.0',
    model: 'fake-small-1',
    metrics: [MetricBaseline.fromValues(metric, values)],
  });
}

/** The z critical values, as tabulated. */
describe('zCritical', () => {
  it('returns the tabulated one-sided critical value at each level', () => {
    expect(zCritical(0.005)).toBe(2.5758);
    expect(zCritical(0.01)).toBe(2.3263);
    expect(zCritical(0.025)).toBe(1.96);
    expect(zCritical(0.05)).toBeCloseTo(1.6449, 4);
    expect(zCritical(0.1)).toBeCloseTo(1.2816, 4);
    expect(zCritical(0.2)).toBeCloseTo(0.8416, 4);
  });

  it('rounds an untabulated alpha to the next stricter level', () => {
    // "Largest tabulated level at or below alpha" means the gate always demands at
    // least the evidence asked for: 0.09 lands on 0.05's value, and just under a
    // tabulated level falls through to the stricter one, not the laxer one.
    expect(zCritical(0.05)).toBeCloseTo(1.6449, 4);
    expect(zCritical(0.0499)).toBe(1.96);
    expect(zCritical(0.09)).toBeCloseTo(1.6449, 4);
  });

  it('gives an alpha below the strictest level the strictest value', () => {
    expect(zCritical(0.0001)).toBe(2.5758);
  });

  it('refuses an alpha outside (0, 1)', () => {
    expect(() => zCritical(0)).toThrow(RangeError);
    expect(() => zCritical(1)).toThrow(/alpha must be between 0 and 1/);
    expect(() => zCritical(-0.1)).toThrow(/alpha must be between 0 and 1/);
  });
});

/** The one-sided z for "current is worse than baseline". */
describe('regressionZ', () => {
  const base = {
    currentMean: 0.5,
    currentStdev: 0.1,
    currentN: 5,
    baselineMean: 0.6,
    baselineStdev: 0.1,
    baselineN: 5,
  };

  it('is positive when the current mean is below the baseline', () => {
    expect(regressionZ(base)).toBeCloseTo(1.5811, 4);
  });

  it('is zero or negative when the current mean is not below the baseline', () => {
    expect(regressionZ({ ...base, currentMean: 0.6 })).toBe(0);
    expect(regressionZ({ ...base, currentMean: 0.7 })).toBeLessThan(0);
  });

  it('widens the standard error as either sample gets noisier', () => {
    const quiet = regressionZ({ ...base, currentStdev: 0.01, baselineStdev: 0.01 });
    expect(quiet).toBeGreaterThan(regressionZ(base));
  });

  it('treats a baseline with zero spread as the stronger claim', () => {
    // A perfectly reproducible baseline leaves only the current run's spread in the
    // denominator, so the same delta is much more significant.
    const sharp = regressionZ({ ...base, baselineStdev: 0, baselineN: 1 });
    expect(sharp).toBeGreaterThan(regressionZ(base));
  });

  it('reports an infinite z when both runs are perfectly flat and the mean dropped', () => {
    expect(
      regressionZ({
        currentMean: 0.5,
        currentStdev: 0,
        currentN: 1,
        baselineMean: 1.0,
        baselineStdev: 0,
        baselineN: 3,
      }),
    ).toBe(Number.POSITIVE_INFINITY);
  });

  it('reports zero when a flat current run did not drop', () => {
    expect(
      regressionZ({
        currentMean: 1.0,
        currentStdev: 0,
        currentN: 1,
        baselineMean: 1.0,
        baselineStdev: 0,
        baselineN: 1,
      }),
    ).toBe(0);
  });
});

describe('MetricBaseline.fromValues', () => {
  it('records the sample mean and the sample standard deviation', () => {
    const recorded = MetricBaseline.fromValues('exact-match', [0.5, 1.0, 1.0, 0.5]);

    expect(recorded.metric).toBe('exact-match');
    expect(recorded.runs).toBe(4);
    expect(recorded.mean).toBeCloseTo(0.75, 10);
    expect(recorded.stdev).toBeCloseTo(0.2887, 4);
  });

  it('records a zero spread for one value', () => {
    expect(MetricBaseline.fromValues('exact-match', [0.5]).stdev).toBe(0);
  });

  it('keeps the two statistics the gate needs and nothing else', () => {
    expect(MetricBaseline.fromValues('exact-match', [0.5, 1.0]).toJSON()).toEqual({
      metric: 'exact-match',
      runs: 2,
      mean: 0.75,
      stdev: 0.353553390593,
    });
  });
});

describe('EvalRun', () => {
  it('reports one mean and one spread per metric', () => {
    const sampled = new EvalRun({
      dataset: 'capitals',
      datasetVersion: '1.0.0',
      runs: 2,
      metrics: [sample([0.5, 1.0]), sample([1.0, 1.0], 'contains')],
    });

    expect(sampled.means()).toEqual({ 'exact-match': 0.75, contains: 1.0 });
    expect(sampled.spread()['exact-match']).toBeCloseTo(0.3536, 4);
    expect(sampled.isVarying()).toBe(true);
  });

  it('does not claim variation when every run agreed', () => {
    expect(run([1.0, 1.0, 1.0]).isVarying()).toBe(false);
  });

  it('refuses a metric it never recorded', () => {
    expect(() => run([1.0]).valuesFor('absent')).toThrow(/is not in this run/);
  });

  it('refuses a run with no metrics or no values', () => {
    expect(() => new EvalRun({ dataset: 'd', datasetVersion: '1', runs: 1, metrics: [] })).toThrow(
      /at least one metric/,
    );
    expect(() => new MetricRun({ metric: 'm', values: [] })).toThrow(/at least one value/);
  });
});

describe('BaselineGate', () => {
  it('passes a drop that is within max_regression', () => {
    const gate = new BaselineGate([new Threshold({ metric: 'exact-match', maxRegression: 0.2 })]);
    const decision = gate.evaluate(run([0.9, 0.9]), baseline([1.0, 1.0]));

    expect(decision.passed).toBe(true);
    expect(at(decision.results, 0).rationale).toContain('is within max_regression');
  });

  it('passes a material drop that run-to-run noise can explain', () => {
    // delta 0.1, z ~ 1.5811: beyond max_regression but not beyond 1.6449.
    const gate = new BaselineGate([new Threshold({ metric: 'exact-match', maxRegression: 0.0 })]);
    const decision = gate.evaluate(
      run([0.4, 0.6, 0.4, 0.6, 0.5]),
      baseline([0.5, 0.7, 0.5, 0.7, 0.6]),
    );

    const only = at(decision.results, 0);
    expect(only.delta).toBeCloseTo(0.1, 10);
    expect(only.z).toBeCloseTo(1.5811, 4);
    expect(decision.passed).toBe(true);
    expect(only.rationale).toContain('consistent with run-to-run noise');
  });

  it('inverts at a laxer alpha, which is the whole point of the alpha knob', () => {
    const values = () => run([0.4, 0.6, 0.4, 0.6, 0.5]);
    const stored = () => baseline([0.5, 0.7, 0.5, 0.7, 0.6]);
    const decide = (alpha: number) =>
      new BaselineGate([
        new Threshold({ metric: 'exact-match', maxRegression: 0, alpha }),
      ]).evaluate(values(), stored()).passed;

    expect(decide(0.025)).toBe(true);
    expect(decide(0.05)).toBe(true);
    // At alpha 0.1 the critical value falls to 1.2816, below the observed z.
    expect(decide(0.1)).toBe(false);
    expect(decide(0.2)).toBe(false);
  });

  it('fails a drop that is both material and beyond the noise threshold', () => {
    const gate = new BaselineGate([new Threshold({ metric: 'exact-match', maxRegression: 0.0 })]);
    const decision = gate.evaluate(run([0.6, 0.6, 0.6, 0.6, 0.6]), baseline([1.0, 1.0, 1.0]));

    expect(decision.passed).toBe(false);
    expect(at(decision.results, 0).z).toBe(Number.POSITIVE_INFINITY);
    expect(at(decision.results, 0).rationale).toContain('exceeds max_regression');
  });

  it('fails an absolute floor breach even when nothing dropped', () => {
    const gate = new BaselineGate([
      new Threshold({ metric: 'exact-match', minMean: 0.8, maxRegression: 0.5 }),
    ]);
    const decision = gate.evaluate(run([0.5, 0.5]), baseline([0.5, 0.5]));

    expect(decision.passed).toBe(false);
    expect(at(decision.results, 0).rationale).toContain('is below the absolute floor');
  });

  it('checks the floor before the drop', () => {
    // Both rules would fire; the floor is reported because it says the system is
    // insufficient, which is the more useful sentence.
    const gate = new BaselineGate([
      new Threshold({ metric: 'exact-match', minMean: 0.9, maxRegression: 0.0 }),
    ]);
    const decision = gate.evaluate(run([0.1, 0.1]), baseline([1.0, 1.0]));

    expect(at(decision.results, 0).rationale).toContain('absolute floor');
    expect(at(decision.results, 0).rationale).not.toContain('z=');
  });

  it('refuses a baseline recorded on a different dataset version', () => {
    const gate = new BaselineGate([new Threshold({ metric: 'exact-match' })]);
    const elsewhere = new EvalBaseline({
      dataset: 'capitals',
      datasetVersion: '2.0.0',
      model: 'fake-small-1',
      metrics: [MetricBaseline.fromValues('exact-match', [1.0])],
    });

    expect(() => gate.evaluate(run([1.0]), elsewhere)).toThrow(/compare like with like/);
    expect(() => gate.evaluate(run([1.0]), elsewhere)).toThrow(FrameworkEvalError);
  });

  it('refuses to be built without a threshold', () => {
    expect(() => new BaselineGate([])).toThrow(GateConfigurationError);
    expect(() => new BaselineGate([])).toThrow(/at least one threshold/);
  });

  it('refuses duplicate thresholds, which would mean two verdicts per metric', () => {
    expect(
      () =>
        new BaselineGate([
          new Threshold({ metric: 'exact-match' }),
          new Threshold({ metric: 'exact-match', maxRegression: 0.1 }),
        ]),
    ).toThrow(/duplicate thresholds for: exact-match/);
  });

  it('refuses to gate on a metric that calls a model', () => {
    const judge = new LlmJudge(async () => '{"score": 1.0, "reason": "fine"}', {
      rubric: 'is it good',
    });

    expect(
      () => new BaselineGate([new Threshold({ metric: judge.name })], { metrics: [judge] }),
    ).toThrow(/non-deterministic metric/);
  });

  it('allows that only when explicitly asked, for local exploration', () => {
    const judge = new LlmJudge(async () => '{"score": 1.0, "reason": "fine"}', {
      rubric: 'is it good',
    });

    expect(
      () =>
        new BaselineGate([new Threshold({ metric: judge.name })], {
          metrics: [judge],
          allowNondeterministic: true,
        }),
    ).not.toThrow();
  });

  it('reports a deterministic metric set without complaint', () => {
    const metric = new ExactMatch();
    expect(
      () => new BaselineGate([new Threshold({ metric: 'exact-match' })], { metrics: [metric] }),
    ).not.toThrow();
  });
});

describe('GateResult.summary', () => {
  it('names the dataset, the run count and whether the run varied', () => {
    const gate = new BaselineGate([new Threshold({ metric: 'exact-match', maxRegression: 0.5 })]);
    const summary = gate.evaluate(run([1.0, 1.0]), baseline([1.0, 1.0])).summary();

    expect(summary.split('\n')[0]).toBe(
      'eval gate PASSED (capitals@1.0.0, 2 runs, run-to-run variation: no)',
    );
    expect(summary.split('\n')[1]).toMatch(/^ {2}\[ok {2}] exact-match: mean /);
  });

  it('marks a failing metric and lists it', () => {
    const gate = new BaselineGate([new Threshold({ metric: 'exact-match', maxRegression: 0.0 })]);
    const decision = gate.evaluate(run([0.0]), baseline([1.0, 1.0]));

    expect(decision.summary().split('\n')[0]).toContain('eval gate FAILED');
    expect(decision.summary()).toContain('[FAIL]');
    expect(decision.failures()).toHaveLength(1);
  });
});

describe('EvalBaseline', () => {
  it('records a run and reads itself back', () => {
    const recorded = EvalBaseline.fromRun(run([1.0, 0.5]), { model: 'fake-small-1' });
    const restored = EvalBaseline.fromJson(recorded.toJson());

    expect(restored.dataset).toBe('capitals');
    expect(restored.datasetVersion).toBe('1.0.0');
    expect(restored.model).toBe('fake-small-1');
    expect(restored.metric('exact-match').mean).toBeCloseTo(0.75, 10);
    expect(restored.metric('exact-match').runs).toBe(2);
  });

  it('refuses a metric it does not carry', () => {
    expect(() => baseline([1.0]).metric('absent')).toThrow(/baseline has no metric/);
  });

  it('refuses a baseline with no metrics', () => {
    expect(
      () => new EvalBaseline({ dataset: 'd', datasetVersion: '1', model: 'm', metrics: [] }),
    ).toThrow(/at least one metric/);
  });

  it('accepts snake_case and camelCase spellings of the same baseline', () => {
    const payload = JSON.stringify({
      dataset: 'capitals',
      dataset_version: '1.0.0',
      model: 'fake-small-1',
      metrics: [{ metric: 'exact-match', runs: 2, mean: 1.0, stdev: 0.0 }],
    });
    const camel = JSON.stringify({
      dataset: 'capitals',
      datasetVersion: '1.0.0',
      model: 'fake-small-1',
      metrics: [{ metric: 'exact-match', runs: 2, mean: 1.0, stdev: 0.0 }],
    });

    expect(EvalBaseline.fromJson(payload).datasetVersion).toBe('1.0.0');
    expect(EvalBaseline.fromJson(camel).datasetVersion).toBe('1.0.0');
  });
});

describe('gateFromConfig', () => {
  it('builds thresholds from snake_case config', () => {
    const gate = gateFromConfig({
      thresholds: [{ metric: 'exact-match', min_mean: 0.5, max_regression: 0.1, alpha: 0.01 }],
    });

    expect(at(gate.thresholds, 0).metric).toBe('exact-match');
    expect(at(gate.thresholds, 0).minMean).toBe(0.5);
    expect(at(gate.thresholds, 0).maxRegression).toBe(0.1);
    expect(at(gate.thresholds, 0).alpha).toBe(0.01);
  });

  it('refuses config without a thresholds list', () => {
    expect(() => gateFromConfig({})).toThrow(/needs a 'thresholds' list/);
  });

  it('refuses a threshold that is not an object', () => {
    expect(() => gateFromConfig({ thresholds: [1] })).toThrow(/must be an object/);
  });
});

describe('Threshold defaults', () => {
  it('defaults to a two-point regression allowance at alpha 0.05 with no floor', () => {
    const threshold = new Threshold({ metric: 'exact-match' });

    expect(threshold.maxRegression).toBe(0.02);
    expect(threshold.alpha).toBe(0.05);
    expect(threshold.minMean).toBeNull();
  });

  it('refuses a metric name it cannot key on', () => {
    expect(() => new Threshold({ metric: '' })).toThrow(/must not be empty/);
  });
});

describe('the shipped metrics the gate reads', () => {
  it('names the deterministic set', () => {
    const metric: Metric = new ExactMatch();
    expect(metricNames([metric])).toEqual(['exact-match']);
    expect(new ExactMatch().deterministic).toBe(true);
    expect(new MetricResult({ metric: 'm', score: 0, passed: false }).score).toBe(0);
  });
});

function at<T>(items: readonly T[], index: number): T {
  const found = items[index];
  if (found === undefined) throw new Error(`no item at index ${index}`);
  return found;
}
