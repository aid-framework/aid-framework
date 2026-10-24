/**
 * Reading a `file` source.
 *
 * The IR names five source kinds and Phase 1 implements one. That is the spec
 * validator's own position ("spec v0.1 indexes a local `file` source; the remote
 * loaders belong to the phase that ships them"), so the other four raise
 * {@link FeatureDeferredError} here rather than indexing an empty corpus and
 * looking healthy.
 *
 * **Document identity is the POSIX path relative to the source root.** That is
 * the vocabulary the IR's retrieval metric already uses -- its `expectDocs` hold
 * `getting-started.md`, not `./docs/getting-started.md` -- and it is
 * machine-independent, so the same corpus indexed on Windows and on Linux yields
 * the same ids and the same eval outcome. Absolute paths would make a baseline
 * non-portable.
 *
 * The protocol is `async` even though the only implementation reads local files
 * synchronously, because the kinds that follow (`s3`, `http`, `db`, `mcp`) are
 * genuinely concurrent. Making it sync now would be a breaking change to the seam
 * exactly when the first real loader arrives.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';

import { ConfigurationError, FeatureDeferredError } from '../errors.js';
import { repr } from '../internal/json.js';
import type { SourceKind, SourceSpec } from './types.js';

/**
 * Compile a `*`/`**`/`?` glob into a matcher over POSIX relative paths.
 *
 * This used to build a regex, which is the compact spelling and the unsafe one: a glob
 * is configuration input, and a double-star-plus-slash group compiles to a nested
 * quantifier -- a star class inside a repeated group -- so a pattern with a dozen such
 * groups costs a pathologically large number of steps to *fail* against a deep path.
 * A glob repeating that group and pointing at a file the tree does not contain is an
 * outage, not a typo.
 *
 * So this walks pattern tokens against positions instead: one pass per token over the
 * path, no backtracking, `O(tokens * length)` in the worst case regardless of shape.
 * The supported syntax is unchanged and still spelled out rather than approximated --
 * anything beyond `*`, `**` and `?` matches literally.
 */
type GlobToken =
  | { readonly kind: 'literal'; readonly char: string }
  | { readonly kind: 'any-one' }
  | { readonly kind: 'star' }
  | { readonly kind: 'globstar' }
  | { readonly kind: 'globstar-segment' };

function tokenizeGlob(pattern: string): readonly GlobToken[] {
  const tokens: GlobToken[] = [];
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] as string;
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index += 1;
        if (pattern[index + 1] === '/') {
          index += 1;
          tokens.push({ kind: 'globstar-segment' });
        } else {
          tokens.push({ kind: 'globstar' });
        }
      } else {
        tokens.push({ kind: 'star' });
      }
    } else if (char === '?') {
      tokens.push({ kind: 'any-one' });
    } else {
      tokens.push({ kind: 'literal', char });
    }
  }
  return tokens;
}

function compileGlob(pattern: string): (path: string) => boolean {
  const tokens = tokenizeGlob(pattern);
  return (path: string): boolean => {
    let reachable: boolean[] = new Array<boolean>(path.length + 1).fill(false);
    reachable[0] = true;
    for (const token of tokens) {
      const next = new Array<boolean>(path.length + 1).fill(false);
      switch (token.kind) {
        case 'literal':
          for (let end = 1; end <= path.length; end += 1) {
            next[end] = reachable[end - 1] === true && path[end - 1] === token.char;
          }
          break;
        case 'any-one':
          for (let end = 1; end <= path.length; end += 1) {
            next[end] = reachable[end - 1] === true && path[end - 1] !== '/';
          }
          break;
        case 'star':
          // Zero or more non-slash characters: stay put, or extend a run that has
          // already stayed inside one segment.
          for (let end = 0; end <= path.length; end += 1) {
            const extendsRun = end > 0 && next[end - 1] === true && path[end - 1] !== '/';
            next[end] = reachable[end] === true || extendsRun;
          }
          break;
        case 'globstar':
          // Zero or more of any character, slashes included.
          for (let end = 0; end <= path.length; end += 1) {
            const extendsRun = end > 0 && next[end - 1] === true;
            next[end] = reachable[end] === true || extendsRun;
          }
          break;
        case 'globstar-segment':
          // `(?:[^/]*/)*`: zero or more whole segments, so it lands on any boundary
          // that follows a slash, including the one it started on.
          {
            let anyBefore = false;
            for (let end = 0; end <= path.length; end += 1) {
              const lands = anyBefore && end > 0 && path[end - 1] === '/';
              next[end] = reachable[end] === true || lands;
              if (reachable[end] === true) anyBefore = true;
            }
          }
          break;
      }
      reachable = next;
    }
    return reachable[path.length] === true;
  };
}

