/**
 * `aid ingest` -- run the generated ingest entry point for a retriever's corpus.
 *
 * **What this shells out to, and why.** Indexing is a batch job, not a request, so the
 * generator emits one runnable module per declared retriever at
 * `app/generated/retrieval/ingest/<id>.py`, with a `main()` that chunks, embeds and writes
 * the corpus. That module is the interface: it already knows the chunking and the store the
 * spec declared, and re-deriving either here would be a second implementation of the
 * runtime's rules. So the command runs `python -m app.generated.retrieval.ingest.<id>` from
 * the project root, which is also what a person would type by hand.
 *
 * **The flag shape is a usage error, not a project verdict.** `--retriever` and `--all` are
 * the two ways to say what to ingest; passing both, or neither, is a mistake in the
 * invocation and exits 2 before the spec is even read. An id the spec does not declare is
 * the same kind of mistake, and its message names the ids that do exist -- a typo should
 * not require opening the spec.
 *
 * **A missing module is a failure, not a usage error.** `--retriever handbook` in a project
 * that has never been generated is a well-formed command that cannot do its job; it exits 1
 * and points at `aid gen`. Exit 2 would tell a script that it passed the wrong arguments,
 * which is false and hides the one action that fixes it.
 *
 * **`--dry-run` is forwarded, not implemented here.** The generated module already grows
 * its own `--dry-run`, which applies the chunker and reports the counts a real run would
 * write without opening a store or calling an embedder. Answering the same question in
 * the CLI would mean re-chunking the corpus, and a second dry run that drifted from the
 * one the module performs is worse than no dry run at all.
 *
 * **Idempotence is the runtime's, not a rescan this command performs.** A chunk id is a
 * content hash, and the store upserts on it, so a second run over unchanged documents
 * replaces rather than appends. The CLI adds no diffing of its own: it would have to
 * reimplement the chunker to know what changed.
 */

import { existsSync } from 'node:fs';

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

export interface IngestOptions {
  readonly spec: string | undefined;
  readonly target: string | undefined;
  readonly retriever: string | undefined;
  readonly all: boolean;
  readonly dryRun: boolean;
}

interface IngestResult {
  readonly retriever: string;
  readonly module: string;
  readonly status: number;
}

/** `Declared retrievers: a, b.`, or the truth when there are none. */
function declaredHint(ids: readonly string[]): string {
  return ids.length > 0
    ? `Declared retrievers: ${ids.join(', ')}.`
    : 'The spec declares no retrievers.';
}

/**
 * The human rendering. One retriever prints the module's own report; several get a heading
 * each, because two unlabelled "wrote N chunks" lines cannot be told apart.
 */
function render(results: readonly IngestResult[], stdout: readonly string[]): string {
  const blocks = results.map((result, index) => {
    const body = stdout[index]?.trimEnd() ?? '';
    if (results.length === 1) return body;
    return [`==> ${result.retriever}`, body].filter((line) => line !== '').join('\n');
  });
  return blocks.filter((block) => block !== '').join('\n');
}

/** The `--retriever`/`--all` shape, which is decided without reading the project. */
function checkFlagShape(options: IngestOptions): CliDiagnostic | undefined {
  if (options.retriever !== undefined && options.all) {
    return cliError({
      code: CLI_DIAGNOSTIC_CODES.retrieverConflict,
      message: '`--retriever` and `--all` say two different things; pass one of them.',
      hint: 'Use `--retriever <id>` for one retriever, or `--all` for every retriever the spec declares.',
    });
  }
  if (options.retriever === undefined && !options.all) {
    return cliError({
      code: CLI_DIAGNOSTIC_CODES.retrieverRequired,
      message: '`aid ingest` needs `--retriever <id>` or `--all`.',
      hint: 'Use `--all` to ingest every retriever the spec declares.',
    });
  }
  return undefined;
}

