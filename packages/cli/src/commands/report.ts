/**
 * `aid report` -- compare many deployments from files alone.
 *
 * The report reads a directory of deployment directories and prints one row per
 * deployment: spans, traces, measured cost, p95 latency, errors, and how many recorded
 * eval baselines are committed next to the traces. Nothing here is a new measurement.
 * The runtime wrote the spans and priced them; `aid eval --baseline` wrote the baselines;
 * this command only puts the two side by side so a team can compare twenty customers
 * without a hosted backend, and can do it in CI on the artifacts a build already has.
 *
 * It deliberately does **not** join to the repository's overlays. `aid fleet` answers the
 * repository question -- which customers exist and do their specs pass -- and this answers
 * the operations question, from a directory that may well be a CI download rather than
 * the repo at all. Joining them would make the report refuse whenever the two names did
 * not match, which is a naming convention pretending to be a fact.
 *
 * Exit codes follow the CLI's taxonomy rather than "did the numbers look bad":
 *
 * - `2` when the invocation is wrong: no directory, or a path that is not a directory.
 * - `1` when a trace file exists and could not be read. The rows still print, because what
 *   was readable is worth comparing.
 * - `0` otherwise, including for an empty directory: "no deployments here" is a true
 *   answer, and the warning on stderr says why it is empty.
 */

import type { CliContext } from '../context.js';
import type { CliDiagnostic } from '../diagnostics.js';
import { CLI_DIAGNOSTIC_CODES, cliError, cliWarning } from '../diagnostics.js';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from '../exit.js';
import type { CommandOutcome } from '../output.js';
import { group, outcome, usd } from '../output.js';
import { absolutePath } from '../paths.js';
import type { DeploymentReport } from '../report.js';
import { isDirectory, readFleetReport } from '../report.js';
import { parseBudget } from './cost.js';

export interface ReportOptions {
  /** The directory of deployments to read. Required: there is no sensible default fleet. */
  readonly dir: string | undefined;
  /**
   * A ceiling in USD for the *sum* across deployments; unset means report only. The
   * per-deployment ceiling is `aid cost --budget`'s job; this one exists because the
   * question "what does the fleet cost" cannot be answered by N separate refusals.
   */
  readonly budget: string | undefined;
}

const DASH = '—';

/**
 * A right-aligned cell, or a dash in the same width when there is nothing to show. The
 * dash is padded too: a table whose empty cells shift the columns is a table nobody can
 * scan, which defeats the point of putting deployments side by side.
 */
function cell(value: number | undefined, width: number, render: (value: number) => string): string {
  return value === undefined ? DASH.padStart(width) : render(value).padStart(width);
}

/**
 * A metric mean, at a precision that works for a score and for a cost. A recorded mean has
 * no declared unit -- `exact_match` is a ratio and `cost_usd` is dollars -- so a fixed
 * number of decimals would print `0.004` for a cost that is `0.0042`, and a zero-looking
 * score for a metric whose values are small. Four significant digits neither rounds a
 * quality score away nor prints eleven zeros in front of a useful digit.
 */
function metricValue(mean: number): string {
  return mean === 0 ? '0' : String(Number(mean.toPrecision(4)));
}

function baselineCell(report: DeploymentReport): string {
  const count = report.baselines.length;
  if (count === 0) return DASH;
  const named = report.baselines.flatMap((baseline) =>
    baseline.metrics.map((metric) => `${metric.metric} ${metricValue(metric.mean)}`),
  );
  return named.length === 0 ? `${count} baseline(s)` : `${count} baseline(s): ${named.join(', ')}`;
}

function tableLines(reports: readonly DeploymentReport[]): string[] {
  const width = Math.max(10, ...reports.map((report) => report.deployment.length));
  const lines = [
    [
      'deployment'.padEnd(width),
      'spans'.padStart(7),
      'traces'.padStart(7),
      'cost'.padStart(11),
      'p95'.padStart(8),
      'errors'.padStart(7),
      'evals',
    ].join('  '),
  ];

  for (const report of reports) {
    const summary = report.summary;
    lines.push(
      [
        report.deployment.padEnd(width),
        cell(summary?.spans, 7, group),
        cell(summary?.traces, 7, group),
        cell(summary?.costUsd, 11, (value) => usd(value, 6)),
        cell(summary?.latency?.p95, 8, (value) => `${group(value)}ms`),
        cell(summary?.errors, 7, group),
        baselineCell(report),
      ].join('  '),
    );
  }

  return lines;
}

