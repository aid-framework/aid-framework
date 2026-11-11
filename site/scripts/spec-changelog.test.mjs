/**
 * Holds the spec version changelog to the enum it documents.
 *
 * The schema enum is what `aid validate` accepts and what the support page reads, so the
 * changelog's list has to match it exactly -- including order -- and every entry has to say
 * something. The reference row is checked too: moving 24 versions into a page is only an
 * improvement if the table cell stops rendering them.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SPEC_VERSIONS } from './spec-changelog-data.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/**
 * @param {string} repositoryPath
 * @returns {string}
 */
function read(repositoryPath) {
  return readFileSync(join(repoRoot, ...repositoryPath.split('/')), 'utf8');
}

const schema = JSON.parse(read('packages/spec/src/schema/spec.schema.json'));

describe('the spec version changelog', () => {
  it('lists exactly the versions the schema enum accepts, in order', () => {
    expect(SPEC_VERSIONS.map((entry) => entry.version)).toEqual(schema.properties.specVersion.enum);
  });

  it('states what each version adds', () => {
    for (const entry of SPEC_VERSIONS) {
      expect(typeof entry.adds, `\`${entry.version}\` has no description`).toBe('string');
      expect(
        entry.adds.trim().length,
        `\`${entry.version}\` has an empty description`,
      ).toBeGreaterThan(0);
    }
  });

  it('keeps the version history off the spec reference row', () => {
    const page = read('docs/reference/spec.md');
    const row = page.split('\n').find((line) => line.startsWith('| `specVersion` |'));
    expect(row, 'the spec reference has no `specVersion` row').toBeDefined();
    expect(row).not.toContain('0.24');
    expect(row).toContain('spec-changelog');
    expect(page).toContain('[spec version changelog](./spec-changelog.md)');
  });

  it('renders one table row per version, newest first', () => {
    const page = read('docs/reference/spec-changelog.md');
    const rows = [...page.matchAll(/^\| `([0-9]+\.[0-9]+)` \|/gm)].map((match) => match[1]);
    expect(rows).toEqual([...SPEC_VERSIONS].map((entry) => entry.version).reverse());
    expect(rows[0]).toBe('0.28');
    expect(rows[rows.length - 1]).toBe('0.1');
  });
});
