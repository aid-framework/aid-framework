/**
 * `aid kb sync` -- ask the engine that owns a managed knowledge base to re-ingest it.
 *
 * **Why this exists at all.** A managed knowledge base ingests *inside* the engine, driven
 * by its data source, so the generator gives such a retriever no ingest module: there is
 * nothing for this process to chunk, embed or write. What is missing there is the ability
 * to *ask*, and that request is the operation a managed retriever has instead of `aid
 * ingest`. That is what this command makes.
 *
 * **What this shells out to, and why.** The generator emits one runnable module per managed
 * retriever at `app/generated/retrieval/sync/<id>.py`, with a `main()` that starts the
 * engine's ingestion job and -- under `--wait` -- follows it to the status the engine
 * reports. That module is the interface, exactly as it is for `aid ingest`: it knows which
 * knowledge base the retriever binds to, and re-deriving that here would be a second
 * implementation of the runtime's rules. So the command runs `python -m
 * app.generated.retrieval.sync.<id>` from the project root.
 *
 * **The flag shape is a usage error, not a project verdict.** `--retriever` and `--all` are
 * the two ways to say what to sync; passing both, or neither, is a mistake in the invocation
 * and exits 2 before the spec is read. A named retriever that is not managed is the same
 * kind of mistake: it has no engine-side job to start, and its corpus is written by `aid
 * ingest` instead. Exit 2 says "nothing was judged", which is true -- no corpus was
 * touched.
 *
 * **An engine that cannot be asked is a capability the runtime answers, not a fact restated
 * here.** Whether a provider exposes an ingestion job is knowledge about the provider, and
 * a CLI that hard-coded it would be the copy that goes stale. So the command asks
 * `aid_runtime.sync_support` and reports the runtime's own sentence, naming the provider.
 *
 * **A missing module is a failure, not a usage error.** `--all` in a project that has never
 * been generated is a well-formed command that cannot do its job; it exits 1 and points at
 * `aid gen`. Exit 2 would tell a script that it passed the wrong arguments, which is false
 * and hides the one action that fixes it.
 *
 * **`--all` over no managed retrievers is a well-formed request with nothing to do.** A
 * project whose retrieval is all local is a legitimate project, so this exits 0 with an
 * empty result rather than failing a CI job over a request that was satisfied by nothing.
 */

import { existsSync } from 'node:fs';

import { isManagedRetriever } from '@aid-framework/ir';
import { sortDiagnostics } from '@aid-framework/spec';

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

export interface KbOptions {
  readonly subcommand: string | undefined;
  readonly spec: string | undefined;
  readonly target: string | undefined;
  readonly retriever: string | undefined;
  readonly all: boolean;
  readonly wait: boolean;
}

interface KbSyncResult {
  readonly retriever: string;
  readonly engine: string;
  readonly module: string;
  readonly status: number;
}

const SUBCOMMANDS = ['sync'] as const;

/**
 * The question this command asks the runtime.
 *
 * `sync_support` is the runtime's own answer to "has this provider an ingestion job this
 * process can start", and `as_dict` is the shape it offers for a caller that cannot import
 * the module. Spelling the provider table out here instead would put a second copy of it
 * somewhere the day a provider changes has to be found twice.
 */
const SYNC_SUPPORT_PROBE = [
  'import json',
  'import sys',
  'from aid_runtime import sync_support',
  'print(json.dumps(sync_support(sys.argv[1]).as_dict()))',
].join('\n');

/** `Declared managed retrievers: a, b.`, or the truth when there are none. */
function declaredHint(ids: readonly string[]): string {
  return ids.length > 0
    ? `Declared managed retrievers: ${ids.join(', ')}.`
    : 'The spec declares no managed retrievers.';
}

/**
 * The human rendering. One retriever prints the module's own report; several get a heading
 * each, because two unlabelled "job ...: COMPLETE" lines cannot be told apart.
 */
function render(results: readonly KbSyncResult[], stdout: readonly string[]): string {
  const blocks = results.map((result, index) => {
    const body = stdout[index]?.trimEnd() ?? '';
    if (results.length === 1) return body;
    return [`==> ${result.retriever}`, body].filter((line) => line !== '').join('\n');
  });
  return blocks.filter((block) => block !== '').join('\n');
}

