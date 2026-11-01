/**
 * `aid guard` -- measure an app's guardrails against a red-team corpus.
 *
 * **What is measured, and why it is measured here.** The runtime's `GuardrailEngine` is
 * the thing that decides whether text is a jailbreak, a secret, or an injection, and the
 * table the generator emitted -- `generated/guardrails.py`, or `generated/guardrails.ts`
 * for the TypeScript target -- is the declarations the routes enforce.
 * This command joins the two and reports, per fixture, whether the table the app actually
 * shipped caught it. Detection is not reimplemented: a second implementation here would
 * drift from the one the routes run, and the number it produced would describe the CLI
 * rather than the application.
 *
 * **Why the corpus is an input.** The framework's own corpus lives in
 * `runtimes/python/tests/redteam/fixtures.json` and is not shipped with any package.
 * Copying it into the CLI would create a second copy that drifts from the one
 * `test_redteam.py` gates on, and shipping it with the runtime would change a landed
 * layer's published contents for one command's convenience. So the format is the
 * contract: `--red-team` names a file, and without it the command looks for
 * `redteam.json` beside the spec and then at the project root.
 *
 * **Why it evaluates the declared table, not one synthesized definition per fixture.**
 * `test_redteam.py` builds a `GuardrailDefinition` for each fixture and runs it alone,
 * because it is testing the detectors. This command is answering a different question --
 * "would *this app* have caught this?" -- so it hands the engine every declaration that
 * covers the fixture's stage, exactly as a route does, and a fixture counts as caught
 * when any of them fires. A declaration that names the wrong policy still counts as a
 * catch if its other policy fires: the app stopped the payload, which is what matters.
 *
 * **Why `covered` is a separate fact from `caught`.** "No declaration at this stage names
 * this policy" is a spec gap the developer can close by editing the YAML; "declared but
 * the detector missed" is a detector gap they cannot. Folding both into one recall number
 * would send a reader to the wrong file, so the undeclared pairs are listed on their own
 * line and in the `--json` document.
 *
 * **Why nothing is regenerated.** A gate measures the tree it is given, and `aid eval`
 * already sets that precedent: this command reads the emitted table, and a tree that
 * predates the spec is reported as a missing or stale module rather than silently
 * replaced. Run `aid gen` first, as CI does.
 *
 * **Two drivers, one join.** Which program imports the table is the target's business,
 * not this command's. A Python target is measured by an interpreter that can import
 * `aid_runtime`, because that is what the emitted module is; a TypeScript target is
 * measured by the Node that is running the CLI, because `aid` is a Node program and the
 * emitted module is TypeScript it loads directly. Both drivers do the same four things --
 * import the table, pick the stage method, turn the verdict into a row, print JSON -- so
 * no part of detection is written twice.
 *
 * **When it does not run, and what it exits with.** Exit 2 is "this command could not
 * judge the project": an unknown target, a corpus that is missing or malformed, or (for a
 * Python target) no interpreter that can import the runtime. Exit 1 is a verdict about the
 * project: it declares no guardrails, its tree has no guardrail module, the run failed, or
 * the measured recall / false-positive rate misses what the corpus asks for.
 */

import { existsSync, readFileSync } from 'node:fs';

import { sortDiagnostics } from '@aid-framework/spec';

import type { CliContext, SpawnResult } from '../context.js';
import type { CliDiagnostic } from '../diagnostics.js';
import { CLI_DIAGNOSTIC_CODES, cliError, cliWarning } from '../diagnostics.js';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from '../exit.js';
import { invokeNode, NODE } from '../node.js';
import type { CommandOutcome } from '../output.js';
import { outcome } from '../output.js';
import { absolutePath, parentPath } from '../paths.js';
import { lowerSpec, readSpec } from '../pipeline.js';
import { discoverInterpreter, INTERPRETERS, interpreterCommand, invoke } from '../python.js';
import { resolveTarget, unknownTargetDiagnostic } from '../targets.js';

