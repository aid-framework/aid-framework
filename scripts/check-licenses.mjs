/**
 * Dependency license audit: fails a pull request that adds a dependency whose
 * license is not on the allowlist below.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ALLOWED = new Set([
  '0BSD',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT-0',
  'MPL-2.0', // weak copyleft; devDependency only (lightningcss)
  'Python-2.0',
  'PSF-2.0',
  'Unlicense',
  'WTFPL',
]);

/**
 * @param {string} license
 * @returns {boolean}
 */
function isAllowed(license) {
  const value = license.trim();
  if (ALLOWED.has(value)) return true;

  if (/\sOR\s/i.test(value)) {
    return value.split(/\s+OR\s+/i).every((part) => isAllowed(part.replace(/[()]/g, '')));
  }

  const [base] = value.split(/\s+WITH\s+/i);
  return base !== undefined && ALLOWED.has(base.trim());
}

const result = spawnSync('pnpm licenses list --json', {
  cwd: fileURLToPath(new URL('../', import.meta.url)),
  encoding: 'utf8',
  shell: true,
});

if (result.error !== undefined || result.status !== 0) {
  process.stderr.write(
    `lint:licenses could not run "pnpm licenses list --json".\n` +
      `${result.error?.message ?? result.stderr ?? ''}\n` +
      'Run `pnpm install` first. If the subcommand itself is unavailable in this\n' +
      'pnpm version, report it - the audit must not silently pass.\n',
  );
  process.exit(1);
}

/** @type {Record<string, { name: string, versions?: string[] }[]>} */
let report;
try {
  report = JSON.parse(result.stdout);
} catch {
  process.stderr.write(
    `lint:licenses expected JSON from "pnpm licenses list --json" but got:\n${result.stdout.slice(0, 2000)}\n`,
  );
  process.exit(1);
}

const rejected = [];
let packageCount = 0;

for (const [license, entries] of Object.entries(report)) {
  const names = entries.map((entry) => entry.name).sort();
  packageCount += names.length;
  if (!isAllowed(license)) {
    rejected.push({ license, names });
  }
}

if (rejected.length > 0) {
  for (const { license, names } of rejected) {
    process.stderr.write(`${license}: ${names.join(', ')}\n`);
  }
  process.stderr.write(
    `\n${rejected.length} license(s) are not on the allowlist in scripts/check-licenses.mjs.\n` +
      'Either drop the dependency or add the license to the allowlist in a pull request\n' +
      'that states why it is acceptable.\n',
  );
  process.exit(1);
}

const licenses = Object.keys(report).sort();
process.stdout.write(
  `Checked ${packageCount} package(s) across ${licenses.length} license(s): ${licenses.join(', ')}.\n`,
);
