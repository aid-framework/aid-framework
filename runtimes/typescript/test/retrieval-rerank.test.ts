import { describe, expect, it } from 'vitest';

import {
  ConfigurationError,
  FeatureDeferredError,
  LexicalReranker,
  lexicalScore,
  RerankSpec,
  rerankerFor,
} from '../src/index.js';
import { at, chunk, item } from './support.js';

describe('lexicalScore', () => {
  it('is 1 for a passage containing every query term', () => {
    expect(lexicalScore('retrieval works', 'how retrieval works')).toBe(1);
  });

  it('is a fraction for a passage covering some of the query', () => {
    expect(lexicalScore('retrieval works', 'retrieval only')).toBeCloseTo(0.5, 12);
  });

  it('is 0 for a passage covering none of the query', () => {
    expect(lexicalScore('retrieval works', 'nothing relevant here')).toBe(0);
  });

  it('is 0 for a query with no tokens', () => {
    expect(lexicalScore('---', 'anything at all')).toBe(0);
  });

  it('counts distinct terms, not repetitions, so keyword stuffing does not win', () => {
    const stuffed = lexicalScore('alpha beta', 'alpha alpha alpha alpha');
    const complete = lexicalScore('alpha beta', 'alpha beta');

    expect(stuffed).toBeCloseTo(0.5, 12);
    expect(stuffed).toBeLessThan(complete);
  });

  it('clamps a phrase match to 1 because a phrase implies full term coverage', () => {
    // The bonus can never promote an unrelated passage: a phrase match already means
    // every query token is present, so coverage is 1.0 and `min(1.0, ...)` is the
    // value. Stated as the clamp it is rather than as a difference it cannot make.
    expect(lexicalScore('retrieval works', 'retrieval works here')).toBe(1);
    expect(lexicalScore('retrieval works', 'retrieval works here')).toBeLessThanOrEqual(1);
  });

  it('does not reward a phrase match that a tokenised passage cannot see', () => {
    // "retrieval-works" tokenises to both query terms, so coverage is full anyway;
    // the point is that the bonus never lifts a partial match.
    expect(lexicalScore('retrieval works', 'retrieval-works')).toBe(1);
    expect(lexicalScore('retrieval works alpha', 'retrieval-works')).toBeCloseTo(2 / 3, 12);
  });

  it('never exceeds 1 even for a phrase match on a fully covered query', () => {
    expect(lexicalScore('alpha', 'alpha')).toBeLessThanOrEqual(1);
  });
});

describe('LexicalReranker', () => {
  it('defaults its name to lexical', () => {
    expect(new LexicalReranker().name).toBe('lexical');
  });

  it('accepts an explicit name', () => {
    expect(new LexicalReranker({ name: 'custom' }).name).toBe('custom');
  });

  it('promotes the passage that best answers the query', () => {
    const items = [
      item(chunk('a.md', 0, 'nothing relevant'), 0.9, 1),
      item(chunk('b.md', 0, 'retrieval works well'), 0.1, 2),
    ];

    return new LexicalReranker().rerank('retrieval works', items, { topN: 2 }).then((reranked) => {
      expect(at(reranked, 0).chunk.docId).toBe('b.md');
    });
  });

  it('replaces each score rather than adding a second number', () => {
    const items = [item(chunk('a.md', 0, 'alpha'), 99.0, 1)];

    return new LexicalReranker().rerank('alpha', items, { topN: 1 }).then((reranked) => {
      expect(at(reranked, 0).score).toBe(1);
    });
  });

  it('renumbers ranks from 1', () => {
    const items = [
      item(chunk('a.md', 0, 'nothing'), 0.9, 7),
      item(chunk('b.md', 0, 'alpha'), 0.1, 9),
    ];

    return new LexicalReranker().rerank('alpha', items, { topN: 2 }).then((reranked) => {
      expect(reranked.map((entry) => entry.rank)).toEqual([1, 2]);
    });
  });

  it('rebuilds each citation from its chunk', () => {
    const source = chunk('a.md', 0, 'alpha');
    const items = [item(source, 0.5, 1)];

    return new LexicalReranker().rerank('alpha', items, { topN: 1 }).then((reranked) => {
      expect(at(reranked, 0).citation.chunkId).toBe(source.chunkId);
    });
  });

  it('truncates to topN', () => {
    const items = [
      item(chunk('a.md', 0, 'alpha'), 0.9, 1),
      item(chunk('b.md', 0, 'alpha alpha'), 0.8, 2),
    ];

    return new LexicalReranker().rerank('alpha', items, { topN: 1 }).then((reranked) => {
      expect(reranked).toHaveLength(1);
    });
  });

  it('breaks ties on chunk id', () => {
    const items = [
      item(chunk('z.md', 0, 'alpha'), 0.9, 1),
      item(chunk('a.md', 0, 'alpha'), 0.8, 2),
    ];

    return new LexicalReranker().rerank('alpha', items, { topN: 2 }).then((reranked) => {
      expect(reranked.map((entry) => entry.chunk.docId)).toEqual(['a.md', 'z.md']);
    });
  });

  it('leaves the incoming order alone when it cannot read the query', () => {
    // Every score is 0, so the chunk-id tie-break would be an arbitrary decision
    // dressed up as one; the reranker declines to make it.
    const items = [item(chunk('z.md', 0, 'alpha'), 0.9, 1), item(chunk('a.md', 0, 'beta'), 0.8, 2)];

    return new LexicalReranker().rerank('---', items, { topN: 2 }).then((reranked) => {
      expect(reranked.map((entry) => entry.chunk.docId)).toEqual(['z.md', 'a.md']);
    });
  });

  it('refuses a non-positive topN', () => {
    return expect(new LexicalReranker().rerank('q', [], { topN: 0 })).rejects.toThrow(
      'rerank top_n must be at least 1',
    );
  });

  it('reports a bad topN as ConfigurationError', () => {
    return expect(new LexicalReranker().rerank('q', [], { topN: -1 })).rejects.toThrow(
      ConfigurationError,
    );
  });
});

describe('rerankerFor', () => {
  it('builds nothing for no spec', () => {
    expect(rerankerFor(null)).toBeNull();
  });

  it('builds the lexical reranker for the lexical family', () => {
    expect(rerankerFor(new RerankSpec({ model: 'lexical-v1', topN: 3 }))).toBeInstanceOf(
      LexicalReranker,
    );
  });

  it('matches the family case-insensitively', () => {
    expect(rerankerFor(new RerankSpec({ model: 'LEXICAL', topN: 3 }))).toBeInstanceOf(
      LexicalReranker,
    );
  });

  it('defers a hosted cross-encoder rather than quietly serving a lexical one', () => {
    const build = () => rerankerFor(new RerankSpec({ model: 'cohere-rerank-3', topN: 3 }));

    expect(build).toThrow(FeatureDeferredError);
    expect(build).toThrow(/cohere-rerank-3/);
  });

  it('names the one implementation it does ship', () => {
    expect(() => rerankerFor(new RerankSpec({ model: 'bge-reranker', topN: 3 }))).toThrow(
      /one deterministic lexical reranker/,
    );
  });
});