export interface GuardOptions {
  readonly spec: string | undefined;
  readonly target: string | undefined;
  /** The corpus to measure against; discovered beside the spec when omitted. */
  readonly redTeam: string | undefined;
}

/** The four stages the IR defines, and the only ones a fixture may name. */
const GUARD_STAGES = ['input', 'output', 'retrieval', 'tool-call'] as const;

type GuardStage = (typeof GUARD_STAGES)[number];

/** What one fixture turned out to be. `caught` is per-fixture; the words depend on intent. */
type GuardVerdict = 'caught' | 'missed' | 'false-positive' | 'clean';

interface Fixture {
  readonly id: string;
  readonly stage: GuardStage;
  readonly policy: string;
  readonly knownBad: boolean;
  readonly text: string;
  readonly arguments: Readonly<Record<string, unknown>> | undefined;
  readonly tool: string | undefined;
}

interface Thresholds {
  /** Recall the corpus requires; `1.0` when it does not say. */
  readonly recall: number;
  /** False-positive rate the corpus tolerates; `0.0` when it does not say. */
  readonly falsePositiveRate: number;
  /** Fewer known-bad fixtures than this and the recall is not a gate. */
  readonly knownBadMinimum: number;
  readonly benignMinimum: number;
}

interface Corpus {
  /** The repo-relative path, which is also what the driver is handed. */
  readonly path: string;
  readonly fixtures: readonly Fixture[];
  readonly thresholds: Thresholds;
}

/** One row the driver reported, before it is joined to its fixture. */
interface RunnerRow {
  readonly id: string;
  readonly declared?: number;
  readonly covered?: boolean;
  readonly caught?: boolean;
  readonly deciding?: string | null;
  readonly actions?: readonly string[];
  readonly error?: string;
}

/** One fixture, measured, with the corpus facts that explain its verdict. */
interface ResultRow {
  readonly id: string;
  readonly stage: GuardStage;
  readonly policy: string;
  readonly knownBad: boolean;
  readonly caught: boolean;
  readonly covered: boolean;
  readonly deciding: string | undefined;
  readonly actions: readonly string[];
  readonly verdict: GuardVerdict;
  readonly error: string | undefined;
}

/**
 * The interpreter side of the contract.
 *
 * It does four things and none of them is detection: import the app's table, pick the
 * stage method that matches the fixture, turn the verdict into a row, print JSON. The
 * corpus path is opened rather than embedded so a large fixture file never has to travel
 * through a command line, and the module name is passed rather than spelled, because the
 * generator owns where its table lives.
 */
const GUARD_SCRIPT = `"""Measure one app's guardrail table against a red-team corpus."""
import importlib
import json
import sys

from aid_runtime.agents import GuardrailEngine

corpus_path, module_name = sys.argv[1], sys.argv[2]

with open(corpus_path, encoding="utf-8") as handle:
    corpus = json.load(handle)

module = importlib.import_module(module_name)
definitions = tuple(getattr(module, "GUARDRAILS", ()))
engine = GuardrailEngine(getattr(module, "BY_ID", None))


def measure(fixture):
    stage = fixture["stage"]
    declared = tuple(item for item in definitions if stage in item.stages)
    text = fixture.get("text") or ""
    if stage == "input":
        return declared, engine.check_input(declared, text)
    if stage == "output":
        return declared, engine.check_output(declared, text)
    if stage == "retrieval":
        return declared, engine.check_retrieval(declared, (text,))
    arguments = dict(fixture.get("arguments") or {})
    if text:
        arguments = dict(arguments, text=text)
    return declared, engine.check_tool_call(
        declared, fixture.get("tool") or "search", arguments
    )


rows = []
for fixture in corpus["fixtures"]:
    try:
        declared, verdict = measure(fixture)
    except Exception as error:  # reported as a row, not swallowed
        rows.append({"id": fixture["id"], "error": type(error).__name__ + ": " + str(error)})
        continue
    rows.append(
        {
            "id": fixture["id"],
            "declared": len(declared),
            "covered": any(fixture["policy"] in item.policies for item in declared),
            "caught": verdict.fired,
            "deciding": None if verdict.deciding is None else verdict.deciding.guardrail,
            "actions": sorted({record.action for record in verdict.records}),
        }
    )

print(json.dumps({"rows": rows}))
`;

