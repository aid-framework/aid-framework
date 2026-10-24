/**
 * `aid ingest` is a shell around the generated ingest modules, so what is asserted here is
 * the boundary: which argv gets run, which exit code is propagated, and where the line
 * between "you invoked me wrong" (2) and "this project cannot do that" (1) sits.
 *
 * **Why every usage-error test is a conjunction.** Before `ingest` existed the CLI exited
 * 2 for every `ingest` form, because the word fell through to the unknown-command path --
 * so an exit-code-only assertion passes against a CLI that never grew the command at all.
 * Each usage-error test therefore also requires that stderr does *not* say
 * `` unknown command ``. The exit code and the absence of that phrase together are what
 * distinguish "rejected for this reason" from "rejected because the word means nothing".
 *
 * The interpreter is injected, so these tests never run Python. The generated modules are
 * executed for real by the E2E job and by `examples/support-copilot`'s own suite; a unit
 * test that ran them here would be a second, slower copy of that.
 */

import { afterAll, describe, expect, it } from 'vitest';

import type { Run } from './helpers.js';
import { aid, diagnosticsOf, project, recordingSpawn, SPEC_PATH } from './helpers.js';

const created: ReturnType<typeof project>[] = [];

function scratch(specText?: string) {
  const made = project(specText);
  created.push(made);
  return made;
}

/**
 * A project whose spec declares retrievers but which has never been generated, so the
 * ingest modules do not exist yet. The `gen` call is what the tests that need a runnable
 * module add afterwards.
 */
function generated() {
  const made = scratch();
  aid(made, ['gen']);
  return made;
}

afterAll(() => {
  for (const made of created) made.close();
});

/** The listing row the global usage prints, summary included. */
const ROW = /^\s*ingest\s{2,}\S/m;
const SUMMARY = 'index a retriever corpus into the store the spec declares';

/**
 * A usage error that is *this* usage error.
 *
 * Exit 2 alone is what a CLI without the command produces, so the second assertion is
 * the one that carries weight: the phrase `` unknown command `` must be absent from the
 * stderr that explains the rejection.
 */
function expectUsageError(run: Run): void {
  expect(run.code).toBe(2);
  expect(run.stderr).not.toMatch(/unknown command/);
}

describe('aid ingest -- the command exists', () => {
  it('lists ingest as a row with its summary, on stdout', () => {
    // C3: the listing goes to stdout, the exit code is still 2, and the row is a table
    // row rather than a mention -- the summary is what separates the two.
    const run = aid(scratch(), []);
    expect(run.code).toBe(2);
    expect(run.stdout).toContain('Usage: aid <command>');
    expect(run.stdout).toMatch(ROW);
    expect(run.stderr).toBe('');
  });

  it('puts the whole summary on the ingest row', () => {
    // C2: `toContain('ingest')` is satisfied by the pre-L4 CLI's bare error text, so the
    // assertion has to pin the summary to the same line as the name.
    const run = aid(scratch(), []);
    expect(run.stdout).toMatch(new RegExp(`^\\s*ingest\\s{2,}${SUMMARY}\\s*$`, 'm'));
  });

  it('is no longer an unknown command', () => {
    const run = aid(generated(), ['ingest', '--all'], recordingSpawn());
    expect(run.code).toBe(0);
    expect(run.stderr).not.toMatch(/unknown command/);
  });

  it('documents its own flags when asked for help', () => {
    const run = aid(scratch(), ['ingest', '--help']);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('Usage: aid ingest');
    expect(run.stdout).toContain('--retriever');
    expect(run.stdout).toContain('--all');
    expect(run.stdout).toContain('--dry-run');
  });
});

