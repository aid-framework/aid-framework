/**
 * Tests for the publish detector, which decides whether the dormant publish workflow
 * publishes anything at all.
 *
 * Two properties matter. The first is that today it finds nothing, run against the real
 * repository rather than a fixture, so that a real manifest drifting into publishability
 * is what breaks this test. The second is that it is not a stub that always finds nothing:
 * the fixture cases show each rule failing to exclude, and the real repository is probed
 * with a version that *should* match, so a detector that never fires cannot pass.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  detect,
  formatDetection,
  parseProjectTable,
  releasedVersionFromGit,
  stripTagPrefix,
} from './detect-publishable.mjs';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

/** @type {string[]} */
const temporaryRoots = [];

/** @returns {string} A fresh directory that is removed after the test. */
function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'aid-publish-'));
  temporaryRoots.push(root);
  return root;
}

/**
 * @param {string} root
 * @param {string} path
 * @param {string} content
 */
function write(root, path, content) {
  const target = join(root, ...path.split('/'));
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, content);
}

/**
 * The publishable paths in a detection, as repository-style paths.
 *
 * @param {ReturnType<typeof detect>} detection
 * @returns {string[]}
 */
function publishablePaths(detection) {
  return detection.publishable.map((candidate) => candidate.path);
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(/** @type {string} */ (temporaryRoots.pop()), { force: true, recursive: true });
  }
});

