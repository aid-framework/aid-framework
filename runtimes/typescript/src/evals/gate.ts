/**
 * N-run sampling and the statistical baseline gate.
 *
 * The ratified Phase 0 decision is that gating uses **N-run sampling with statistical
 * thresholds compared against a stored baseline**, in the `maxRegression` style --
 * *not* strict equality. Non-determinism is expected and must not be treated as a bug.
 *
 * Concretely, for each metric we:
 *
 * 1. Run the dataset `runs` times, giving one mean score per run. Those means are the
 *    *sample*, and their spread is the honest measure of how much this system varies
 *    when nothing changed.
 * 2. Compare the sample against a stored baseline (its own mean, spread and size).
 * 3. Fail only when the drop exceeds `maxRegression` **and** that drop is larger than
 *    the standard error of the difference could explain, at the configured
 *    significance level.
 *
 * Step 3 is what makes the gate trustworthy in both directions. A gate that fires on
 * any decrease is a flaky gate; a gate that only compares means can be fooled by a
 * noisy run. Requiring both a material *and* a statistically distinguishable drop
 * means the gate reports a regression when the evidence says there is one, and stays
 * quiet otherwise.
 *
 * The z critical values are a table rather than a library call because adding a
 * statistics dependency to enforce one one-sided test is not a trade worth making in a
 * runtime that must stay small.
 *
 * ## Parity note
 *
 * The arithmetic here is a direct transcription of `aid_runtime.evals.gate`, including
 * the z-critical table, the verdict ordering, and the six-decimal/four-decimal/three-
 * decimal formatting of the rationales. Only the *inputs* differ between the two
 * runtimes, because their fake providers draw their accuracy samples differently.
 */

import { readFileSync } from 'node:fs';

// biome-ignore lint/suspicious/noShadowRestrictedNames: the framework's own error name, matching the Python runtime's public surface
import { EvalError, GateConfigurationError } from '../errors.js';
import { repr } from '../internal/json.js';
import type { Metric } from './metrics.js';

/** One-sided z critical values, keyed by significance level. Ascending by level. */
const Z_CRITICAL_LEVELS: readonly (readonly [level: number, z: number])[] = [
  [0.005, 2.5758],
  [0.01, 2.3263],
  [0.025, 1.96],
  [0.05, 1.6449],
  [0.1, 1.2816],
  [0.2, 0.8416],
];

/**
 * The one-sided z critical value at `alpha`, rounded to a stricter level.
 *
 * `alpha` is rounded to the next *stricter* tabulated level -- a smaller alpha, hence a
 * larger z, hence a gate that demands slightly more evidence than asked for. That is
 * the safe direction for a regression gate: a gate that fires on borderline evidence
 * is a gate that gets switched off. An `alpha` below the strictest tabulated level
 * gets the strictest value, for the same reason.
 */
export function zCritical(alpha: number): number {
  if (!(alpha > 0.0 && alpha < 1.0)) throw new RangeError('alpha must be between 0 and 1');
  let chosen: number | undefined;
  for (const [level, z] of Z_CRITICAL_LEVELS) {
    if (level <= alpha) chosen = z;
  }
  return chosen ?? Z_CRITICAL_LEVELS[0]?.[1] ?? 2.5758;
}

