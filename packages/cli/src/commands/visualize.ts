/**
 * `aid visualize` -- draw the spec as a graph, and keep drawing it as it changes.
 *
 * **Why this is a picture of the IR and not of the YAML.** A spec is a document about
 * references: a pipeline names a prompt, a prompt names a model, an eval names a target, a
 * deployment names a pipeline. Reading that as YAML means holding the reference graph in your
 * head; reading it as a picture means the graph is on screen. So the graph is derived from the
 * same IR the generators consume, after the same gates that build it, which also settles what
 * a picture may show: anything the build refused has no picture, because a diagram of a spec
 * that does not compile would suggest it does.
 *
 * **Why it serves instead of writing a file.** The interesting moment is not the spec that
 * builds, it is the three edits between the one that builds and the one that does not. A
 * command that wrote an SVG and exited would make you re-run it after each. So this starts a
 * server on loopback, watches the spec's directory, and redraws the page when the file
 * settles. Nothing is written to disk and nothing leaves the machine.
 *
 * **Why `--json` exists even though this is interactive.** The graph is a value, and a value
 * is worth asserting on. `--json` prints the same document the page renders -- graph plus
 * layout, coordinates included -- and binds no port, so it is usable in CI, in a test, and in
 * whatever someone wants to pipe it into. `aid visualize --json | jq .counts` is the shortest
 * honest answer to "how big is this spec".
 *
 * **What it refuses.** A `--port` that is not a port is an invocation mistake and exits 2
 * before anything is read, the same as `aid dev`. A spec the build refuses is *not* a refusal
 * to serve: the page is where the diagnostics belong, and the spec someone is halfway through
 * fixing is exactly the spec worth watching. In `--json` mode there is no page to put them on,
 * so the refusals are the answer and the command exits 1.
 */

import { dirname } from 'node:path';

import { formatDiagnostics } from '@aid-framework/spec';

import type { CliContext } from '../context.js';
import type { CliDiagnostic } from '../diagnostics.js';
import { CLI_DIAGNOSTIC_CODES, cliError } from '../diagnostics.js';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from '../exit.js';
import type { CommandOutcome } from '../output.js';
import { outcome } from '../output.js';
import { DEFAULT_SPEC_PATH } from '../targets.js';
import type { VisualDocument } from '../visualize/document.js';
import { buildVisualDocument } from '../visualize/document-node.js';
import { startVisualServer } from '../visualize/server.js';

export interface VisualizeOptions {
  readonly spec: string | undefined;
  readonly port: string | undefined;
  /** Print the graph document and exit instead of serving it. */
  readonly json: boolean;
}

/**
 * Distinct from `aid dev`'s 8000 on purpose: the usual gesture is to visualise the spec of
 * the service that is already running, and a shared default would mean one of the two
 * refuses to start for a reason that has nothing to do with the spec.
 */
const DEFAULT_PORT = 4321;

function parsePort(raw: string | undefined): number | undefined {
  if (raw === undefined) return DEFAULT_PORT;
  if (!/^\d+$/.test(raw)) return undefined;
  const port = Number(raw);
  return port >= 1 && port <= 65_535 ? port : undefined;
}

/**
 * The block the terminal gets once the socket is bound.
 *
 * Printed from the `listening` callback rather than returned, because the returned text is
 * written before the server has had a turn of the event loop and would announce an address
 * that may turn out to be taken.
 */
function banner(document: VisualDocument, specPath: string, url: string): string {
  if (!document.ok) {
    return [
      `aid visualize: the build refuses ${specPath}, so there is no picture to draw.`,
      `  ${url}`,
      '  The page lists every diagnostic and redraws itself the moment the spec stops being wrong.',
      'Press Ctrl-C to stop.',
    ].join('\n');
  }

  const project = document.graph.project;
  const counts = document.counts;
  return [
    `aid visualize: ${project.name} (profile ${document.graph.profile}) -- ${counts.nodes} nodes, ${counts.edges} edges, ${counts.steps} steps`,
    `  ${url}`,
    `  serving ${specPath}, watching ${dirname(specPath)} -- save the spec and the page redraws`,
    'Press Ctrl-C to stop.',
  ].join('\n');
}

export function visualize(context: CliContext, options: VisualizeOptions): CommandOutcome {
  const command = 'visualize';
  const specPath = options.spec ?? DEFAULT_SPEC_PATH;

  // Before the spec is read: a port that is not a port is a mistake in the invocation, and
  // reporting a spec problem instead would bury the actual mistake.
  const port = parsePort(options.port);
  if (port === undefined) {
    return outcome({
      command,
      exitCode: EXIT_USAGE,
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.visualizePortInvalid,
          message: `\`--port\` needs an integer between 1 and 65535, got "${options.port}".`,
        }),
      ],
    });
  }

  if (options.json) {
    const document = buildVisualDocument(context, specPath);
    if (!document.ok) {
      return outcome({
        command,
        exitCode: EXIT_FAILURE,
        fields: { spec: specPath },
        diagnostics: document.diagnostics,
      });
    }
    return outcome({
      command,
      exitCode: EXIT_OK,
      fields: {
        spec: specPath,
        profile: document.graph.profile,
        counts: document.counts,
        graph: document.graph,
        system: document.system,
        sequences: document.sequences,
        layout: document.layout,
      },
      diagnostics: document.warnings,
    });
  }

  const server = startVisualServer({
    specPath,
    port,
    load: () => buildVisualDocument(context, specPath),
  });

  server.ready.then(
    ({ url }) => {
      // Rebuilt rather than cached from start-up: the banner and the first page render must
      // describe the same file, and the file may have changed between the two.
      const document = buildVisualDocument(context, specPath);
      context.stdout(`${banner(document, specPath, url)}\n`);
      if (!document.ok) context.stderr(formatDiagnostics(document.diagnostics));
    },
    (diagnostic: CliDiagnostic) => {
      context.stderr(formatDiagnostics([diagnostic]));
      // The one place this command acts outside the dispatcher, and it is deliberate: `run`
      // has already handed back exit 0 by the time a bind failure can be known, so the
      // returned code describes an intent rather than an outcome. The command never exits
      // when it succeeds -- the process serves -- so this assignment is the only way the
      // process can be honest about a server that never started.
      process.exitCode = EXIT_FAILURE;
    },
  );

  return outcome({
    command,
    exitCode: EXIT_OK,
    fields: { spec: specPath, port, url: `http://127.0.0.1:${port}` },
    text: '',
  });
}
