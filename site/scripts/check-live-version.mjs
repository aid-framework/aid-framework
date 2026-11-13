/**
 * Asserts the published site reports the release the tree declares.
 *
 * Every other gate in this repository reads the working tree, so none of them can tell a
 * deploy that ran from a deploy that published nothing. The published site is the one
 * artefact a reader meets before the code, and GitHub Pages sits behind a CDN that serves
 * `max-age=600`, so a fresh deploy can be invisible for ten minutes after a green build.
 * A check that fetched once would therefore report a false failure, and one that never
 * fetched at all is what made a stale-site complaint unanswerable.
 *
 * The expected version is `currentVersion()`, the same function the site's footer renders,
 * so this compares the claim against the page that makes it rather than against a second
 * copy of the version.
 *
 * Rules:
 *   - fetch the page, and accept it only when it carries the declared version;
 *   - retry with exponential backoff over roughly ten minutes, because of the CDN;
 *   - a non-200 response or a fetch error counts as a miss and is retried, never skipped;
 *   - an exhausted run fails, and names every version it did see.
 *
 * This is a *post*-deploy check. It runs after `deploy` on `main`, so it informs and can be
 * re-run; it never gates a merge, and it is deliberately not a required check.
 *
 * Usage:
 *   node scripts/check-live-version.mjs [url]
 */

import { currentVersion } from './site-version.mjs';

/** The published homepage. */
export const DEFAULT_URL = 'https://aid-framework.github.io/aid-framework/';

/**
 * Waits between attempts in milliseconds, before the second attempt onwards. Six attempts
 * over ~9.75 minutes covers a `max-age=600` window with one retry to spare.
 */
export const DEFAULT_DELAYS_MS = [15_000, 30_000, 60_000, 120_000, 180_000, 180_000];

/**
 * Every `vX.Y.Z` the page mentions, in order of appearance, without duplicates. Reading all
 * of them is what lets a failure say which release the site is actually serving.
 *
 * @param {string} html
 * @returns {string[]}
 */
export function versionsIn(html) {
  /** @type {string[]} */
  const versions = [];
  for (const match of html.matchAll(/v\d+\.\d+\.\d+/g)) {
    if (!versions.includes(match[0])) versions.push(match[0]);
  }
  return versions;
}

/** @param {number} ms */
function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * @typedef {object} LiveVersionResult
 * @property {boolean} ok whether the declared version was served
 * @property {number} attempts how many fetches were made
 * @property {string[]} versions every version the page was seen to carry
 */

/**
 * Fetches the page until it carries `expected`, or the attempts run out.
 *
 * `fetchImpl`, `sleep` and `log` are injectable so the retry policy is testable without a
 * network and without waiting ten minutes.
 *
 * @param {object} options
 * @param {string} options.expected the version the tree declares, for example `v0.1.168`
 * @param {string} [options.url]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {number[]} [options.delays]
 * @param {(line: string) => void} [options.log]
 * @returns {Promise<LiveVersionResult>}
 */
export async function waitForVersion({
  expected,
  url = DEFAULT_URL,
  fetchImpl = globalThis.fetch,
  sleep = wait,
  delays = DEFAULT_DELAYS_MS,
  log = (line) => process.stderr.write(`${line}\n`),
}) {
  const attempts = delays.length + 1;
  /** @type {string[]} */
  const seen = [];

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const label = `attempt ${attempt}/${attempts}`;
    let html = null;
    try {
      const response = await fetchImpl(url);
      if (response.ok) html = await response.text();
      else log(`${label}: ${url} answered ${response.status}`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log(`${label}: ${url} could not be fetched (${reason})`);
    }

    if (html !== null) {
      const versions = versionsIn(html);
      for (const version of versions) {
        if (!seen.includes(version)) seen.push(version);
      }
      if (versions.includes(expected)) {
        log(`${label}: ${url} reports ${expected}`);
        return { ok: true, attempts: attempt, versions: seen };
      }
      const served = versions.length === 0 ? 'no version at all' : versions.join(', ');
      log(`${label}: ${url} reports ${served}, expected ${expected}`);
    }

    if (attempt < attempts) await sleep(delays[attempt - 1] ?? 0);
  }

  return { ok: false, attempts, versions: seen };
}

/**
 * @param {string} line
 * @returns {never}
 */
function fail(line) {
  process.stderr.write(`${line}\n`);
  process.exit(1);
}

async function main() {
  const expected = currentVersion();
  if (expected === null) {
    fail(
      'the shipped manifests do not declare one release version, so there is nothing to compare the site against',
    );
  }

  const url = process.argv[2] ?? process.env.AID_LIVE_URL ?? DEFAULT_URL;
  const result = await waitForVersion({ expected, url });

  if (!result.ok) {
    const served = result.versions.length === 0 ? 'no version at all' : result.versions.join(', ');
    fail(
      `${url} never reported ${expected} in ${result.attempts} attempts over ~10 minutes; it served ${served}`,
    );
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))
) {
  await main();
}
