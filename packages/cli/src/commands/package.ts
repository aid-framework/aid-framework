/**
 * `aid package edge` -- build the archive the emitted `edge` module deploys.
 *
 * The module has always named a file it expected to find: `filename = var.edge_zip_path`,
 * `source_code_hash = filebase64sha256(var.edge_zip_path)`, and a `fileexists` precondition
 * whose message tells the operator to build the app first. There was no way to do that, so
 * an `edge` deployment could be planned only after someone assembled a Lambda zip by hand
 * and hoped it matched the handler. This command is the missing half of that contract.
 *
 * It refuses in two places before it builds anything, and both are refusals rather than
 * fallbacks because the alternative is a file that looks like a deployable artifact:
 *
 * - **A target that does not emit Python.** The archive is `app/` installed for CPython
 *   3.12; there is no TypeScript equivalent, so a `--target` naming one is an invocation
 *   error, the same way `aid ingest` treats it.
 * - **A spec with no `edge` deployment.** Packaging for a deployment the spec does not
 *   declare is a success that nothing will ever use. The module will not plan it, so the
 *   archive would sit there implying a deployable edge function exists.
 *
 * Everything about the archive itself -- why the dependency list comes from
 * `pyproject.toml`, why the wheels are pinned to manylinux, and why the bytes are
 * deterministic -- is documented in `edge-zip.ts`, where it can be tested without a
 * project.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CliContext } from '../context.js';
import { CLI_DIAGNOSTIC_CODES, cliError } from '../diagnostics.js';
import {
  EDGE_PLATFORM,
  EDGE_PYTHON_VERSION,
  extractRequirements,
  installWheels,
  missingStageInputs,
  stageApplication,
  writeArchive,
} from '../edge-zip.js';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from '../exit.js';
import type { CommandOutcome } from '../output.js';
import { group, outcome } from '../output.js';
import { absolutePath, parentPath } from '../paths.js';
import { lowerSpec, readSpec } from '../pipeline.js';
import { discoverStdlibInterpreter, INTERPRETERS } from '../python.js';
import { resolveTarget, unknownTargetDiagnostic } from '../targets.js';

const SUBCOMMANDS = ['edge'] as const;

/** Where the archive lands when `--out` is silent: the working directory, as the module defaults to. */
const DEFAULT_OUT = 'edge.zip';

export interface PackageOptions {
  readonly subcommand: string | undefined;
  readonly spec: string | undefined;
  readonly target: string | undefined;
  /** The archive to write, relative to the working directory or absolute. */
  readonly out: string | undefined;
}

