/**
 * `aid cost` — a cost and latency report read from the local trace sink.
 *
 * The numbers already exist. `runtimes/{python,typescript}` write one JSONL span per line
 * whenever `AID_TRACE_DIR` is set, and those spans carry the GenAI token attributes and
 * the priced `aid.cost.usd` the gateway computed. This command adds no pricing rule and
 * no estimate: it reads what the runtime recorded and aggregates it. The build-time
 * estimate is the IR's cost gate, and a second pricing implementation here would be a
 * second answer to "what does this cost".
 *
 * Exit codes follow the CLI's taxonomy rather than "did the bill look big":
 *
 * - `2` when there is nowhere to read from (no directory, or one that does not exist), or
 *   when `--since` is not a date. The invocation or the environment is wrong, so no
 *   judgement about the project has been made.
 * - `1` only when a trace file exists and could not be read. The report still prints what
 *   was readable, because a partial report is more useful than none.
 * - `0` otherwise, including for an empty directory: a report of zero spans is true, and
 *   the warning on stderr says why it is zero.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { CliContext } from '../context.js';
import type { CliDiagnostic } from '../diagnostics.js';
import { CLI_DIAGNOSTIC_CODES, cliError, cliWarning } from '../diagnostics.js';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from '../exit.js';
import type { CommandOutcome } from '../output.js';
import { outcome } from '../output.js';
import type { CostSummary, ModelSpend, TraceSpan } from '../trace.js';
import { parseSince, parseTraceLines, summariseSpans } from '../trace.js';

/** The variable the runtimes read. Named here, not imported, because it is a runtime knob. */
const TRACE_DIR_ENV = 'AID_TRACE_DIR';

export interface CostOptions {
  /** The directory to read; defaults to `$AID_TRACE_DIR`. */
  readonly dir: string | undefined;
  readonly since: string | undefined;
}

function displayPath(cwd: string, absolute: string): string {
  const path = relative(cwd, absolute);
  if (path === '') return '.';
  if (path.startsWith('..') || isAbsolute(path)) return absolute;
  return path.split(sep).join('/');
}

