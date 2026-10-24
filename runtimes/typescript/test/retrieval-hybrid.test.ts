import { describe, expect, it } from 'vitest';

import { bm25Scores, fuse, lexicalRanking, RankedId, rrfScore, tokenize } from '../src/index.js';
import { at } from './support.js';

describe('tokenize', () => {
  it('lowercases alphanumeric runs and drops punctuation', () => {
    expect(tokenize('Hello, World 42!')).toEqual(['hello', 'world', '42']);
  });

  it('keeps identifiers whole instead of stemming them', () => {
    expect(tokenize('aid_runtime x-error-code')).toEqual(['aid', 'runtime', 'x', 'error', 'code']);
  });

  it('returns nothing for text with no alphanumerics', () => {
    expect(tokenize('--- ... ///')).toEqual([]);
  });
});

describe('bm25Scores', () => {
  it('scores a single-document corpus at log 2 for its one term', () => {
    // idf = log(1 + (2 - 1 + 0.5) / (1 + 0.5)) = log(2), and tf saturation cancels
    // against the normalisation because the one document is exactly average length.
    expect(at(bm25Scores(['alpha', 'beta'], 'alpha'), 0)).toBeCloseTo(Math.log(2), 12);
  });

  it('scores a document that does not contain the term at zero', () => {
    expect(at(bm25Scores(['alpha', 'beta'], 'alpha'), 1)).toBe(0);
  });

  it('returns one score per document in the order given', () => {
    expect(bm25Scores(['alpha', 'beta', 'gamma'], 'alpha')).toHaveLength(3);
  });

  it('scores everything zero when the corpus is empty', () => {
    expect(bm25Scores([], 'alpha')).toEqual([]);
  });

  it('scores everything zero when the query has no tokens', () => {
    expect(bm25Scores(['alpha', 'beta'], '---')).toEqual([0, 0]);
  });

  it('saturates a repeated term instead of scaling linearly', () => {
    const once = at(bm25Scores(['alpha beta gamma', 'filler words here'], 'alpha'), 0);
    const many = at(bm25Scores([`${'alpha '.repeat(10)}beta`, 'filler words here'], 'alpha'), 0);

    expect(many).toBeGreaterThan(once);
    expect(many).toBeLessThan(once * 10);
  });

  it('penalises a long document that merely contains more words', () => {
    const short = at(bm25Scores(['alpha', `${'filler '.repeat(20)}alpha`], 'alpha'), 0);
    const long = at(bm25Scores(['alpha', `${'filler '.repeat(20)}alpha`], 'alpha'), 1);

    expect(long).toBeLessThan(short);
  });

  it('accepts injected k1 and b', () => {
    expect(() => bm25Scores(['alpha'], 'alpha', { k1: 2.0, b: 0.0 })).not.toThrow();
    // One document: idf = log(1 + (1 - 1 + 0.5) / (1 + 0.5)) = log(4/3), and b = 0
    // removes the length normalisation so tf saturation applies at full strength.
    expect(at(bm25Scores(['alpha'], 'alpha', { b: 0.0 }), 0)).toBeCloseTo(Math.log(4 / 3), 12);
  });
});

describe('lexicalRanking', () => {
  it('ranks only the documents with a positive score', () => {
    const ranked = lexicalRanking(['alpha', 'unrelated', 'alpha again'], ['a', 'b', 'c'], 'alpha', {
      topK: 10,
    });

    expect(ranked.map((entry) => entry.chunkId).sort()).toEqual(['a', 'c']);
  });

  it('orders by descending score', () => {
    const ranked = lexicalRanking(['alpha alpha alpha', 'alpha'], ['many', 'one'], 'alpha', {
      topK: 10,
    });

    expect(at(ranked, 0).chunkId).toBe('many');
  });

  it('breaks ties on chunk id so every run ranks identically', () => {
    const ranked = lexicalRanking(['alpha', 'alpha'], ['zeta', 'alpha'], 'alpha', { topK: 10 });

    expect(ranked.map((entry) => entry.chunkId)).toEqual(['alpha', 'zeta']);
  });

  it('truncates to topK', () => {
    const ranked = lexicalRanking(['alpha', 'alpha', 'alpha'], ['a', 'b', 'c'], 'alpha', {
      topK: 2,
    });

    expect(ranked).toHaveLength(2);
  });

  it('returns nothing when no document matches', () => {
    expect(lexicalRanking(['beta'], ['a'], 'alpha', { topK: 10 })).toEqual([]);
  });

  it('refuses a parallel-arity mismatch', () => {
    expect(() => lexicalRanking(['alpha', 'beta'], ['a'], 'alpha', { topK: 1 })).toThrow(
      'documents and ids must be parallel sequences',
    );
  });
});

describe('rrfScore', () => {
  it('is 1 / (60 + 1) for the first rank', () => {
    expect(rrfScore(1)).toBeCloseTo(1 / 61, 12);
  });

  it('decreases as the rank worsens', () => {
    expect(rrfScore(1)).toBeGreaterThan(rrfScore(2));
    expect(rrfScore(2)).toBeGreaterThan(rrfScore(100));
  });

  it('accepts an injected damping constant', () => {
    expect(rrfScore(1, { k: 0 })).toBe(1);
  });

  it('refuses a rank below one because ranks are 1-based', () => {
    expect(() => rrfScore(0)).toThrow('rank is 1-based');
  });
});

describe('fuse', () => {
  it('ranks an id both retrievers agree on above one only a single retriever found', () => {
    // "b" is 2nd and 1st; "a" is 1st in one list only. Agreement wins.
    expect(fuse([['a', 'b'], ['b']]).map((entry) => entry.chunkId)).toEqual(['b', 'a']);
  });

  it('sums one contribution per appearance', () => {
    const fused = fuse([['a'], ['a']]);

    expect(at(fused, 0).score).toBeCloseTo(2 / 61, 12);
  });

  it('breaks ties on chunk id', () => {
    expect(fuse([['zeta'], ['alpha']]).map((entry) => entry.chunkId)).toEqual(['alpha', 'zeta']);
  });

  it('preserves a single ranking unchanged', () => {
    expect(fuse([['a', 'b', 'c']]).map((entry) => entry.chunkId)).toEqual(['a', 'b', 'c']);
  });

  it('returns nothing for no rankings', () => {
    expect(fuse([])).toEqual([]);
  });

  it('ignores an empty ranking', () => {
    expect(fuse([[], ['a']]).map((entry) => entry.chunkId)).toEqual(['a']);
  });

  it('deduplicates an id repeated inside one ranking', () => {
    const fused = fuse([['a', 'a']]);

    expect(fused).toHaveLength(1);
  });

  it('accepts an injected damping constant', () => {
    const fused = fuse([['a'], ['a']], { k: 0 });

    expect(at(fused, 0).score).toBeCloseTo(2.0, 12);
  });
});

describe('RankedId', () => {
  it('carries its id and score', () => {
    const entry = new RankedId({ chunkId: 'a', score: 0.5 });

    expect(entry.chunkId).toBe('a');
    expect(entry.score).toBe(0.5);
  });

  it('refuses an empty id', () => {
    expect(() => new RankedId({ chunkId: '', score: 0 })).toThrow('chunkId must not be empty');
  });
});