/** One document read from a source, before chunking. */
export class SourceDocument {
  /** POSIX path relative to the source root; the document's identity everywhere. */
  readonly docId: string;
  /** The absolute resolved location, for a human reading a citation. Never matched on. */
  readonly uri: string;
  readonly text: string;
  readonly metadata: Readonly<Record<string, string>>;

  constructor(init: {
    readonly docId: string;
    readonly uri: string;
    readonly text: string;
    readonly metadata?: Readonly<Record<string, string>>;
  }) {
    if (init.docId.length === 0) {
      throw new ConfigurationError('docId must not be empty');
    }
    if (init.uri.length === 0) {
      throw new ConfigurationError('uri must not be empty');
    }
    this.docId = init.docId;
    this.uri = init.uri;
    this.text = init.text;
    this.metadata = { ...(init.metadata ?? {}) };
  }
}

/** A source that yields documents in a deterministic order. */
export interface Connector {
  readonly kind: SourceKind;
  documents(): Promise<readonly SourceDocument[]>;
  close(): Promise<void>;
}

/**
 * Reads `*.md`-style files under a local directory.
 *
 * Files are read and returned in sorted `docId` order, never in directory order:
 * directory order is a filesystem accident, and a corpus whose chunk ids depend on
 * it would reindex itself differently on a different machine.
 */
export class FileConnector implements Connector {
  private readonly _root: string;
  private readonly _glob: string | null;

  constructor(root: string, options: { readonly glob?: string | null } = {}) {
    this._root = root;
    if (!existsSync(this._root)) {
      throw new ConfigurationError(`source path ${repr(this._root)} does not exist`);
    }
    if (!statSync(this._root).isDirectory()) {
      throw new ConfigurationError(`source path ${repr(this._root)} is not a directory`);
    }
    this._glob = options.glob ?? null;
  }

  get kind(): SourceKind {
    return 'file';
  }

  async documents(): Promise<readonly SourceDocument[]> {
    return this.paths().map((path) => this.read(path));
  }

  async close(): Promise<void> {
    return Promise.resolve();
  }

  private paths(): readonly string[] {
    const pattern = this._glob ?? '**/*';
    const matcher = compileGlob(pattern);
    const found: string[] = [];
    const walk = (absolute: string): void => {
      for (const entry of readdirSync(absolute, { withFileTypes: true })) {
        const child = `${absolute}${sep}${entry.name}`;
        if (entry.isDirectory()) {
          walk(child);
          continue;
        }
        if (!entry.isFile()) continue;
        if (entry.name.startsWith('.')) continue;
        if (!matcher(this.docId(child))) continue;
        found.push(child);
      }
    };
    walk(this._root);
    return found.sort((left, right) => {
      const a = this.docId(left);
      const b = this.docId(right);
      if (a < b) return -1;
      return a > b ? 1 : 0;
    });
  }

  private docId(path: string): string {
    return relative(this._root, path).split(sep).join('/');
  }

  private read(path: string): SourceDocument {
    const docId = this.docId(path);
    const suffix = docId.includes('.') ? `.${docId.split('.').pop() as string}` : '';
    return new SourceDocument({
      docId,
      uri: path,
      text: readFileSync(path, 'utf8'),
      metadata: { path: docId, suffix },
    });
  }
}

/**
 * Open the connector for a source entry.
 *
 * `baseDir` resolves a relative source `uri`; it is explicit because the runtime
 * has no opinion about a working directory, and a corpus must not depend on where a
 * process happened to be started.
 */
export function openConnector(
  spec: SourceSpec,
  options: { readonly baseDir?: string | null } = {},
): Connector {
  if (spec.kind !== 'file') {
    throw new FeatureDeferredError(
      `source kind ${repr(spec.kind)} is declared but not implemented: spec v0.1 ` +
        "indexes a local 'file' source, and the remote loaders (s3, http, db, mcp) " +
        'belong to the phase that ships them',
    );
  }
  let root = spec.uri;
  if (!isAbsolute(root) && options.baseDir !== undefined && options.baseDir !== null) {
    root = `${options.baseDir}${sep}${root}`;
  }
  return new FileConnector(root, { glob: spec.glob });
}
