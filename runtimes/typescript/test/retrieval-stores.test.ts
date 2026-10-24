import { describe, expect, it } from 'vitest';

import {
  ConfigurationError,
  createStore,
  FeatureDeferredError,
  InMemoryVectorStore,
  SearchHit,
  StoreRecord,
  similarity,
} from '../src/index.js';
import { at, chunk } from './support.js';

function record(
  docId: string,
  index: number,
  text: string,
  vector: readonly number[],
): StoreRecord {
  return new StoreRecord({ chunk: chunk(docId, index, text), vector });
}

describe('similarity', () => {
  it('reports a dot product for the dot metric', () => {
    expect(similarity([1, 2], [3, 4], { metric: 'dot' })).toBe(11);
  });

  it('reports a negated L2 distance so higher is always better', () => {
    expect(similarity([0, 0], [3, 4], { metric: 'l2' })).toBe(-5);
  });

  it('reports cosine similarity for the cosine metric', () => {
    expect(similarity([1, 0], [1, 0], { metric: 'cosine' })).toBeCloseTo(1, 12);
    expect(similarity([1, 0], [0, 1], { metric: 'cosine' })).toBeCloseTo(0, 12);
  });

  it('reports -1 for antiparallel vectors, never below', () => {
    expect(similarity([1, 0], [-1, 0], { metric: 'cosine' })).toBeCloseTo(-1, 12);
  });

  it('reports 0 for a zero vector because cosine has no direction to compare', () => {
    expect(similarity([0, 0], [1, 1], { metric: 'cosine' })).toBe(0);
  });

  it('refuses vectors of different widths', () => {
    expect(() => similarity([1], [1, 2], { metric: 'cosine' })).toThrow(ConfigurationError);
    expect(() => similarity([1], [1, 2], { metric: 'cosine' })).toThrow(
      /cannot compare vectors of 1 and 2 dimensions/,
    );
  });

  it('refuses a width mismatch for every metric, not only cosine', () => {
    for (const metric of ['dot', 'l2', 'cosine'] as const) {
      expect(() => similarity([1], [1, 2], { metric })).toThrow(/cannot compare vectors/);
    }
  });
});

describe('StoreRecord', () => {
  it('copies the vector it is given', () => {
    const vector = [1, 2, 3];

    const built = new StoreRecord({ chunk: chunk('a.md', 0, 'x'), vector });

    expect(built.vector).toEqual([1, 2, 3]);
    expect(built.vector).not.toBe(vector);
  });
});

