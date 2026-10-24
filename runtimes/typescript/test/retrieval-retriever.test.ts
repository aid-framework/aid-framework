import { describe, expect, it } from 'vitest';

import {
  Budget,
  ConfigurationError,
  CostLedger,
  DEFAULT_CANDIDATE_FACTOR,
  FakeDeterministicEmbedder,
  FeatureDeferredError,
  IngestReport,
  InMemoryVectorStore,
  LedgerEntry,
  RerankSpec,
  Retriever,
  RetrieverBinding,
  rerankerFor,
  TokenUsage,
} from '../src/index.js';
import type { RefreshMode } from '../src/retrieval/types.js';
import {
  at,
  binding,
  chunkingSpec,
  document,
  EMBED_ID,
  MODEL_ID,
  RETRIEVER_ID,
} from './support.js';

/** Three documents whose wording makes the lexical ranking predictable. */
const CORPUS = [
  document('alpha.md', 'the quick brown fox jumps over the lazy dog'),
  document('bravo.md', 'a lazy afternoon with a good book'),
  document('charlie.md', 'foxes are quick and clever animals'),
];

function retriever(
  options: {
    hybrid?: boolean;
    topK?: number;
    metric?: 'cosine' | 'dot' | 'l2';
    rerank?: RerankSpec | null;
    chunking?: import('../src/index.js').ChunkingSpec;
  } = {},
  extra: { readonly ledger?: CostLedger; readonly budget?: Budget } = {},
): Retriever {
  return new Retriever(binding(options), {
    embedder: new FakeDeterministicEmbedder(),
    store: new InMemoryVectorStore(),
    ...extra,
  });
}

describe('Retriever construction', () => {
  it('exposes its binding and its store', () => {
    const bound = retriever();

    expect(bound.binding.retrieverId).toBe(RETRIEVER_ID);
    expect(bound.store.kind).toBe('memory');
  });

  it('defers a refresh mode other than full', () => {
    const full = binding();
    const manual = new RetrieverBinding({
      retrieverId: full.retrieverId,
      source: full.source,
      chunking: full.chunking,
      embedModel: full.embedModel,
      embedding: full.embedding,
      store: full.store,
      storeKind: full.storeKind,
      storeUri: full.storeUri,
      index: full.index,
      topK: full.topK,
      rerank: full.rerank,
      // The spec's own type forbids this mode; that is the point of the test, which
      // asserts the *runtime* refuses it too rather than trusting the type alone.
      refreshMode: 'manual' as unknown as RefreshMode,
    });

    expect(() => new Retriever(manual)).toThrow(FeatureDeferredError);
    expect(() => new Retriever(manual)).toThrow(/refresh mode 'manual' is declared/);
  });

  it('refuses a candidate factor below one', () => {
    expect(() => new Retriever(binding(), { candidateFactor: 0 })).toThrow(
      new ConfigurationError('candidate_factor must be at least 1'),
    );
  });

  it('defaults its candidate factor to four', () => {
    // Four is the number that lets a 4th-place lexical hit reach the top of a fused
    // list, which is the case fusion exists to fix.
    expect(DEFAULT_CANDIDATE_FACTOR).toBe(4);
  });
});

