/**
 * `aid trace` — read a traced run back out of the local trace sink.
 *
 * The sink records *what happened*, not *what was said*: spans carry timing, kind, model,
 * token counts and priced cost, but no prompts and no completions. So this command
 * **inspects** a run; it does not replay one. A replay needs the request payloads, and
 * inventing them -- asking the model again -- would answer a different question than "what
 * happened here", while looking like an answer to it. Replay stays unimplemented until the
 * sink records payloads, and the help text says so rather than letting a reader assume.
 *
 * Exit codes:
 *
 * - `2` when the invocation is wrong: no directory, a selector that matches no run or more
 *   than one, or `--run` together with `--all`.
 * - `1` only when a trace file exists and could not be read. The tree still prints: what
 *   was readable is worth seeing.
 * - `0` otherwise, including a directory with no runs yet -- "nothing ran" is a true
 *   answer, and the warning on stderr says why it is empty.
 */

import type { CliContext } from '../context.js';
import type { CliDiagnostic } from '../diagnostics.js';
import { CLI_DIAGNOSTIC_CODES, cliError, cliWarning } from '../diagnostics.js';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from '../exit.js';
import type { CommandOutcome } from '../output.js';
import { group, outcome, usd } from '../output.js';
import type { SpanRow, TraceRun } from '../trace.js';
import { runsOf, treeRowsOf } from '../trace.js';
import { readTraceDir, resolveTraceDir, TRACE_DIR_ENV } from '../trace-dir.js';

export interface TraceOptions {
  /** The directory to read; defaults to `$AID_TRACE_DIR`. */
  readonly dir: string | undefined;
  /** A full trace id, or an unambiguous prefix of one. */
  readonly run: string | undefined;
  /** Print every run's tree instead of the run list. */
  readonly all: boolean;
}

/** What a reader wants to know about a run before opening it. */
function summaryOf(run: TraceRun): Record<string, unknown> {
  return {
    traceId: run.traceId,
    startedAt: run.startedAt,
    durationMs: run.durationMs,
    spans: run.spans.length,
    errors: run.errors,
    costUsd: run.costUsd,
    unpricedSpans: run.unpricedSpans,
    ...(run.root === undefined ? {} : { rootSpanId: run.root.span_id, rootName: run.root.name }),
  };
}

function rowOf(row: SpanRow): Record<string, unknown> {
  const { facts } = row;
  return {
    spanId: row.span.span_id,
    ...(row.span.parent_span_id == null ? {} : { parentSpanId: row.span.parent_span_id }),
    name: row.span.name,
    ...(row.span.kind === undefined ? {} : { kind: row.span.kind }),
    depth: row.depth,
    ...(row.offsetMs === undefined ? {} : { offsetMs: row.offsetMs }),
    ...(row.span.started_at === undefined ? {} : { startedAt: row.span.started_at }),
    ...(facts.durationMs === undefined ? {} : { durationMs: facts.durationMs }),
    ...(facts.model === undefined ? {} : { model: facts.model }),
    ...(facts.inputTokens === undefined ? {} : { inputTokens: facts.inputTokens }),
    ...(facts.outputTokens === undefined ? {} : { outputTokens: facts.outputTokens }),
    ...(facts.costUsd === undefined ? {} : { costUsd: facts.costUsd }),
    ...(row.span.status?.message == null ? {} : { statusMessage: row.span.status.message }),
    error: facts.error,
  };
}

function maxNameWidth(rows: readonly SpanRow[]): number {
  return Math.max(0, ...rows.map((row) => row.span.name.length));
}

function treeLines(rows: readonly SpanRow[]): string[] {
  const width = maxNameWidth(rows);
  return rows.map((row) => {
    const indent = '  '.repeat(row.depth);
    const offset = row.offsetMs === undefined ? '-' : `+${group(row.offsetMs)}ms`;
    const duration = row.facts.durationMs === undefined ? '-' : `${group(row.facts.durationMs)}ms`;
    const parts = [indent + row.span.name.padEnd(width), row.span.kind ?? '-'];

    if (row.facts.model !== undefined) {
      const tokens =
        row.facts.inputTokens === undefined && row.facts.outputTokens === undefined
          ? ''
          : ` ${group(row.facts.inputTokens ?? 0)}→${group(row.facts.outputTokens ?? 0)}`;
      parts.push(row.facts.model + tokens);
    }
    if (row.facts.costUsd !== undefined) parts.push(usd(row.facts.costUsd, 6));
    if (row.facts.error) {
      const message = row.span.status?.message;
      parts.push(message == null || message === '' ? 'ERROR' : `ERROR ${message}`);
    }

    return `${offset.padStart(9)}  ${duration.padStart(9)}  ${parts.join('  ')}`;
  });
}

function runHeader(run: TraceRun, spanCount: number): string[] {
  const label = run.root === undefined ? '(no single root)' : run.root.name;
  const cost =
    run.unpricedSpans === 0
      ? usd(run.costUsd, 6)
      : `${usd(run.costUsd, 6)} + ${group(run.unpricedSpans)} unpriced`;
  return [
    `run: ${run.traceId}  ${label}`,
    `started: ${run.startedAt === '' ? '-' : run.startedAt}`,
    `wall: ${group(run.durationMs)}ms  spans: ${group(spanCount)}  errors: ${group(run.errors)}`,
    `cost: ${cost}`,
  ];
}

