/**
 * A test must never assert a *resolved* third-party version or an action tag.
 *
 * Both change without a line of our code changing, so such an assertion fails on a
 * dependency bump and the bump PR closes with the wrong diagnosis. This happened twice:
 * `runtimes/typescript/test/agents-deepagents.test.ts` compared the installed harness to a
 * hand-copied `1.16.0`, and `packages/cli/test/infra-modules.test.ts` compared the emitted
 * `aws-cdk-lib` to `2.275.0`. Both now assert the *contract* (manifest agreement, exact-pin
 * shape) instead of the number.
 *
 * This is the guard that keeps it from coming back. The pin table is derived from the
 * manifests on every run, so the rule moves with a bump instead of going stale, and the
 * detector is itself tested against a synthetic violation so it cannot silently no-op.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * @typedef {{ name: string, version: string }} Pin
 * @typedef {{
 *   kind: 'action' | 'version',
 *   path: string,
 *   line: number,
 *   text: string,
 *   package?: string,
 *   version?: string,
 * }} Violation
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TEST_ROOTS = ['packages', 'runtimes', 'scripts', 'site'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', '.venv']);
const INTERNAL_PREFIXES = ['@aid-framework/'];
const INTERNAL_PACKAGES = new Set(['aid-runtime-python']);
const EXACT_VERSION = /^=?(\d+\.\d+\.\d+)$/;
const TEST_FILE = /\.test\.(ts|mjs)$|^test_.*\.py$/;
/** `owner/repo@v4` or `owner/repo/sub@v12` â€” an action reference pinned to a moving tag. */
const TAGGED_ACTION = /[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@v\d+/;
const ASSERTION = /\bexpect\s*\(|\bassert\b|\.to(Be|Equal|Contain|Match|Throw)\w*\s*\(/;

/**
 * Every file under `root`, depth-first, skipping build output and VCS directories.
 *
 * @param {string} root
 * @param {(name: string) => boolean} accept
 * @param {string[]} [found]
 * @returns {string[]}
 */
function walk(root, accept, found = []) {
  let entries;
  try {
    entries = readdirSync(root);
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const path = join(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path, accept, found);
    else if (accept(entry)) found.push(path);
  }
  return found;
}

/** @param {string} name @returns {boolean} */
const isThirdParty = (name) =>
  !INTERNAL_PREFIXES.some((prefix) => name.startsWith(prefix)) && !INTERNAL_PACKAGES.has(name);

/**
 * @param {string} path
 * @param {Pin[]} pins
 */
function npmPins(path, pins) {
  /** @type {Record<string, Record<string, string>>} */
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  for (const field of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      const exact = EXACT_VERSION.exec(String(range).trim());
      const version = exact?.[1];
      if (version !== undefined && isThirdParty(name)) pins.push({ version, name });
    }
  }
}

/**
 * @param {string} path
 * @param {Pin[]} pins
 */
function pythonPins(path, pins) {
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^\s*"([A-Za-z0-9_.-]+)(\[[^\]]*\])?\s*=\s*"([^"]+)"/.exec(line);
    if (match === null) continue;
    const exact = EXACT_VERSION.exec(String(match[3]).trim());
    const version = exact?.[1];
    if (version !== undefined && isThirdParty(String(match[1]))) {
      pins.push({ version, name: String(match[1]) });
    }
  }
}

/**
 * Exact-pinned third-party dependencies, read from the manifests that declare them.
 *
 * @param {string} [root]
 * @returns {Pin[]}
 */
function declaredPins(root = ROOT) {
  /** @type {Pin[]} */
  const pins = [];
  const files = walk(root, (name) => name === 'package.json' || name === 'pyproject.toml');
  for (const path of files) {
    if (path.endsWith('package.json')) npmPins(path, pins);
    else pythonPins(path, pins);
  }
  return pins;
}

/**
 * Strip comments so a comment recording a past failure is not itself a failure. Block
 * comments are blanked first, keeping their newlines so line numbers still point at the
 * original file.
 *
 * @param {string} source
 * @param {boolean} python
 * @returns {string}
 */
const stripComments = (source, python) =>
  python
    ? source
        .split('\n')
        .map((line) => line.replace(/#.*$/, ''))
        .join('\n')
    : source
        .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ''))
        .split('\n')
        .map((line) => line.replace(/\/\/.*$/, ''))
        .join('\n');

/** @param {string} text @param {string} name @returns {boolean} */
const mentionsPackage = (text, name) =>
  new RegExp(
    `(?<![A-Za-z0-9_./@-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_./-])`,
  ).test(text);

/**
 * Violations in one test file's source.
 *
 * - `action`: an action reference pinned to a tag, never acceptable.
 * - `version`: an assertion carrying the exact version a third-party dependency is
 *   pinned to in a manifest. The name is matched across the whole file because the
 *   literal and the package it checks are often on different lines.
 *
 * @param {string} source
 * @param {Pin[]} pins
 * @param {string} [path]
 * @returns {Violation[]}
 */
function violationsIn(source, pins, path = '<memory>') {
  const python = path.endsWith('.py');
  const code = stripComments(source, python).split('\n');
  const named = pins.filter((pin) => mentionsPackage(code.join('\n'), pin.name));
  /** @type {Violation[]} */
  const found = [];

  code.forEach((line, index) => {
    if (TAGGED_ACTION.test(line)) {
      found.push({ kind: 'action', path, line: index + 1, text: line.trim() });
    }
    if (!ASSERTION.test(line)) return;
    for (const pin of named) {
      if (line.includes(pin.version)) {
        found.push({
          kind: 'version',
          path,
          line: index + 1,
          text: line.trim(),
          package: pin.name,
          version: pin.version,
        });
      }
    }
  });

  return found;
}

/** @param {Violation} violation @returns {string} */
const format = (violation) =>
  `${violation.path}:${violation.line} asserts ${violation.kind === 'action' ? 'a tagged action' : `${violation.package}@${violation.version}`}: ${violation.text}`;

/** This file states the rule, so it necessarily names the patterns the rule forbids. */
const GUARD = fileURLToPath(import.meta.url);

describe('tests do not pin resolved dependency or action versions', () => {
  const pins = declaredPins();
  const files = TEST_ROOTS.flatMap((dir) =>
    walk(join(ROOT, dir), (name) => TEST_FILE.test(name)),
  ).filter((path) => path !== GUARD);

  it('finds the manifests to read pins from', () => {
    // If this table ever empties, the rules below stop proving anything.
    expect(pins.length).toBeGreaterThan(0);
    expect(new Set(pins.map((pin) => pin.name)).size).toBeGreaterThan(0);
  });

  it('scans the test trees', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('has no test asserting an exact third-party version or a tagged action', () => {
    const violations = files.flatMap((path) =>
      violationsIn(readFileSync(path, 'utf8'), pins, relative(ROOT, path)),
    );
    expect(violations.map(format)).toEqual([]);
  });

  it('detects both kinds of violation in a synthetic file', () => {
    // Without this, a broken detector would look exactly like a clean repository.
    const pinsFor = [{ version: '9.9.9', name: 'example-package' }];
    const source = [
      "import example from 'example-package';",
      "it('checks the bump', () => {",
      "  expect(installedVersion()).toBe('9.9.9');",
      "  expect(workflow).toContain('actions/checkout@v4');",
      '});',
    ].join('\n');
    const kinds = violationsIn(source, pinsFor, 'synthetic.test.ts').map((v) => v.kind);
    expect(kinds).toEqual(['version', 'action']);
  });

  it('ignores a comment that records a past bump failure', () => {
    const pinsFor = [{ version: '9.9.9', name: 'example-package' }];
    const source = [
      '// a bump once failed with `expected 9.9.9 to be 9.9.8`',
      "// expect(example).toBe('9.9.9')",
      'expect(true).toBe(true);',
    ].join('\n');
    expect(violationsIn(source, pinsFor, 'comment.test.ts')).toEqual([]);
  });
});
