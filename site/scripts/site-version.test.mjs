/**
 * Tests for the version the site reports.
 *
 * The property that matters is that the footer and the homepage name a version a consumer
 * can install, which is the one the shipped manifests declare -- not the newest tag, since
 * `v0.1.40`-`v0.1.43` exist without a release. The real `release.config.json` and the real
 * manifests are read rather than fixtures, so a hand-edited bump has to face these
 * assertions, and the homepage is checked for a hardcoded version coming back.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { currentVersion } from './site-version.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/**
 * @param {{ path: string, registry: string }} entry
 * @returns {string} the version the manifest declares
 */
function manifestVersion(entry) {
  const directory = join(repoRoot, ...entry.path.split('/'));
  if (entry.registry === 'npm') {
    return JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).version;
  }
  const project = readFileSync(join(directory, 'pyproject.toml'), 'utf8');
  const match = /^version\s*=\s*"([^"]*)"/m.exec(project);
  if (match === null) throw new Error(`${entry.path}/pyproject.toml declares no version`);
  return match[1] ?? '';
}

const config = JSON.parse(readFileSync(join(repoRoot, 'release.config.json'), 'utf8'));

describe('the version the site reports', () => {
  it('is the one every shipped manifest declares', () => {
    const declared = config.packages.map((entry) => manifestVersion(entry));
    expect(new Set(declared).size).toBe(1);
    expect(currentVersion()).toBe(`${config.tagPrefix}${declared[0]}`);
  });

  it('is stated by the homepage through the token, not hardcoded', () => {
    const homepage = readFileSync(join(repoRoot, 'docs', 'index.md'), 'utf8');
    expect(homepage).toContain('{{ AID_VERSION }}');
    expect(homepage).not.toMatch(/at version \*\*\d+\.\d+\.\d+\*\*/);
  });

  it('names the current spec language version on the homepage', () => {
    // The newest version is the last entry of the array the validator reads, not a
    // hand-maintained constant: the constant was `0.6` while the build already read `0.8`.
    const source = readFileSync(join(repoRoot, 'packages', 'spec', 'src', 'validate.ts'), 'utf8');
    const block = /SUPPORTED_SPEC_VERSIONS = \[([\s\S]*?)\] as const;/.exec(source)?.[1] ?? '';
    const versions = [...block.matchAll(/'([0-9]+\.[0-9]+)'/g)].map((match) => match[1]);
    expect(versions.length).toBeGreaterThan(0);
    const latest = versions[versions.length - 1];
    const homepage = readFileSync(join(repoRoot, 'docs', 'index.md'), 'utf8');
    expect(homepage).toContain(`\`${latest}\``);
  });
});
