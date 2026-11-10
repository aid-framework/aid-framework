/**
 * Turning documents into deterministic, size-bounded chunks.
 *
 * The IR declares a strategy, a size and an overlap; it does not declare the split
 * algorithm. This module pins one. Three of the four strategies are size-bounded
 * splitters and the only thing that distinguishes them is **where a boundary is
 * allowed to fall**:
 *
 * `fixed`
 *     Anywhere. The window always fills to `size`, cutting mid-word when that is
 *     where the budget ends. This is the honest baseline other strategies improve on.
 * `recursive`
 *     Prefer the last paragraph break, then the last line break, then the last
 *     sentence end, then the last word break inside the window.
 * `code`
 *     Prefer the last blank line, then the last line break, then the last statement
 *     end. Code is line-structured, so a blank line is the closest thing it has to a
 *     paragraph, and cutting mid-statement is the failure worth avoiding.
 * `semantic`
 *     Cut where adjacent-unit embedding similarity dips, not where a budget runs out.
 *     This is the one strategy that costs more than the chunks it produces: it splits
 *     the document into atomic units, embeds every unit to find the boundaries, and
 *     only then emits chunks. That is why `chunk` is asynchronous and why a chunker
 *     reports `usage` -- the boundary pass is real work the ingest has to account for.
 *
 * Chunks are pure functions of the text, so the same input always produces the same
 * chunks with the same ids in the same order -- which is what makes re-ingesting a
 * corpus a no-op instead of a duplicate. `semantic` keeps that property because the
 * pinned model is deterministic for a given text: same input, same embeddings, same
 * boundaries.
 */

import { ConfigurationError, FeatureDeferredError } from '../errors.js';
import { repr } from '../internal/json.js';
import { TokenUsage } from '../types.js';
import type { SourceDocument } from './connectors.js';
import type { Embedder } from './embedding.js';
import {
  Chunk,
  type ChunkingSpec,
  type ChunkingStrategy,
  chunkIdFor,
  type PinnedEmbedding,
} from './types.js';

/**
 * A boundary found in the first half of a window is ignored and the window is
 * filled to `size` instead. Without this, one early paragraph break near the end of
 * a split would produce a stream of very short chunks, and a chunker that emits
 * 5-character chunks is worse than one that cuts a sentence in half.
 */
const MIN_FILL_NUMERATOR = 1;
const MIN_FILL_DENOMINATOR = 2;

/**
 * How similar two adjacent units must be for the boundary between them to count as a
 * valley worth cutting at.
 *
 * The pinned models put adjacent sentences of one paragraph at roughly 0.85-0.95 and
 * sentences from different topics well below that. 0.72 sits under the same-paragraph
 * band with room for paraphrase and list items, and above the cross-topic band, so a
 * dip is a topic change rather than a punctuation change. It is a documented constant
 * rather than a config field on purpose: a per-spec threshold would change the IR,
 * and therefore every chunk id, for a tuning knob nobody asked to tune.
 */
export const SEMANTIC_SIMILARITY_THRESHOLD = 0.72;

/**
 * A chunk shorter than `size / SEMANTIC_MIN_CHUNK_DIVISOR` is a runt. It is merged
 * forward into its neighbour when that still fits, so a topic tail does not become a
 * chunk too small to retrieve usefully.
 */
export const SEMANTIC_MIN_CHUNK_DIVISOR = 4;

/** The same hierarchy `recursive` prefers, from coarsest to finest. */
const SEMANTIC_SEPARATORS: readonly (readonly string[])[] = [['\n\n'], ['\n'], ['. ', '! ', '? ']];

/** A strategy's preference order, outermost first. */
export type MarkerGroups = readonly (readonly string[])[];

/** Splits a document into chunks, deterministically. */
export interface Chunker {
  readonly strategy: ChunkingStrategy;
  /** Tokens the chunker itself spent; zero for every strategy but `semantic`. */
  readonly usage: TokenUsage;
  chunk(document: SourceDocument): Promise<readonly Chunk[]>;
}

/** Reject a window that could not advance, for every chunker family. */
function checkWindow(size: number, overlap: number): void {
  if (size <= 0) {
    throw new ConfigurationError('chunking size must be positive');
  }
  if (overlap < 0) {
    throw new ConfigurationError('chunking overlap must not be negative');
  }
  if (overlap >= size) {
    throw new ConfigurationError(
      `chunking overlap ${overlap} must be smaller than size ${size}; otherwise a ` +
        'window would not advance and chunking would never terminate',
    );
  }
}

/** Read a sequence at an index the surrounding invariants prove is in range. */
function at<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) {
    throw new RangeError(`index ${index} is out of range for a sequence of ${items.length}`);
  }
  return value;
}