/**
 * The Node side of the same contract, for a target whose table is TypeScript.
 *
 * It is the same four steps as `GUARD_SCRIPT` and nothing more, which is the point: the
 * measurement a TypeScript app gets is produced by the engine the Next app runs, over the
 * table the generator emitted, exactly as the Python app's is. `GUARDRAILS`, `ENGINE` and
 * the camelCase stage methods are the generated module's exports, so this driver is
 * written against the emit contract rather than against any one app.
 *
 * The paths are spliced in as string literals instead of arriving as argv: `node -e` has
 * no script name, so `process.argv` is off by one relative to a script file, and a literal
 * removes that whole class of bug (and quoting on Windows with it). Both are absolute, and
 * the module is imported by URL so Node resolves its own imports from the app tree.
 */
const NODE_GUARD_SCRIPT = `import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const corpus = JSON.parse(readFileSync(CORPUS_PATH, 'utf8'));
const emitted = await import(pathToFileURL(MODULE_PATH).href);
const definitions = emitted.GUARDRAILS ?? [];
const engine = emitted.ENGINE;

function measure(fixture) {
  const stage = fixture.stage;
  const declared = definitions.filter((item) => item.stages.includes(stage));
  const text = fixture.text ?? '';
  if (stage === 'input') return [declared, engine.checkInput(declared, text)];
  if (stage === 'output') return [declared, engine.checkOutput(declared, text)];
  if (stage === 'retrieval') return [declared, engine.checkRetrieval(declared, [text])];
  const args = { ...(fixture.arguments ?? {}) };
  if (text) args.text = text;
  return [declared, engine.checkToolCall(declared, fixture.tool ?? 'search', args)];
}

const rows = [];
for (const fixture of corpus.fixtures) {
  try {
    const [declared, verdict] = measure(fixture);
    rows.push({
      id: fixture.id,
      declared: declared.length,
      covered: declared.some((item) => item.policies.includes(fixture.policy)),
      caught: verdict.records.length > 0,
      deciding: verdict.deciding?.guardrail ?? null,
      actions: [...new Set(verdict.records.map((record) => record.action))].sort(),
    });
  } catch (error) {
    rows.push({
      id: fixture.id,
      error: (error?.constructor?.name ?? 'Error') + ': ' + error?.message,
    });
  }
}

process.stdout.write(JSON.stringify({ rows }));
`;

