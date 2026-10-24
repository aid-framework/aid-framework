/**
 * Shapes the retrieval runtime shares across its modules.
 *
 * Two families live here and the split is deliberate.
 *
 * * The **IR mirror** models (`SourceSpec`, `ChunkingSpec`, `IndexSpec`,
 *   `RerankSpec`, `RefreshSpec`, `RetrieverSpec`, `EmbeddingSpec`,
 *   `VectorStoreSpec`) reproduce the L1 IR's `retrievers` / `embeddings` /
 *   `stores` entries field for field. The IR spells these in camelCase
 *   (`keepMetadata`, `embedModel`, `topK`, `inputPerMTok`, ...) and so does this
 *   file, because in TypeScript the IR's own spelling *is* the natural one: there
 *   is no second vocabulary to translate from. Enum values are the IR's own
 *   strings (`recursive`, `pgvector`, `cosine`) and are never re-spelled.
 * * The **resolved** models (`PinnedEmbedding`, `RetrieverBinding`) are what
 *   generated code binds with literals. They carry the exact embedding model id
 *   rather than an alias, so a run is reproducible from the generated source
 *   alone and nothing is resolved at run time.
 */

import { ConfigurationError, FeatureDeferredError } from '../errors.js';
import { repr, sha256Parts } from '../internal/json.js';
import { CostProfile } from '../types.js';

/** `retriever.index.metric`. */
export type DistanceMetric = 'cosine' | 'dot' | 'l2';

export const DISTANCE_METRICS: readonly DistanceMetric[] = ['cosine', 'dot', 'l2'];

/**
 * `retriever.source.kind`.
 *
 * `file` is the only kind the Phase 1 connector implements; the rest are part of
 * the IR contract and fail loudly rather than silently indexing nothing.
 */
export type SourceKind = 'file' | 's3' | 'http' | 'db' | 'mcp';

/** `retriever.chunking.strategy`. */
export type ChunkingStrategy = 'fixed' | 'recursive' | 'semantic' | 'code';

/** `vectorStore.kind`. */
export type StoreKind = 'memory' | 'pgvector' | 'qdrant' | 'pinecone' | 'weaviate' | 'custom';

/** `retriever.refresh.mode`. Only `full` is implemented. */
export type RefreshMode = 'full' | 'incremental';

function requireNonEmpty(value: string, label: string): string {
  if (value.length === 0) {
    throw new ConfigurationError(`${label} must not be empty`);
  }
  return value;
}

function requirePositiveInt(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigurationError(`${label} must be a positive integer`);
  }
  return value;
}

function requireNonNegativeInt(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new ConfigurationError(`${label} must be a non-negative integer`);
  }
  return value;
}

/** `retriever.source`. */
export class SourceSpec {
  readonly kind: SourceKind;
  readonly uri: string;
  readonly glob: string | null;

  constructor(init: {
    readonly kind: SourceKind;
    readonly uri: string;
    readonly glob?: string | null;
  }) {
    this.kind = init.kind;
    this.uri = init.uri;
    this.glob = init.glob ?? null;
  }
}

/** `retriever.chunking`. */
export class ChunkingSpec {
  readonly strategy: ChunkingStrategy;
  readonly size: number;
  readonly overlap: number;
  readonly keepMetadata: readonly string[];

  constructor(init: {
    readonly strategy: ChunkingStrategy;
    readonly size: number;
    readonly overlap: number;
    readonly keepMetadata?: readonly string[];
  }) {
    this.strategy = init.strategy;
    this.size = requirePositiveInt(init.size, 'chunking size');
    this.overlap = requireNonNegativeInt(init.overlap, 'chunking overlap');
    this.keepMetadata = [...(init.keepMetadata ?? [])];
  }
}

/** `retriever.index`. */
export class IndexSpec {
  readonly metric: DistanceMetric;
  readonly hybrid: boolean;
  readonly params: Readonly<Record<string, unknown>> | null;

  constructor(init: {
    readonly metric: DistanceMetric;
    readonly hybrid: boolean;
    readonly params?: Readonly<Record<string, unknown>> | null;
  }) {
    this.metric = init.metric;
    this.hybrid = init.hybrid;
    this.params = init.params ?? null;
  }
}

/** `retriever.rerank`. */
export class RerankSpec {
  readonly model: string;
  readonly topN: number;

  constructor(init: { readonly model: string; readonly topN: number }) {
    this.model = init.model;
    this.topN = requirePositiveInt(init.topN, 'rerank topN');
  }
}

/** `retriever.refresh`. */
export class RefreshSpec {
  readonly mode: RefreshMode;
  readonly schedule: string | null;

