/**
 * `aid eval` — run the eval gate, or record the baseline it measures against.
 *
 * **What this shells out to, and why.**
 *
 * The assignment sketched `uv run python -m aid_runtime.evals ...`, but that module is not
 * runnable: there is no `__main__.py`, no console script, and no `argparse` anywhere under
 * `runtimes/python/src/aid_runtime/evals/`. The command it names does not exist.
 *
 * What does exist, one per eval, is the module the generator emits:
 * `app/generated/evals/<id>.py`, with a `main()` that prints `result.summary()` and exits
 * non-zero when the gate fails. That module is the intended surface -- it is generated code
 * the spec already declares, and it is what the committed `app/evals/*.baseline.json` was
 * produced by. So `aid eval` runs `python -m app.generated.evals.<id>` from the project
 * root, which is also what a person would type by hand.
 *
 * The alternative was adding an entry point to `runtimes/`, and that was rejected: the
 * runtime is a landed layer whose published surface other layers depend on, and the
 * assignment says not to modify it. A missing runtime entry point is this layer's problem
 * to route around, not a reason to change a shipped one.
 *
 * **A TypeScript target runs its source directly.** The emitted `.ts` module carries the
 * same contract and the same entry guard, so `aid eval` runs the file with Node, whose
 * type stripping loads it without a build. One thing does not survive that: the generator
 * emits NodeNext `.js` specifiers because the compiled tree needs them, and Node will not
 * rewrite `../deps.js` to `../deps.ts`. `ts-loader.ts` supplies exactly that rewrite, as
 * the `--import` hook of the process, so no `dist/` has to exist first and a project that
 * has one still runs it.
 *
 * **`--baseline` delegates the sampling.** The gate is statistical (`maxRegression` against
 * a stored distribution), so a baseline from a single run is noise shaped like a fact. The
 * generated module's `run()` (or `sample()`) already samples the dataset `SAMPLES` times --
 * the N the spec declares -- so recording a baseline calls that, then the runtime's own
 * documented recipe (`EvalBaseline.fromRun` / `from_run`, which is literally the string in
 * the generated `loadBaseline`'s error message). Re-sampling here would invent a second N
 * and let the CLI and the module disagree about how many runs a baseline means.
 *
 * Each recipe is the only place in the CLI that writes its language. The Python one is a
 * script piped to the interpreter over stdin, and the Node one a script passed to `-e`,
 * because neither runtime has such an entry point; both are deliberately short, since
 * anything longer would be this layer reimplementing the runtime's measurement.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { IR } from '@aid-framework/ir';
import { sortDiagnostics } from '@aid-framework/spec';

import type { CliContext, SpawnResult } from '../context.js';
import type { CliDiagnostic } from '../diagnostics.js';
import { CLI_DIAGNOSTIC_CODES, cliError, cliWarning } from '../diagnostics.js';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from '../exit.js';
import { invokeNode, invokeNodeFile, NODE } from '../node.js';
import type { CommandOutcome } from '../output.js';
import { outcome } from '../output.js';
import { absolutePath } from '../paths.js';
import { lowerSpec, readSpec } from '../pipeline.js';
import { discoverInterpreter, INTERPRETERS, interpreterCommand, invoke } from '../python.js';
import { resolveTarget, unknownTargetDiagnostic } from '../targets.js';
import { compareBaselines } from './eval-compare.js';

/**
 * The TypeScript resolve hook, as a URL, because `--import` parses its argument as a
 * specifier: a bare `C:\...` path reads as a `c:` URL scheme.
 *
 * The `.ts` fallback exists for the same reason the hook does -- so this command works
 * from source as well as from `dist/`.
 */
const TS_LOADER = ((): string => {
  const compiled = new URL('../ts-loader.js', import.meta.url);
  if (existsSync(fileURLToPath(compiled))) return compiled.href;
  return new URL('../ts-loader.ts', import.meta.url).href;
})();

export interface EvalOptions {
  readonly spec: string | undefined;
  readonly target: string | undefined;
  readonly suite: string | undefined;
  readonly baseline: boolean;
  /** The accepted baseline for `--compare`; `candidate` is the other side of it. */
  readonly compare: string | undefined;
  readonly candidate: string | undefined;
  /**
   * Where `--record` writes the model calls the run made.
   *
   * Only meaningful for an agent eval, and only for a live one: the module refuses to
   * both replay and capture, and refuses to capture a scripted run, because a transcript
   * of a script is not evidence about a model.
   */
  readonly record: string | undefined;
}

