/**
 * Verifies that every built page carries a title, its own description, and the social
 * metadata a shared link needs.
 *
 * The presence of a description tag proves nothing on its own: VitePress falls back to the
 * site-wide description, so every page emits one whether or not an author wrote it, and a
 * check that only asserted presence would pass while every shared link described the
 * project instead of the page. The homepage is where that fallback is observable - it
 * declares no description of its own - so its `<meta name="description">` is treated as the
 * fallback, and a non-home page that repeats it is reported as having no description.
 *
 * Rules:
 *   - every page except the 404 page declares a non-empty `<title>`;
 *   - every page except the 404 page declares a non-empty meta description;
 *   - a non-home page's description is not the site-wide fallback;
 *   - every page except the 404 page declares `og:type`, `og:site_name`, `og:title`,
 *     `og:description`, `og:url` and `og:locale`;
 *   - `og:url` equals the page's canonical link, so a shared link and an indexed URL agree;
 *   - `og:type` is `website` on the homepage and `article` everywhere else;
 *   - `twitter:card` is `summary`, with non-empty `twitter:title` and `twitter:description`.
 *
 * The 404 page is exempt: it is not addressable, has no canonical URL, and is not shared.
 *
 * Usage:
 *   node scripts/check-head.mjs
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const distRoot = fileURLToPath(new URL('../.vitepress/dist', import.meta.url));

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
 * Every `<meta>` on the page, keyed by `property` or `name`. Reading the attributes one at a
 * time keeps the map independent of the order in which they are emitted.
 *
 * @param {string} html
 * @returns {Map<string, string>}
 */
function metaTags(html) {
  /** @type {Map<string, string>} */
  const tags = new Map();
  for (const match of html.matchAll(/<meta\b([^>]*)>/g)) {
    const attrs = match[1];
    const key = /\s(?:property|name)="([^"]+)"/.exec(attrs);
    if (key === null) continue;
    const content = /\scontent="([^"]*)"/.exec(attrs);
    tags.set(key[1], content === null ? '' : content[1]);
  }
  return tags;
}

/**
 * @param {string} html
 * @returns {string | null}
 */
function canonical(html) {
  for (const match of html.matchAll(/<link\b([^>]*)>/g)) {
    if (!/\srel="canonical"/.test(match[1])) continue;
    const href = /\shref="([^"]*)"/.exec(match[1]);
    return href === null ? '' : href[1];
  }
  return null;
}

if (!existsSync(distRoot) || !statSync(distRoot).isDirectory()) {
  console.error(`[head] no build under ${distRoot}; run \`pnpm docs:build\` first`);
  process.exit(2);
}

const files = htmlFiles(distRoot);
if (files.length === 0) {
  console.error(`[head] no HTML under ${distRoot}; run \`pnpm docs:build\` first`);
  process.exit(2);
}

const homePath = join(distRoot, 'index.html');
if (!existsSync(homePath)) {
  console.error('[head] the build has no index.html; the homepage fallback is unreadable');
  process.exit(2);
}
const homeDescription = metaTags(readFileSync(homePath, 'utf8')).get('description') ?? '';
if (homeDescription.trim() === '') {
  failures.push('index.html: the homepage declares no description, so there is no fallback');
}

let pageCount = 0;
let describedCount = 0;
let socialCount = 0;

for (const file of files) {
  const html = readFileSync(file, 'utf8');
  const page = relative(distRoot, file).split(sep).join('/');
  if (page === '404.html') continue;
  pageCount += 1;

  const isHome = page === 'index.html';
  const tags = metaTags(html);
  const description = tags.get('description') ?? '';

  if (tags.get('description') === undefined || description.trim() === '') {
    failures.push(`${page}: no meta description`);
  } else {
    describedCount += 1;
    if (!isHome && description === homeDescription) {
      failures.push(`${page}: its description is the site-wide fallback, not its own`);
    }
  }

  const title = /<title>([\s\S]*?)<\/title>/.exec(html);
  if (title === null || title[1].trim() === '') {
    failures.push(`${page}: no <title>`);
  }

  /** @type {[string, string][]} */
  const required = [
    ['og:type', isHome ? 'website' : 'article'],
    ['og:site_name', 'AID Framework'],
    ['og:title', ''],
    ['og:description', ''],
    ['og:url', ''],
    ['og:locale', 'en_GB'],
  ];
  for (const [property, expected] of required) {
    const value = tags.get(property);
    if (value === undefined || value.trim() === '') {
      failures.push(`${page}: no ${property}`);
      continue;
    }
    socialCount += 1;
    if (expected !== '' && value !== expected) {
      failures.push(`${page}: ${property} is "${value}", expected "${expected}"`);
    }
  }

  const ogUrl = tags.get('og:url') ?? '';
  const link = canonical(html);
  if (link === null || link === '') {
    failures.push(`${page}: no canonical link, so og:url has nothing to agree with`);
  } else if (ogUrl !== link) {
    failures.push(`${page}: og:url "${ogUrl}" does not match canonical "${link}"`);
  }
  if ((tags.get('twitter:card') ?? '') !== 'summary') {
    failures.push(`${page}: twitter:card is not "summary"`);
  } else {
    socialCount += 1;
  }
  for (const tag of ['twitter:title', 'twitter:description']) {
    if ((tags.get(tag) ?? '').trim() === '') failures.push(`${page}: no ${tag}`);
    else socialCount += 1;
  }
}

if (failures.length > 0) {
  console.error(`[head] ${failures.length} problem(s) across ${pageCount} pages:`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log(
  `[head] ${pageCount} pages, ${describedCount} page descriptions, ${socialCount} social tags: all pass`,
);