describe('aid ingest -- the flag shape', () => {
  it('rejects `--retriever` together with `--all`', () => {
    // C4. Both say what to ingest, and they disagree, so the invocation is wrong.
    const run = aid(scratch(), ['ingest', '--retriever', 'handbook', '--all', '--json']);
    expectUsageError(run);
    expect(diagnosticsOf(run)[0]?.code).toBe('cli/retriever-conflict');
  });

  it('rejects neither `--retriever` nor `--all`', () => {
    // C5. Ingest has no sensible default: every retriever, or one of several, is a choice
    // only the caller can make.
    const run = aid(scratch(), ['ingest', '--json']);
    expectUsageError(run);
    expect(diagnosticsOf(run)[0]?.code).toBe('cli/retriever-required');
  });

  it('does not let `--dry-run` stand in for `--retriever` or `--all`', () => {
    // `--dry-run` says how to run, not what to run. Asking for a dry run of nothing is
    // still an incomplete invocation, and it must be rejected as one.
    expectUsageError(aid(scratch(), ['ingest', '--dry-run']));
  });

  it('names the declared retriever ids when the id is not one of them', () => {
    // C6. A typo should not require opening the spec to find out what the ids are.
    const run = aid(scratch(), ['ingest', '--retriever', 'zz-not-declared', '--json']);
    expectUsageError(run);

    const [diagnostic] = diagnosticsOf(run);
    expect(diagnostic?.code).toBe('cli/retriever-not-found');
    expect(diagnostic?.message).toContain('zz-not-declared');
    expect(diagnostic?.hint).toContain('handbook');
  });

  it('judges the flag shape before it reads the spec', () => {
    // A contradictory invocation is wrong whether or not the spec is readable; reporting
    // the spec's problem instead would bury the mistake the caller actually made.
    const run = aid(scratch('this: is: not: a: spec'), [
      'ingest',
      '--retriever',
      'handbook',
      '--all',
      '--json',
    ]);
    expectUsageError(run);
    expect(diagnosticsOf(run)[0]?.code).toBe('cli/retriever-conflict');
  });

  it('names the declared ids on the human rendering too', () => {
    // The hint is the line rendered under the message, so a person at a terminal sees the
    // ids without `--json`.
    const run = aid(scratch(), ['ingest', '--retriever', 'zz-not-declared']);
    expectUsageError(run);
    expect(run.stderr).toContain('handbook');
  });

  it('rejects an unknown target as a usage error', () => {
    const run = aid(scratch(), ['ingest', '--all', '--target', 'nope', '--json']);
    expectUsageError(run);
    expect(diagnosticsOf(run)[0]?.code).toBe('cli/unknown-target');
  });
});

describe('aid ingest -- a project that declares no retrievers', () => {
  // The smallest valid spec: no `retrievers:` section, so there is nothing to index.
  const NO_RETRIEVERS = ['specVersion: "0.1"', '', 'project:', '  name: minimal', ''].join('\n');

  it('succeeds over `--all` with an empty result set', () => {
    // C7. A generated app with no retrieval is a legitimate app, so making this fail
    // would force a `--retriever` that cannot exist.
    const run = aid(scratch(NO_RETRIEVERS), ['ingest', '--all', '--json']);
    expect(run.code).toBe(0);
    expect(run.stderr).not.toMatch(/unknown command/);
    expect(run.json<{ results: unknown[] }>().results).toEqual([]);
  });

  it('says so on the human rendering rather than printing an empty line', () => {
    const spawn = recordingSpawn();
    const run = aid(scratch(NO_RETRIEVERS), ['ingest', '--all'], spawn);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('nothing to ingest');
    // Nothing was run: an empty selection must not invoke an interpreter, because there is
    // no module to invoke and probing for one would report a missing interpreter instead.
    expect(spawn.calls).toEqual([]);
  });
});

