import { describe, expect, it } from 'vitest';

import { ConfigurationError, FeatureDeferredError } from '../src/index.js';
import {
  CodeChunker,
  chunkDocument,
  chunkerFor,
  FixedChunker,
  RecursiveChunker,
} from '../src/retrieval/chunking.js';
import { ChunkingSpec, type ChunkingStrategy, chunkIdFor } from '../src/retrieval/types.js';
import { at, document } from './support.js';

// Dense prose with no blank lines and no trailing whitespace: every fixed-size window
// has content, so window skipping cannot make the spans look non-contiguous.
const DENSE = Array.from({ length: 200 }, (_, index) => `w${String(index).padStart(3, '0')}`).join(
  ' ',
);

const PROSE =
  'Retrieval augments a prompt with passages the model never saw during training.\n\n' +
  'A retriever embeds the query and the corpus into one vector space, then ranks by ' +
  'similarity.\n\n' +
  'Chunking decides what a passage is, and it is the choice most likely to decide ' +
  'whether retrieval works at all.\n\n' +
  "Citations are what let a model's answer be checked against the source it names.\n";

const STRATEGIES: readonly ChunkingStrategy[] = ['fixed', 'recursive', 'code'];

function specFor(
  strategy: ChunkingStrategy,
  overrides: { size?: number; overlap?: number; keepMetadata?: readonly string[] } = {},
): ChunkingSpec {
  return new ChunkingSpec({
    strategy,
    size: overrides.size ?? 80,
    overlap: overrides.overlap ?? 0,
    keepMetadata: overrides.keepMetadata ?? [],
  });
}

function chunksOf(text: string, spec: ChunkingSpec): ReturnType<typeof chunkDocument> {
  return chunkDocument(document('a.md', text), spec);
}

describe('every strategy', () => {
  it.each(STRATEGIES)('%s covers the whole document', (strategy) => {
    const produced = chunksOf(DENSE, specFor(strategy, { size: 80 }));

    expect(at(produced, 0).start).toBe(0);
    expect(at(produced, produced.length - 1).end).toBe(DENSE.length);
    for (let index = 1; index < produced.length; index += 1) {
      expect(at(produced, index - 1).end).toBe(at(produced, index).start);
    }
  });

  it.each(STRATEGIES)('%s numbers its chunks from zero', (strategy) => {
    const produced = chunksOf(PROSE, specFor(strategy, { size: 80 }));

    expect(produced.map((item) => item.index)).toEqual(produced.map((_, index) => index));
  });

  it.each(STRATEGIES)('%s derives the id from the content', (strategy) => {
    const produced = chunksOf(PROSE, specFor(strategy, { size: 80 }));

    for (const item of produced) {
      expect(item.chunkId).toBe(chunkIdFor('a.md', item.index, item.text));
    }
  });

  it.each(STRATEGIES)('%s bounds the chunk by the size', (strategy) => {
    const produced = chunksOf(DENSE, specFor(strategy, { size: 40 }));

    expect(produced.length).toBeGreaterThan(0);
    for (const item of produced) {
      expect(item.text.length).toBeLessThanOrEqual(40);
    }
  });

  it.each(STRATEGIES)('%s never emits a whitespace-only chunk', (strategy) => {
    const produced = chunksOf(PROSE, specFor(strategy, { size: 40 }));

    for (const item of produced) {
      expect(item.text.trim().length).toBeGreaterThan(0);
    }
  });

  it.each(STRATEGIES)('%s carries the document identity and its span', (strategy) => {
    const produced = chunksOf(DENSE, specFor(strategy, { size: 80 }));

    for (const item of produced) {
      expect(item.docId).toBe('a.md');
      expect(item.text).toBe(DENSE.slice(item.start, item.end));
    }
  });
});

describe('FixedChunker', () => {
  it('fills the window and so cuts mid-token', () => {
    const produced = chunksOf(DENSE, specFor('fixed', { size: 42 }));

    expect(at(produced, 0).text.length).toBe(42);
    expect(at(produced, 0).text).toBe(DENSE.slice(0, 42));
    expect(at(produced, 0).text.endsWith(' ')).toBe(false);
  });

  it('backs the next window up by the overlap', () => {
    const produced = chunksOf(DENSE, specFor('fixed', { size: 40, overlap: 10 }));

    expect(at(produced, 1).start).toBe(at(produced, 0).end - 10);
  });

  it('makes spans disjoint when there is no overlap', () => {
    const produced = chunksOf(DENSE, specFor('fixed', { size: 40 }));

    for (let index = 1; index < produced.length; index += 1) {
      expect(at(produced, index - 1).end).toBe(at(produced, index).start);
    }
  });
});