/** Eval ids the spec declares, or the diagnostics that stopped it from declaring any. */
function declaredSuites(
  text: string,
  specPath: string,
):
  | {
      readonly ok: true;
      readonly ids: readonly string[];
      readonly ir: IR;
      readonly warnings: readonly CliDiagnostic[];
    }
  | { readonly ok: false; readonly diagnostics: readonly CliDiagnostic[] } {
  const lowered = lowerSpec(text, specPath);
  if (!lowered.ok) return { ok: false, diagnostics: lowered.diagnostics };
  const ir: IR = lowered.ir;
  return {
    ok: true,
    ids: ir.evals.map((entry) => entry.id),
    ir,
    warnings: lowered.diagnostics,
  };
}

/**
 * The baseline recorder, run as `python -`. `python` puts the current directory on
 * `sys.path`, so `import app.generated.evals.<id>` resolves against the project root and
 * each module's own `BASELINE_PATH` decides where its baseline goes -- the same path
 * `load_baseline()` reads back, because it is the same constant.
 */
function baselineScript(modules: readonly string[]): string {
  return [
    'import asyncio',
    'import importlib',
    'import pathlib',
    '',
    'from aid_runtime.evals import EvalBaseline',
    '',
    `MODULES = ${JSON.stringify(modules)}`,
    '',
    'for name in MODULES:',
    '    module = importlib.import_module(name)',
    '    # run() already samples the dataset SAMPLES times, the N the spec declares.',
    '    baseline = EvalBaseline.from_run(',
    '        asyncio.run(module.run()),',
    '        model=module.MODEL,',
    "        note='recorded by `aid eval --baseline`',",
    '    )',
    '    path = pathlib.Path(module.BASELINE_PATH)',
    '    path.parent.mkdir(parents=True, exist_ok=True)',
    '    path.write_text(baseline.to_json(), encoding="utf-8")',
    '    print(f"wrote {path}")',
    '',
  ].join('\n');
}

interface SuiteResult {
  readonly suite: string;
  readonly module: string;
  readonly status: number;
}

/**
 * The TypeScript baseline recorder, run as `node -e`.
 *
 * It imports each module by absolute URL so the module's own imports resolve from the
 * project tree, and it calls `recordBaseline()` rather than re-deriving a baseline: that
 * function already samples `SAMPLES` times, builds the `EvalBaseline`, and writes the file
 * `loadBaseline()` reads back -- the same constant, so the two cannot disagree.
 */
function nodeBaselineScript(files: readonly string[]): string {
  return [
    "import { fileURLToPath, pathToFileURL } from 'node:url';",
    '',
    `const MODULES = ${JSON.stringify(files)};`,
    '',
    'for (const file of MODULES) {',
    '  const module = await import(pathToFileURL(file).href);',
    "  await module.recordBaseline({ note: 'recorded by `aid eval --baseline`' });",
    // Concatenation, not a template literal: the emitted line is a plain string here, and
    // CodeQL (rightly) reads `${fileURLToPath}` inside one as a mistake.
    '  console.log("wrote " + fileURLToPath(module.BASELINE_PATH));',
    '}',
    '',
  ].join('\n');
}

/**
 * The environment variable a generated agent eval reads to learn where a capture goes.
 *
 * Spelled out here rather than imported from the generator: the CLI and the emitted module
 * share this name as a contract, the same way both sides already share
 * `AID_EVAL_TRANSCRIPT`. Importing it would make the CLI depend on a generator package to
 * hold a string, which is the layer edge the CLI otherwise keeps.
 */
const AGENT_RECORD_ENV = 'AID_EVAL_RECORD';

/**
 * The capture decision is the module's, made from its environment.
 *
 * The generated module refuses an impossible capture (both modes set, a scripted provider,
 * a path that already holds a recording) with a message that names the fix, so the CLI does
 * not repeat those checks: it says where the file goes and lets the module judge the rest.
 */
function recordingContext(context: CliContext, record: string | undefined): CliContext {
  if (record === undefined) return context;
  return {
    ...context,
    env: { ...context.env, [AGENT_RECORD_ENV]: absolutePath(context.cwd, record) },
  };
}

