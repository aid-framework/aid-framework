/**
 * `aid init` scaffolds a project and deliberately does not generate one.
 *
 * The split matters: `init` writes the two files a person is expected to edit, and `gen`
 * writes the files they are not. A `--from` spec is validated before it is copied, because
 * an imported spec that does not build would otherwise fail later, in a command whose
 * message would point at the wrong file.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import { projectNameFor } from '../src/index.js';
import { aid, diagnosticsOf, EXAMPLE_SPEC, emptyProject, project, SPEC_PATH } from './helpers.js';

const created: ReturnType<typeof project>[] = [];

/** A scratch directory with nothing in it, which is what `init` is normally pointed at. */
function scratch() {
  const made = emptyProject();
  created.push(made);
  return made;
}

/** A scratch directory holding a spec, for the paths that have to cope with one. */
function withSpec(specText: string = EXAMPLE_SPEC) {
  const made = project(specText);
  created.push(made);
  return made;
}

/** A spec in a directory of its own, for `--from` to import. */
function source(): string {
  return join(withSpec().root, ...SPEC_PATH.split('/'));
}

afterAll(() => {
  for (const made of created) made.close();
});

describe('projectNameFor', () => {
  it('derives a schema-valid name from a directory path', () => {
    expect(projectNameFor('/tmp/Support Copilot')).toBe('support-copilot');
    expect(projectNameFor('My_App.v2')).toBe('my-app-v2');
    expect(projectNameFor('9lives')).toBe('app-9lives');
    expect(projectNameFor('/tmp/ä')).toBe('app');
  });

  it('always satisfies the schema pattern', () => {
    for (const input of ['/tmp/x', 'A', '---', 'a'.repeat(200), '']) {
      expect(projectNameFor(input)).toMatch(/^[a-z][a-z0-9-]{0,63}$/);
    }
  });
});

describe('aid init', () => {
  it('writes a starter spec and a README, and generates nothing', () => {
    const made = scratch();
    const run = aid(made, ['init', '.', '--json']);
    expect(run.code).toBe(0);

    const report = run.json<{ written: string[]; skipped: string[]; generation: unknown }>();
    // `generation: null` is how the report says `init` stopped at scaffolding; `written`
    // names what is on the tree afterwards, which is the claim a reader can check.
    expect(report.generation).toBeNull();
    expect(report.written).toContain(SPEC_PATH);
    expect(report.written).toContain('README.md');
    expect(made.exists(SPEC_PATH)).toBe(true);
    expect(made.exists('README.md')).toBe(true);
    expect(made.exists('app/generated')).toBe(false);
    // The starter spec must itself be valid, or `init` hands the user a broken repo.
    expect(aid(made, ['validate']).code).toBe(0);
  });

  it('creates the directory it was pointed at', () => {
    const made = scratch();
    const run = aid(made, ['init', 'services/orders']);
    expect(run.code).toBe(0);
    expect(made.exists('services/orders/app/app.spec.yaml')).toBe(true);
    expect(made.exists('services/orders/README.md')).toBe(true);
  });

  it('refuses to overwrite an existing spec without --force', () => {
    const made = withSpec();
    const original = made.read(SPEC_PATH);
    const run = aid(made, ['init', '.', '--json']);

    expect(run.code).toBe(1);
    expect(diagnosticsOf(run)[0]?.code).toBe('cli/refusing-to-overwrite');
    expect(made.read(SPEC_PATH)).toBe(original);
  });

  it('overwrites with --force', () => {
    const made = withSpec('# not a spec\n');
    expect(aid(made, ['init', '.', '--force']).code).toBe(0);
    expect(made.read(SPEC_PATH)).toContain('specVersion');
  });

  it('keeps an existing README, under --force too', () => {
    // The README is the one file written here whose contents are the caller's. `--force`
    // is passed routinely just to reset the spec; destroying prose as a side effect of
    // that is not what it was asked for.
    const made = withSpec();
    made.write('README.md', '# mine\n');
    const report = aid(made, ['init', '.', '--force', '--json']).json<{ skipped: string[] }>();
    expect(made.read('README.md')).toBe('# mine\n');
    expect(report.skipped).toContain('README.md');
  });

  it('imports an existing spec with --from, verbatim and without generating', () => {
    const made = scratch();
    const run = aid(made, ['init', '.', '--from', source(), '--json']);

    expect(run.code).toBe(0);
    // Verbatim, not re-serialised: an import that reformats the spec makes the first diff
    // of a new project the tool's formatting choices rather than the project's content.
    expect(made.read(SPEC_PATH)).toBe(EXAMPLE_SPEC);
    expect(made.exists('app/generated')).toBe(false);
  });

  it('rejects a --from spec that does not validate, and writes nothing', () => {
    const made = scratch();
    const bad = withSpec('specVersion: "0.1"\nproject:\n  name: demo\n  nope: 1\n');

    const run = aid(made, [
      'init',
      '.',
      '--from',
      join(bad.root, ...SPEC_PATH.split('/')),
      '--json',
    ]);
    expect(run.code).toBe(1);
    expect(diagnosticsOf(run).length).toBeGreaterThan(0);
    expect(made.exists(SPEC_PATH)).toBe(false);
  });

  it('reports a --from path that does not exist', () => {
    const made = scratch();
    const run = aid(made, ['init', '.', '--from', 'nope.yaml', '--json']);
    expect(run.code).toBe(1);
    expect(diagnosticsOf(run)[0]?.code).toBe('cli/spec-unreadable');
  });

  it('generates on request with --gen', () => {
    const made = scratch();
    const run = aid(made, ['init', '.', '--gen']);
    expect(run.code).toBe(0);
    expect(existsSync(join(made.root, 'app', 'generated'))).toBe(true);
  });

  it('honours --target and rejects an unknown one', () => {
    expect(aid(scratch(), ['init', '.', '--target', 'py-fastapi', '--json']).code).toBe(0);
    expect(
      diagnosticsOf(aid(scratch(), ['init', '.', '--target', 'rust', '--json']))[0]?.code,
    ).toBe('cli/unknown-target');
  });
});