/** The `--retriever`/`--all` shape, which is decided without reading the project. */
function checkFlagShape(options: KbOptions): CliDiagnostic | undefined {
  if (options.retriever !== undefined && options.all) {
    return cliError({
      code: CLI_DIAGNOSTIC_CODES.retrieverConflict,
      message: '`--retriever` and `--all` say two different things; pass one of them.',
      hint: 'Use `--retriever <id>` for one retriever, or `--all` for every managed retriever the spec declares.',
    });
  }
  if (options.retriever === undefined && !options.all) {
    return cliError({
      code: CLI_DIAGNOSTIC_CODES.retrieverRequired,
      message: '`aid kb sync` needs `--retriever <id>` or `--all`.',
      hint: 'Use `--all` to sync every managed retriever the spec declares.',
    });
  }
  return undefined;
}

/**
 * What the runtime says about one engine, or `undefined` when it could not be asked.
 *
 * A probe that fails is not a verdict: the runtime is the authority, and a run that could
 * not reach it is better off letting the generated module raise its own, identical refusal
 * than inventing one here.
 */
function probeSyncSupport(
  context: CliContext,
  base: readonly string[],
  engine: string,
): { supported: boolean; reason: string | undefined } | undefined {
  const run = invoke(context, [...base, '-c', SYNC_SUPPORT_PROBE, engine]);
  if (run === undefined || (run.status ?? EXIT_FAILURE) !== 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(run.stdout.trim());
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const record = parsed as { supported?: unknown; reason?: unknown };
    if (typeof record.supported !== 'boolean') return undefined;
    return {
      supported: record.supported,
      reason: typeof record.reason === 'string' ? record.reason : undefined,
    };
  } catch {
    return undefined;
  }
}

