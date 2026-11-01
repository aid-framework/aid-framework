/**
 * `aid dev` -- compile the spec, reconcile the tree, and run the application.
 *
 * **Why generation is part of it.** The command's whole promise is "the spec you just
 * edited is the thing serving requests", and a `dev` that started a server against a tree
 * compiled from an older spec would answer from code the developer is no longer looking
 * at. So it runs the same generator the `gen` command does, and if generation fails it
 * does not start the server: a tree that could not be reconciled is not a tree to serve.
 *
 * **Why it starts the target's own server instead of one of its own.** The Python target
 * emits routers; the application owns `app/main.py` and decides what to mount and how to
 * run it (the generator says so in its own comments). A dev server implemented here would
 * be a second, competing way to run the same app, and it would drift. So this command
 * spawns the module the application already declares, which is also what a person types by
 * hand: `python -m uvicorn app.main:app`. `-m uvicorn` rather than the `uvicorn` binary,
 * because the probe that proved the interpreter can import the runtime also proves it can
 * import uvicorn; a `uvicorn` script on `PATH` proves neither.
 *
 * **Why a target may refuse.** `ts-vercel` is a deployment target: it emits route handlers
 * that Next mounts, and ships no server of its own to start. Inventing one here would be
 * exactly the competing dev server the previous paragraph rules out. The registry declares
 * that per target, so this command refuses with a reason rather than guessing.
 *
 * **Why the start banner is printed by the command.** Every other command returns text and
 * lets the dispatcher print it. This one hands the terminal to a child for an unbounded
 * time, so a banner returned after the server exits would arrive after the log it was
 * meant to introduce. The banner and the generation summary are therefore written as they
 * happen, and the returned text is only the farewell.
 *
 * **Why there is no `--json`.** A JSON document is a verdict about a finished run. `dev`
 * produces a running process and a stream of server output, so the honest answers are "a
 * document that lies about when the run ended" or "a document interrupted by logs". It
 * refuses `--json` as a usage error instead of emitting something that cannot be parsed.
 *
 * **What is not watched.** uvicorn's `--reload` reloads on changes to the code it imported,
 * and that is left on by default. The *spec* is not watched: regenerating it needs the
 * generator to run again, and doing that from a synchronous command would mean the
 * dispatcher grew an event loop for one command. Restart `aid dev` after editing the spec;
 * the generation step makes that restart cheap and the tree correct either way.
 */

import { existsSync } from 'node:fs';

import { sortDiagnostics } from '@aid-framework/spec';

import type { CliContext } from '../context.js';
import type { CliDiagnostic } from '../diagnostics.js';
import { CLI_DIAGNOSTIC_CODES, cliError } from '../diagnostics.js';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from '../exit.js';
import type { CommandOutcome } from '../output.js';
import { outcome } from '../output.js';
import { absolutePath } from '../paths.js';
import { DEV_PROBE, discoverInterpreter, INTERPRETERS, interpreterCommand } from '../python.js';
import { resolveTarget, unknownTargetDiagnostic } from '../targets.js';
import { generate } from './gen.js';

export interface DevOptions {
  readonly spec: string | undefined;
  readonly target: string | undefined;
  readonly port: string | undefined;
  /** Skip regeneration and serve the tree as it is. */
  readonly noGen: boolean;
  /** Turn off uvicorn's own reloader. */
  readonly noReload: boolean;
}

/** uvicorn's own default, so `aid dev` and `uvicorn app.main:app` agree. */
const DEFAULT_PORT = 8000;

/** The port, or `undefined` when the flag could not have meant one. */
function parsePort(raw: string | undefined): number | undefined {
  if (raw === undefined) return DEFAULT_PORT;
  if (!/^\d+$/.test(raw)) return undefined;
  const port = Number(raw);
  return port >= 1 && port <= 65_535 ? port : undefined;
}

