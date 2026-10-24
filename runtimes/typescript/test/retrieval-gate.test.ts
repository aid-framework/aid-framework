import { describe, expect, it } from 'vitest';

import {
  Budget,
  CitationGrounding,
  CostLedger,
  EvalBaseline,
  EvalRun,
  FakeDeterministicEmbedder,
  EvalError as FrameworkEvalError,
  InMemoryVectorStore,
  MeanReciprocalRank,
  MetricBaseline,
  MetricResult,
  MetricRun,
  RecallAtK,
  RetrievalCase,
  RetrievalGate,
  Retriever,
  retrievalMetrics,
  Threshold,
} from '../src/index.js';
import type { RetrievalMetric } from '../src/retrieval/metrics.js';
import { at, binding, document, retrievalCase } from './support.js';

/**
 * A retriever over three documents about one topic each, so a query has exactly one
 * right answer and the ranking is not a coin toss.
 */
const CORPUS = [
  document('paris.md', 'paris is the capital of france and sits on the seine'),
  document('tokyo.md', 'tokyo is the capital of japan and sits on the sumida'),
  document('lima.md', 'lima is the capital of peru and sits on the rimac'),
];

const CASES = [
  retrievalCase({ id: 'q-fr', query: 'capital of france', expectDocs: ['paris.md'], k: 3 }),
  retrievalCase({ id: 'q-jp', query: 'capital of japan', expectDocs: ['tokyo.md'], k: 3 }),
  retrievalCase({ id: 'q-pe', query: 'capital of peru', expectDocs: ['lima.md'], k: 3 }),
];

/**
 * The same questions with a one-passage window.
 *
 * The fake embedder is deliberately semantically meaningless -- its vectors are hashes
 * -- so which passage lands first is arbitrary. That is why the gate tests use `k = 3`
 * and assert a full window rather than a ranking: what this runtime proves is the
 * pipeline and the gate arithmetic, never embedding quality.
 */
const NARROW_CASES = [
  retrievalCase({ id: 'q-fr', query: 'capital of france', expectDocs: ['paris.md'], k: 1 }),
  retrievalCase({ id: 'q-jp', query: 'capital of japan', expectDocs: ['tokyo.md'], k: 1 }),
  retrievalCase({ id: 'q-pe', query: 'capital of peru', expectDocs: ['lima.md'], k: 1 }),
];

async function seededRetriever(): Promise<Retriever> {
  const bound = new Retriever(binding({ hybrid: true, topK: 3 }), {
    embedder: new FakeDeterministicEmbedder(),
    store: new InMemoryVectorStore(),
  });
  await bound.ingest(CORPUS);
  return bound;
}

/** A metric that scores a constant, for exercising the gate's arithmetic. */
class ConstantMetric implements RetrievalMetric {
  readonly name: string;
  readonly deterministic: boolean;
  private readonly _value: number;

  constructor(
    value: number,
    init: { readonly name?: string; readonly deterministic?: boolean } = {},
  ) {
    this._value = value;
    this.name = init.name ?? 'constant';
    this.deterministic = init.deterministic ?? true;
  }

  async score(): Promise<MetricResult> {
    return new MetricResult({ metric: this.name, score: this._value, passed: true, detail: '' });
  }
}

/** A retriever that retrieves nothing, so a metric scores its floor. */
function emptyRetriever(): Retriever {
  return new Retriever(binding(), {
    embedder: new FakeDeterministicEmbedder(),
    store: new InMemoryVectorStore(),
  });
}

/**
 * The shipped gate refuses to exist without a threshold, so every gate here carries
 * one. A lenient `recall@k` threshold keeps the sampling tests about sampling.
 */
function gateOver(
  metrics: readonly RetrievalMetric[],
  thresholds: readonly Threshold[] = [new Threshold({ metric: 'recall@k' })],
): RetrievalGate {
  return new RetrievalGate(thresholds, { metrics });
}

