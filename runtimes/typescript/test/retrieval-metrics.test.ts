import { describe, expect, it } from 'vitest';

import {
  CitationGrounding,
  ConfigurationError,
  MeanReciprocalRank,
  RecallAtK,
  RetrievalCase,
  type RetrievalResult,
  retrievalMetrics,
} from '../src/index.js';
import type { RetrievalMetricSpec } from '../src/retrieval/types.js';
import { at, chunk, item, result, retrievalCase } from './support.js';

/** A retrieved set whose only content is the passage each item carries. */
function retrieved(query: string, docIds: readonly string[]): RetrievalResult {
  const items = docIds.map((docId, offset) =>
    item(chunk(docId, 0, `text of ${docId}`), 1 / (offset + 1), offset + 1),
  );
  return result(query, items);
}

describe('RetrievalCase', () => {
  it('keeps every field it was given', () => {
    const entry = retrievalCase({ id: 'q1', query: 'where', expectDocs: ['a.md'], k: 3 });

    expect(entry.id).toBe('q1');
    expect(entry.query).toBe('where');
    expect(entry.expectDocs).toEqual(['a.md']);
    expect(entry.k).toBe(3);
  });

  it('copies its expected documents', () => {
    const expectDocs = ['a.md'];

    const entry = retrievalCase({ id: 'q1', query: 'where', expectDocs, k: 3 });

    expectDocs.push('b.md');
    expect(entry.expectDocs).toEqual(['a.md']);
  });

  it('refuses an empty id', () => {
    expect(() => new RetrievalCase({ id: '', query: 'q', expectDocs: ['a.md'], k: 1 })).toThrow(
      new ConfigurationError('case id must not be empty'),
    );
  });

  it('refuses a case with nothing expected', () => {
    expect(() => new RetrievalCase({ id: 'q1', query: 'q', expectDocs: [], k: 1 })).toThrow(
      'a retrieval case needs at least one expected document',
    );
  });

  it('refuses a non-positive k', () => {
    expect(() => new RetrievalCase({ id: 'q1', query: 'q', expectDocs: ['a.md'], k: 0 })).toThrow(
      'a retrieval case needs a positive k',
    );
  });

  it('refuses a fractional k', () => {
    expect(() => new RetrievalCase({ id: 'q1', query: 'q', expectDocs: ['a.md'], k: 1.5 })).toThrow(
      'a retrieval case needs a positive k',
    );
  });

  it('builds from the IR node', () => {
    const spec = {
      kind: 'retrieval',
      expectDocs: ['a.md'],
      k: 3,
    } as unknown as RetrievalMetricSpec;

    const entry = RetrievalCase.fromSpec({ caseId: 'q1', query: 'where', spec });

    expect(entry.id).toBe('q1');
    expect(entry.expectDocs).toEqual(['a.md']);
    expect(entry.k).toBe(3);
  });
});

describe('RecallAtK', () => {
  it('defaults its name to recall@k', () => {
    const metric = new RecallAtK();

    expect(metric.name).toBe('recall@k');
    expect(metric.deterministic).toBe(true);
  });

  it('accepts an explicit name', () => {
    expect(new RecallAtK({ name: 'r@5' }).name).toBe('r@5');
  });

  it('scores a full recall of one', async () => {
    const score = await new RecallAtK().score(
      retrievalCase({ id: 'q1', query: 'q', expectDocs: ['a.md'], k: 3 }),
      retrieved('q', ['a.md']),
    );

    expect(score.score).toBe(1);
    expect(score.passed).toBe(true);
    expect(score.detail).toBe('');
  });

  it('scores the fraction of expected documents found', async () => {
    const score = await new RecallAtK().score(
      retrievalCase({ id: 'q1', query: 'q', expectDocs: ['a.md', 'b.md'], k: 3 }),
      retrieved('q', ['a.md', 'c.md']),
    );

    expect(score.score).toBe(0.5);
    expect(score.detail).toBe('missing: b.md');
  });

  it('scores zero when nothing expected was found', async () => {
    const score = await new RecallAtK().score(
      retrievalCase({ id: 'q1', query: 'q', expectDocs: ['a.md'], k: 3 }),
      retrieved('q', ['z.md']),
    );

    expect(score.score).toBe(0);
    expect(score.passed).toBe(false);
  });

  it('counts only the top k', async () => {
    const score = await new RecallAtK().score(
      retrievalCase({ id: 'q1', query: 'q', expectDocs: ['b.md'], k: 1 }),
      retrieved('q', ['a.md', 'b.md']),
    );

    expect(score.score).toBe(0);
  });

  it('does not inflate recall when a document contributes several passages', async () => {
    const items = [
      item(chunk('a.md', 0, 'one'), 1, 1),
      item(chunk('a.md', 1, 'two'), 0.9, 2),
      item(chunk('a.md', 2, 'three'), 0.8, 3),
    ];

    const score = await new RecallAtK().score(
      retrievalCase({ id: 'q1', query: 'q', expectDocs: ['a.md', 'b.md'], k: 3 }),
      result('q', items),
    );

    // Three passages from one document are still one of two expected documents.
    expect(score.score).toBe(0.5);
  });

  it('lists the missing documents in sorted order', async () => {
    const score = await new RecallAtK().score(
      retrievalCase({ id: 'q1', query: 'q', expectDocs: ['c.md', 'a.md', 'b.md'], k: 3 }),
      retrieved('q', ['c.md']),
    );

    expect(score.detail).toBe('missing: a.md, b.md');
  });

  it('fails below its minimum score', async () => {
    const score = await new RecallAtK({ minScore: 0.75 }).score(
      retrievalCase({ id: 'q1', query: 'q', expectDocs: ['a.md', 'b.md'], k: 2 }),
      retrieved('q', ['a.md']),
    );

    expect(score.passed).toBe(false);
  });

  it('can pass a partial score when its floor is lenient', async () => {
    const score = await new RecallAtK({ minScore: 0.25 }).score(
      retrievalCase({ id: 'q1', query: 'q', expectDocs: ['a.md', 'b.md'], k: 2 }),
      retrieved('q', ['a.md']),
    );

    expect(score.passed).toBe(true);
  });
});