function mean(values: readonly number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

/** Sample standard deviation over `n - 1`; zero for a single observation. */
function stdev(values: readonly number[]): number {
  if (values.length <= 1) return 0.0;
  const average = mean(values);
  let squared = 0;
  for (const value of values) squared += (value - average) ** 2;
  return Math.sqrt(squared / (values.length - 1));
}

function fixed(value: number, digits: number): string {
  if (Number.isNaN(value)) return 'nan';
  if (value === Number.POSITIVE_INFINITY) return 'inf';
  if (value === Number.NEGATIVE_INFINITY) return '-inf';
  return value.toFixed(digits);
}

function signed(value: number, digits: number): string {
  const negative = value < 0 || Object.is(value, -0);
  return `${negative ? '-' : '+'}${Math.abs(value).toFixed(digits)}`;
}

/** A quantised number, so a JSON round-trip is byte-stable. */
function quantise(value: number): number {
  return Number(value.toFixed(12));
}

/**
 * One-sided z for "the current mean is lower than the baseline mean".
 *
 * Uses the standard error of the difference of two means, so *both* spreads
 * contribute: a noisy baseline is a weak claim to regress against, and the gate should
 * demand more evidence before rejecting it.
 */
export function regressionZ(init: {
  readonly currentMean: number;
  readonly currentStdev: number;
  readonly currentN: number;
  readonly baselineMean: number;
  readonly baselineStdev: number;
  readonly baselineN: number;
}): number {
  const standardError = Math.sqrt(
    init.currentStdev ** 2 / Math.max(init.currentN, 1) +
      init.baselineStdev ** 2 / Math.max(init.baselineN, 1),
  );
  if (standardError <= 0.0) {
    // Both distributions are degenerate: any drop is real, so report an arbitrarily
    // large statistic rather than dividing by zero.
    return init.currentMean < init.baselineMean ? Number.POSITIVE_INFINITY : 0.0;
  }
  return (init.baselineMean - init.currentMean) / standardError;
}

/** Per-run, per-metric means: one value per run of the dataset. */
export class MetricRun {
  readonly metric: string;
  readonly values: readonly number[];

  constructor(init: { readonly metric: string; readonly values: readonly number[] }) {
    if (init.values.length === 0) throw new RangeError('a metric run needs at least one value');
    this.metric = init.metric;
    this.values = [...init.values];
  }

  toJSON(): Record<string, unknown> {
    return { metric: this.metric, values: [...this.values] };
  }
}

/** The sampled result of running a dataset N times. */
export class EvalRun {
  readonly dataset: string;
  readonly datasetVersion: string;
  readonly runs: number;
  readonly metrics: readonly MetricRun[];

  constructor(init: {
    readonly dataset: string;
    readonly datasetVersion: string;
    readonly runs: number;
    readonly metrics: readonly MetricRun[];
  }) {
    if (!Number.isInteger(init.runs) || init.runs <= 0) {
      throw new RangeError('runs must be a positive integer');
    }
    if (init.metrics.length === 0) throw new RangeError('an eval run needs at least one metric');
    this.dataset = init.dataset;
    this.datasetVersion = init.datasetVersion;
    this.runs = init.runs;
    this.metrics = init.metrics;
  }

  means(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const entry of this.metrics) out[entry.metric] = mean(entry.values);
    return out;
  }

  spread(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const entry of this.metrics) out[entry.metric] = stdev(entry.values);
    return out;
  }

  valuesFor(metric: string): readonly number[] {
    for (const entry of this.metrics) {
      if (entry.metric === metric) return entry.values;
    }
    throw new EvalError(`metric ${repr(metric)} is not in this run`);
  }

  /**
   * Whether any metric produced different scores across runs.
   *
   * Exposed because "the run varied" is a *fact about the system*, not a failure: a
   * test asserts on it to prove the gate tolerates noise rather than assuming a
   * deterministic system.
   */
  isVarying(): boolean {
    return this.metrics.some((entry) => new Set(entry.values).size > 1);
  }

  toJson(): string {
    const payload = {
      dataset: this.dataset,
      dataset_version: this.datasetVersion,
      runs: this.runs,
      metrics: this.metrics.map((entry) => entry.toJSON()),
    };
    return JSON.stringify(payload, null, 2);
  }
}

/** A stored metric distribution, recorded from a run that was accepted. */
export class MetricBaseline {
  readonly metric: string;
  readonly runs: number;
  readonly mean: number;
  readonly stdev: number;

  constructor(init: {
    readonly metric: string;
    readonly runs: number;
    readonly mean: number;
    readonly stdev: number;
  }) {
    if (!Number.isInteger(init.runs) || init.runs <= 0) {
      throw new RangeError('runs must be a positive integer');
    }
    if (!(init.mean >= 0.0 && init.mean <= 1.0)) {
      throw new RangeError('mean must be between 0 and 1');
    }
    if (!(init.stdev >= 0.0)) throw new RangeError('stdev must be non-negative');
    this.metric = init.metric;
    this.runs = init.runs;
    this.mean = init.mean;
    this.stdev = init.stdev;
  }

  static fromValues(metric: string, values: readonly number[]): MetricBaseline {
    return new MetricBaseline({
      metric,
      runs: values.length,
      mean: mean(values),
      stdev: stdev(values),
    });
  }

  toJSON(): Record<string, unknown> {
    return {
      metric: this.metric,
      runs: this.runs,
      mean: quantise(this.mean),
      stdev: quantise(this.stdev),
    };
  }
}

function readNumber(record: Readonly<Record<string, unknown>>, ...keys: string[]): number {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number') return value;
  }
  throw new EvalError(`a baseline entry is missing ${repr(keys[0] ?? '')}`);
}

