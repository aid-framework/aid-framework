/**
 * Reading the local trace sink back into numbers.
 *
 * The format is the one `runtimes/{python,typescript}/src/.../local_trace` writes: one
 * JSON object per line, one line per span. This module is the third consumer of that
 * contract and the only one written in TypeScript that does not live in the runtime, so
 * it repeats the field names in one place rather than importing a runtime that drags a
 * provider SDK into the CLI.
 *
 * Two rules keep the report honest:
 *
 * - A span that cannot be parsed is **counted and skipped**, never guessed at. A crash
 *   truncated the last line of a file is normal; a line that is not a span at all is not,
 *   and the caller reports the count either way.
 * - A span with tokens but no `aid.cost.usd` is **unpriced**, not free. Summing it as
 *   zero would make a missing cost look like a cheap run, which is the same failure the
 *   IR's cost gate refuses.
 */

/** One span, as the sink wrote it. Only the fields this report reads are typed. */
export interface TraceSpan {
  readonly trace_id: string;
  readonly span_id: string;
  readonly parent_span_id?: string | null;
  readonly name: string;
  readonly kind?: string;
  readonly started_at: string;
  readonly duration_ms?: number;
  readonly attributes?: Readonly<Record<string, unknown>>;
  readonly status?: { readonly code?: string } | null;
}

export interface ParsedTrace {
  readonly spans: readonly TraceSpan[];
  /** Lines that were not a span. Counted, never silently dropped. */
  readonly skipped: number;
}

/** The attribute keys the report reads, from the runtime's own conventions table. */
const ATTRIBUTES = {
  alias: 'aid.model.alias',
  costUsd: 'aid.cost.usd',
  inputTokens: 'gen_ai.usage.input_tokens',
  outputTokens: 'gen_ai.usage.output_tokens',
  responseModel: 'gen_ai.response.model',
  requestModel: 'gen_ai.request.model',
} as const;

const UNKNOWN_MODEL = '(unknown)';

/** The model a span is attributed to: the pinned alias, else the model the provider served. */
function modelOf(span: TraceSpan): string {
  const attributes = span.attributes ?? {};
  for (const key of [ATTRIBUTES.alias, ATTRIBUTES.responseModel, ATTRIBUTES.requestModel]) {
    const value = attributes[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return UNKNOWN_MODEL;
}

/** A non-negative finite number, accepting the string form an attribute may carry. */
function numeric(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : undefined;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  }
  return undefined;
}

function isSpan(value: unknown): value is TraceSpan {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.trace_id === 'string' &&
    typeof candidate.span_id === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.started_at === 'string'
  );
}

/**
 * Parse one JSONL file. A blank line is not a failure -- the sink never writes one, but
 * a file being appended to while it is read can end in a partial line, and that is the
 * one case a reader has to tolerate.
 */
export function parseTraceLines(text: string): ParsedTrace {
  const spans: TraceSpan[] = [];
  let skipped = 0;

  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isSpan(parsed)) spans.push(parsed);
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }

  return { spans, skipped };
}

/**
 * Normalise `--since` to the ISO instant the sink writes, or `undefined` when the value
 * is not a date. A plain `YYYY-MM-DD` is UTC midnight; anything else must be ISO 8601
 * with an explicit offset, because a bare local time would mean a different instant on
 * every machine reading the same repository.
 */
export function parseSince(value: string): string | undefined {
  const trimmed = value.trim();
  const day = /^(\d{4})-(\d{2})-(\d{2})$/;
  if (day.test(trimmed)) {
    const date = new Date(`${trimmed}T00:00:00.000Z`);
    // A round trip rejects 2026-02-31, which `Date` would otherwise roll into March.
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== trimmed) {
      return undefined;
    }
    return date.toISOString();
  }

  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(trimmed)) {
    return undefined;
  }
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** One model's share of the report. */
export interface ModelSpend {
  readonly model: string;
  /** Spans attributed to this model that carried usage or cost. */
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  /** Calls with usage but no recorded cost. */
  readonly unpricedCalls: number;
}