describe('boundary preference', () => {
  it('recursive prefers a paragraph break to the budget', () => {
    const text = `${'a'.repeat(50)}\n\n${'b'.repeat(200)}`;

    const produced = chunksOf(text, specFor('recursive', { size: 80 }));

    expect(at(produced, 0).end).toBe(52);
    expect(at(produced, 0).text).toBe(`${'a'.repeat(50)}\n\n`);
  });

  it('code honours the same paragraph break', () => {
    const text = `${'a'.repeat(50)}\n\n${'b'.repeat(200)}`;

    const produced = chunksOf(text, specFor('code', { size: 80 }));

    expect(at(produced, 0).end).toBe(52);
  });

  it('recursive falls back to a sentence end', () => {
    const text = `${'a'.repeat(50)}. ${'b'.repeat(200)}`;

    const produced = chunksOf(text, specFor('recursive', { size: 80 }));

    expect(at(produced, 0).end).toBe(52);
  });

  it('code prefers a statement end over a word break', () => {
    const text = `${'a'.repeat(40)}; ${'b'.repeat(10)} ${'c'.repeat(30)}`;

    const code = chunksOf(text, specFor('code', { size: 80 }));
    const prose = chunksOf(text, specFor('recursive', { size: 80 }));

    expect(at(code, 0).end).toBe(42);
    expect(at(prose, 0).end).toBe(53);
  });

  it('rejects a boundary in the first half in favour of the budget', () => {
    const text = `${'a'.repeat(10)}\n\n${'b'.repeat(200)}`;

    const produced = chunksOf(text, specFor('recursive', { size: 80 }));

    expect(at(produced, 0).end).toBe(80);
  });

  it('yields at least as many chunks for a smaller size', () => {
    const coarse = chunksOf(PROSE, specFor('recursive', { size: 200 }));
    const fine = chunksOf(PROSE, specFor('recursive', { size: 60 }));

    expect(fine.length).toBeGreaterThanOrEqual(coarse.length);
  });
});

describe('edge cases', () => {
  it('yields no chunks for an empty document', () => {
    expect(chunksOf('', specFor('fixed', { size: 40 }))).toEqual([]);
  });

  it('yields one chunk for a document shorter than the size', () => {
    const produced = chunksOf('short text', specFor('fixed', { size: 800 }));

    expect(produced.length).toBe(1);
    expect(at(produced, 0).text).toBe('short text');
  });

  it.each([['path'], ['suffix'], ['path', 'suffix']])(
    'keepMetadata copies the named document fields: %s',
    (...keep: string[]) => {
      const source = document('a.md', 'hello', { path: 'a.md', suffix: '.md' });

      const produced = chunkDocument(source, specFor('fixed', { size: 800, keepMetadata: keep }));

      const expected: Record<string, string> = {};
      for (const name of keep) expected[name] = source.metadata[name] as string;
      expect(at(produced, 0).metadata).toEqual(expected);
    },
  );

  it('carries no metadata without keepMetadata', () => {
    const source = document('a.md', 'hello', { path: 'a.md' });

    const produced = chunkDocument(source, specFor('fixed', { size: 800 }));

    expect(at(produced, 0).metadata).toEqual({});
  });

  it('does not invent a value for an absent kept field', () => {
    const produced = chunkDocument(
      document('a.md', 'hello', { path: 'a.md' }),
      specFor('fixed', { size: 800, keepMetadata: ['absent'] }),
    );

    expect(at(produced, 0).metadata).toEqual({});
  });
});

describe('chunkerFor', () => {
  it('builds the strategy that was declared', () => {
    expect(chunkerFor(specFor('fixed'))).toBeInstanceOf(FixedChunker);
    expect(chunkerFor(specFor('recursive'))).toBeInstanceOf(RecursiveChunker);
    expect(chunkerFor(specFor('code'))).toBeInstanceOf(CodeChunker);
  });

  it('reports its strategy', () => {
    expect(chunkerFor(specFor('recursive')).strategy).toBe('recursive');
  });

  it('defers semantic chunking rather than approximating it', () => {
    expect(() => chunkerFor(specFor('semantic'))).toThrow(FeatureDeferredError);
    expect(() => chunkerFor(specFor('semantic'))).toThrow(/semantic/);
  });

  it.each([[0], [-1]])('refuses a non-positive size: %s', (size) => {
    expect(() => new FixedChunker({ size, overlap: 0 })).toThrow('chunking size must be positive');
  });

  it('refuses a negative overlap', () => {
    expect(() => new FixedChunker({ size: 40, overlap: -1 })).toThrow(
      'chunking overlap must not be negative',
    );
  });

  it('refuses an overlap at the size because it would not advance', () => {
    expect(() => new FixedChunker({ size: 40, overlap: 40 })).toThrow(/smaller than size/);
  });

  it('reports configuration errors as ConfigurationError', () => {
    expect(() => new FixedChunker({ size: 0, overlap: 0 })).toThrow(ConfigurationError);
  });
});
