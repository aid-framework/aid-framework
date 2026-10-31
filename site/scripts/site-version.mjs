/**
 * The release the site reports in its footer and on its homepage.
 *
 * A tag is not proof of a release: `v0.1.40`-`v0.1.43` were cut while the release gate
 * could not tell a docs-only change from a code change, so nothing was published under
 * them. The version a consumer can install is therefore the one the shipped manifests
 * declare, because the publish workflow stamps a manifest only for a release it is about
 * to publish. Reading the manifests makes the site match npm and PyPI instead of
 * outrunning them.
 *
 * `release.config.json` is the list of shipped manifests, so it is read instead of
 * re-listing them here; a package added there is picked up without a second edit.
 *
 * Every shipped package must agree. A split version means the tree is mid-stamp or a bump
 * was applied by hand, and neither has one honest answer, so `null` is returned and the
 * site omits the version rather than printing a guess.
 *
 * Usage:
 *   node scripts/site-version.mjs   print the version, or nothing when unknown
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/**
 * The shipped packages and tag prefix from `release.config.json`.
 *
 * `parseConfig` in `scripts/version.mjs` validates more, but it cannot be imported here:
 * VitePress bundles this file into its config, and that entry point starts with a `#!`
 * line, which is only legal at the top of a file — esbuild fails once it is inlined. The
 * two fields read here are the whole contract this module needs.
 *
 * @returns {{ tagPrefix: string, packages: { path: string, registry: string }[] } | null}
 */
function shippedPackages() {
  /** @type {unknown} */
  let raw;
  try {
    raw = JSON.parse(readFileSync(join(repoRoot, 'release.config.json'), 'utf8'));
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;

  const { tagPrefix, packages } = /** @type {Record<string, unknown>} */ (raw);
  if (typeof tagPrefix !== 'string' || tagPrefix.length === 0) return null;
  if (!Array.isArray(packages) || packages.length === 0) return null;

  /** @type {{ path: string, registry: string }[]} */
  const entries = [];
  for (const entry of packages) {
    if (typeof entry !== 'object' || entry === null) return null;
    const { path, registry } = /** @type {Record<string, unknown>} */ (entry);
    if (typeof path !== 'string' || typeof registry !== 'string') return null;
    entries.push({ path, registry });
  }
  return { tagPrefix, packages: entries };
}

/**
 * `[project] version` from a `pyproject.toml`, mirroring the table-aware scan in
 * `scripts/version.mjs` so a `version` under another table is never mistaken for it.
 *
 * @param {string} text
 * @returns {string | null}
 */
function projectVersion(text) {
  let inProject = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      inProject = /^\[\s*project\s*\]$/.test(trimmed);
      continue;
    }
    if (!inProject) continue;
    const match = /^\s*version\s*=\s*"([^"]*)"/.exec(line);
    if (match !== null) return match[1] ?? null;
  }
  return null;
}

/**
 * @param {{ path: string, registry: string }} entry
 * @returns {string | null} the version the manifest declares, or `null` when unreadable
 */
function declaredVersion(entry) {
  const directory = join(repoRoot, ...entry.path.split('/'));
  try {
    if (entry.registry === 'npm') {
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
      return typeof manifest.version === 'string' ? manifest.version : null;
    }
    return projectVersion(readFileSync(join(directory, 'pyproject.toml'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * @returns {string | null} the released version with its tag prefix (`v0.1.39`), or
 * `null` when the shipped manifests do not all declare one.
 */
export function currentVersion() {
  const config = shippedPackages();
  if (config === null) return null;

  const declared = new Set();
  for (const entry of config.packages) {
    const version = declaredVersion(entry);
    if (version === null) return null;
    declared.add(version);
  }

  if (declared.size !== 1) return null;
  const [version] = declared;
  return version === undefined || version === '0.0.0' ? null : `${config.tagPrefix}${version}`;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))
) {
  const version = currentVersion();
  if (version !== null) process.stdout.write(`${version}\n`);
}
