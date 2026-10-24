/**
 * Fixtures shared by the runtime tests.
 *
 * Mirrors `tests/conftest.py` and `tests/retrieval_support.py` in the Python runtime so
 * the two suites describe the same system. The one thing deliberately *not* mirrored is
 * any recorded baseline: the fake providers draw their accuracy samples differently in
 * the two runtimes, so every baseline asserted on here is computed by this runtime.
 */

import type { Capability } from '../src/index.js';
import {
  bindingFromSpec,
  Chunk,
  ChunkingSpec,
  CostProfile,
  chunkIdFor,
  cite,
  Dataset,
  EmbeddingCostProfile,
  EmbeddingSpec,
  EvalCase,
  FakeProvider,
  IndexSpec,
  Message,
  ModelGateway,
  ModelSpec,
  type PinnedEmbedding,
  pinnedEmbedding,
  RefreshSpec,
  RetrievalCase,
  RetrievalResult,
  RetrievedItem,
  type RetrieverBinding,
  RetrieverSpec,
  SourceDocument,
  SourceSpec,
  TokenUsage,
  VectorStoreSpec,
} from '../src/index.js';

export const FAKE_PROVIDER = 'fake';
export const SMALL_ALIAS = 'small';
export const LARGE_ALIAS = 'large';

export function smallSpec(): ModelSpec {
  return new ModelSpec({
    name: 'fake-small-1',
    provider: FAKE_PROVIDER,
    cost: new CostProfile({ inputPer1kUsd: 0.15, outputPer1kUsd: 0.6 }),
    contextWindow: 128_000,
    maxOutputTokens: 4096,
    capabilities: ['tool-calling', 'structured-output'],
  });
}

export function largeSpec(): ModelSpec {
  return new ModelSpec({
    name: 'fake-large-1',
    provider: FAKE_PROVIDER,
    cost: new CostProfile({ inputPer1kUsd: 2.5, outputPer1kUsd: 10.0 }),
    contextWindow: 200_000,
    maxOutputTokens: 8192,
    capabilities: ['tool-calling', 'structured-output'],
  });
}

/** A gateway over the fake provider, with a `small` and a `large` alias. */
export function modelGateway(
  provider: FakeProvider = new FakeProvider({ accuracy: 1.0 }),
): ModelGateway {
  return new ModelGateway({
    providers: { [FAKE_PROVIDER]: provider },
    aliases: { [SMALL_ALIAS]: smallSpec(), [LARGE_ALIAS]: largeSpec() },
  });
}

/** A provider that declares only what it is told to, for capability tests. */
export class DeclaredProvider {
  readonly name = FAKE_PROVIDER;
  readonly capabilities: ReadonlySet<Capability>;

  constructor(capabilities: readonly Capability[] = []) {
    this.capabilities = new Set(capabilities);
  }

  async complete(): Promise<never> {
    throw new Error('this fixture provider is a capability declaration only');
  }

  async close(): Promise<void> {}
}

/** The four capital cases the gate tests sample. */
export function capitalsCases(): EvalCase[] {
  return [
    new EvalCase({ id: 'capital-fr', input: 'What is the capital of France?', expected: 'Paris' }),
    new EvalCase({ id: 'capital-jp', input: 'What is the capital of Japan?', expected: 'Tokyo' }),
    new EvalCase({ id: 'capital-pe', input: 'What is the capital of Peru?', expected: 'Lima' }),
    new EvalCase({ id: 'capital-ke', input: 'What is the capital of Kenya?', expected: 'Nairobi' }),
  ];
}

export function capitalsDataset(): Dataset {
  return new Dataset({ name: 'capitals', version: '1.0.0', cases: capitalsCases() });
}

export function usage(input: number, output: number): TokenUsage {
  return new TokenUsage({ inputTokens: input, outputTokens: output });
}

export function messages(text: string): Message[] {
  return [Message.user(text)];
}

/** Read `index` from `items`, failing loudly instead of yielding `undefined`. */
/**
 * Await a promise that must reject, and hand back the failure as an `Error`.
 *
 * `promise.catch((caught) => caught as Error)` widens to `Result | Error`, which then
 * needs a cast at every use site. This narrows once, and it fails loudly when the call
 * unexpectedly succeeds instead of asserting against the success value.
 */
export async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (caught) {
    return caught as Error;
  }
  throw new Error('expected the call to fail, but it succeeded');
}

export function at<T>(items: readonly T[], index: number): T {
  const found = items[index];
  if (found === undefined) throw new Error(`no item at index ${index} (length ${items.length})`);
  return found;
}

// --------------------------------------------------------------------------------------
// Retrieval fixtures
// --------------------------------------------------------------------------------------

