/**
 * Where a generator's declared version comes from.
 *
 * `GeneratorManifestInput.version` is stamped into every generated file's banner, into
 * `aid.manifest.json`'s `generatedBy.generatorVersion` and into every file entry, and it
 * is what `aid doctor` compares to detect a tree written by a different generator release.
 * A generator therefore has to report the version of the package that is actually running,
 * not a number a human keeps in step by hand.
 *
 * It used to be a literal. Both targets declared `version: '0.1.0'` in the first commit and
 * neither was ever touched again while the packages went on to 0.1.199, which had three
 * consequences that were all silent: every generated banner named a generator that shipped
 * two years earlier, `cliRangeFor` pinned `@aid-framework/cli@0.1` in scaffolded workflows
 * forever, and `aid doctor`'s generator-drift check could not fire because both sides of the
 * comparison came from the same frozen literal. Reading the version from the package that
 * ships the module removes the literal, so it cannot drift again.
 */

import { existsSync, readFileSync } from 'node:fs';

import { isValidVersion } from './semver.js';

/** `src/` and `dist/` are the only two directories a compiled module can be running from. */
const MAX_WALK_DEPTH = 2;

/**
 * The `version` of the package owning `moduleUrl`, read from its nearest `package.json`.
 *
 * The walk upward, rather than a fixed `../package.json`, is what makes this work from both
 * trees a module can live in: `dist/manifest.js` under normal use and `src/manifest.ts` under
 * vitest. Both are one level below the package root.
 *
 * Throws when no readable, valid-semver manifest is found. A published package always ships
 * its own `package.json`, so a miss is a packaging error rather than a runtime condition a
 * caller could recover from, and a version that failed validation is not something to paper
 * over with a fallback: `aid doctor` would then compare against a number that means nothing.
 */
export function packageVersion(moduleUrl: string): string {
  let directory = new URL('.', moduleUrl);

  for (let depth = 0; depth <= MAX_WALK_DEPTH; depth++) {
    const candidate = new URL('package.json', directory);
    if (existsSync(candidate)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(candidate, 'utf8'));
      } catch (cause) {
        throw new Error(`cannot read ${candidate.href}: ${(cause as Error).message}`, { cause });
      }
      const version =
        typeof parsed === 'object' && parsed !== null
          ? (parsed as { version?: unknown }).version
          : undefined;
      if (typeof version !== 'string' || !isValidVersion(version)) {
        throw new Error(`${candidate.href} does not declare a valid semver "version"`);
      }
      return version;
    }
    directory = new URL('../', directory);
  }

  throw new Error(
    `no package.json within ${MAX_WALK_DEPTH + 1} levels of ${moduleUrl}; a published package ships its own manifest next to its build output`,
  );
}
