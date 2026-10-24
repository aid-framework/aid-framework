/**
 * Running a dataset through a gateway, once or N times.
 *
 * The split with {@link import('./gate.js')} is deliberate: this module *produces*
 * numbers, the gate *judges* them. Keeping them apart is what lets the sampling loop
 * stay boring and the decision logic stay testable without a provider.
 */

// biome-ignore lint/suspicious/noShadowRestrictedNames: the framework's own error name, matching the Python runtime's public surface
import { EvalError } from '../errors.js';
import type { ModelGateway } from '../gateway.js';
import { repr } from '../internal/json.js';
import { CompletionRequest, Message } from '../types.js';
import type { Dataset, EvalCase } from './dataset.js';
import { EvalRun, MetricRun } from './gate.js';
import type { Metric, MetricResult } from './metrics.js';

/** Anything that turns a case into a prediction. */
export type Runner = (entry: EvalCase) => Promise<string>;

/** One case's prediction and its per-metric scores, for inspection. */
export class CaseOutcome {
  readonly caseId: string;
  readonly prediction: string;
  readonly scores: readonly MetricResult[];

  constructor(init: {
    readonly caseId: string;
    readonly prediction: string;
    readonly scores?: readonly MetricResult[];
  }) {
    this.caseId = init.caseId;
    this.prediction = init.prediction;
    this.scores = init.scores ?? [];
  }

  get passed(): boolean {
    return this.scores.every((score) => score.passed);
  }
}

