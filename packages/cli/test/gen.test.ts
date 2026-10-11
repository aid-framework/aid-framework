/**
 * The generation contract: `aid gen` is a function of the spec.
 *
 * Three properties are asserted here because they are promises the README and the design
 * make, not implementation details:
 *
 * 1. Generating twice produces the same bytes, from a clean tree and from a tree that was
 *    deleted first. A generator whose output depends on what is already there cannot be
 *    reviewed in a diff.
 * 2. `--dry-run` writes nothing. Asserted against a whole-tree listing rather than a
 *    file-by-file check, so a *new* file appearing in a dry run fails the test too.
 * 3. A hand-edited generated file is never overwritten: the run refuses, keeps the
 *    rejected bytes beside the file, and exits non-zero. A hand-edited *business* file is
 *    untouched and does not fail the run, because business files are the caller's.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { aid, cloneExample, EXAMPLE_ROOT, isBuildArtifact, project, SPEC_PATH } from './helpers.js';

const created: ReturnType<typeof project>[] = [];

function scratch() {
  const made = project();
  created.push(made);
  return made;
}

/** Committed paths under `dir`, relative and POSIX-separated. */
function walkCommitted(dir: string, base = dir): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (isBuildArtifact(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walkCommitted(full, base));
    else found.push(relative(base, full).split(sep).join('/'));
  }
  return found.sort();
}

afterAll(() => {
  for (const made of created) made.close();
});

/** A generated file with a stable name, used as the edit target. */
const GENERATED = 'app/generated/observability.py';
const BUSINESS = 'app/business/tools/lookup_customer.py';