describe('Retriever ingest', () => {
  it('reports documents, chunks and writes', async () => {
    const bound = retriever();

    const report = await bound.ingest(CORPUS);

    expect(report.retriever).toBe(RETRIEVER_ID);
    expect(report.documents).toBe(3);
    expect(report.chunks).toBe(3);
    expect(report.written).toBe(3);
  });

  it('writes records that the store can enumerate', async () => {
    const bound = retriever();

    await bound.ingest(CORPUS);

    expect(await bound.store.corpus()).toHaveLength(3);
  });

  it('reports sorted chunk ids so two ingests compare equal', async () => {
    const bound = retriever();

    const report = await bound.ingest(CORPUS);
    const ids = [...report.chunkIds];

    expect(ids).toEqual([...ids].sort((left, right) => (left < right ? -1 : 1)));
  });

  it('is idempotent: a second ingest replaces rather than duplicates', async () => {
    const bound = retriever();

    const first = await bound.ingest(CORPUS);
    const second = await bound.ingest(CORPUS);

    expect(second.chunkIds).toEqual(first.chunkIds);
    expect(await bound.store.corpus()).toHaveLength(3);
  });

  it('prices its own spend, not the ledger total', async () => {
    const ledger = new CostLedger();
    const bound = retriever({}, { ledger });

    const first = await bound.ingest(CORPUS);
    const second = await bound.ingest(CORPUS);

    expect(first.costUsd).toBeCloseTo(second.costUsd, 12);
    expect(ledger.costUsd).toBeCloseTo(first.costUsd * 2, 12);
  });

  it('counts the tokens the embedder reported', async () => {
    const bound = retriever();

    const report = await bound.ingest([document('a.md', 'abcd')]);

    expect(report.tokens).toBe(1);
  });

  it('reports an empty corpus as empty', async () => {
    const bound = retriever();

    const report = await bound.ingest([]);

    expect(report.isEmpty).toBe(true);
    expect(report.documents).toBe(0);
    expect(report.chunks).toBe(0);
    expect(report.written).toBe(0);
    expect(report.costUsd).toBe(0);
  });

  it('splits a long document into several chunks', async () => {
    const bound = retriever({ chunking: chunkingSpec({ size: 20 }) });

    const report = await bound.ingest([document('long.md', 'word '.repeat(40).trim())]);

    expect(report.documents).toBe(1);
    expect(report.chunks).toBeGreaterThan(1);
  });

  it('records what an ingest charged on the ledger under the embedding alias', async () => {
    const ledger = new CostLedger();
    const bound = retriever({}, { ledger });

    await bound.ingest(CORPUS);

    const entry = at(ledger.entries, 0);
    expect(entry.alias).toBe(EMBED_ID);
    expect(entry.model).toBe(MODEL_ID);
  });

  it('charges without a ledger supplied, and still reports the cost', async () => {
    const bound = retriever();

    const report = await bound.ingest(CORPUS);

    expect(report.costUsd).toBeGreaterThan(0);
  });
});

describe('IngestReport', () => {
  it('copies its chunk ids', () => {
    const chunkIds = ['a', 'b'];

    const report = new IngestReport({
      retriever: 'docs',
      documents: 1,
      chunks: 2,
      written: 2,
      tokens: 3,
      costUsd: 0.1,
      chunkIds,
    });

    chunkIds.push('c');
    expect(report.chunkIds).toEqual(['a', 'b']);
  });

  it('is empty only when it chunked nothing', () => {
    const base = {
      retriever: 'docs',
      documents: 0,
      written: 0,
      tokens: 0,
      costUsd: 0,
      chunkIds: [],
    };

    expect(new IngestReport({ ...base, chunks: 0 }).isEmpty).toBe(true);
    expect(new IngestReport({ ...base, chunks: 1 }).isEmpty).toBe(false);
  });
});

describe('Retriever retrieve', () => {
  it('returns ranked items with contiguous one-based ranks', async () => {
    const bound = retriever({ topK: 3 });
    await bound.ingest(CORPUS);

    const result = await bound.retrieve('lazy afternoon');

    expect(result.retriever).toBe(RETRIEVER_ID);
    expect(result.query).toBe('lazy afternoon');
    result.items.forEach((item, offset) => {
      expect(item.rank).toBe(offset + 1);
    });
  });

  it('puts the best lexical match first when hybrid is on', async () => {
    const bound = retriever({ hybrid: true, topK: 3 });
    await bound.ingest(CORPUS);

    const result = await bound.retrieve('lazy afternoon');

    expect(at(result.items, 0).chunk.docId).toBe('bravo.md');
  });

  it('never returns more than topK', async () => {
    const bound = retriever({ topK: 2 });
    await bound.ingest(CORPUS);

    const result = await bound.retrieve('quick fox');

    expect(result.items.length).toBeLessThanOrEqual(2);
  });

  it('honours a per-call top_k override', async () => {
    const bound = retriever({ topK: 3 });
    await bound.ingest(CORPUS);

    const result = await bound.retrieve('quick fox', { topK: 1 });

    expect(result.items).toHaveLength(1);
  });

  it('refuses a top_k below one', async () => {
    const bound = retriever();
    await bound.ingest(CORPUS);

    await expect(bound.retrieve('quick', { topK: 0 })).rejects.toThrow(
      new ConfigurationError('top_k must be at least 1'),
    );
  });

  it('attaches a citation to every item', async () => {
    const bound = retriever();
    await bound.ingest(CORPUS);

    const result = await bound.retrieve('quick fox');

    for (const item of result.items) {
      expect(item.citation.chunkId).toBe(item.chunk.chunkId);
      expect(item.citation.docId).toBe(item.chunk.docId);
    }
  });

  it('returns an empty result for an empty store', async () => {
    const bound = retriever();

    const result = await bound.retrieve('anything');

    expect(result.items).toEqual([]);
    expect(result.context).toBe('');
  });

  it('charges the query embedding to the ledger as a second spend', async () => {
    const ledger = new CostLedger();
    const bound = retriever({}, { ledger });
    await bound.ingest(CORPUS);
    const afterIngest = ledger.entries.length;

    await bound.retrieve('lazy afternoon');

    // The ledger totals are rounded to six decimals, so a handful of tokens cannot
    // move the visible sum; a separate entry is the honest evidence of a second spend.
    expect(ledger.entries).toHaveLength(afterIngest + 1);
    expect(at(ledger.entries, afterIngest).alias).toBe(EMBED_ID);
  });

  it('reads the store through the declared metric', async () => {
    const bound = retriever({ metric: 'dot' });
    await bound.ingest(CORPUS);

    const result = await bound.retrieve('lazy afternoon');

    expect(result.items.length).toBeGreaterThan(0);
  });

  it('skips fusion entirely when hybrid is off', async () => {
    const off = retriever({ hybrid: false });
    await off.ingest(CORPUS);
    const plain = await off.retrieve('lazy afternoon');

    // With hybrid off the ranking is the store's own order, so its score is the raw
    // similarity rather than a reciprocal-rank score bounded by 1/61.
    expect(at(plain.items, 0).score).toBeGreaterThan(1 / 61);
  });

  it('scores with reciprocal rank fusion when hybrid is on', async () => {
    const on = retriever({ hybrid: true });
    await on.ingest(CORPUS);

    const fused = await on.retrieve('lazy afternoon');

    // A fused score is a sum of 1/(k + rank) terms, so it can never exceed 2/(60 + 1).
    expect(at(fused.items, 0).score).toBeLessThanOrEqual(2 / 61);
  });
});