function group(value: number): string {
  return String(Math.trunc(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function usd(value: number): string {
  return `$${value.toFixed(6)}`;
}

function modelLines(models: readonly ModelSpend[]): string[] {
  if (models.length === 0) return [];
  const width = Math.max(...models.map((model) => model.model.length));
  const lines = ['by model:'];
  for (const model of models) {
    const unpriced = model.unpricedCalls === 0 ? '' : `  (${model.unpricedCalls} unpriced)`;
    lines.push(
      [
        `  ${model.model.padEnd(width)}`,
        `${String(model.calls).padStart(4)} calls`,
        `${group(model.inputTokens).padStart(9)} in`,
        `${group(model.outputTokens).padStart(9)} out`,
        usd(model.costUsd).padStart(14),
        unpriced,
      ].join('  '),
    );
  }
  return lines;
}

function reportLines(summary: CostSummary, dir: string, since: string | undefined): string[] {
  const scope = since === undefined ? '' : ` since ${since}`;
  const lines = [
    `dir: ${dir}`,
    `spans: ${group(summary.spans)} in ${group(summary.traces)} trace(s)${scope}`,
    summary.unpricedSpans === 0
      ? `cost: ${usd(summary.costUsd)}`
      : `cost: ${usd(summary.costUsd)} (${summary.unpricedSpans} unpriced span(s) not included)`,
    `tokens: ${group(summary.inputTokens)} input, ${group(summary.outputTokens)} output`,
  ];
  if (summary.latency !== undefined) {
    lines.push(
      `latency: p50 ${group(summary.latency.p50)}ms, p95 ${group(summary.latency.p95)}ms over ${group(summary.latency.samples)} model call(s)`,
    );
  }
  if (summary.errors > 0) lines.push(`errors: ${group(summary.errors)} span(s)`);
  lines.push(...modelLines(summary.models));
  return lines;
}

export function cost(context: CliContext, options: CostOptions): CommandOutcome {
  const command = 'cost';

  const configured = options.dir ?? context.env[TRACE_DIR_ENV]?.trim();
  if (configured === undefined || configured === '') {
    return outcome({
      command,
      exitCode: EXIT_USAGE,
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.traceDirMissing,
          message: `no trace directory: \`aid cost\` needs one to read.`,
          hint: `Pass it as \`aid ${command} <dir>\`, or set ${TRACE_DIR_ENV} to the directory the runtime writes to.`,
        }),
      ],
      text: `aid: no trace directory. Pass one, or set ${TRACE_DIR_ENV}.\n`,
    });
  }

  let since: string | undefined;
  if (options.since !== undefined) {
    since = parseSince(options.since);
    if (since === undefined) {
      return outcome({
        command,
        exitCode: EXIT_USAGE,
        diagnostics: [
          cliError({
            code: CLI_DIAGNOSTIC_CODES.traceSinceInvalid,
            message: `--since "${options.since}" is not a date.`,
            hint: 'Use YYYY-MM-DD (UTC midnight) or an ISO 8601 instant with an offset, such as 2026-10-01T12:00:00Z.',
          }),
        ],
        text: `aid: --since "${options.since}" is not a date.\n`,
      });
    }
  }

  const absolute = resolve(context.cwd, configured);
  const shown = displayPath(context.cwd, absolute);
  const diagnostics: CliDiagnostic[] = [];
  let isDirectory = false;
  try {
    isDirectory = statSync(absolute).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    return outcome({
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
    });
  }

  const names = readdirSync(absolute, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => entry.name)
    .sort();

  let skipped = 0;
  const all: TraceSpan[] = [];
  let unreadable = 0;

  for (const name of names) {
    let text: string;
    try {
      text = readFileSync(join(absolute, name), 'utf8');
    } catch {
      // Counted, not thrown: one unreadable file should not hide the spans in the rest.
      unreadable += 1;
      continue;
    }
    const parsed = parseTraceLines(text);
    all.push(...parsed.spans);
    skipped += parsed.skipped;
  }

  if (unreadable > 0) {
    diagnostics.push(
      cliError({
        code: CLI_DIAGNOSTIC_CODES.traceUnreadable,
        message: `could not read ${unreadable} trace file(s) in "${shown}": the report covers only the files that were readable.`,
        hint: 'Check the file permissions, or move the unreadable file out of the directory.',
      }),
    );
  }

  if (skipped > 0) {
    diagnostics.push(
      cliWarning({
        code: CLI_DIAGNOSTIC_CODES.traceMalformed,
        message: `skipped ${skipped} line(s) in "${shown}" that are not complete span records.`,
        hint: 'A trace file is appended to while it is read, so a truncated last line is normal; a large count is not.',
      }),
    );
  }

  if (names.length === 0) {
    diagnostics.push(
      cliWarning({
        code: CLI_DIAGNOSTIC_CODES.traceEmpty,
        message: `no trace files in "${shown}".`,
        hint: `The runtime writes one when ${TRACE_DIR_ENV} is set and a model call runs; check that this is the directory it names.`,
      }),
    );
  }

  const summary = summariseSpans(all, since === undefined ? {} : { since });
  const exitCode = unreadable > 0 ? EXIT_FAILURE : EXIT_OK;

  return outcome({
    command,
    exitCode,
    fields: {
      dir: shown,
      ...(since === undefined ? {} : { since }),
      files: names.length,
      spans: summary.spans,
      traces: summary.traces,
      errors: summary.errors,
      inputTokens: summary.inputTokens,
      outputTokens: summary.outputTokens,
      costUsd: summary.costUsd,
      unpricedSpans: summary.unpricedSpans,
      ...(summary.latency === undefined
        ? {}
        : { latencyMs: { p50: summary.latency.p50, p95: summary.latency.p95 } }),
      models: summary.models,
    },
    diagnostics,
    text: reportLines(summary, shown, since).join('\n'),
  });
}
