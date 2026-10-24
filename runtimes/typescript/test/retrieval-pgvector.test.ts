import { afterEach, describe, expect, it } from 'vitest';

import {
  ConfigurationError,
  createStore,
  InMemoryVectorStore,
  PgVectorStore,
  parseVector,
  resolveUri,
  StoreRecord,
  vectorLiteral,
} from '../src/index.js';
import { chunk } from './support.js';

/**
 * These tests never open a database.
 *
 * The adapter resolves its driver lazily through `createRequire`, which a module mock
 * cannot intercept, and `pg` is deliberately not a dependency of this runtime. That is
 * exactly what keeps every required gate on the in-memory store (D2): the assertions
 * below cover the pure helpers and every guard that fires *before* a connection is
 * made, and they prove the missing driver is a clear `ConfigurationError` rather than a
 * crash. The SQL path itself runs only where someone brought the database up.
 */

const ENV_NAME = 'AID_TEST_PGVECTOR_URL';

afterEach(() => {
  delete process.env[ENV_NAME];
});

function record(dimensions = 3): StoreRecord {
  return new StoreRecord({
    chunk: chunk('a.md', 0, 'body'),
    vector: Array.from({ length: dimensions }, (_, index) => index / 10),
  });
}

describe('resolveUri', () => {
  it('returns a plain uri unchanged', () => {
    expect(resolveUri('postgres://localhost/aid')).toBe('postgres://localhost/aid');
  });

  it('refuses a missing uri', () => {
    expect(() => resolveUri(null)).toThrow(
      new ConfigurationError('the pgvector store requires a uri'),
    );
    expect(() => resolveUri(undefined)).toThrow('the pgvector store requires a uri');
  });

  it('resolves an env reference to the variable value', () => {
    process.env[ENV_NAME] = 'postgres://from-env/aid';

    expect(resolveUri(`env:${ENV_NAME}`)).toBe('postgres://from-env/aid');
  });

  it('refuses an env reference that names nothing', () => {
    expect(() => resolveUri('env:')).toThrow(/names an empty environment variable/);
  });

  it('refuses an env reference to an unset variable', () => {
    expect(() => resolveUri('env:AID_TEST_DEFINITELY_UNSET_VARIABLE')).toThrow(
      new ConfigurationError(
        "store uri 'env:AID_TEST_DEFINITELY_UNSET_VARIABLE' refers to environment variable " +
          "'AID_TEST_DEFINITELY_UNSET_VARIABLE', which is unset",
      ),
    );
  });

  it('does not treat a uri that merely contains env: as a reference', () => {
    expect(resolveUri('postgres://host/env:name')).toBe('postgres://host/env:name');
  });
});

describe('vectorLiteral', () => {
  it('renders pgvector text form', () => {
    expect(vectorLiteral([0.1, 0.2, 0.3])).toBe('[0.1,0.2,0.3]');
  });

  it('spells an integral float with a trailing zero, as Python repr does', () => {
    expect(vectorLiteral([1, 2])).toBe('[1.0,2.0]');
  });

  it('keeps exponent notation intact', () => {
    expect(vectorLiteral([1e-7])).toBe('[1e-7]');
  });

  it('renders a negative zero as a float', () => {
    expect(vectorLiteral([-0])).toBe('[-0.0]');
  });

  it('renders an empty vector', () => {
    expect(vectorLiteral([])).toBe('[]');
  });
});