/** The driver with its two absolute paths spliced in, safely for any path text. */
function nodeGuardScript(corpusPath: string, modulePath: string): string {
  return NODE_GUARD_SCRIPT.replace('CORPUS_PATH', () => JSON.stringify(corpusPath)).replace(
    'MODULE_PATH',
    () => JSON.stringify(modulePath),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStage(value: unknown): value is GuardStage {
  return typeof value === 'string' && (GUARD_STAGES as readonly string[]).includes(value);
}

/** A rate or a count the corpus declares, or the default when it declares nothing sane. */
function numberField(
  source: Record<string, unknown>,
  key: string,
  fallback: number,
  bounds: { readonly min: number; readonly max: number; readonly integer: boolean },
  problems: string[],
  at: string,
): number {
  const raw = source[key];
  if (raw === undefined) return fallback;
  if (
    typeof raw !== 'number' ||
    !Number.isFinite(raw) ||
    raw < bounds.min ||
    raw > bounds.max ||
    (bounds.integer && !Number.isInteger(raw))
  ) {
    problems.push(`${at}.${key} must be a number between ${bounds.min} and ${bounds.max}`);
    return fallback;
  }
  return raw;
}

type CorpusRead =
  | { readonly ok: true; readonly corpus: Corpus }
  | { readonly ok: false; readonly diagnostics: readonly CliDiagnostic[] };

/**
 * The corpus to measure against: the one named, or the first conventional location that
 * holds one. Both are repo-relative, like every path the CLI takes.
 */
function locateCorpus(
  cwd: string,
  specPath: string,
  named: string | undefined,
): string | undefined {
  if (named !== undefined) return named;
  const candidates = [`${parentPath(specPath)}/redteam.json`, 'redteam.json'];
  return candidates.find((candidate) => existsSync(absolutePath(cwd, candidate)));
}

function readCorpus(context: CliContext, specPath: string, named: string | undefined): CorpusRead {
  const path = locateCorpus(context.cwd, specPath, named);

  if (path === undefined) {
    return {
      ok: false,
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.redTeamMissing,
          message: `\`aid guard\` needs a corpus, and found none beside the spec or at the project root.`,
          hint: 'Pass `--red-team <file>`; see `runtimes/python/tests/redteam/fixtures.json` for the format.',
        }),
      ],
    };
  }

  let text: string;
  try {
    text = readFileSync(absolutePath(context.cwd, path), 'utf8');
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.redTeamMissing,
          message: `Cannot read the corpus at "${path}": ${error instanceof Error ? error.message : String(error)}.`,
          path: [path],
        }),
      ],
    };
  }

  const problems: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.redTeamMalformed,
          message: `The corpus at "${path}" is not JSON: ${message}.`,
          path: [path],
        }),
      ],
    };
  }

  if (!isRecord(parsed)) {
    problems.push('the document must be an object');
  }

  const corpus = isRecord(parsed) ? parsed : {};
  if (corpus.version !== 1) problems.push('`version` must be 1');

  const rawFixtures = corpus.fixtures;
  const entries = Array.isArray(rawFixtures) ? rawFixtures : [];
  if (!Array.isArray(rawFixtures)) problems.push('`fixtures` must be an array');
  else if (entries.length === 0) problems.push('`fixtures` must not be empty');

  const fixtures: Fixture[] = [];
  const seen = new Set<string>();

  for (const [index, entry] of entries.entries()) {
    const at = `fixtures[${index}]`;
    if (!isRecord(entry)) {
      problems.push(`${at} must be an object`);
      continue;
    }

    const id = entry.id;
    if (typeof id !== 'string' || id.trim() === '') {
      problems.push(`${at}.id must be a non-empty string`);
      continue;
    }
    if (seen.has(id)) {
      problems.push(`${at}.id repeats "${id}"; ids are how a row is matched to a fixture`);
      continue;
    }
    seen.add(id);

    const stage = entry.stage;
    if (!isStage(stage)) {
      problems.push(`${at}.stage must be one of ${GUARD_STAGES.join(', ')}`);
      continue;
    }

    const policy = entry.policy;
    if (typeof policy !== 'string' || policy.trim() === '') {
      problems.push(`${at}.policy must be a non-empty string`);
      continue;
    }

    const knownBad = entry.known_bad;
    if (typeof knownBad !== 'boolean') {
      problems.push(`${at}.known_bad must be true or false`);
      continue;
    }

    // `expect` restates `known_bad`. When the two disagree the fixture is ambiguous, and
    // silently preferring one would measure an intent the author did not have.
    const expect = entry.expect;
    const expected = knownBad ? 'caught' : 'clean';
    if (expect !== undefined && expect !== expected) {
      problems.push(`${at}.expect is "${String(expect)}" but known_bad says "${expected}"`);
      continue;
    }

    const text = entry.text;
    const args = entry.arguments;
    const tool = entry.tool;

    if (stage === 'tool-call') {
      if (args !== undefined && !isRecord(args)) {
        problems.push(`${at}.arguments must be an object`);
        continue;
      }
      if (tool !== undefined && (typeof tool !== 'string' || tool.trim() === '')) {
        problems.push(`${at}.tool must be a non-empty string`);
        continue;
      }
    } else if (typeof text !== 'string') {
      problems.push(`${at}.text must be a string for the ${stage} stage`);
      continue;
    }

    fixtures.push({
      id,
      stage,
      policy,
      knownBad,
      text: typeof text === 'string' ? text : '',
      arguments: isRecord(args) ? args : undefined,
      tool: typeof tool === 'string' ? tool : undefined,
    });
  }

  if (problems.length > 0) {
    return {
      ok: false,
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.redTeamMalformed,
          message: `The corpus at "${path}" is not a corpus: ${problems.slice(0, 8).join('; ')}${problems.length > 8 ? `; and ${problems.length - 8} more` : ''}.`,
          path: [path],
          hint: 'See `runtimes/python/tests/redteam/fixtures.json`: version 1, a `fixtures` array, and one stage and policy per fixture.',
        }),
      ],
    };
  }

  const declared: Record<string, unknown> = isRecord(corpus.threshold) ? corpus.threshold : {};
  const thresholds: Thresholds = {
    recall: numberField(
      declared,
      'recall',
      1,
      { min: 0, max: 1, integer: false },
      problems,
      'threshold',
    ),
    falsePositiveRate: numberField(
      declared,
      'false_positive_rate',
      0,
      { min: 0, max: 1, integer: false },
      problems,
      'threshold',
    ),
    knownBadMinimum: numberField(
      declared,
      'known_bad_minimum',
      0,
      { min: 0, max: Number.MAX_SAFE_INTEGER, integer: true },
      problems,
      'threshold',
    ),
    benignMinimum: numberField(
      declared,
      'benign_minimum',
      0,
      { min: 0, max: Number.MAX_SAFE_INTEGER, integer: true },
      problems,
      'threshold',
    ),
  };

  // A threshold that is not a number between its bounds is a corpus the author did not
  // mean, and defaulting past it would measure against a gate nobody declared.
  if (problems.length > 0) {
    return {
      ok: false,
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.redTeamMalformed,
          message: `The corpus at "${path}" declares a threshold this command cannot read: ${problems.join('; ')}.`,
          path: [path],
        }),
      ],
    };
  }

  return { ok: true, corpus: { path, fixtures, thresholds } };
}