export function report(context: CliContext, options: ReportOptions): CommandOutcome {
  const command = 'report';

  if (options.dir === undefined) {
    return outcome({
      command,
      exitCode: EXIT_USAGE,
      fields: { dir: null, deployments: [], totals: null },
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.reportDirUnreadable,
          message: 'aid report needs a directory of deployments to read.',
          hint: 'Pass a directory whose immediate children are deployment directories, each holding the *.jsonl files the runtime wrote and any *.baseline.json files you committed.',
        }),
      ],
      text: 'aid: aid report needs a directory of deployments to read.\n',
    });
  }

  const absolute = absolutePath(context.cwd, options.dir);
  if (!isDirectory(absolute)) {
    return outcome({
      command,
      exitCode: EXIT_USAGE,
      fields: { dir: options.dir, deployments: [], totals: null },
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.reportDirUnreadable,
          message: `"${options.dir}" is not a directory.`,
          hint: 'Point aid report at the directory that holds one subdirectory per deployment. A trace directory with spans directly inside it is what `aid cost` reads, not this.',
        }),
      ],
      text: `aid: "${options.dir}" is not a directory.\n`,
    });
  }

  let budget: number | undefined;
  if (options.budget !== undefined) {
    budget = parseBudget(options.budget);
    if (budget === undefined) {
      return outcome({
        command,
        exitCode: EXIT_USAGE,
        fields: { dir: options.dir, deployments: [], totals: null },
        diagnostics: [
          cliError({
            code: CLI_DIAGNOSTIC_CODES.costBudgetInvalid,
            message: `--budget "${options.budget}" is not a non-negative amount in USD.`,
            hint: 'Pass a plain decimal, for example --budget 250 or --budget 12.50.',
          }),
        ],
        text: `aid: --budget "${options.budget}" is not a non-negative amount in USD.\n`,
      });
    }
  }

  const { deployments, badBaselines, unlistable, rootUnreadable } = readFleetReport(absolute);
  const diagnostics: CliDiagnostic[] = [];

  if (rootUnreadable) {
    return outcome({
      command,
      exitCode: EXIT_FAILURE,
      fields: { dir: options.dir, deployments: [], totals: null },
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.reportDirUnreadable,
          message: `"${options.dir}" is a directory but could not be listed.`,
          hint: 'The request was fine and the path exists, so this is a permissions or I/O problem on the machine running the report -- not a verdict on any deployment.',
        }),
      ],
      text: `aid: "${options.dir}" is a directory but could not be listed.\n`,
    });
  }

  for (const entry of badBaselines) {
    diagnostics.push(
      cliWarning({
        code: CLI_DIAGNOSTIC_CODES.reportBaselineInvalid,
        message: `"${entry.deployment}/${entry.file}" is not a recorded baseline, so its scores are not shown.`,
        hint: 'A baseline needs dataset, dataset_version and metrics[].{metric,mean}. Regenerate it with `aid eval --baseline` rather than editing it.',
      }),
    );
  }

  for (const name of unlistable) {
    diagnostics.push(
      cliWarning({
        code: CLI_DIAGNOSTIC_CODES.reportBaselineInvalid,
        message: `"${name}" could not be read, so it is not in the report.`,
        hint: 'Check the directory permissions. The other deployments are unaffected, which is why this is a warning.',
      }),
    );
  }

  const unreadable = deployments.reduce((total, entry) => total + entry.unreadable, 0);
  const skipped = deployments.reduce((total, entry) => total + entry.skipped, 0);

  if (unreadable > 0) {
    diagnostics.push(
      cliError({
        code: CLI_DIAGNOSTIC_CODES.traceUnreadable,
        message: `could not read ${unreadable} trace file(s) across the report: the figures cover only the files that were readable.`,
        hint: 'Check the file permissions, or move the unreadable file out of its deployment directory.',
      }),
    );
  }

  if (skipped > 0) {
    diagnostics.push(
      cliWarning({
        code: CLI_DIAGNOSTIC_CODES.traceMalformed,
        message: `skipped ${skipped} line(s) that are not complete span records.`,
        hint: 'A trace file is appended to while it is read, so a truncated last line is normal; a large count is not.',
      }),
    );
  }

  if (deployments.length === 0) {
    diagnostics.push(
      cliWarning({
        code: CLI_DIAGNOSTIC_CODES.reportNoDeployments,
        message: `no deployment directories in "${options.dir}".`,
        hint: 'Each immediate child directory is one deployment. An empty report is a true answer, but check that the trace sink was downloaded to the right place.',
      }),
    );
  }

  const measured = deployments.filter((entry) => entry.summary !== undefined);
  const totals = {
    deployments: deployments.length,
    measured: measured.length,
    spans: measured.reduce((total, entry) => total + (entry.summary?.spans ?? 0), 0),
    traces: measured.reduce((total, entry) => total + (entry.summary?.traces ?? 0), 0),
    costUsd: measured.reduce((total, entry) => total + (entry.summary?.costUsd ?? 0), 0),
    errors: measured.reduce((total, entry) => total + (entry.summary?.errors ?? 0), 0),
    unpricedSpans: measured.reduce(
      (total, entry) => total + (entry.summary?.unpricedSpans ?? 0),
      0,
    ),
  };

  const overBudget = budget !== undefined && totals.costUsd > budget;
  if (overBudget && budget !== undefined) {
    diagnostics.push(
      cliError({
        code: CLI_DIAGNOSTIC_CODES.costOverBudget,
        message: `the fleet's measured cost ${usd(totals.costUsd, 6)} exceeds the --budget ceiling ${usd(budget, 6)} by ${usd(totals.costUsd - budget, 6)}.`,
        hint: 'Either the ceiling is out of date or a deployment is spending more than it should; `aid cost --budget` per deployment narrows down which one.',
      }),
    );
  }

  const fields = {
    dir: options.dir,
    deployments: deployments.map((entry) => ({
      deployment: entry.deployment,
      files: entry.files,
      ...(entry.summary === undefined
        ? {}
        : {
            spans: entry.summary.spans,
            traces: entry.summary.traces,
            costUsd: entry.summary.costUsd,
            unpricedSpans: entry.summary.unpricedSpans,
            errors: entry.summary.errors,
            ...(entry.summary.latency === undefined ? {} : { p95Ms: entry.summary.latency.p95 }),
          }),
      baselines: entry.baselines.map((baseline) => ({
        file: baseline.file,
        dataset: baseline.dataset,
        datasetVersion: baseline.datasetVersion,
        metrics: baseline.metrics,
      })),
      skipped: entry.skipped,
      unreadable: entry.unreadable,
    })),
    totals,
    unlistable,
    badBaselines,
    ...(budget === undefined ? {} : { budgetUsd: budget, overBudget }),
  };

  const lines = [`dir: ${options.dir}`];
  lines.push(...tableLines(deployments));
  if (measured.length === 0) {
    lines.push(
      deployments.length === 0
        ? 'measured: no deployment directories here, so no cost, latency or error figures exist to compare.'
        : `measured: none of ${deployments.length} deployment(s) has trace files yet, so no cost, latency or error figures exist to compare.`,
    );
  } else {
    const unpriced =
      totals.unpricedSpans === 0
        ? ''
        : ` (${group(totals.unpricedSpans)} unpriced span(s) not included)`;
    lines.push(
      `total: ${group(totals.spans)} span(s) in ${group(totals.traces)} trace(s) across ${measured.length} of ${deployments.length} deployment(s), ${usd(totals.costUsd, 6)}${unpriced}`,
    );
  }
  if (budget !== undefined) {
    lines.push(
      overBudget
        ? `budget: ${usd(budget, 6)} (over by ${usd(totals.costUsd - budget, 6)})`
        : `budget: ${usd(budget, 6)} (within)`,
    );
  }

  return outcome({
    command,
    exitCode: unreadable > 0 || overBudget ? EXIT_FAILURE : EXIT_OK,
    fields,
    diagnostics,
    text: `${lines.join('\n')}\n`,
  });
}
