/**
 * Ingesting a corpus and retrieving from it.
 *
 * This is the module a later layer's generated code calls: `ingest` once per
 * refresh, `retrieve` per query. It is deliberately not a command-line entry point --
 * the generated module is the intended surface, and a runtime that also shipped a
 * `main` would grow a second, competing one.
 *
 * Both halves are orchestration over injected seams. Nothing here chooses a model by
 * name, because the binding already carries the resolved model id, the vector width
 * and the store kind; resolving any of those at run time is exactly what the pinning
 * rule forbids.
 *
 * Cost is charged to the existing ledger using the existing profile. The IR quotes
 * embedding prices per MTok and `CostProfile` quotes per 1k tokens; that conversion
 * happens once, in `pinnedEmbedding`, so no call site repeats it.
 *
 * Candidates: the retriever fetches more than `topK` candidates from each ranking
 * before fusing, because fusion and reranking both reorder, and a fused list built
 * from only `topK` inputs has nothing to reorder. `topK` is applied to the *result*,
 * which is what the IR field means.
 */

import { type Budget, type CostLedger, LedgerEntry } from '../cost.js';
import { ConfigurationError } from '../errors.js';
import { repr } from '../internal/json.js';
import { TokenUsage } from '../types.js';
import { chunkerFor } from './chunking.js';
import { cite, RetrievalResult, RetrievedItem } from './citations.js';
import { type Connector, openConnector, type SourceDocument } from './connectors.js';
import { type Embedder, type EmbeddingBatch, embedderFor } from './embedding.js';
import { compileFilters, type Filter, matchesAll } from './filters.js';
import { fuse, lexicalRanking } from './hybrid.js';
import { type Reranker, rerankerFor } from './rerank.js';
import { createStore, type SearchHit, StoreRecord, type VectorStore } from './stores.js';
import { type Chunk, type RetrieverBinding, ScoredChunk } from './types.js';

/**
 * How many candidates per ranking are fetched before fusion. Four is a round number
 * with a defensible property: it lets a passage ranked 4th lexically and 1st by
 * vector similarity reach the top of the fused list, which is the case fusion exists
 * to fix.
 */
export const DEFAULT_CANDIDATE_FACTOR = 4;

/** Texts per embedding request. */
const BATCH_SIZE = 64;

/**
 * What one ingest wrote.
 *
 * `chunkIds` is the load-bearing field for idempotence: it is sorted, so two ingests
 * of identical input compare equal without depending on the order the filesystem
 * happened to yield. `costUsd` is what *this* ingest charged, not the ledger's
 * running total, so ingesting twice reads as two separate spends.
 *
 * `written` counts chunks upserted and `reused` counts chunks an incremental ingest
 * found already stored and therefore did not embed; `written + reused` is `chunks`.
 * `removed` counts chunks deleted because their document no longer yields them. All
 * three are zero-or-more, and all but `written` are zero for a `full` refresh, which
 * never reads the index and never deletes from it.
 */
export class IngestReport {
  readonly retriever: string;
  readonly documents: number;
  readonly chunks: number;
  readonly written: number;
  readonly tokens: number;
  readonly costUsd: number;
  readonly chunkIds: readonly string[];
  readonly reused: number;
  readonly removed: number;

  constructor(init: {
    readonly retriever: string;
    readonly documents: number;
    readonly chunks: number;
    readonly written: number;
    readonly tokens: number;
    readonly costUsd: number;
    readonly chunkIds: readonly string[];
    readonly reused?: number;
    readonly removed?: number;
  }) {
    this.retriever = init.retriever;
    this.documents = init.documents;
    this.chunks = init.chunks;
    this.written = init.written;
    this.tokens = init.tokens;
    this.costUsd = init.costUsd;
    this.chunkIds = [...init.chunkIds];
    this.reused = init.reused ?? 0;
    this.removed = init.removed ?? 0;
  }

  get isEmpty(): boolean {
    return this.chunks === 0;
  }
}

export interface RetrieverOptions {
  readonly embedder?: Embedder;
  readonly store?: VectorStore;
  readonly reranker?: Reranker | null;
  readonly connector?: Connector | null;
  readonly ledger?: CostLedger;
  readonly budget?: Budget;
  readonly baseDir?: string | null;
  readonly candidateFactor?: number;
}

/**
 * A bound retriever: its source, its chunker, its embedder, its store.
 *
 * Seams are injectable and default from the binding. Tests inject the fake embedder
 * and an in-memory store; generated code passes the real ones.
 */
export class Retriever {
  private readonly _binding: RetrieverBinding;
  private readonly _embedder: Embedder;
  private readonly _store: VectorStore;
  private readonly _reranker: Reranker | null;
  private _connector: Connector | null;
  private readonly _baseDir: string | null;
  private readonly _ledger: CostLedger | undefined;
  private readonly _budget: Budget | undefined;
  private readonly _candidateFactor: number;
  private readonly _filters: readonly Filter[];
  private _closed = false;

