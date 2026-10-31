#!/usr/bin/env node
// @ts-check
/**
 * Release version computation for the AID Framework monorepo.
 *
 * The decision logic is pure functions over plain data (`tags`, `changedPaths`,
 * config); only `main()` touches the filesystem, so the gate is unit-testable and
 * nothing tested shells out to `git`.
 *
 * Gating is path-based, not conventional-commit based: `release.config.json`
 * holds a denylist of non-releasable paths, so a change set touching both docs and
 * code releases. Root-level `*.md` is non-releasable, but `packages/spec/README.md`
 * is shipped package content and is not matched by that rule.
 *
 * The JSON decision goes to stdout and notes to stderr, so a redirect stays clean.
 * Exit 0 means a decision was produced - including "do not release"; exit 2 means
 * a usage or I/O failure. `stamp` is the exception: a rejected `--version` is exit 1.
 *
 * `stamp` is the counterweight to the tag being the source of truth: it writes a
 * version into every manifest `release.config.json` lists, so `release.yml` tagging
 * `v0.1.39` and the manifests declaring `0.1.39` cannot drift apart. A pypi package
 * that also exposes a module-level `__version__` gets that literal stamped too, since
 * the runtime's own tests pin it to `[project].version`. It is a maintainer command
 * run before the release commit, deliberately not a CI step -- a workflow that rewrote
 * manifests could publish a version nobody reviewed.
 */

import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * @typedef {object} Version
 * @property {number} major
 * @property {number} minor
 * @property {number} patch
 */

/**
 * @typedef {object} NonReleasableRule
 * @property {string} pattern
 * @property {string} reason
 */

/**
 * @typedef {object} PackageEntry
 * @property {string} name
 * @property {string} path
 * @property {string} registry
 */

/**
 * @typedef {object} ReleaseConfig
 * @property {string} [description]
 * @property {'repo-wide' | 'independent'} mode
 * @property {string} tagPrefix
 * @property {'patch'} bump
 * @property {string} bootstrapVersion
 * @property {string} [releaseGating]
 * @property {NonReleasableRule[]} nonReleasable
 * @property {PackageEntry[]} packages
 */

/**
 * @typedef {object} PackageRelease
 * @property {string} name
 * @property {string} path
 * @property {string} registry
 * @property {string} previousVersion
 * @property {string} version
 * @property {string} tag
 * @property {string[]} paths
 */

/**
 * @typedef {object} ReleaseDecision
 * @property {boolean} release
 * @property {'repo-wide' | 'independent'} mode
 * @property {string} reason
 * @property {boolean} forced
 * @property {string | null} currentVersion
 * @property {string | null} version
 * @property {string | null} tag
 * @property {string[]} changedPaths
 * @property {string[]} releasablePaths
 * @property {PackageRelease[]} [packages]
 */

const USAGE = [
  'usage: node scripts/version.mjs [decide] --config <file> (--tags-file <file> | --tags a,b)',
  '                                     (--changed-files-file <file> | --changed-files a,b)',
  '                                     [--force] [--github-output <file>]',
  '       node scripts/version.mjs latest  --config <file> (--tags-file <file> | --tags a,b)',
  '       node scripts/version.mjs stamp   --version x.y.z [--config <file>]',
].join('\n');

/** A released version as a manifest declares it: bare, no tag prefix. */
const STAMP_VERSION = /^\d+\.\d+\.\d+$/;

/**
 * A `stamp` argument the maintainer can fix by retyping. Distinct from the generic
 * exit 2 so `stamp`'s contract -- reject a bad version with exit 1 -- holds without
 * making every other failure look like a usage error.
 */
export class StampVersionError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'StampVersionError';
    this.exitCode = 1;
  }
}

/**
 * The version to write, rejecting anything a manifest may not declare. A tag prefix
 * is the caller quoting the git tag rather than the version, so it is named
 * explicitly instead of being silently stripped: `stamp --version v0.1.39` writing
 * `0.1.39` would hide that the two spellings differ.
 *
 * @param {string} value
 * @returns {string}
 */
export function parseStampVersion(value) {
  if (value.startsWith('v')) {
    throw new StampVersionError(
      `--version takes a bare semver version, not a tag: use ${value.slice(1)} instead of ${value}`,
    );
  }
  if (!STAMP_VERSION.test(value)) {
    throw new StampVersionError(`--version must be a x.y.z version, got "${value}"`);
  }
  return value;
}