  constructor(init: { readonly mode: RefreshMode; readonly schedule?: string | null }) {
    this.mode = init.mode;
    this.schedule = init.schedule ?? null;
  }
}

/** One entry of the IR's `retrievers` map. */
export class RetrieverSpec {
  readonly id: string;
  readonly source: SourceSpec;
  readonly chunking: ChunkingSpec;
  readonly embedModel: string;
  readonly store: string;
  readonly index: IndexSpec;
  readonly topK: number;
  readonly rerank: RerankSpec | null;
  readonly filters: readonly string[] | null;
  readonly refresh: RefreshSpec;
  readonly traits: readonly string[];

  constructor(init: {
    readonly id: string;
    readonly source: SourceSpec;
    readonly chunking: ChunkingSpec;
    readonly embedModel: string;
    readonly store: string;
    readonly index: IndexSpec;
    readonly topK: number;
    readonly rerank?: RerankSpec | null;
    readonly filters?: readonly string[] | null;
    readonly refresh: RefreshSpec;
    readonly traits?: readonly string[];
  }) {
    this.id = requireNonEmpty(init.id, 'retriever id');
    this.source = init.source;
    this.chunking = init.chunking;
    this.embedModel = init.embedModel;
    this.store = init.store;
    this.index = init.index;
    this.topK = requirePositiveInt(init.topK, 'retriever topK');
    this.rerank = init.rerank ?? null;
    this.filters = init.filters === undefined || init.filters === null ? null : [...init.filters];
    this.refresh = init.refresh;
    this.traits = [...(init.traits ?? [])];
  }
}

/**
 * `embedding.costProfile` -- USD per **million** tokens.
 *
 * Not interchangeable with {@link CostProfile}, which prices per *thousand*
 * tokens because it predates the IR. {@link pinnedEmbedding} is the single place
 * the two are converted, so the factor of 1000 is stated once rather than assumed
 * at every call site.
 */
export class EmbeddingCostProfile {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;

  constructor(init: { readonly inputPerMTok: number; readonly outputPerMTok: number }) {
    for (const [label, value] of [
      ['inputPerMTok', init.inputPerMTok],
      ['outputPerMTok', init.outputPerMTok],
    ] as const) {
      if (!Number.isFinite(value) || value < 0) {
        throw new ConfigurationError(`${label} must be a non-negative number`);
      }
    }
    this.inputPerMTok = init.inputPerMTok;
    this.outputPerMTok = init.outputPerMTok;
  }
}

/**
 * One entry of the IR's `embeddings` map.
 *
 * `id` is the *alias* a retriever's `embedModel` names -- the resolution the
 * runtime must never repeat at run time.
 */
export class EmbeddingSpec {
  readonly id: string;
  readonly provider: string;
  readonly modelId: string;
  readonly dimensions: number | null;
  readonly costProfile: EmbeddingCostProfile | null;
  readonly traits: readonly string[];

  constructor(init: {
    readonly id: string;
    readonly provider: string;
    readonly modelId: string;
    readonly dimensions?: number | null;
    readonly costProfile?: EmbeddingCostProfile | null;
    readonly traits?: readonly string[];
  }) {
    this.id = requireNonEmpty(init.id, 'embedding id');
    this.provider = init.provider;
    this.modelId = init.modelId;
    this.dimensions = init.dimensions === undefined ? null : init.dimensions;
    if (this.dimensions !== null) {
      requirePositiveInt(this.dimensions, 'embedding dimensions');
    }
    this.costProfile = init.costProfile ?? null;
    this.traits = [...(init.traits ?? [])];
  }
}

/** One entry of the IR's `stores` map. */
export class VectorStoreSpec {
  readonly id: string;
  readonly kind: StoreKind;
  readonly uri: string | null;
  readonly dimensions: number | null;
  readonly traits: readonly string[];

  constructor(init: {
    readonly id: string;
    readonly kind: StoreKind;
    readonly uri?: string | null;
    readonly dimensions?: number | null;
    readonly traits?: readonly string[];
  }) {
    this.id = requireNonEmpty(init.id, 'store id');
    this.kind = init.kind;
    this.uri = init.uri ?? null;
    this.dimensions = init.dimensions === undefined ? null : init.dimensions;
    if (this.dimensions !== null) {
      requirePositiveInt(this.dimensions, 'store dimensions');
    }
    this.traits = [...(init.traits ?? [])];
  }
}

/** The IR's `retrieval` metric variant: `{kind, expectDocs, k}`. */
export class RetrievalMetricSpec {
  readonly kind: 'retrieval';
  readonly expectDocs: readonly string[];
  readonly k: number;

