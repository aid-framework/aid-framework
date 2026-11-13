/**
 * `aid eval --compare` — the promotion decision, taken from two committed baselines.
 *
 * **Why it reads files instead of running anything.** The generated eval module answers
 * "does this build meet its own `maxRegression`?". This answers a different question:
 * "may this candidate replace the accepted one?". The candidate is usually a branch, not a
 * directory, so there is nothing to run here — the evidence is two baseline files, both
 * already recorded by `--baseline` and both already in git. Reading them keeps the decision
 * reproducible from the repository alone, which is the whole constraint the fleet-level
 * features have to satisfy.
 *
 * **Why the policy is read from the spec, not from flags.** `evals.<id>.gate.promotion`
 * is the declared contract, and a build gate already refuses a policy that governs no
 * quality metric (`ir/promotion-regression`) or claims a cost allowance on an eval that
 * declares no cost ceiling (`ir/promotion-cost`). This layer therefore applies the policy and only
 * applies it: it invents no allowance, and the allowance a reader sees in the output is the
 * one in the YAML.
 *
 * **What it refuses to pretend.** A recorded baseline stores a mean pass rate per metric,
 * and now also a mean spend and latency per run when the run that produced it metered them.
 * `allowedCostIncrease` is judged whenever both files carry that spend block, and refused
 * with the reason when either does not: a baseline that records no spend is not evidence
 * that spend did not rise.
 */

import { existsSync, readFileSync } from 'node:fs';

import type { IR } from '@aid-framework/ir';

import type { CliContext } from '../context.js';
import type { CliDiagnostic } from '../diagnostics.js';
import { CLI_DIAGNOSTIC_CODES, cliError } from '../diagnostics.js';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from '../exit.js';
import type { CommandOutcome } from '../output.js';
import { outcome } from '../output.js';
import { absolutePath } from '../paths.js';

/** One metric line in a recorded baseline, as both runtimes serialize it. */
interface RecordedMetric {
  readonly metric: string;
  readonly runs: number;
  readonly mean: number;
  readonly stdev: number;
}

/** A committed baseline: the accepted distribution for a dataset and model. */
interface RecordedBaseline {
  readonly dataset: string;
  readonly datasetVersion: string;
  readonly model: string | null;
  readonly metrics: readonly RecordedMetric[];
  /**
   * Mean spend and latency per run, in dollars and milliseconds.
   *
   * `null` means the run that recorded this baseline metered neither, which is a different
   * statement from a run that spent nothing. Both runtimes write the block only when they
   * measured it, so an older file simply does not have the key.
   */
  readonly cost: RecordedAggregate | null;
  readonly latency: RecordedAggregate | null;
}

/** A recorded mean and spread over runs, in the unit of the field that holds it. */
interface RecordedAggregate {
  readonly runs: number;
  readonly mean: number;
  readonly stdev: number;
}

/** The cost allowance, judged: what each side spent per run and how far it moved. */
interface CostRow {
  readonly baselineMeanUsd: number;
  readonly candidateMeanUsd: number;
  /** `null` when the accepted run spent nothing, so no fraction of it exists. */
  readonly increase: number | null;
  readonly allowedIncrease: number;
  readonly within: boolean;
}

/** One row of the report: what the accepted run scored, what the candidate scored. */
interface ComparisonRow {
  readonly metric: string;
  readonly baselineMean: number;
  readonly candidateMean: number;
  readonly drop: number;
  readonly allowedDrop: number;
  readonly within: boolean;
}

export interface CompareOptions {
  readonly specPath: string;
  /** The eval whose policy applies; `undefined` means "the one that declares a policy". */
  readonly suite: string | undefined;
  readonly comparePath: string;
  readonly candidatePath: string;
}

const COMMAND = 'eval';

/**
 * The eval whose promotion policy governs this comparison.
 *
 * Naming it is not optional bookkeeping: the allowance belongs to an eval, and a document
 * with two gated evals has two answers. Asking for `--suite` is cheaper than picking one
 * and reporting a verdict that applies to neither.
 */