/**
 * Rewrite `[project] version` in a `pyproject.toml`, leaving every other byte alone.
 * The fields that decide publishability are flat strings in the project table, so the
 * four lines of parsing that `detect-publishable.mjs` already relies on are enough;
 * a TOML dependency would be the tail wagging the dog.
 *
 * @param {string} text
 * @param {string} version
 * @returns {{ text: string, changed: boolean }}
 */
export function stampProjectVersion(text, version) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(eol);
  let inProject = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      inProject = /^\[\s*project\s*\]$/.test(trimmed);
      continue;
    }
    if (!inProject) continue;
    const match = /^(\s*version\s*=\s*")([^"]*)(".*)$/.exec(line);
    if (match === null) continue;
    const [, prefix, declared, suffix] = match;
    if (declared === version) return { text, changed: false };
    lines[index] = `${prefix}${version}${suffix}`;
    return { text: lines.join(eol), changed: true };
  }
  throw new StampVersionError(
    'pyproject.toml has no static version in its [project] table, so it cannot be stamped',
  );
}

/**
 * A pypi package can expose its own version as a module-level literal as well as in
 * `[project]`. `runtimes/python` does, and its `tests/test_package.py` pins the two
 * equal, so stamping only the manifest would publish a distribution whose barrel
 * disagrees with its own metadata.
 *
 * @param {string} text
 * @param {string} version
 * @returns {{ text: string, changed: boolean } | null} null when the module has no literal
 */
export function stampBarrelVersion(text, version) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(eol);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;
    const match = /^(__version__\s*=\s*["'])([^"']*)(["'].*)$/.exec(line);
    if (match === null) continue;
    const [, prefix, declared, suffix] = match;
    if (declared === version) return { text, changed: false };
    lines[index] = `${prefix}${version}${suffix}`;
    return { text: lines.join(eol), changed: true };
  }
  return null;
}

/**
 * Write `version` into every manifest `release.config.json` lists. Idempotent by
 * construction rather than by re-serializing: a manifest that already declares the
 * version is not written at all, so a second run leaves every byte identical.
 *
 * @param {{ config: ReleaseConfig, root: string, version: string }} options
 * @returns {{ version: string, written: string[], unchanged: string[] }}
 */
