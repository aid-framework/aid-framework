/**
 * Detects artifacts that a release is *allowed and able* to publish, and reports why
 * everything else is not.
 *
 * Publishing is opt-in at two gates: `.github/workflows/publish.yml` runs only from
 * `release.yml` (`workflow_call`) or by hand (`workflow_dispatch`), and its `publish` job
 * additionally requires this script's verdict plus `vars.AID_PUBLISH_ENABLED == 'true'`.
 * This script is the first half of that gate, so what it means by "publishable" matters
 * more than what it prints.
 *
 * A manifest is publishable when all four hold:
 *
 *   1. It declares a name and a version: an npm `package.json` with string `name` and
 *      `version` that is not `private: true`, or a `pyproject.toml` with a `[project]`
 *      table naming it.
 *   2. Its version is not `0.0.0`, the internal placeholder every workspace package
 *      carries. A package that says `0.0.0` is not claiming a release.
 *   3. Its version *is* the version being released. `release.yml` tags the commit and
 *      never rewrites a manifest, so for this repository the tag is the source of truth:
 *      only a manifest that already says `0.1.5` can be published as `0.1.5`. Publishing
 *      a manifest under a version it does not declare is how a registry ends up with a
 *      tag that lies.
 *   4. It is not the example app. `examples/support-copilot/pyproject.toml` exists so the
 *      documented quickstart can `pip install -e` the example; nobody publishes it.
 *
 * A non-empty set is the steady state, not an accident. `scripts/version.mjs stamp` writes
 * the next release version into every manifest `release.config.json` lists, so claim 3 is
 * satisfiable rather than permanently false: a release commit carries manifests that already
 * declare the version `release.yml` is about to tag, and all eight artifacts ship. When the
 * two *do* drift -- someone tags `v0.1.40` without re-stamping -- claim 3 degrades to
 * `unreleased-version`, which is a skip, not a wrong publish.
 *
 * What has not changed is that this script neither publishes nor authenticates.
 * `publish.yml` runs it first and only a non-empty result reaches the publish job, which
 * uses OIDC trusted publishing (`id-token: write`) instead of a registry token. A predicate
 * this strict is deliberate: a detector that cannot fail loud is worse than no publishing at
 * all, so dropping an artifact from the release is a change someone makes here on purpose.
 *
 * One thing is still *not* expressed here, and is worth knowing: publish *order* (npm needs
 * its `workspace:*` dependencies present on the registry before a dependent can install).
 * That lives in `publish.yml` as an explicit topological list, because this script answers
 * "which artifacts", not "in what order".
 *
 * Usage: `node scripts/detect-publishable.mjs [--root .] [--version v0.1.5] [--json]
 * [--github-output "$GITHUB_OUTPUT"]`
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** Directories that hold no publishable manifest, only build output or tool state. */
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

/** The version every workspace package carries until a release gives it a real one. */
const PLACEHOLDER_VERSION = '0.0.0';

/** Trees that exist for the docs and the tests, not for consumers. */
const NON_DISTRIBUTABLE_PREFIXES = ['examples/'];

/**
 * Why a candidate is not publishable. `publishable` is the only status that ships.
 *
 * @typedef {'publishable' | 'private' | 'placeholder' | 'unreleased-version' | 'outside-workspace' | 'dynamic-version'} CandidateStatus
 */

/**
 * @typedef {object} Candidate
 * @property {'npm' | 'pypi'} registry
 * @property {string} path Repository-relative, `/`-separated.
 * @property {string | null} name
 * @property {string | null} version
 * @property {CandidateStatus} status
 */

/**
 * @typedef {object} Detection
 * @property {string | null} version The version being released, or null if unknown.
 * @property {Candidate[]} candidates Every manifest found, with the reason it does or does
 * not ship.
 * @property {Candidate[]} publishable The subset that ships.
 */

/**
 * Read the `[project]` table of a `pyproject.toml` without a TOML parser: the fields that
 * decide publishability (`name`, `version`) are plain strings in a flat table, and a
 * dependency for four lines of parsing would be the tail wagging the dog.
 *
 * @param {string} text
 * @returns {{name: string | null, version: string | null}}
 */
export function parseProjectTable(text) {
  let inProject = false;
  /** @type {string | null} */
  let name = null;
  /** @type {string | null} */
  let version = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      inProject = /^\[\s*project\s*\]$/.test(line);
      continue;
    }
    if (!inProject) continue;
    const match = /^(name|version)\s*=\s*"([^"]*)"/.exec(line);
    if (match === null) continue;
    const [, key, value] = match;
    if (key === undefined || value === undefined) continue;
    if (key === 'name') name = value;
    else version = value;
  }

  return { name, version };
}

/**
 * @param {string} root
 * @returns {Candidate[]} Every manifest under `root`, in path order.
 */
export function findCandidates(root) {
  /** @type {Candidate[]} */
  const candidates = [];

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
      const path = relative(root, absolute).split(sep).join('/');
      if (entry.name === 'package.json') {
        candidates.push(npmCandidate(path, absolute));
      } else if (entry.name === 'pyproject.toml') {
        candidates.push(pypiCandidate(path, absolute));
      }
    }
  };

  walk(root);
  return candidates.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * A `package.json` that is not an object, or that declares a non-string name or version, is
 * a broken manifest rather than an unpublishable one -- and it is the kind of thing that
 * silently disables a publisher. Fail on it.
 *
 * @param {string} path
 * @param {string} absolute
 * @returns {Candidate}
 */