function policedEval(
  ir: IR,
  suite: string | undefined,
):
  | { readonly ok: true; readonly evalId: string; readonly policy: NonNullable<Policy> }
  | { readonly ok: false; readonly diagnostics: readonly CliDiagnostic[] } {
  const policed = ir.evals.filter((entry) => entry.gate.promotion !== undefined);
  if (suite !== undefined) {
    const named = ir.evals.find((entry) => entry.id === suite);
    if (named === undefined) {
      return {
        ok: false,
        diagnostics: [
          cliError({
            code: CLI_DIAGNOSTIC_CODES.suiteNotFound,
            message: `No eval named "${suite}" in the spec.`,
            path: ['evals'],
            hint:
              ir.evals.length > 0
                ? `Declared evals: ${ir.evals.map((entry) => entry.id).join(', ')}.`
                : 'The spec declares no evals.',
          }),
        ],
      };
    }
    if (named.gate.promotion === undefined) {
      return {
        ok: false,
        diagnostics: [
          cliError({
            code: CLI_DIAGNOSTIC_CODES.compareNoPolicy,
            message: `Eval "${suite}" declares no gate.promotion, so there is no allowance to compare against.`,
            path: ['evals', suite, 'gate'],
            hint: `Declare gate.promotion with allowedQualityDrop and a baseline, or compare the evals that have one.${
              policed.length > 0 ? ` Declared: ${policed.map((entry) => entry.id).join(', ')}.` : ''
            }`,
          }),
        ],
      };
    }
    return { ok: true, evalId: named.id, policy: named.gate.promotion };
  }

  const only = policed[0];
  if (policed.length === 1 && only !== undefined) {
    return { ok: true, evalId: only.id, policy: only.gate.promotion ?? unreachable() };
  }
  if (policed.length === 0) {
    return {
      ok: false,
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.compareNoPolicy,
          message:
            'No eval in the spec declares gate.promotion, so nothing says what counts as an acceptable candidate.',
          path: ['evals'],
          hint: 'Declare gate.promotion on the eval this candidate replaces, or pass --suite.',
        }),
      ],
    };
  }
  return {
    ok: false,
    diagnostics: [
      cliError({
        code: CLI_DIAGNOSTIC_CODES.compareSuiteRequired,
        message: `${String(policed.length)} evals declare a promotion policy, so the comparison has more than one possible verdict.`,
        path: ['evals'],
        hint: `Pass --suite with one of: ${policed.map((entry) => entry.id).join(', ')}.`,
      }),
    ],
  };
}

type Policy = IR['evals'][number]['gate']['promotion'];

function unreachable(): never {
  throw new Error('unreachable: the policy was filtered by presence');
}

/**
 * A baseline file, parsed and checked.
 *
 * The fields are `snake_case` because both runtimes serialize the runtime's own pydantic
 * or class field names, and a baseline in git is read back by that same runtime. This
 * layer reads the file rather than re-recording it, so it accepts the format it finds and
 * refuses anything that is not that format, instead of guessing at a shape.
 */
function readBaseline(
  context: CliContext,
  path: string,
  role: string,
):
  | { readonly ok: true; readonly baseline: RecordedBaseline }
  | { readonly ok: false; readonly diagnostics: readonly CliDiagnostic[] } {
  const resolved = absolutePath(context.cwd, path);
  if (!existsSync(resolved)) {
    return {
      ok: false,
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.compareUnreadable,
          message: `The ${role} baseline does not exist at ${path}.`,
          path: [path],
          hint: 'Record it with `aid eval --baseline`, commit it, and point --compare or --candidate at the committed file.',
        }),
      ],
    };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(resolved, 'utf8'));
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.compareUnreadable,
          message: `The ${role} baseline at ${path} is not valid JSON: ${String(error)}`,
          path: [path],
          hint: 'A baseline is written by the runtime; regenerate it with `aid eval --baseline` rather than editing it.',
        }),
      ],
    };
  }

  const parsed = parseBaseline(payload);
  if (parsed === undefined) {
    return {
      ok: false,
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.compareUnreadable,
          message: `The ${role} baseline at ${path} is not a recorded baseline: it needs dataset, dataset_version and metrics[].{metric,mean}, and any cost or latency block it carries must be {runs,mean,stdev}.`,
          path: [path],
          hint: 'Record it with `aid eval --baseline`: the shape is the runtime’s, and the runtime is what reads it back.',
        }),
      ],
    };
  }
  return { ok: true, baseline: parsed };
}

