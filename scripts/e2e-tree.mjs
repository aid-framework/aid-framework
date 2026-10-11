/**
 * Byte-for-byte directory comparison for the end-to-end job.
 *
 * The end-to-end check claims that what this repository *generates* is exactly what it
 * *commits*, so the comparison is the assertion, and an assertion that cannot fail is not
 * one. It lives here rather than inside `scripts/e2e-example.mjs` because the driver spawns
 * the CLI, uvicorn and pip -- nothing a unit test can hold still -- while the comparison is
 * a pure function of two directories.
 *
 * Comparison is on bytes, not on hashes or line endings: the contract in `docs/design.md`
 * is "regenerating is byte-identical", and a hash comparison over normalised text would
 * pass on a tree that differs in the ways that actually bite (CRLF, trailing whitespace, a
 * missing final newline).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Directory names that are build output, tool caches or VCS state. They are compared on
 * nothing because they are not committed, and their contents differ legitimately between a
 * fresh checkout and a tree that has just been imported and run.
 */
const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.venv',
  '__pycache__',
  'build',
  'coverage',
  'dist',
  'node_modules',
]);

/**
 * @typedef {object} TreeSnapshot
 * @property {Map<string, Buffer>} files Path (`/`-separated, relative) to exact bytes.
 */

/**
 * @typedef {object} TreeDiff
 * @property {string[]} missing Paths the expected tree has and the actual tree does not.
 * @property {string[]} changed Paths present in both but not byte-identical.
 * @property {string[]} unexpected Paths the actual tree has and the expected tree does not.
 */

/**
 * Read every file under `root` into memory, keyed by its `/`-separated relative path.
 *
 * Files are read whole rather than hashed so that a mismatch can be reported and, when it
 * matters, shown. The trees this compares are a few dozen small source files.
 *
 * @param {string} root
 * @returns {TreeSnapshot}
 */
export function snapshotTree(root) {
  /** @type {Map<string, Buffer>} */
  const files = new Map();

  /** @param {string} directory */
  const walk = (directory) => {
    /** @type {import('node:fs').Dirent[]} */
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      const code = /** @type {NodeJS.ErrnoException} */ (error).code;
      if (code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue;
        walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      // Windows paths never reach the diff, which keeps failures copy-pasteable into a
      // shell on every platform the repository runs on.
      files.set(relative(root, absolute).split(sep).join('/'), readFileSync(absolute));
    }
  };

  walk(root);
  return { files };
}

/**
 * Compare two snapshots.
 *
 * @param {TreeSnapshot} expected
 * @param {TreeSnapshot} actual
 * @returns {TreeDiff}
 */
export function compareTrees(expected, actual) {
  /** @type {string[]} */
  const missing = [];
  /** @type {string[]} */
  const changed = [];
  /** @type {string[]} */
  const unexpected = [];

  for (const [path, bytes] of expected.files) {
    const other = actual.files.get(path);
    if (other === undefined) {
      missing.push(path);
      continue;
    }
    if (!bytes.equals(other)) changed.push(path);
  }
  for (const path of actual.files.keys()) {
    if (!expected.files.has(path)) unexpected.push(path);
  }

  return { missing: missing.sort(), changed: changed.sort(), unexpected: unexpected.sort() };
}

/**
 * @param {TreeDiff} diff
 * @returns {boolean}
 */
export function isIdentical(diff) {
  return diff.missing.length === 0 && diff.changed.length === 0 && diff.unexpected.length === 0;
}

/**
 * Render a diff for a log, bounded so that one pathological run cannot bury the job output.
 *
 * @param {TreeDiff} diff
 * @param {{expected: string, actual: string}} labels
 * @returns {string}
 */
export function formatTreeDiff(diff, labels) {
  /** @type {string[]} */
  const lines = [];
  /** @param {string} title @param {string[]} paths */
  const section = (title, paths) => {
    if (paths.length === 0) return;
    lines.push(`  ${title} (${paths.length}):`);
    for (const path of paths.slice(0, 20)) lines.push(`    ${path}`);
    if (paths.length > 20) lines.push(`    ... and ${paths.length - 20} more`);
  };

  section(`only in ${labels.expected}`, diff.missing);
  section(`differs from ${labels.expected}`, diff.changed);
  section(`only in ${labels.actual}`, diff.unexpected);
  return lines.join('\n');
}
