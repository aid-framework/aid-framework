/**
 * `aid cost` Ã¢â‚¬â€ a cost and latency report read from the local trace sink.
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

import type { CliContext } from '../context.js';
import type { CliDiagnostic } from '../diagnostics.js';
import { CLI_DIAGNOSTIC_CODES, cliError, cliWarning } from '../diagnostics.js';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from '../exit.js';
import type { CommandOutcome } from '../output.js';
import { group, outcome, usd } from '../output.js';
import type { CostSummary, ModelSpend } from '../trace.js';
import { parseSince, summariseSpans } from '../trace.js';
import { confirmTraceDir, locateTraceDir, readTraceDir, TRACE_DIR_ENV } from '../trace-dir.js';

export interface CostOptions {
  /** The directory to read; defaults to `$AID_TRACE_DIR`. */
  readonly dir: string | undefined;
  readonly since: string | undefined;
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
        usd(model.costUsd, 6).padStart(14),
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
      ? `cost: ${usd(summary.costUsd, 6)}`
      : `cost: ${usd(summary.costUsd, 6)} (${summary.unpricedSpans} unpriced span(s) not included)`,
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

  const located = locateTraceDir(context, options.dir, command);
  if (located.kind === 'refused') return located.outcome;
  const shown = located.shown;

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

  const confirmed = confirmTraceDir(located, command);
  if (confirmed.kind === 'refused') return confirmed.outcome;

  const diagnostics: CliDiagnostic[] = [];
  const { files: names, spans: all, skipped, unreadable } = readTraceDir(confirmed.absolute);

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