describe('MeanReciprocalRank', () => {
  it('defaults its name to mrr', () => {
    const metric = new MeanReciprocalRank();

    expect(metric.name).toBe('mrr');
    expect(metric.deterministic).toBe(true);
  });

  it('scores one when the first passage is expected', async () => {
    const score = await new MeanReciprocalRank().score(
      retrievalCase({ id: 'q1', query: 'q', expectDocs: ['a.md'], k: 3 }),
      retrieved('q', ['a.md', 'b.md']),
    );

    expect(score.score).toBe(1);
    expect(score.detail).toBe("first expected document 'a.md' at rank 1");
  });

  it('scores the reciprocal of the first matching rank', async () => {
    const score = await new MeanReciprocalRank().score(
      retrievalCase({ id: 'q1', query: 'q', expectDocs: ['c.md'], k: 3 }),
      retrieved('q', ['a.md', 'b.md', 'c.md']),
    );

    expect(score.score).toBeCloseTo(1 / 3, 12);
    expect(score.detail).toBe("first expected document 'c.md' at rank 3");
  });

  it('scores zero when nothing expected was retrieved', async () => {
    const score = await new MeanReciprocalRank().score(
      retrievalCase({ id: 'q1', query: 'q', expectDocs: ['b.md', 'a.md'], k: 2 }),
      retrieved('q', ['z.md']),
    );

    expect(score.score).toBe(0);
    expect(score.passed).toBe(false);
    expect(score.detail).toBe('none of a.md, b.md were retrieved within k=2');
  });

  it('ignores a match beyond k', async () => {
    const score = await new MeanReciprocalRank().score(
      retrievalCase({ id: 'q1', query: 'q', expectDocs: ['c.md'], k: 2 }),
      retrieved('q', ['a.md', 'b.md', 'c.md']),
    );

    expect(score.score).toBe(0);
  });

  it('fails a rank of three on the default half floor', async () => {
    const score = await new MeanReciprocalRank().score(
      retrievalCase({ id: 'q1', query: 'q', expectDocs: ['c.md'], k: 3 }),
      retrieved('q', ['a.md', 'b.md', 'c.md']),
    );

    // 1/3 is below the default floor of 0.5, and that is a real judgement: finding
    // the answer third is worse than finding it first or second.
    expect(score.passed).toBe(false);
  });

  it('passes a rank of two on the default half floor', async () => {
    const score = await new MeanReciprocalRank().score(
      retrievalCase({ id: 'q1', query: 'q', expectDocs: ['b.md'], k: 3 }),
      retrieved('q', ['a.md', 'b.md']),
    );

    expect(score.score).toBeCloseTo(0.5, 12);
    expect(score.passed).toBe(true);
  });

  it('passes a zero when its floor is zero', async () => {
    const score = await new MeanReciprocalRank({ minScore: 0 }).score(
      retrievalCase({ id: 'q1', query: 'q', expectDocs: ['a.md'], k: 1 }),
      retrieved('q', ['z.md']),
    );

    expect(score.passed).toBe(true);
  });
});

