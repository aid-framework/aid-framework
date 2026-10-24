/**
 * Turning documents into deterministic, size-bounded chunks.
 *
 * The IR declares a strategy, a size and an overlap; it does not declare the split
 * algorithm. This module pins one, and the pin is the spec validator's own reading
 * of the intent: *"spec v0.1 chunks by size (fixed, recursive, code)"*. `semantic`
 * is refused because it needs an embedding pass over the whole source at ingest --
 * a different shape of job, not a different boundary rule.
 *
 * So all three implemented strategies are size-bounded splitters and the only thing
 * that distinguishes them is **where a boundary is allowed to fall**:
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
 *
 * Chunks are pure functions of the text, so the same input always produces the same
 * chunks with the same ids in the same order -- which is what makes re-ingesting a
 * corpus a no-op instead of a duplicate.
 */

import { ConfigurationError, FeatureDeferredError } from '../errors.js';
import { repr } from '../internal/json.js';
import type { SourceDocument } from './connectors.js';
import { Chunk, type ChunkingSpec, type ChunkingStrategy, chunkIdFor } from './types.js';

/**
 * A boundary found in the first half of a window is ignored and the window is
 * filled to `size` instead. Without this, one early paragraph break near the end of
 * a split would produce a stream of very short chunks, and a chunker that emits
 * 5-character chunks is worse than one that cuts a sentence in half.
 */
const MIN_FILL_NUMERATOR = 1;
const MIN_FILL_DENOMINATOR = 2;

/** A strategy's preference order, outermost first. */
export type MarkerGroups = readonly (readonly string[])[];

/** Splits a document into chunks, deterministically. */
export interface Chunker {
  readonly strategy: ChunkingStrategy;
  chunk(document: SourceDocument): readonly Chunk[];
}

/** Shared windowing. Subclasses only choose where a boundary may fall. */
abstract class SizeChunker implements Chunker {
  private readonly _size: number;
  private readonly _overlap: number;
  private readonly _keep: readonly string[];

  constructor(init: {
    readonly size: number;
    readonly overlap: number;
    readonly keepMetadata?: readonly string[];
  }) {
    if (init.size <= 0) {
      throw new ConfigurationError('chunking size must be positive');
    }
    if (init.overlap < 0) {
      throw new ConfigurationError('chunking overlap must not be negative');
    }
    if (init.overlap >= init.size) {
      throw new ConfigurationError(
        `chunking overlap ${init.overlap} must be smaller than size ${init.size}; otherwise a ` +
          'window would not advance and chunking would never terminate',
      );
    }
    this._size = init.size;
    this._overlap = init.overlap;
    this._keep = [...(init.keepMetadata ?? [])];
  }

  abstract get strategy(): ChunkingStrategy;

  /** Where to end the window that starts at `start` and may reach `limit`. */
  protected abstract cut(text: string, start: number, limit: number): number;

  chunk(document: SourceDocument): readonly Chunk[] {
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
        chunks.push(this.build(document, chunks.length, start, end, window));
      }
      if (end >= text.length) {
        break;
      }
      start = Math.max(end - this._overlap, start + 1);
    }
    return chunks;
  }

  private build(
    document: SourceDocument,
    index: number,
    start: number,
    end: number,
    text: string,
  ): Chunk {
    const metadata: Record<string, string> = {};
    for (const key of this._keep) {
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

/**
 * Resolve a chunking block to an implementation.
 *
 * `semantic` is refused here as well as in the spec validator, because the runtime
 * is reachable from generated code the validator never saw.
 */
export function chunkerFor(spec: ChunkingSpec): Chunker {
  const options = {
    size: spec.size,
    overlap: spec.overlap,
    keepMetadata: spec.keepMetadata,
  };
  switch (spec.strategy) {
    case 'fixed':
      return new FixedChunker(options);
    case 'recursive':
      return new RecursiveChunker(options);
    case 'code':
      return new CodeChunker(options);
    case 'semantic':
      throw new FeatureDeferredError(
        `chunking strategy ${repr(spec.strategy)} is declared but not implemented: spec ` +
          'v0.1 chunks by size (fixed, recursive, code), and semantic chunking needs an ' +
          'embedding pass over the whole source at ingest',
      );
    /* istanbul ignore next -- unreachable while the union above is exhaustive */
    default:
      throw new FeatureDeferredError(
        `chunking strategy ${repr(String(spec.strategy))} is declared but not implemented`,
      );
  }
}

/** Chunk one document with the strategy the spec names. */
export function chunkDocument(document: SourceDocument, spec: ChunkingSpec): readonly Chunk[] {
  return chunkerFor(spec).chunk(document);
}
