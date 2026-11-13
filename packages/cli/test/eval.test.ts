/**
 * `aid eval` is a shell around whichever runtime the target uses, so the contract under
 * test is the contract between the two processes: which command is run, from where, with
 * what exit code propagated, and what happens when the runtime is not there at all.
 *
 * Python dispatches `-m app.generated.evals.<id>`; a Node target dispatches the emitted
 * file itself, because `process.argv[1]` is how the module knows to run its gate. Both
 * drivers are injected, so these tests never run a runtime. That is deliberate: the E2E
 * job and `examples/support-copilot{,-ts}`'s own test suites are where generated code is
 * actually executed, and a unit test that skipped itself when a runtime was missing would
 * report coverage it did not have.
 */

import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  aid,
  diagnosticsOf,
  project,
  recordingSpawn,
  SPEC_PATH,
  TS_EXAMPLE_SPEC,
} from './helpers.js';

const created: ReturnType<typeof project>[] = [];

function scratch() {
  const made = project();
  created.push(made);
  return made;
}

/** A scratch project built from the committed TypeScript example's spec. */
function tsScratch() {
  const made = project(TS_EXAMPLE_SPEC);
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
    // Every declared eval gets its own module, in plan order: the example declares three,
    // and asserting only the last dispatched module would pass while one of them was
    // silently skipped.
    const dispatched = spawn.calls
      .filter((call) => call.args.includes('-m'))
      .map((call) => call.args.at(-1));
    expect(dispatched).toEqual([
      'app.generated.evals.classify_quality',
      'app.generated.evals.handbook_quality',
      'app.generated.evals.refund_trajectory',
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
      driver: string;
      results: { suite: string; status: number }[];
    }>();
    expect(report.suites).toEqual(['classify_quality', 'handbook_quality', 'refund_trajectory']);
    expect(report.driver).toBeTruthy();
    expect(report.results).toEqual([
      { suite: 'classify_quality', module: expect.any(String), status: 0 },
      { suite: 'handbook_quality', module: expect.any(String), status: 0 },
      { suite: 'refund_trajectory', module: expect.any(String), status: 0 },
    ]);
  });
});

describe('aid eval on a Node target', () => {
  it('runs each generated file, because argv[1] is how it knows to run its gate', () => {
    const made = tsScratch();
    aid(made, ['gen', '--target', 'ts-vercel']);
    const spawn = recordingSpawn();

    expect(aid(made, ['eval', '--target', 'ts-vercel'], spawn).code).toBe(0);

    // No `-m`: the file is what `process.argv[1]` names, and the emitted module compares
    // that against its own URL before running. A module name here would start Node on a
    // file called `app.generated.evals.classify_quality`.
    const runs = spawn.calls.filter((call) => !call.args.includes('-e'));
    expect(runs.map((call) => call.args.at(-1))).toEqual([
      expect.stringMatching(/app[\\/]generated[\\/]evals[\\/]classify_quality\.ts$/),
      expect.stringMatching(/app[\\/]generated[\\/]evals[\\/]handbook_quality\.ts$/),
      expect.stringMatching(/app[\\/]generated[\\/]evals[\\/]triage_quality\.ts$/),
    ]);
    // The TypeScript resolve hook is passed as `--import`: the emitted modules use NodeNext
    // `.js` specifiers, and Node will not rewrite `../deps.js` to `../deps.ts` on its own.
    for (const call of runs) {
      expect(call.command).toBe(process.execPath);
      expect(call.args.slice(0, 2)).toEqual([
        '--import',
        expect.stringMatching(/ts-loader\.(ts|js)$/),
      ]);
    }
  });

  it('says node when it reports the driver', () => {
    const made = tsScratch();
    aid(made, ['gen', '--target', 'ts-vercel']);
    const report = aid(made, ['eval', '--target', 'ts-vercel', '--json'], recordingSpawn()).json<{
      driver: string;
      suites: string[];
    }>();
    expect(report.driver).toBe('node');
    expect(report.suites).toEqual(['classify_quality', 'handbook_quality', 'triage_quality']);
  });

  it('fails as a usage error when the process cannot be started', () => {
    const made = tsScratch();
    aid(made, ['gen', '--target', 'ts-vercel']);
    const run = aid(
      made,
      ['eval', '--target', 'ts-vercel', '--json'],
      recordingSpawn({ status: null }),
    );

    expect(run.code).toBe(2);
    expect(diagnosticsOf(run)[0]?.code).toBe('cli/runner-failed');
  });

  it("records a baseline with the module's own recordBaseline", () => {
    const made = tsScratch();
    aid(made, ['gen', '--target', 'ts-vercel']);
    const spawn = recordingSpawn();

    expect(aid(made, ['eval', '--target', 'ts-vercel', '--baseline'], spawn).code).toBe(0);

    const call = spawn.calls.at(-1);
    // `-e` carries the driver as text: a recording run must not write a script into the
    // project. It imports each module by file URL and calls `recordBaseline()`, which
    // already samples `SAMPLES` times and writes the file `loadBaseline()` reads.
    expect(call?.args).toContain('-e');
    expect(call?.args).toContain('--input-type=module');
    expect(call?.stdin).toBeUndefined();
    const script = call?.args.at(-1) ?? '';
    expect(script).toContain('recordBaseline');
    expect(script).toContain('BASELINE_PATH');
    expect(script).toContain('pathToFileURL');
  });
});

