/**
 * Retrieved passages, their provenance, and the context they assemble into.
 *
 * A retrieved set is only useful to a model if the passages arrive with provenance
 * the model can repeat back, so ranking and citation are one type here rather than a
 * search result plus a separate lookup table. {@link RetrievalResult} is the
 * runtime's answer type: it is what a `retrieve` step produces and what every
 * retrieval metric scores.
 *
 * The assembled context is numbered by **rank**, not by position in the array. The
 * two are the same in practice because ranks are assigned contiguously from 1, but
 * naming the rank is what makes a model's `[2]` resolvable by the caller without
 * re-running the search.
 */

import { ConfigurationError } from '../errors.js';
import type { Chunk } from './types.js';

/**
 * Where one retrieved passage came from.
 *
 * `docId` is the document identity the IR's retrieval metric already uses
 * (`expectDocs: [getting-started.md]`), so a citation and a gate expectation are the
 * same vocabulary rather than two spellings of the same thing.
 */
export class Citation {
  readonly docId: string;
  readonly chunkId: string;
  readonly uri: string;
  readonly index: number;

  constructor(init: {
    readonly docId: string;
    readonly chunkId: string;
    readonly uri?: string;
    readonly index: number;
  }) {
    if (init.docId.length === 0) throw new ConfigurationError('citation docId must not be empty');
    if (init.chunkId.length === 0) {
      throw new ConfigurationError('citation chunkId must not be empty');
    }
    if (!Number.isInteger(init.index) || init.index < 0) {
      throw new ConfigurationError('citation index must be a non-negative integer');
    }
    this.docId = init.docId;
    this.chunkId = init.chunkId;
    this.uri = init.uri ?? '';
    this.index = init.index;
  }

  toString(): string {
    return `${this.docId}#${this.index}`;
  }
}

/** One ranked passage: the chunk, its score, and its provenance. */
export class RetrievedItem {
  readonly chunk: Chunk;
  readonly score: number;
  readonly rank: number;
  readonly citation: Citation;

  constructor(init: {
    readonly chunk: Chunk;
    readonly score: number;
    readonly rank: number;
    readonly citation: Citation;
  }) {
    if (!Number.isInteger(init.rank) || init.rank < 1) {
      throw new ConfigurationError('retrieved item rank must be at least 1');
    }
    this.chunk = init.chunk;
    this.score = init.score;
    this.rank = init.rank;
    this.citation = init.citation;
  }
}

/**
 * What a `retrieve` step returns.
 *
 * `items` is rank-ordered and may be empty -- "the corpus has nothing for this
 * query" is a result, not an error, and a caller that needs a non-empty answer says
 * so with a metric rather than by crashing.
 */
export class RetrievalResult {
  readonly retriever: string;
  readonly query: string;
  readonly items: readonly RetrievedItem[];

  constructor(init: {
    readonly retriever: string;
    readonly query: string;
    readonly items?: readonly RetrievedItem[];
  }) {
    if (init.retriever.length === 0) {
      throw new ConfigurationError('retriever must not be empty');
    }
    this.retriever = init.retriever;
    this.query = init.query;
    this.items = [...(init.items ?? [])];
  }

  get length(): number {
    return this.items.length;
  }

  /** The first `k` items, or all of them when the result is shorter. */
  top(k: number): readonly RetrievedItem[] {
    return this.items.slice(0, k);
  }

  /** The numbered excerpts a prompt binds. */
  get context(): string {
    return assembleContext(this.items);
  }

  /** One citation per item, in rank order. */
  get citations(): readonly Citation[] {
    return this.items.map((item) => item.citation);
  }

  /**
   * Rank-ordered, de-duplicated document ids.
   *
   * De-duplicated because recall is about *documents found*, and a document that
   * contributed three passages was found once. First occurrence wins, so the order
   * still reflects relevance.
   */
  get docIds(): readonly string[] {
    return [...new Set(this.items.map((item) => item.citation.docId))];
  }
}

/**
 * The citation for a chunk.
 *
 * Derived from the chunk rather than passed alongside it, so a citation cannot drift
 * from the passage it names.
 */
export function cite(chunk: Chunk): Citation {
  return new Citation({
    docId: chunk.docId,
    chunkId: chunk.chunkId,
    uri: chunk.uri,
    index: chunk.index,
  });
}

/**
 * Render ranked items as numbered excerpts, each tagged with its citation.
 *
 * An empty retrieval renders as the empty string rather than as a header with nothing
 * under it: a header alone reads to a model as "sources were found", and a prompt
 * that invites a model to invent a source is worse than an empty prompt.
 */
export function assembleContext(
  items: readonly RetrievedItem[],
  options: { readonly separator?: string } = {},
): string {
  const separator = options.separator ?? '\n\n';
  return items
    .map((item) => `[${item.rank}] ${item.citation.toString()} :: ${item.chunk.text}`)
    .join(separator);
}
