import { describe, expect, it } from 'vitest';

import {
  ConfigurationError,
  type Embedder,
  EmbeddingBatch,
  estimateTokens,
  type PinnedEmbedding,
  TokenUsage,
} from '../src/index.js';
import {
  CodeChunker,
  chunkDocument,
  chunkerFor,
  FixedChunker,
  RecursiveChunker,
  SemanticChunker,
  splitSemanticUnits,
} from '../src/retrieval/chunking.js';
import { ChunkingSpec, type ChunkingStrategy, chunkIdFor } from '../src/retrieval/types.js';
import { at, document, pinned } from './support.js';

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

async function chunksOf(text: string, spec: ChunkingSpec): Promise<readonly ChunkLike[]> {
  return chunkDocument(document('a.md', text), spec);
}

type ChunkLike = Awaited<ReturnType<typeof chunkDocument>>[number];

describe('every strategy', () => {
  it.each(STRATEGIES)('%s covers the whole document', async (strategy) => {
    const produced = await chunksOf(DENSE, specFor(strategy, { size: 80 }));

    expect(at(produced, 0).start).toBe(0);
    expect(at(produced, produced.length - 1).end).toBe(DENSE.length);
    for (let index = 1; index < produced.length; index += 1) {
      expect(at(produced, index - 1).end).toBe(at(produced, index).start);
    }
  });

  it.each(STRATEGIES)('%s numbers its chunks from zero', async (strategy) => {
    const produced = await chunksOf(PROSE, specFor(strategy, { size: 80 }));

    expect(produced.map((item) => item.index)).toEqual(produced.map((_, index) => index));
  });

  it.each(STRATEGIES)('%s derives the id from the content', async (strategy) => {
    const produced = await chunksOf(PROSE, specFor(strategy, { size: 80 }));

    for (const item of produced) {
      expect(item.chunkId).toBe(chunkIdFor('a.md', item.index, item.text));
    }
  });

  it.each(STRATEGIES)('%s bounds the chunk by the size', async (strategy) => {
    const produced = await chunksOf(DENSE, specFor(strategy, { size: 40 }));

    expect(produced.length).toBeGreaterThan(0);
    for (const item of produced) {
      expect(item.text.length).toBeLessThanOrEqual(40);
    }
  });

  it.each(STRATEGIES)('%s never emits a whitespace-only chunk', async (strategy) => {
    const produced = await chunksOf(PROSE, specFor(strategy, { size: 40 }));

    for (const item of produced) {
      expect(item.text.trim().length).toBeGreaterThan(0);
    }
  });

  it.each(STRATEGIES)('%s carries the document identity and its span', async (strategy) => {
    const produced = await chunksOf(DENSE, specFor(strategy, { size: 80 }));

    for (const item of produced) {
      expect(item.docId).toBe('a.md');
      expect(item.text).toBe(DENSE.slice(item.start, item.end));
    }
  });
});

describe('FixedChunker', () => {
  it('fills the window and so cuts mid-token', async () => {
    const produced = await chunksOf(DENSE, specFor('fixed', { size: 42 }));

    expect(at(produced, 0).text.length).toBe(42);
    expect(at(produced, 0).text).toBe(DENSE.slice(0, 42));
    expect(at(produced, 0).text.endsWith(' ')).toBe(false);
  });

  it('backs the next window up by the overlap', async () => {
    const produced = await chunksOf(DENSE, specFor('fixed', { size: 40, overlap: 10 }));

    expect(at(produced, 1).start).toBe(at(produced, 0).end - 10);
  });

  it('makes spans disjoint when there is no overlap', async () => {
    const produced = await chunksOf(DENSE, specFor('fixed', { size: 40 }));

    for (let index = 1; index < produced.length; index += 1) {
      expect(at(produced, index - 1).end).toBe(at(produced, index).start);
    }
  });
});