export function evaluate(context: CliContext, options: EvalOptions): CommandOutcome {
  const command = 'eval';
  const target = resolveTarget(options.target);
  if (target === undefined) {
    return outcome({
      command,
      exitCode: EXIT_USAGE,
      diagnostics: [unknownTargetDiagnostic(options.target ?? '')],
    });
  }

  const specPath = options.spec ?? target.specPath;
  const fields = { target: target.name, spec: specPath, suite: options.suite ?? null };

  const read = readSpec(context, specPath);
  if (!read.ok) {
    return outcome({ command, exitCode: EXIT_FAILURE, fields, diagnostics: read.diagnostics });
  }

  const declared = declaredSuites(read.text, specPath);
  if (!declared.ok) {
    return outcome({ command, exitCode: EXIT_FAILURE, fields, diagnostics: declared.diagnostics });
  }

  // `--compare` never runs anything: the candidate is usually a branch, and the evidence
  // is two committed baselines. It short-circuits here, before the module and interpreter
  // checks, because a project that has not been generated can still answer this question.
  if (options.compare !== undefined || options.candidate !== undefined) {
    if (options.compare === undefined || options.candidate === undefined) {
      return outcome({
        command,
        exitCode: EXIT_USAGE,
        fields,
        diagnostics: [
          cliError({
            code: CLI_DIAGNOSTIC_CODES.comparePairRequired,
            message: '--compare takes two baselines: the accepted one and the candidate one.',
            hint: 'Pass both, as in `aid eval --compare app/evals/x.baseline.json --candidate candidate.json`.',
          }),
        ],
      });
    }
    if (options.baseline) {
      // Recording replaces the accepted side of the comparison, so doing both at once would
      // mean comparing a file this run just overwrote. Two verbs, two runs.
      return outcome({
        command,
        exitCode: EXIT_USAGE,
        fields,
        diagnostics: [
          cliError({
            code: CLI_DIAGNOSTIC_CODES.comparePairRequired,
            message:
              '--compare and --baseline are separate runs: one records a baseline, the other judges a candidate against one.',
            hint: 'Record with `aid eval --baseline`, then compare with `aid eval --compare <accepted> --candidate <candidate>`.',
          }),
        ],
      });
    }
    if (options.record !== undefined) {
      // A capture is the evidence a comparison is made from, not part of making one:
      // `--compare` reads two committed baselines and runs nothing, so there would be no
      // run to capture and the flag would silently do nothing.
      return outcome({
        command,
        exitCode: EXIT_USAGE,
        fields,
        diagnostics: [
          cliError({
            code: CLI_DIAGNOSTIC_CODES.comparePairRequired,
            message: '--compare runs nothing, so there is no run for --record to capture.',
            hint: 'Capture with `aid eval --suite <id> --record <path>`, commit the transcript, then compare the baselines.',
          }),
        ],
      });
    }
    return compareBaselines(context, declared.ir, {
      specPath,
      suite: options.suite,
      comparePath: options.compare,
      candidatePath: options.candidate,
    });
  }

  // `--suite` is checked against the ids the spec declares, not against filenames on
  // disk: the set of evals is a property of the spec, so a typo is a usage error and
  // should say which ids exist.
  if (options.suite !== undefined && !declared.ids.includes(options.suite)) {
    return outcome({
      command,
      exitCode: EXIT_USAGE,
      fields,
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.suiteNotFound,
          message: `No eval named "${options.suite}" in ${specPath}.`,
          path: [specPath],
          hint:
            declared.ids.length > 0
              ? `Declared evals: ${declared.ids.join(', ')}.`
              : 'The spec declares no evals.',
        }),
      ],
    });
  }

  const suites = options.suite === undefined ? declared.ids : [options.suite];

  if (options.record !== undefined) {
    // One transcript is one run. Capturing several suites into one path would write a file
    // holding two runs' calls in arrival order, which no replay can divide back up.
    if (suites.length !== 1) {
      return outcome({
        command,
        exitCode: EXIT_USAGE,
        fields: { ...fields, suites },
        diagnostics: [
          cliError({
            code: CLI_DIAGNOSTIC_CODES.evalRecordUnsupported,
            message: `--record captures one run, and this one would run ${suites.length} evals.`,
            hint: 'Name the eval to capture with `--suite <id>`, and record each one to its own path.',
          }),
        ],
      });
    }
    // A prompt eval calls the gateway for an answer, not for a trajectory, and its module
    // has no capture code at all: `--record` there would exit 0 and write nothing.
    const subject = declared.ir.evals.find((entry) => entry.id === suites[0]);
    if (subject !== undefined && subject.target.kind !== 'agent') {
      return outcome({
        command,
        exitCode: EXIT_USAGE,
        fields: { ...fields, suites, suiteKind: subject.target.kind },
        diagnostics: [
          cliError({
            code: CLI_DIAGNOSTIC_CODES.evalRecordUnsupported,
            message: `"${subject.id}" measures a ${subject.target.kind}, not an agent, so it has no trajectory to record.`,
            hint: 'Only an agent eval calls a model inside a loop; declare the eval with `target: agent:<id>`.',
          }),
        ],
      });
    }
  }

  const missing = suites.filter(
    (id) => !existsSync(absolutePath(context.cwd, target.evalModuleFile(id))),
  );
  if (missing.length > 0) {
    return outcome({
      command,
      exitCode: EXIT_FAILURE,
      fields: { ...fields, suites },
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.evalModulesMissing,
          message: `No generated eval module for ${missing.map((id) => `"${id}"`).join(', ')}.`,
          path: missing.map((id) => target.evalModuleFile(id)),
          hint: 'Run `aid gen`: the evals that run are the modules the generator emits.',
        }),
      ],
    });
  }

  // A Python target names its module (`app.generated.evals.<id>`, importable from the
  // project root); a Node target names the file, because `process.argv[1]` is how the
  // emitted module knows it is the entry point and should run its gate.
  const modules = suites.map((id) =>
    target.runner === 'node'
      ? absolutePath(context.cwd, target.evalModuleFile(id))
      : target.evalModule(id),
  );

  let driver: string;
  let runModule: (module: string) => SpawnResult | undefined;
  let recordBaseline: () => SpawnResult | undefined;

  // Both verbs run in the derived context, so a baseline captured from a live run can keep
  // the transcript that produced it instead of describing a session nobody can replay.
  const spawned = recordingContext(context, options.record);

  if (target.runner === 'node') {
    driver = NODE;
    runModule = (module) => invokeNodeFile(spawned, module, { import: TS_LOADER });
    recordBaseline = () => invokeNode(spawned, nodeBaselineScript(modules), { import: TS_LOADER });
  } else {
    const interpreter = discoverInterpreter(context);
    if (interpreter === undefined) {
      return outcome({
        command,
        // Exit 2, not 1: nothing about the project was judged. The gate has no verdict when
        // the thing that would run it cannot start, and `1` would read as "the evals failed".
        exitCode: EXIT_USAGE,
        fields: { ...fields, suites },
        diagnostics: [
          cliError({
            code: CLI_DIAGNOSTIC_CODES.pythonMissing,
            message: `No interpreter could import aid_runtime (tried ${INTERPRETERS.join(', ')}).`,
            hint: 'Install the runtime into the interpreter you run with, or run the generated eval modules yourself.',
          }),
        ],
      });
    }
    driver = interpreter;
    const base = interpreterCommand(interpreter);
    runModule = (module) => invoke(spawned, [...base, '-m', module]);
    recordBaseline = () => invoke(spawned, [...base, '-'], baselineScript(modules));
  }

  const common = { ...fields, suites, driver };

  if (options.baseline) {
    const recorded = recordBaseline();
    if (recorded === undefined || recorded.status !== 0) {
      return outcome({
        command,
        exitCode: EXIT_FAILURE,
        fields: common,
        diagnostics: [
          cliError({
            code: CLI_DIAGNOSTIC_CODES.runnerFailed,
            message: `Could not record a baseline with ${driver}.`,
            hint: 'Recording a baseline runs the evals, so it needs whatever they need; see the output for why they did not run.',
          }),
        ],
        text: recorded?.stdout.trimEnd() ?? '',
        stderr: recorded?.stderr ?? '',
      });
    }
    return outcome({
      command,
      exitCode: EXIT_OK,
      fields: common,
      text: recorded.stdout.trimEnd(),
      stderr: recorded.stderr,
    });
  }

  const results: SuiteResult[] = [];
  const output: string[] = [];
  const spoken: string[] = [];
  const diagnostics: CliDiagnostic[] = [...declared.warnings];

  for (const [index, module] of modules.entries()) {
    const suite = suites[index] ?? module;
    const run = runModule(module);
    if (run === undefined) {
      return outcome({
        command,
        exitCode: EXIT_USAGE,
        fields: common,
        diagnostics: [
          cliError({
            code: CLI_DIAGNOSTIC_CODES.runnerFailed,
            message: `Could not start ${driver} to run "${suite}".`,
          }),
        ],
      });
    }
    results.push({ suite, module, status: run.status ?? EXIT_FAILURE });
    if (run.stdout.trim() !== '') output.push(run.stdout.trimEnd());
    // The generated `main()` prints its summary to stdout and exits non-zero on a
    // regression; anything on stderr is the eval reporting something that did not fit in
    // a metric. It is surfaced rather than swallowed, because a gate that hides what it
    // could not measure is a gate that passes for the wrong reason -- and it is surfaced
    // on stderr, including under `--json`, because that is where the process that wrote it
    // wrote it, and `--json` replaces stdout with a document rather than with nothing.
    if (run.stderr.trim() !== '') {
      spoken.push(run.stderr.trimEnd());
      diagnostics.push(
        cliWarning({
          code: CLI_DIAGNOSTIC_CODES.runnerWarned,
          message: `"${suite}" wrote to stderr.`,
        }),
      );
    }
  }

  // A non-zero exit from a generated module *is* the gate's verdict, so it propagates
  // rather than being reinterpreted here. The CLI reports the gate; it has no opinion
  // about the numbers, and forming one would be the second implementation of the gate
  // that this layer exists to avoid.
  const failed = results.some((result) => result.status !== 0);

  return outcome({
    command,
    exitCode: failed ? EXIT_FAILURE : EXIT_OK,
    fields: { ...common, results },
    diagnostics: sortDiagnostics(diagnostics),
    text: output.join('\n'),
    stderr: spoken.join('\n'),
  });
}