/** Build one chunk, keeping only the metadata keys the spec asks to keep. */
function buildChunk(
  document: SourceDocument,
  index: number,
  start: number,
  end: number,
  text: string,
  keep: readonly string[],
): Chunk {
  const metadata: Record<string, string> = {};
  for (const key of keep) {
    const value = document.metadata[key];
    if (value !== undefined) metadata[key] = value;
  }
  return new Chunk({
    chunkId: chunkIdFor(document.docId, index, text),
    docId: document.docId,
    uri: document.uri,
    index,
    start,
    end,
    text,
    metadata,
  });
}

/** Shared windowing. Subclasses only choose where a boundary may fall. */
abstract class SizeChunker implements Chunker {
  private readonly _size: number;
  private readonly _overlap: number;
  private readonly _keep: readonly string[];
  readonly usage: TokenUsage = new TokenUsage();

  constructor(init: {
    readonly size: number;
    readonly overlap: number;
    readonly keepMetadata?: readonly string[];
  }) {
    checkWindow(init.size, init.overlap);
    this._size = init.size;
    this._overlap = init.overlap;
    this._keep = [...(init.keepMetadata ?? [])];
  }

  abstract get strategy(): ChunkingStrategy;

  /** Where to end the window that starts at `start` and may reach `limit`. */
  protected abstract cut(text: string, start: number, limit: number): number;

  async chunk(document: SourceDocument): Promise<readonly Chunk[]> {
    const text = document.text;
    const chunks: Chunk[] = [];
    let start = 0;
    while (start < text.length) {
      const limit = Math.min(start + this._size, text.length);
      let end = limit >= text.length ? limit : this.cut(text, start, limit);
      // A boundary at or before `start` would stall the loop, so progress is
      // guaranteed here rather than trusted from the strategy hook.
      end = Math.max(end, start + 1);
      const window = text.slice(start, end);
      if (window.trim().length > 0) {
        chunks.push(buildChunk(document, chunks.length, start, end, window, this._keep));
      }
      if (end >= text.length) {
        break;
      }
      start = Math.max(end - this._overlap, start + 1);
    }
    return chunks;
  }

  /**
   * The end offset of the last `marker` in `text.slice(start, limit)`, if usable.
   *
   * `null` means "no boundary worth taking", and the caller falls back to `limit`.
   * The minimum-fill rule is applied here rather than by each strategy so no
   * strategy can forget it.
   */
  private boundary(
    text: string,
    start: number,
    limit: number,
    markers: readonly string[],
  ): number | null {
    const floor = start + Math.floor((this._size * MIN_FILL_NUMERATOR) / MIN_FILL_DENOMINATOR);
    const window = text.slice(start, limit);
    for (const marker of markers) {
      const position = window.lastIndexOf(marker);
      if (position === -1) continue;
      const end = start + position + marker.length;
      if (end >= Math.max(floor, start + 1)) {
        return end;
      }
    }
    return null;
  }

  /** The first usable boundary from `markerGroups`, in preference order. */
  protected fill(text: string, start: number, limit: number, markerGroups: MarkerGroups): number {
    for (const markers of markerGroups) {
      const found = this.boundary(text, start, limit, markers);
      if (found !== null) return found;
    }
    return limit;
  }
}

/** Cuts on size alone. */
export class FixedChunker extends SizeChunker {
  override get strategy(): ChunkingStrategy {
    return 'fixed';
  }

  protected override cut(_text: string, _start: number, limit: number): number {
    return limit;
  }
}

/** Prefers prose boundaries: paragraph, then line, then sentence, then word. */
export class RecursiveChunker extends SizeChunker {
  override get strategy(): ChunkingStrategy {
    return 'recursive';
  }

  protected override cut(text: string, start: number, limit: number): number {
    return this.fill(text, start, limit, [['\n\n'], ['\n'], ['. ', '! ', '? '], [' ']]);
  }
}

/** Prefers code boundaries: blank line, then line, then statement, then token. */
export class CodeChunker extends SizeChunker {
  override get strategy(): ChunkingStrategy {
    return 'code';
  }

  protected override cut(text: string, start: number, limit: number): number {
    return this.fill(text, start, limit, [['\n\n'], ['\n'], [';\n', ';\r\n', '; '], [' ']]);
  }
}

/** Split `text.slice(start, end)` on every separator hit, keeping the separator. */
function splitSpan(
  text: string,
  start: number,
  end: number,
  separators: readonly string[],
): readonly (readonly [number, number])[] {
  const pieces: (readonly [number, number])[] = [];
  let cursor = start;
  let position = start;
  while (position < end) {
    const matched = separators.find((item) => text.startsWith(item, position));
    if (matched === undefined) {
      position += 1;
      continue;
    }
    const cut = position + matched.length;
    pieces.push([cursor, cut] as const);
    cursor = cut;
    position = cut;
  }
  if (cursor < end) {
    pieces.push([cursor, end] as const);
  }
  return pieces;
}