describe('detect against this repository', () => {
  it('finds nothing publishable for a version no manifest declares', () => {
    const detection = detect({ root: repoRoot, version: '0.1.5' });

    expect(publishablePaths(detection)).toEqual([]);
    // Not vacuous: it saw the manifests and rejected them for a rule each.
    expect(detection.candidates.length).toBeGreaterThan(5);
    expect(detection.candidates.some((candidate) => candidate.status === 'private')).toBe(true);
    expect(detection.candidates.some((candidate) => candidate.status === 'placeholder')).toBe(true);
    expect(detection.candidates.some((candidate) => candidate.status === 'outside-workspace')).toBe(
      true,
    );
  });

  it('finds the runtime when the released version is the one it declares', () => {
    const { version } = parseProjectTable(
      readFileSync(join(repoRoot, 'runtimes', 'python', 'pyproject.toml'), 'utf8'),
    );

    const detection = detect({ root: repoRoot, version });
    const shipped = detection.publishable;

    // Exactly one artifact, and it is the runtime. This is the assertion that would fail if
    // the detector were a stub that never finds anything -- and, in reverse, the one that
    // fires the day a real release lines a manifest up with a tag.
    expect(shipped.map((candidate) => candidate.path)).toEqual(['runtimes/python/pyproject.toml']);
    const [runtime] = shipped;
    expect(runtime?.registry).toBe('pypi');
    expect(runtime?.name).toBe('aid-runtime-python');
    // The example declares the same version and must still not ship. There are two of them
    // now, and they are refused for two different reasons -- the Python example is outside
    // the workspace, the TypeScript one is a workspace member marked `private` -- so this
    // asserts the set rather than whichever example the scan happened to reach first.
    const exampleCandidates = detection.candidates.filter((candidate) =>
      candidate.path.startsWith('examples/'),
    );
    expect(exampleCandidates.map((candidate) => candidate.path).sort()).toEqual([
      'examples/support-copilot-ts/package.json',
      'examples/support-copilot/pyproject.toml',
    ]);
    expect(exampleCandidates.filter((candidate) => candidate.status === 'publishable')).toEqual([]);
    expect(
      exampleCandidates.find(
        (candidate) => candidate.path === 'examples/support-copilot/pyproject.toml',
      )?.status,
    ).toBe('outside-workspace');
  });

  it('never publishes the 0.0.0 workspace placeholder, even when it matches', () => {
    const detection = detect({ root: repoRoot, version: '0.0.0' });

    expect(publishablePaths(detection)).toEqual([]);
  });

  it('finds nothing when no release has been tagged', () => {
    const detection = detect({ root: repoRoot, version: null });

    expect(detection.version).toBeNull();
    expect(publishablePaths(detection)).toEqual([]);
  });

  it('reads the released version from the tag, without the tag prefix', () => {
    const version = releasedVersionFromGit(repoRoot);

    // A shallow checkout has no tags; that is a "nothing has been released" answer rather
    // than a wrong one, and the publish workflow passes the tag explicitly anyway.
    if (version !== null) expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('reads the version out of a directory that has no release config', () => {
    expect(releasedVersionFromGit(scratch())).toBeNull();
  });
});

describe('stripTagPrefix', () => {
  it('turns a release tag into the version a manifest declares', () => {
    expect(stripTagPrefix('v0.1.5', 'v')).toBe('0.1.5');
  });

  it('leaves a version alone when there is no prefix to strip', () => {
    expect(stripTagPrefix('0.1.5', '')).toBe('0.1.5');
    expect(stripTagPrefix('v0.1.5', '')).toBe('v0.1.5');
  });

  it('does not strip a prefix that is not there', () => {
    expect(stripTagPrefix('release-0.1.5', 'v')).toBe('release-0.1.5');
  });
});

describe('detect over a fixture workspace', () => {
  it('publishes a manifest that matches the release', () => {
    const root = scratch();
    write(
      root,
      'packages/thing/package.json',
      JSON.stringify({ name: '@aid/thing', version: '2.0.0' }),
    );

    const detection = detect({ root, version: '2.0.0' });

    expect(publishablePaths(detection)).toEqual(['packages/thing/package.json']);
    expect(detection.publishable[0]).toMatchObject({
      registry: 'npm',
      name: '@aid/thing',
      version: '2.0.0',
      status: 'publishable',
    });
  });

  it('skips private manifests', () => {
    const root = scratch();
    write(
      root,
      'package.json',
      JSON.stringify({ name: 'aid-framework', version: '2.0.0', private: true }),
    );

    const detection = detect({ root, version: '2.0.0' });

    expect(publishablePaths(detection)).toEqual([]);
    const [candidate] = detection.candidates;
    expect(candidate?.status).toBe('private');
  });

  it('skips a manifest whose version is not the release', () => {
    const root = scratch();
    write(root, 'packages/thing/package.json', JSON.stringify({ name: 'thing', version: '1.9.9' }));

    expect(publishablePaths(detect({ root, version: '2.0.0' }))).toEqual([]);
    const [candidate] = detect({ root, version: '2.0.0' }).candidates;
    expect(candidate?.status).toBe('unreleased-version');
  });

  it('skips a manifest that declares no usable version', () => {
    const root = scratch();
    write(root, 'packages/thing/package.json', JSON.stringify({ name: 'thing' }));
    write(root, 'pyproject.toml', '[project]\nname = "dynamic-thing"\ndynamic = ["version"]\n');

    const detection = detect({ root, version: '2.0.0' });

    expect(publishablePaths(detection)).toEqual([]);
    expect(detection.candidates.map((candidate) => candidate.status)).toEqual([
      'unreleased-version',
      'dynamic-version',
    ]);
  });

  it('ignores build output and dependency trees', () => {
    const root = scratch();
    write(
      root,
      'node_modules/thing/package.json',
      JSON.stringify({ name: 'vendored', version: '2.0.0' }),
    );
    write(root, 'dist/package.json', JSON.stringify({ name: 'built', version: '2.0.0' }));

    expect(publishablePaths(detect({ root, version: '2.0.0' }))).toEqual([]);
    expect(detect({ root, version: '2.0.0' }).candidates).toEqual([]);
  });

  it('fails loudly on a manifest that is not a JSON object', () => {
    const root = scratch();
    write(root, 'packages/thing/package.json', '["not", "an", "object"]\n');

    expect(() => detect({ root, version: '2.0.0' })).toThrow(/packages\/thing\/package\.json/);
  });
});

describe('parseProjectTable', () => {
  it('reads name and version from the project table', () => {
    expect(parseProjectTable('[project]\nname = "pkg"\nversion = "1.2.3"\n')).toEqual({
      name: 'pkg',
      version: '1.2.3',
    });
  });

  it('stops at the next table', () => {
    const text = '[project]\nname = "pkg"\n\n[tool.thing]\nversion = "9.9.9"\n';

    expect(parseProjectTable(text)).toEqual({ name: 'pkg', version: null });
  });

  it('ignores keys that are not in the project table', () => {
    expect(parseProjectTable('[tool.uv]\nname = "pkg"\nversion = "1.2.3"\n')).toEqual({
      name: null,
      version: null,
    });
  });

  it('ignores comments and blank lines', () => {
    const text = '# a comment\n[project]\n# another\nname = "pkg"\nversion = "1.2.3"\n';

    expect(parseProjectTable(text)).toEqual({ name: 'pkg', version: '1.2.3' });
  });
});

describe('formatDetection', () => {
  it('names the version, the count, and the reason for every candidate', () => {
    const root = scratch();
    write(root, 'packages/thing/package.json', JSON.stringify({ name: 'thing', version: '2.0.0' }));

    const text = formatDetection(detect({ root, version: '2.0.0' }));

    expect(text).toContain('release version: 2.0.0');
    expect(text).toContain('publishable: 1');
    expect(text).toMatch(/publishable\s+npm\s+thing@2\.0\.0\s+packages\/thing\/package\.json/);
  });

  it('says so when nothing has been released', () => {
    const text = formatDetection(detect({ root: scratch(), version: null }));

    expect(text).toContain('(unknown -- nothing has been released)');
    expect(text).toContain('publishable: 0');
  });
});
