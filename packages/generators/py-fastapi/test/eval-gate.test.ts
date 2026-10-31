/**
 * The eval gate is a statistical comparison, and this is where the emitted wiring that
 * makes it one is pinned.
 *
 * A sampled model scores differently on every honest run, so a gate that compared a run
 * against a stored number would fail constantly, and a gate with a tolerance wide enough
 * to never fail is not a gate. Both properties are decided by constants the generator
 * emits -- `SAMPLES` and `MAX_REGRESSION` -- and by handing the verdict to the runtime's
 * `BaselineGate` instead of deciding it here. Those are the things asserted below.
 *
 * Nothing in this file reimplements the gate. "Thin generated, fat runtime" means the
 * generated module carries the constants and the wiring, and `aid_runtime.evals` carries
 * the statistics; the example's `tests/test_eval_gate.py` drives the real gate with a
 * fake provider, and this file checks the artifact that test relies on.
 *
 * Every block ends with a mutation that has been shown to be caught.
 */

import { scanForNonDeterminism } from '@aid-framework/generator-sdk';

import type { EvalShape } from '@aid-framework/ir';
import { describe, expect, it } from 'vitest';

import {
  baselineRelativePath,
  datasetRelativePath,
  deterministicMetrics,
  evalModulePath,
  evalSubject,
  isRetrievalEval,
  metricBindings,
  modelsUnderTest,
  pipelinePath,
  usesJudge,
} from '../src/index.js';
import { assignedValue, example, literalString, onDisk, quotedSegments } from './helpers.js';

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function show(value: unknown): string {
  if (value === undefined) return 'undefined';
  return JSON.stringify(value) ?? String(value);
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * The example's sampled-prompt eval.
 *
 * The example declares two evals: this one, and a retrieval eval that measures the corpus
 * rather than the model. Every assertion in this file is about the sampled prompt eval --
 * `SAMPLES`, `MAX_REGRESSION`, the threshold's metric, delegation to `BaselineGate` -- so
 * the subject is selected as "the eval that is not a retrieval eval" and there must be
 * exactly one, because two would make these assertions partial over their own subject.
 */
function exampleEval(): { ir: ReturnType<typeof example>['ir']; evaluation: EvalShape } {
  const { ir } = example();
  const sampled = ir.evals.filter((candidate) => !isRetrievalEval(candidate));
  const [evaluation] = sampled;
  if (evaluation === undefined || sampled.length !== 1) {
    throw new Error(`the example should declare one sampled eval, found ${sampled.length}`);
  }
  return { ir, evaluation };
}

function numberConstant(source: string, name: string): number | undefined {
  const expression = assignedValue(source, name)?.trim();
  if (expression === undefined || expression === '') return undefined;
  const value = Number(expression);
  return Number.isFinite(value) ? value : undefined;
}

export interface EvalContract {
  /** How many times one measurement samples the dataset. */
  readonly samples: number | undefined;
  /** The tolerance the gate allows the sampled mean to drop by. */
  readonly maxRegression: number | undefined;
  /** The metric the emitted threshold names, from the `Threshold(...)` call itself. */
  readonly thresholdMetric: string | undefined;
  /** Whether the verdict is delegated to the runtime rather than decided here. */
  readonly hasBaselineGate: boolean;
  /** Whether an LLM judge is among the metrics in the emitted module. */
  readonly hasJudge: boolean;
}

/** Reads the gate's contract out of the emitted module. Pure, so it can be mutated. */
function evalContract(source: string): EvalContract {
  const threshold = source
    .split('\n')
    .find((line) => line.includes('Threshold(') && line.includes('max_regression='));

  return {
    samples: numberConstant(source, 'SAMPLES'),
    maxRegression: numberConstant(source, 'MAX_REGRESSION'),
    thresholdMetric:
      threshold === undefined ? undefined : quotedSegments(threshold.split('metric=')[1] ?? '')[0],
    hasBaselineGate: source.includes('BaselineGate(thresholds()'),
    hasJudge: source.includes('Judge('),
  };
}

/**
 * What stops the emitted gate from being a statistical comparison.
 *
 * Pure, so the falsifiers below drive it with a mutated artifact instead of by eyeballing
 * the emitted file. The two ends of the range matter equally: a zero tolerance is an
 * equality check, and a tolerance of 1.0 passes a metric that fell to zero.
 */
function statisticalProblems(contract: EvalContract, evaluation: EvalShape): string[] {
  const problems: string[] = [];
  const measured = metricBindings(evaluation).map((binding) => binding.name);

  if (contract.samples === undefined || contract.samples < 2) {
    problems.push(`samples: ${show(contract.samples)}, which is not a sample`);
  }
  if (contract.maxRegression === undefined || contract.maxRegression <= 0) {
    problems.push(`max_regression: ${show(contract.maxRegression)}, which is an equality check`);
  } else if (contract.maxRegression >= 1) {
    problems.push(`max_regression: ${show(contract.maxRegression)}, which swallows any drop`);
  }
  if (!contract.hasBaselineGate) {
    problems.push('the verdict is not delegated to the runtime baseline gate');
  }
  if (contract.thresholdMetric === undefined || !measured.includes(contract.thresholdMetric)) {
    problems.push(`threshold metric ${show(contract.thresholdMetric)} is not measured`);
  }
  if (contract.hasJudge) {
    problems.push('an LLM judge is in the gate');
  }

  return problems;
}

/** What is wrong with a stored baseline, given the contract the module emits. */
function baselineProblems(
  baseline: unknown,
  expected: { evalId: string; model: string; samples: number; metrics: string[] },
): string[] {
  if (!isMapping(baseline)) return ['the baseline is not a JSON object'];

  const problems: string[] = [];
  if (asText(baseline.dataset) !== expected.evalId) {
    problems.push(`dataset: ${show(baseline.dataset)} != ${expected.evalId}`);
  }
  if (asText(baseline.model) !== expected.model) {
    problems.push(`model: ${show(baseline.model)} != ${expected.model}`);
  }

  const entries = Array.isArray(baseline.metrics) ? baseline.metrics : [];
  if (entries.length === 0) problems.push('no metric was recorded');

  for (const entry of entries) {
    if (!isMapping(entry)) {
      problems.push('a metric entry is not a JSON object');
      continue;
    }
    const name = asText(entry.metric);
    const label = name ?? show(entry.metric);
    if (name === undefined || !expected.metrics.includes(name)) {
      problems.push(`metric ${label} is not measured by the eval`);
    }
    if (asNumber(entry.runs) !== expected.samples) {
      problems.push(`${label}: runs ${show(entry.runs)} != ${expected.samples}`);
    }
    for (const field of ['mean', 'stdev'] as const) {
      const value = asNumber(entry[field]);
      if (value === undefined || value < 0 || value > 1) {
        problems.push(`${label}: ${field} ${show(entry[field])} is not a rate`);
      }
    }
  }

  for (const metric of expected.metrics) {
    if (!entries.some((entry) => isMapping(entry) && asText(entry.metric) === metric)) {
      problems.push(`no baseline was recorded for ${metric}`);
    }
  }

  return problems;
}

/** What is wrong with the dataset file the eval loads. */
function datasetProblems(dataset: unknown, evalId: string): string[] {
  if (!isMapping(dataset)) return ['the dataset is not a JSON object'];

  const problems: string[] = [];
  if (asText(dataset.name) !== evalId) {
    problems.push(`name: ${show(dataset.name)} != ${evalId}`);
  }
  if (asText(dataset.version) === undefined) problems.push('the dataset has no version');

  const cases = Array.isArray(dataset.cases) ? dataset.cases : [];
  if (cases.length === 0) problems.push('the dataset has no cases');

  const seen = new Set<string>();
  for (const entry of cases) {
    if (!isMapping(entry)) {
      problems.push('a case is not a JSON object');
      continue;
    }
    const id = asText(entry.id);
    if (id === undefined || id === '') {
      problems.push('a case has no id');
    } else if (seen.has(id)) {
      problems.push(`case ${id} appears twice`);
    } else {
      seen.add(id);
    }
    if (asText(entry.input) === undefined) problems.push(`case ${show(id)} has no input`);
  }

  return problems;
}

/**
 * Why the emitted eval would not be measuring the app it claims to measure.
 *
 * The module's docstring says it measures the prompt and version the pipeline renders, so
 * anything else about the call has to come from the same wiring -- and a call's fallback
 * chain is part of its wiring. A runner built on the bare gateway dies where the app
 * survives, which is a divergence rather than a stricter measurement.
 *
 * Pure, so the falsifiers below drive it with a mutated artifact.
 */
function wiringProblems(evalText: string, pipelineText: string): string[] {
  const problems: string[] = [];

  if (!pipelineText.includes('fallbacks=FALLBACKS.get(')) {
    problems.push('the pipeline no longer passes a fallback chain for the eval to mirror');
  }
  if (!evalText.includes('from ..gateway.models import FALLBACKS')) {
    problems.push("the eval does not read the spec's fallback chain");
  }
  if (!evalText.includes('fallbacks=FALLBACKS.get(MODEL, ())')) {
    problems.push("the eval's runner passes no fallback chain");
  }

  return problems;
}

function evalSource(): string {
  const { evaluation } = exampleEval();
  // `evalModulePath` is app-relative already; the dataset and baseline helpers below
  // return paths relative to the app directory, which is why those get the prefix.
  const path = evalModulePath(evaluation.id);
  const source = onDisk(path);
  if (source === undefined) throw new Error(`no emitted eval at ${path}`);
  return source;
}

function pipelineSource(): string {
  const { ir } = example();
  const [pipeline] = ir.pipelines;
  if (pipeline === undefined || ir.pipelines.length !== 1) {
    throw new Error(`the example should declare one pipeline, found ${ir.pipelines.length}`);
  }
  const path = pipelinePath(pipeline.id);
  const source = onDisk(path);
  if (source === undefined) throw new Error(`no emitted pipeline at ${path}`);
  return source;
}

describe('the emitted eval module', () => {
  it('samples the dataset instead of running it once', () => {
    const { evaluation } = exampleEval();
    const contract = evalContract(evalSource());

    expect(contract.samples).toBe(evaluation.gate.samples);
    expect(contract.samples).toBeGreaterThanOrEqual(2);
  });

  it('carries the spec tolerance, and a tolerance that can fail in both directions', () => {
    const { evaluation } = exampleEval();
    const contract = evalContract(evalSource());

    expect(contract.maxRegression).toBe(evaluation.gate.maxRegression);
    expect(contract.maxRegression).toBeGreaterThan(0);
    expect(contract.maxRegression).toBeLessThan(1);
  });

  it('thresholds on the metric the runtime actually measures', () => {
    const { evaluation } = exampleEval();
    const contract = evalContract(evalSource());
    const bindings = metricBindings(evaluation);

    expect(bindings.map((binding) => binding.name)).toEqual([contract.thresholdMetric]);
    expect(deterministicMetrics(evaluation)).toHaveLength(bindings.length);
    expect(bindings[0]?.expression).toBe('JsonSchemaValid()');
  });

  it('never puts an LLM judge in the gate, because Phase 0 does not CI-require one', () => {
    const { evaluation } = exampleEval();

    expect(usesJudge(evaluation)).toBe(false);
    expect(evalContract(evalSource()).hasJudge).toBe(false);
  });

  it('measures the prompt and model the pipeline uses, not a paraphrase of them', () => {
    const { ir, evaluation } = exampleEval();
    const subject = evalSubject(ir, evaluation);
    expect(subject.ok, subject.ok ? '' : subject.message).toBe(true);
    if (!subject.ok) return;

    const source = evalSource();
    expect(literalString(assignedValue(source, 'PROMPT'))).toBe(subject.subject.prompt.id);
    expect(literalString(assignedValue(source, 'MODEL'))).toBe(subject.subject.model);
    expect(literalString(assignedValue(source, 'EVAL_ID'))).toBe(evaluation.id);
    expect(modelsUnderTest(ir, subject.subject.prompt.id)).toContain(subject.subject.model);
  });

  it('hands the verdict to the runtime and reports a regression as an exit code', () => {
    const source = evalSource();

    expect(source).toContain('BaselineGate(thresholds(), metrics=metrics())');
    expect(source).toContain('run_evaluation(');
    expect(source).toContain('if __name__ == "__main__":');
    expect(source).toContain('return 1 if result.failures() else 0');
  });

  it('is a gate with no statistical defect the runtime would have to absorb', () => {
    const { evaluation } = exampleEval();
    expect(statisticalProblems(evalContract(evalSource()), evaluation)).toEqual([]);
  });

  it('measures the app as wired, fallbacks included, so it cannot diverge from the pipeline', () => {
    expect(wiringProblems(evalSource(), pipelineSource())).toEqual([]);
  });
});

describe('an eval that stopped measuring the app would be caught', () => {
  it("catches a runner built on the bare gateway, without the pipeline's fallbacks", () => {
    const original = evalSource();
    const mutated = original.replace(' fallbacks=FALLBACKS.get(MODEL, ())', '');

    expect(mutated).not.toBe(original);
    expect(wiringProblems(mutated, pipelineSource())).toEqual([
      "the eval's runner passes no fallback chain",
    ]);
  });

  it('catches an eval that stopped reading the declared fallbacks at all', () => {
    const original = evalSource();
    const mutated = original.replace('from ..gateway.models import FALLBACKS\n', '');

    expect(mutated).not.toBe(original);
    expect(wiringProblems(mutated, pipelineSource())).toEqual([
      "the eval does not read the spec's fallback chain",
    ]);
  });

  it('catches a pipeline that stopped passing the chain the eval mirrors', () => {
    const original = pipelineSource();
    // Every `generate` in the module has to lose the chain, not just the first one: the
    // example's parallel added two more model calls above the one the pipeline binds, so
    // stripping a single occurrence leaves the wiring the check looks for intact and the
    // mutation stops falsifying anything.
    const mutated = original.replaceAll('fallbacks=FALLBACKS.get("fast", ())', '');

    expect(mutated).not.toBe(original);
    expect(wiringProblems(evalSource(), mutated)).toEqual([
      'the pipeline no longer passes a fallback chain for the eval to mirror',
    ]);
  });
});

describe('a gate that stopped being statistical would be caught', () => {
  it('catches a tolerance of zero, which is an equality check', () => {
    const { evaluation } = exampleEval();
    const mutated = evalContract(
      evalSource().replace('MAX_REGRESSION = 0.05', 'MAX_REGRESSION = 0.0'),
    );

    expect(mutated.maxRegression).toBe(0);
    expect(statisticalProblems(mutated, evaluation)).toEqual([
      'max_regression: 0, which is an equality check',
    ]);
  });

  it('catches a tolerance wide enough to accept the metric collapsing', () => {
    const { evaluation } = exampleEval();
    const mutated = evalContract(
      evalSource().replace('MAX_REGRESSION = 0.05', 'MAX_REGRESSION = 1.0'),
    );

    expect(statisticalProblems(mutated, evaluation)).toEqual([
      'max_regression: 1, which swallows any drop',
    ]);
  });

  it('catches a single sample, which cannot vary and so cannot be compared', () => {
    const { evaluation } = exampleEval();
    const mutated = evalContract(evalSource().replace('SAMPLES = 5', 'SAMPLES = 1'));

    expect(mutated.samples).toBe(1);
    expect(statisticalProblems(mutated, evaluation)).toEqual(['samples: 1, which is not a sample']);
  });

  it('catches a gate that decides the verdict itself instead of delegating it', () => {
    const { evaluation } = exampleEval();
    const mutated = evalContract(
      evalSource().replace('BaselineGate(thresholds(), metrics=metrics())', 'StrictEqualityGate()'),
    );

    expect(statisticalProblems(mutated, evaluation)).toContain(
      'the verdict is not delegated to the runtime baseline gate',
    );
  });

  it('catches a threshold on a metric nothing measures', () => {
    const { evaluation } = exampleEval();
    const mutated = evalContract(evalSource().replace('metric="json-valid"', 'metric="vibes"'));

    expect(statisticalProblems(mutated, evaluation)).toContain(
      'threshold metric "vibes" is not measured',
    );
  });

  it('catches a judge metric that crept into the gate', () => {
    const { evaluation } = exampleEval();
    const mutated = evalContract(
      evalSource().replace('return (JsonSchemaValid(),)', 'return (JsonSchemaValid(), LlmJudge())'),
    );

    expect(mutated.hasJudge).toBe(true);
    expect(statisticalProblems(mutated, evaluation)).toContain('an LLM judge is in the gate');
  });
});

describe('the stored dataset and baseline', () => {
  function stored(): {
    dataset: unknown;
    baseline: unknown;
    datasetPath: string;
    baselinePath: string;
    expected: { evalId: string; model: string; samples: number; metrics: string[] };
  } {
    const { evaluation } = exampleEval();
    const source = evalSource();
    const uri = evaluation.dataset.uri;
    if (uri === undefined) throw new Error('the example should load its dataset from a file');

    const datasetPath = `app/${datasetRelativePath(uri)}`;
    const baselinePath = `app/${baselineRelativePath(evaluation.id)}`;
    const datasetText = onDisk(datasetPath);
    const baselineText = onDisk(baselinePath);
    if (datasetText === undefined) throw new Error(`no dataset at ${datasetPath}`);
    if (baselineText === undefined) throw new Error(`no baseline at ${baselinePath}`);

    return {
      dataset: JSON.parse(datasetText) as unknown,
      baseline: JSON.parse(baselineText) as unknown,
      datasetPath,
      baselinePath,
      expected: {
        evalId: evaluation.id,
        model: literalString(assignedValue(source, 'MODEL')) ?? '',
        samples: numberConstant(source, 'SAMPLES') ?? 0,
        metrics: metricBindings(evaluation).map((binding) => binding.name),
      },
    };
  }

  it('loads both from where the generated loader says they are', () => {
    const { dataset, baseline, expected } = stored();

    expect(datasetProblems(dataset, expected.evalId)).toEqual([]);
    expect(baselineProblems(baseline, expected)).toEqual([]);
  });

  it('records the baseline from a fake provider, so the gate runs with no network', () => {
    const { baseline } = stored();
    const note = isMapping(baseline) ? asText(baseline.note) : undefined;

    expect(note).toBeDefined();
    expect(note).toContain('fake provider');
  });

  it('keeps machine-identifying text out of both files, which are committed', () => {
    const { datasetPath, baselinePath } = stored();
    const violations = [
      ...scanForNonDeterminism(datasetPath, onDisk(datasetPath) ?? ''),
      ...scanForNonDeterminism(baselinePath, onDisk(baselinePath) ?? ''),
    ];

    expect(violations).toEqual([]);
  });

  it('would notice a baseline recorded from a different number of runs', () => {
    const { baseline, expected } = stored();
    const mutated = { ...(baseline as Record<string, unknown>) };

    mutated.metrics = (Array.isArray(mutated.metrics) ? mutated.metrics : []).map((entry) => ({
      ...(entry as Record<string, unknown>),
      runs: expected.samples + 1,
    }));

    expect(baselineProblems(mutated, expected)).toEqual([
      `json-valid: runs ${expected.samples + 1} != ${expected.samples}`,
    ]);
  });

  it('would notice a metric with no baseline recorded for it', () => {
    const { baseline, expected } = stored();
    const mutated = {
      ...(baseline as Record<string, unknown>),
      metrics: [] as unknown[],
    };

    expect(baselineProblems(mutated, expected)).toEqual([
      'no metric was recorded',
      'no baseline was recorded for json-valid',
    ]);
  });

  it('would notice a mean that is not a rate, and a metric nobody measures', () => {
    const { baseline, expected } = stored();
    const mutated = {
      ...(baseline as Record<string, unknown>),
      metrics: [{ metric: 'vibes', runs: expected.samples, mean: 7, stdev: -1 }],
    };

    expect(baselineProblems(mutated, expected)).toEqual([
      'metric vibes is not measured by the eval',
      'vibes: mean 7 is not a rate',
      'vibes: stdev -1 is not a rate',
      'no baseline was recorded for json-valid',
    ]);
  });

  it('would notice a dataset that lost its cases, its name or its ids', () => {
    const { dataset } = stored();

    expect(datasetProblems({ ...(dataset as object), cases: [] }, 'classify_quality')).toEqual([
      'the dataset has no cases',
    ]);
    expect(datasetProblems({ ...(dataset as object), name: 'other' }, 'classify_quality')).toEqual([
      'name: "other" != classify_quality',
    ]);
    expect(
      datasetProblems(
        {
          name: 'classify_quality',
          version: '1',
          cases: [
            { id: 'a', input: 'x' },
            { id: 'a', input: 'y' },
          ],
        },
        'classify_quality',
      ),
    ).toEqual(['case a appears twice']);
    expect(
      datasetProblems(
        { name: 'classify_quality', version: '1', cases: [{ id: 'a' }] },
        'classify_quality',
      ),
    ).toEqual(['case "a" has no input']);
  });
});