/**
 * Atomic units: the recursive hierarchy, hard-cut only when nothing else fits.
 *
 * A separator stays with the piece it ends, so a unit is always a raw slice of the
 * document and joining the units reproduces it exactly. Nothing inside a unit is
 * ever split again, which is what makes a boundary mean "topic changed" rather than
 * "budget ran out".
 */
export function splitSemanticUnits(
  text: string,
  size: number,
): readonly (readonly [number, number])[] {
  const units: (readonly [number, number])[] = [];

  const visit = (start: number, end: number, depth: number): void => {
    if (end <= start) return;
    if (end - start <= size) {
      if (text.slice(start, end).trim().length > 0) units.push([start, end] as const);
      return;
    }
    if (depth < SEMANTIC_SEPARATORS.length) {
      const separators = at(SEMANTIC_SEPARATORS, depth);
      const pieces = splitSpan(text, start, end, separators);
      if (pieces.length > 1) {
        for (const [pieceStart, pieceEnd] of pieces) visit(pieceStart, pieceEnd, depth + 1);
        return;
      }
      // Nothing at this level separated the span, so try the next level with the same
      // span rather than jumping straight to a hard cut. Falling through here would
      // cut prose with no blank lines mid-word even though it has plenty of line
      // breaks.
      visit(start, end, depth + 1);
      return;
    }
    // The bottom of the hierarchy: one word or one very long line, where a hard cut is
    // the only boundary left and `size` bounds it.
    for (let cut = start; cut < end; cut += size) {
      visit(cut, Math.min(cut + size, end), SEMANTIC_SEPARATORS.length);
    }
  };

  visit(0, text.length, 0);
  return units;
}