export const RETRIEVER_ID = 'docs';
export const STORE_ID = 'docs';
export const EMBED_ID = 'embed';
export const EMBED_ALIAS = 'embed-small';
export const MODEL_ID = 'text-embedding-3-small';
export const EMBED_DIMENSIONS = 32;

export function embeddingSpec(overrides: { dimensions?: number | null } = {}): EmbeddingSpec {
  return new EmbeddingSpec({
    id: EMBED_ID,
    provider: FAKE_PROVIDER,
    modelId: MODEL_ID,
    dimensions: overrides.dimensions === undefined ? EMBED_DIMENSIONS : overrides.dimensions,
    costProfile: new EmbeddingCostProfile({ inputPerMTok: 0.02, outputPerMTok: 0 }),
  });
}

export function pinned(overrides: { dimensions?: number; alias?: string } = {}): PinnedEmbedding {
  return pinnedEmbedding(embeddingSpec(), {
    alias: overrides.alias ?? EMBED_ALIAS,
    dimensions: overrides.dimensions,
  });
}

export function storeSpec(
  overrides: { kind?: 'memory' | 'pgvector'; uri?: string | null; dimensions?: number | null } = {},
): VectorStoreSpec {
  return new VectorStoreSpec({
    id: STORE_ID,
    kind: overrides.kind ?? 'memory',
    uri: overrides.uri ?? null,
    dimensions: overrides.dimensions === undefined ? EMBED_DIMENSIONS : overrides.dimensions,
  });
}

export function chunkingSpec(
  overrides: { size?: number; overlap?: number; keepMetadata?: readonly string[] } = {},
): ChunkingSpec {
  return new ChunkingSpec({
    strategy: 'fixed',
    size: overrides.size ?? 400,
    overlap: overrides.overlap ?? 0,
    keepMetadata: overrides.keepMetadata ?? [],
  });
}

export interface RetrieverSpecOverrides {
  readonly topK?: number;
  readonly hybrid?: boolean;
  readonly metric?: 'cosine' | 'dot' | 'l2';
  readonly rerank?: RerankSpecArg | null;
  readonly chunking?: ChunkingSpec;
  readonly glob?: string | null;
}

type RerankSpecArg = import('../src/index.js').RerankSpec;

export function retrieverSpec(overrides: RetrieverSpecOverrides = {}): RetrieverSpec {
  return new RetrieverSpec({
    id: RETRIEVER_ID,
    source: new SourceSpec({ kind: 'file', uri: './docs', glob: overrides.glob ?? null }),
    chunking: overrides.chunking ?? chunkingSpec(),
    embedModel: EMBED_ID,
    store: STORE_ID,
    index: new IndexSpec({
      metric: overrides.metric ?? 'cosine',
      hybrid: overrides.hybrid ?? false,
    }),
    topK: overrides.topK ?? 4,
    rerank: overrides.rerank ?? null,
    refresh: new RefreshSpec({ mode: 'full' }),
  });
}

export function binding(
  overrides: RetrieverSpecOverrides & { storeKind?: 'memory' | 'pgvector' } = {},
): RetrieverBinding {
  return bindingFromSpec(retrieverSpec(overrides), {
    embedding: embeddingSpec(),
    store: storeSpec(overrides.storeKind === undefined ? {} : { kind: overrides.storeKind }),
  });
}

export function document(
  docId: string,
  text: string,
  metadata: Readonly<Record<string, string>> = {},
): SourceDocument {
  return new SourceDocument({ docId, uri: `memory://${docId}`, text, metadata });
}

export function chunk(
  docId: string,
  index: number,
  text: string,
  overrides: { start?: number; end?: number; metadata?: Readonly<Record<string, string>> } = {},
): Chunk {
  return new Chunk({
    chunkId: chunkIdFor(docId, index, text),
    docId,
    uri: `memory://${docId}`,
    index,
    start: overrides.start ?? 0,
    end: overrides.end ?? text.length,
    text,
    metadata: overrides.metadata ?? {},
  });
}

export function item(source: Chunk, score: number, rank: number): RetrievedItem {
  return new RetrievedItem({ chunk: source, score, rank, citation: cite(source) });
}

export function result(
  query: string,
  items: readonly RetrievedItem[],
  retriever = RETRIEVER_ID,
): RetrievalResult {
  return new RetrievalResult({ retriever, query, items });
}

export function retrievalCase(
  init: { id?: string; query?: string; expectDocs?: readonly string[]; k?: number } = {},
): RetrievalCase {
  return new RetrievalCase({
    id: init.id ?? 'case-1',
    query: init.query ?? 'how does retrieval work',
    expectDocs: init.expectDocs ?? ['a.md'],
    k: init.k ?? 2,
  });
}
