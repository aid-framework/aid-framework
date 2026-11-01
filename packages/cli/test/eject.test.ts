/**
 * `aid eject` end to end: the ownership transfer has to hold across the commands that
 * read the tree, not just in the command that performed it.
 *
 * The assertions that matter are about the *next* run. A manifest entry that `aid gen`
 * ignores would look correct in an eject test and still recreate the file a second later,
 * so every positive case here regenerates and re-diagnoses afterwards.
 */

import { afterAll, describe, expect, it } from 'vitest';

import { aid, cloneExample, diagnosticsOf, project, SPEC_PATH } from './helpers.js';

const created: ReturnType<typeof project>[] = [];

function scratch() {
  const made = project();
  created.push(made);
  return made;
}

afterAll(() => {
  for (const made of created) made.close();
});

/** A generated file with no business counterpart, so the move has a clear destination. */
const GENERATED = 'app/generated/observability.py';
const BUSINESS = 'app/business/observability.py';

describe('aid eject', () => {
  it('moves the file, excludes it from generation, and leaves doctor green', () => {
    const made = scratch();
    expect(aid(made, ['gen']).code).toBe(0);
    const before = made.read(GENERATED);

    const ejected = aid(made, ['eject', GENERATED]);
    expect(ejected.code).toBe(0);
    expect(made.exists(GENERATED)).toBe(false);
    expect(made.read(BUSINESS)).toBe(before);

    // The next generation must not resurrect the file. This is the reason the ledger
    // exists, and asserting it on the CLI (rather than only in the SDK test) is what
    // proves `gen` actually consults it.
    const regen = aid(made, ['gen']);
    expect(regen.code).toBe(0);
    expect(made.exists(GENERATED)).toBe(false);
    expect(made.read(BUSINESS)).toBe(before);

    const report = aid(made, ['gen', '--dry-run', '--json']).json<{
      changes: { ejected: string[]; created: string[] };
    }>();
    expect(report.changes.ejected).toEqual([GENERATED]);
    expect(report.changes.created).toEqual([]);

    expect(aid(made, ['doctor']).code).toBe(0);
  });

  it('writes nothing on --dry-run, and says what it would do', () => {
    const made = scratch();
    expect(aid(made, ['gen']).code).toBe(0);
    const before = made.snapshot();

    const run = aid(made, ['eject', GENERATED, '--dry-run']);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('would eject');
    expect(made.snapshot()).toEqual(before);
  });

  it('is a no-op for a file the developer already owns', () => {
    const made = scratch();
    expect(aid(made, ['gen']).code).toBe(0);
    expect(aid(made, ['eject', GENERATED]).code).toBe(0);

    const again = aid(made, ['eject', BUSINESS]);

    expect(again.code).toBe(0);
    expect(again.stdout).toContain('already developer-owned');
  });

  it('refuses a path outside every managed root as a usage error', () => {
    const made = scratch();

    const run = aid(made, ['eject', SPEC_PATH, '--json']);

    expect(run.code).toBe(2);
    expect(diagnosticsOf(run)[0]?.code).toBe('cli/eject-unmanaged-path');
  });

  it('fails when the recorded file is gone, rather than manufacturing one', () => {
    const made = scratch();
    expect(aid(made, ['gen']).code).toBe(0);
    made.remove(GENERATED);

    const run = aid(made, ['eject', GENERATED, '--json']);

    expect(run.code).toBe(1);
    expect(diagnosticsOf(run)[0]?.code).toBe('generator/eject-missing-file');
    expect(made.exists(BUSINESS)).toBe(false);
  });

  it('refuses to overwrite a business file with different content', () => {
    const made = scratch();
    expect(aid(made, ['gen']).code).toBe(0);
    made.write(BUSINESS, '# written by hand\n');

    const run = aid(made, ['eject', GENERATED, '--json']);

    expect(run.code).toBe(1);
    expect(diagnosticsOf(run)[0]?.code).toBe('generator/eject-destination-exists');
    expect(made.read(BUSINESS)).toBe('# written by hand\n');
    expect(made.exists(GENERATED)).toBe(true);
  });
});

describe('aid eject — infra', () => {
  it('recognizes infra/generated and stops the emitter from rewriting that file', () => {
    const made = cloneExample();
    created.push(made);
    expect(aid(made, ['infra', 'gen']).code).toBe(0);

    const generated = 'infra/generated/README.md';
    const business = 'infra/business/README.md';
    const before = made.read(generated);

    expect(aid(made, ['eject', generated]).code).toBe(0);
    expect(made.exists(generated)).toBe(false);
    expect(made.read(business)).toBe(before);

    expect(aid(made, ['infra', 'gen']).code).toBe(0);
    expect(made.exists(generated)).toBe(false);
    expect(made.read(business)).toBe(before);
  });
});
