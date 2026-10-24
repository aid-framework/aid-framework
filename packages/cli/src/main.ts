/**
 * The dispatcher: argv in, exit code out.
 *
 * It is a pure function of the argv and a `CliContext`, so the whole CLI can be driven in
 * a test by calling `run([...], context)` against a temporary directory and asserting on
 * the captured streams -- no subprocess, no `process.exit`, no spawning the built binary
 * to find out what a flag does.
 *
 * `run` decides only what is genuinely global: which command, whether the invocation was
 * well formed, whether help was asked for, and how an unforeseen exception maps onto an
 * exit code. Everything else belongs to the command, which is why each entry in the table
 * below is a two-line adapter and not a flag handler.
 */

import type { ParsedArguments } from './args.js';
import { booleanFlag, JSON_FLAG, parseArguments, valueFlag } from './args.js';
import { evaluate } from './commands/eval.js';
import { generate } from './commands/gen.js';
import { ingest } from './commands/ingest.js';
import { init } from './commands/init.js';
import { validate } from './commands/validate.js';
import type { CliContext } from './context.js';
import type { ExitCode } from './exit.js';
import { EXIT_OK, EXIT_USAGE } from './exit.js';
import type { CommandOutcome } from './output.js';
import { emit } from './output.js';
import { targetNames } from './targets.js';
import type { CommandSpec } from './usage.js';
import { commandUsage, globalUsage } from './usage.js';

interface Command extends CommandSpec {
  readonly run: (context: CliContext, args: ParsedArguments) => CommandOutcome;
}

const TARGET_FLAG = valueFlag(
  'target',
  'name',
  `generator target; one of ${targetNames().join(', ')}`,
);

export const COMMANDS: readonly Command[] = [
  {
    name: 'init',
    summary: 'scaffold a project: a starter spec and a README',
    usage: 'init [dir] [--from <spec>] [--target <name>] [--force] [--gen]',
    flags: [
      valueFlag('from', 'spec', 'import an existing spec instead of writing the starter'),
      TARGET_FLAG,
      booleanFlag('force', 'replace a spec or README that is already there'),
      booleanFlag('gen', 'generate immediately after scaffolding'),
      JSON_FLAG,
    ],
    run: (context, args) =>
      init(context, {
        dir: args.positionals[0],
        from: args.values.get('from'),
        target: args.values.get('target'),
        force: args.booleans.has('force'),
        gen: args.booleans.has('gen'),
      }),
  },
  {
    name: 'validate',
    summary: 'parse the spec, build the IR, and run every build-time gate',
    usage: 'validate [spec]',
    flags: [JSON_FLAG],
    run: (context, args) => validate(context, { spec: args.positionals[0] }),
  },
  {
    name: 'gen',
    summary: 'compile the spec and reconcile the tree with it',
    usage: 'gen [spec] [--target <name>] [--dry-run] [--force]',
    flags: [
      TARGET_FLAG,
      booleanFlag('dry-run', 'report what would change, and write nothing'),
      booleanFlag('force', 'overwrite generated files that were edited by hand'),
      JSON_FLAG,
    ],
    run: (context, args) =>
      generate(context, {
        spec: args.positionals[0],
        target: args.values.get('target'),
        dryRun: args.booleans.has('dry-run'),
        force: args.booleans.has('force'),
      }),
  },
  {
    name: 'ingest',
    summary: 'index a retriever corpus into the store the spec declares',
    usage: 'ingest [spec] [--target <name>] [--retriever <id> | --all] [--dry-run]',
    flags: [
      valueFlag('retriever', 'id', 'ingest one declared retriever, by the id the spec used'),
      booleanFlag('all', 'ingest every retriever the spec declares'),
      booleanFlag('dry-run', 'report what a run would write, and write nothing'),
      TARGET_FLAG,
      JSON_FLAG,
    ],
    run: (context, args) =>
      ingest(context, {
        spec: args.positionals[0],
        target: args.values.get('target'),
        retriever: args.values.get('retriever'),
        all: args.booleans.has('all'),
        dryRun: args.booleans.has('dry-run'),
      }),
  },
  {
    name: 'eval',
    summary: 'run the eval gate, or record the baseline it measures against',
    usage: 'eval [spec] [--target <name>] [--suite <id>] [--baseline]',
    flags: [
      valueFlag('suite', 'id', 'run one eval instead of all of them'),
      TARGET_FLAG,
      booleanFlag('baseline', 'record a fresh baseline instead of gating'),
      JSON_FLAG,
    ],
    run: (context, args) =>
      evaluate(context, {
        spec: args.positionals[0],
        target: args.values.get('target'),
        suite: args.values.get('suite'),
        baseline: args.booleans.has('baseline'),
      }),
  },
];

function usageError(context: CliContext, message: string, usage?: string): ExitCode {
  context.stderr(`aid: ${message}\n\n${usage ?? globalUsage(COMMANDS)}`);
  return EXIT_USAGE;
}

/**
 * Map an unexpected throw onto exit 2. A command that crashed has not judged the project,
 * so it must not report `1` -- that code means "the project is wrong", and a crash
 * claiming it would send a reader looking for a spec problem that does not exist.
 */
function internalError(
  context: CliContext,
  json: boolean,
  command: string,
  error: unknown,
): ExitCode {
  const message = error instanceof Error ? error.message : String(error);
  context.stderr(`aid: internal error in \`${command}\`: ${message}\n`);
  if (json) {
    context.stdout(`${JSON.stringify({ command, ok: false, diagnostics: [] }, null, 2)}\n`);
  }
  return EXIT_USAGE;
}

export function run(argv: readonly string[], context: CliContext): ExitCode {
  const [name, ...rest] = argv;

  if (name === undefined || name === '--help' || name === '-h' || name === 'help') {
    context.stdout(globalUsage(COMMANDS));
    // No command at all is a usage error; explicitly asking for help is not.
    return name === undefined ? EXIT_USAGE : EXIT_OK;
  }

  const command = COMMANDS.find((candidate) => candidate.name === name);
  if (command === undefined) {
    return usageError(context, `unknown command \`${name}\``);
  }

  const parsed = parseArguments(rest, command.flags);
  if (!parsed.ok) {
    return usageError(context, parsed.message, commandUsage(command));
  }
  if (parsed.args.help) {
    context.stdout(commandUsage(command));
    return EXIT_OK;
  }

  // Every command takes at most one positional (a spec, or the directory to scaffold
  // into), so the arity rule lives here rather than four times in four commands.
  if (parsed.args.positionals.length > 1) {
    return usageError(
      context,
      `\`aid ${command.name}\` takes at most one path, got ${parsed.args.positionals.length}`,
      commandUsage(command),
    );
  }

  const json = parsed.args.booleans.has('json');
  try {
    return emit(context, json, command.run(context, parsed.args));
  } catch (error) {
    return internalError(context, json, command.name, error);
  }
}