function parseBaseline(payload: unknown): RecordedBaseline | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const record = payload as Record<string, unknown>;
  const dataset = record.dataset;
  const datasetVersion = record.dataset_version;
  const model = record.model;
  const metrics = record.metrics;
  if (typeof dataset !== 'string') return undefined;
  if (typeof datasetVersion !== 'string') return undefined;
  if (!Array.isArray(metrics) || metrics.length === 0) return undefined;

  const parsed: RecordedMetric[] = [];
  for (const entry of metrics) {
    if (typeof entry !== 'object' || entry === null) return undefined;
    const metric = entry as Record<string, unknown>;
    if (typeof metric.metric !== 'string') return undefined;
    if (typeof metric.mean !== 'number') return undefined;
    // `runs` and `stdev` are reported but not judged, so an older baseline that predates
    // one of them still compares rather than being refused for a field it does not use.
    parsed.push({
      metric: metric.metric,
      runs: typeof metric.runs === 'number' ? metric.runs : 0,
      mean: metric.mean,
      stdev: typeof metric.stdev === 'number' ? metric.stdev : 0,
    });
  }

  const parsedAggregates = {
    cost: parseAggregate(record.cost),
    latency: parseAggregate(record.latency),
  };
  if (parsedAggregates.cost === false || parsedAggregates.latency === false) return undefined;

  return {
    dataset,
    datasetVersion,
    model: typeof model === 'string' ? model : null,
    metrics: parsed,
    cost: parsedAggregates.cost,
    latency: parsedAggregates.latency,
  };
}

/**
 * An optional spend or latency block.
 *
 * Three answers, because the third one matters: `null` for a baseline that does not carry
 * the block at all, the record when it does, and `false` when the block is present but
 * unreadable -- which is a corrupt file, not a baseline that recorded nothing.
 */
function parseAggregate(value: unknown): RecordedAggregate | null | false {
  if (value === undefined) return null;
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.runs !== 'number') return false;
  if (typeof record.mean !== 'number') return false;
  if (typeof record.stdev !== 'number') return false;
  return { runs: record.runs, mean: record.mean, stdev: record.stdev };
}

/**
 * The comparison itself, which is deliberately not statistical.
 *
 * The generated gate tolerates noise because it judges a run against a stored
 * distribution. Promotion is a different decision: it is asking whether the candidate is
 * *at least as good*, and a drop larger than the declared allowance is answered by the
 * allowance the author wrote, not by a significance test this layer would have to invent.
 * The means and spreads are printed so a reader can see how close the call was.
 */
/**
 * Metric kinds that record spend or time rather than quality.
 *
 * `allowedQualityDrop` is a budget over a quality metric, so a cost or latency row is
 * excluded from the comparison rather than measured against it: both report a pass rate
 * against a declared ceiling, so a change in that rate is a change in how often the budget
 * held, not a drop in quality the allowance is meant to bound.
 */
const NON_QUALITY_METRICS = new Set(['cost', 'latency']);

function rows(
  baseline: RecordedBaseline,
  candidate: RecordedBaseline,
  allowedDrop: number,
): readonly ComparisonRow[] {
  return baseline.metrics
    .filter((metric) => !NON_QUALITY_METRICS.has(metric.metric))
    .map((metric) => {
      const other = candidate.metrics.find((entry) => entry.metric === metric.metric);
      // A metric the candidate did not record scores zero here, which is the fail-closed
      // reading: a candidate that stopped measuring a metric has not demonstrated it kept it.
      const candidateMean = other?.mean ?? 0;
      const drop = metric.mean - candidateMean;
      return {
        metric: metric.metric,
        baselineMean: metric.mean,
        candidateMean,
        drop,
        allowedDrop,
        within: drop <= allowedDrop,
      };
    });
}

function percent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function usd(value: number): string {
  return `$${value.toFixed(4)}`;
}

/**
 * Applies `gate.promotion.allowedCostIncrease` to two recorded spend measurements.
 *
 * The allowance is a fraction of what the accepted run spent, so it needs both numbers.
 * When either file records no spend the allowance is refused instead of satisfied: the
 * candidate may well cost more, and a gate that cannot tell has not passed anything. That
 * is the one behavioural change from when every comparison deferred -- refusing is the
 * difference between a gate and a decoration, and the fix is a re-record, not a spec edit.
 */
