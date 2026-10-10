/**
 * The filesystem-backed {@link RegenerationSink}. Kept out of `drift.ts` so the
 * algorithm itself has no dependency on `node:fs` and can be driven from an
 * in-memory map in tests.
 *
 * Writes are atomic (temp file in the destination directory, then rename over the
 * target) because a partially written generated file is worse than a stale one: it
 * fails to parse, so nothing downstream can tell "regeneration was interrupted" from
 * "the generator emitted garbage".
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

import type { RegenerationSink } from './drift.js';

const TEMP_SUFFIX = '.aid-tmp';

export function createNodeSink(root: string): RegenerationSink {
  const base = resolve(root);

  function absoluteFor(path: string): string {
    const absolute = resolve(base, ...path.split('/'));
    if (absolute !== base && !absolute.startsWith(base + sep)) {
      throw new Error(`Path "${path}" escapes the sink root "${base}".`);
    }
    return absolute;
  }

  return {
    read(path) {
      try {
        return readFileSync(absoluteFor(path), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    },
    write(path, content) {
      const absolute = absoluteFor(path);
      mkdirSync(dirname(absolute), { recursive: true });
      const temporary = `${absolute}${TEMP_SUFFIX}`;
      writeFileSync(temporary, content, 'utf8');
      renameSync(temporary, absolute);
    },
    remove(path) {
      rmSync(absoluteFor(path), { force: true });
    },
  };
}

/** An in-memory sink, for tests and for dry runs against a plan. */
export function createMemorySink(initial: Record<string, string> = {}): RegenerationSink & {
  files: Map<string, string>;
} {
  const files = new Map(Object.entries(initial));
  return {
    files,
    read(path) {
      return files.get(path);
    },
    write(path, content) {
      files.set(path, content);
    },
    remove(path) {
      files.delete(path);
    },
  };
}