  constructor(init: { readonly expectDocs: readonly string[]; readonly k: number }) {
    this.kind = 'retrieval';
    this.expectDocs = [...init.expectDocs];
    this.k = requirePositiveInt(init.k, 'retrieval metric k');
  }
}

/**
 * An `embedModel` alias already resolved to an exact embedding model.
 *
 * The same contract as `PinnedModel`: a baseline recorded against
 * `text-embedding-3-small` means nothing if the alias floats to another
 * revision, so the resolved id, the dimensions and the price are all *recorded
 * inputs* rather than lookups a run performs.
 */
export class PinnedEmbedding {
  readonly alias: string;
  readonly provider: string;
  readonly modelId: string;
  readonly dimensions: number;
  readonly cost: CostProfile;

  constructor(init: {
    readonly alias: string;
    readonly provider: string;
    readonly modelId: string;
    readonly dimensions: number;
    readonly cost: CostProfile;
  }) {
    this.alias = requireNonEmpty(init.alias, 'embedding alias');
    this.provider = requireNonEmpty(init.provider, 'embedding provider');
    this.modelId = requireNonEmpty(init.modelId, 'embedding modelId');
    this.dimensions = requirePositiveInt(init.dimensions, 'embedding dimensions');
    this.cost = init.cost;
  }
}

/**
 * A retriever as generated code binds it, with every alias resolved.
 *
 * `embedModel` keeps the declared alias purely so cost can be attributed to the
 * name the spec used; `embedding` is the resolved model actually called.
 * `storeKind` is resolved from the store entry, because a run must not discover
 * at search time which backend it wrote to.
 *
 * `storeUri` is deliberately kept *unresolved*: a hosted store's location is a
 * deployment secret, which is why the IR writes `env:PGVECTOR_URL` rather than a
 * DSN. The name is pinned in code; the value is read from the environment at run
 * time, and an environment variable is not an alias.
 */
export class RetrieverBinding {
  readonly retrieverId: string;
  readonly source: SourceSpec;
  readonly chunking: ChunkingSpec;
  readonly embedModel: string;
  readonly embedding: PinnedEmbedding;
  readonly store: string;
  readonly storeKind: StoreKind;
  readonly storeUri: string | null;
  readonly index: IndexSpec;
  readonly topK: number;
  readonly rerank: RerankSpec | null;
  readonly refreshMode: RefreshMode;
  readonly traits: readonly string[];

  constructor(init: {
    readonly retrieverId: string;
    readonly source: SourceSpec;
    readonly chunking: ChunkingSpec;
    readonly embedModel: string;
    readonly embedding: PinnedEmbedding;
    readonly store: string;
    readonly storeKind: StoreKind;
    readonly storeUri?: string | null;
    readonly index: IndexSpec;
    readonly topK: number;
    readonly rerank?: RerankSpec | null;
    readonly refreshMode?: RefreshMode;
    readonly traits?: readonly string[];
  }) {
    this.retrieverId = requireNonEmpty(init.retrieverId, 'retrieverId');
    this.source = init.source;
    this.chunking = init.chunking;
    this.embedModel = requireNonEmpty(init.embedModel, 'embedModel');
    this.embedding = init.embedding;
    this.store = requireNonEmpty(init.store, 'store');
    this.storeKind = init.storeKind;
    this.storeUri = init.storeUri ?? null;
    this.index = init.index;
    this.topK = requirePositiveInt(init.topK, 'retriever topK');
    this.rerank = init.rerank ?? null;
    this.refreshMode = init.refreshMode ?? 'full';
    this.traits = [...(init.traits ?? [])];
  }
}

/**
 * One indexed passage.
 *
 * `chunkId` hashes the document id, the chunk's position *and* its text. That is
 * what makes ingest idempotent: identical input re-chunks to identical ids, so a
 * second ingest replaces rather than duplicates. Position is part of the hash on
 * purpose -- two byte-identical paragraphs in one document must stay two chunks
 * instead of colliding into one.
 */
export class Chunk {
  readonly chunkId: string;
  readonly docId: string;
  readonly uri: string;
  readonly index: number;
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly metadata: Readonly<Record<string, string>>;

  constructor(init: {
    readonly chunkId: string;
    readonly docId: string;
    readonly uri?: string;
    readonly index: number;
    readonly start: number;
    readonly end: number;
    readonly text: string;
    readonly metadata?: Readonly<Record<string, string>>;
  }) {
    this.chunkId = requireNonEmpty(init.chunkId, 'chunkId');
    this.docId = requireNonEmpty(init.docId, 'docId');
    this.uri = init.uri ?? '';
    this.index = requireNonNegativeInt(init.index, 'chunk index');
    this.start = requireNonNegativeInt(init.start, 'chunk start');
    this.end = requireNonNegativeInt(init.end, 'chunk end');
    this.text = init.text;
    this.metadata = { ...(init.metadata ?? {}) };
  }
}

