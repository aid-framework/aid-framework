import { describe, expect, it } from 'vitest';

import {
  assembleContext,
  Citation,
  ConfigurationError,
  chunkIdFor,
  cite,
  RetrievalResult,
} from '../src/index.js';
import { at, chunk, item, result } from './support.js';

describe('Citation', () => {
  it('carries provenance for one passage', () => {
    const citation = new Citation({
      docId: 'a.md',
      chunkId: 'sha256:x',
      uri: 'file:///a.md',
      index: 2,
    });

    expect(citation.docId).toBe('a.md');
    expect(citation.chunkId).toBe('sha256:x');
    expect(citation.uri).toBe('file:///a.md');
    expect(citation.index).toBe(2);
  });

  it('defaults the uri to the empty string', () => {
    expect(new Citation({ docId: 'a.md', chunkId: 'sha256:x', index: 0 }).uri).toBe('');
  });

  it('renders as docId#index', () => {
    expect(new Citation({ docId: 'a.md', chunkId: 'sha256:x', index: 3 }).toString()).toBe(
      'a.md#3',
    );
  });

  it('refuses an empty docId', () => {
    expect(() => new Citation({ docId: '', chunkId: 'sha256:x', index: 0 })).toThrow(
      'citation docId must not be empty',
    );
  });

  it('refuses an empty chunkId', () => {
    expect(() => new Citation({ docId: 'a.md', chunkId: '', index: 0 })).toThrow(
      'citation chunkId must not be empty',
    );
  });

  it.each([[-1], [1.5], [Number.NaN]])('refuses index %s', (index) => {
    expect(() => new Citation({ docId: 'a.md', chunkId: 'sha256:x', index })).toThrow(
      'citation index must be a non-negative integer',
    );
  });

  it('reports the failure as ConfigurationError', () => {
    expect(() => new Citation({ docId: '', chunkId: 'sha256:x', index: 0 })).toThrow(
      ConfigurationError,
    );
  });
});

describe('cite', () => {
  it('derives the citation from the chunk so the two cannot drift', () => {
    const source = chunk('a.md', 1, 'hello', { start: 10, end: 15 });

    const citation = cite(source);

    expect(citation.docId).toBe(source.docId);
    expect(citation.chunkId).toBe(source.chunkId);
    expect(citation.uri).toBe(source.uri);
    expect(citation.index).toBe(source.index);
  });
});

describe('RetrievedItem', () => {
  it('carries the chunk, score, rank and citation', () => {
    const source = chunk('a.md', 0, 'hello');
    const entry = item(source, 0.25, 2);

    expect(entry.chunk).toBe(source);
    expect(entry.score).toBe(0.25);
    expect(entry.rank).toBe(2);
    expect(entry.citation.chunkId).toBe(source.chunkId);
  });

  it.each([[0], [-1], [1.5]])('refuses rank %s because ranks start at 1', (rank) => {
    expect(() => item(chunk('a.md', 0, 'x'), 0.0, rank)).toThrow(
      'retrieved item rank must be at least 1',
    );
  });
});

describe('RetrievalResult', () => {
  it('defaults to no items', () => {
    expect(new RetrievalResult({ retriever: 'docs', query: 'q' }).items).toEqual([]);
  });

  it('refuses an empty retriever id', () => {
    expect(() => new RetrievalResult({ retriever: '', query: 'q' })).toThrow(
      'retriever must not be empty',
    );
  });

  it('reports its length', () => {
    const items = [item(chunk('a.md', 0, 'one'), 0.9, 1), item(chunk('b.md', 0, 'two'), 0.5, 2)];

    expect(result('q', items).length).toBe(2);
  });

  it('copies the items it is given', () => {
    const items = [item(chunk('a.md', 0, 'one'), 0.9, 1)];
    const built = result('q', items);

    expect(built.items).not.toBe(items);
    expect(built.items).toEqual(items);
  });

  it('returns the first k items and tolerates k beyond the length', () => {
    const items = [item(chunk('a.md', 0, 'one'), 0.9, 1), item(chunk('b.md', 0, 'two'), 0.5, 2)];
    const built = result('q', items);

    expect(built.top(1)).toHaveLength(1);
    expect(built.top(99)).toHaveLength(2);
  });

  it('assembles numbered context in rank order', () => {
    const items = [
      item(chunk('a.md', 0, 'first'), 0.9, 1),
      item(chunk('b.md', 1, 'second'), 0.5, 2),
    ];

    const context = result('q', items).context;

    expect(context.split('\n\n')).toHaveLength(2);
    expect(context.startsWith(`[1] a.md#0 :: first`)).toBe(true);
    expect(context).toContain(`[2] b.md#1 :: second`);
  });

  it('renders an empty result as the empty string, not a bare header', () => {
    expect(result('q', []).context).toBe('');
  });

  it('exposes one citation per item in rank order', () => {
    const items = [item(chunk('a.md', 0, 'one'), 0.9, 1), item(chunk('b.md', 0, 'two'), 0.5, 2)];

    expect(result('q', items).citations.map((citation) => citation.docId)).toEqual([
      'a.md',
      'b.md',
    ]);
  });

  it('de-duplicates docIds while keeping first-occurrence order', () => {
    const items = [
      item(chunk('b.md', 0, 'b0'), 0.9, 1),
      item(chunk('a.md', 0, 'a0'), 0.8, 2),
      item(chunk('b.md', 1, 'b1'), 0.7, 3),
    ];

    expect(result('q', items).docIds).toEqual(['b.md', 'a.md']);
  });
});

describe('assembleContext', () => {
  it('tags each excerpt with its numbered citation', () => {
    const text = assembleContext([item(chunk('a.md', 0, 'body'), 1.0, 1)]);

    expect(text).toBe(`[1] a.md#0 :: body`);
  });

  it('honours a custom separator', () => {
    const items = [item(chunk('a.md', 0, 'one'), 1.0, 1), item(chunk('b.md', 0, 'two'), 0.5, 2)];

    expect(assembleContext(items, { separator: ' | ' }).split(' | ')).toHaveLength(2);
  });

  it('returns the empty string for no items', () => {
    expect(assembleContext([])).toBe('');
  });

  it('ends the chunk id with the content hash it was built from', () => {
    const source = chunk('a.md', 0, 'hello');

    expect(source.chunkId).toBe(chunkIdFor('a.md', 0, 'hello'));
    expect(at([source], 0).chunkId.startsWith('sha256:')).toBe(true);
  });
});