export function stamp({ config, root, version }) {
  /** @type {string[]} */
  const written = [];
  /** @type {string[]} */
  const unchanged = [];

  for (const entry of config.packages) {
    const directory = join(root, ...entry.path.split('/'));
    if (entry.registry === 'npm') {
      const path = `${entry.path}/package.json`;
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
      if (manifest.version === version) {
        unchanged.push(path);
        continue;
      }
      manifest.version = version;
      writeFileSync(join(directory, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      written.push(path);
    } else if (entry.registry === 'pypi') {
      const path = `${entry.path}/pyproject.toml`;
      const absolute = join(directory, 'pyproject.toml');
      const result = stampProjectVersion(readFileSync(absolute, 'utf8'), version);
      if (!result.changed) {
        unchanged.push(path);
      } else {
        writeFileSync(absolute, result.text);
        written.push(path);
      }

      const sourceDir = join(directory, 'src');
      if (!existsSync(sourceDir)) continue;
      for (const module of readdirSync(sourceDir)) {
        const barrel = join(sourceDir, module, '__init__.py');
        if (!existsSync(barrel)) continue;
        const stamped = stampBarrelVersion(readFileSync(barrel, 'utf8'), version);
        if (stamped === null) continue;
        const barrelPath = `${entry.path}/src/${module}/__init__.py`;
        if (!stamped.changed) {
          unchanged.push(barrelPath);
          continue;
        }
        writeFileSync(barrel, stamped.text);
        written.push(barrelPath);
      }
    } else {
      throw new Error(
        `release.config.json lists "${entry.name}" with unknown registry "${entry.registry}"`,
      );
    }
  }

  return { version, written, unchanged };
}

/** @param {string} value */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parses `v1.2.3` (or `<prefix>1.2.3`). Anything else - e.g. a package-scoped
 * `@aid-framework/spec@0.1.0` tag, which only means something in independent mode - is null.
 *
 * @param {string} tag
 * @param {string} prefix
 * @returns {Version | null}
 */
export function parseVersionTag(tag, prefix) {
  const match = new RegExp(`^${escapeRegExp(prefix)}(\\d+)\\.(\\d+)\\.(\\d+)$`).exec(tag);
  if (match === null) return null;
  const [major, minor, patch] = [match[1], match[2], match[3]];
  if (major === undefined || minor === undefined || patch === undefined) return null;
  return { major: Number(major), minor: Number(minor), patch: Number(patch) };
}

/**
 * @param {Version} version
 * @returns {string}
 */
export function formatVersion(version) {
  return `${version.major}.${version.minor}.${version.patch}`;
}

/**
 * @param {Version} a
 * @param {Version} b
 * @returns {number} negative when `a` sorts before `b`
 */
export function compareVersions(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/**
 * The greatest release tag, or `null` when the repository has never released.
 *
 * @param {readonly string[]} tags
 * @param {string} prefix
 * @returns {string | null}
 */
export function latestReleaseTag(tags, prefix) {
  /** @type {Version | null} */
  let best = null;
  for (const tag of tags) {
    const version = parseVersionTag(tag, prefix);
    if (version === null) continue;
    if (best === null || compareVersions(version, best) > 0) best = version;
  }
  return best === null ? null : `${prefix}${formatVersion(best)}`;
}

/**
 * A path is releasable unless it matches one of the denylist rules. The denylist
 * is matched against the whole path, which is why root-level `*.md` does not
 * suppress `packages/spec/README.md`.
 *
 * @param {string} path
 * @param {readonly NonReleasableRule[]} rules
 * @returns {boolean}
 */
export function isReleasable(path, rules) {
  return !rules.some((rule) => new RegExp(rule.pattern).test(path));
}

/**
 * @param {string} path
 * @param {readonly NonReleasableRule[]} rules
 * @returns {NonReleasableRule | null}
 */
export function matchingRule(path, rules) {
  return rules.find((rule) => new RegExp(rule.pattern).test(path)) ?? null;
}

/**
 * Longest prefix match on a path boundary, so `packages/spec-extra` never maps
 * to the `packages/spec` entry.
 *
 * @param {string} path
 * @param {readonly PackageEntry[]} packages
 * @returns {PackageEntry | null}
 */
export function packageFor(path, packages) {
  /** @type {PackageEntry | null} */
  let best = null;
  for (const entry of packages) {
    const prefix = entry.path.endsWith('/') ? entry.path : `${entry.path}/`;
    const matches = path.startsWith(prefix) || path === entry.path;
    if (!matches) continue;
    if (best === null || entry.path.length > best.path.length) best = entry;
  }
  return best;
}

/**
 * @param {string | null} latestTag
 * @param {ReleaseConfig} config
 * @returns {string}
 */
export function nextVersion(latestTag, config) {
  if (latestTag === null) return `${config.tagPrefix}${config.bootstrapVersion}`;
  const current = parseVersionTag(latestTag, config.tagPrefix);
  if (current === null) return `${config.tagPrefix}${config.bootstrapVersion}`;
  return `${config.tagPrefix}${formatVersion({ ...current, patch: current.patch + 1 })}`;
}

/**
 * @param {object} input
 * @param {readonly string[]} input.tags
 * @param {readonly string[]} input.changedPaths
 * @param {boolean} [input.force]
 * @param {ReleaseConfig} input.config
 * @returns {ReleaseDecision}
 */
export function decide({ tags, changedPaths, force = false, config }) {
  const releasablePaths = changedPaths.filter((path) => isReleasable(path, config.nonReleasable));
  const latestTag = latestReleaseTag(tags, config.tagPrefix);
  const forced = force && releasablePaths.length === 0;

  if (config.mode === 'independent') {
    return decideIndependent({ changedPaths, releasablePaths, tags, latestTag, forced, config });
  }

  const version = nextVersion(latestTag, config);
  const releasing = releasablePaths.length > 0 || forced;

  return {
    release: releasing,
    mode: 'repo-wide',
    reason: releasing
      ? describe(releasablePaths, changedPaths, forced)
      : 'no releasable paths changed',
    forced,
    currentVersion: latestTag,
    version: releasing ? version : null,
    tag: releasing ? version : null,
    changedPaths: [...changedPaths],
    releasablePaths,
  };
}

/**
 * Per-package versioning. Unused in `repo-wide` mode, but kept working and tested
 * so switching modes is a config change rather than a rewrite. A releasable path
 * that no `packages` entry covers is a hard error.
 *
 * @param {object} input
 * @param {readonly string[]} input.changedPaths
 * @param {readonly string[]} input.releasablePaths
 * @param {readonly string[]} input.tags
 * @param {string | null} input.latestTag
 * @param {boolean} input.forced
 * @param {ReleaseConfig} input.config
 * @returns {ReleaseDecision}
 */
function decideIndependent({ changedPaths, releasablePaths, tags, latestTag, forced, config }) {
  /** @type {Map<string, PackageRelease>} */
  const releases = new Map();

  for (const path of releasablePaths) {
    const entry = packageFor(path, config.packages);
    if (entry === null) {
      throw new Error(
        `release.config.json is in "independent" mode but no packages[] entry covers ` +
          `the releasable path "${path}". Add an entry (and complete the table for every ` +
          `shippable path) before switching modes.`,
      );
    }
    const existing = releases.get(entry.name);
    if (existing) {
      existing.paths.push(path);
      continue;
    }
    const previous = latestReleaseTag(
      tags.filter((tag) => tag.startsWith(`${entry.name}@`)),
      `${entry.name}@`,
    );
    const previousVersion = previous === null ? null : previous.slice(entry.name.length + 1);
    const next =
      previousVersion === null
        ? config.bootstrapVersion
        : formatVersion(bumpPatch(previousVersion));
    releases.set(entry.name, {
      name: entry.name,
      path: entry.path,
      registry: entry.registry,
      previousVersion: previousVersion ?? '(none)',
      version: next,
      tag: `${entry.name}@${next}`,
      paths: [path],
    });
  }

  const packages = [...releases.values()].sort((a, b) => a.name.localeCompare(b.name));
  const releasing = packages.length > 0 || forced;

  return {
    release: releasing,
    mode: 'independent',
    reason: releasing
      ? describe(releasablePaths, changedPaths, forced)
      : 'no releasable paths changed',
    forced,
    currentVersion: latestTag,
    version: null,
    tag: null,
    changedPaths: [...changedPaths],
    releasablePaths: [...releasablePaths],
    packages,
  };
}

/**
 * @param {string} version
 * @returns {Version}
 */
function bumpPatch(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (match === null) return { major: 0, minor: 0, patch: 1 };
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]) + 1,
  };
}