export function dev(context: CliContext, options: DevOptions): CommandOutcome {
  const command = 'dev';

  const target = resolveTarget(options.target);
  if (target === undefined) {
    return outcome({
      command,
      exitCode: EXIT_USAGE,
      diagnostics: [unknownTargetDiagnostic(options.target ?? '')],
    });
  }

  // Before the project is touched: a port that is not a port is a mistake in the
  // invocation, and reporting a spec problem instead would bury the actual mistake.
  const port = parsePort(options.port);
  if (port === undefined) {
    return outcome({
      command,
      exitCode: EXIT_USAGE,
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.devPortInvalid,
          message: `\`--port\` needs an integer between 1 and 65535, got "${options.port}".`,
        }),
      ],
    });
  }

  const specPath = options.spec ?? target.specPath;
  const fields = { target: target.name, spec: specPath, port };
  const surface = target.dev;

  if (surface.kind === 'none') {
    return outcome({
      command,
      // Exit 2, not 1: no server was started and no project was judged, so nothing here
      // is a verdict about the tree.
      exitCode: EXIT_USAGE,
      fields,
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.runnerUnsupported,
          message: `\`aid dev\` cannot start ${target.name}: ${surface.reason}.`,
          hint: 'Run the application with the server its platform provides; `aid gen` still compiles and reconciles the tree.',
        }),
      ],
    });
  }

  const diagnostics: CliDiagnostic[] = [];

  if (!options.noGen) {
    const generated = generate(context, {
      spec: options.spec,
      target: options.target,
      dryRun: false,
      force: false,
      check: false,
    });
    if (generated.exitCode !== EXIT_OK) {
      // The generator's own summary and diagnostics are the answer: it is the same
      // failure `aid gen` would have reported, and renaming it here would hide that.
      return outcome({
        command,
        exitCode: generated.exitCode,
        fields,
        diagnostics: generated.diagnostics,
        text: generated.text,
      });
    }
    if (generated.text !== '') context.stdout(`${generated.text}\n`);
    diagnostics.push(...generated.diagnostics);
  }

  // The entry point is the application's own file, not a generated one, so its absence
  // means the project was never set up rather than never regenerated. Named explicitly
  // because "app/main.py is missing" is the one thing the reader needs to know.
  const entry = absolutePath(context.cwd, surface.entry);
  if (!existsSync(entry)) {
    return outcome({
      command,
      exitCode: EXIT_FAILURE,
      fields,
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.devEntryMissing,
          message: `No ASGI entry point at ${surface.entry}.`,
          path: [surface.entry],
          hint: 'Run `aid init` for a starter entry point, or run `aid dev` from the directory that contains the generated app.',
        }),
      ],
    });
  }

  const interpreter = discoverInterpreter(context, DEV_PROBE);
  if (interpreter === undefined) {
    return outcome({
      command,
      // Exit 2: the project was not judged, because nothing could start it.
      exitCode: EXIT_USAGE,
      fields,
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.devUvicornMissing,
          message: `No interpreter can import both aid_runtime and uvicorn (tried ${INTERPRETERS.join(', ')}).`,
          hint: 'Install the runtime and uvicorn into the interpreter you run with, or run `python -m uvicorn` yourself.',
        }),
      ],
    });
  }

  const argv = [
    ...interpreterCommand(interpreter),
    '-m',
    'uvicorn',
    surface.module,
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    ...(options.noReload ? [] : ['--reload']),
  ];

  // Bound to loopback on purpose: a dev server is for the machine it runs on, and a
  // `0.0.0.0` default quietly exposes a half-built app to the network.
  context.stdout(
    [
      `${target.name}: serving ${surface.module} on http://127.0.0.1:${port}${options.noReload ? '' : ' (reload on)'}`,
      `  ${argv.join(' ')}`,
      'Press Ctrl-C to stop.',
      '',
    ].join('\n'),
  );

  const run = context.spawn(argv[0] ?? interpreter, argv.slice(1), {
    cwd: context.cwd,
    stdio: 'inherit',
    env: context.env,
  });

  if (run.error !== undefined) {
    return outcome({
      command,
      exitCode: EXIT_USAGE,
      fields: { ...fields, interpreter },
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.runnerFailed,
          message: `Could not start ${interpreter} to run "${surface.module}": ${run.error.message}`,
        }),
      ],
    });
  }

  // A null status means the child was ended by a signal, which for a foreground server is
  // how Ctrl-C arrives. Reporting that as a failure would make stopping the dev server
  // look like the server broke.
  if (run.status === null) {
    return outcome({
      command,
      exitCode: EXIT_OK,
      fields: { ...fields, interpreter, stopped: true },
      diagnostics: sortDiagnostics(diagnostics),
      text: 'server stopped.',
    });
  }

  if (run.status !== 0) {
    return outcome({
      command,
      exitCode: EXIT_FAILURE,
      fields: { ...fields, interpreter, status: run.status },
      diagnostics: sortDiagnostics([
        ...diagnostics,
        cliError({
          code: CLI_DIAGNOSTIC_CODES.runnerFailed,
          message: `The server exited with status ${run.status}.`,
        }),
      ]),
    });
  }

  return outcome({
    command,
    exitCode: EXIT_OK,
    fields: { ...fields, interpreter },
    diagnostics: sortDiagnostics(diagnostics),
    text: 'server stopped.',
  });
}
