/**
 * Finding the directory `aid cost` and `aid trace` both read.
 *
 * The two commands answer different questions about the same files, so they must agree
 * on which files those are. Discovery lives here rather than in either command: if one
 * of them grew its own default, `cost` could report a directory `trace` refused, and
 * nothing would explain the difference.
 *
 * Both outcomes are wrong invocations, so both exit `2`: no directory was named and
 * `AID_TRACE_DIR` is unset, or the named path is not a directory. Neither says anything
 * about the project, which is why neither is `1`.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { CliContext } from './context.js';
import { CLI_DIAGNOSTIC_CODES, cliError } from './diagnostics.js';
import { EXIT_USAGE } from './exit.js';
import type { CommandOutcome } from './output.js';
import { outcome } from './output.js';
import type { TraceSpan } from './trace.js';
import { parseTraceLines } from './trace.js';

/** The variable the runtimes read. Named here, not imported, because it is a runtime knob. */
export const TRACE_DIR_ENV = 'AID_TRACE_DIR';

/** Everything one trace directory yielded, with failures counted rather than thrown. */
export interface TraceDir {
  /** The `.jsonl` entries, sorted, so two reads of one directory agree on order. */
  readonly files: readonly string[];
  readonly spans: readonly TraceSpan[];
  /** Lines that were not a span. */
  readonly skipped: number;
  /** Files that existed but could not be read. */
  readonly unreadable: number;
}

/**
 * Read every `.jsonl` file directly inside `absolute`.
 *
 * A file that cannot be read is **counted and skipped**, for the same reason a bad line
 * is: one unreadable file must not hide the spans in the others, and the caller decides
 * whether the count fails the run. Subdirectories are ignored -- the sink writes flat
 * files, and walking a tree would silently mix in traces the caller did not point at.
 *
 * The exception is the directory itself: `readdirSync` throws when it is missing or is
 * not a directory, and the caller has to have checked that before it can say anything
 * useful about it.
 */
export function readTraceDir(absolute: string): TraceDir {
  const files = readdirSync(absolute, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => entry.name)
    .sort();

  const spans: TraceSpan[] = [];
  let skipped = 0;
  let unreadable = 0;

  for (const name of files) {
    let text: string;
    try {
      text = readFileSync(join(absolute, name), 'utf8');
    } catch {
      unreadable += 1;
      continue;
    }
    const parsed = parseTraceLines(text);
    spans.push(...parsed.spans);
    skipped += parsed.skipped;
  }

  return { files, spans, skipped, unreadable };
}

/** A directory relative to the cwd when it is below it, else the absolute path. */
export function displayPath(cwd: string, absolute: string): string {
  const path = relative(cwd, absolute);
  if (path === '') return '.';
  if (path.startsWith('..') || isAbsolute(path)) return absolute;
  return path.split(sep).join('/');
}

export type TraceDirResolution =
  | { readonly kind: 'ok'; readonly absolute: string; readonly shown: string }
  | { readonly kind: 'refused'; readonly outcome: CommandOutcome };

/**
 * Where the directory is, before asking whether it exists.
 *
 * Split from the existence check so `cost` can validate `--since` in the order it always
 * has: a missing directory is reported first, then a bad date, then a path that is not a
 * directory. A command that showed those in a different order would be telling the caller
 * to fix the second thing while the first is still wrong.
 *
 * An all-whitespace variable is treated as unset: a shell that exported an empty value
 * meant "nothing", and resolving it to the cwd would read whatever happened to be there.
 */
export function locateTraceDir(
  context: CliContext,
  argument: string | undefined,
  command: string,
  usage = '<dir>',
): TraceDirResolution {
  const configured = argument ?? context.env[TRACE_DIR_ENV]?.trim();
  if (configured === undefined || configured.trim() === '') {
    return {
      kind: 'refused',
      outcome: outcome({
        command,
        exitCode: EXIT_USAGE,
        diagnostics: [
          cliError({
            code: CLI_DIAGNOSTIC_CODES.traceDirMissing,
            message: `no trace directory: \`aid ${command}\` needs one to read.`,
            hint: `Pass it as \`aid ${command} ${usage}\`, or set ${TRACE_DIR_ENV} to the directory the runtime writes to.`,
          }),
        ],
        text: `aid: no trace directory. Pass one, or set ${TRACE_DIR_ENV}.\n`,
      }),
    };
  }

  const absolute = resolve(context.cwd, configured);
  return { kind: 'ok', absolute, shown: displayPath(context.cwd, absolute) };
}

/**
 * Confirm a located directory is one, refusing with `2` when it is not.
 *
 * A path that exists but is a file is refused the same way as one that does not: neither
 * is a directory this command can read, and the fix is the same.
 */
export function confirmTraceDir(
  located: { readonly absolute: string; readonly shown: string },
  command: string,
): TraceDirResolution {
  const { absolute, shown } = located;

  let isDirectory = false;
  try {
    isDirectory = statSync(absolute).isDirectory();
  } catch {
    isDirectory = false;
  }

  if (!isDirectory) {
    return {
      kind: 'refused',
      outcome: outcome({
        command,
        exitCode: EXIT_USAGE,
        diagnostics: [
          cliError({
            code: CLI_DIAGNOSTIC_CODES.traceDirNotFound,
            message: `"${shown}" is not a directory.`,
            hint: `Point \`aid ${command}\` at the directory ${TRACE_DIR_ENV} names, or unset it to be told which is missing.`,
          }),
        ],
        text: `aid: "${shown}" is not a directory.\n`,
      }),
    };
  }

  return { kind: 'ok', absolute, shown };
}

/** Locate and confirm in one call, for a command that has nothing to check in between. */
export function resolveTraceDir(
  context: CliContext,
  argument: string | undefined,
  command: string,
  usage = '<dir>',
): TraceDirResolution {
  const located = locateTraceDir(context, argument, command, usage);
  if (located.kind === 'refused') return located;
  return confirmTraceDir(located, command);
}
