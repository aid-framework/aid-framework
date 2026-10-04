/**
 * Tests for the release gate. The property that matters is that a docs-only or
 * CI-only merge cannot cut a release while a mixed docs+code merge does. The real
 * `release.config.json` is imported rather than a copy, so a rule change there has
 * to face these assertions.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  decide,
  formatVersion,
  isReleasable,
  latestReleaseTag,
  matchingRule,
  nextVersion,
  packageFor,
  parseConfig,
  parseVersionTag,
} from './version.mjs';

const root = new URL('../', import.meta.url);
const config = parseConfig(
  JSON.parse(readFileSync(fileURLToPath(new URL('release.config.json', root)), 'utf8')),
);

/**
 * Convenience: run the real gate over a set of changed paths.
 *
 * @param {string[]} changedPaths
 * @param {{ tags?: string[], force?: boolean, cfg?: ReturnType<typeof parseConfig> }} [options]
 * @returns {ReturnType<typeof decide>}
 */
function decideFor(changedPaths, { tags = [], force = false, cfg = config } = {}) {
  return decide({ tags, changedPaths, force, config: cfg });
}

describe('the committed release config', () => {
  it('is repo-wide with a patch bump and a bootstrap version', () => {
    expect(config.mode).toBe('repo-wide');
    expect(config.bump).toBe('patch');
    expect(config.bootstrapVersion).toBe('0.1.0');
    expect(config.tagPrefix).toBe('v');
  });

  it('has a reason for every non-releasable rule', () => {
    expect(config.nonReleasable.length).toBeGreaterThan(0);
    for (const rule of config.nonReleasable) {
      expect(rule.reason, `rule ${rule.pattern} has no reason`).not.toBe('');
    }
  });
});

describe('the first release', () => {
  it('bootstraps to v0.1.0 when no tags exist', () => {
    const decision = decideFor(['packages/spec/package.json']);

    expect(decision.release).toBe(true);
    expect(decision.version).toBe('v0.1.0');
    expect(decision.tag).toBe('v0.1.0');
    expect(decision.currentVersion).toBeNull();
  });

  it('increments the patch from the greatest existing tag', () => {
    const decision = decideFor(['packages/spec/src/index.ts'], {
      tags: ['v0.1.0', 'v0.1.1', 'v0.3.0', 'not-a-release'],
    });

    expect(decision.version).toBe('v0.3.1');
    expect(decision.currentVersion).toBe('v0.3.0');
  });

  it('bootstraps even though the repository has non-release tags', () => {
    expect(
      decideFor(['runtimes/python/aid_runtime/__init__.py'], { tags: ['nightly'] }).version,
    ).toBe('v0.1.0');
  });
});

describe('path-based release gating', () => {
  it('does not release for a docs-only change', () => {
    const decision = decideFor(['docs/design.md']);

    expect(decision.release).toBe(false);
    expect(decision.version).toBeNull();
    expect(decision.tag).toBeNull();
    expect(decision.reason).toBe('no releasable paths changed');
  });

  it('does not release for a CI-only change', () => {
    const decision = decideFor(['.github/workflows/ci.yml', '.github/CODEOWNERS']);

    expect(decision.release).toBe(false);
  });

  it('does not release for a repository-hygiene-only change', () => {
    const decision = decideFor([
      'README.md',
      'CONTRIBUTING.md',
      '.gitignore',
      '.editorconfig',
      '.nvmrc',
      '.gitattributes',
    ]);

    expect(decision.release).toBe(false);
  });

  it('releases when a single PR contains both docs and code', () => {
    const decision = decideFor(['docs/design.md', 'README.md', 'packages/spec/src/parse.ts']);

    expect(decision.release).toBe(true);
    expect(decision.releasablePaths).toEqual(['packages/spec/src/parse.ts']);
    expect(decision.reason).toContain('1 releasable path');
  });

  it('releases for runtime and generator changes', () => {
    for (const path of [
      'runtimes/python/pyproject.toml',
      'packages/generators/py-fastapi/src/emit.ts',
      'packages/ir/src/build.ts',
      'scripts/version.mjs',
      'pnpm-lock.yaml',
    ]) {
      expect(decideFor([path]).release, `${path} should release`).toBe(true);
    }
  });

  it('treats a package README as releasable while a root README is not', () => {
    expect(decideFor(['README.md']).release).toBe(false);
    expect(decideFor(['packages/spec/README.md']).release).toBe(true);
  });

  it('records which rule suppressed a path', () => {
    const rule = matchingRule('docs/design.md', config.nonReleasable);
    expect(rule?.pattern).toBe('^docs/');
    expect(rule?.reason).not.toBe('');
    expect(isReleasable('docs/design.md', config.nonReleasable)).toBe(false);
    expect(isReleasable('packages/spec/src/index.ts', config.nonReleasable)).toBe(true);
  });

  it('releases nothing when no paths changed at all', () => {
    const decision = decideFor([]);
    expect(decision.release).toBe(false);
    expect(decision.changedPaths).toEqual([]);
  });
});