describe('CitationGrounding', () => {
  it('defaults its name to citation-grounding', () => {
    const metric = new CitationGrounding();

    expect(metric.name).toBe('citation-grounding');
    expect(metric.deterministic).toBe(true);
  });

  it('scores one when every expected document is cited', async () => {
    const score = await new CitationGrounding().score(
      retrievalCase({ id: 'q1', query: 'q', expectDocs: ['a.md'], k: 3 }),
      retrieved('q', ['a.md']),
    );

    expect(score.score).toBe(1);
    expect(score.detail).toBe('');
  });

  it('names the documents it could not ground', async () => {
    const score = await new CitationGrounding().score(
      retrievalCase({ id: 'q1', query: 'q', expectDocs: ['a.md', 'b.md'], k: 3 }),
      retrieved('q', ['a.md']),
    );

    expect(score.score).toBe(0.5);
    expect(score.detail).toBe('uncited: b.md');
  });

  it('scores a broken citation at zero, whatever was retrieved', async () => {
    const passage = chunk('a.md', 0, 'body');
    const broken = result('q', [
      {
        ...item(passage, 1, 1),
        citation: {
          docId: 'other.md',
          chunkId: 'other#0',
          index: 0,
          uri: 'x',
          toString: () => 'other.md#0',
        },
      } as unknown as import('../src/index.js').RetrievedItem,
    ]);

    const score = await new CitationGrounding().score(
      retrievalCase({ id: 'q1', query: 'q', expectDocs: ['a.md'], k: 3 }),
      broken,
    );

    expect(score.score).toBe(0);
    expect(score.passed).toBe(false);
    expect(score.detail).toMatch(/^1 citation\(s\) disagree with the passage they name, first: /);
  });

  it('checks integrity before it counts grounding', async () => {
    const passage = chunk('a.md', 0, 'body');
    const broken = result('q', [
      {
        ...item(passage, 1, 1),
        citation: {
          docId: 'a.md',
          chunkId: 'wrong#0',
          index: 0,
          uri: 'x',
          toString: () => 'a.md#0',
        },
      } as unknown as import('../src/index.js').RetrievedItem,
    ]);

    const score = await new CitationGrounding().score(
      retrievalCase({ id: 'q1', query: 'q', expectDocs: ['a.md'], k: 3 }),
      broken,
    );

    // A wrong citation is worse than a missing one: it sends a reader to the wrong
    // place while looking authoritative, so it scores zero even though `a.md` was
    // both expected and cited.
    expect(score.score).toBe(0);
    expect(score.detail).toBe(
      `1 citation(s) disagree with the passage they name, first: a.md#0 vs chunk ${passage.chunkId}`,
    );
  });
});

describe('retrievalMetrics', () => {
  it('ships recall, mrr and citation grounding in a stable order', () => {
    const metrics = retrievalMetrics();

    expect(metrics.map((metric) => metric.name)).toEqual(['recall@k', 'mrr', 'citation-grounding']);
  });

  it('reports every metric as deterministic, which is what lets a gate threshold it', () => {
    for (const metric of retrievalMetrics()) {
      expect(metric.deterministic).toBe(true);
    }
  });

  it('returns a fresh list each call', () => {
    expect(retrievalMetrics()).not.toBe(retrievalMetrics());
  });

  it('exposes no mutable state between calls', async () => {
    const metric = new RecallAtK();
    const entry = retrievalCase({ id: 'q1', query: 'q', expectDocs: ['a.md', 'b.md'], k: 3 });

    await metric.score(entry, retrieved('q', ['a.md']));
    const second = await metric.score(entry, retrieved('q', ['a.md', 'b.md']));

    expect(second.detail).toBe('');
    expect(second.score).toBe(1);
  });

  it('scores the same retrieved set identically twice', async () => {
    const entry = retrievalCase({ id: 'q1', query: 'q', expectDocs: ['a.md'], k: 3 });
    const one = retrieved('q', ['a.md']);
    const metric = new RecallAtK();

    const first = await metric.score(entry, one);
    const second = await metric.score(entry, one);

    expect(second.score).toBe(first.score);
  });

  it('scores an empty retrieved set against a case without throwing', async () => {
    const score = await new RecallAtK().score(
      retrievalCase({ id: 'q1', query: 'q', expectDocs: ['a.md'], k: 3 }),
      result('q', []),
    );

    expect(score.score).toBe(0);
    expect(at([score.detail], 0)).toBe('missing: a.md');
  });
});