export function packageEdge(context: CliContext, options: PackageOptions): CommandOutcome {
  const command = 'package';

  if (options.subcommand === undefined) {
    return outcome({
      command,
      exitCode: EXIT_USAGE,
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.packageSubcommandRequired,
          message: '`aid package` needs a subcommand.',
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
          code: CLI_DIAGNOSTIC_CODES.packageUnknownSubcommand,
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

  const specPath = options.spec ?? target.specPath;
  const outPath = options.out === undefined || options.out === '' ? DEFAULT_OUT : options.out;
  const fields = { target: target.name, spec: specPath, archive: outPath };

  // Exit 2: the flag names a target whose output this command cannot possibly be asked to
  // build, so nothing about the project has been judged yet.
  if (target.runner !== 'python') {
    return outcome({
      command,
      exitCode: EXIT_USAGE,
      fields,
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.runnerUnsupported,
          message: `\`aid package edge\` builds the Python application the edge module deploys, and ${target.name} emits TypeScript.`,
          hint: 'The archive is `app/` plus its packaging metadata, installed for CPython 3.12; there is no TypeScript equivalent for Lambda@Edge.',
        }),
      ],
    });
  }

  const read = readSpec(context, specPath);
  if (!read.ok) {
    return outcome({ command, exitCode: EXIT_FAILURE, fields, diagnostics: read.diagnostics });
  }

  const lowered = lowerSpec(read.text, specPath);
  if (!lowered.ok) {
    return outcome({ command, exitCode: EXIT_FAILURE, fields, diagnostics: lowered.diagnostics });
  }

  const deployment = lowered.ir.deployments.find((candidate) => candidate.target === 'edge');
  // Exit 1, not 2: the invocation was right and the spec is what does not ask for an edge
  // function, so the command has a verdict to report.
  if (deployment === undefined) {
    return outcome({
      command,
      exitCode: EXIT_FAILURE,
      fields,
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.packageNoEdgeDeployment,
          message:
            'The spec declares no `edge` deployment, so there is no Lambda@Edge function to package.',
          path: [specPath],
          hint: 'Add a deployment with `target: edge` under `deployments:`, or deploy the targets the spec does declare.',
        }),
      ],
    });
  }

  const appRoot = parentPath(target.generatedDir);
  const missing = missingStageInputs(context, appRoot);
  if (missing.length > 0) {
    return outcome({
      command,
      exitCode: EXIT_FAILURE,
      fields,
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.packageStageMissing,
          message: `The archive is built from ${missing.map((path) => `"${path}"`).join(', ')}, and ${missing.length === 1 ? 'it is' : 'they are'} not there.`,
          path: missing,
          hint: 'Run `aid gen` for `app/`. `pyproject.toml` and `README.md` stay at the project root: they are the packaging metadata the emitted Dockerfile installs from.',
        }),
      ],
    });
  }

  const interpreter = discoverStdlibInterpreter(context);
  if (interpreter === undefined) {
    return outcome({
      command,
      exitCode: EXIT_USAGE,
      fields,
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.packageNoInterpreter,
          message: `No interpreter could run the standard-library helpers (tried ${INTERPRETERS.join(', ')}).`,
          hint: 'Install Python 3.11 or newer, or `uv`, which supplies one. The helpers read `pyproject.toml` with `tomllib` and write the archive with `zipfile`.',
        }),
      ],
    });
  }

  const work = mkdtempSync(join(tmpdir(), 'aid-edge-'));
  try {
    const stage = join(work, 'stage');
    stageApplication(context, appRoot, stage);

    const extracted = extractRequirements(context, interpreter, work, stage);
    if (!extracted.ok) {
      return outcome({
        command,
        exitCode: EXIT_FAILURE,
        fields,
        diagnostics: [extracted.diagnostic],
      });
    }

    const dependencies = extracted.value;
    if (dependencies.length > 0) {
      const installed = installWheels(context, stage, dependencies);
      if (!installed.ok) {
        return outcome({
          command,
          exitCode:
            installed.diagnostic.code === CLI_DIAGNOSTIC_CODES.packageUvMissing
              ? EXIT_USAGE
              : EXIT_FAILURE,
          fields,
          diagnostics: [installed.diagnostic],
          ...(installed.stderr === undefined ? {} : { stderr: installed.stderr }),
        });
      }
    }

    const archivePath = absolutePath(context.cwd, outPath);
    const written = writeArchive(context, interpreter, work, stage, archivePath);
    if (!written.ok) {
      return outcome({
        command,
        exitCode: EXIT_FAILURE,
        fields,
        diagnostics: [written.diagnostic],
        ...(written.stderr === undefined ? {} : { stderr: written.stderr }),
      });
    }

    const text = [
      `target: ${target.name}`,
      `spec: ${specPath}`,
      `deployment: ${deployment.id} (edge)`,
      `app: ${appRoot}/`,
      dependencies.length === 0
        ? 'dependencies: none declared -- the archive carries only the application'
        : `dependencies: ${dependencies.length} installed as ${EDGE_PLATFORM} wheels for CPython ${EDGE_PYTHON_VERSION}`,
      `archive: ${outPath}`,
      `size: ${group(written.value.bytes)} bytes`,
      `entries: ${group(written.value.entries)}`,
      `next: copy "${outPath}" into the environment root (for example infra/envs/dev) so the module's`,
      'default `edge_zip_path = "edge.zip"` finds it, or set `edge_zip_path` there to this path.',
    ];

    return outcome({
      command,
      exitCode: EXIT_OK,
      text: text.join('\n'),
      fields: {
        ...fields,
        deployment: deployment.id,
        app: appRoot,
        interpreter,
        dependencies,
        bytes: written.value.bytes,
        entries: written.value.entries,
        files: written.value.names,
      },
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