function npmCandidate(path, absolute) {
  /** @type {any} */
  const manifest = JSON.parse(readFileSync(absolute, 'utf8'));
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`${path} is not a JSON object`);
  }
  const name = typeof manifest.name === 'string' ? manifest.name : null;
  const version = typeof manifest.version === 'string' ? manifest.version : null;
  if (manifest.private === true) {
    return { registry: 'npm', path, name, version, status: 'private' };
  }
  return { registry: 'npm', path, name, version, status: 'unreleased-version' };
}

/**
 * @param {string} path
 * @param {string} absolute
 * @returns {Candidate}
 */
function pypiCandidate(path, absolute) {
  const { name, version } = parseProjectTable(readFileSync(absolute, 'utf8'));
  return {
    registry: 'pypi',
    path,
    name,
    version,
    status: version === null ? 'dynamic-version' : 'unreleased-version',
  };
}

/**
 * Decide which candidates ship.
 *
 * @param {{ root: string, version: string | null }} options
 * @returns {Detection}
 */
export function detect({ root, version }) {
  const candidates = findCandidates(root).map((candidate) => ({
    ...candidate,
    status: classify(candidate, version),
  }));
  return {
    version,
    candidates,
    publishable: candidates.filter((candidate) => candidate.status === 'publishable'),
  };
}

/**
 * @param {Candidate} candidate
 * @param {string | null} version
 * @returns {CandidateStatus}
 */
function classify(candidate, version) {
  if (candidate.status === 'private') return 'private';
  if (candidate.status === 'dynamic-version') return 'dynamic-version';
  if (candidate.name === null || candidate.version === null) return 'unreleased-version';
  if (NON_DISTRIBUTABLE_PREFIXES.some((prefix) => candidate.path.startsWith(prefix))) {
    return 'outside-workspace';
  }
  if (candidate.version === PLACEHOLDER_VERSION) return 'placeholder';
  if (version === null || candidate.version !== version) return 'unreleased-version';
  return 'publishable';
}

/**
 * The released version, taken from the tag unless the caller knows better. A release that
 * has not been tagged has not happened, so its version is unknown and nothing ships.
 *
 * @param {string} root
 * @returns {string | null}
 */
export function releasedVersionFromGit(root) {
  const result = spawnSync('git', ['describe', '--tags', '--abbrev=0'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.status !== 0) return null;
  const tag = result.stdout.trim();
  if (tag === '') return null;
  return stripTagPrefix(tag, readTagPrefix(root));
}

/**
 * `release: published` hands over `v0.1.5`, a manifest declares `0.1.5`.
 *
 * @param {string} value
 * @param {string} prefix
 * @returns {string}
 */
export function stripTagPrefix(value, prefix) {
  return prefix !== '' && value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

/**
 * @param {string} root
 * @returns {string}
 */
function readTagPrefix(root) {
  try {
    const config = JSON.parse(readFileSync(join(root, 'release.config.json'), 'utf8'));
    return typeof config.tagPrefix === 'string' ? config.tagPrefix : '';
  } catch {
    return '';
  }
}

/**
 * @param {Detection} detection
 * @returns {string}
 */
export function formatDetection(detection) {
  const lines = [
    `release version: ${detection.version ?? '(unknown -- nothing has been released)'}`,
    `publishable: ${detection.publishable.length}`,
  ];
  for (const candidate of detection.candidates) {
    const name = candidate.name ?? '(unnamed)';
    const version = candidate.version ?? '(no version)';
    lines.push(
      `  ${candidate.status.padEnd(18)} ${candidate.registry}  ${name}@${version}  ${candidate.path}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/**
 * @param {string} path
 * @param {string[]} argv
 * @returns {string | null}
 */
function argument(path, argv) {
  const index = argv.indexOf(path);
  if (index === -1) return null;
  const value = argv[index + 1];
  return value === undefined || value.startsWith('--') ? '' : value;
}

function main() {
  const argv = process.argv.slice(2);
  const root = argument('--root', argv) || process.cwd();
  const requested = argument('--version', argv);
  const version =
    requested === null
      ? releasedVersionFromGit(root)
      : requested === ''
        ? null
        : stripTagPrefix(requested, readTagPrefix(root));
  const detection = detect({ root, version });

  const output = argument('--github-output', argv);
  if (output !== null && output !== '') {
    writeFileSync(
      output,
      [
        `publishable=${detection.publishable.length > 0}`,
        `count=${detection.publishable.length}`,
        `version=${detection.version ?? ''}`,
        `artifacts=${JSON.stringify(
          detection.publishable.map(({ registry, name, version: declared }) => ({
            registry,
            name,
            version: declared,
          })),
        )}`,
        '',
      ].join('\n'),
    );
  }

  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(detection, null, 2)}\n`);
  } else {
    process.stdout.write(formatDetection(detection));
  }
}

// Importable for the tests, executable for the workflow.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
