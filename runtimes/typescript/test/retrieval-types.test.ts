import { describe, expect, it } from 'vitest';

import {
  bindingFromSpec,
  Chunk,
  ChunkingSpec,
  ConfigurationError,
  chunkIdFor,
  DISTANCE_METRICS,
  EmbeddingCostProfile,
  EmbeddingSpec,
  FeatureDeferredError,
  IndexSpec,
  PinnedEmbedding,
  pinnedEmbedding,
  RefreshSpec,
  RerankSpec,
  RetrievalMetricSpec,
  RetrieverBinding,
  RetrieverSpec,
  SourceSpec,
  VectorStoreSpec,
} from '../src/index.js';
import {
  binding,
  chunkingSpec,
  EMBED_ALIAS,
  EMBED_DIMENSIONS,
  EMBED_ID,
  MODEL_ID,
  retrieverSpec,
  storeSpec,
} from './support.js';

describe('chunkIdFor', () => {
  it('pins the hash scheme so a re-index cannot silently duplicate a corpus', () => {
    expect(chunkIdFor('a.md', 0, 'hello')).toBe(
      'sha256:247170a6f3e8b25f6ad374f26ba9162eff1b51d6ebce1966f1e23ac48b4560d6',
    );
  });

  it('separates two byte-identical paragraphs by their position', () => {
    expect(chunkIdFor('a.md', 0, 'same')).not.toBe(chunkIdFor('a.md', 1, 'same'));
  });

  it('separates the same text in two documents', () => {
    expect(chunkIdFor('a.md', 0, 'same')).not.toBe(chunkIdFor('b.md', 0, 'same'));
  });

  it('is stable across calls', () => {
    expect(chunkIdFor('a.md', 3, 'x')).toBe(chunkIdFor('a.md', 3, 'x'));
  });
});

describe('DISTANCE_METRICS', () => {
  it('lists the three metrics in a stable order', () => {
    expect(DISTANCE_METRICS).toEqual(['cosine', 'dot', 'l2']);
  });
});

describe('ChunkingSpec', () => {
  it('carries the strategy, size, overlap and kept metadata', () => {
    const spec = new ChunkingSpec({
      strategy: 'recursive',
      size: 400,
      overlap: 40,
      keepMetadata: ['path'],
    });

    expect(spec.strategy).toBe('recursive');
    expect(spec.size).toBe(400);
    expect(spec.overlap).toBe(40);
    expect(spec.keepMetadata).toEqual(['path']);
  });

  it('defaults keepMetadata to nothing', () => {
    expect(chunkingSpec().keepMetadata).toEqual([]);
  });

  it.each([[0], [-1], [1.5]])('refuses size %s', (size) => {
    expect(() => new ChunkingSpec({ strategy: 'fixed', size, overlap: 0 })).toThrow(
      'chunking size must be a positive integer',
    );
  });

  it.each([[-1], [0.5]])('refuses overlap %s', (overlap) => {
    expect(() => new ChunkingSpec({ strategy: 'fixed', size: 10, overlap })).toThrow(
      'chunking overlap must be a non-negative integer',
    );
  });
});

describe('EmbeddingCostProfile', () => {
  it('prices per million tokens', () => {
    const profile = new EmbeddingCostProfile({ inputPerMTok: 0.02, outputPerMTok: 0.0 });

    expect(profile.inputPerMTok).toBe(0.02);
  });

  it.each([[-1], [Number.NaN], [Number.POSITIVE_INFINITY]])(
    'refuses a negative or non-finite price: %s',
    (value) => {
      expect(() => new EmbeddingCostProfile({ inputPerMTok: value, outputPerMTok: 0 })).toThrow(
        'inputPerMTok must be a non-negative number',
      );
    },
  );
});

describe('EmbeddingSpec', () => {
  it('leaves dimensions null when omitted', () => {
    const spec = new EmbeddingSpec({ id: EMBED_ID, provider: 'fake', modelId: MODEL_ID });

    expect(spec.dimensions).toBeNull();
  });

  it('refuses a non-positive declared width', () => {
    expect(
      () => new EmbeddingSpec({ id: EMBED_ID, provider: 'fake', modelId: MODEL_ID, dimensions: 0 }),
    ).toThrow('embedding dimensions must be a positive integer');
  });

  it('refuses an empty id', () => {
    expect(() => new EmbeddingSpec({ id: '', provider: 'fake', modelId: MODEL_ID })).toThrow(
      'embedding id must not be empty',
    );
  });
});

