/**
 * Where vectors live and how they are searched.
 *
 * Two adapters behind one protocol: in-memory and pgvector. The in-memory store is
 * not a stand-in for a "real" one -- it is the adapter every gate runs against, so it
 * is the one whose behaviour is the contract. The pgvector adapter is covered by the
 * same expectations and by nothing else: it is locally provisioned, and no required
 * gate touches a database.
 *
 * Similarity is always reported as *higher is better*, including for L2, where the
 * raw quantity is a distance. A store that inverted its sign for one metric would
 * make every caller responsible for remembering which metric it asked for, and fusion
 * and reranking downstream would silently rank backwards.
 *
 * Lexical search is deliberately absent from the store. The store owns the vector
 * index; BM25 lives in `hybrid.ts` and reads the corpus through
 * {@link VectorStore.corpus}. That keeps one lexical implementation instead of one
 * per backend, at the cost of fetching the corpus per query -- a Phase 1
 * simplification, correct at test scale and worth revisiting when a corpus outgrows
 * memory.
 */

import { ConfigurationError, FeatureDeferredError } from '../errors.js';
import { repr } from '../internal/json.js';
import { PgVectorStore } from './pgvector.js';
import type { Chunk, DistanceMetric, StoreKind } from './types.js';

/** One chunk and its vector, exactly as it is written to a store. */
export class StoreRecord {
  readonly chunk: Chunk;
  readonly vector: readonly number[];

  constructor(init: { readonly chunk: Chunk; readonly vector: readonly number[] }) {
    this.chunk = init.chunk;
    this.vector = [...init.vector];
  }
}

/** A record and its similarity to the query, higher being better. */
export class SearchHit {
  readonly record: StoreRecord;
  readonly score: number;

  constructor(init: { readonly record: StoreRecord; readonly score: number }) {
    this.record = init.record;
    this.score = init.score;
  }
}

/**
 * Similarity of two equal-length vectors under `metric`.
 *
 * Always oriented so that a larger number means a better match.
 */
export function similarity(
  left: readonly number[],
  right: readonly number[],
  init: { readonly metric: DistanceMetric },
): number {
  if (left.length !== right.length) {
    throw new ConfigurationError(
      `cannot compare vectors of ${left.length} and ${right.length} dimensions; the query ` +
        "and the stored vectors must share the embedding's pinned width",
    );
  }
  let dot = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += (left[index] as number) * (right[index] as number);
  }
  if (init.metric === 'dot') {
    return dot;
  }
  if (init.metric === 'l2') {
    let squares = 0;
    for (let index = 0; index < left.length; index += 1) {
      const difference = (left[index] as number) - (right[index] as number);
      squares += difference * difference;
    }
    return -Math.sqrt(squares);
  }
  const leftNorm = Math.sqrt(left.reduce((total, value) => total + value * value, 0));
  const rightNorm = Math.sqrt(right.reduce((total, value) => total + value * value, 0));
  if (leftNorm === 0.0 || rightNorm === 0.0) {
    // A zero vector has no direction, so cosine similarity is undefined rather than
    // zero; returning 0.0 keeps it last without inventing a ranking.
    return 0.0;
  }
  return dot / (leftNorm * rightNorm);
}

/**
 * A vector index the retriever can ingest into and search.
 *
 * `close` must be idempotent, matching the other seams in this runtime.
 */
export interface VectorStore {
  readonly kind: StoreKind;
  /** Write records, keyed by `chunkId`. Returns the number written. */
  upsert(records: readonly StoreRecord[]): Promise<number>;
  search(
    vector: readonly number[],
    init: { readonly topK: number; readonly metric: DistanceMetric },
  ): Promise<readonly SearchHit[]>;
  /**
   * Every stored record.
   *
   * Exists for the lexical half of hybrid search, and for assertions about a store's
   * contents after re-ingest.
   */
  corpus(): Promise<readonly StoreRecord[]>;
  close(): Promise<void>;
}

/**
 * A map keyed by `chunkId`.
 *
 * The key choice is what makes ingest idempotent: re-ingesting identical input
 * recomputes identical ids and overwrites in place, so the store's contents are a
 * function of the input rather than of how many times it was ingested.
 */
export class InMemoryVectorStore implements VectorStore {
  private readonly _kind: StoreKind;
  private readonly _records = new Map<string, StoreRecord>();

  constructor(init: { readonly kind?: StoreKind } = {}) {
    this._kind = init.kind ?? 'memory';
  }

  get kind(): StoreKind {
    return this._kind;
  }

  async upsert(records: readonly StoreRecord[]): Promise<number> {
    for (const record of records) {
      this._records.set(record.chunk.chunkId, record);
    }
    return records.length;
  }

  async search(
    vector: readonly number[],
    init: { readonly topK: number; readonly metric: DistanceMetric },
  ): Promise<readonly SearchHit[]> {
    if (init.topK < 1) {
      throw new ConfigurationError('top_k must be at least 1');
    }
    const hits = [...this._records.values()].map(
      (record) => new SearchHit({ record, score: similarity(vector, record.vector, init) }),
    );
    // Ties break on chunk id, never on insertion order: two runs that ingest the same
    // corpus in a different order must produce the same ranking.
    hits.sort((left, right) =>
      left.score !== right.score
        ? right.score - left.score
        : left.record.chunk.chunkId < right.record.chunk.chunkId
          ? -1
          : 1,
    );
    return hits.slice(0, init.topK);
  }

  async corpus(): Promise<readonly StoreRecord[]> {
    return [...this._records.keys()]
      .sort((left, right) => (left < right ? -1 : 1))
      .map((chunkId) => this._records.get(chunkId) as StoreRecord);
  }

  async close(): Promise<void> {
    // The in-memory store owns no external resource, so there is nothing to release.
    return Promise.resolve();
  }
}

/**
 * Select a store adapter.
 *
 * `pgvector.ts` is imported statically but loads its database driver lazily on first
 * connect, so importing this module still pulls in no driver: the optional-extra
 * property the Python adapter preserves at import time is preserved here at connect
 * time instead. It keeps `createStore` synchronous, which is what the retriever's
 * constructor needs.
 */
export function createStore(
  kind: StoreKind,
  init: { readonly uri?: string | null; readonly dimensions?: number | null } = {},
): VectorStore {
  if (kind === 'memory') {
    return new InMemoryVectorStore();
  }
  if (kind === 'pgvector') {
    return new PgVectorStore({ uri: init.uri ?? null, dimensions: init.dimensions ?? null });
  }
  throw new FeatureDeferredError(
    `vector store kind ${repr(kind)} is declared in the IR but has no adapter in this ` +
      "runtime; Phase 1 ships 'memory' and 'pgvector'",
  );
}
