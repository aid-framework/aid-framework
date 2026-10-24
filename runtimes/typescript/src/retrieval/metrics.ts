/**
 * Metrics over a retrieved set.
 *
 * The shipped `Metric` scores `(case, prediction: string)`. That signature cannot
 * express these metrics: recall@k and MRR score a *ranked set of passages with
 * provenance*, and a citation-grounding score has to look at where each passage came
 * from. Encoding a retrieved set into one string would make every metric re-parse it,
 * and the parse would become the thing under test.
 *
 * So the retrieval metrics get their own protocol here rather than widening the
 * shipped one. Widening `Metric` would change the meaning of an interface the eval
 * gate already threshold-checks, and would do so for every existing implementation.
 * The new protocol is additive and reuses {@link MetricResult}.
 *
 * The two protocols share the part the gate actually consumes -- `name` and
 * `deterministic` -- which is what lets retrieval metrics be handed to the shipped
 * gate's `metrics` option. See `retrieval/gate.ts` for why that hand-off needs a cast
 * and why the cast is sound.
 *
 * `deterministic` is `true` for all three, and that is a claim the gate enforces:
 * none of these metrics calls a model, and every tie is broken by chunk id, so the
 * same retrieved set always scores the same.
 */

import { ConfigurationError } from '../errors.js';
import { MetricResult } from '../evals/metrics.js';
import { repr } from '../internal/json.js';
import type { RetrievalResult } from './citations.js';
import type { RetrievalMetricSpec } from './types.js';

/**
 * One retrieval question and the documents that should answer it.
 *
 * This mirrors the IR's `retrieval` metric node field for field, and it exists
 * because `EvalCase` carries `metadata: Record<string, string>` -- a string map,
 * which cannot hold `expectDocs` without inventing an encoding. The expected
 * documents, and `k`, are what a retrieval metric needs, so they are typed here
 * instead of smuggled through a string.
 */
export class RetrievalCase {
  readonly id: string;
  readonly query: string;
  readonly expectDocs: readonly string[];
  readonly k: number;

  constructor(init: {
    readonly id: string;
    readonly query: string;
    readonly expectDocs: readonly string[];
    readonly k: number;
  }) {
    if (init.id.length === 0) throw new ConfigurationError('case id must not be empty');
    if (init.expectDocs.length === 0) {
      throw new ConfigurationError('a retrieval case needs at least one expected document');
    }
    if (!Number.isInteger(init.k) || init.k <= 0) {
      throw new ConfigurationError('a retrieval case needs a positive k');
    }
    this.id = init.id;
    this.query = init.query;
    this.expectDocs = [...init.expectDocs];
    this.k = init.k;
  }

  /** Build a case from the IR's `{kind, expectDocs, k}` node. */
  static fromSpec(init: {
    readonly caseId: string;
    readonly query: string;
    readonly spec: RetrievalMetricSpec;
  }): RetrievalCase {
    return new RetrievalCase({
      id: init.caseId,
      query: init.query,
      expectDocs: init.spec.expectDocs,
      k: init.spec.k,
    });
  }
}

/**
 * Scores a ranked, cited retrieved set.
 *
 * `name` and `deterministic` are part of the contract because the shipped gate reads
 * exactly those two properties when it checks that a thresholded metric is allowed to
 * gate CI.
 */
export interface RetrievalMetric {
  readonly name: string;
  readonly deterministic: boolean;
  score(entry: RetrievalCase, retrieved: RetrievalResult): Promise<MetricResult>;
}

/**
 * Fraction of expected documents present in the top `k`.
 *
 * Duplicated passages do not inflate the score: {@link RetrievalResult.docIds} is
 * de-duplicated, so a document that contributed three passages counts once. Recall is
 * about which documents were found.
 */
export class RecallAtK implements RetrievalMetric {
  private readonly _name: string;
  private readonly _minScore: number;

  constructor(options: { readonly name?: string; readonly minScore?: number } = {}) {
    this._name = options.name ?? 'recall@k';
    this._minScore = options.minScore ?? 1.0;
  }

  get name(): string {
    return this._name;
  }

  get deterministic(): boolean {
    return true;
  }

