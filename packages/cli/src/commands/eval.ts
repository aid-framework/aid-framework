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
 * **`--baseline` delegates the sampling.** The gate is statistical (`maxRegression` against
 * a stored distribution), so a baseline from a single run is noise shaped like a fact. The
 * generated module's `run()` already samples the dataset `SAMPLES` times -- the N the spec
 * declares -- so recording a baseline calls that, then the runtime's own documented recipe
 * (`EvalBaseline.from_run(await run(), model=...).to_json()`, which is literally the string
 * in the generated `load_baseline`'s error message). Re-sampling here would invent a second
 * N and let the CLI and the module disagree about how many runs a baseline means.
 *
 * That recipe is the one place in the CLI that writes Python. It is a script piped to the
 * interpreter over stdin rather than an API call because the runtime has no such entry
 * point, and it is deliberately short: anything longer would be this layer reimplementing
 * the runtime's measurement.
 */

import { existsSync } from 'node:fs';

import type { IR } from '@aid/ir';
import { sortDiagnostics } from '@aid/spec';

import type { CliContext } from '../context.js';
import type { CliDiagnostic } from '../diagnostics.js';
import { CLI_DIAGNOSTIC_CODES, cliError, cliWarning } from '../diagnostics.js';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from '../exit.js';
import type { CommandOutcome } from '../output.js';
import { outcome } from '../output.js';
import { absolutePath } from '../paths.js';
import { lowerSpec, readSpec } from '../pipeline.js';
import { discoverInterpreter, INTERPRETERS, interpreterCommand, invoke } from '../python.js';
import { resolveTarget, unknownTargetDiagnostic } from '../targets.js';

export interface EvalOptions {
  readonly spec: string | undefined;
  readonly target: string | undefined;
  readonly suite: string | undefined;
  readonly baseline: boolean;
}

/** Eval ids the spec declares, or the diagnostics that stopped it from declaring any. */
function declaredSuites(
  text: string,
  specPath: string,
):
  | {
      readonly ok: true;
      readonly ids: readonly string[];
      readonly warnings: readonly CliDiagnostic[];
    }
  | { readonly ok: false; readonly diagnostics: readonly CliDiagnostic[] } {
  const lowered = lowerSpec(text, specPath);
  if (!lowered.ok) return { ok: false, diagnostics: lowered.diagnostics };
  const ir: IR = lowered.ir;
  return {
    ok: true,
    ids: ir.evals.map((entry) => entry.id),
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

  if (target.runner !== 'python') {
    return outcome({
      command,
      // Exit 2, not 1: this command has no runner for this target, so no eval ran and
      // nothing about the project was judged. `1` would read as "the evals failed".
      exitCode: EXIT_USAGE,
      fields: { ...fields, suites },
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.runnerUnsupported,
          message: `\`aid eval\` runs generated Python modules, and ${target.name} emits TypeScript.`,
          hint: 'The emitted eval module exports `sample()` and `evaluate(run, baseline)`; run it with Node.',
        }),
      ],
    });
  }

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

  const modules = suites.map((id) => target.evalModule(id));
  const base = interpreterCommand(interpreter);
  const common = { ...fields, suites, interpreter };

  if (options.baseline) {
    const recorded = invoke(context, [...base, '-'], baselineScript(modules));
    if (recorded === undefined || recorded.status !== 0) {
      return outcome({
        command,
        exitCode: EXIT_FAILURE,
        fields: common,
        diagnostics: [
          cliError({
            code: CLI_DIAGNOSTIC_CODES.runnerFailed,
            message: `Could not record a baseline with ${interpreter}.`,
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
    const run = invoke(context, [...base, '-m', module]);
    if (run === undefined) {
      return outcome({
        command,
        exitCode: EXIT_USAGE,
        fields: common,
        diagnostics: [
          cliError({
            code: CLI_DIAGNOSTIC_CODES.runnerFailed,
            message: `Could not start ${interpreter} to run "${module}".`,
          }),
        ],
      });
    }
    const suite = suites[index] ?? module;
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