function verdictOf(knownBad: boolean, caught: boolean): GuardVerdict {
  if (knownBad) return caught ? 'caught' : 'missed';
  return caught ? 'false-positive' : 'clean';
}

/** Failures first, so the table reads as a to-do list rather than a report card. */
const VERDICT_RANK: Readonly<Record<GuardVerdict, number>> = {
  missed: 0,
  'false-positive': 1,
  caught: 2,
  clean: 3,
};

function formatRate(value: number): string {
  return value.toFixed(3);
}

/** `by message_injection`, or the actions when nothing alone decided the verdict. */
function describeCatch(row: ResultRow): string {
  if (row.deciding !== undefined) return `by ${row.deciding}`;
  if (row.actions.length > 0) return `(${row.actions.join(', ')})`;
  return '';
}

export function guard(context: CliContext, options: GuardOptions): CommandOutcome {
  const command = 'guard';

  const target = resolveTarget(options.target);
  if (target === undefined) {
    return outcome({
      command,
      exitCode: EXIT_USAGE,
      diagnostics: [unknownTargetDiagnostic(options.target ?? '')],
    });
  }

  const specPath = options.spec ?? target.specPath;
  const named = { target: target.name, spec: specPath };

  // Which program imports the table is the target's business; both drivers report the
  // same rows, so nothing below this block branches on the language again.
  const surface = target.guard;

  const read = readCorpus(context, specPath, options.redTeam);
  if (!read.ok) {
    return outcome({
      command,
      exitCode: EXIT_USAGE,
      fields: { ...named, corpus: options.redTeam ?? null },
      diagnostics: read.diagnostics,
    });
  }
  const corpus = read.corpus;
  const fields = { ...named, corpus: corpus.path };

  const spec = readSpec(context, specPath);
  if (!spec.ok) {
    return outcome({
      command,
      exitCode: EXIT_FAILURE,
      fields,
      diagnostics: spec.diagnostics,
    });
  }

  const lowered = lowerSpec(spec.text, specPath);
  if (!lowered.ok) {
    return outcome({
      command,
      exitCode: EXIT_FAILURE,
      fields,
      diagnostics: lowered.diagnostics,
    });
  }

  const declarations = lowered.ir.guardrails ?? [];
  if (declarations.length === 0) {
    return outcome({
      command,
      exitCode: EXIT_FAILURE,
      fields: {
        ...fields,
        declarations: [],
        fixtures: corpus.fixtures.length,
        passed: false,
      },
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.guardNotDeclared,
          message: `The spec at "${specPath}" declares no guardrails, so none of the ${corpus.fixtures.length} fixtures could be caught.`,
          path: [specPath],
          hint: 'Add a `guardrails:` section naming the policies the corpus exercises, then run `aid gen` and `aid guard` again.',
        }),
      ],
    });
  }

  if (!existsSync(absolutePath(context.cwd, surface.file))) {
    return outcome({
      command,
      exitCode: EXIT_FAILURE,
      fields,
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.guardModuleMissing,
          message: `The spec declares ${declarations.length} guardrail(s), but this tree has no ${surface.file}.`,
          path: [surface.file],
          hint: 'Run `aid gen`: this command measures the table the generator emitted, and a missing one means the tree predates the spec.',
        }),
      ],
    });
  }

  let driver: string;
  let run: SpawnResult | undefined;
  if (surface.runner === 'python') {
    const interpreter = discoverInterpreter(context);
    if (interpreter === undefined) {
      return outcome({
        command,
        // Exit 2, not 1: nothing about the project was judged. The corpus cannot run
        // without the runtime, so there is no recall to report and no gate to fail.
        exitCode: EXIT_USAGE,
        fields,
        diagnostics: [
          cliError({
            code: CLI_DIAGNOSTIC_CODES.pythonMissing,
            message: `No interpreter could import aid_runtime (tried ${INTERPRETERS.join(', ')}).`,
            hint: 'Install the runtime into the interpreter you run with, or measure the corpus yourself.',
          }),
        ],
      });
    }
    driver = interpreter;
    run = invoke(
      context,
      [...interpreterCommand(interpreter), '-', corpus.path, surface.module],
      GUARD_SCRIPT,
    );
  } else {
    driver = NODE;
    run = invokeNode(
      context,
      nodeGuardScript(
        absolutePath(context.cwd, corpus.path),
        absolutePath(context.cwd, surface.file),
      ),
    );
  }

  if (run === undefined) {
    return outcome({
      command,
      exitCode: EXIT_USAGE,
      fields: { ...fields, driver },
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.runnerFailed,
          message: `Could not start ${driver} to measure "${surface.file}".`,
        }),
      ],
    });
  }

  if (run.status !== 0) {
    return outcome({
      command,
      exitCode: EXIT_FAILURE,
      fields: { ...fields, driver },
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.runnerFailed,
          message: `Measuring "${surface.file}" with ${driver} exited ${run.status ?? 'without a status'}.`,
          hint: "The table could not be imported or a declaration failed to evaluate; the driver's own output says which.",
        }),
      ],
      stderr: run.stderr,
    });
  }

  let rows: RunnerRow[];
  try {
    const parsed: unknown = JSON.parse(run.stdout);
    const reported = isRecord(parsed) ? parsed.rows : undefined;
    if (!Array.isArray(reported)) throw new Error('no `rows` array');
    rows = reported.filter((row): row is RunnerRow => isRecord(row) && typeof row.id === 'string');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return outcome({
      command,
      exitCode: EXIT_FAILURE,
      fields: { ...fields, driver },
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.runnerFailed,
          message: `The measurement did not come back as JSON: ${message}.`,
        }),
      ],
      text: run.stdout.trimEnd(),
      stderr: run.stderr,
    });
  }

  const reported = new Map(rows.map((row) => [row.id, row]));
  const results: ResultRow[] = corpus.fixtures.map((fixture) => {
    const row = reported.get(fixture.id);
    if (row === undefined) {
      return {
        ...fixture,
        caught: false,
        covered: false,
        deciding: undefined,
        actions: [],
        verdict: verdictOf(fixture.knownBad, false),
        error: 'the driver reported no row for this fixture',
      };
    }
    const caught = row.caught === true;
    return {
      ...fixture,
      caught,
      covered: row.covered === true,
      deciding: typeof row.deciding === 'string' ? row.deciding : undefined,
      actions: Array.isArray(row.actions)
        ? row.actions.filter((action): action is string => typeof action === 'string')
        : [],
      verdict: verdictOf(fixture.knownBad, caught),
      error: typeof row.error === 'string' ? row.error : undefined,
    };
  });

  const knownBad = results.filter((row) => row.knownBad);
  const benign = results.filter((row) => !row.knownBad);
  const caught = knownBad.filter((row) => row.caught).length;
  const falsePositives = benign.filter((row) => row.caught).length;
  const recall = knownBad.length === 0 ? 1 : caught / knownBad.length;
  const falsePositiveRate = benign.length === 0 ? 0 : falsePositives / benign.length;

  const uncovered = [
    ...new Set(results.filter((row) => !row.covered).map((row) => `${row.stage}/${row.policy}`)),
  ].sort();

  const diagnostics: CliDiagnostic[] = [...lowered.diagnostics];
  const failures: string[] = [];

  const errors = results.filter((row) => row.error !== undefined);
  for (const row of errors) {
    diagnostics.push(
      cliError({
        code: CLI_DIAGNOSTIC_CODES.guardFixtureError,
        message: `"${row.id}" could not be measured: ${row.error ?? 'unknown error'}.`,
        path: [corpus.path],
      }),
    );
  }
  if (errors.length > 0) failures.push('a fixture could not be measured');

  const missed = knownBad.filter((row) => !row.caught);
  if (missed.length > 0) {
    diagnostics.push(
      cliError({
        code: CLI_DIAGNOSTIC_CODES.guardRecall,
        message: `Recall ${formatRate(recall)} (${caught}/${knownBad.length}) is below the required ${formatRate(corpus.thresholds.recall)}: ${missed
          .slice(0, 5)
          .map((row) => `"${row.id}" (${row.stage}/${row.policy})`)
          .join(', ')}${missed.length > 5 ? `, and ${missed.length - 5} more` : ''}.`,
        path: [corpus.path],
        hint:
          uncovered.length > 0
            ? `No guardrail declares ${uncovered.slice(0, 4).join(', ')}; adding one would catch these before tightening detection.`
            : 'The declarations cover these policies but the detectors did not match; these are the cases the heuristics miss.',
      }),
    );
    failures.push(`${missed.length} known-bad fixture(s) were not caught`);
  }

  if (falsePositives > 0) {
    diagnostics.push(
      cliError({
        code: CLI_DIAGNOSTIC_CODES.guardFalsePositives,
        message: `False positive rate ${formatRate(falsePositiveRate)} (${falsePositives}/${benign.length}) exceeds the tolerated ${formatRate(corpus.thresholds.falsePositiveRate)}: ${benign
          .filter((row) => row.caught)
          .slice(0, 5)
          .map((row) => `"${row.id}"`)
          .join(', ')}.`,
        path: [corpus.path],
        hint: 'A benign payload the table blocks is a user the app turns away; narrow the policy that fires on it.',
      }),
    );
    failures.push(`${falsePositives} benign fixture(s) were flagged`);
  }

  if (knownBad.length < corpus.thresholds.knownBadMinimum) {
    diagnostics.push(
      cliError({
        code: CLI_DIAGNOSTIC_CODES.redTeamTooSmall,
        message: `The corpus carries ${knownBad.length} known-bad fixture(s) and asks for at least ${corpus.thresholds.knownBadMinimum}.`,
        path: [corpus.path],
        hint: 'A recall computed from this few fixtures is not a gate; add fixtures or lower the corpus minimum.',
      }),
    );
    failures.push('the corpus is too small to judge');
  }

  if (benign.length < corpus.thresholds.benignMinimum) {
    diagnostics.push(
      cliError({
        code: CLI_DIAGNOSTIC_CODES.redTeamTooSmall,
        message: `The corpus carries ${benign.length} benign fixture(s) and asks for at least ${corpus.thresholds.benignMinimum}.`,
        path: [corpus.path],
        hint: 'A false-positive rate computed from this few fixtures is not a gate; add fixtures or lower the corpus minimum.',
      }),
    );
    failures.push('the corpus is too small to judge');
  }

  if (uncovered.length > 0) {
    diagnostics.push(
      cliWarning({
        code: CLI_DIAGNOSTIC_CODES.guardPolicyUndeclared,
        message: `The corpus exercises ${uncovered.join(', ')}, which no guardrail declares at that stage.`,
        hint: 'Those fixtures can only be caught by a declaration naming their policy at their stage.',
      }),
    );
  }

  const ordered = [...results].sort((left, right) => {
    const rank = VERDICT_RANK[left.verdict] - VERDICT_RANK[right.verdict];
    return rank !== 0 ? rank : left.id.localeCompare(right.id);
  });

  const idWidth = Math.max(2, ...results.map((row) => row.id.length));
  const policyWidth = Math.max(6, ...results.map((row) => row.policy.length));

  const lines: string[] = [
    `corpus: ${corpus.path} (${knownBad.length} known-bad, ${benign.length} benign)`,
    `declarations: ${declarations.length} guardrail(s) -- ${declarations
      .map((entry) => `${entry.id} (${entry.stages.join(', ')})`)
      .join('; ')}`,
    '',
    `  ${'id'.padEnd(idWidth)}  ${'stage'.padEnd(9)}  ${'policy'.padEnd(policyWidth)}  outcome`,
  ];

  for (const row of ordered) {
    const described =
      row.error !== undefined
        ? `error: ${row.error}`
        : row.verdict === 'caught' || row.verdict === 'false-positive'
          ? `${row.verdict} ${describeCatch(row)}`.trimEnd()
          : row.verdict;
    lines.push(
      `  ${row.id.padEnd(idWidth)}  ${row.stage.padEnd(9)}  ${row.policy.padEnd(policyWidth)}  ${described}`,
    );
  }

  if (uncovered.length > 0) {
    lines.push('', `undeclared: ${uncovered.join(', ')}`);
  }

  lines.push(
    '',
    `recall ${formatRate(recall)} (${caught}/${knownBad.length} known-bad caught), false positives ${formatRate(falsePositiveRate)} (${falsePositives}/${benign.length} benign)`,
    `required: recall >= ${formatRate(corpus.thresholds.recall)}, false positive rate <= ${formatRate(corpus.thresholds.falsePositiveRate)}`,
    failures.length === 0 ? 'guard: ok' : `guard: FAILED (${failures.join('; ')})`,
  );

  const passed = failures.length === 0;

  return outcome({
    command,
    exitCode: passed ? EXIT_OK : EXIT_FAILURE,
    fields: {
      ...fields,
      driver,
      declarations: declarations.map((entry) => ({
        id: entry.id,
        stages: entry.stages,
        policies: entry.policies,
        action: entry.action,
      })),
      fixtures: results.length,
      knownBad: knownBad.length,
      benign: benign.length,
      caught,
      missed: missed.length,
      falsePositives,
      recall: Number(recall.toFixed(4)),
      falsePositiveRate: Number(falsePositiveRate.toFixed(4)),
      thresholds: corpus.thresholds,
      uncovered,
      passed,
      rows: results.map((row) => ({
        id: row.id,
        stage: row.stage,
        policy: row.policy,
        knownBad: row.knownBad,
        caught: row.caught,
        covered: row.covered,
        verdict: row.verdict,
        deciding: row.deciding ?? null,
        actions: row.actions,
        ...(row.error === undefined ? {} : { error: row.error }),
      })),
    },
    diagnostics: sortDiagnostics(diagnostics),
    text: lines.join('\n'),
    stderr: run.stderr,
  });
}