describe('aid gen', () => {
  it('reproduces the committed example generated tree byte-for-byte from the spec alone', () => {
    const made = scratch();
    expect(aid(made, ['gen']).code).toBe(0);

    const snapshot = made.snapshot();
    const generated = Object.keys(snapshot).filter((path) => path.startsWith('app/generated/'));
    // Every generated file, and only those: a file the CLI emitted that the example does
    // not have is as much a failure as a byte that differs, so both directions are
    // asserted against the committed tree.
    const expected = walkCommitted(join(EXAMPLE_ROOT, 'app', 'generated')).map(
      (path) => `app/generated/${path}`,
    );
    expect(expected.length).toBeGreaterThan(0);
    expect(generated.sort()).toEqual(expected);
    for (const path of generated) {
      expect(snapshot[path], path).toBe(readFileSync(join(EXAMPLE_ROOT, path), 'utf8'));
    }
    expect(snapshot[SPEC_PATH]).toBeDefined();
  });

  it('is a byte-identical no-op over the whole committed tree', () => {
    // A copy of the *whole* example -- spec, business, generated and manifest -- because a
    // tree built from the spec alone cannot reproduce the committed manifest: a business
    // record keeps the hash it was first given (`generator-sdk/src/drift.ts`), and the
    // committed manifest carries the hash of the template that created the file, before a
    // human edited it. Regenerating a copy of the tree in place is therefore the run whose
    // output must be identical, and it is also the run `pnpm generate:example` performs.
    const made = cloneExample();
    created.push(made);
    const before = made.snapshot();

    const run = aid(made, ['gen', '--json']);
    expect(run.code).toBe(0);
    const changes = run.json<{ changes: { created: string[]; updated: string[] } }>().changes;
    expect(changes.created).toEqual([]);
    expect(changes.updated).toEqual([]);
    expect(made.snapshot()).toEqual(before);
  });

  it('is a no-op the second time, and reports everything unchanged', () => {
    const made = scratch();
    aid(made, ['gen']);
    const before = made.snapshot();

    const second = aid(made, ['gen', '--json']);
    expect(second.code).toBe(0);
    const changes = second.json<{
      changes: { created: string[]; updated: string[]; unchanged: string[] };
    }>().changes;
    expect(changes.created).toEqual([]);
    expect(changes.updated).toEqual([]);
    expect(changes.unchanged.length).toBeGreaterThan(0);
    expect(made.snapshot()).toEqual(before);
  });

  it('produces identical bytes when the generated tree is deleted first', () => {
    const made = scratch();
    aid(made, ['gen']);
    const first = made.snapshot();

    // The deleted state is the case a stale manifest would get wrong: regenerating over
    // an existing manifest can hide a file the plan no longer emits.
    for (const path of Object.keys(first)) {
      if (path.startsWith('app/generated/') || path === 'app/aid.manifest.json') {
        made.remove(path);
      }
    }
    expect(aid(made, ['gen']).code).toBe(0);

    // The manifest is provenance, not payload: compare the generated bytes it describes.
    const regenerated = made.snapshot();
    for (const path of Object.keys(first)) {
      if (path.startsWith('app/generated/')) expect(regenerated[path], path).toBe(first[path]);
    }
  });

  it('writes nothing on --dry-run', () => {
    const made = scratch();
    const before = made.walk();

    const run = aid(made, ['gen', '--dry-run', '--json']);
    expect(run.code).toBe(0);
    expect(run.json<{ dryRun: boolean }>().dryRun).toBe(true);
    // The whole tree, so a dry run that created a file it did not report still fails.
    expect(made.walk()).toEqual(before);
    expect(made.walk()).toEqual([SPEC_PATH]);
  });

  it('refuses to overwrite an edited generated file, and keeps the new bytes beside it', () => {
    const made = scratch();
    aid(made, ['gen']);
    const original = made.read(GENERATED);
    const edited = `${original}\n# hand-edited\n`;
    made.write(GENERATED, edited);

    const run = aid(made, ['gen', '--json']);
    expect(run.code).toBe(1);
    // The edit survives, the rejected content is beside it, and the report says which
    // file it was -- all three, because any one alone is a confusing half-answer.
    expect(made.read(GENERATED)).toBe(edited);
    expect(made.exists(`${GENERATED}.aid-rej`)).toBe(true);
    expect(made.read(`${GENERATED}.aid-rej`)).toBe(original);
    expect(run.json<{ changes: { conflicts: string[] } }>().changes.conflicts).toContain(GENERATED);
  });

  it('reports drift on --dry-run without writing a rejection file', () => {
    const made = scratch();
    aid(made, ['gen']);
    made.write(GENERATED, '# hand-edited\n');
    const before = made.walk();

    const json = aid(made, ['gen', '--dry-run', '--json']);
    expect(json.code).toBe(1);
    expect(json.json<{ changes: { conflicts: string[] } }>().changes.conflicts).toContain(
      GENERATED,
    );

    // The human rendering says what *would* happen, because a dry run that promises a
    // refusal in the same words as one that performed it is a report that cannot be
    // trusted to describe the state of the tree.
    const plain = aid(made, ['gen', '--dry-run']);
    expect(plain.code).toBe(1);
    expect(plain.stdout).toContain('would refuse to overwrite');
    expect(plain.stdout).toContain(`${GENERATED}.aid-rej`);
    // A dry run that wrote the rejected content would not be dry.
    expect(made.walk()).toEqual(before);
  });

  it('keeps a drifted file in its previous manifest record', () => {
    // A refused run must not record the rejected content as though it had been written:
    // a manifest that claims bytes it did not write turns the next run's drift report
    // into noise about a file nobody touched.
    const made = scratch();
    aid(made, ['gen']);

    const before = JSON.parse(made.read('app/aid.manifest.json')) as {
      files: { path: string; sha256: string }[];
    };
    const recorded = before.files.find((file) => file.path === GENERATED);
    made.write(GENERATED, `${made.read(GENERATED)}\n# hand-edited\n`);
    aid(made, ['gen']);

    const after = JSON.parse(made.read('app/aid.manifest.json')) as {
      files: { path: string; sha256: string }[];
    };
    expect(after.files.find((file) => file.path === GENERATED)).toEqual(recorded);
  });

  it('overwrites the edit with --force, and leaves no rejection behind', () => {
    const made = scratch();
    aid(made, ['gen']);
    const original = made.read(GENERATED);
    made.write(GENERATED, '# handwritten replacement\n');
    made.write(`${GENERATED}.aid-rej`, 'stale rejection\n');

    const run = aid(made, ['gen', '--force']);
    expect(run.code).toBe(0);
    expect(made.read(GENERATED)).toBe(original);
    expect(made.exists(`${GENERATED}.aid-rej`)).toBe(false);
  });

  it('leaves a hand-edited business file alone, byte for byte', () => {
    const made = scratch();
    aid(made, ['gen']);
    const edited = `${made.read(BUSINESS)}\n# the caller owns this file\n`;
    made.write(BUSINESS, edited);

    const run = aid(made, ['gen']);
    expect(run.code).toBe(0);
    expect(made.read(BUSINESS)).toBe(edited);
    expect(made.exists(`${BUSINESS}.aid-rej`)).toBe(false);
  });

  it('creates a business file that is missing rather than reporting drift', () => {
    // A business file is created once and never overwritten. Deleting it is therefore a
    // request to have it back, not a conflict to refuse.
    const made = scratch();
    aid(made, ['gen']);
    made.remove(BUSINESS);

    expect(aid(made, ['gen']).code).toBe(0);
    expect(made.exists(BUSINESS)).toBe(true);
  });

  it('fails on a spec the gates reject, and writes nothing', () => {
    const made = scratch();
    made.setSpec('specVersion: "0.1"\nproject:\n  name: demo\n  nope: 1\n');

    const run = aid(made, ['gen', '--json']);
    expect(run.code).toBe(1);
    expect(made.walk()).toEqual([SPEC_PATH]);
  });

  it('names the spec in the report and the target it generated for', () => {
    const made = scratch();
    const report = aid(made, ['gen', '--json', '--target', 'py-fastapi']).json<{
      spec: string;
      target: string;
      manifest: { path: string; written: boolean };
    }>();
    expect(report.spec).toBe(SPEC_PATH);
    expect(report.target).toBe('py-fastapi');
    expect(report.manifest).toEqual({ path: 'app/aid.manifest.json', written: true });
  });
});