/**
 * @param {readonly string[]} releasablePaths
 * @param {readonly string[]} changedPaths
 * @param {boolean} forced
 * @returns {string}
 */
function describe(releasablePaths, changedPaths, forced) {
  if (forced && releasablePaths.length === 0) {
    return `forced release despite no releasable paths (${changedPaths.length} path(s) changed)`;
  }
  const preview = releasablePaths.slice(0, 5).join(', ');
  const extra = releasablePaths.length > 5 ? ` (+${releasablePaths.length - 5} more)` : '';
  return `${releasablePaths.length} releasable path(s) changed: ${preview}${extra}`;
}

/**
 * @param {unknown} raw
 * @returns {ReleaseConfig}
 */
export function parseConfig(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('release config must be a JSON object');
  }
  const record = /** @type {Record<string, unknown>} */ (raw);
  const mode = record['mode'];
  if (mode !== 'repo-wide' && mode !== 'independent') {
    throw new Error(
      `release config "mode" must be "repo-wide" or "independent", got ${String(mode)}`,
    );
  }
  const tagPrefix = record['tagPrefix'];
  if (typeof tagPrefix !== 'string' || tagPrefix.length === 0) {
    throw new Error('release config "tagPrefix" must be a non-empty string');
  }
  const bootstrapVersion = record['bootstrapVersion'];
  if (
    typeof bootstrapVersion !== 'string' ||
    parseVersionTag(tagPrefix + bootstrapVersion, tagPrefix) === null
  ) {
    throw new Error('release config "bootstrapVersion" must be a x.y.z version');
  }
  const bump = record['bump'];
  if (bump !== 'patch') {
    throw new Error(`release config "bump" must be "patch", got ${String(bump)}`);
  }
  const nonReleasable = record['nonReleasable'];
  if (!Array.isArray(nonReleasable)) {
    throw new Error('release config "nonReleasable" must be an array of { pattern, reason }');
  }
  const rules = nonReleasable.map((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error('each "nonReleasable" entry must be an object');
    }
    const item = /** @type {Record<string, unknown>} */ (entry);
    const pattern = item['pattern'];
    if (typeof pattern !== 'string')
      throw new Error('each "nonReleasable" entry needs a string "pattern"');
    try {
      new RegExp(pattern);
    } catch {
      throw new Error(`"nonReleasable" pattern ${pattern} is not a valid regular expression`);
    }
    const reason = typeof item['reason'] === 'string' ? item['reason'] : '';
    return { pattern, reason };
  });
  const packages = record['packages'];
  if (!Array.isArray(packages)) {
    throw new Error('release config "packages" must be an array of { name, path, registry }');
  }
  const entries = packages.map((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error('each "packages" entry must be an object');
    }
    const item = /** @type {Record<string, unknown>} */ (entry);
    const name = item['name'];
    const path = item['path'];
    const registry = item['registry'];
    if (typeof name !== 'string' || typeof path !== 'string' || typeof registry !== 'string') {
      throw new Error('each "packages" entry needs string "name", "path" and "registry"');
    }
    return { name, path, registry };
  });

  return {
    mode,
    tagPrefix,
    bump,
    bootstrapVersion,
    nonReleasable: rules,
    packages: entries,
  };
}