function listLines(runs: readonly TraceRun[]): string[] {
  if (runs.length === 0) return ['no runs recorded.'];
  const ids = Math.max(...runs.map((run) => run.traceId.length));
  const lines = [`${group(runs.length)} run(s), newest first:`];
  for (const run of runs) {
    const label = run.root === undefined ? '-' : run.root.name;
    const cost = run.unpricedSpans === 0 ? usd(run.costUsd, 6) : `${usd(run.costUsd, 6)}+`;
    const errors = run.errors === 0 ? '' : `  ${group(run.errors)} ERROR`;
    lines.push(
      `  ${run.traceId.padEnd(ids)}  ${run.startedAt.padEnd(24)}  ${`${group(run.durationMs)}ms`.padStart(9)}  ${`${group(run.spans.length)} spans`.padStart(10)}  ${label}  ${cost}${errors}`,
    );
  }
  return lines;
}

/** Exact id first, then a unique prefix; ambiguity is reported, never guessed through. */
function selectRun(
  runs: readonly TraceRun[],
  selector: string,
): { readonly run: TraceRun } | { readonly matches: readonly string[] } | undefined {
  const exact = runs.find((run) => run.traceId === selector);
  if (exact !== undefined) return { run: exact };
  const matches = runs.filter((run) => run.traceId.startsWith(selector)).map((run) => run.traceId);
  if (matches.length === 1) {
    const only = runs.find((run) => run.traceId === matches[0]);
    if (only !== undefined) return { run: only };
  }
  if (matches.length > 1) return { matches };
  return undefined;
}

function selectionRefusal(
  command: string,
  selector: string,
  matches: readonly string[] | undefined,
): CommandOutcome {
  if (matches === undefined) {
    return outcome({
      command,
      exitCode: EXIT_USAGE,
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.traceRunNotFound,
          message: `no run starts with "${selector}".`,
          hint: 'Run `aid trace` with no selector to list the runs in the directory, then pass an id or an unambiguous prefix.',
        }),
      ],
      text: `aid: no run starts with "${selector}".\n`,
    });
  }

  return outcome({
    command,
    exitCode: EXIT_USAGE,
    diagnostics: [
      cliError({
        code: CLI_DIAGNOSTIC_CODES.traceRunAmbiguous,
        message: `"${selector}" matches ${matches.length} runs: ${matches.join(', ')}.`,
        hint: 'Pass a longer prefix, or the whole id.',
      }),
    ],
    text: `aid: "${selector}" matches ${matches.length} runs. Pass a longer prefix.\n`,
  });
}

export function trace(context: CliContext, options: TraceOptions): CommandOutcome {
  const command = 'trace';

  if (options.run !== undefined && options.all) {
    return outcome({
      command,
      exitCode: EXIT_USAGE,
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.traceFlagsConflict,
          message: '--run and --all ask for different reports.',
          hint: 'Pass --run <id> for one run, or --all for every run, not both.',
        }),
      ],
      text: 'aid: --run and --all ask for different reports.\n',
    });
  }

  const resolved = resolveTraceDir(context, options.dir, command, '--dir <dir>');
  if (resolved.kind === 'refused') return resolved.outcome;
  const shown = resolved.shown;

  const diagnostics: CliDiagnostic[] = [];
  const { files, spans, skipped, unreadable } = readTraceDir(resolved.absolute);

  if (unreadable > 0) {
    diagnostics.push(
      cliError({
        code: CLI_DIAGNOSTIC_CODES.traceUnreadable,
        message: `could not read ${unreadable} trace file(s) in "${shown}": this view covers only the files that were readable.`,
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

  if (files.length === 0) {
    diagnostics.push(
      cliWarning({
        code: CLI_DIAGNOSTIC_CODES.traceEmpty,
        message: `no trace files in "${shown}".`,
        hint: `The runtime writes one when ${TRACE_DIR_ENV} is set and a model call runs; check that this is the directory it names.`,
      }),
    );
  }

  const runs = runsOf(spans);
  const exitCode = unreadable > 0 ? EXIT_FAILURE : EXIT_OK;
  const base = { dir: shown, files: files.length, spans: spans.length };

  if (options.run !== undefined) {
    const selected = selectRun(runs, options.run);
    if (selected === undefined || !('run' in selected)) {
      return selectionRefusal(command, options.run, selected?.matches);
    }
    const rows = treeRowsOf(selected.run);
    return outcome({
      command,
      exitCode,
      fields: { ...base, run: summaryOf(selected.run), tree: rows.map(rowOf) },
      diagnostics,
      text: [...runHeader(selected.run, rows.length), '', ...treeLines(rows)].join('\n'),
    });
  }

  if (runs.length === 0 && files.length > 0) {
    diagnostics.push(
      cliWarning({
        code: CLI_DIAGNOSTIC_CODES.traceNoRuns,
        message: `"${shown}" has ${files.length} trace file(s) but no complete span records.`,
        hint: 'Check that the runtime finished the call it was tracing, and that the files are not empty.',
      }),
    );
  }

  if (options.all) {
    const blocks: string[] = [];
    for (const run of runs)
      blocks.push(
        [...runHeader(run, run.spans.length), '', ...treeLines(treeRowsOf(run))].join('\n'),
      );
    return outcome({
      command,
      exitCode,
      fields: {
        ...base,
        runs: runs.map((run) => ({ ...summaryOf(run), tree: treeRowsOf(run).map(rowOf) })),
      },
      diagnostics,
      text: blocks.length === 0 ? 'no runs recorded.\n' : blocks.join('\n\n'),
    });
  }

  return outcome({
    command,
    exitCode,
    fields: { ...base, runs: runs.map(summaryOf) },
    diagnostics,
    text: listLines(runs).join('\n'),
  });
}