function judgeCostAllowance(
  evalId: string,
  policy: NonNullable<Policy>,
  baseline: RecordedBaseline,
  candidate: RecordedBaseline,
): { readonly row: CostRow | null; readonly diagnostics: readonly CliDiagnostic[] } {
  const allowance = policy.allowedCostIncrease;
  if (allowance === undefined) return { row: null, diagnostics: [] };

  const path = ['evals', evalId, 'gate', 'promotion', 'allowedCostIncrease'];
  const unmeasured = [
    ...(baseline.cost === null ? ['accepted'] : []),
    ...(candidate.cost === null ? ['candidate'] : []),
  ];
  if (baseline.cost === null || candidate.cost === null) {
    const which =
      unmeasured.length === 2
        ? 'the accepted and candidate baselines record'
        : `the ${unmeasured[0]} baseline records`;
    const rerecord = unmeasured.length === 2 ? 'both baselines' : `the ${unmeasured[0]} baseline`;
    return {
      row: null,
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.compareCostUnjudged,
          message: `The promotion was refused: allowedCostIncrease (${percent(allowance)}) could not be judged because ${which} no spend.`,
          path,
          hint: `Re-record ${rerecord} with \`aid eval --baseline\` on a run whose spend is metered, and commit it. A baseline that records no spend is not evidence that spend did not rise.`,
        }),
      ],
    };
  }

  const accepted = baseline.cost.mean;
  const candidateMean = candidate.cost.mean;
  // A fraction of zero does not exist. Any spend at all then exceeds the allowance, which is
  // the honest reading rather than treating the increase as infinite and printing it.
  const increase = accepted === 0 ? null : (candidateMean - accepted) / accepted;
  const within = increase === null ? candidateMean === 0 : increase <= allowance;
  const row: CostRow = {
    baselineMeanUsd: accepted,
    candidateMeanUsd: candidateMean,
    increase,
    allowedIncrease: allowance,
    within,
  };
  if (within) return { row, diagnostics: [] };

  const movement =
    increase === null
      ? `the accepted run recorded no spend, so the candidate's ${usd(candidateMean)} per run is an unbounded increase`
      : `spend per run rose ${percent(increase)} (${usd(accepted)} accepted, ${usd(candidateMean)} candidate), and gate.promotion.allowedCostIncrease on "${evalId}" is ${percent(allowance)}`;
  return {
    row,
    diagnostics: [
      cliError({
        code: CLI_DIAGNOSTIC_CODES.compareCostRegressed,
        message: `The promotion was refused: ${movement}.`,
        path,
        hint: 'Improve the candidate’s cost, or raise allowedCostIncrease in the spec and say why in the commit that raises it.',
      }),
    ],
  };
}

function signed(value: number): string {
  const rendered = percent(Math.abs(value));
  return value > 0 ? `-${rendered}` : `+${rendered}`;
}

/**
 * A change in the measured quantity itself, rather than in a score.
 *
 * `signed` above renders *badness*: the `change` column of a quality row is a drop, so a
 * fall in the score prints negative and reads correctly. A cost row prints the change in
 * spend, where a rise in dollars must not appear as a minus.
 */
function signedChange(value: number): string {
  return `${value < 0 ? '-' : '+'}${percent(Math.abs(value))}`;
}

/**
 * Applies `evals.<id>.gate.promotion` to two baselines.
 *
 * Exit codes follow the rest of the CLI: `0` the candidate may be promoted, `1` the
 * promotion was refused (a regression, or an approval the policy requires and the tree does
 * not carry), `2` nothing was judged (no policy, an unreadable baseline, or two baselines
 * of different datasets).
 */
