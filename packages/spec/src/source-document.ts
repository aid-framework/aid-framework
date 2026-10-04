import type { Document } from 'yaml';
import { isMap, isSeq, type LineCounter } from 'yaml';
import type { DiagnosticPath, SourcePosition } from './diagnostics.js';

type YamlDocument = Document.Parsed;

/**
 * A parsed spec document together with the machinery to map a logical path back
 * to a line and column.
 *
 * Positions come from the YAML syntax tree, not the value, which has already lost
 * every source location. The walk is best-effort and stops at the deepest segment
 * it can find, so a diagnostic about a missing key points at the closest existing
 * ancestor.
 */
export class SourceDocument {
  readonly file: string | undefined;
  readonly text: string;

  readonly #document: YamlDocument;
  readonly #lineCounter: LineCounter;

  constructor(
    text: string,
    file: string | undefined,
    document: YamlDocument,
    lineCounter: LineCounter,
  ) {
    this.text = text;
    this.file = file;
    this.#document = document;
    this.#lineCounter = lineCounter;
  }

  get yaml(): YamlDocument {
    return this.#document;
  }

  positionAt(path: DiagnosticPath): SourcePosition | undefined {
    let node: unknown = this.#document.contents;
    let position = this.#positionOf(node);

    for (const segment of path) {
      const child = this.#childOf(node, segment);
      if (child === undefined) {
        break;
      }
      node = child.value;
      position = this.#positionOf(child.entry) ?? position;
    }

    return position;
  }

  #positionOf(node: unknown): SourcePosition | undefined {
    if (node === null || typeof node !== 'object') {
      return undefined;
    }
    const range = (node as { range?: unknown }).range;
    if (!Array.isArray(range) || typeof range[0] !== 'number') {
      return undefined;
    }
    const { line, col } = this.#lineCounter.linePos(range[0]);
    return { line, column: col };
  }

  /**
   * Returns the child value plus the node whose position represents it. For
   * mappings that node is the key.
   */
  #childOf(
    node: unknown,
    segment: string | number,
  ): { value: unknown; entry: unknown } | undefined {
    if (isMap(node)) {
      if (typeof segment !== 'string') {
        return undefined;
      }
      for (const pair of node.items) {
        const key = pair.key;
        if (
          key !== null &&
          typeof key === 'object' &&
          'value' in key &&
          String(key.value) === segment
        ) {
          return { value: pair.value, entry: key };
        }
      }
      return undefined;
    }

    if (isSeq(node)) {
      if (typeof segment !== 'number') {
        return undefined;
      }
      const item = node.items[segment];
      return item === undefined ? undefined : { value: item, entry: item };
    }

    return undefined;
  }
}