describe('aid eval --record', () => {
  it('tells the module where to capture, rather than capturing itself', () => {
    // The capture is generated code: only the module knows its document, its providers and
    // its dataset. So `--record` is a request passed to the child, not a second
    // implementation of recording in the CLI -- which is why the assertion is on the
    // child's environment rather than on anything this process did.
    const made = scratch();
    aid(made, ['gen']);
    const spawn = recordingSpawn();

    expect(
      aid(made, ['eval', '--suite', 'refund_trajectory', '--record', 'capture.json'], spawn).code,
    ).toBe(0);

    const call = spawn.calls.find((entry) => entry.args.includes('-m'));
    // Absolute, because the child runs from the project root only by convention: a relative
    // path handed to a module that resolved it from somewhere else would write the capture
    // outside the tree the user was looking at.
    expect(call?.env?.AID_EVAL_RECORD).toBe(join(made.root, 'capture.json'));
    // Nothing else is set: a run that replayed and captured at once is refused by the
    // module, and the CLI must not manufacture that state.
    expect(call?.env?.AID_EVAL_TRANSCRIPT).toBeUndefined();
  });

  it('records only when asked', () => {
    const made = scratch();
    aid(made, ['gen']);
    const spawn = recordingSpawn();

    expect(aid(made, ['eval', '--suite', 'refund_trajectory'], spawn).code).toBe(0);

    const call = spawn.calls.find((entry) => entry.args.includes('-m'));
    expect(call?.env?.AID_EVAL_RECORD).toBeUndefined();
  });

  it('refuses to capture a run it would not be able to divide', () => {
    // One transcript is one run. Several suites into one path would interleave two runs'
    // calls in arrival order, and no replay can split them again.
    const made = scratch();
    aid(made, ['gen']);
    const run = aid(made, ['eval', '--record', 'capture.json', '--json'], recordingSpawn());

    expect(run.code).toBe(2);
    const [diagnostic] = diagnosticsOf(run);
    expect(diagnostic?.code).toBe('cli/eval-record-unsupported');
    expect(diagnostic?.hint).toContain('--suite');
  });

  it('refuses to capture an eval that measures no trajectory', () => {
    // A prompt eval calls the gateway for an answer, not for a run, and its module carries
    // no capture code: the flag would exit 0 and write nothing, which reads as success.
    const made = scratch();
    aid(made, ['gen']);
    const run = aid(
      made,
      ['eval', '--suite', 'classify_quality', '--record', 'capture.json', '--json'],
      recordingSpawn(),
    );

    expect(run.code).toBe(2);
    const [diagnostic] = diagnosticsOf(run);
    expect(diagnostic?.code).toBe('cli/eval-record-unsupported');
    expect(diagnostic?.message).toContain('pipeline');
  });

  it('refuses to capture during a comparison, which runs nothing', () => {
    const made = scratch();
    aid(made, ['gen']);
    const run = aid(
      made,
      [
        'eval',
        '--compare',
        'a.json',
        '--candidate',
        'b.json',
        '--record',
        'capture.json',
        '--json',
      ],
      recordingSpawn(),
    );

    expect(run.code).toBe(2);
    expect(diagnosticsOf(run)[0]?.message).toContain('--record');
  });
});
