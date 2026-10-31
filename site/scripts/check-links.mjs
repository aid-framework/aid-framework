/**
 * Verifies that every internal link in the built site resolves to a file the build emitted.
 *
 * Markdown lint checks the Markdown sources, but the site's links are not only the ones
 * authors type: the sidebar and nav come from `config.mts`, and VitePress rewrites relative
 * `.md` links into clean URLs. A sidebar entry pointing at a page that does not exist, or a
 * link that keeps a `.md` extension, is valid Markdown and a broken link once built. This
 * script reads `dist/`, so it checks what a browser would actually receive.
 *
 * Three failure modes are reported:
 *   - an internal path with no emitted file (tried with the clean-URL fallbacks);
 *   - an absolute path outside the project Pages base, which 404s on `aid-framework.github.io`
 *     because this repository does not own the host root;
 *   - a fragment that names no `id` on the target page.
 *
 * External links are not fetched: the build stays offline and deterministic.
 *
 * Usage:
 *   node scripts/check-links.mjs
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const distRoot = fileURLToPath(new URL('../.vitepress/dist', import.meta.url));
const BASE = '/aid-framework/';
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/** @type {string[]} */
const failures = [];

/**
 * @param {string} directory
 * @returns {string[]} absolute paths of every emitted HTML file.
 */
function htmlFiles(directory) {
  /** @type {string[]} */
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...htmlFiles(path));
    else if (entry.name.endsWith('.html')) found.push(path);
  }
  return found;
}

/**
 * @param {string} path
 * @returns {boolean}
 */
function isFile(path) {
  return existsSync(path) && statSync(path).isFile();
}

/**
 * The file a clean URL is served from: GitHub Pages maps `/x` to `x.html` and `/x/` to
 * `x/index.html`. A path with a file extension is taken literally so assets are not shadowed.
 *
 * @param {string} urlPath path below the base, without a leading slash; may be empty
 * @returns {string | null} absolute path of the emitted file, or `null`
 */
function targetFile(urlPath) {
  const candidate = join(distRoot, urlPath);
  /** @type {string[]} */
  const options =
    urlPath === '' || urlPath.endsWith('/')
      ? [join(candidate, 'index.html')]
      : [candidate, `${candidate}.html`, join(candidate, 'index.html')];

  for (const option of options) if (isFile(option)) return option;
  return null;
}

/**
 * @param {string} file absolute path of the HTML file being checked
 * @returns {Set<string>} every `id` and named anchor defined on the page
 */
function idsOnPage(file) {
  const html = readFileSync(file, 'utf8');
  const ids = new Set();
  for (const match of html.matchAll(/\sid="([^"]+)"/g)) ids.add(match[1]);
  for (const match of html.matchAll(/\sname="([^"]+)"/g)) ids.add(match[1]);
  return ids;
}

const files = htmlFiles(distRoot);
if (files.length === 0) {
  console.error(`[links] no HTML under ${distRoot}; run \`pnpm docs:build\` first`);
  process.exit(2);
}

/** @type {Map<string, Set<string>>} */
const idCache = new Map();

let linkCount = 0;
let fragmentCount = 0;

for (const file of files) {
  const html = readFileSync(file, 'utf8');
  const page = relative(distRoot, file).split(sep).join('/');

  for (const match of html.matchAll(/\s(?:href|src)="([^"]*)"/g)) {
    const raw = match[1];
    if (raw.length === 0 || EXTERNAL.test(raw)) continue;

    const hashIndex = raw.indexOf('#');
    const fragment = hashIndex === -1 ? '' : raw.slice(hashIndex + 1);
    const pathPart = (hashIndex === -1 ? raw : raw.slice(0, hashIndex)).split('?')[0];

    /** @type {string | null} */
    let resolved = null;

    if (pathPart === '') {
      // A same-page fragment; counted with the fragments below, not as a link.
      resolved = file;
    } else if (pathPart.startsWith('/')) {
      if (!pathPart.startsWith(BASE)) {
        failures.push(`${page}: ${raw} is absolute but outside ${BASE}`);
        continue;
      }
      linkCount += 1;
      resolved = targetFile(pathPart.slice(BASE.length));
    } else {
      linkCount += 1;
      const absolute = resolve(dirname(file), pathPart);
      const urlPath = relative(distRoot, absolute).split(sep).join('/');
      if (urlPath.startsWith('..')) {
        failures.push(`${page}: ${raw} escapes the site root`);
        continue;
      }
      resolved = targetFile(urlPath);
    }

    if (resolved === null) {
      failures.push(`${page}: ${raw} has no emitted file`);
      continue;
    }

    if (fragment.length > 0) {
      fragmentCount += 1;
      if (!idCache.has(resolved)) idCache.set(resolved, idsOnPage(resolved));
      const ids = idCache.get(resolved);
      if (ids !== undefined && !ids.has(fragment)) {
        const target = relative(distRoot, resolved).split(sep).join('/');
        failures.push(`${page}: ${raw} names no id "${fragment}" on ${target}`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error(`[links] ${failures.length} problem(s) across ${files.length} pages:`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log(
  `[links] ${files.length} pages, ${linkCount} internal links, ${fragmentCount} fragments: all resolve`,
);