describe('boundary preference', () => {
  it('recursive prefers a paragraph break to the budget', async () => {
    const text = `${'a'.repeat(50)}\n\n${'b'.repeat(200)}`;

    const produced = await chunksOf(text, specFor('recursive', { size: 80 }));

    expect(at(produced, 0).end).toBe(52);
    expect(at(produced, 0).text).toBe(`${'a'.repeat(50)}\n\n`);
  });

  it('code honours the same paragraph break', async () => {
    const text = `${'a'.repeat(50)}\n\n${'b'.repeat(200)}`;

    const produced = await chunksOf(text, specFor('code', { size: 80 }));

    expect(at(produced, 0).end).toBe(52);
  });

  it('recursive falls back to a sentence end', async () => {
    const text = `${'a'.repeat(50)}. ${'b'.repeat(200)}`;

    const produced = await chunksOf(text, specFor('recursive', { size: 80 }));

    expect(at(produced, 0).end).toBe(52);
  });

  it('code prefers a statement end over a word break', async () => {
    const text = `${'a'.repeat(40)}; ${'b'.repeat(10)} ${'c'.repeat(30)}`;

    const code = await chunksOf(text, specFor('code', { size: 80 }));
    const prose = await chunksOf(text, specFor('recursive', { size: 80 }));

    expect(at(code, 0).end).toBe(42);
    expect(at(prose, 0).end).toBe(53);
  });

  it('rejects a boundary in the first half in favour of the budget', async () => {
    const text = `${'a'.repeat(10)}\n\n${'b'.repeat(200)}`;

    const produced = await chunksOf(text, specFor('recursive', { size: 80 }));

    expect(at(produced, 0).end).toBe(80);
  });

  it('yields at least as many chunks for a smaller size', async () => {
    const coarse = await chunksOf(PROSE, specFor('recursive', { size: 200 }));
    const fine = await chunksOf(PROSE, specFor('recursive', { size: 60 }));

    expect(fine.length).toBeGreaterThanOrEqual(coarse.length);
  });
});

describe('edge cases', () => {
  it('yields no chunks for an empty document', async () => {
    expect(await chunksOf('', specFor('fixed', { size: 40 }))).toEqual([]);
  });

  it('yields one chunk for a document shorter than the size', async () => {
    const produced = await chunksOf('short text', specFor('fixed', { size: 800 }));

    expect(produced.length).toBe(1);
    expect(at(produced, 0).text).toBe('short text');
  });

  it.each([['path'], ['suffix'], ['path', 'suffix']])(
    'keepMetadata copies the named document fields: %s',
    async (...keep: string[]) => {
      const source = document('a.md', 'hello', { path: 'a.md', suffix: '.md' });

      const produced = await chunkDocument(
        source,
        specFor('fixed', { size: 800, keepMetadata: keep }),
      );

      const expected: Record<string, string> = {};
      for (const name of keep) expected[name] = source.metadata[name] as string;
      expect(at(produced, 0).metadata).toEqual(expected);
    },
  );

  it('carries no metadata without keepMetadata', async () => {
    const source = document('a.md', 'hello', { path: 'a.md' });

    const produced = await chunkDocument(source, specFor('fixed', { size: 800 }));

    expect(at(produced, 0).metadata).toEqual({});
  });

  it('does not invent a value for an absent kept field', async () => {
    const produced = await chunkDocument(
      document('a.md', 'hello', { path: 'a.md' }),
      specFor('fixed', { size: 800, keepMetadata: ['absent'] }),
    );

    expect(at(produced, 0).metadata).toEqual({});
  });
});

// --------------------------------------------------------------------------------------
// Semantic chunking
// --------------------------------------------------------------------------------------

const MODEL = pinned();

/** An embedder whose vectors the test chooses, so similarity valleys are deliberate. */
class VectorEmbedder implements Embedder {
  readonly name = 'vector-embedder';
  calls = 0;
  inputTokens = 0;

  constructor(private readonly vector: (text: string) => readonly number[]) {}

  async embed(
    texts: readonly string[],
    _init: { model: PinnedEmbedding },
  ): Promise<EmbeddingBatch> {
    this.calls += 1;
    const inputTokens = texts.reduce((total, text) => total + estimateTokens(text), 0);
    this.inputTokens += inputTokens;
    return new EmbeddingBatch({
      vectors: texts.map((text) => this.vector(text)),
      usage: new TokenUsage({ inputTokens }),
    });
  }

  async close(): Promise<void> {}
}

/** Two topics: alpha/beta land on one axis, gamma/delta on the other. */
function twoTopics(text: string): readonly number[] {
  return text.startsWith('alpha') || text.startsWith('beta') ? [1, 0] : [0, 1];
}

function oneTopic(): readonly number[] {
  return [1, 0];
}

const FOUR_SENTENCES = 'alpha one. beta two. gamma three. delta four.';

async function semanticChunks(
  text: string,
  embedder: VectorEmbedder,
  overrides: { size?: number; overlap?: number } = {},
): Promise<readonly ChunkLike[]> {
  const spec = specFor('semantic', { size: overrides.size ?? 40, overlap: overrides.overlap ?? 0 });
  return chunkerFor(spec, { embedder, model: MODEL }).chunk(document('a.md', text));
}

