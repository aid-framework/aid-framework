/**
 * Running the retrieval gate through the shipped statistical gate.
 *
 * No gate logic lives here. {@link RetrievalGate} samples a retriever over retrieval
 * cases, turns each per-run mean into a real {@link MetricRun}, and hands a real
 * {@link EvalRun} to the real {@link BaselineGate}. That matters for the falsification
 * test, which must show the *shipped* gate rejecting a worse retriever; a comparator
 * written for the occasion would prove only that the comparator works.
 *
 * Two deliberate details:
 *
 * **The metrics hand-off needs a cast.** `BaselineGate` annotates `metrics` as
 * `Metric[]`, and the shipped `Metric` requires `score(entry: EvalCase, prediction:
 * string)`, which a retrieval metric cannot implement. What the gate actually consumes
 * from that argument is only `name` and `deterministic` -- that is the entirety of
 * `checkMetricEligibility` -- so a cast is sound here, and is confined to one line
 * with this comment rather than spread through the runtime. The eligibility check it
 * feeds is real: a retrieval metric reporting `deterministic = false` is refused,
 * which a test asserts.
 *
 * **`allowNondeterministic` is not exposed.** The shipped gate has the flag for local
 * exploration, and wiring it through would make it reachable from a gate. There is no
 * retrieval metric in Phase 1 that is non-deterministic; if one ever appears, the
 * metric is what needs fixing.
 *
 * `runs` is a required argument rather than a default, because it is not a tuning
 * knob: at `runs = 1` the run-to-run standard deviation is zero and the statistical
 * half of the gate cannot fire at all, so a gate built on one run silently degrades to
 * a mean comparison.
 */

// biome-ignore lint/suspicious/noShadowRestrictedNames: the framework's own error name, matching the Python runtime's public surface
import { EvalError } from '../errors.js';
import {
  BaselineGate,
  type EvalBaseline,
  EvalRun,
  type GateResult,
  MetricRun,
  type Threshold,
} from '../evals/gate.js';
import type { Metric } from '../evals/metrics.js';
import type { RetrievalCase, RetrievalMetric } from './metrics.js';
import type { Retriever } from './retriever.js';

/** Samples a retriever and decides whether its retrieval regressed. */
export class RetrievalGate {
  private readonly _metrics: readonly RetrievalMetric[];
  private readonly _gate: BaselineGate;

  constructor(
    thresholds: readonly Threshold[],
    options: { readonly metrics?: readonly RetrievalMetric[] } = {},
  ) {
    this._metrics = [...(options.metrics ?? [])];
    // See the module docstring: the gate reads only `name` and `deterministic` from
    // these, which is the part of the protocol a retrieval metric shares.
    this._gate = new BaselineGate(thresholds, {
      metrics: this._metrics as unknown as readonly Metric[],
    });
  }

  get thresholds(): readonly Threshold[] {
    return this._gate.thresholds;
  }

  get metrics(): readonly RetrievalMetric[] {
    return this._metrics;
  }

  /** Run every case `runs` times, producing one mean per metric per run. */
  async sample(
    cases: readonly RetrievalCase[],
    retriever: Retriever,
    init: { readonly runs: number; readonly dataset: string; readonly datasetVersion: string },
  ): Promise<EvalRun> {
    if (cases.length === 0) {
      throw new EvalError('a retrieval run needs at least one case');
    }
    if (init.runs < 1) {
      throw new EvalError(`a retrieval run needs at least one run, got ${init.runs}`);
    }
    if (this._metrics.length === 0) {
      throw new EvalError('a retrieval run needs at least one metric');
    }

    const samples = new Map<string, number[]>(
      this._metrics.map((metric) => [metric.name, [] as number[]]),
    );
    for (let run = 0; run < init.runs; run += 1) {
      const totals = new Map<string, number>(this._metrics.map((metric) => [metric.name, 0.0]));
      for (const entry of cases) {
        // k comes from the case, because a case is what says how many passages count
        // as an answer; a retriever's own topK is a default.
        const retrieved = await retriever.retrieve(entry.query, { topK: entry.k });
        for (const metric of this._metrics) {
          const result = await metric.score(entry, retrieved);
          totals.set(metric.name, (totals.get(metric.name) ?? 0.0) + result.score);
        }
      }
      for (const [name, total] of totals) {
        samples.get(name)?.push(total / cases.length);
      }
    }

    return new EvalRun({
      dataset: init.dataset,
      datasetVersion: init.datasetVersion,
      runs: init.runs,
      metrics: [...samples.entries()].map(
        ([name, values]) => new MetricRun({ metric: name, values }),
      ),
    });
  }

  /** Delegate to the shipped gate; there is no verdict logic in this module. */
  evaluate(run: EvalRun, baseline: EvalBaseline): GateResult {
    return this._gate.evaluate(run, baseline);
  }
}
