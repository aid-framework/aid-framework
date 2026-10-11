#!/usr/bin/env node
/**
 * The `aid` executable: the only file in this package that touches `process`.
 *
 * Everything it does is three lines of I/O wiring, because everything else lives behind
 * `run(argv, context)`. Keeping the process bindings in one place is what makes the rest
 * of the CLI testable, and the `import.meta.url` guard below is what makes importing this
 * module a no-op: a test can import `main.js` and call `run` without the import itself
 * deciding to read `process.argv` and start working.
 *
 * The exit status is set through `process.exitCode` rather than `process.exit()`. Nothing
 * here is holding a handle open, so the process ends when the event loop drains, and
 * `process.exit()` before that is how a CLI truncates its own stdout on a pipe.
 */

import { pathToFileURL } from 'node:url';

import { createContext } from './context.js';
import { run } from './main.js';

/** The real entry point: the process streams, the process environment, real children. */
export function main(argv: readonly string[] = process.argv.slice(2)): number {
  return run(argv, createContext());
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = main();
}