  async score(entry: RetrievalCase, retrieved: RetrievalResult): Promise<MetricResult> {
    const expected = new Set(entry.expectDocs);
    const foundInTop = new Set(retrieved.docIds.slice(0, entry.k));
    const found = new Set([...expected].filter((docId) => foundInTop.has(docId)));
    const score = found.size / expected.size;
    const missing = [...expected]
      .filter((docId) => !found.has(docId))
      .sort((left, right) => (left < right ? -1 : 1));
    return new MetricResult({
      metric: this.name,
      score,
      passed: score >= this._minScore,
      detail: missing.length === 0 ? '' : `missing: ${missing.join(', ')}`,
    });
  }
}

/**
 * Reciprocal rank of the first expected document, averaged over cases.
 *
 * Scored per case, so the "mean" is taken by the gate across cases and runs. One
 * number per case keeps the metric a drop-in for the gate's per-case arithmetic.
 */
export class MeanReciprocalRank implements RetrievalMetric {
  private readonly _name: string;
  private readonly _minScore: number;

  constructor(options: { readonly name?: string; readonly minScore?: number } = {}) {
    this._name = options.name ?? 'mrr';
    this._minScore = options.minScore ?? 0.5;
  }

  get name(): string {
    return this._name;
  }

  get deterministic(): boolean {
    return true;
  }

  async score(entry: RetrievalCase, retrieved: RetrievalResult): Promise<MetricResult> {
    const expected = new Set(entry.expectDocs);
    const ranked = retrieved.docIds.slice(0, entry.k);
    for (const [offset, docId] of ranked.entries()) {
      if (expected.has(docId)) {
        const rank = offset + 1;
        const score = 1.0 / rank;
        return new MetricResult({
          metric: this.name,
          score,
          passed: score >= this._minScore,
          detail: `first expected document ${repr(docId)} at rank ${rank}`,
        });
      }
    }
    const sortedExpected = [...expected].sort((left, right) => (left < right ? -1 : 1));
    return new MetricResult({
      metric: this.name,
      score: 0.0,
      passed: this._minScore <= 0.0,
      detail: `none of ${sortedExpected.join(', ')} were retrieved within k=${entry.k}`,
    });
  }
}

/**
 * Fraction of expected documents that a returned item cites *correctly*.
 *
 * Distinct from recall because it scores citations rather than document ids, and
 * because it checks integrity first: a citation whose `chunkId` or `docId` disagrees
 * with the passage it is attached to is worse than a missing citation, since it sends
 * a reader to the wrong place while looking authoritative. Any such mismatch scores 0
 * regardless of what was retrieved.
 *
 * This definition is authored here: the IR has no citation metric kind, so there is
 * no upstream semantics to match. It is stated rather than derived.
 */
export class CitationGrounding implements RetrievalMetric {
  private readonly _name: string;
  private readonly _minScore: number;

  constructor(options: { readonly name?: string; readonly minScore?: number } = {}) {
    this._name = options.name ?? 'citation-grounding';
    this._minScore = options.minScore ?? 1.0;
  }

  get name(): string {
    return this._name;
  }

  get deterministic(): boolean {
    return true;
  }

  async score(entry: RetrievalCase, retrieved: RetrievalResult): Promise<MetricResult> {
    const broken = retrieved.items.filter(
      (item) =>
        item.citation.chunkId !== item.chunk.chunkId || item.citation.docId !== item.chunk.docId,
    );
    const first = broken[0];
    if (first !== undefined) {
      return new MetricResult({
        metric: this.name,
        score: 0.0,
        passed: false,
        detail:
          `${broken.length} citation(s) disagree with the passage they name, ` +
          `first: ${first.citation.toString()} vs chunk ${first.chunk.chunkId}`,
      });
    }
    const expected = new Set(entry.expectDocs);
    const cited = new Set(retrieved.items.map((item) => item.citation.docId));
    const grounded = new Set([...expected].filter((docId) => cited.has(docId)));
    const score = grounded.size / expected.size;
    const missing = [...expected]
      .filter((docId) => !grounded.has(docId))
      .sort((left, right) => (left < right ? -1 : 1));
    return new MetricResult({
      metric: this.name,
      score,
      passed: score >= this._minScore,
      detail: missing.length === 0 ? '' : `uncited: ${missing.join(', ')}`,
    });
  }
}

/** The retrieval metrics this runtime ships, in a stable order. */
export function retrievalMetrics(): readonly RetrievalMetric[] {
  return [new RecallAtK(), new MeanReciprocalRank(), new CitationGrounding()];
}
