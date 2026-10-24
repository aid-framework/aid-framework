/**
 * Reordering a retrieved set before it is returned.
 *
 * Exactly one reranker exists in Phase 1, and it is lexical. That is a deliberate
 * limitation rather than an unfinished one: the seam is what this layer owes, and the
 * deterministic implementation is what lets a gate assert on ranking behaviour
 * without an API key or a floating cross-encoder.
 *
 * Why rerank at all when hybrid search already blends two rankings? Because fusion
 * answers "which candidates are worth considering" and reranking answers "which of
 * these best answers the question", and the second question can look at the query and
 * one passage together instead of at ranks alone. The lexical reranker does that with
 * query-term coverage, which is cheap, explainable, and stable.
 *
 * The reranker **replaces** each item's score instead of adding a second number. After
 * reranking, the number that ranks the list is the reranker's, and keeping a fused RRF
 * value in the same field would put two incomparable scales in one place. Ranks are
 * renumbered from 1 so {@link RetrievalResult.context} stays resolvable.
 */

import { ConfigurationError, FeatureDeferredError } from '../errors.js';
import { repr } from '../internal/json.js';
import { cite, RetrievedItem } from './citations.js';
import { tokenize } from './hybrid.js';
import type { RerankSpec } from './types.js';

const LEXICAL_MARKER = 'lexical';

/**
 * How much of `query` the passage actually covers, in `[0, 1]`.
 *
 * Query-term coverage, not term frequency: for "which passages answer this", a
 * passage containing each distinct query term once is as good a candidate as one
 * repeating a term, and rewarding repetition is how a keyword-stuffed chunk wins. An
 * exact phrase match breaks ties toward the passage quoting the query.
 */
export function lexicalScore(query: string, text: string): number {
  const terms = new Set(tokenize(query));
  if (terms.size === 0) return 0.0;
  const present = new Set(tokenize(text));
  let coverage = 0;
  for (const term of terms) {
    if (present.has(term)) coverage += 1;
  }
  coverage /= terms.size;
  const trimmed = query.trim();
  if (trimmed.length > 0 && text.toLowerCase().includes(trimmed.toLowerCase())) {
    // Small and bounded, so it can only order passages that already cover the query
    // equally well; it can never promote an unrelated passage.
    return Math.min(1.0, coverage + 0.1);
  }
  return coverage;
}

/** Reorder candidates for a query, deterministically. */
export interface Reranker {
  readonly name: string;
  rerank(
    query: string,
    items: readonly RetrievedItem[],
    init: { readonly topN: number },
  ): Promise<readonly RetrievedItem[]>;
}

/** Coverage-based reranking, with ties broken on chunk id. */
export class LexicalReranker implements Reranker {
  private readonly _name: string;

  constructor(init: { readonly name?: string } = {}) {
    this._name = init.name ?? 'lexical';
  }

  get name(): string {
    return this._name;
  }

  async rerank(
    query: string,
    items: readonly RetrievedItem[],
    init: { readonly topN: number },
  ): Promise<readonly RetrievedItem[]> {
    if (init.topN < 1) {
      throw new ConfigurationError('rerank top_n must be at least 1');
    }
    const scored = items.map((item) => ({
      score: lexicalScore(query, item.chunk.text),
      chunkId: item.chunk.chunkId,
      item,
    }));
    // A reranker that cannot read the query leaves the incoming order alone rather
    // than shuffling it: every score is 0.0, so the tie-break would be chunk-id
    // order, which is an arbitrary order dressed up as a decision.
    if (scored.every((entry) => entry.score === 0.0)) {
      return items.slice(0, init.topN);
    }
    scored.sort((left, right) =>
      left.score !== right.score ? right.score - left.score : left.chunkId < right.chunkId ? -1 : 1,
    );
    return scored.slice(0, init.topN).map(
      (entry, offset) =>
        new RetrievedItem({
          chunk: entry.item.chunk,
          score: entry.score,
          rank: offset + 1,
          citation: cite(entry.item.chunk),
        }),
    );
  }
}

/**
 * The reranker a retriever's `rerank` block asks for, if any.
 *
 * `rerank.model` is free-form in the IR, and Phase 1 ships exactly one
 * implementation. A declared model outside the lexical family is refused rather than
 * quietly served by {@link LexicalReranker}, for the same reason an unimplemented
 * source kind or store kind is refused: a retriever that appears to rerank with a
 * cross-encoder it never called is worse than one that says it cannot. The guard
 * matches on the name because the name is the only signal the IR gives; the lexical
 * family is what this runtime can honestly claim.
 */
export function rerankerFor(spec: RerankSpec | null): Reranker | null {
  if (spec === null) return null;
  if (!spec.model.toLowerCase().includes(LEXICAL_MARKER)) {
    throw new FeatureDeferredError(
      `rerank model ${repr(spec.model)} is declared but not implemented: Phase 1 ships one ` +
        'deterministic lexical reranker, and a hosted cross-encoder is a later layer',
    );
  }
  return new LexicalReranker();
}