/** A chunk with the score that ranked it. */
export class ScoredChunk {
  readonly chunk: Chunk;
  readonly score: number;

  constructor(init: { readonly chunk: Chunk; readonly score: number }) {
    this.chunk = init.chunk;
    this.score = init.score;
  }
}

/**
 * The content hash that identifies a chunk.
 *
 * Shared by every chunker so the id scheme cannot differ between strategies; a
 * strategy that changed the id scheme would silently duplicate a corpus on
 * re-ingest instead of replacing it.
 */
export function chunkIdFor(docId: string, index: number, text: string): string {
  return `sha256:${sha256Parts([docId, String(index), text])}`;
}

/**
 * Resolve an IR embedding entry into the pinned form generated code carries.
 *
 * `dimensions` may be supplied when the IR entry omits it (the schema makes it
 * optional); it is an error to have neither, because an unpinned width would let a
 * store accept vectors a later run cannot compare against.
 */
export function pinnedEmbedding(
  spec: EmbeddingSpec,
  init: { readonly alias: string; readonly dimensions?: number | null },
): PinnedEmbedding {
  const width = init.dimensions ?? spec.dimensions;
  if (width === null || width === undefined) {
    throw new ConfigurationError(
      `embedding ${repr(spec.id)} pins no dimensions and none were supplied; the vector ` +
        'width must be recorded with the pinned model so stores stay comparable',
    );
  }
  const profile = spec.costProfile;
  // costProfile quotes USD per MTok; CostProfile quotes USD per 1k tokens.
  const scale = 1000.0;
  return new PinnedEmbedding({
    alias: init.alias,
    provider: spec.provider,
    modelId: spec.modelId,
    dimensions: width,
    cost: new CostProfile({
      inputPer1kUsd: profile === null ? 0.0 : profile.inputPerMTok / scale,
      outputPer1kUsd: profile === null ? 0.0 : profile.outputPerMTok / scale,
    }),
  });
}

/**
 * Bind one IR retriever entry to the embedding and store it names.
 *
 * `embedModel` names an *embeddings entry id*, not a provider model, and `store`
 * names a *stores entry id*. Both are checked here rather than trusted, because a
 * mistyped reference in generated code would otherwise surface as an empty or
 * mis-scored corpus far from its cause.
 */
export function bindingFromSpec(
  spec: RetrieverSpec,
  init: {
    readonly embedding: EmbeddingSpec;
    readonly store: VectorStoreSpec;
    readonly dimensions?: number | null;
  },
): RetrieverBinding {
  const { embedding, store } = init;
  if (spec.embedModel !== embedding.id) {
    throw new ConfigurationError(
      `retriever ${repr(spec.id)} names embedModel ${repr(spec.embedModel)} but embedding ` +
        `${repr(embedding.id)} was supplied`,
    );
  }
  if (spec.store !== store.id) {
    throw new ConfigurationError(
      `retriever ${repr(spec.id)} names store ${repr(spec.store)} but store ` +
        `${repr(store.id)} was supplied`,
    );
  }
  if (spec.filters !== null && spec.filters.length > 0) {
    // The spec validator already refuses filters; the runtime checks too, because
    // generated code is reachable without the validator having run.
    throw new FeatureDeferredError(
      `retriever ${repr(spec.id)} declares filters, which spec v0.1 does not implement: a ` +
        "filter would have to be pushed into every store adapter's query",
    );
  }
  const pinned = pinnedEmbedding(embedding, {
    alias: spec.embedModel,
    dimensions: init.dimensions ?? null,
  });
  if (store.dimensions !== null && store.dimensions !== pinned.dimensions) {
    throw new ConfigurationError(
      `store ${repr(store.id)} is declared ${store.dimensions}-dimensional but retriever ` +
        `${repr(spec.id)} pins ${pinned.dimensions} dimensions via embedModel ` +
        `${repr(spec.embedModel)}; the two must agree before anything is indexed`,
    );
  }
  return new RetrieverBinding({
    retrieverId: spec.id,
    source: spec.source,
    chunking: spec.chunking,
    embedModel: spec.embedModel,
    embedding: pinned,
    store: spec.store,
    storeKind: store.kind,
    storeUri: store.uri,
    index: spec.index,
    topK: spec.topK,
    rerank: spec.rerank,
    refreshMode: spec.refresh.mode,
    traits: spec.traits,
  });
}