describe('SemanticChunker', () => {
  it('cuts where adjacent-unit similarity dips', async () => {
    const produced = await semanticChunks(FOUR_SENTENCES, new VectorEmbedder(twoTopics));

    expect(produced.map((item) => item.text)).toEqual([
      'alpha one. beta two. ',
      'gamma three. delta four.',
    ]);
  });

  it('keeps a document with no dip in one chunk', async () => {
    const produced = await semanticChunks(FOUR_SENTENCES, new VectorEmbedder(oneTopic), {
      size: 800,
    });

    expect(produced.length).toBe(1);
    expect(at(produced, 0).text).toBe(FOUR_SENTENCES);
  });

  it('bounds every chunk by the size', async () => {
    const produced = await semanticChunks(DENSE, new VectorEmbedder(oneTopic), { size: 40 });

    expect(produced.length).toBeGreaterThan(0);
    for (const chunk of produced) {
      expect(chunk.text.length).toBeLessThanOrEqual(40);
    }
  });

  it('carries the trailing units of the previous chunk for the overlap', async () => {
    const produced = await semanticChunks(FOUR_SENTENCES, new VectorEmbedder(twoTopics), {
      overlap: 10,
    });

    expect(at(produced, 1).start).toBeLessThan(at(produced, 0).end);
    expect(at(produced, 1).text.startsWith('beta two. ')).toBe(true);
  });

  it.each([[''], ['   \n\n\t ']])(
    'yields no chunks and no embed calls for an empty document: %j',
    async (text) => {
      const embedder = new VectorEmbedder(twoTopics);

      expect(await semanticChunks(text, embedder)).toEqual([]);
      expect(embedder.calls).toBe(0);
    },
  );

  it('yields one chunk and no embed calls for a single unit', async () => {
    const embedder = new VectorEmbedder(twoTopics);

    const produced = await semanticChunks('one short sentence', embedder, { size: 800 });

    expect(produced.length).toBe(1);
    expect(at(produced, 0).text).toBe('one short sentence');
    expect(embedder.calls).toBe(0);
  });

  it('derives the id from the content, deterministically across runs', async () => {
    const first = await semanticChunks(FOUR_SENTENCES, new VectorEmbedder(twoTopics));
    const second = await semanticChunks(FOUR_SENTENCES, new VectorEmbedder(twoTopics));

    expect(second.map((item) => item.chunkId)).toEqual(first.map((item) => item.chunkId));
    expect(second.map((item) => item.text)).toEqual(first.map((item) => item.text));
    for (const chunk of first) {
      expect(chunk.chunkId).toBe(chunkIdFor('a.md', chunk.index, chunk.text));
    }
  });

  it('exposes the boundary pass usage for the ingest report', async () => {
    const embedder = new VectorEmbedder(twoTopics);
    const chunker = chunkerFor(specFor('semantic', { size: 40 }), { embedder, model: MODEL });

    await chunker.chunk(document('a.md', FOUR_SENTENCES));

    expect(chunker.usage.inputTokens).toBeGreaterThan(0);
    expect(chunker.usage.inputTokens).toBe(embedder.inputTokens);
  });

  it('splits a long paragraph on newlines instead of mid-word', async () => {
    const text = Array.from({ length: 20 }, (_, index) => `line ${index} of prose\n`).join('');

    const units = splitSemanticUnits(text, 64);

    expect(units.length).toBeGreaterThan(1);
    for (const [start, end] of units) {
      const unit = text.slice(start, end);
      expect(unit.length).toBeLessThanOrEqual(64);
      expect(unit.endsWith('\n')).toBe(true);
    }
  });
});

describe('chunkerFor', () => {
  it('builds the strategy that was declared', () => {
    expect(chunkerFor(specFor('fixed'))).toBeInstanceOf(FixedChunker);
    expect(chunkerFor(specFor('recursive'))).toBeInstanceOf(RecursiveChunker);
    expect(chunkerFor(specFor('code'))).toBeInstanceOf(CodeChunker);
  });

  it('builds a semantic chunker from the retriever embedder', () => {
    const chunker = chunkerFor(specFor('semantic'), {
      embedder: new VectorEmbedder(oneTopic),
      model: MODEL,
    });

    expect(chunker).toBeInstanceOf(SemanticChunker);
    expect(chunker.strategy).toBe('semantic');
  });

  it('refuses semantic chunking without the retriever embedder', () => {
    expect(() => chunkerFor(specFor('semantic'))).toThrow(ConfigurationError);
    expect(() => chunkerFor(specFor('semantic'))).toThrow(/embedder/);
  });

  it('reports its strategy', () => {
    expect(chunkerFor(specFor('recursive')).strategy).toBe('recursive');
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
