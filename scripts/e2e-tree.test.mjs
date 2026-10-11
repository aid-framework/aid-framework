/**
 * Tests for the end-to-end job's comparison primitive.
 *
 * The job's whole claim is "generated equals committed", so this is where the comparison
 * has to be shown to be able to fail: identical trees pass, and each way two trees can
 * differ (a changed byte, a missing file, a stray file) is reported. A comparison that
 * quietly passes on a difference would turn the job into theatre, which is worse than
 * having no job at all.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { compareTrees, formatTreeDiff, isIdentical, snapshotTree } from './e2e-tree.mjs';

/** @type {string[]} */
const temporaryRoots = [];

/** @returns {string} A fresh directory that is removed after the test. */
function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'aid-e2e-tree-'));
  temporaryRoots.push(root);
  return root;
}

/**
 * Write a file, creating any missing parents.
 *
 * @param {string} root
 * @param {string} path
 * @param {string | Buffer} content
 */
function write(root, path, content) {
  const target = join(root, ...path.split('/'));
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, content);
}

afterEach(() => {
  while (temporaryRoots.length > 0)
    rmSync(/** @type {string} */ (temporaryRoots.pop()), {
      force: true,
      recursive: true,
    });
});

describe('snapshotTree and compareTrees', () => {
  it('treats two identical trees as identical', () => {
    const expected = scratch();
    const actual = scratch();
    write(expected, 'app/generated/deps.py', 'x = 1\n');
    write(actual, 'app/generated/deps.py', 'x = 1\n');

    const diff = compareTrees(snapshotTree(expected), snapshotTree(actual));

    expect(diff).toEqual({ missing: [], changed: [], unexpected: [] });
    expect(isIdentical(diff)).toBe(true);
  });

  it('reports a single changed byte', () => {
    const expected = scratch();
    const actual = scratch();
    write(expected, 'app/generated/deps.py', 'x = 1\n');
    write(actual, 'app/generated/deps.py', 'x = 2\n');

    const diff = compareTrees(snapshotTree(expected), snapshotTree(actual));

    expect(diff.changed).toEqual(['app/generated/deps.py']);
    expect(isIdentical(diff)).toBe(false);
  });

  it('compares bytes, so a line-ending change is a difference', () => {
    const expected = scratch();
    const actual = scratch();
    write(expected, 'app/generated/deps.py', 'x = 1\n');
    write(actual, 'app/generated/deps.py', 'x = 1\r\n');

    expect(compareTrees(snapshotTree(expected), snapshotTree(actual)).changed).toEqual([
      'app/generated/deps.py',
    ]);
  });

  it('reports a file the expected tree has and the actual one does not', () => {
    const expected = scratch();
    const actual = scratch();
    write(expected, 'app/generated/routes/answer_ticket.py', '');
    write(expected, 'app/generated/deps.py', 'x = 1\n');
    write(actual, 'app/generated/deps.py', 'x = 1\n');

    const diff = compareTrees(snapshotTree(expected), snapshotTree(actual));

    expect(diff.missing).toEqual(['app/generated/routes/answer_ticket.py']);
    expect(diff.unexpected).toEqual([]);
    expect(isIdentical(diff)).toBe(false);
  });

  it('reports a file only the actual tree has', () => {
    const expected = scratch();
    const actual = scratch();
    write(expected, 'app/generated/deps.py', 'x = 1\n');
    write(actual, 'app/generated/deps.py', 'x = 1\n');
    write(actual, 'app/generated/deps.py.aid-rej', 'rejected\n');

    const diff = compareTrees(snapshotTree(expected), snapshotTree(actual));

    expect(diff.unexpected).toEqual(['app/generated/deps.py.aid-rej']);
    expect(isIdentical(diff)).toBe(false);
  });

  it('keys paths with forward slashes, so failures read the same on every platform', () => {
    const expected = scratch();
    write(expected, 'app/generated/routes/answer_ticket.py', 'a\n');

    expect([...snapshotTree(expected).files.keys()]).toEqual([
      'app/generated/routes/answer_ticket.py',
    ]);
  });

  it('ignores build output and tool caches', () => {
    const expected = scratch();
    const actual = scratch();
    for (const ignored of ['__pycache__', '.pytest_cache', '.venv', 'node_modules', 'dist']) {
      write(expected, `app/generated/${ignored}/stale.py`, 'old\n');
      write(actual, `app/generated/${ignored}/stale.py`, 'new\n');
    }
    write(expected, 'app/generated/deps.py', 'x = 1\n');
    write(actual, 'app/generated/deps.py', 'x = 1\n');

    expect(isIdentical(compareTrees(snapshotTree(expected), snapshotTree(actual)))).toBe(true);
  });

  it('treats a missing root as an empty tree', () => {
    const expected = scratch();
    write(expected, 'app/generated/deps.py', 'x = 1\n');

    const diff = compareTrees(snapshotTree(expected), snapshotTree(join(expected, 'nowhere')));

    expect(diff.missing).toEqual(['app/generated/deps.py']);
  });
});

describe('formatTreeDiff', () => {
  it('names every section that has content and omits the ones that do not', () => {
    const diff = {
      missing: ['a.py'],
      changed: ['b.py'],
      unexpected: ['c.py'],
    };

    const text = formatTreeDiff(diff, { expected: 'the committed example', actual: 'the copy' });

    expect(text).toContain('only in the committed example (1):');
    expect(text).toContain('differs from the committed example (1):');
    expect(text).toContain('only in the copy (1):');
    expect(text).toContain('    a.py');
  });

  it('says nothing when the trees agree', () => {
    const text = formatTreeDiff(
      { missing: [], changed: [], unexpected: [] },
      { expected: 'expected', actual: 'actual' },
    );

    expect(text).toBe('');
  });

  it('bounds the paths it lists so one bad run cannot bury the log', () => {
    const unexpected = Array.from({ length: 25 }, (_, index) => `file-${index}.py`);

    const text = formatTreeDiff(
      { missing: [], changed: [], unexpected },
      { expected: 'expected', actual: 'actual' },
    );

    expect(text).toContain('(25):');
    expect(text).toContain('... and 5 more');
    expect(text).not.toContain('file-24.py');
  });
});