export interface Latency {
  /** Nearest-rank percentiles over model-call spans, in milliseconds. */
  readonly p50: number;
  readonly p95: number;
  readonly samples: number;
}

export interface CostSummary {
  readonly spans: number;
  readonly traces: number;
  readonly errors: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  /** Spans that carried usage but no recorded cost; they are absent from `costUsd`. */
  readonly unpricedSpans: number;
  readonly latency?: Latency;
  readonly models: readonly ModelSpend[];
}

/** Nearest-rank percentile: the smallest value at or above the given fraction. */
function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(fraction * sorted.length);
  const index = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
  return sorted[index] ?? 0;
}

/**
 * Aggregate spans into one report.
 *
 * `since` filters on `started_at` by string comparison, which is exact because both
 * sides are the UTC ISO form the sink writes.
 */
export function summariseSpans(
  spans: readonly TraceSpan[],
  options: { readonly since?: string } = {},
): CostSummary {
  const counted =
    options.since === undefined
      ? spans
      : spans.filter((span) => span.started_at >= (options.since as string));

  const traceIds = new Set<string>();
  const byModel = new Map<string, ModelSpend>();
  const durations: number[] = [];
  let errors = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let unpricedSpans = 0;

  for (const span of counted) {
    traceIds.add(span.trace_id);
    if (span.status?.code === 'ERROR') errors += 1;

    const attributes = span.attributes ?? {};
    const cost = numeric(attributes[ATTRIBUTES.costUsd]);
    const input = numeric(attributes[ATTRIBUTES.inputTokens]);
    const output = numeric(attributes[ATTRIBUTES.outputTokens]);
    const hasUsage = input !== undefined || output !== undefined;

    if (cost !== undefined) costUsd += cost;
    if (input !== undefined) inputTokens += input;
    if (output !== undefined) outputTokens += output;
    if (hasUsage && cost === undefined) unpricedSpans += 1;

    if (hasUsage) {
      const duration = span.duration_ms;
      if (typeof duration === 'number' && Number.isFinite(duration) && duration >= 0) {
        durations.push(duration);
      }
    }

    if (!hasUsage && cost === undefined) continue;

    const model = modelOf(span);
    const existing = byModel.get(model);
    const addition = {
      input: input ?? 0,
      output: output ?? 0,
      cost: cost ?? 0,
      unpriced: hasUsage && cost === undefined ? 1 : 0,
    };

    if (existing === undefined) {
      byModel.set(model, {
        model,
        calls: 1,
        inputTokens: addition.input,
        outputTokens: addition.output,
        costUsd: addition.cost,
        unpricedCalls: addition.unpriced,
      });
    } else {
      byModel.set(model, {
        model,
        calls: existing.calls + 1,
        inputTokens: existing.inputTokens + addition.input,
        outputTokens: existing.outputTokens + addition.output,
        costUsd: existing.costUsd + addition.cost,
        unpricedCalls: existing.unpricedCalls + addition.unpriced,
      });
    }
  }

  // Priciest first, then busiest, then by name, so two runs over the same spans print
  // the same order without depending on the order the files happened to be read in.
  const models = [...byModel.values()].sort(
    (left, right) =>
      right.costUsd - left.costUsd ||
      right.calls - left.calls ||
      (left.model < right.model ? -1 : left.model > right.model ? 1 : 0),
  );

  durations.sort((left, right) => left - right);
  const summary: CostSummary = {
    spans: counted.length,
    traces: traceIds.size,
    errors,
    inputTokens,
    outputTokens,
    costUsd,
    unpricedSpans,
    models,
    ...(durations.length === 0
      ? {}
      : {
          latency: {
            p50: Math.round(percentile(durations, 0.5)),
            p95: Math.round(percentile(durations, 0.95)),
            samples: durations.length,
          },
        }),
  };
  return summary;
}