function readString(record: Readonly<Record<string, unknown>>, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') return value;
  }
  throw new EvalError(`a baseline is missing ${repr(keys[0] ?? '')}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A committed baseline: the accepted distribution for a dataset and model. */
export class EvalBaseline {
  readonly dataset: string;
  readonly datasetVersion: string;
  readonly model: string;
  readonly metrics: readonly MetricBaseline[];
  readonly note: string;

  constructor(init: {
    readonly dataset: string;
    readonly datasetVersion: string;
    readonly model: string;
    readonly metrics: readonly MetricBaseline[];
    readonly note?: string;
  }) {
    if (init.metrics.length === 0) throw new RangeError('a baseline needs at least one metric');
    this.dataset = init.dataset;
    this.datasetVersion = init.datasetVersion;
    this.model = init.model;
    this.metrics = init.metrics;
    this.note = init.note ?? '';
  }

  static fromRun(
    run: EvalRun,
    options: { readonly model: string; readonly note?: string },
  ): EvalBaseline {
    return new EvalBaseline({
      dataset: run.dataset,
      datasetVersion: run.datasetVersion,
      model: options.model,
      metrics: run.metrics.map((entry) => MetricBaseline.fromValues(entry.metric, entry.values)),
      note: options.note ?? '',
    });
  }

  metric(name: string): MetricBaseline {
    for (const entry of this.metrics) {
      if (entry.metric === name) return entry;
    }
    throw new EvalError(`baseline has no metric ${repr(name)}`);
  }

  /** Parse a committed baseline. Accepts `snake_case` and `camelCase` keys. */
  static fromJson(payload: string): EvalBaseline {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch (error) {
      throw new EvalError(
        `a baseline must be JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!isObject(parsed)) throw new EvalError('a baseline must be a JSON object');
    const rawMetrics = parsed.metrics;
    if (!Array.isArray(rawMetrics) || rawMetrics.length === 0) {
      throw new EvalError('a baseline needs at least one metric');
    }
    return new EvalBaseline({
      dataset: readString(parsed, 'dataset'),
      datasetVersion: readString(parsed, 'dataset_version', 'datasetVersion'),
      model: readString(parsed, 'model'),
      metrics: rawMetrics.map((entry) => {
        if (!isObject(entry)) throw new EvalError('a baseline metric must be an object');
        return new MetricBaseline({
          metric: readString(entry, 'metric'),
          runs: readNumber(entry, 'runs'),
          mean: readNumber(entry, 'mean'),
          stdev: readNumber(entry, 'stdev'),
        });
      }),
      note: typeof parsed.note === 'string' ? parsed.note : '',
    });
  }

  static fromPath(path: string | URL): EvalBaseline {
    return EvalBaseline.fromJson(readFileSync(path, 'utf8'));
  }

  toJson(): string {
    const payload = {
      dataset: this.dataset,
      dataset_version: this.datasetVersion,
      model: this.model,
      metrics: this.metrics.map((entry) => entry.toJSON()),
      note: this.note,
    };
    return `${JSON.stringify(payload, null, 2)}\n`;
  }
}

/** The acceptance rule for one metric. */
export class Threshold {
  readonly metric: string;
  /**
   * Absolute floor on the mean. Independent of the baseline: it says what "good
   * enough" means, which no comparison to a past run can express.
   */
  readonly minMean: number | null;
  /** Largest mean drop, versus the baseline, still considered acceptable. */
  readonly maxRegression: number;
  /** Significance level for the one-sided regression test. */
  readonly alpha: number;

  constructor(init: {
    readonly metric: string;
    readonly minMean?: number | null;
    readonly maxRegression?: number;
    readonly alpha?: number;
  }) {
    if (init.metric.length === 0) throw new RangeError('threshold metric must not be empty');
    const minMean = init.minMean ?? null;
    if (minMean !== null && !(minMean >= 0.0 && minMean <= 1.0)) {
      throw new RangeError('minMean must be between 0 and 1');
    }
    const maxRegression = init.maxRegression ?? 0.02;
    if (!(maxRegression >= 0.0 && maxRegression <= 1.0)) {
      throw new RangeError('maxRegression must be between 0 and 1');
    }
    const alpha = init.alpha ?? 0.05;
    if (!(alpha > 0.0 && alpha < 1.0)) throw new RangeError('alpha must be between 0 and 1');
    this.metric = init.metric;
    this.minMean = minMean;
    this.maxRegression = maxRegression;
    this.alpha = alpha;
  }
}

/** Why one metric passed or failed. The rationale is the product. */
export class MetricGateResult {
  readonly metric: string;
  readonly passed: boolean;
  readonly currentMean: number;
  readonly currentStdev: number;
  readonly baselineMean: number;
  readonly baselineStdev: number;
  readonly delta: number;
  readonly z: number;
  readonly alpha: number;
  readonly maxRegression: number;
  readonly rationale: string;

