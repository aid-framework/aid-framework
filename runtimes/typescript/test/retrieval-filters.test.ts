import { describe, expect, it } from 'vitest';

import {
  Chunk,
  ConfigurationError,
  compileFilters,
  FakeDeterministicEmbedder,
  FILTER_OPERATORS,
  Filter,
  InMemoryVectorStore,
  matches,
  matchesAll,
  metadataFields,
  parseFilter,
  Retriever,
  SearchHit,
  type StoreRecord,
  type VectorStore,
} from '../src/index.js';
import type { DistanceMetric } from '../src/retrieval/types.js';
import { binding, chunk, chunkingSpec, document } from './support.js';

/**
 * Filter expressions: the grammar, its evaluation, and its place in retrieval.
 *
 * The grammar is pinned deliberately narrow, so the accept/reject table is the
 * specification. Two behaviours are worth stating where a reader will look for them:
 *
 * * a field the chunk does not carry matches **nothing**, including under `!=`, because
 *   absence is not a value and treating it as one widens a selector;
 * * filtering happens in the retriever, not in the store, and the hybrid lexical half
 *   reads the same filtered corpus -- otherwise a filtered-out passage could re-enter
 *   through BM25.
 */

describe('filter grammar', () => {
  it('round-trips every declared operator', () => {
    expect(FILTER_OPERATORS).toEqual(['==', '!=', '^=', '$=', '*=']);
    for (const operator of FILTER_OPERATORS) {
      const parsed = parseFilter(`tenant ${operator} acme`);
      expect(parsed).toEqual(new Filter({ field: 'tenant', operator, value: 'acme' }));
    }
  });

  it('accepts a value in double or single quotes', () => {
    expect(parseFilter('path == "a/b c"').value).toBe('a/b c');
    expect(parseFilter("path == 'a/b c'").value).toBe('a/b c');
  });

  it('only strips quotes when they pair', () => {
    // A value that merely starts with a quote has no closing quote, which is a typo
    // rather than a value containing one.
    expect(() => parseFilter('path == "unterminated')).toThrow(/does not close it/);
  });

  it.each([
    ['tenant', 'no operator'],
    ['tenant = acme', "single '=' is not an operator"],
    ['tenant == ', 'empty value'],
    ['tenant ==', 'no value at all'],
    ['== acme', 'no field'],
    ['tenant ~= acme', 'unsupported operator'],
  ])('refuses %j (%s)', (expression) => {
    expect(() => parseFilter(expression)).toThrow(ConfigurationError);
  });

  it('lists the operators when an expression is malformed', () => {
    let message = '';
    try {
      parseFilter('tenant = acme');
    } catch (raised) {
      message = (raised as Error).message;
    }
    for (const operator of FILTER_OPERATORS) {
      expect(message).toContain(operator);
    }
  });

  it('allows dots and hyphens in a metadata key', () => {
    expect(parseFilter('classification.level-2 == internal').field).toBe('classification.level-2');
  });

  it('lists metadata keys without the reserved fields or repeats', () => {
    expect(metadataFields(['tenant == acme', 'uri ^= s3://', 'tenant != other'])).toEqual([
      'tenant',
    ]);
  });
});

describe('filter evaluation', () => {
  it('compares equality exactly, and case-sensitively', () => {
    const compiled = compileFilters(['tenant == "Acme"']);
    expect(matchesAll(chunk('a', 0, 'text', { metadata: { tenant: 'Acme' } }), compiled)).toBe(
      true,
    );
    expect(matchesAll(chunk('a', 0, 'text', { metadata: { tenant: 'acme' } }), compiled)).toBe(
      false,
    );
  });

  it('differentiates the five operators on the same value', () => {
    const subject = chunk('a', 0, 'text', { metadata: { path: 'docs/guide.md' } });
    expect(matches(subject, parseFilter('path == docs/guide.md'))).toBe(true);
    expect(matches(subject, parseFilter('path != docs/other.md'))).toBe(true);
    expect(matches(subject, parseFilter('path ^= docs/'))).toBe(true);
    expect(matches(subject, parseFilter('path $= .md'))).toBe(true);
    expect(matches(subject, parseFilter('path *= guide'))).toBe(true);
    expect(matches(subject, parseFilter('path ^= guide'))).toBe(false);
    expect(matches(subject, parseFilter('path $= guide'))).toBe(false);
    expect(matches(subject, parseFilter('path *= other'))).toBe(false);
  });

  it('never matches a missing field, even under not-equal', () => {
    // This is the security-relevant rule: `tenant != other` on a chunk with no tenant
    // must not admit the chunk, because that would turn a selector into a bypass.
    const subject = chunk('a', 0, 'text');
    for (const operator of FILTER_OPERATORS) {
      expect(matches(subject, parseFilter(`tenant ${operator} acme`))).toBe(false);
    }
  });

  it('resolves doc_id and uri from the chunk, not the metadata', () => {
    const subject = chunk('doc-1', 0, 'text', { metadata: { doc_id: 'shadowed' } });
    expect(matches(subject, parseFilter('doc_id == doc-1'))).toBe(true);
    expect(matches(subject, parseFilter('uri == memory://doc-1'))).toBe(true);
    expect(matches(subject, parseFilter('doc_id == shadowed'))).toBe(false);
  });

  it('does not let metadata shadow the reserved fields', () => {
    // A document can carry any metadata, so pinning precedence keeps a corpus from
    // choosing which identity the filter sees.
    const subject = new Chunk({
      chunkId: 'sha256:x',
      docId: 'doc-1',
      uri: 'real.md',
      index: 0,
      start: 0,
      end: 4,
      text: 'text',
      metadata: { uri: 'forged.md' },
    });
    expect(matches(subject, parseFilter('uri == real.md'))).toBe(true);
    expect(matches(subject, parseFilter('uri == forged.md'))).toBe(false);
  });

  it('ands every entry', () => {
    const subject = chunk('a', 0, 'text', { metadata: { tenant: 'acme', tier: 'gold' } });
    expect(matchesAll(subject, compileFilters(['tenant == acme', 'tier == gold']))).toBe(true);
    expect(matchesAll(subject, compileFilters(['tenant == acme', 'tier == silver']))).toBe(false);
  });

  it('admits everything when the list is empty', () => {
    expect(matchesAll(chunk('a', 0, 'text'), [])).toBe(true);
    expect(compileFilters([])).toEqual([]);
  });
});