  constructor(binding: RetrieverBinding, options: RetrieverOptions = {}) {
    // The IR type admits two modes, but a hand-built IR can carry anything. Treating an
    // unknown value as `full` would be a silent difference between what was declared and
    // what ran, which is the failure the runtime exists to avoid.
    if (binding.refreshMode !== 'full' && binding.refreshMode !== 'incremental') {
      throw new ConfigurationError(
        `refresh mode ${repr(binding.refreshMode)} is not one this runtime implements`,
      );
    }
    const candidateFactor = options.candidateFactor ?? DEFAULT_CANDIDATE_FACTOR;
    if (candidateFactor < 1) {
      throw new ConfigurationError('candidate_factor must be at least 1');
    }
    this._binding = binding;
    this._embedder = options.embedder ?? embedderFor(binding.embedding);
    this._store =
      options.store ??
      createStore(binding.storeKind, {
        uri: binding.storeUri,
        dimensions: binding.embedding.dimensions,
      });
    this._reranker = options.reranker ?? rerankerFor(binding.rerank);
    this._connector = options.connector ?? null;
    this._baseDir = options.baseDir ?? null;
    this._ledger = options.ledger;
    this._budget = options.budget;
    this._candidateFactor = candidateFactor;
    // Compiled once: a malformed selector is a construction fault, not a per-query one.
    this._filters = compileFilters(binding.filters);
  }

  get binding(): RetrieverBinding {
    return this._binding;
  }

  get store(): VectorStore {
    return this._store;
  }

  /**
   * Chunk a source, embed it, and write it.
   *
   * Idempotent by construction: chunk ids are content hashes and the store upserts on
   * them, so ingesting the same input twice replaces rather than duplicates.
   * Re-ingesting is therefore a legitimate way to refresh a corpus.
   *
   * `refresh.mode` decides what the second run redoes. `full` -- the default -- embeds
   * and upserts every chunk and never reads or deletes from the index, so dropping a
   * document from the source leaves its vectors behind. `incremental` instead
   * reconciles the index with the source: a chunk the store already holds keeps its
   * vector, a stored chunk the source no longer yields is deleted, and only new chunks
   * are embedded.
   *
   * Incremental therefore treats what it is given as the *whole* corpus, whether that
   * came from the connector or from an explicit `documents` argument. Passing a subset
   * of the corpus in incremental mode deletes the rest, exactly as narrowing the
   * source glob would; the mode is a reconciliation, not a merge.
   */
  async ingest(documents?: readonly SourceDocument[] | null): Promise<IngestReport> {
    const incremental = this._binding.refreshMode === 'incremental';
    const sourceDocuments = documents != null ? [...documents] : await this._readSource();
    const chunker = chunkerFor(this._binding.chunking);
    const chunks: Chunk[] = [];
    for (const document of sourceDocuments) {
      for (const chunk of chunker.chunk(document)) {
        chunks.push(chunk);
      }
    }

    let toEmbed = chunks;
    let removed = 0;
    if (incremental) {
      const stored = new Set(await this._store.chunkIds());
      const current = new Set(chunks.map((chunk) => chunk.chunkId));
      const stale = [...stored].filter((chunkId) => !current.has(chunkId)).sort();
      if (stale.length > 0) {
        removed = await this._store.delete(stale);
      }
      toEmbed = chunks.filter((chunk) => !stored.has(chunk.chunkId));
    }

    const records: StoreRecord[] = [];
    let tokens = 0;
    let cost = 0.0;
    for (let start = 0; start < toEmbed.length; start += BATCH_SIZE) {
      const batch = toEmbed.slice(start, start + BATCH_SIZE);
      const embedded = await this._embed(batch.map((chunk) => chunk.text));
      tokens += embedded.batch.usage.inputTokens;
      cost += embedded.costUsd;
      const batchVectors = embedded.batch.vectors;
      if (batchVectors.length !== batch.length) {
        throw new ConfigurationError(
          `the embedder returned ${batchVectors.length} vectors for ${batch.length} texts`,
        );
      }
      batch.forEach((chunk, offset) => {
        records.push(new StoreRecord({ chunk, vector: batchVectors[offset] as number[] }));
      });
    }

    const written = await this._store.upsert(records);
    return new IngestReport({
      retriever: this._binding.retrieverId,
      documents: sourceDocuments.length,
      chunks: chunks.length,
      written,
      reused: chunks.length - toEmbed.length,
      removed,
      tokens,
      costUsd: cost,
      chunkIds: chunks.map((chunk) => chunk.chunkId).sort((left, right) => (left < right ? -1 : 1)),
    });
  }