describe('RetrievalGate construction', () => {
  it('reports the thresholds it was given', () => {
    const gate = new RetrievalGate([new Threshold({ metric: 'recall@k' })]);

    expect(gate.thresholds.map((threshold) => threshold.metric)).toEqual(['recall@k']);
  });

  it('refuses to exist without a threshold, matching the shipped gate', () => {
    expect(() => new RetrievalGate([])).toThrow(/the gate needs at least one threshold/);
  });

  it('reports the metrics it was given', () => {
    const gate = gateOver(retrievalMetrics());

    expect(gate.metrics.map((metric) => metric.name)).toEqual([
      'recall@k',
      'mrr',
      'citation-grounding',
    ]);
  });

  it('defaults to no metrics, which sampling then refuses', async () => {
    const gate = new RetrievalGate([new Threshold({ metric: 'recall@k' })]);

    expect(gate.metrics).toEqual([]);
    await expect(
      gate.sample(CASES, emptyRetriever(), { runs: 1, dataset: 'docs', datasetVersion: '1' }),
    ).rejects.toThrow('a retrieval run needs at least one metric');
  });
});

describe('RetrievalGate sample', () => {
  it('refuses an empty case list', async () => {
    const gate = gateOver([new RecallAtK()]);

    await expect(
      gate.sample([], emptyRetriever(), { runs: 1, dataset: 'docs', datasetVersion: '1' }),
    ).rejects.toThrow(new FrameworkEvalError('a retrieval run needs at least one case'));
  });

  it('refuses fewer than one run', async () => {
    const gate = gateOver([new RecallAtK()]);

    await expect(
      gate.sample(CASES, emptyRetriever(), { runs: 0, dataset: 'docs', datasetVersion: '1' }),
    ).rejects.toThrow('a retrieval run needs at least one run, got 0');
  });

  it('produces one value per run per metric', async () => {
    const gate = gateOver([new RecallAtK()]);

    const sampled = await gate.sample(CASES, await seededRetriever(), {
      runs: 3,
      dataset: 'docs',
      datasetVersion: '1',
    });

    expect(sampled.runs).toBe(3);
    expect(sampled.metrics).toHaveLength(1);
    expect(at(sampled.metrics, 0).values).toHaveLength(3);
  });

  it('labels the run with the dataset and version it was given', async () => {
    const gate = gateOver([new RecallAtK()]);

    const sampled = await gate.sample(CASES, await seededRetriever(), {
      runs: 1,
      dataset: 'docs',
      datasetVersion: '2.1.0',
    });

    expect(sampled.dataset).toBe('docs');
    expect(sampled.datasetVersion).toBe('2.1.0');
  });

  it('scores a perfect retriever at one on recall', async () => {
    const gate = gateOver([new RecallAtK()]);

    const sampled = await gate.sample(CASES, await seededRetriever(), {
      runs: 2,
      dataset: 'docs',
      datasetVersion: '1',
    });

    for (const value of at(sampled.metrics, 0).values) {
      expect(value).toBe(1);
    }
  });

  it('averages the per-case scores into one value per run', async () => {
    const always = gateOver([new ConstantMetric(0.5)]);

    const sampled = await always.sample(CASES, emptyRetriever(), {
      runs: 1,
      dataset: 'docs',
      datasetVersion: '1',
    });

    expect(at(sampled.metrics, 0).values).toEqual([0.5]);
  });

  it('uses the case k rather than the retriever topK', async () => {
    // The case is what says how many passages count as an answer; the retriever's own
    // topK is a default. The same retriever and questions must score differently under
    // a one-passage window, which is only possible if k comes from the case.
    const gate = gateOver([new RecallAtK()]);
    const init = { runs: 1, dataset: 'docs', datasetVersion: '1' };

    const wide = await gate.sample(CASES, await seededRetriever(), init);
    const narrow = await gate.sample(NARROW_CASES, await seededRetriever(), init);

    expect(at(wide.metrics, 0).values).toEqual([1]);
    expect(at(narrow.metrics, 0).values[0]).toBeLessThan(1);
  });

  it('is deterministic: the same corpus samples identically twice', async () => {
    const metrics = (): readonly RetrievalMetric[] => [new RecallAtK(), new MeanReciprocalRank()];
    const init = { runs: 2, dataset: 'docs', datasetVersion: '1' };

    const first = await gateOver(metrics()).sample(CASES, await seededRetriever(), init);
    const second = await gateOver(metrics()).sample(CASES, await seededRetriever(), init);

    expect(second.metrics.map((metric) => metric.values)).toEqual(
      first.metrics.map((metric) => metric.values),
    );
  });

  it('samples a worse retriever strictly lower', async () => {
    const gate = gateOver([new RecallAtK()]);
    const init = { runs: 1, dataset: 'docs', datasetVersion: '1' };

    const good = await gate.sample(CASES, await seededRetriever(), init);
    const bad = await gate.sample(CASES, emptyRetriever(), init);

    expect(at(bad.metrics, 0).values[0]).toBeLessThan(at(good.metrics, 0).values[0] as number);
  });
});