/** Returns insertion order, so a test can place a filtered-out chunk first. */
class OrderedStore extends InMemoryVectorStore {
  readonly limits: number[] = [];
  private readonly _order: StoreRecord[] = [];

  override async upsert(records: readonly StoreRecord[]): Promise<number> {
    this._order.push(...records);
    return super.upsert(records);
  }

  override async search(
    _vector: readonly number[],
    init: { readonly topK: number; readonly metric: DistanceMetric },
  ): Promise<readonly SearchHit[]> {
    this.limits.push(init.topK);
    return this._order.slice(0, init.topK).map((record) => new SearchHit({ record, score: 1.0 }));
  }
}

function makeRetriever(
  options: {
    readonly filters?: readonly string[];
    readonly hybrid?: boolean;
    readonly topK?: number;
    readonly store?: VectorStore;
  } = {},
): Retriever {
  return new Retriever(
    binding({
      filters: options.filters ?? [],
      hybrid: options.hybrid ?? false,
      topK: options.topK ?? 3,
      chunking: chunkingSpec({ size: 2000 }),
    }),
    {
      embedder: new FakeDeterministicEmbedder(),
      store: options.store ?? new InMemoryVectorStore(),
    },
  );
}

describe('filters in retrieval', () => {
  it('narrows the result', async () => {
    const retriever = makeRetriever({ filters: ['tenant == "acme"'] });
    await retriever.ingest([
      document('ours.md', 'alpha', { tenant: 'acme' }),
      document('theirs.md', 'alpha alpha', { tenant: 'other' }),
    ]);

    const result = await retriever.retrieve('alpha');

    expect(result.items.map((entry) => entry.chunk.docId)).toEqual(['ours.md']);
  });

  it('yields an empty result when nothing matches', async () => {
    const retriever = makeRetriever({ filters: ['tenant == "absent"'] });
    await retriever.ingest([document('a.md', 'alpha', { tenant: 'acme' })]);

    const result = await retriever.retrieve('alpha');

    expect(result.items).toEqual([]);
  });

  it('widens the search until a selective filter can fill topK', async () => {
    const store = new OrderedStore();
    const retriever = makeRetriever({ filters: ['tenant == "acme"'], topK: 1, store });
    await retriever.ingest([
      ...Array.from({ length: 4 }, (_, index) =>
        document(`other-${index}.md`, `text ${index}`, { tenant: 'other' }),
      ),
      document('ours.md', 'text ours', { tenant: 'acme' }),
    ]);

    const result = await retriever.retrieve('text');

    // 1 * candidateFactor (4) misses, then doubles past the five-record corpus.
    expect(store.limits).toEqual([4, 8]);
    expect(result.items.map((entry) => entry.chunk.docId)).toEqual(['ours.md']);
  });

  it('cannot reintroduce a filtered-out chunk through the lexical half', async () => {
    // The lexical half reads the whole corpus, which is exactly where a leak would
    // come from: the disallowed document matches the query far more strongly.
    const retriever = makeRetriever({ filters: ['tenant == "acme"'], hybrid: true, topK: 2 });
    await retriever.ingest([
      document('ours.md', 'alpha', { tenant: 'acme' }),
      document('theirs.md', 'alpha alpha alpha alpha', { tenant: 'other' }),
    ]);

    const result = await retriever.retrieve('alpha');

    expect(result.items.map((entry) => entry.chunk.docId)).toEqual(['ours.md']);
  });

  it('does not widen an unfiltered search', async () => {
    const store = new OrderedStore();
    const retriever = makeRetriever({ topK: 1, store });
    await retriever.ingest(
      Array.from({ length: 4 }, (_, index) => document(`${index}.md`, `text ${index}`)),
    );

    await retriever.retrieve('text');

    expect(store.limits).toEqual([4]);
  });

  it('fails at construction when a filter is malformed', () => {
    // Configuration faults should surface where the configuration is read, not on
    // the first query after a successful deploy.
    expect(() => makeRetriever({ filters: ['tenant = acme'] })).toThrow(/operators are/);
  });

  it('is invisible when every chunk satisfies it', async () => {
    // A filter every chunk satisfies must be invisible: same docs, same order, same
    // scores as the unfiltered run.
    const texts: [string, string][] = [
      ['a.md', 'alpha beta'],
      ['b.md', 'gamma delta'],
      ['c.md', 'epsilon'],
    ];
    const plain = makeRetriever({ topK: 3 });
    const filtered = makeRetriever({ filters: ['tier == "gold"'], topK: 3 });
    for (const retriever of [plain, filtered]) {
      await retriever.ingest(texts.map(([name, text]) => document(name, text, { tier: 'gold' })));
    }

    const unfiltered = await plain.retrieve('alpha');
    const narrowed = await filtered.retrieve('alpha');

    const pairs = (result: { items: readonly { chunk: Chunk; score: number }[] }) =>
      result.items.map((entry) => [entry.chunk.docId, entry.score]);
    expect(pairs(narrowed)).toEqual(pairs(unfiltered));
  });
});