describe('Retriever reranking', () => {
  it('reranks through the lexical reranker when the binding declares one', async () => {
    const bound = retriever({
      hybrid: true,
      topK: 3,
      rerank: new RerankSpec({ model: 'lexical', topN: 3 }),
    });
    await bound.ingest(CORPUS);

    const result = await bound.retrieve('lazy afternoon');

    expect(at(result.items, 0).chunk.docId).toBe('bravo.md');
  });

  it('resolves no reranker when the binding declares none', () => {
    expect(rerankerFor(null)).toBeNull();
  });

  it('reranks only the top N the binding declares', async () => {
    const bound = retriever({
      hybrid: true,
      topK: 3,
      rerank: new RerankSpec({ model: 'lexical', topN: 1 }),
    });
    await bound.ingest(CORPUS);

    const result = await bound.retrieve('lazy afternoon');

    expect(result.items).toHaveLength(1);
  });
});

describe('Retriever close', () => {
  it('closes its store and embedder, twice', async () => {
    const bound = retriever();

    await expect(bound.close()).resolves.toBeUndefined();
    await expect(bound.close()).resolves.toBeUndefined();
  });

  it('closes an injected connector', async () => {
    let closed = 0;
    const connector = {
      kind: 'file' as const,
      documents: async () => CORPUS,
      close: async () => {
        closed += 1;
      },
    };
    const bound = new Retriever(binding(), {
      embedder: new FakeDeterministicEmbedder(),
      store: new InMemoryVectorStore(),
      connector,
    });

    await bound.close();

    expect(closed).toBe(1);
  });

  it('ingests through an injected connector when no documents are supplied', async () => {
    const bound = new Retriever(binding(), {
      embedder: new FakeDeterministicEmbedder(),
      store: new InMemoryVectorStore(),
      connector: { kind: 'file' as const, documents: async () => CORPUS, close: async () => {} },
    });

    const report = await bound.ingest();

    expect(report.documents).toBe(3);
  });
});

describe('Retriever under a budget', () => {
  it('fails the ingest when the budget is already spent', async () => {
    const ledger = new CostLedger();
    ledger.charge(
      undefined,
      new LedgerEntry({
        alias: EMBED_ID,
        model: MODEL_ID,
        provider: 'fake',
        usage: new TokenUsage({ inputTokens: 1_000_000, outputTokens: 0 }),
        costUsd: 5,
      }),
    );
    const bound = retriever({}, { ledger, budget: new Budget({ maxUsd: 0.001 }) });

    await expect(bound.ingest(CORPUS)).rejects.toThrow(/budget/);
  });
});
