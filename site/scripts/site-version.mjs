/**
 * The release the site reports in its footer.
 *
 * The tag is the source of truth, not a manifest: every `package.json` declares `0.0.0`
 * between releases and `release.yml` stamps the real version only for a publish. The
 * selection logic is not reimplemented here — `scripts/version.mjs latest` is the command
 * the release workflow itself uses, so the footer and the release gate cannot disagree
 * about which tag is current.
 *
 * It is invoked as a subprocess rather than imported because VitePress bundles this file
 * into the config, and the entry point's `#!` line is only legal at the start of a file.
 *
 * A shallow clone has no tags (`actions/checkout` fetches one commit by default), and a
 * checkout with no tags has no honest answer — `null` is returned and the footer omits the
 * version instead of printing a guess.
 *
 * Usage:
 *   node scripts/site-version.mjs   print the version, or nothing when unknown
 */

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/**
 * @returns {string | null} the latest release tag (`v0.1.41`), or `null` when the
 * checkout carries no tags.
 */
export function currentVersion() {
  /** @type {string} */
  let tags;
  try {
    tags = execFileSync('git', ['tag', '--list'], { cwd: repoRoot, encoding: 'utf8' });
  } catch {
    return null;
  }

  const list = tags
    .split('\n')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
  if (list.length === 0) return null;

  const stdout = execFileSync(
    process.execPath,
    [
      join(repoRoot, 'scripts', 'version.mjs'),
      'latest',
      '--config',
      join(repoRoot, 'release.config.json'),
      '--tags',
      list.join(','),
    ],
    { encoding: 'utf8' },
  ).trim();

  return stdout.length === 0 ? null : stdout;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))
) {
  const version = currentVersion();
  if (version !== null) process.stdout.write(`${version}\n`);
}