export function ingest(context: CliContext, options: IngestOptions): CommandOutcome {
  const command = 'ingest';
  const target = resolveTarget(options.target);
  if (target === undefined) {
    return outcome({
      command,
      exitCode: EXIT_USAGE,
      diagnostics: [unknownTargetDiagnostic(options.target ?? '')],
    });
  }

  // The flag shape is judged before the project is touched: an invocation that asks two
  // contradictory things is wrong whether or not the spec happens to be readable, and
  // reporting a spec problem instead would bury the actual mistake.
  const malformed = checkFlagShape(options);
  if (malformed !== undefined) {
    return outcome({ command, exitCode: EXIT_USAGE, diagnostics: [malformed] });
  }

  const specPath = options.spec ?? target.specPath;
  const fields = { target: target.name, spec: specPath };

  const read = readSpec(context, specPath);
  if (!read.ok) {
    return outcome({ command, exitCode: EXIT_FAILURE, fields, diagnostics: read.diagnostics });
  }

  const lowered = lowerSpec(read.text, specPath);
  if (!lowered.ok) {
    return outcome({ command, exitCode: EXIT_FAILURE, fields, diagnostics: lowered.diagnostics });
  }

  const declared: readonly string[] = lowered.ir.retrievers.map((entry) => entry.id);

  if (options.retriever !== undefined && !declared.includes(options.retriever)) {
    return outcome({
      command,
      exitCode: EXIT_USAGE,
      fields: { ...fields, retrievers: declared },
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.retrieverNotFound,
          message: `No retriever named "${options.retriever}" in ${specPath}.`,
          path: [specPath],
          hint: declaredHint(declared),
        }),
      ],
    });
  }

  // `--all` over a project that declares none is a well-formed request with nothing to do.
  // It is not an error: a generated app with no retrieval is a legitimate app, and making
  // its CI fail would force a `--retriever` that does not exist.
  const selected: readonly string[] =
    options.all || options.retriever === undefined ? declared : [options.retriever];
  const scoped = { ...fields, retrievers: selected };

  if (selected.length === 0) {
    return outcome({
      command,
      exitCode: EXIT_OK,
      fields: { ...scoped, results: [] },
      diagnostics: sortDiagnostics(lowered.diagnostics),
      text: 'No retrievers are declared; nothing to ingest.',
    });
  }

  // A declared retriever whose module is absent is a project that has not been generated,
  // not a misuse of the command. Checked before discovery so the message is about the
  // missing artefact rather than about the interpreter that would have run it.
  const missing = selected.filter(
    (id) => !existsSync(absolutePath(context.cwd, target.retrievalIngestModuleFile(id))),
  );
  if (missing.length > 0) {
    return outcome({
      command,
      exitCode: EXIT_FAILURE,
      fields: scoped,
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.ingestModulesMissing,
          message: `No generated ingest module for ${missing.map((id) => `"${id}"`).join(', ')}.`,
          path: missing.map((id) => target.retrievalIngestModuleFile(id)),
          hint: 'Run `aid gen`: the ingest entry points are the modules the generator emits.',
        }),
      ],
    });
  }

  if (target.runner !== 'python') {
    return outcome({
      command,
      // Exit 2, not 1: this command has no runner for this target, so nothing was
      // ingested and the corpus was not judged.
      exitCode: EXIT_USAGE,
      fields: scoped,
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.runnerUnsupported,
          message: `\`aid ingest\` runs generated Python modules, and ${target.name} emits TypeScript.`,
          hint: 'The emitted ingest module exports `ingest()`; run it with Node.',
        }),
      ],
    });
  }

  const interpreter = discoverInterpreter(context);
  if (interpreter === undefined) {
    return outcome({
      command,
      // Exit 2, not 1: nothing about the project was judged. Ingest has no verdict when the
      // thing that would run it cannot start, and `1` would read as "the corpus was wrong".
      exitCode: EXIT_USAGE,
      fields: scoped,
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.pythonMissing,
          message: `No interpreter could import aid_runtime (tried ${INTERPRETERS.join(', ')}).`,
          hint: 'Install the runtime into the interpreter you run with, or run the generated ingest modules yourself.',
        }),
      ],
    });
  }

  const base = interpreterCommand(interpreter);
  const results: IngestResult[] = [];
  const stdout: string[] = [];
  const spoken: string[] = [];
  const diagnostics: CliDiagnostic[] = [...lowered.diagnostics];

  for (const id of selected) {
    const module = target.retrievalIngestModule(id);
    // Appended after the module name so it lands as an argument to the module, which owns
    // what a dry run means -- see the header note.
    const run = invoke(context, [...base, '-m', module, ...(options.dryRun ? ['--dry-run'] : [])]);
    if (run === undefined) {
      return outcome({
        command,
        exitCode: EXIT_USAGE,
        fields: { ...scoped, interpreter },
        diagnostics: [
          cliError({
            code: CLI_DIAGNOSTIC_CODES.runnerFailed,
            message: `Could not start ${interpreter} to run "${module}".`,
          }),
        ],
      });
    }
    results.push({ retriever: id, module, status: run.status ?? EXIT_FAILURE });
    stdout.push(run.stdout);
    // The module reports what it could not ingest on stderr. It is surfaced rather than
    // swallowed, and on the CLI's stderr even under `--json`, because that is where the
    // process that wrote it wrote it.
    if (run.stderr.trim() !== '') {
      spoken.push(run.stderr.trimEnd());
      diagnostics.push(
        cliWarning({
          code: CLI_DIAGNOSTIC_CODES.runnerWarned,
          message: `"${id}" wrote to stderr.`,
        }),
      );
    }
  }

  // A non-zero exit from a generated module is that module's verdict, so it propagates.
  // Every selected retriever still runs: one corpus that could not be built should not
  // hide the state of the others.
  const failed = results.some((result) => result.status !== 0);

  return outcome({
    command,
    exitCode: failed ? EXIT_FAILURE : EXIT_OK,
    fields: { ...scoped, interpreter, results },
    diagnostics: sortDiagnostics(diagnostics),
    text: render(results, stdout),
    stderr: spoken.join('\n'),
  });
}
