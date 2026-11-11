/**
 * Reading many deployments' files into one comparison.
 *
 * `aid cost` answers "what did this one directory cost". A team running twenty customers
 * needs the other question -- "how do these compare" -- and the answer has to come from
 * files, because AID has no fleet database and does not want one. So a report is a
 * directory of directories: one child per deployment, each holding the trace sink files
 * its runtime wrote, plus any recorded eval baseline it committed.
 *
 * Two formats, both already written by existing tooling, and nothing invented here:
 *
 * - `*.jsonl` -- the runtime's trace sink, the same files `aid cost` and `aid trace` read.
 * - `*.baseline.json` -- the recorded baseline `aid eval --baseline` writes, the same file
 *   `aid eval --compare` reads back. The suffix is what distinguishes it from a trace
 *   file, since both live in the deployment's directory.
 *
 * A deployment with no traces reports no traces rather than a cost of zero. Zero and "we
 * never looked" are different answers, and only one of them belongs in a comparison, so
 * the row omits the number instead of inventing it.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { CostSummary } from './trace.js';
import { summariseSpans } from './trace.js';
import type { TraceDir } from './trace-dir.js';
import { readTraceDir } from './trace-dir.js';

/** The suffix that marks a file as a recorded baseline rather than a trace sink file. */
export const BASELINE_SUFFIX = '.baseline.json';

/** One metric a baseline recorded, reduced to the mean a comparison row can show. */
export interface BaselineMetric {
  readonly metric: string;
  readonly mean: number;
}

/** One committed eval baseline, reduced to what a comparison row can show. */
export interface EvalBaseline {
  /** The file name inside the deployment directory. */
  readonly file: string;
  readonly dataset: string;
  readonly datasetVersion: string;
  /** Metric names in the order the runtime wrote them, with their recorded means. */
  readonly metrics: readonly BaselineMetric[];
}

/**
 * One deployment's row.
 *
 * `summary` is absent, rather than zeroed, when the deployment has no trace files. That
 * is the difference between a customer whose traffic is quiet and one whose trace sink was
 * never wired up, and a report that prints `0` for both would hide the second.
 */
export interface DeploymentReport {
  readonly deployment: string;
  /** Files the sink wrote, whether or not they parsed. */
  readonly files: number;
  readonly summary?: CostSummary;
  readonly baselines: readonly EvalBaseline[];
  /** Lines that were not complete span records. */
  readonly skipped: number;
  /** Files that existed but could not be read. */
  readonly unreadable: number;
}

/** A `*.baseline.json` that exists but is not a recorded baseline. */
export interface BadBaseline {
  readonly deployment: string;
  readonly file: string;
}

export interface FleetReport {
  readonly deployments: readonly DeploymentReport[];
  readonly badBaselines: readonly BadBaseline[];
  /** Subdirectory names that exist but could not be listed. */
  readonly unlistable: readonly string[];
  /** The root itself could not be listed, so nothing below it was read. */
  readonly rootUnreadable: boolean;
}

/** Whether `name` is a recorded baseline by suffix. */
function isBaselineFile(name: string): boolean {
  return name.endsWith(BASELINE_SUFFIX);
}

/**
 * Parse a recorded baseline, or nothing.
 *
 * Deliberately lenient about everything except the fields a comparison reads. The file is
 * written by a runtime -- `aid eval --baseline` -- and may carry fields this version does
 * not know, so rejecting an unfamiliar key would refuse a newer baseline for no reason.
 * What it will not do is guess: a file missing `dataset` or `metrics[].mean` is reported
 * as a bad baseline rather than shown with a zero where a score should be.
 */
export function parseEvalBaseline(file: string, payload: unknown): EvalBaseline | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const record = payload as Record<string, unknown>;

  const dataset = record['dataset'];
  const version = record['dataset_version'];
  const metrics = record['metrics'];
  if (typeof dataset !== 'string' || dataset === '') return undefined;
  if (typeof version !== 'string' && typeof version !== 'number') return undefined;
  if (!Array.isArray(metrics)) return undefined;

  const parsed: BaselineMetric[] = [];
  for (const entry of metrics) {
    if (typeof entry !== 'object' || entry === null) return undefined;
    const item = entry as Record<string, unknown>;
    const metric = item['metric'];
    const mean = item['mean'];
    if (typeof metric !== 'string' || metric === '') return undefined;
    if (typeof mean !== 'number' || !Number.isFinite(mean)) return undefined;
    parsed.push({ metric, mean });
  }

  return { file, dataset, datasetVersion: String(version), metrics: parsed };
}

/** Every baseline in a deployment directory, with the ones that did not parse separated. */
function readBaselines(
  absolute: string,
  deployment: string,
): { readonly baselines: EvalBaseline[]; readonly bad: BadBaseline[] } {
  const baselines: EvalBaseline[] = [];
  const bad: BadBaseline[] = [];

  let names: string[];
  try {
    names = readdirSync(absolute).filter(isBaselineFile).sort();
  } catch {
    return { baselines, bad };
  }

  for (const name of names) {
    try {
      const text = readFileSync(join(absolute, name), 'utf8');
      const parsed = parseEvalBaseline(name, JSON.parse(text));
      if (parsed === undefined) {
        bad.push({ deployment, file: name });
      } else {
        baselines.push(parsed);
      }
    } catch {
      bad.push({ deployment, file: name });
    }
  }

  return { baselines, bad };
}

/** Read one deployment directory. */
function readDeployment(
  absolute: string,
  deployment: string,
): {
  readonly report: DeploymentReport;
  readonly bad: readonly BadBaseline[];
} {
  const traces: TraceDir = readTraceDir(absolute);
  const { baselines, bad } = readBaselines(absolute, deployment);

  const report: DeploymentReport = {
    deployment,
    files: traces.files.length,
    // No files at all means nothing was measured, which is not the same as measuring zero.
    ...(traces.files.length === 0 ? {} : { summary: summariseSpans(traces.spans) }),
    baselines,
    skipped: traces.skipped,
    unreadable: traces.unreadable,
  };

  return { report, bad };
}

/**
 * Read every deployment directly under `root`.
 *
 * Only direct children are deployments. A recursive walk would find a nested directory and
 * attribute its spans to whichever ancestor came first, which is a silently wrong answer
 * about a named customer -- so the layout is one level, and anything deeper is ignored.
 */
export function readFleetReport(root: string): FleetReport {
  const deployments: DeploymentReport[] = [];
  const badBaselines: BadBaseline[] = [];
  const unlistable: string[] = [];

  let names: string[];
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return { deployments, badBaselines, unlistable, rootUnreadable: true };
  }

  for (const name of names) {
    const absolute = join(root, name);
    try {
      if (!statSync(absolute).isDirectory()) continue;
      const read = readDeployment(absolute, name);
      deployments.push(read.report);
      badBaselines.push(...read.bad);
    } catch {
      unlistable.push(name);
    }
  }

  return { deployments, badBaselines, unlistable, rootUnreadable: false };
}

/** Whether a path exists and is a directory, for the invocation check. */
export function isDirectory(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
