/**
 * The local server behind `aid visualize`: three routes and a file watcher, in-process.
 *
 * **Why in-process rather than a spawned child.** `aid dev` runs a child because the server
 * it needs is the application's own, written in another language. The server here *is* this
 * process, and the thing being served is a document this process already knows how to build,
 * so a child would mean re-running the pipeline somewhere else only to hand its result back.
 * The dispatcher's `run` returns an exit code synchronously and that is a constraint, not an
 * accident: `listen()` keeps a handle open, so the event loop stays alive after `run` returns
 * and the process serves until something stops it. That is the one place this command differs
 * from a reporting command, and it is why the banner is printed from the `listening` callback
 * rather than returned as text.
 *
 * **What that costs.** A bind failure is discovered after `run` has decided its exit code, so
 * this module reports it only as a rejected `ready`; the command that started the server is
 * what turns that into a non-zero process status. `--json` is the CI surface and it binds
 * nothing, so a pipeline never depends on the exit code of a server that does not exit; the
 * serving mode is interactive and its exit status is whatever stopped it.
 *
 * **Why the document is built per request.** A page that kept a document built at startup
 * would show the spec as it was when the server started, which is the opposite of what live
 * reload promises. Reading and lowering a spec is file work on a document of a few hundred
 * lines, so rebuilding it on each request is cheap and always correct, and it means the
 * watcher only has to decide *when*, never *what*.
 *
 * **Why the directory is watched, not the file.** Editors that save by writing a new file and
 * renaming it over the old one replace the inode, and a watcher on the old inode goes silent.
 * Watching the containing directory and filtering on the spec's name survives that.
 *
 * **What it deliberately does not do.** It does not bind anything but the loopback address,
 * does not set a CORS header, and does not read a query parameter as a path. The page is for
 * the machine it was started on; anything else is a server someone deploys, which is a
 * different product with a different threat model.
 */

import type { FSWatcher } from 'node:fs';
import { watch } from 'node:fs';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { basename, dirname } from 'node:path';

import { CLI_DIAGNOSTIC_CODES, cliError } from '../diagnostics.js';
import type { VisualDocument } from './document.js';
import { renderPage } from './page.js';

/** How long to wait for the burst of events one save produces to stop. */
const SETTLE_MS = 120;

/** How often to write a comment down an idle event stream, to keep a proxy from closing it. */
const HEARTBEAT_MS = 20_000;

export interface VisualServerOptions {
  /** Builds the document to serve. Called once per request, never cached here. */
  readonly load: () => VisualDocument;
  /** The spec file, watched for changes. Directory watching needs it absolute or resolvable. */
  readonly specPath: string;
  /** 0 asks the operating system for a free port, which is what a test wants. */
  readonly port: number;
}

export interface VisualServer {
  /**
   * Resolves once the socket is bound. Rejects with the bind failure, which is the only
   * asynchronous failure this command has to report.
   */
  readonly ready: Promise<{ readonly url: string; readonly port: number }>;
  close(): Promise<void>;
}

/** The three routes, as one switch, so an unknown path is visibly a fallthrough. */
function routeOf(url: string): 'page' | 'graph' | 'events' | 'unknown' {
  const path = url.split('?')[0] ?? '';
  if (path === '/' || path === '/index.html') return 'page';
  if (path === '/api/graph') return 'graph';
  if (path === '/api/events') return 'events';
  return 'unknown';
}

export function startVisualServer(options: VisualServerOptions): VisualServer {
  // Rendered once: the shell carries no spec data, because every value it shows arrives from
  // `/api/graph`. That is what lets the same page serve a corrected spec a second later, and
  // it keeps spec-controlled text out of the HTML entirely.
  const page = renderPage();

  let revision = 0;
  const streams = new Set<ServerResponse>();
  let settle: NodeJS.Timeout | undefined;

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const route = routeOf(request.url ?? '/');

    if (route === 'events') {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      response.write(`data: ${JSON.stringify({ revision })}\n\n`);
      streams.add(response);
      request.on('close', () => streams.delete(response));
      return;
    }

    if (route === 'graph') {
      let document: VisualDocument;
      try {
        document = options.load();
      } catch (error) {
        // The loader is this package's own pipeline and a throw here is a bug, but a page
        // that dies with the server is worse than one that says so: the watcher may be
        // about to be handed a fixed spec.
        response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        response.end(
          JSON.stringify({
            ok: false,
            specPath: options.specPath,
            diagnostics: [
              cliError({
                code: CLI_DIAGNOSTIC_CODES.visualizeDocumentFailed,
                message: `Could not build the picture: ${error instanceof Error ? error.message : String(error)}`,
              }),
            ],
          }),
        );
        return;
      }
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(JSON.stringify({ ...document, revision }));
      return;
    }

    if (route === 'page') {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(page);
      return;
    }

    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('not found\n');
  });

  const directory = dirname(options.specPath);
  const name = basename(options.specPath);
  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(directory, { persistent: true }, (_event, filename) => {
      // A null filename means the platform did not say; the conservative answer is that it
      // might have been ours, because a missed change shows a stale picture while a spare
      // refresh shows the same one.
      if (filename !== null && String(filename) !== name) return;
      if (settle !== undefined) clearTimeout(settle);
      settle = setTimeout(() => {
        settle = undefined;
        revision += 1;
        for (const stream of streams) {
          try {
            stream.write(`data: ${JSON.stringify({ revision })}\n\n`);
          } catch {
            streams.delete(stream);
          }
        }
      }, SETTLE_MS);
    });
  } catch {
    // A directory that cannot be watched is a live reload that will not fire, not a reason
    // to refuse to draw the spec that is already loaded.
    watcher = undefined;
  }
  watcher?.on('error', () => {});

  const heartbeat = setInterval(() => {
    for (const stream of streams) {
      try {
        stream.write(': keep-alive\n\n');
      } catch {
        streams.delete(stream);
      }
    }
  }, HEARTBEAT_MS);
  // The open streams and the http server already keep the process alive; the heartbeat must
  // not be a second reason it never exits.
  heartbeat.unref();

  const ready = new Promise<{ readonly url: string; readonly port: number }>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      reject(
        cliError({
          code: CLI_DIAGNOSTIC_CODES.visualizePortUnavailable,
          message: `Cannot serve on http://127.0.0.1:${options.port}: ${error.message}`,
          hint: 'Pass `--port` with a free port. `--json` prints the picture and binds nothing.',
        }),
      );
    });
    // Loopback only. A dev server is for the machine it runs on, and a `0.0.0.0` default
    // quietly publishes someone's spec to the network.
    server.listen(options.port, '127.0.0.1', () => {
      const address = server.address();
      const bound = typeof address === 'object' && address !== null ? address.port : options.port;
      resolve({ url: `http://127.0.0.1:${bound}`, port: bound });
    });
  });
  // Nobody has to await `ready` for the page to work, and an unawaited rejection is an
  // unhandled one. The command attaches its own handler; this keeps a test that ignores it
  // from crashing the run.
  ready.catch(() => {});

  return {
    ready,
    close: () =>
      new Promise<void>((resolve) => {
        if (settle !== undefined) clearTimeout(settle);
        clearInterval(heartbeat);
        watcher?.close();
        for (const stream of streams) stream.end();
        streams.clear();
        // Long-lived event streams would hold `close` open forever; they were ended above,
        // so this only has to stop accepting and drop anything still queued.
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