export function compareBaselines(
  context: CliContext,
  ir: IR,
  options: CompareOptions,
): CommandOutcome {
  const fields = {
    compare: options.comparePath,
    candidate: options.candidatePath,
    suite: options.suite ?? null,
  };
  const command = COMMAND;

  const chosen = policedEval(ir, options.suite);
  if (!chosen.ok) {
    return outcome({ command, exitCode: EXIT_USAGE, fields, diagnostics: chosen.diagnostics });
  }

  const baselineRead = readBaseline(context, options.comparePath, 'accepted');
  if (!baselineRead.ok) {
    return outcome({
      command,
      exitCode: EXIT_USAGE,
      fields,
      diagnostics: baselineRead.diagnostics,
    });
  }
  const candidateRead = readBaseline(context, options.candidatePath, 'candidate');
  if (!candidateRead.ok) {
    return outcome({
      command,
      exitCode: EXIT_USAGE,
      fields,
      diagnostics: candidateRead.diagnostics,
    });
  }

  const baseline = baselineRead.baseline;
  const candidate = candidateRead.baseline;
  const diagnostics: CliDiagnostic[] = [];

  // Two baselines of different datasets are two different measurements. Comparing them
  // would produce a number, and the number would be meaningless, which is exactly the
  // approximation this framework refuses.
  if (
    baseline.dataset !== candidate.dataset ||
    baseline.datasetVersion !== candidate.datasetVersion
  ) {
    return outcome({
      command,
      exitCode: EXIT_USAGE,
      fields: { ...fields, suite: chosen.evalId },
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.compareMismatch,
          message: `The two baselines are of different datasets: the accepted one is ${baseline.dataset}@${baseline.datasetVersion}, the candidate one is ${candidate.dataset}@${candidate.datasetVersion}.`,
          path: [options.candidatePath],
          hint: 'Compare baselines of the same dataset version. A dataset change is a new baseline, not a promotion.',
        }),
      ],
    });
  }

  const compared = rows(baseline, candidate, chosen.policy.allowedQualityDrop);
  const regressions = compared.filter((row) => !row.within);
  const judgedCost = judgeCostAllowance(chosen.evalId, chosen.policy, baseline, candidate);
  diagnostics.push(...judgedCost.diagnostics);

  const report: Record<string, unknown> = {
    eval: chosen.evalId,
    allowedQualityDrop: chosen.policy.allowedQualityDrop,
    baseline: options.comparePath,
    candidate: options.candidatePath,
    dataset: `${baseline.dataset}@${baseline.datasetVersion}`,
    metrics: compared,
    cost: judgedCost.row,
    verdict: regressions.length === 0 ? 'promotable' : 'refused',
  };

  for (const row of regressions) {
    diagnostics.push(
      cliError({
        code: CLI_DIAGNOSTIC_CODES.compareRegressed,
        message: `The promotion was refused: metric "${row.metric}" dropped ${percent(row.drop)} (${percent(row.baselineMean)} accepted, ${percent(row.candidateMean)} candidate), and gate.promotion.allowedQualityDrop on "${chosen.evalId}" is ${percent(row.allowedDrop)}.`,
        path: ['evals', chosen.evalId, 'gate', 'promotion', 'allowedQualityDrop'],
        hint: 'Improve the candidate, or raise allowedQualityDrop in the spec and say why in the commit that raises it.',
      }),
    );
  }

  // An approval the policy requires is a file in the tree. Checking that it exists is the
  // whole mechanism: there is no hosted reviewer to ask, and inventing one would be the
  // control plane this framework does not have.
  const approval = chosen.policy.approval;
  if (approval !== undefined) {
    const resolved = absolutePath(context.cwd, approval.record);
    if (!existsSync(resolved) || readFileSync(resolved, 'utf8').trim() === '') {
      diagnostics.push(
        cliError({
          code: CLI_DIAGNOSTIC_CODES.compareApprovalMissing,
          message: `The promotion was refused: "${chosen.evalId}" requires a recorded approval at ${approval.record}, and that file is missing or empty.`,
          path: ['evals', chosen.evalId, 'gate', 'promotion', 'approval', 'record'],
          hint: `Commit the approval record at ${approval.record}, signed off by one of: ${approval.by.join(', ')}.`,
        }),
      );
    }
    report.approval = { record: approval.record, by: approval.by };
  }

  const refused = diagnostics.some((diagnostic) => diagnostic.severity === 'error');
  report.verdict = refused ? 'refused' : 'promotable';

  const lines = [
    `promotion of eval "${chosen.evalId}" over dataset ${String(report.dataset)}`,
    '',
    ...compared.map(
      (row) =>
        `  ${row.within ? 'ok  ' : 'FAIL'} ${row.metric.padEnd(16)} accepted ${percent(row.baselineMean).padStart(7)}  candidate ${percent(row.candidateMean).padStart(7)}  change ${signed(row.drop).padStart(8)}  allowance ${percent(row.allowedDrop)}`,
    ),
    ...(judgedCost.row === null
      ? []
      : [
          `  ${judgedCost.row.within ? 'ok  ' : 'FAIL'} ${'cost'.padEnd(16)} accepted ${usd(judgedCost.row.baselineMeanUsd).padStart(7)}  candidate ${usd(judgedCost.row.candidateMeanUsd).padStart(7)}  change ${(judgedCost.row.increase === null ? 'unbounded' : signedChange(judgedCost.row.increase)).padStart(8)}  allowance ${percent(judgedCost.row.allowedIncrease)}`,
        ]),
    '',
    `  verdict: ${String(report.verdict)}`,
  ];

  return outcome({
    command,
    exitCode: refused ? EXIT_FAILURE : EXIT_OK,
    fields: {
      ...fields,
      suite: chosen.evalId,
      verdict: report.verdict,
      metrics: compared,
      cost: judgedCost.row,
    },
    diagnostics,
    text: lines.join('\n'),
  });
}
