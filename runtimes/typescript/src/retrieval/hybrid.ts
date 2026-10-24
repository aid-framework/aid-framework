/**
 * Lexical scoring and rank fusion.
 *
 * Vector similarity cannot carry retrieval on its own, and the reason is not
 * aesthetic: cosine similarity is dominated by embedding geometry while exact terms
 * -- an identifier, an error code, a flag name -- are what a developer actually
 * greps for. So a retriever fuses a vector ranking with a lexical one.
 *
 * The lexical half is BM25, implemented here rather than delegated to a search engine
 * so that the same scoring applies to both store adapters and to a store that has no
 * database behind it.
 *
 * The fusion is Reciprocal Rank Fusion, and it fuses *ranks* rather than scores. That
 * is the whole reason to pick it: BM25 scores and cosine similarities are unbounded
 * and on incomparable scales, so any weighted score sum would need a per-corpus
 * normalisation constant that nobody can justify. Ranks are already comparable, and
 * RRF's `1 / (k + rank)` says something defensible -- being ranked highly by either
 * retriever is evidence, being ranked highly by both is stronger evidence.
 *
 * Everything here is a pure function of its inputs, so retrieval order is
 * reproducible and a re-ingested corpus ranks identically.
 */

/**
 * The RRF constant from the original formulation: it damps the influence of the very
 * top ranks so one retriever's confident first hit cannot alone decide the fused
 * order.
 */
const RRF_K = 60;

/**
 * BM25 saturation and length-normalisation. The usual defaults, and defaults are the
 * right call here: they are tuned against judged-relevance corpora, and this runtime
 * has no such corpus to tune against.
 */
const BM25_K1 = 1.5;
const BM25_B = 0.75;

const TOKEN = /[a-z0-9]+/g;

/** A ranked chunk id and the score that ranked it. */
export class RankedId {
  readonly chunkId: string;
  readonly score: number;

  constructor(init: { readonly chunkId: string; readonly score: number }) {
    if (init.chunkId.length === 0) {
      throw new RangeError('chunkId must not be empty');
    }
    this.chunkId = init.chunkId;
    this.score = init.score;
  }
}

/**
 * Lowercase alphanumeric runs.
 *
 * No stemming and no stop-word list: both are language-specific, and a retrieval
 * runtime that silently mangles identifiers by stemming them is worse at its actual
 * job than one that keeps the tokens it was given.
 */
export function tokenize(text: string): readonly string[] {
  return text.toLowerCase().match(TOKEN) ?? [];
}

/**
 * BM25 score of every document for `query`, in the order given.
 *
 * Saturated term frequency (a term repeated ten times is not ten times as
 * informative) and length normalisation (a long chunk should not win merely by
 * containing more words) -- those two properties are the reason to use BM25 rather
 * than a raw term count.
 */
export function bm25Scores(
  documents: readonly string[],
  query: string,
  options: { readonly k1?: number; readonly b?: number } = {},
): readonly number[] {
  const k1 = options.k1 ?? BM25_K1;
  const b = options.b ?? BM25_B;
  const tokenised = documents.map((document) => tokenize(document));
  const terms = tokenize(query);
  if (tokenised.length === 0 || terms.length === 0) {
    return documents.map(() => 0.0);
  }

  const total = tokenised.length;
  const lengths = tokenised.map((tokens) => tokens.length);
  const averageLength = lengths.reduce((sum, length) => sum + length, 0) / total;
  const counts = tokenised.map((tokens) => {
    const frequencies = new Map<string, number>();
    for (const token of tokens) {
      frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    }
    return frequencies;
  });

  const scores: number[] = [];
  for (const [index, frequencies] of counts.entries()) {
    const length = lengths[index] ?? 0;
    let score = 0.0;
    for (const term of terms) {
      const frequency = frequencies.get(term) ?? 0;
      if (frequency === 0) continue;
      const documentFrequency = counts.reduce(
        (count, other) => (other.has(term) ? count + 1 : count),
        0,
      );
      const inverseFrequency = Math.log(
        1.0 + (total - documentFrequency + 0.5) / (documentFrequency + 0.5),
      );
      const norm = averageLength > 0 ? 1.0 - b + b * (length / averageLength) : 1.0;
      score += (inverseFrequency * (frequency * (k1 + 1.0))) / (frequency + k1 * norm);
    }
    scores.push(score);
  }
  return scores;
}

/**
 * The `topK` documents with a non-zero lexical score, best first.
 *
 * Ties break on chunk id so that equal-scoring matches rank identically on every run
 * and in both store adapters.
 */
export function lexicalRanking(
  documents: readonly string[],
  ids: readonly string[],
  query: string,
  options: { readonly topK: number },
): readonly RankedId[] {
  if (documents.length !== ids.length) {
    throw new RangeError('documents and ids must be parallel sequences');
  }
  const scores = bm25Scores(documents, query);
  const scored: RankedId[] = [];
  for (const [index, chunkId] of ids.entries()) {
    const score = scores[index] ?? 0.0;
    if (score > 0.0) {
      scored.push(new RankedId({ chunkId, score }));
    }
  }
  scored.sort((left, right) =>
    left.score !== right.score ? right.score - left.score : left.chunkId < right.chunkId ? -1 : 1,
  );
  return scored.slice(0, options.topK);
}

/** The reciprocal-rank contribution of a 1-based `rank`. */
export function rrfScore(rank: number, options: { readonly k?: number } = {}): number {
  if (rank < 1) {
    throw new RangeError('rank is 1-based');
  }
  return 1.0 / ((options.k ?? RRF_K) + rank);
}

/**
 * Reciprocal Rank Fusion of rank-ordered id lists.
 *
 * Each ranking contributes `1 / (k + rank)` per id; an id absent from a ranking
 * contributes nothing from it. An id that appears in several rankings therefore
 * outranks one that is top of a single ranking, which is the behaviour that makes
 * fusion worth doing.
 */
export function fuse(
  rankings: readonly (readonly string[])[],
  options: { readonly k?: number } = {},
): readonly RankedId[] {
  const k = options.k ?? RRF_K;
  const totals = new Map<string, number>();
  for (const ranking of rankings) {
    for (const [offset, chunkId] of ranking.entries()) {
      totals.set(chunkId, (totals.get(chunkId) ?? 0.0) + rrfScore(offset + 1, { k }));
    }
  }
  const fused = [...totals.entries()].map(([chunkId, score]) => new RankedId({ chunkId, score }));
  fused.sort((left, right) =>
    left.score !== right.score ? right.score - left.score : left.chunkId < right.chunkId ? -1 : 1,
  );
  return fused;
}