describe('parseVector', () => {
  it('reads pgvector text form', () => {
    expect(parseVector('[0.1,0.2,0.3]')).toEqual([0.1, 0.2, 0.3]);
  });

  it('tolerates whitespace inside the text form', () => {
    expect(parseVector(' [0.1, 0.2] ')).toEqual([0.1, 0.2]);
  });

  it('reads the empty text form as no elements', () => {
    expect(parseVector('[]')).toEqual([]);
  });

  it('reads a driver-returned sequence', () => {
    expect(parseVector([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it('coerces a numeric sequence', () => {
    expect(parseVector(['1', '2'])).toEqual([1, 2]);
  });

  it('refuses a value it cannot read', () => {
    expect(() => parseVector(42)).toThrow(
      new ConfigurationError('cannot read a vector: expected a sequence or its text form'),
    );
  });

  it('round-trips its own literal form', () => {
    const vector = [0.125, -0.5, 2, 1e-7];

    expect(parseVector(vectorLiteral(vector))).toEqual(vector);
  });
});

describe('PgVectorStore construction', () => {
  it('resolves its uri at construction, so a misconfiguration fails early', () => {
    expect(() => new PgVectorStore({ uri: null })).toThrow('the pgvector store requires a uri');
  });

  it('requires no driver to be constructed', () => {
    // The driver is loaded on first use, so importing and building the adapter cannot
    // fail because a database dependency is absent.
    const store = new PgVectorStore({ uri: 'postgres://localhost/aid' });

    expect(store.kind).toBe('pgvector');
  });

  it('is built by createStore for the pgvector kind', () => {
    const store = createStore('pgvector', {
      uri: 'postgres://localhost/aid',
      dimensions: 3,
    });

    expect(store).toBeInstanceOf(PgVectorStore);
  });

  it('needs a uri through createStore', () => {
    expect(() => createStore('pgvector', { uri: null, dimensions: 3 })).toThrow(
      'the pgvector store requires a uri',
    );
  });
});

describe('PgVectorStore guards before connecting', () => {
  it('refuses a record that disagrees with the pinned width', async () => {
    const store = new PgVectorStore({ uri: 'postgres://localhost/aid', dimensions: 3 });

    await expect(store.upsert([record(4)])).rejects.toThrow(
      new ConfigurationError('store is pinned to 3 dimensions but a record carries 4'),
    );
  });

  it('writes nothing and opens nothing for an empty batch', async () => {
    const store = new PgVectorStore({ uri: 'postgres://localhost/aid', dimensions: 3 });

    await expect(store.upsert([])).resolves.toBe(0);
  });

  it('refuses a top_k below one', async () => {
    const store = new PgVectorStore({ uri: 'postgres://localhost/aid' });

    await expect(store.search([1, 2, 3], { topK: 0, metric: 'cosine' })).rejects.toThrow(
      new ConfigurationError('top_k must be at least 1'),
    );
  });

  it('refuses to rank by an unknown metric', async () => {
    const store = new PgVectorStore({ uri: 'postgres://localhost/aid' });

    await expect(
      store.search([1, 2, 3], { topK: 1, metric: 'hamming' as unknown as 'cosine' }),
    ).rejects.toThrow(/pgvector cannot rank by/);
  });

  it('names the driver to install when pg is absent', async () => {
    const store = new PgVectorStore({ uri: 'postgres://localhost/aid' });

    await expect(store.upsert([record(3)])).rejects.toThrow(
      new ConfigurationError(
        'the pgvector store needs its driver; install it with `pnpm add pg` in the ' +
          'generated app (the default runtime install omits it)',
      ),
    );
  });

  it('names the driver for a search too, never a crash', async () => {
    const store = new PgVectorStore({ uri: 'postgres://localhost/aid' });

    await expect(store.search([1, 2, 3], { topK: 1, metric: 'cosine' })).rejects.toThrow(
      /needs its driver/,
    );
  });

  it('names the driver for a corpus read', async () => {
    const store = new PgVectorStore({ uri: 'postgres://localhost/aid' });

    await expect(store.corpus()).rejects.toThrow(/needs its driver/);
  });

  it('refuses any use after close', async () => {
    const store = new PgVectorStore({ uri: 'postgres://localhost/aid' });
    await store.close();

    await expect(store.corpus()).rejects.toThrow(
      new ConfigurationError('this store has been closed'),
    );
    await expect(store.search([1, 2], { topK: 1, metric: 'cosine' })).rejects.toThrow(
      'this store has been closed',
    );
    await expect(store.upsert([record(2)])).rejects.toThrow('this store has been closed');
  });

  it('closes without complaint, twice, and without ever connecting', async () => {
    const store = new PgVectorStore({ uri: 'postgres://localhost/aid' });

    await expect(store.close()).resolves.toBeUndefined();
    await expect(store.close()).resolves.toBeUndefined();
  });
});

describe('the shipped default store stays in memory', () => {
  it('createStore picks the in-memory adapter for the memory kind', () => {
    expect(createStore('memory', { uri: null, dimensions: 3 })).toBeInstanceOf(InMemoryVectorStore);
  });

  it('does not hand back a pgvector store for a memory binding', () => {
    const store = createStore('memory', { uri: 'env:PGVECTOR_URL', dimensions: 3 });

    expect(store.kind).toBe('memory');
  });
});