describe('PinnedEmbedding', () => {
  it('records the resolved model so a run is reproducible from source alone', () => {
    const pinned = pinnedEmbedding(
      new EmbeddingSpec({
        id: EMBED_ID,
        provider: 'openai',
        modelId: MODEL_ID,
        dimensions: 1536,
        costProfile: new EmbeddingCostProfile({ inputPerMTok: 0.02, outputPerMTok: 0 }),
      }),
      { alias: EMBED_ALIAS },
    );

    expect(pinned).toBeInstanceOf(PinnedEmbedding);
    expect(pinned.alias).toBe(EMBED_ALIAS);
    expect(pinned.provider).toBe('openai');
    expect(pinned.modelId).toBe(MODEL_ID);
    expect(pinned.dimensions).toBe(1536);
  });

  it('converts the per-MTok price to the per-1k profile exactly once', () => {
    const pinned = pinnedEmbedding(
      new EmbeddingSpec({
        id: EMBED_ID,
        provider: 'openai',
        modelId: MODEL_ID,
        dimensions: 1536,
        costProfile: new EmbeddingCostProfile({ inputPerMTok: 0.02, outputPerMTok: 2.0 }),
      }),
      { alias: EMBED_ALIAS },
    );

    expect(pinned.cost.inputPer1kUsd).toBeCloseTo(0.00002, 12);
    expect(pinned.cost.outputPer1kUsd).toBeCloseTo(0.002, 12);
  });

  it('prices a profile-less embedding at zero rather than inventing a price', () => {
    const pinned = pinnedEmbedding(
      new EmbeddingSpec({ id: EMBED_ID, provider: 'fake', modelId: MODEL_ID, dimensions: 32 }),
      { alias: EMBED_ALIAS },
    );

    expect(pinned.cost.inputPer1kUsd).toBe(0);
  });

  it('takes a supplied width when the IR entry pins none', () => {
    const pinned = pinnedEmbedding(
      new EmbeddingSpec({ id: EMBED_ID, provider: 'fake', modelId: MODEL_ID }),
      { alias: EMBED_ALIAS, dimensions: 64 },
    );

    expect(pinned.dimensions).toBe(64);
  });

  it('refuses to leave the width unpinned', () => {
    expect(() =>
      pinnedEmbedding(new EmbeddingSpec({ id: EMBED_ID, provider: 'fake', modelId: MODEL_ID }), {
        alias: EMBED_ALIAS,
      }),
    ).toThrow(/pins no dimensions and none were supplied/);
  });

  it('refuses an empty alias', () => {
    expect(() =>
      pinnedEmbedding(
        new EmbeddingSpec({
          id: EMBED_ID,
          provider: 'fake',
          modelId: MODEL_ID,
          dimensions: EMBED_DIMENSIONS,
        }),
        { alias: '' },
      ),
    ).toThrow('embedding alias must not be empty');
  });
});

describe('bindingFromSpec', () => {
  it('binds a retriever entry to the embedding and store it names', () => {
    const built = binding();

    expect(built).toBeInstanceOf(RetrieverBinding);
    expect(built.retrieverId).toBe('docs');
    expect(built.embedding.modelId).toBe(MODEL_ID);
    expect(built.storeKind).toBe('memory');
    expect(built.refreshMode).toBe('full');
  });

  it('keeps the declared alias beside the resolved model so cost is attributable', () => {
    const built = binding();

    // `embedModel` names an embeddings *entry id*, and that id is what the binding
    // records as the alias so a spend can be attributed to the spec's own name.
    expect(built.embedModel).toBe(EMBED_ID);
    expect(built.embedding.alias).toBe(EMBED_ID);
    expect(built.embedding.modelId).toBe(MODEL_ID);
  });

  it('keeps the store uri unresolved because it is a deployment secret', () => {
    const built = bindingFromSpec(retrieverSpec(), {
      embedding: storeSpecFreeEmbedding(),
      store: storeSpec({ kind: 'pgvector', uri: 'env:PGVECTOR_URL' }),
    });

    expect(built.storeUri).toBe('env:PGVECTOR_URL');
  });

  it('refuses an embedModel that does not name the supplied embedding', () => {
    expect(() =>
      bindingFromSpec(retrieverSpec(), {
        embedding: new EmbeddingSpec({
          id: 'other',
          provider: 'fake',
          modelId: MODEL_ID,
          dimensions: EMBED_DIMENSIONS,
        }),
        store: storeSpec(),
      }),
    ).toThrow(/names embedModel 'embed' but embedding 'other' was supplied/);
  });

  it('refuses a store that does not match the supplied one', () => {
    expect(() =>
      bindingFromSpec(retrieverSpec(), {
        embedding: storeSpecFreeEmbedding(),
        store: new VectorStoreSpec({ id: 'other', kind: 'memory' }),
      }),
    ).toThrow(/names store 'docs' but store 'other' was supplied/);
  });

  it('refuses a store width that disagrees with the pinned width', () => {
    expect(() =>
      bindingFromSpec(retrieverSpec(), {
        embedding: storeSpecFreeEmbedding(),
        store: storeSpec({ dimensions: 64 }),
      }),
    ).toThrow(/is declared 64-dimensional but retriever 'docs' pins 32 dimensions/);
  });

  it('defers filters rather than pushing them into some adapters only', () => {
    const withFilters = new RetrieverSpec({
      id: 'docs',
      source: new SourceSpec({ kind: 'file', uri: './docs' }),
      chunking: chunkingSpec(),
      embedModel: EMBED_ID,
      store: 'docs',
      index: new IndexSpec({ metric: 'cosine', hybrid: false }),
      topK: 4,
      filters: ['lang=en'],
      refresh: new RefreshSpec({ mode: 'full' }),
    });

    expect(() =>
      bindingFromSpec(withFilters, { embedding: storeSpecFreeEmbedding(), store: storeSpec() }),
    ).toThrow(FeatureDeferredError);
  });

  it('does not defer an empty filter list', () => {
    const built = binding();

    expect(built.index.hybrid).toBe(false);
  });

  it('carries the declared metric and topK through', () => {
    const built = binding({ metric: 'l2', topK: 9, hybrid: true });

    expect(built.index.metric).toBe('l2');
    expect(built.index.hybrid).toBe(true);
    expect(built.topK).toBe(9);
  });

  it('carries a rerank spec through', () => {
    const built = binding({ rerank: new RerankSpec({ model: 'lexical-v1', topN: 3 }) });

    expect(built.rerank?.model).toBe('lexical-v1');
  });
});