describe('RetrievalGate evaluate', () => {
  function baselineFor(values: readonly number[], metric = 'recall@k'): EvalBaseline {
    return new EvalBaseline({
      dataset: 'docs',
      datasetVersion: '1',
      model: 'fake-small-1',
      metrics: [MetricBaseline.fromValues(metric, values)],
    });
  }

  function runFor(values: readonly number[], metric = 'recall@k'): EvalRun {
    return new EvalRun({
      dataset: 'docs',
      datasetVersion: '1',
      runs: values.length,
      metrics: [new MetricRun({ metric, values })],
    });
  }

  it('passes an unchanged retriever', () => {
    const gate = new RetrievalGate([new Threshold({ metric: 'recall@k' })]);

    const verdict = gate.evaluate(runFor([1, 1, 1]), baselineFor([1, 1, 1]));

    expect(verdict.passed).toBe(true);
  });

  it('fails a retriever that lost recall outright', () => {
    const gate = new RetrievalGate([new Threshold({ metric: 'recall@k', minMean: 0.9 })]);

    const verdict = gate.evaluate(runFor([0.2, 0.2, 0.2]), baselineFor([1, 1, 1]));

    expect(verdict.passed).toBe(false);
    expect(verdict.summary()).toContain('[FAIL]');
  });

  it('fails a real regression beyond the noise band', () => {
    const gate = gateOver(
      [new RecallAtK()],
      [new Threshold({ metric: 'recall@k', maxRegression: 0.0, alpha: 0.2 })],
    );

    // The gate's own noise case: delta 0.1 and z 1.5811, and 1.5811 > 0.8416 at alpha
    // 0.2, so the shipped z rejects this pair once the evidence demanded is lenient
    // enough for the difference to clear it.
    const verdict = gate.evaluate(
      runFor([0.4, 0.6, 0.4, 0.6, 0.5]),
      baselineFor([0.5, 0.7, 0.5, 0.7, 0.6]),
    );

    expect(verdict.passed).toBe(false);
    expect(verdict.summary()).toContain('exceeds max_regression');
  });

  it('passes the same regression as noise at the default alpha', () => {
    const gate = gateOver(
      [new RecallAtK()],
      [new Threshold({ metric: 'recall@k', maxRegression: 0.0, alpha: 0.05 })],
    );

    // z 1.5811 does not clear 1.6449 at alpha 0.05, so the same numbers that fail at
    // 0.2 read as run-to-run noise here: same arithmetic, different evidence demanded.
    const verdict = gate.evaluate(
      runFor([0.4, 0.6, 0.4, 0.6, 0.5]),
      baselineFor([0.5, 0.7, 0.5, 0.7, 0.6]),
    );

    expect(verdict.passed).toBe(true);
    expect(verdict.summary()).toContain('consistent with run-to-run noise');
  });

  it('refuses a baseline recorded on another dataset', () => {
    const gate = new RetrievalGate([new Threshold({ metric: 'recall@k' })]);
    const elsewhere = new EvalBaseline({
      dataset: 'other',
      datasetVersion: '9',
      model: 'fake-small-1',
      metrics: [MetricBaseline.fromValues('recall@k', [1, 1, 1])],
    });

    expect(() => gate.evaluate(runFor([1, 1, 1]), elsewhere)).toThrow(FrameworkEvalError);
  });

  it('refuses to threshold a non-deterministic metric', () => {
    // The cast in `retrieval/gate.ts` is confined to the hand-off; the eligibility
    // check it feeds is the shipped one, and it fires at construction.
    expect(
      () =>
        new RetrievalGate([new Threshold({ metric: 'wobbly' })], {
          metrics: [new ConstantMetric(1, { name: 'wobbly', deterministic: false })],
        }),
    ).toThrow(/thresholds reference non-deterministic metric\(s\): wobbly/);
  });

  it('samples and evaluates end to end, passing a retriever against itself', async () => {
    const gate = new RetrievalGate([new Threshold({ metric: 'recall@k', minMean: 0.9 })], {
      metrics: [new RecallAtK()],
    });
    const init = { runs: 3, dataset: 'docs', datasetVersion: '1' };
    const sampled = await gate.sample(CASES, await seededRetriever(), init);
    const against = baselineFor(at(sampled.metrics, 0).values);

    const verdict = gate.evaluate(sampled, against);

    expect(verdict.dataset).toBe('docs');
    expect(verdict.passed).toBe(true);
  });

  it('samples and evaluates end to end, failing an empty retriever against a good baseline', async () => {
    const gate = new RetrievalGate([new Threshold({ metric: 'recall@k', minMean: 0.9 })], {
      metrics: [new RecallAtK()],
    });
    const sampled = await gate.sample(CASES, emptyRetriever(), {
      runs: 3,
      dataset: 'docs',
      datasetVersion: '1',
    });

    const verdict = gate.evaluate(sampled, baselineFor([1, 1, 1]));

    expect(verdict.passed).toBe(false);
    expect(verdict.summary()).toContain('is below the absolute floor');
  });

  it('scores citation grounding end to end over a real retriever', async () => {
    const gate = gateOver([new CitationGrounding()]);

    const sampled = await gate.sample(CASES, await seededRetriever(), {
      runs: 1,
      dataset: 'docs',
      datasetVersion: '1',
    });

    expect(at(sampled.metrics, 0).values).toEqual([1]);
  });

  it('keeps a ledger quiet when no budget is set', async () => {
    const ledger = new CostLedger();
    const gate = gateOver([new RecallAtK()]);
    const bound = new Retriever(binding({ hybrid: true }), {
      embedder: new FakeDeterministicEmbedder(),
      store: new InMemoryVectorStore(),
      ledger,
      budget: new Budget({ maxUsd: 10 }),
    });
    await bound.ingest(CORPUS);

    await gate.sample(CASES, bound, { runs: 1, dataset: 'docs', datasetVersion: '1' });

    expect(ledger.entries.length).toBeGreaterThan(0);
  });
});

describe('RetrievalCase reuse across the gate', () => {
  it('accepts the same case object in several runs without mutating it', async () => {
    const entry = retrievalCase({
      id: 'q',
      query: 'capital of france',
      expectDocs: ['paris.md'],
      k: 3,
    });
    const gate = gateOver([new RecallAtK()]);

    await gate.sample([entry], await seededRetriever(), {
      runs: 2,
      dataset: 'docs',
      datasetVersion: '1',
    });

    expect(entry.expectDocs).toEqual(['paris.md']);
    expect(entry.k).toBe(3);
  });

  it('treats a case with a different k as a different question', async () => {
    const wide = new RetrievalCase({
      id: 'q',
      query: 'capital of france',
      expectDocs: ['paris.md'],
      k: 3,
    });
    const gate = gateOver([new RecallAtK()]);

    const sampled = await gate.sample([wide], await seededRetriever(), {
      runs: 1,
      dataset: 'docs',
      datasetVersion: '1',
    });

    expect(at(sampled.metrics, 0).values).toEqual([1]);
  });
});
