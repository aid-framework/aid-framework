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
import { cost } from './commands/cost.js';
import { dev } from './commands/dev.js';
import { doctor } from './commands/doctor.js';
import { eject } from './commands/eject.js';
import { evaluate } from './commands/eval.js';
import { generate } from './commands/gen.js';
import { guard } from './commands/guard.js';
import { infra } from './commands/infra.js';
import { ingest } from './commands/ingest.js';
import { init } from './commands/init.js';
import { kb } from './commands/kb.js';
import { migrate } from './commands/migrate.js';
import { packageEdge } from './commands/package.js';
import { trace } from './commands/trace.js';
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
  /** Positional arguments this command accepts. Defaults to one. */
  readonly maxPositionals?: number;
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
    usage: 'gen [spec] [--target <name>] [--dry-run] [--check] [--force]',
    flags: [
      TARGET_FLAG,
      booleanFlag('dry-run', 'report what would change, and write nothing'),
      booleanFlag('check', 'fail when the committed tree does not match the spec; writes nothing'),
      booleanFlag('force', 'overwrite generated files that were edited by hand'),
      JSON_FLAG,
    ],
    run: (context, args) =>
      generate(context, {
        spec: args.positionals[0],
        target: args.values.get('target'),
        dryRun: args.booleans.has('dry-run'),
        force: args.booleans.has('force'),
        check: args.booleans.has('check'),
      }),
  },
  {
    name: 'dev',
    summary: 'regenerate the tree and run the application on a local server',
    usage: 'dev [spec] [--target <name>] [--port <n>] [--no-gen] [--no-reload]',
    flags: [
      TARGET_FLAG,
      valueFlag('port', 'n', 'the port to serve on; defaults to 8000, the uvicorn default'),
      booleanFlag('no-gen', 'serve the tree as it is, without regenerating it first'),
      booleanFlag('no-reload', 'turn off the reloader that restarts the server on code changes'),
    ],
    run: (context, args) =>
      dev(context, {
        spec: args.positionals[0],
        target: args.values.get('target'),
        port: args.values.get('port'),
        noGen: args.booleans.has('no-gen'),
        noReload: args.booleans.has('no-reload'),
      }),
  },
  {
    name: 'guard',
    summary: 'measure the guardrails against a red-team corpus',
    usage: 'guard [spec] [--target <name>] [--red-team <file>]',
    flags: [
      TARGET_FLAG,
      valueFlag(
        'red-team',
        'file',
        'the corpus to measure against; defaults to redteam.json beside the spec, then at the project root',
      ),
      JSON_FLAG,
    ],
    run: (context, args) =>
      guard(context, {
        spec: args.positionals[0],
        target: args.values.get('target'),
        redTeam: args.values.get('red-team'),
      }),
  },
  {
    name: 'migrate',
    summary: 'emit the SQL the declared vector stores need, for an operator to apply',
    usage: 'migrate [spec] [--out <dir>] [--check] [--dry-run]',
    flags: [
      valueFlag('out', 'dir', 'directory for the migration file; defaults to `migrations`'),
      booleanFlag('check', 'fail when the committed file does not match the spec; writes nothing'),
      booleanFlag('dry-run', 'report what would change, and write nothing'),
      JSON_FLAG,
    ],
    run: (context, args) =>
      migrate(context, {
        spec: args.positionals[0],
        out: args.values.get('out'),
        check: args.booleans.has('check'),
        dryRun: args.booleans.has('dry-run'),
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
    name: 'kb',
    summary: 'ask the engine that owns a managed knowledge base to re-ingest it',
    usage: 'kb sync [spec] [--target <name>] [--retriever <id> | --all] [--wait]',
    maxPositionals: 2,
    flags: [
      valueFlag('retriever', 'id', 'sync one managed retriever, by the id the spec used'),
      booleanFlag('all', 'sync every managed retriever the spec declares'),
      booleanFlag('wait', 'follow the ingestion job until the engine reports it done'),
      TARGET_FLAG,
      JSON_FLAG,
    ],
    run: (context, args) =>
      kb(context, {
        subcommand: args.positionals[0],
        spec: args.positionals[1],
        target: args.values.get('target'),
        retriever: args.values.get('retriever'),
        all: args.booleans.has('all'),
        wait: args.booleans.has('wait'),
      }),
  },
  {
    name: 'eval',
    summary:
      'run the eval gate, record the baseline it measures against, or apply a promotion policy',
    usage:
      'eval [spec] [--target <name>] [--suite <id>] [--baseline] [--compare <baseline.json> --candidate <candidate.json>]',
    flags: [
      valueFlag('suite', 'id', 'run one eval instead of all of them'),
      TARGET_FLAG,
      booleanFlag('baseline', 'record a fresh baseline instead of gating'),
      valueFlag(
        'compare',
        'path',
        'apply gate.promotion to an accepted baseline and a candidate one. The quality allowance is judged; a declared cost ceiling is reported as unjudged because no runtime records cost',
      ),
      valueFlag('candidate', 'path', 'the candidate baseline --compare reads'),
      JSON_FLAG,
    ],
    run: (context, args) =>
      evaluate(context, {
        spec: args.positionals[0],
        target: args.values.get('target'),
        suite: args.values.get('suite'),
        baseline: args.booleans.has('baseline'),
        compare: args.values.get('compare'),
        candidate: args.values.get('candidate'),
      }),
  },
  {
    name: 'cost',
    summary: 'report cost and latency from the local trace sink',
    usage: 'cost [dir] [--since <date>] [--budget <usd>]',
    flags: [
      valueFlag(
        'since',
        'date',
        'only count spans that started at or after this date (YYYY-MM-DD or an ISO 8601 instant)',
      ),
      valueFlag('budget', 'usd', 'fail when the measured cost exceeds this ceiling'),
      JSON_FLAG,
    ],
    run: (context, args) =>
      cost(context, {
        dir: args.positionals[0],
        since: args.values.get('since'),
        budget: args.values.get('budget'),
      }),
  },
  {
    name: 'trace',
    summary: 'inspect a traced run: the span tree, timings, models, tokens and cost',
    usage: 'trace [run] [--dir <dir>] [--all]',
    flags: [
      valueFlag('dir', 'dir', 'the trace directory to read (default: $AID_TRACE_DIR)'),
      booleanFlag('all', 'print every run in the directory, not just the run list'),
      JSON_FLAG,
    ],
    run: (context, args) =>
      trace(context, {
        run: args.positionals[0],
        dir: args.values.get('dir'),
        all: args.booleans.has('all'),
      }),
  },
  {
    name: 'doctor',
    summary: 'diagnose the tree against the spec: drift, versions, missing files',
    usage: 'doctor [spec] [--target <name>]',
    flags: [TARGET_FLAG, JSON_FLAG],
    run: (context, args) =>
      doctor(context, {
        spec: args.positionals[0],
        target: args.values.get('target'),
      }),
  },
  {
    name: 'eject',
    summary: 'take ownership of a generated file: move it to business/ and stop generating it',
    usage: 'eject <path> [--target <name>] [--dry-run]',
    flags: [TARGET_FLAG, booleanFlag('dry-run', 'report the move, and write nothing'), JSON_FLAG],
    run: (context, args) =>
      eject(context, {
        path: args.positionals[0],
        target: args.values.get('target'),
        dryRun: args.booleans.has('dry-run'),
      }),
  },
  {
    name: 'infra',
    summary: 'derive the deployment wiring from the spec and drive OpenTofu or AWS CDK',
    usage:
      'infra <gen|plan|apply|drift> [spec] [--dry-run|--check] [--env <name>] [--iac <tofu|cdk>] [--cloud <aws|gcp>] [--force]',
    maxPositionals: 2,
    flags: [
      booleanFlag('dry-run', 'gen: report what would change, and write nothing'),
      booleanFlag('check', 'gen: exit non-zero when the generated tree is out of date'),
      valueFlag(
        'env',
        'name',
        'environment root (infra/envs/<name>, infra/envs/gcp-<name>, or infra/cdk/<name>); plan, apply and drift use dev',
      ),
      valueFlag(
        'iac',
        'tofu|cdk',
        'plan, apply and drift: which backend to drive; defaults to tofu',
      ),
      valueFlag(
        'cloud',
        'aws|gcp',
        'which cloud the module set targets, and so which env root an action runs in; defaults to aws',
      ),
      booleanFlag('confirm-prod', 'required to apply to prod'),
      booleanFlag('force', 'gen: overwrite generated files that were edited by hand'),
      JSON_FLAG,
    ],
    run: (context, args) =>
      infra(context, {
        subcommand: args.positionals[0],
        spec: args.positionals[1],
        dryRun: args.booleans.has('dry-run'),
        check: args.booleans.has('check'),
        force: args.booleans.has('force'),
        env: args.values.get('env'),
        iac: args.values.get('iac'),
        cloud: args.values.get('cloud'),
        confirmProd: args.booleans.has('confirm-prod'),
        json: args.booleans.has('json'),
      }),
  },
  {
    name: 'package',
    summary: 'build the archive an `edge` deployment hands to Lambda@Edge',
    usage: 'package <edge> [spec] [--target <name>] [--out <file>]',
    maxPositionals: 2,
    flags: [
      valueFlag(
        'out',
        'file',
        'archive to write, relative to the working directory; defaults to `edge.zip`',
      ),
      TARGET_FLAG,
      JSON_FLAG,
    ],
    run: (context, args) =>
      packageEdge(context, {
        subcommand: args.positionals[0],
        spec: args.positionals[1],
        target: args.values.get('target'),
        out: args.values.get('out'),
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

  // Every other command takes at most one positional (a spec, or the directory to
  // scaffold into); `infra` is the exception because it takes a subcommand and a spec. The
  // arity rule lives here rather than five times in five commands, and each command
  // declares its own bound rather than this list naming commands.
  const maxPositionals = command.maxPositionals ?? 1;
  if (parsed.args.positionals.length > maxPositionals) {
    // `one path` rather than `1 path` keeps the message this command has always printed for
    // the single-positional commands; only commands with a larger bound read as a count.
    const bound = maxPositionals === 1 ? 'one path' : `${maxPositionals} arguments`;
    return usageError(
      context,
      `\`aid ${command.name}\` takes at most ${bound}, got ${parsed.args.positionals.length}`,
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