describe('InMemoryVectorStore', () => {
  it('reports the memory kind by default', () => {
    expect(new InMemoryVectorStore().kind).toBe('memory');
  });

  it('accepts an explicit kind', () => {
    expect(new InMemoryVectorStore({ kind: 'custom' }).kind).toBe('custom');
  });

  it('reports how many records it wrote', async () => {
    const store = new InMemoryVectorStore();

    await expect(store.upsert([record('a.md', 0, 'x', [1, 0])])).resolves.toBe(1);
  });

  it('ranks by descending similarity', async () => {
    const store = new InMemoryVectorStore();
    await store.upsert([record('a.md', 0, 'near', [1, 0]), record('b.md', 0, 'far', [0, 1])]);

    const hits = await store.search([1, 0], { topK: 2, metric: 'cosine' });

    expect(at(hits, 0).record.chunk.docId).toBe('a.md');
    expect(at(hits, 0).score).toBeCloseTo(1, 12);
    expect(at(hits, 1).score).toBeCloseTo(0, 12);
  });

  it('orients L2 so the nearest vector scores highest', async () => {
    const store = new InMemoryVectorStore();
    await store.upsert([record('a.md', 0, 'near', [1, 0]), record('b.md', 0, 'far', [10, 0])]);

    const hits = await store.search([1, 0], { topK: 2, metric: 'l2' });

    expect(at(hits, 0).record.chunk.docId).toBe('a.md');
    expect(at(hits, 0).score).toBeGreaterThan(at(hits, 1).score);
  });

  it('truncates to topK', async () => {
    const store = new InMemoryVectorStore();
    await store.upsert([
      record('a.md', 0, 'a', [1, 0]),
      record('b.md', 0, 'b', [0.9, 0.1]),
      record('c.md', 0, 'c', [0, 1]),
    ]);

    expect(await store.search([1, 0], { topK: 2, metric: 'cosine' })).toHaveLength(2);
  });

  it('breaks ties on chunk id so ingest order cannot change the ranking', async () => {
    const first = record('z.md', 0, 'same', [1, 0]);
    const second = record('a.md', 0, 'same', [1, 0]);

    const forward = new InMemoryVectorStore();
    await forward.upsert([first, second]);
    const backward = new InMemoryVectorStore();
    await backward.upsert([second, first]);

    const ordered = (await forward.search([1, 0], { topK: 2, metric: 'cosine' })).map(
      (hit) => hit.record.chunk.docId,
    );
    const reversed = (await backward.search([1, 0], { topK: 2, metric: 'cosine' })).map(
      (hit) => hit.record.chunk.docId,
    );

    expect(ordered).toEqual(['a.md', 'z.md']);
    expect(reversed).toEqual(ordered);
  });

  it('refuses a non-positive topK', async () => {
    const store = new InMemoryVectorStore();

    await expect(store.search([1], { topK: 0, metric: 'cosine' })).rejects.toThrow(
      'top_k must be at least 1',
    );
  });

  it('is idempotent because chunk ids key the map', async () => {
    const store = new InMemoryVectorStore();
    const one = record('a.md', 0, 'x', [1, 0]);

    await store.upsert([one]);
    await store.upsert([one]);

    expect(await store.corpus()).toHaveLength(1);
  });

  it('replaces a record on re-ingest with a new vector', async () => {
    const store = new InMemoryVectorStore();
    await store.upsert([record('a.md', 0, 'x', [1, 0])]);
    await store.upsert([record('a.md', 0, 'x', [0, 1])]);

    const hits = await store.search([0, 1], { topK: 1, metric: 'cosine' });

    expect(at(hits, 0).score).toBeCloseTo(1, 12);
  });

  it('reports the corpus in chunk-id order', async () => {
    const store = new InMemoryVectorStore();
    await store.upsert([record('z.md', 0, 'z', [1, 0]), record('a.md', 0, 'a', [1, 0])]);

    const corpus = await store.corpus();
    const ids = corpus.map((entry) => entry.chunk.chunkId);

    expect(ids).toEqual([...ids].sort((left, right) => (left < right ? -1 : 1)));
  });

  it('closes without complaint, twice', async () => {
    const store = new InMemoryVectorStore();

    await expect(store.close()).resolves.toBeUndefined();
    await expect(store.close()).resolves.toBeUndefined();
  });

  it('searches an empty store without inventing hits', async () => {
    expect(await new InMemoryVectorStore().search([1, 0], { topK: 5, metric: 'cosine' })).toEqual(
      [],
    );
  });
});

describe('SearchHit', () => {
  it('carries a record and its score', () => {
    const source = record('a.md', 0, 'x', [1, 0]);

    const hit = new SearchHit({ record: source, score: 0.5 });

    expect(hit.record).toBe(source);
    expect(hit.score).toBe(0.5);
  });
});

describe('createStore', () => {
  it('builds the in-memory adapter', () => {
    expect(createStore('memory')).toBeInstanceOf(InMemoryVectorStore);
  });

  it('builds the pgvector adapter without touching a driver', () => {
    const store = createStore('pgvector', { uri: 'postgres://localhost/aid' });

    expect(store.kind).toBe('pgvector');
  });

  it('refuses a pgvector store with no uri at construction', () => {
    expect(() => createStore('pgvector')).toThrow('the pgvector store requires a uri');
  });

  it.each([['qdrant'], ['pinecone'], ['weaviate']] as const)(
    'defers the %s adapter rather than inventing one',
    (kind) => {
      expect(() => createStore(kind)).toThrow(FeatureDeferredError);
    },
  );

  it('names the two adapters it does ship', () => {
    expect(() => createStore('custom')).toThrow(/Phase 1 ships 'memory' and 'pgvector'/);
  });
});