export function kb(context: CliContext, options: KbOptions): CommandOutcome {
  const command = 'kb';

  if (options.subcommand === undefined) {
    return outcome({
      command,
      exitCode: EXIT_USAGE,
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.kbSubcommandRequired,
          message: '`aid kb` needs a subcommand.',
          hint: `Use one of: ${SUBCOMMANDS.join(', ')}.`,
        }),
      ],
    });
  }

  if (!(SUBCOMMANDS as readonly string[]).includes(options.subcommand)) {
    return outcome({
      command,
      exitCode: EXIT_USAGE,
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.kbUnknownSubcommand,
          message: `Unknown subcommand "${options.subcommand}".`,
          hint: `Use one of: ${SUBCOMMANDS.join(', ')}.`,
        }),
      ],
    });
  }

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
  const managed: readonly string[] = lowered.ir.retrievers
    .filter(isManagedRetriever)
    .map((entry) => entry.id);

  /** The engine that owns one managed retriever's corpus, resolved through the base it names. */
  const engineOf = (retrieverId: string): string => {
    const retriever = lowered.ir.retrievers.find((entry) => entry.id === retrieverId);
    if (retriever === undefined || !isManagedRetriever(retriever)) return 'unknown';
    const base = lowered.ir.knowledgeBases.find((entry) => entry.id === retriever.knowledgeBase);
    return base?.engine ?? 'unknown';
  };

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
          hint: declaredHint(managed),
        }),
      ],
    });
  }

  // A retriever this command cannot sync is a usage error, not a failed run: the spec says
  // its corpus is written here by `aid ingest`, so there is no engine-side job to start and
  // nothing was judged. Its counterpart -- a managed retriever on an engine with no job --
  // is refused below, once the runtime has been asked.
  if (options.retriever !== undefined && !managed.includes(options.retriever)) {
    return outcome({
      command,
      exitCode: EXIT_USAGE,
      fields: { ...fields, retrievers: managed },
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.kbRetrieverNotManaged,
          message: `"${options.retriever}" is a local retriever: its corpus is written by this process, not by a knowledge base.`,
          hint:
            `Sync is what a managed retriever has instead of ingest; use ` +
            `\`aid ingest --retriever ${options.retriever}\` for this one.`,
        }),
      ],
    });
  }

  // `--all` over a project that declares no managed retriever is a well-formed request with
  // nothing to do. It is not an error: a project whose retrieval is all local is a
  // legitimate project, and making its CI fail would force a `--retriever` that cannot work.
  const selected: readonly string[] =
    options.retriever === undefined ? managed : [options.retriever];
  const scoped = { ...fields, retrievers: selected };

  if (selected.length === 0) {
    return outcome({
      command,
      exitCode: EXIT_OK,
      fields: { ...scoped, results: [] },
      diagnostics: sortDiagnostics(lowered.diagnostics),
      text: 'No managed retrievers are declared; nothing to sync.',
    });
  }

  // A target that emits TypeScript has no sync module this command could run, and `aid gen`
  // will never produce one -- so this is judged before the module check below, whose whole
  // remedy is "run `aid gen`". Reporting a missing artefact here would point at a command
  // that cannot create it.
  if (target.runner !== 'python') {
    return outcome({
      command,
      // Exit 2, not 1: this command has no runner for this target, so nothing was
      // ingested and no corpus was judged.
      exitCode: EXIT_USAGE,
      fields: scoped,
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.runnerUnsupported,
          message: `\`aid kb sync\` runs generated Python modules, and ${target.name} emits TypeScript.`,
          hint: 'The emitted sync module is a Python entry point; run it with an interpreter that has aid_runtime installed.',
        }),
      ],
    });
  }

  // A declared retriever whose module is absent is a project that has not been generated,
  // not a misuse of the command. Checked before discovery so the message is about the
  // missing artefact rather than about the interpreter that would have run it.
  const missing = selected.filter(
    (id) => !existsSync(absolutePath(context.cwd, target.retrievalSyncModuleFile(id))),
  );
  if (missing.length > 0) {
    return outcome({
      command,
      exitCode: EXIT_FAILURE,
      fields: scoped,
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.kbSyncModulesMissing,
          message: `No generated sync module for ${missing.map((id) => `"${id}"`).join(', ')}.`,
          path: missing.map((id) => target.retrievalSyncModuleFile(id)),
          hint: 'Run `aid gen`: the sync entry points are the modules the generator emits.',
        }),
      ],
    });
  }

  const interpreter = discoverInterpreter(context);
  if (interpreter === undefined) {
    return outcome({
      command,
      // Exit 2, not 1: nothing about the project was judged. Sync has no verdict when the
      // thing that would run it cannot start, and `1` would read as "the job failed".
      exitCode: EXIT_USAGE,
      fields: scoped,
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.pythonMissing,
          message: `No interpreter could import aid_runtime (tried ${INTERPRETERS.join(', ')}).`,
          hint: 'Install the runtime into the interpreter you run with, or run the generated sync modules yourself.',
        }),
      ],
    });
  }

  const base = interpreterCommand(interpreter);

  // An engine with no ingestion job is refused for the whole selection rather than per
  // retriever: `--all` named a set that includes one impossible member, so the request as
  // stated cannot be satisfied, and starting the others would leave the corpus half synced
  // under a command that reported success.
  for (const id of selected) {
    const engine = engineOf(id);
    if (engine === 'unknown') continue;
    const support = probeSyncSupport(context, base, engine);
    if (support === undefined || support.supported) continue;
    return outcome({
      command,
      exitCode: EXIT_USAGE,
      fields: scoped,
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.kbEngineUnsupported,
          message: `"${id}" reads a knowledge base on ${engine}, which has no ingestion job to start.`,
          hint: support.reason,
        }),
      ],
    });
  }

  const results: KbSyncResult[] = [];
  const stdout: string[] = [];
  const spoken: string[] = [];
  const diagnostics: CliDiagnostic[] = [...lowered.diagnostics];

  for (const id of selected) {
    const module = target.retrievalSyncModule(id);
    // Appended after the module name so it lands as an argument to the module, which owns
    // what waiting means -- see the header note.
    const run = invoke(context, [...base, '-m', module, ...(options.wait ? ['--wait'] : [])]);
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
    results.push({
      retriever: id,
      engine: engineOf(id),
      module,
      status: run.status ?? EXIT_FAILURE,
    });
    stdout.push(run.stdout);
    // The module reports what the engine refused, or why a job failed, on stderr. It is
    // surfaced rather than swallowed, and on the CLI's stderr even under `--json`, because
    // that is where the process that wrote it wrote it.
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

  // A non-zero exit from a generated module is that module's verdict -- a job the engine
  // reported as failed, or one it refused to start -- so it propagates. Every selected
  // retriever still runs: one corpus that could not be rebuilt should not hide the state
  // of the others.
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