  constructor(init: {
    readonly metric: string;
    readonly passed: boolean;
    readonly currentMean: number;
    readonly currentStdev: number;
    readonly baselineMean: number;
    readonly baselineStdev: number;
    readonly delta: number;
    readonly z: number;
    readonly alpha: number;
    readonly maxRegression: number;
    readonly rationale: string;
  }) {
    this.metric = init.metric;
    this.passed = init.passed;
    this.currentMean = init.currentMean;
    this.currentStdev = init.currentStdev;
    this.baselineMean = init.baselineMean;
    this.baselineStdev = init.baselineStdev;
    this.delta = init.delta;
    this.z = init.z;
    this.alpha = init.alpha;
    this.maxRegression = init.maxRegression;
    this.rationale = init.rationale;
  }
}

/** The gate's verdict over every metric. */
export class GateResult {
  readonly passed: boolean;
  readonly dataset: string;
  readonly datasetVersion: string;
  readonly runs: number;
  readonly results: readonly MetricGateResult[];
  readonly varying: boolean;

  constructor(init: {
    readonly passed: boolean;
    readonly dataset: string;
    readonly datasetVersion: string;
    readonly runs: number;
    readonly results: readonly MetricGateResult[];
    readonly varying?: boolean;
  }) {
    if (init.results.length === 0) throw new RangeError('a gate result needs at least one metric');
    this.passed = init.passed;
    this.dataset = init.dataset;
    this.datasetVersion = init.datasetVersion;
    this.runs = init.runs;
    this.results = init.results;
    this.varying = init.varying ?? false;
  }

  failures(): MetricGateResult[] {
    return this.results.filter((result) => !result.passed);
  }

  summary(): string {
    const verdict = this.passed ? 'PASSED' : 'FAILED';
    const varied = this.varying ? 'yes' : 'no';
    const lines = [
      `eval gate ${verdict} (${this.dataset}@${this.datasetVersion}, ${this.runs} runs, run-to-run variation: ${varied})`,
    ];
    for (const result of this.results) {
      lines.push(`  [${result.passed ? 'ok  ' : 'FAIL'}] ${result.rationale}`);
    }
    return lines.join('\n');
  }
}

export interface BaselineGateOptions {
  readonly metrics?: readonly Metric[];
  readonly allowNondeterministic?: boolean;
}

/** Compares a sampled run against a stored baseline. */
export class BaselineGate {
  private readonly _thresholds: readonly Threshold[];
  private readonly _metrics: ReadonlyMap<string, Metric>;
  private readonly _allowNondeterministic: boolean;

  constructor(thresholds: readonly Threshold[], options: BaselineGateOptions = {}) {
    if (thresholds.length === 0) {
      throw new GateConfigurationError('the gate needs at least one threshold');
    }
    const names = thresholds.map((threshold) => threshold.metric);
    const duplicates = [
      ...new Set(names.filter((name) => names.filter((n) => n === name).length > 1)),
    ].sort();
    if (duplicates.length > 0) {
      throw new GateConfigurationError(`duplicate thresholds for: ${duplicates.join(', ')}`);
    }
    this._thresholds = thresholds;
    this._metrics = new Map((options.metrics ?? []).map((metric) => [metric.name, metric]));
    this._allowNondeterministic = options.allowNondeterministic ?? false;
    this.checkMetricEligibility();
  }

  get thresholds(): readonly Threshold[] {
    return this._thresholds;
  }

  /** Decide whether `run` regressed against `baseline`. */
  evaluate(run: EvalRun, baseline: EvalBaseline): GateResult {
    if (run.dataset !== baseline.dataset || run.datasetVersion !== baseline.datasetVersion) {
      throw new EvalError(
        `baseline was recorded on ${baseline.dataset}@${baseline.datasetVersion} but the ` +
          `run is ${run.dataset}@${run.datasetVersion}; compare like with like`,
      );
    }

    const results = this._thresholds.map((threshold) =>
      this.evaluateMetric(threshold, run, baseline),
    );
    return new GateResult({
      passed: results.every((result) => result.passed),
      dataset: run.dataset,
      datasetVersion: run.datasetVersion,
      runs: run.runs,
      results,
      varying: run.isVarying(),
    });
  }