describe('aid ingest -- running the generated modules', () => {
  it('dispatches the generated ingest module, not a runtime entry point', () => {
    // The ingest module is the only object that knows this corpus's chunking and store, so
    // re-deriving either here would be a second implementation of the runtime's rules.
    const made = generated();
    const spawn = recordingSpawn();

    expect(aid(made, ['ingest', '--all'], spawn).code).toBe(0);
    const dispatched = spawn.calls
      .filter((call) => call.args.includes('-m'))
      .map((call) => call.args.at(-1));
    expect(dispatched).toEqual(['app.generated.retrieval.ingest.handbook']);
  });

  it('runs only the requested retriever', () => {
    const made = generated();
    const spawn = recordingSpawn();
    expect(aid(made, ['ingest', '--retriever', 'handbook'], spawn).code).toBe(0);

    const modules = spawn.calls
      .map((call) => call.args.join(' '))
      .filter((command) => command.includes('generated.retrieval.ingest'));
    expect(modules).toEqual(['-m app.generated.retrieval.ingest.handbook']);
  });

  it('forwards `--dry-run` to the generated module rather than answering it itself', () => {
    // The module owns the chunker, so it also owns what a dry run means: it applies the
    // chunking and reports the counts a real run would write, without opening a store or
    // calling an embedder. A dry run answered here would be a second implementation of
    // those counts, free to drift from the one the module performs.
    const made = generated();
    const spawn = recordingSpawn({ stdout: 'would write 2 documents as 2 chunks\n' });
    const run = aid(made, ['ingest', '--all', '--dry-run'], spawn);

    expect(run.code).toBe(0);
    const invocation = spawn.calls
      .map((call) => call.args.join(' '))
      .filter((command) => command.includes('generated.retrieval.ingest'));
    expect(invocation).toEqual(['-m app.generated.retrieval.ingest.handbook --dry-run']);
    expect(run.stdout.trimEnd()).toBe('would write 2 documents as 2 chunks');
  });

  it('does not pass `--dry-run` when it was not asked for', () => {
    const made = generated();
    const spawn = recordingSpawn();
    aid(made, ['ingest', '--all'], spawn);

    const invocation = spawn.calls
      .map((call) => call.args.join(' '))
      .filter((command) => command.includes('generated.retrieval.ingest'));
    expect(invocation).toEqual(['-m app.generated.retrieval.ingest.handbook']);
  });

  it('probes the interpreter by asking whether it can import the runtime', () => {
    // Existence is the wrong question: a system `python` beside a project virtualenv
    // exists and is the wrong one, and its failure would look like a broken module.
    const made = generated();
    const spawn = recordingSpawn();
    aid(made, ['ingest', '--all'], spawn);

    const probe = spawn.calls.find((call) => call.args.includes('-c'));
    expect(probe?.args.join(' ')).toContain('import aid_runtime');
  });

  it('propagates a module that failed, and surfaces what it said', () => {
    const made = generated();
    const run = aid(
      made,
      ['ingest', '--all', '--json'],
      recordingSpawn({ status: 1, stderr: 'could not read docs/billing.md\n' }),
    );

    expect(run.code).toBe(1);
    expect(run.stderr).toContain('could not read docs/billing.md');
    expect(diagnosticsOf(run)[0]?.code).toBe('cli/runner-warned');
  });

  it('reports what it ran and how it ran it', () => {
    const made = generated();
    const report = aid(made, ['ingest', '--all', '--json'], recordingSpawn()).json<{
      retrievers: string[];
      interpreter: string;
      results: { retriever: string; module: string; status: number }[];
    }>();

    expect(report.retrievers).toEqual(['handbook']);
    expect(report.interpreter).toBeTruthy();
    expect(report.results).toEqual([
      {
        retriever: 'handbook',
        module: 'app.generated.retrieval.ingest.handbook',
        status: 0,
      },
    ]);
  });

  it("prints the module's own report without inventing a heading for one retriever", () => {
    const made = generated();
    const run = aid(
      made,
      ['ingest', '--all'],
      recordingSpawn({ stdout: 'wrote 3 of 3 chunks from 2 documents\n' }),
    );
    expect(run.stdout.trimEnd()).toBe('wrote 3 of 3 chunks from 2 documents');
  });

  it('fails cleanly when no interpreter is available at all', () => {
    const made = generated();
    const run = aid(
      made,
      ['ingest', '--all', '--json'],
      recordingSpawn({ probeStatus: null, status: null }),
    );

    expect(run.code).toBe(2);
    const [diagnostic] = diagnosticsOf(run);
    expect(diagnostic?.code).toBe('cli/python-missing');
    expect(diagnostic?.message).toContain('aid_runtime');
  });

  it('fails the same way when an interpreter exists but cannot import the runtime', () => {
    const made = generated();
    const run = aid(made, ['ingest', '--all', '--json'], recordingSpawn({ probeStatus: 1 }));
    expect(run.code).toBe(2);
    expect(diagnosticsOf(run)[0]?.code).toBe('cli/python-missing');
  });
});

describe('aid ingest -- a project that has not been generated', () => {
  it('fails and says to generate, rather than claiming a usage error', () => {
    // C8. `--retriever handbook` is a well-formed command that cannot do its job, so the
    // exit code is 1. Exit 2 would tell a script the arguments were wrong, which is false
    // and hides the one action that fixes it.
    const made = scratch();
    const run = aid(made, ['ingest', '--retriever', 'handbook', '--json']);

    expect(run.code).toBe(1);
    expect(run.code).not.toBe(2);
    expect(run.stderr).not.toMatch(/unknown command/);
    const [diagnostic] = diagnosticsOf(run);
    expect(diagnostic?.code).toBe('cli/ingest-modules-missing');
    expect(diagnostic?.hint).toContain('aid gen');
  });

  it('names `aid gen` on the human rendering too', () => {
    const run = aid(scratch(), ['ingest', '--retriever', 'handbook']);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('aid gen');
  });

  it('reports every missing module when `--all` has none to run', () => {
    const run = aid(scratch(), ['ingest', '--all', '--json']);
    expect(run.code).toBe(1);
    const [diagnostic] = diagnosticsOf(run);
    expect(diagnostic?.code).toBe('cli/ingest-modules-missing');
    expect(diagnostic?.message).toContain('handbook');
  });
});

describe('aid ingest -- the spec it read', () => {
  it('names the spec in its report', () => {
    const made = generated();
    expect(
      aid(made, ['ingest', '--all', '--json'], recordingSpawn()).json<{ spec: string }>().spec,
    ).toBe(SPEC_PATH);
  });

  it('fails on a spec that does not parse, without claiming a usage error', () => {
    // The code is the spec layer's, not this layer's: the CLI renames nothing. What matters
    // here is that a broken document is a failed command (1), not a rejected invocation.
    const run = aid(scratch('this: is: not: a: spec'), ['ingest', '--all', '--json']);
    expect(run.code).toBe(1);
    expect(diagnosticsOf(run).length).toBeGreaterThan(0);
  });
});