  /** Search the store for `query` and return ranked, cited passages. */
  async retrieve(
    query: string,
    options: { readonly topK?: number | null } = {},
  ): Promise<RetrievalResult> {
    const wanted = options.topK ?? this._binding.topK;
    if (wanted < 1) {
      throw new ConfigurationError('top_k must be at least 1');
    }

    const queryBatch = await this._embed([query]);
    const vector = queryBatch.batch.vectors[0];
    if (vector === undefined) {
      throw new ConfigurationError('the embedder returned no vector for the query');
    }
    const candidates = wanted * this._candidateFactor;
    const hits = await this._searchVector(vector, candidates);
    const ranked = await this._rank(query, hits, candidates, this._filters);
    let items: readonly RetrievedItem[] = toItems(ranked);
    if (this._reranker !== null) {
      const topN = this._binding.rerank?.topN ?? wanted;
      items = await this._reranker.rerank(query, items, { topN });
    }
    return new RetrievalResult({
      retriever: this._binding.retrieverId,
      query,
      items: items.slice(0, wanted),
    });
  }

  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    await this._store.close();
    await this._embedder.close();
    if (this._connector !== null) {
      await this._connector.close();
    }
  }

  private async _readSource(): Promise<readonly SourceDocument[]> {
    if (this._connector === null) {
      this._connector = openConnector(this._binding.source, { baseDir: this._baseDir });
    }
    return this._connector.documents();
  }

  /**
   * Embed a batch, charge it to the ledger, and report what it cost.
   *
   * The cost is returned as well as charged so a caller can report what one operation
   * spent: the ledger's total is cumulative across every call the process made, and
   * reporting that as this ingest's cost would double-count.
   */
  private async _embed(
    texts: readonly string[],
  ): Promise<{ readonly batch: EmbeddingBatch; readonly costUsd: number }> {
    const batch = await this._embedder.embed(texts, { model: this._binding.embedding });
    const usage = new TokenUsage({
      inputTokens: batch.usage.inputTokens,
      outputTokens: batch.usage.outputTokens,
    });
    // Priced through CostProfile rather than a ModelSpec: a ModelSpec requires a
    // context window and an output ceiling, and fabricating those to reuse a pricing
    // helper would put invented numbers in a generated artifact.
    const costUsd = this._binding.embedding.cost.costUsd(usage);
    if (this._ledger !== undefined) {
      this._ledger.charge(
        this._budget,
        new LedgerEntry({
          alias: this._binding.embedModel,
          model: this._binding.embedding.modelId,
          provider: this._binding.embedding.provider,
          usage,
          costUsd,
        }),
      );
    }
    return { batch, costUsd };
  }

  /**
   * Vector search, widened until `wanted` passages survive the filters.
   *
   * A store can only apply `topK`, so a selective filter has to be satisfied by
   * looking deeper. The limit doubles until enough passages match or the store returns
   * fewer rows than were asked for -- the latter is the only signal that the corpus is
   * exhausted. With no filters this is one search at the historical candidate width,
   * so the unfiltered path is unchanged.
   */
  private async _searchVector(
    vector: readonly number[],
    width: number,
  ): Promise<readonly SearchHit[]> {
    let limit = Math.max(width, 1);
    for (;;) {
      const hits = await this._store.search(vector, {
        topK: limit,
        metric: this._binding.index.metric,
      });
      const kept = hits.filter((hit) => matchesAll(hit.record.chunk, this._filters));
      if (kept.length >= width || hits.length < limit) {
        return kept;
      }
      limit *= 2;
    }
  }

  /**
   * The candidate ranking: vector only, or fused with a lexical ranking.
   *
   * Fusion is skipped when `index.hybrid` is false, and that is the whole meaning of
   * the flag -- not "use a different metric", but "do not consult the lexical ranking
   * at all".
   *
   * The lexical half reads the stored corpus rather than the vector hits, so it is
   * filtered too. Ranking the whole corpus and filtering afterwards would let a
   * passage outside the selector re-enter through BM25, which is the one way a filter
   * could silently match more than it says.
   */
  private async _rank(
    query: string,
    hits: readonly SearchHit[],
    candidates: number,
    filters: readonly Filter[] = [],
  ): Promise<readonly ScoredChunk[]> {
    if (!this._binding.index.hybrid) {
      return hits.map((hit) => new ScoredChunk({ chunk: hit.record.chunk, score: hit.score }));
    }

    const stored = await this._store.corpus();
    const corpus =
      filters.length === 0 ? stored : stored.filter((record) => matchesAll(record.chunk, filters));
    const byId = new Map<string, StoreRecord>();
    for (const record of corpus) {
      byId.set(record.chunk.chunkId, record);
    }
    for (const hit of hits) {
      if (!byId.has(hit.record.chunk.chunkId)) {
        byId.set(hit.record.chunk.chunkId, hit.record);
      }
    }
    const lexical = lexicalRanking(
      corpus.map((record) => record.chunk.text),
      corpus.map((record) => record.chunk.chunkId),
      query,
      { topK: candidates },
    );
    const fused = fuse([
      hits.map((hit) => hit.record.chunk.chunkId),
      lexical.map((entry) => entry.chunkId),
    ]);
    const ranked: ScoredChunk[] = [];
    for (const entry of fused) {
      const record = byId.get(entry.chunkId);
      if (record !== undefined) {
        ranked.push(new ScoredChunk({ chunk: record.chunk, score: entry.score }));
      }
    }
    return ranked;
  }
}

/** Attach provenance and assign contiguous 1-based ranks. */
function toItems(ranked: readonly ScoredChunk[]): readonly RetrievedItem[] {
  return ranked.map(
    (scored, offset) =>
      new RetrievedItem({
        chunk: scored.chunk,
        score: scored.score,
        rank: offset + 1,
        citation: cite(scored.chunk),
      }),
  );
}