  private evaluateMetric(
    threshold: Threshold,
    run: EvalRun,
    baseline: EvalBaseline,
  ): MetricGateResult {
    const values = run.valuesFor(threshold.metric);
    const stored = baseline.metric(threshold.metric);
    const currentMean = mean(values);
    const currentStdev = stdev(values);
    const delta = stored.mean - currentMean;
    const z = regressionZ({
      currentMean,
      currentStdev,
      currentN: values.length,
      baselineMean: stored.mean,
      baselineStdev: stored.stdev,
      baselineN: stored.runs,
    });

    const verdict = this.verdict(threshold, currentMean, stored, delta, z);
    return new MetricGateResult({
      metric: threshold.metric,
      passed: verdict.passed,
      currentMean,
      currentStdev,
      baselineMean: stored.mean,
      baselineStdev: stored.stdev,
      delta,
      z,
      alpha: threshold.alpha,
      maxRegression: threshold.maxRegression,
      rationale: verdict.rationale,
    });
  }

  /**
   * The pass/fail call and the sentence explaining it.
   *
   * Three ways to pass, and the distinction between them is the whole point: no floor
   * breached, no material drop, or a drop that is material but within what the two
   * runs' own variation can explain. Only a drop that is both material *and* beyond the
   * noise threshold counts as a regression.
   */
  private verdict(
    threshold: Threshold,
    currentMean: number,
    stored: MetricBaseline,
    delta: number,
    z: number,
  ): { readonly passed: boolean; readonly rationale: string } {
    const where = `${threshold.metric}: mean ${fixed(currentMean, 4)} vs baseline ${fixed(stored.mean, 4)}`;

    if (threshold.minMean !== null && currentMean < threshold.minMean) {
      return {
        passed: false,
        rationale:
          `${threshold.metric}: mean ${fixed(currentMean, 4)} is below the absolute floor ` +
          `${fixed(threshold.minMean, 4)} (baseline ${fixed(stored.mean, 4)})`,
      };
    }

    if (delta <= threshold.maxRegression) {
      return {
        passed: true,
        rationale: `${where} -- delta ${signed(delta, 4)} is within max_regression ${fixed(threshold.maxRegression, 4)}`,
      };
    }

    const critical = zCritical(threshold.alpha);
    if (z <= critical) {
      return {
        passed: true,
        rationale:
          `${where} -- delta ${signed(delta, 4)} exceeds max_regression but z=${fixed(z, 3)} is not ` +
          `beyond ${fixed(critical, 3)} at alpha=${threshold.alpha}; consistent with run-to-run noise`,
      };
    }

    return {
      passed: false,
      rationale:
        `${where} -- delta ${signed(delta, 4)} exceeds max_regression ` +
        `${fixed(threshold.maxRegression, 4)} and z=${fixed(z, 3)} > ${fixed(critical, 3)} ` +
        `at alpha=${threshold.alpha}`,
    };
  }

  /**
   * Refuse thresholds that a non-deterministic metric would undermine.
   *
   * The rule is enforced here, at construction, rather than documented and hoped for: a
   * gate configured on a model-backed metric is not a gate, and refusing at
   * configuration time is the only moment that is cheap to fix.
   */
  private checkMetricEligibility(): void {
    if (this._allowNondeterministic) return;
    const offending = this._thresholds
      .map((threshold) => threshold.metric)
      .filter((name) => {
        const metric = this._metrics.get(name);
        return metric !== undefined && !metric.deterministic;
      })
      .sort();
    if (offending.length > 0) {
      throw new GateConfigurationError(
        `thresholds reference non-deterministic metric(s): ${offending.join(', ')}. ` +
          'A model-backed metric varies run to run, so it cannot distinguish a regression ' +
          'from its own noise; keep it as a reported metric and gate on a deterministic one. ' +
          'Pass allowNondeterministic: true only for local exploration, never in CI.',
      );
    }
  }
}

/** Build a gate from parsed JSON/YAML, so CI config stays declarative. */
export function gateFromConfig(
  config: Readonly<Record<string, unknown>>,
  options: { readonly metrics?: readonly Metric[] } = {},
): BaselineGate {
  const raw = config.thresholds;
  if (!Array.isArray(raw)) throw new GateConfigurationError("config needs a 'thresholds' list");
  return new BaselineGate(
    raw.map((entry) => {
      if (!isObject(entry)) throw new GateConfigurationError('a threshold must be an object');
      return new Threshold({
        metric: String(entry.metric ?? ''),
        minMean:
          typeof entry.min_mean === 'number'
            ? entry.min_mean
            : typeof entry.minMean === 'number'
              ? entry.minMean
              : null,
        maxRegression:
          typeof entry.max_regression === 'number'
            ? entry.max_regression
            : typeof entry.maxRegression === 'number'
              ? entry.maxRegression
              : undefined,
        alpha: typeof entry.alpha === 'number' ? entry.alpha : undefined,
      });
    }),
    {
      metrics: options.metrics ?? [],
      allowNondeterministic: Boolean(config.allow_nondeterministic ?? config.allowNondeterministic),
    },
  );
}
