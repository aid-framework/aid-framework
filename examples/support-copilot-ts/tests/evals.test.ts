/**
 * The example's eval gates, driven offline.
 *
 * Mirrors `examples/support-copilot/tests/test_eval_gate.py` and
 * `test_retrieval_eval.py`, and exists for the same reason: the committed baselines
 * are measurements, so a test that only compared them to themselves would pass no
 * matter what the app did. Each suite is therefore also run against a downgraded
 * input -- a provider that answers badly, an index with nothing in it -- because a
 * gate that passes both ways is measuring its own tolerance.
 */

import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { EvalBaseline } from '@aid-framework/runtime';

import * as classify from '../app/generated/evals/classify_quality.js';
import * as handbook from '../app/generated/evals/handbook_quality.js';
import { buildRetrievers } from '../app/generated/retrieval/index.js';
import { fakeDeps } from './fake_gateway.js';

const RECALL = 'recall@k';

/** `app/`, taken from where the generated module says its baseline lives. */
const APP_DIR = dirname(dirname(fileURLToPath(handbook.BASELINE_PATH)));

/** The handbook retriever with the example's corpus written to it, in this process. */
async function indexedRetriever() {
  const retriever = buildRetrievers({ baseDir: APP_DIR }).get(handbook.RETRIEVER);
  assert.ok(retriever !== undefined, `no retriever ${handbook.RETRIEVER}`);
  await retriever.ingest();
  return retriever;
}

describe('classify_quality', () => {
  it('passes at the recorded baseline when the provider answers ideally', async () => {
    const result = await classify.runGate(fakeDeps());
    assert.ok(result.passed, result.summary());
    assert.equal(result.runs, classify.SAMPLES);
  });

  it('fails once the provider stops producing well-formed answers', async () => {
    const result = await classify.runGate(fakeDeps({ accuracy: 0 }));
    assert.ok(!result.passed, result.summary());
    const failures = result.failures();
    assert.deepEqual(
      failures.map((failure) => failure.metric),
      ['json-schema'],
    );
    const [failure] = failures;
    assert.ok(failure !== undefined);
    assert.ok(failure.baselineMean > 0);
  });

  it('has a baseline that is a recorded run, not a hand-written number', async () => {
    const measured = await classify.sample({ deps: fakeDeps() });
    const recorded = EvalBaseline.fromRun(measured, { model: classify.MODEL });
    const stored = classify.loadBaseline();

    assert.equal(stored.model, classify.MODEL);
    assert.equal(stored.dataset, measured.dataset);
    assert.equal(stored.datasetVersion, measured.datasetVersion);
    for (const entry of stored.metrics) {
      const fresh = recorded.metric(entry.metric);
      assert.equal(entry.runs, fresh.runs);
      assert.equal(entry.runs, classify.SAMPLES);
      assert.equal(entry.mean, fresh.mean);
      assert.equal(entry.stdev, fresh.stdev);
    }
  });

  it('measures the alias the app pins, never the fallback', () => {
    assert.equal(classify.MODEL, 'fast');
  });
});

describe('handbook_quality', () => {
  it('passes at the recorded ranking when the corpus is indexed', async () => {
    const retriever = await indexedRetriever();
    const result = await handbook.runGate(
      fakeDeps({ retrievers: new Map([[handbook.RETRIEVER, retriever]]) }),
    );
    assert.ok(result.passed, result.summary());
  });

  it('fails, naming the metric, when nothing is indexed', async () => {
    const empty = buildRetrievers({ baseDir: APP_DIR }).get(handbook.RETRIEVER);
    assert.ok(empty !== undefined);
    const measured = await handbook.sample({
      deps: fakeDeps({ retrievers: new Map([[handbook.RETRIEVER, empty]]) }),
    });
    const result = handbook.evaluate(measured, handbook.loadBaseline());

    assert.ok(!result.passed, result.summary());
    assert.equal(measured.means()[RECALL] ?? Number.NaN, 0);
    const [failure] = result.failures();
    assert.ok(failure !== undefined);
    assert.equal(failure.metric, RECALL);
    assert.ok(failure.baselineMean > 0);
  });

  it('has a baseline that is a recorded run over the indexed corpus', async () => {
    const retriever = await indexedRetriever();
    const measured = await handbook.sample({
      deps: fakeDeps({ retrievers: new Map([[handbook.RETRIEVER, retriever]]) }),
    });
    const recorded = EvalBaseline.fromRun(measured, { model: handbook.RETRIEVER });
    const stored = handbook.loadBaseline();

    assert.equal(stored.model, handbook.RETRIEVER);
    for (const entry of stored.metrics) {
      const fresh = recorded.metric(entry.metric);
      assert.equal(entry.runs, fresh.runs);
      assert.equal(entry.runs, handbook.SAMPLES);
      assert.equal(entry.mean, fresh.mean);
      assert.equal(entry.stdev, fresh.stdev);
    }
  });

  it('names the retriever and the page count the spec declares', () => {
    assert.equal(handbook.RETRIEVER, 'handbook');
    assert.ok(handbook.TOP_K >= 1);
  });
});