function mean(values: readonly number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

/** A single pass over a dataset, keeping per-case detail. */
export class DatasetRun {
  readonly dataset: string;
  readonly datasetVersion: string;
  readonly outcomes: readonly CaseOutcome[];

  constructor(init: {
    readonly dataset: string;
    readonly datasetVersion: string;
    readonly outcomes: readonly CaseOutcome[];
  }) {
    if (init.outcomes.length === 0)
      throw new RangeError('a dataset run needs at least one outcome');
    this.dataset = init.dataset;
    this.datasetVersion = init.datasetVersion;
    this.outcomes = init.outcomes;
  }

  /** Mean score per metric across the cases of this pass. */
  means(): Record<string, number> {
    const collected = new Map<string, number[]>();
    for (const outcome of this.outcomes) {
      for (const score of outcome.scores) {
        const bucket = collected.get(score.metric);
        if (bucket === undefined) collected.set(score.metric, [score.score]);
        else bucket.push(score.score);
      }
    }
    const out: Record<string, number> = {};
    for (const [name, values] of collected) out[name] = mean(values);
    return out;
  }

  failures(): CaseOutcome[] {
    return this.outcomes.filter((outcome) => !outcome.passed);
  }

  outcome(caseId: string): CaseOutcome {
    for (const outcome of this.outcomes) {
      if (outcome.caseId === caseId) return outcome;
    }
    throw new EvalError(`no outcome recorded for case ${repr(caseId)}`);
  }

  summary(): string {
    const failed = this.failures();
    const lines = [
      `${this.dataset}@${this.datasetVersion}: ${this.outcomes.length - failed.length}/${this.outcomes.length} cases passed`,
    ];
    for (const [name, value] of Object.entries(this.means()).sort(([a], [b]) => (a < b ? -1 : 1))) {
      lines.push(`  ${name}: ${value.toFixed(4)}`);
    }
    for (const outcome of failed) {
      const detail = outcome.scores
        .filter((score) => !score.passed)
        .map((score) => `${score.metric}: ${score.detail}`)
        .join('; ');
      lines.push(`  FAIL ${outcome.caseId}: ${detail}`);
    }
    return lines.join('\n');
  }
}

export interface GatewayRunnerOptions {
  readonly system?: string;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  /** Supply a prompt-registry-backed request instead of the default shape. */
  readonly requestFor?: (entry: EvalCase) => CompletionRequest;
  readonly fallbacks?: readonly string[];
}

/**
 * Adapts a {@link ModelGateway} into a {@link Runner}.
 *
 * `requestFor` exists so a caller can supply a prompt-registry-backed request (with its
 * own system message and version) instead of the default one-message-for-`case.input`
 * shape. Keeping it an option rather than a subclass is enough: the only thing that
 * varies is how a case becomes a request.
 */
export class GatewayRunner {
  private readonly _gateway: ModelGateway;
  private readonly _alias: string;
  private readonly _fallbacks: readonly string[];
  private readonly _temperature: number | undefined;
  private readonly _maxOutputTokens: number | undefined;
  private readonly _system: string | undefined;
  private readonly _requestFor: (entry: EvalCase) => CompletionRequest;

  constructor(gateway: ModelGateway, alias: string, options: GatewayRunnerOptions = {}) {
    gateway.resolve(alias);
    this._gateway = gateway;
    this._alias = alias;
    this._fallbacks = options.fallbacks ?? [];
    this._temperature = options.temperature;
    this._maxOutputTokens = options.maxOutputTokens;
    this._system = options.requestFor === undefined ? options.system : undefined;
    this._requestFor = options.requestFor ?? ((entry) => this.defaultRequest(entry));
  }

  get alias(): string {
    return this._alias;
  }

  get costUsd(): number {
    return this._gateway.ledger.costUsd;
  }

  async run(entry: EvalCase): Promise<string> {
    const request = this._requestFor(entry);
    const result = await this._gateway.generate(this._alias, request, {
      fallbacks: this._fallbacks,
    });
    return result.text;
  }

  private defaultRequest(entry: EvalCase): CompletionRequest {
    const messages: Message[] = [];
    if (this._system !== undefined) messages.push(Message.system(this._system));
    messages.push(Message.user(entry.input));
    return new CompletionRequest({
      messages,
      temperature: this._temperature,
      maxOutputTokens: this._maxOutputTokens,
    });
  }
}

/**
 * A judge call backed by the gateway, for {@link import('./metrics.js').LlmJudge}.
 *
 * Note what this does *not* do: it does not make the judge deterministic. It is still
 * unfit for a CI threshold.
 */
export function gatewayJudge(
  gateway: ModelGateway,
  alias: string,
  options: { readonly system?: string } = {},
): (prompt: string) => Promise<string> {
  return async (prompt: string): Promise<string> => {
    const result = await gateway.generate(alias, CompletionRequest.prompt(prompt, options.system));
    return result.text;
  };
}

/** One pass over `dataset`, scoring every prediction with every metric. */
export async function evaluateOnce(
  dataset: Dataset,
  runner: Runner,
  metrics: readonly Metric[],
): Promise<DatasetRun> {
  if (metrics.length === 0) throw new RangeError('at least one metric is required');
  const outcomes: CaseOutcome[] = [];
  for (const entry of dataset.cases) {
    const prediction = await runner(entry);
    const scores: MetricResult[] = [];
    for (const metric of metrics) scores.push(await metric.score(entry, prediction));
    outcomes.push(new CaseOutcome({ caseId: entry.id, prediction, scores }));
  }
  return new DatasetRun({
    dataset: dataset.name,
    datasetVersion: dataset.version,
    outcomes,
  });
}

/**
 * Sample `dataset` `runs` times, recording one mean per metric per run.
 *
 * Every run makes fresh calls, which is the point: the spread across runs is the
 * measurement of how much this system varies when nothing has changed. Without it there
 * is nothing to compare a "regression" against.
 */
export async function runEvaluation(
  dataset: Dataset,
  runner: Runner,
  metrics: readonly Metric[],
  options: { readonly runs?: number } = {},
): Promise<EvalRun> {
  const runs = options.runs ?? 5;
  if (runs < 1) throw new RangeError('runs must be at least 1');
  if (metrics.length === 0) throw new RangeError('at least one metric is required');

  const collected = new Map<string, number[]>(metrics.map((metric) => [metric.name, []]));
  for (let pass = 0; pass < runs; pass += 1) {
    const result = await evaluateOnce(dataset, runner, metrics);
    const means = result.means();
    for (const metric of metrics) {
      const bucket = collected.get(metric.name);
      if (bucket === undefined) continue;
      bucket.push(means[metric.name] ?? 0);
    }
  }

  return new EvalRun({
    dataset: dataset.name,
    datasetVersion: dataset.version,
    runs,
    metrics: metrics.map(
      (metric) => new MetricRun({ metric: metric.name, values: collected.get(metric.name) ?? [] }),
    ),
  });
}