describe('forcing a release', () => {
  it('releases a docs-only change when forced', () => {
    const decision = decideFor(['docs/design.md'], { force: true, tags: ['v0.1.0'] });

    expect(decision.release).toBe(true);
    expect(decision.forced).toBe(true);
    expect(decision.version).toBe('v0.1.1');
    expect(decision.reason).toContain('forced');
  });

  it('ignores the flag when there is nothing to release and no force', () => {
    expect(decideFor(['docs/design.md'], { force: false }).forced).toBe(false);
  });

  it('is not "forced" when a releasable path is present anyway', () => {
    const decision = decideFor(['docs/design.md', 'packages/spec/src/index.ts'], { force: true });
    expect(decision.release).toBe(true);
    expect(decision.forced).toBe(false);
  });
});

describe('version arithmetic', () => {
  it('parses only tags that match the prefix', () => {
    expect(parseVersionTag('v1.2.3', 'v')).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseVersionTag('@aid/spec@0.1.0', 'v')).toBeNull();
    expect(parseVersionTag('v1.2', 'v')).toBeNull();
    expect(parseVersionTag('v1.2.3-rc.1', 'v')).toBeNull();
    expect(parseVersionTag('1.2.3', 'v')).toBeNull();
  });

  it('formats a version back to text', () => {
    expect(formatVersion({ major: 2, minor: 10, patch: 0 })).toBe('2.10.0');
  });

  it('compares numerically, not lexically', () => {
    expect(
      compareVersions({ major: 0, minor: 10, patch: 0 }, { major: 0, minor: 9, patch: 9 }),
    ).toBe(1);
    expect(
      compareVersions({ major: 1, minor: 0, patch: 0 }, { major: 1, minor: 0, patch: 0 }),
    ).toBe(0);
    expect(
      compareVersions({ major: 0, minor: 0, patch: 1 }, { major: 0, minor: 1, patch: 0 }),
    ).toBe(-1);
  });

  it('picks the greatest release tag and ignores everything else', () => {
    expect(latestReleaseTag(['v0.1.0', 'v0.10.0', 'v0.9.0'], 'v')).toBe('v0.10.0');
    expect(latestReleaseTag(['v0.1.0', '@aid/spec@9.9.9'], 'v')).toBe('v0.1.0');
    expect(latestReleaseTag([], 'v')).toBeNull();
    expect(latestReleaseTag(['nope'], 'v')).toBeNull();
  });

  it('bootstraps rather than guessing when the latest tag is unparseable', () => {
    expect(nextVersion(null, config)).toBe('v0.1.0');
    expect(nextVersion('garbage', config)).toBe('v0.1.0');
    expect(nextVersion('v0.0.0', config)).toBe('v0.0.1');
  });
});

describe('config validation', () => {
  it('rejects an unknown mode', () => {
    expect(() => parseConfig({ ...baseConfig(), mode: 'per-file' })).toThrow(/mode/);
  });

  it('rejects a bump other than patch', () => {
    expect(() => parseConfig({ ...baseConfig(), bump: 'minor' })).toThrow(/bump/);
  });

  it('rejects a malformed bootstrap version', () => {
    expect(() => parseConfig({ ...baseConfig(), bootstrapVersion: 'one' })).toThrow(
      /bootstrapVersion/,
    );
  });

  it('rejects a non-regex rule', () => {
    expect(() => parseConfig({ ...baseConfig(), nonReleasable: [{ pattern: '[' }] })).toThrow(
      /regular expression/,
    );
  });

  it('rejects a non-array packages table', () => {
    expect(() => parseConfig({ ...baseConfig(), packages: {} })).toThrow(/packages/);
  });
});