/**
 * @param {string[]} argv
 * @returns {Record<string, string>}
 */
function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || !token.startsWith('--')) {
      throw new Error(`unexpected argument: ${String(token)}`);
    }
    const name = token.slice(2);
    if (name === 'force') {
      args['force'] = 'true';
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`option --${name} needs a value`);
    }
    args[name] = value;
    index += 1;
  }
  return args;
}

/**
 * @param {Record<string, string>} args
 * @param {string} key
 * @returns {string[] | null}
 */
function listOption(args, key) {
  const file = args[`${key}-file`];
  if (file !== undefined) {
    return readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }
  const inline = args[key];
  if (inline !== undefined) {
    return inline
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  return null;
}

/** The repo root, only used to find the default `release.config.json` for `stamp`. */
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * `stamp --version x.y.z [--config <file>]`.
 *
 * The config is optional here, unlike `decide`, so the maintainer command is a
 * one-liner against the checked-in release config. Package paths resolve against the
 * config's own directory, which keeps `--config` usable from a fixture tree.
 *
 * @param {Record<string, string | undefined>} args
 */
function stampCommand(args) {
  const requested = args['version'];
  if (requested === undefined) throw new StampVersionError(`--version is required\n${USAGE}`);
  const version = parseStampVersion(requested);

  const configPath = resolve(args['config'] ?? join(REPO_ROOT, 'release.config.json'));
  const config = parseConfig(JSON.parse(readFileSync(configPath, 'utf8')));
  const result = stamp({ config, root: dirname(configPath), version });

  process.stdout.write(
    `[stamp] ${version}: ${result.written.length} written, ${result.unchanged.length} unchanged\n`,
  );
  if (result.written.length === 0) {
    const total = result.written.length + result.unchanged.length;
    process.stdout.write(`[stamp] all ${total} manifests already declare ${version}\n`);
  }
  for (const path of result.written) process.stdout.write(`  wrote ${path}\n`);
  for (const path of result.unchanged) process.stdout.write(`  unchanged ${path}\n`);
}

function main() {
  const argv = process.argv.slice(2);
  const hasCommand = argv[0] !== undefined && !argv[0].startsWith('--');
  const command = hasCommand ? argv[0] : 'decide';
  const args = parseArgs(hasCommand ? argv.slice(1) : argv);

  if (command === 'stamp') {
    stampCommand(args);
    return;
  }

  const configPath = args['config'];
  if (configPath === undefined) throw new Error(`--config is required\n${USAGE}`);
  const config = parseConfig(JSON.parse(readFileSync(configPath, 'utf8')));

  const tags = listOption(args, 'tags');

  if (command === 'latest') {
    if (tags === null) throw new Error(`--tags or --tags-file is required\n${USAGE}`);
    // Lets the workflow build its `git diff` range without re-deriving the prefix.
    const latest = latestReleaseTag(tags, config.tagPrefix);
    if (latest !== null) process.stdout.write(`${latest}\n`);
    return;
  }

  if (command !== 'decide') throw new Error(`unknown command: ${command}\n${USAGE}`);

  const changedPaths = listOption(args, 'changed-files');
  if (changedPaths === null)
    throw new Error(`--changed-files or --changed-files-file is required\n${USAGE}`);

  const decision = decide({
    tags: tags ?? [],
    changedPaths,
    force: args['force'] === 'true',
    config,
  });

  process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);

  const githubOutput = args['github-output'];
  if (githubOutput !== undefined) {
    appendFileSync(
      githubOutput,
      [
        `release=${decision.release ? 'true' : 'false'}`,
        `version=${decision.version ?? ''}`,
        `tag=${decision.tag ?? ''}`,
        `mode=${decision.mode}`,
        `reason=${decision.reason}`,
        '',
      ].join('\n'),
    );
  }

  process.stderr.write(
    decision.release
      ? `[release] ${decision.reason} -> ${decision.tag ?? decision.packages?.map((p) => p.tag).join(', ')}\n`
      : `[release] skipped: ${decision.reason}\n`,
  );
}

// Only run when invoked as a program; the unit tests import the pure functions.
if (
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    const exitCode = /** @type {{ exitCode?: number }} */ (error).exitCode;
    process.exit(typeof exitCode === 'number' ? exitCode : 2);
  }
}
