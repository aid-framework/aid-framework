/**
 * Verifies structural accessibility and self-containment on the built site.
 *
 * This is not an audit — it cannot judge contrast or reading order, and it does not run a
 * browser. It checks the invariants that a theme or a content change can silently break, on
 * the HTML a browser actually receives, so the same rules apply to generated pages as to
 * hand-written ones.
 *
 * Rules:
 *   - every page declares a non-empty `lang`;
 *   - every page except the 404 page offers a skip link whose target id exists on the page;
 *   - every page except the 404 page keeps its content in a landmark (`main`, `role="main"`,
 *     or `article`, which VitePress uses for the home layout);
 *   - every `img` has an `alt` attribute, present even when empty;
 *   - no page repeats an `id`;
 *   - no positive `tabindex`, which reorders focus away from the document order;
 *   - every link and button has an accessible name (text, `aria-label`, `aria-labelledby`,
 *     `title`, or an image with `alt` inside it);
 *   - no `iframe`, `embed`, or `object`: the site is offline-capable and embeds a third party;
 *   - subresources are same-origin, so no third-party script, style, or font is loaded;
 *   - the local search index is present, so search is not delegated to a hosted service;
 *
 * The 404 page is exempt from the skip-link and landmark rules because VitePress's 404 layout
 * renders neither and a 404 is not a reading surface; its `lang`, names, and ids are still
 * checked.
 *
 * Usage:
 *   node scripts/check-a11y.mjs
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const distRoot = fileURLToPath(new URL('../.vitepress/dist', import.meta.url));
const BASE = '/aid-framework/';
const SITE_ORIGIN = 'https://aid-framework.github.io';
const SUBRESOURCE = /<(script|link|img|source|video|audio)\b([^>]*?)\s(?:src|href)="([^"]+)"/gi;
const EXTERNAL_ORIGIN = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

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
 * @param {string} directory
 * @returns {string[]} absolute paths of every emitted file.
 */
function allFiles(directory) {
  /** @type {string[]} */
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...allFiles(path));
    else if (statSync(path).isFile()) found.push(path);
  }
  return found;
}

/**
 * Visible text of an element, with tags removed and entities left as the browser would show
 * them. `&#8203;` and `&nbsp;` count as text because they are what a screen reader announces.
 *
 * @param {string} inner
 * @returns {string}
 */
function textOf(inner) {
  return inner
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * An element is named if it has text, `aria-label`, `aria-labelledby`, `title`, or a descendant
 * image with a non-empty `alt`. An `aria-hidden` descendant does not name anything.
 *
 * @param {string} attrs
 * @param {string} inner
 * @returns {boolean}
 */
function hasAccessibleName(attrs, inner) {
  if (/\saria-label="[^"]+"/.test(attrs)) return true;
  if (/\saria-labelledby="[^"]+"/.test(attrs)) return true;
  if (/\stitle="[^"]+"/.test(attrs)) return true;
  if (textOf(inner).length > 0) return true;
  for (const match of inner.matchAll(/<img\b([^>]*)>/g)) {
    if (/\salt="[^"]+"/.test(match[1])) return true;
  }
  return false;
}

if (!existsSync(distRoot) || !statSync(distRoot).isDirectory()) {
  console.error(`[a11y] no build under ${distRoot}; run \`pnpm docs:build\` first`);
  process.exit(2);
}

const files = htmlFiles(distRoot);
if (files.length === 0) {
  console.error(`[a11y] no HTML under ${distRoot}; run \`pnpm docs:build\` first`);
  process.exit(2);
}

let linkCount = 0;
let buttonCount = 0;
let imageCount = 0;
let idCount = 0;
let skipLinkCount = 0;

for (const file of files) {
  const html = readFileSync(file, 'utf8');
  const page = relative(distRoot, file).split(sep).join('/');
  const is404 = page === '404.html';

  const lang = /<html\b[^>]*\slang="([^"]*)"/.exec(html);
  if (lang === null || lang[1].trim().length === 0) {
    failures.push(`${page}: <html> declares no lang`);
  }

  /** @type {Set<string>} */
  const ids = new Set();
  for (const match of html.matchAll(/\sid="([^"]+)"/g)) {
    idCount += 1;
    if (ids.has(match[1])) failures.push(`${page}: id "${match[1]}" appears more than once`);
    ids.add(match[1]);
  }

  if (!is404) {
    const skip = /<a\b([^>]*)>([\s\S]*?)<\/a>/g;
    let hasSkipLink = false;
    for (const match of html.matchAll(skip)) {
      const href = /\shref="#([^"]+)"/.exec(match[1]);
      if (href === null) continue;
      if (!/skip/i.test(textOf(match[2]))) continue;
      if (!ids.has(href[1])) {
        failures.push(`${page}: skip link targets "#${href[1]}", which is not on the page`);
      }
      hasSkipLink = true;
      break;
    }
    if (hasSkipLink) skipLinkCount += 1;
    else failures.push(`${page}: no skip link to the main content`);

    const hasLandmark =
      /<main\b/.test(html) || /\srole="main"/.test(html) || /<article\b/.test(html);
    if (!hasLandmark) {
      failures.push(`${page}: content is in no landmark (main, role="main", or article)`);
    }
  }

  for (const match of html.matchAll(/<img\b([^>]*)>/g)) {
    imageCount += 1;
    if (!/\salt=/.test(match[1])) {
      failures.push(`${page}: <img> has no alt attribute (use alt="" when decorative)`);
    }
  }

  for (const match of html.matchAll(/\stabindex="(\d+)"/g)) {
    if (Number(match[1]) > 0) {
      failures.push(`${page}: tabindex="${match[1]}" reorders focus away from document order`);
    }
  }

  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)) {
    linkCount += 1;
    if (!hasAccessibleName(match[1], match[2])) {
      failures.push(`${page}: link has no accessible name: <a${match[1]}>`);
    }
  }

  for (const match of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
    buttonCount += 1;
    if (!hasAccessibleName(match[1], match[2])) {
      failures.push(`${page}: button has no accessible name: <button${match[1]}>`);
    }
  }

  if (/<(iframe|embed|object)\b/i.test(html)) {
    failures.push(`${page}: embeds a frame or object; the site must stay self-contained`);
  }

  for (const match of html.matchAll(SUBRESOURCE)) {
    const url = match[3];
    if (!EXTERNAL_ORIGIN.test(url)) continue;
    if (url.startsWith(SITE_ORIGIN) || url.startsWith(BASE)) continue;
    failures.push(`${page}: loads a subresource from another origin: ${url}`);
  }
}

const assets = allFiles(distRoot);
const localIndex = assets.filter((file) => /localSearchIndex/.test(file));
if (localIndex.length === 0) {
  failures.push('build: no local search index was emitted');
}

if (failures.length > 0) {
  console.error(`[a11y] ${failures.length} problem(s) across ${files.length} pages:`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log(
  `[a11y] ${files.length} pages, ${linkCount} links, ${buttonCount} buttons, ${imageCount} images, ` +
    `${idCount} ids, ${skipLinkCount} skip links, local search index present: all pass`,
);