function cosine(left: readonly number[], right: readonly number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const l = at(left, index);
    const r = at(right, index);
    dot += l * r;
    leftNorm += l * l;
    rightNorm += r * r;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

/** True when the similarity at `index` is a local low below the threshold. */
function isValley(similarities: readonly number[], index: number): boolean {
  const score = at(similarities, index);
  if (score >= SEMANTIC_SIMILARITY_THRESHOLD) return false;
  if (index > 0 && at(similarities, index - 1) < score) return false;
  if (index + 1 < similarities.length && at(similarities, index + 1) < score) return false;
  return true;
}

/**
 * Fold any chunk shorter than `floor` into a neighbour where the result fits.
 *
 * A size overflow can leave a short chunk in the middle of a document, not only at
 * the end, so this repairs any runt: backward when the previous chunk has room, then
 * forward when the next one does. A runt with no room on either side stays as it is,
 * because growing it would break the `size` cap.
 */
function mergeRunts(
  spans: readonly (readonly [number, number])[],
  floor: number,
  size: number,
): readonly (readonly [number, number])[] {
  const merged = [...spans];
  let index = 0;
  while (index < merged.length && merged.length > 1) {
    const [start, end] = at(merged, index);
    if (end - start >= floor) {
      index += 1;
      continue;
    }
    if (index > 0 && end - at(merged, index - 1)[0] <= size) {
      merged[index - 1] = [at(merged, index - 1)[0], end] as const;
      merged.splice(index, 1);
      index = Math.max(index - 1, 0);
      continue;
    }
    if (index + 1 < merged.length && at(merged, index + 1)[1] - start <= size) {
      merged[index] = [start, at(merged, index + 1)[1]] as const;
      merged.splice(index + 1, 1);
      continue;
    }
    index += 1;
  }
  return merged;
}

/**
 * Cuts where adjacent-unit similarity dips, rather than at a fixed size.
 *
 * The boundary pass and the chunk pass are separate: this class embeds the atomic
 * units to find the boundaries, and the retriever embeds the finished chunks to
 * index them. `usage` reports the boundary pass so the ingest report can account for
 * it; the chunk embeddings are reported by the retriever itself.
 */
export class SemanticChunker implements Chunker {
  readonly strategy: ChunkingStrategy = 'semantic';
  private readonly _size: number;
  private readonly _overlap: number;
  private readonly _keep: readonly string[];
  private readonly _embedder: Embedder;
  private readonly _model: PinnedEmbedding;
  private _usage: TokenUsage = new TokenUsage();

  constructor(init: {
    readonly size: number;
    readonly overlap: number;
    readonly keepMetadata?: readonly string[];
    readonly embedder: Embedder;
    readonly model: PinnedEmbedding;
  }) {
    checkWindow(init.size, init.overlap);
    this._size = init.size;
    this._overlap = init.overlap;
    this._keep = [...(init.keepMetadata ?? [])];
    this._embedder = init.embedder;
    this._model = init.model;
  }

  get usage(): TokenUsage {
    return this._usage;
  }

  async chunk(document: SourceDocument): Promise<readonly Chunk[]> {
    const text = document.text;
    this._usage = new TokenUsage();
    if (text.trim().length === 0) return [];
    const units = splitSemanticUnits(text, this._size);
    if (units.length === 0) return [];
    if (units.length === 1) {
      // One unit needs no boundary decision, so the boundary pass is skipped
      // entirely: zero embed calls, and `usage` stays zero.
      const [start, end] = at(units, 0);
      return [buildChunk(document, 0, start, end, text.slice(start, end), this._keep)];
    }

    const batch = await this._embedder.embed(
      units.map(([start, end]) => text.slice(start, end)),
      { model: this._model },
    );
    this._usage = batch.usage;
    const similarities = units
      .slice(0, -1)
      .map((_, index) => cosine(at(batch.vectors, index), at(batch.vectors, index + 1)));
    const floor = Math.max(1, Math.floor(this._size / SEMANTIC_MIN_CHUNK_DIVISOR));

    const spans: (readonly [number, number])[] = [];
    let firstUnit = 0;
    let cursorStart = at(units, 0)[0];
    for (let index = 0; index < units.length - 1; index += 1) {
      const [nextStart, nextEnd] = at(units, index + 1);
      const length = at(units, index)[1] - cursorStart;
      const overflows = length + (nextEnd - nextStart) > this._size;
      const dips = length >= floor && isValley(similarities, index);
      if (!overflows && !dips) continue;
      spans.push([cursorStart, at(units, index)[1]] as const);
      const carried = this._carry(units, firstUnit, index, index + 1);
      firstUnit = carried.length > 0 ? at(carried, 0) : index + 1;
      cursorStart = at(units, firstUnit)[0];
    }
    spans.push([cursorStart, at(units, units.length - 1)[1]] as const);

    const chunks: Chunk[] = [];
    for (const [start, end] of mergeRunts(spans, floor, this._size)) {
      const window = text.slice(start, end);
      if (window.trim().length > 0) {
        chunks.push(buildChunk(document, chunks.length, start, end, window, this._keep));
      }
    }
    return chunks;
  }

  /** Trailing units of the chunk just emitted that fit inside `overlap`. */
  private _carry(
    units: readonly (readonly [number, number])[],
    first: number,
    last: number,
    nextUnit: number,
  ): readonly number[] {
    const carried: number[] = [];
    let carriedLength = 0;
    const nextLength = at(units, nextUnit)[1] - at(units, nextUnit)[0];
    for (let index = last; index >= first; index -= 1) {
      const unitLength = at(units, index)[1] - at(units, index)[0];
      if (carriedLength + unitLength > this._overlap) break;
      if (carriedLength + unitLength + nextLength > this._size) break;
      carried.unshift(index);
      carriedLength += unitLength;
    }
    return carried;
  }
}

/**
 * Resolve a chunking block to an implementation.
 *
 * `semantic` needs the retriever's own embedder and pinned model, because it embeds
 * the units to choose a boundary. Nothing here resolves an alias or picks a model:
 * the caller passes the pin the index already uses. An unknown strategy is still
 * refused, because the runtime is reachable from generated code the validator never
 * saw.
 */
export function chunkerFor(
  spec: ChunkingSpec,
  options: {
    readonly embedder?: Embedder;
    readonly model?: PinnedEmbedding;
  } = {},
): Chunker {
  const window = {
    size: spec.size,
    overlap: spec.overlap,
    keepMetadata: spec.keepMetadata,
  };
  switch (spec.strategy) {
    case 'fixed':
      return new FixedChunker(window);
    case 'recursive':
      return new RecursiveChunker(window);
    case 'code':
      return new CodeChunker(window);
    case 'semantic':
      if (options.embedder === undefined || options.model === undefined) {
        throw new ConfigurationError(
          "semantic chunking needs the retriever's embedder and pinned model; pass both " +
            'to chunkerFor rather than letting the runtime choose one',
        );
      }
      return new SemanticChunker({
        ...window,
        embedder: options.embedder,
        model: options.model,
      });
    /* istanbul ignore next -- unreachable while the union above is exhaustive */
    default:
      throw new FeatureDeferredError(
        `chunking strategy ${repr(String(spec.strategy))} is declared but not implemented: ` +
          'fixed, recursive, code and semantic are the strategies this runtime chunks with',
      );
  }
}

/** Chunk one document with the strategy the spec names. */
export async function chunkDocument(
  document: SourceDocument,
  spec: ChunkingSpec,
  options: {
    readonly embedder?: Embedder;
    readonly model?: PinnedEmbedding;
  } = {},
): Promise<readonly Chunk[]> {
  return chunkerFor(spec, options).chunk(document);
}
