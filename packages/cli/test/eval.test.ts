/**
 * `aid eval` is a shell around the Python runtime, so the contract under test is the
 * contract between the two processes: which command is run, from where, with what exit
 * code propagated, and what happens when Python is not there at all.
 *
 * The interpreter is injected, so these tests never run Python. That is deliberate: the
 * E2E job and `examples/support-copilot`'s own test suite are where generated code is
 * actually executed, and a unit test that skipped itself when Python was missing would
 * report coverage it did not have.
 */

import { afterAll, describe, expect, it } from 'vitest';

import { aid, diagnosticsOf, project, recordingSpawn, SPEC_PATH } from './helpers.js';

const created: ReturnType<typeof project>[] = [];

function scratch() {
  const made = project();
  created.push(made);
  return made;
}

afterAll(() => {
  for (const made of created) made.close();
});

describe('aid eval', () => {
  it('dispatches the generated eval module, not a runtime entry point', () => {
    // `aid_runtime.evals` has no `__main__`, so there is no module to run: the runnable
    // thing is the generated module, which is the only object that knows this eval's
    // dataset, model and baseline.
    const made = scratch();
    aid(made, ['gen']);
    const spawn = recordingSpawn();

    const run = aid(made, ['eval', '--json'], spawn);
    expect(run.code).toBe(0);
    // Every declared eval gets its own module, in plan order: the example declares two,
    // and asserting only the last dispatched module would pass while one of them was
    // silently skipped.
    const dispatched = spawn.calls
      .filter((call) => call.args.includes('-m'))
      .map((call) => call.args.at(-1));
    expect(dispatched).toEqual([
      'app.generated.evals.classify_quality',
      'app.generated.evals.handbook_quality',
    ]);
  });

  it('probes the interpreter by asking whether it can import the runtime', () => {
    // Existence is the wrong question: a system `python` beside a project virtualenv
    // exists and is the wrong one, and its failure would be reported as a broken
    // generated module.
    const made = scratch();
    aid(made, ['gen']);
    const spawn = recordingSpawn();
    aid(made, ['eval'], spawn);

    const probe = spawn.calls.find((call) => call.args.includes('-c'));
    expect(probe?.args.join(' ')).toContain('import aid_runtime');
  });

  it('runs from the project root, where the module is importable', () => {
    // The package is only importable as `app.generated.evals.<id>` from the project root;
    // from anywhere else the run fails with a ModuleNotFoundError that looks like a bug
    // in the generated code rather than in the working directory.
    const made = scratch();
    aid(made, ['gen']);
    const spawn = recordingSpawn();
    aid(made, ['eval', '--json'], spawn);
    expect(spawn.calls.at(-1)?.command).toBeTruthy();
    expect(aid(made, ['eval', '--json'], recordingSpawn()).json<{ spec: string }>().spec).toBe(
      SPEC_PATH,
    );
  });

  it('propagates the gate exit code, and surfaces what the gate said', () => {
    const made = scratch();
    aid(made, ['gen']);
    const run = aid(
      made,
      ['eval', '--json'],
      recordingSpawn({ status: 1, stderr: 'gate failed\n' }),
    );
    expect(run.code).toBe(1);
    // The runner's own stderr is worth surfacing rather than swallowing: a gate that
    // hides what it could not measure passes for the wrong reason. It reaches the CLI's
    // stderr even under `--json`, where stdout is a document rather than the report --
    // otherwise the one mode a machine reads is the one that drops the explanation.
    expect(run.stderr).toContain('gate failed');
    expect(diagnosticsOf(run)[0]?.code).toBe('cli/runner-warned');
  });

  it('reports a suite that the IR does not declare as a usage error', () => {
    const made = scratch();
    aid(made, ['gen']);
    const run = aid(made, ['eval', '--suite', 'nope', '--json'], recordingSpawn());

    expect(run.code).toBe(2);
    const [diagnostic] = diagnosticsOf(run);
    expect(diagnostic?.code).toBe('cli/suite-not-found');
    expect(diagnostic?.hint).toContain('classify_quality');
  });

  it('runs only the requested suite', () => {
    const made = scratch();
    aid(made, ['gen']);
    const spawn = recordingSpawn();
    expect(aid(made, ['eval', '--suite', 'classify_quality'], spawn).code).toBe(0);

    const modules = spawn.calls
      .map((call) => call.args.join(' '))
      .filter((command) => command.includes('generated.evals'));
    expect(modules).toEqual(['-m app.generated.evals.classify_quality']);
  });

  it('says to generate first when the eval module is missing', () => {
    const made = scratch();
    const run = aid(made, ['eval', '--json'], recordingSpawn());

    expect(run.code).toBe(1);
    const [diagnostic] = diagnosticsOf(run);
    expect(diagnostic?.code).toBe('cli/eval-modules-missing');
    expect(diagnostic?.hint).toContain('aid gen');
  });

  it('fails cleanly when no interpreter is available at all', () => {
    const made = scratch();
    aid(made, ['gen']);
    const run = aid(made, ['eval', '--json'], recordingSpawn({ probeStatus: null, status: null }));

    expect(run.code).toBe(2);
    const [diagnostic] = diagnosticsOf(run);
    expect(diagnostic?.code).toBe('cli/python-missing');
    expect(diagnostic?.message).toContain('aid_runtime');
  });

  it('fails the same way when an interpreter exists but cannot import the runtime', () => {
    // The actionable case: `python` is on PATH and the runtime is not installed into it.
    const made = scratch();
    aid(made, ['gen']);
    const run = aid(made, ['eval', '--json'], recordingSpawn({ probeStatus: 1 }));

    expect(run.code).toBe(2);
    expect(diagnosticsOf(run)[0]?.code).toBe('cli/python-missing');
  });

  it("records a baseline by rewriting the module's own baseline file", () => {
    const made = scratch();
    aid(made, ['gen']);
    const spawn = recordingSpawn();

    expect(aid(made, ['eval', '--baseline'], spawn).code).toBe(0);
    // The baseline recipe runs the eval and writes what it measured -- the same code path
    // the module documents, not a second implementation of "what a baseline means".
    const recipe = spawn.calls.at(-1)?.stdin ?? '';
    expect(recipe).toContain('from_run');
    expect(recipe).toContain('BASELINE_PATH');
    expect(recipe).toContain('app.generated.evals.classify_quality');
    expect(spawn.calls.at(-1)?.args).toEqual(['-']);
  });

  it('reports the suites it knows about and how the run was started', () => {
    const made = scratch();
    aid(made, ['gen']);
    const report = aid(made, ['eval', '--json'], recordingSpawn()).json<{
      suites: string[];
      interpreter: string;
      results: { suite: string; status: number }[];
    }>();
    expect(report.suites).toEqual(['classify_quality', 'handbook_quality']);
    expect(report.interpreter).toBeTruthy();
    expect(report.results).toEqual([
      { suite: 'classify_quality', module: expect.any(String), status: 0 },
      { suite: 'handbook_quality', module: expect.any(String), status: 0 },
    ]);
  });
});