describe('per-package mode (kept working for a later switch)', () => {
  const independent = parseConfig({
    ...baseConfig(),
    mode: 'independent',
    packages: [
      { name: '@aid/ir', path: 'packages/ir', registry: 'npm' },
      { name: '@aid/spec', path: 'packages/spec', registry: 'npm' },
    ],
  });

  it('releases one tagged version per changed package, sorted by name', () => {
    const decision = decideFor(['packages/ir/src/build.ts', 'packages/spec/src/index.ts'], {
      cfg: independent,
    });

    expect(decision.release).toBe(true);
    expect(decision.version).toBeNull();
    expect(decision.packages?.map((entry) => entry.tag)).toEqual([
      '@aid/ir@0.1.0',
      '@aid/spec@0.1.0',
    ]);
  });

  it('increments each package independently', () => {
    const decision = decideFor(['packages/spec/src/index.ts'], {
      cfg: independent,
      tags: ['@aid/spec@0.4.2', '@aid/ir@0.1.0'],
    });

    expect(decision.packages).toHaveLength(1);
    expect(decision.packages?.[0]?.tag).toBe('@aid/spec@0.4.3');
    expect(decision.packages?.[0]?.previousVersion).toBe('0.4.2');
  });

  it('fails loudly when a releasable path belongs to no package', () => {
    expect(() => decideFor(['runtimes/python/main.py'], { cfg: independent })).toThrow(
      /no packages\[\] entry covers/,
    );
  });

  it('matches package paths on a boundary, not a prefix', () => {
    expect(packageFor('packages/spec/src/a.ts', independent.packages)?.name).toBe('@aid/spec');
    expect(packageFor('packages/spec-extra/src/a.ts', independent.packages)).toBeNull();
  });
});

describe('the command line release.yml calls', () => {
  const script = fileURLToPath(new URL('version.mjs', import.meta.url));
  const configPath = fileURLToPath(new URL('release.config.json', root));

  /**
   * Runs version.mjs exactly as release.yml does, through the file flags.
   *
   * @param {string | null} name
   * @param {{ tags?: string[], changed?: string[] }} [input]
   * @returns {{ status: number | null, stdout: string, release: string, version: string, tag: string, reason: string }}
   */
  function runCli(name, { tags = [], changed = [] } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'aid-version-'));
    const tagsFile = join(dir, 'tags.txt');
    const changedFile = join(dir, 'changed.txt');
    const outputFile = join(dir, 'out.txt');
    writeFileSync(tagsFile, tags.join('\n'));
    writeFileSync(changedFile, changed.join('\n'));

    const argv = [
      ...(name === null ? [] : [name]),
      '--config',
      configPath,
      '--tags-file',
      tagsFile,
      '--changed-files-file',
      changedFile,
      '--github-output',
      outputFile,
    ];
    const result = spawnSync(process.execPath, [script, ...argv], { encoding: 'utf8' });

    /** @param {string} key */
    const readOutput = (key) => {
      if (!existsSync(outputFile)) return '';
      const line = readFileSync(outputFile, 'utf8')
        .split('\n')
        .find((entry) => entry.startsWith(`${key}=`));
      return line === undefined ? '' : line.slice(key.length + 1);
    };

    const run = {
      status: result.status,
      stdout: result.stdout ?? '',
      release: readOutput('release'),
      version: readOutput('version'),
      tag: readOutput('tag'),
      reason: readOutput('reason'),
    };

    rmSync(dir, { recursive: true, force: true });
    return run;
  }

  it('accepts the explicit decide subcommand the workflow passes', () => {
    const result = runCli('decide', { changed: ['packages/spec/src/parse.ts'] });

    expect(result.status).toBe(0);
    expect(result.release).toBe('true');
    expect(result.tag).toBe('v0.1.0');
    expect(result.reason).not.toBe('');
  });

  it('accepts an implicit decide subcommand', () => {
    const result = runCli(null, { changed: ['packages/spec/src/parse.ts'] });

    expect(result.status).toBe(0);
    expect(result.release).toBe('true');
  });

  it('writes release=false rather than omitting the key', () => {
    const result = runCli('decide', { tags: ['v0.1.0'], changed: ['docs/design.md'] });

    expect(result.status).toBe(0);
    expect(result.release).toBe('false');
    expect(result.tag).toBe('');
  });

  it('prints the latest tag for the latest subcommand', () => {
    const result = runCli('latest', { tags: ['v0.1.0', 'v0.2.3', 'nightly'] });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('v0.2.3');
  });

  it('resolves the base range for the first ever release', () => {
    const result = runCli('latest', { tags: [] });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it('exits non-zero on an unknown option', () => {
    const broken = spawnSync(
      process.execPath,
      [script, 'decide', '--config', configPath, '--nope', 'x'],
      { encoding: 'utf8' },
    );
    expect(broken.status).not.toBe(0);
  });
});

function baseConfig() {
  return {
    mode: 'repo-wide',
    tagPrefix: 'v',
    bump: 'patch',
    bootstrapVersion: '0.1.0',
    nonReleasable: [{ pattern: '^docs/', reason: 'documentation only' }],
    packages: [],
  };
}