describe('other spec models', () => {
  it('refuses an empty retriever id', () => {
    expect(
      () =>
        new RetrieverSpec({
          id: '',
          source: new SourceSpec({ kind: 'file', uri: './docs' }),
          chunking: chunkingSpec(),
          embedModel: EMBED_ID,
          store: 'docs',
          index: new IndexSpec({ metric: 'cosine', hybrid: false }),
          topK: 4,
          refresh: new RefreshSpec({ mode: 'full' }),
        }),
    ).toThrow('retriever id must not be empty');
  });

  it.each([[0], [-1]])('refuses topK %s', (topK) => {
    expect(() => retrieverSpec({ topK })).toThrow('retriever topK must be a positive integer');
  });

  it('refuses a non-positive rerank topN', () => {
    expect(() => new RerankSpec({ model: 'lexical', topN: 0 })).toThrow(
      'rerank topN must be a positive integer',
    );
  });

  it('defaults the refresh schedule to null and the mode to full', () => {
    const refresh = new RefreshSpec({ mode: 'full' });

    expect(refresh.schedule).toBeNull();
  });

  it('keeps the retrieval metric k positive', () => {
    expect(() => new RetrievalMetricSpec({ expectDocs: ['a.md'], k: 0 })).toThrow(
      'retrieval metric k must be a positive integer',
    );
  });

  it('carries expectDocs and k through the retrieval metric spec', () => {
    const spec = new RetrievalMetricSpec({ expectDocs: ['a.md', 'b.md'], k: 3 });

    expect(spec.kind).toBe('retrieval');
    expect(spec.expectDocs).toEqual(['a.md', 'b.md']);
    expect(spec.k).toBe(3);
  });

  it('refuses an empty store id', () => {
    expect(() => new VectorStoreSpec({ id: '', kind: 'memory' })).toThrow(
      'store id must not be empty',
    );
  });

  it('refuses a non-positive store width', () => {
    expect(() => new VectorStoreSpec({ id: 'docs', kind: 'memory', dimensions: 0 })).toThrow(
      'store dimensions must be a positive integer',
    );
  });
});

describe('Chunk', () => {
  it('copies its metadata', () => {
    const metadata = { path: 'a.md' };
    const built = new Chunk({
      chunkId: chunkIdFor('a.md', 0, 'x'),
      docId: 'a.md',
      index: 0,
      start: 0,
      end: 1,
      text: 'x',
      metadata,
    });

    expect(built.metadata).toEqual({ path: 'a.md' });
    expect(built.metadata).not.toBe(metadata);
  });

  it('defaults the uri to the empty string', () => {
    expect(
      new Chunk({
        chunkId: chunkIdFor('a.md', 0, 'x'),
        docId: 'a.md',
        index: 0,
        start: 0,
        end: 1,
        text: 'x',
      }).uri,
    ).toBe('');
  });

  it.each([[['chunkId', 'chunkId must not be empty']]])('validates %s', () => {
    expect(
      () =>
        new Chunk({
          chunkId: '',
          docId: 'a.md',
          index: 0,
          start: 0,
          end: 0,
          text: '',
        }),
    ).toThrow(ConfigurationError);
  });

  it('refuses a negative index', () => {
    expect(
      () =>
        new Chunk({
          chunkId: chunkIdFor('a.md', 0, 'x'),
          docId: 'a.md',
          index: -1,
          start: 0,
          end: 1,
          text: 'x',
        }),
    ).toThrow('chunk index must be a non-negative integer');
  });
});

function storeSpecFreeEmbedding(): EmbeddingSpec {
  return new EmbeddingSpec({
    id: EMBED_ID,
    provider: 'fake',
    modelId: MODEL_ID,
    dimensions: EMBED_DIMENSIONS,
    costProfile: new EmbeddingCostProfile({ inputPerMTok: 0.02, outputPerMTok: 0 }),
  });
}
