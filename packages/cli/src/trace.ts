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
  readonly status?: { readonly code?: string; readonly message?: string | null } | null;
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

/** A span's start as epoch milliseconds, or `undefined` when the timestamp is unreadable. */
function instantOf(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Start order, with the span id as a tiebreak so equal timestamps still print one way. */
function byStart(left: TraceSpan, right: TraceSpan): number {
  const leftAt = instantOf(left.started_at);
  const rightAt = instantOf(right.started_at);
  if (leftAt !== undefined && rightAt !== undefined && leftAt !== rightAt) return leftAt - rightAt;
  if (leftAt === undefined && rightAt !== undefined) return 1;
  if (leftAt !== undefined && rightAt === undefined) return -1;
  return left.span_id < right.span_id ? -1 : left.span_id > right.span_id ? 1 : 0;
}

/** Wall time the run covered: earliest start to latest end, not the sum of the spans. */
function runDurationOf(spans: readonly TraceSpan[]): number {
  let earliest = Number.POSITIVE_INFINITY;
  let latest = Number.NEGATIVE_INFINITY;
  let longest = 0;

  for (const span of spans) {
    const duration =
      typeof span.duration_ms === 'number' &&
      Number.isFinite(span.duration_ms) &&
      span.duration_ms > 0
        ? span.duration_ms
        : 0;
    if (duration > longest) longest = duration;
    const begun = instantOf(span.started_at);
    if (begun === undefined) continue;
    earliest = Math.min(earliest, begun);
    latest = Math.max(latest, begun + duration);
  }

  const measured = earliest === Number.POSITIVE_INFINITY ? longest : latest - earliest;
  return Math.round(measured * 1000) / 1000;
}

/** One trace: the spans that share a `trace_id`, and what a reader asks about it. */
export interface TraceRun {
  readonly traceId: string;
  readonly spans: readonly TraceSpan[];
  /**
   * The span the others hang from, when the trace has exactly one. A trace assembled
   * from several exports can have none, or several; a reader that guessed would draw a
   * hierarchy the data does not claim.
   */
  readonly root?: TraceSpan;
  /** The earliest `started_at` in the run, in the sink's own format. */
  readonly startedAt: string;
  /** Wall time from the earliest start to the latest end. */
  readonly durationMs: number;
  readonly errors: number;
  readonly costUsd: number;
  readonly unpricedSpans: number;
}

/**
 * Group spans into runs, newest first.
 *
 * A run is **one `trace_id`**, because that is the only identifier the sink writes that
 * covers a whole request: `span_id` is one step, and there is no separate run record. The
 * cost, error and unpriced counts come from {@link summariseSpans} rather than a second
 * summation here, so one span set can never price two ways.
 *
 * A span whose parent is absent is treated as top-level. That happens legitimately -- a
 * trace can be exported in pieces, or a parent can fail before it records -- and the
 * alternative, dropping it, would hide a span that did run.
 */
export function runsOf(spans: readonly TraceSpan[]): readonly TraceRun[] {
  const grouped = new Map<string, TraceSpan[]>();
  for (const span of spans) {
    const members = grouped.get(span.trace_id);
    if (members === undefined) grouped.set(span.trace_id, [span]);
    else members.push(span);
  }

  const runs: TraceRun[] = [];
  for (const [traceId, members] of grouped) {
    const ordered = [...members].sort(byStart);
    const ids = new Set(members.map((span) => span.span_id));
    const tops = ordered.filter(
      (span) => span.parent_span_id == null || !ids.has(span.parent_span_id),
    );
    const summary = summariseSpans(members);
    const first = ordered[0];

    runs.push({
      traceId,
      spans: ordered,
      ...(tops.length === 1 && tops[0] !== undefined ? { root: tops[0] } : {}),
      startedAt: first?.started_at ?? '',
      durationMs: runDurationOf(members),
      errors: summary.errors,
      costUsd: summary.costUsd,
      unpricedSpans: summary.unpricedSpans,
    });
  }

  // Newest first, then by id, so two runs over one directory list in one order whatever
  // order their files happened to be read in.
  return runs.sort((left, right) => {
    const leftAt = instantOf(left.startedAt) ?? Number.NEGATIVE_INFINITY;
    const rightAt = instantOf(right.startedAt) ?? Number.NEGATIVE_INFINITY;
    if (leftAt !== rightAt) return rightAt - leftAt;
    return left.traceId < right.traceId ? -1 : left.traceId > right.traceId ? 1 : 0;
  });
}

/** Children of each span in one run, keyed by parent id, in start order. */
export function childrenOf(spans: readonly TraceSpan[]): ReadonlyMap<string, readonly TraceSpan[]> {
  const ids = new Set(spans.map((span) => span.span_id));
  const children = new Map<string, TraceSpan[]>();

  for (const span of [...spans].sort(byStart)) {
    const parent = span.parent_span_id;
    if (parent == null || !ids.has(parent)) continue;
    const existing = children.get(parent);
    if (existing === undefined) children.set(parent, [span]);
    else existing.push(span);
  }

  return children;
}

/**
 * One span as a tree row: where it sits, when it began relative to the run, and what the
 * record says about it.
 */
export interface SpanRow {
  readonly span: TraceSpan;
  /** Nesting level; a span whose parent is missing sits at the top, not in limbo. */
  readonly depth: number;
  /** Milliseconds after the run's earliest start; absent when the timestamp is unusable. */
  readonly offsetMs?: number;
  readonly facts: SpanFacts;
}

/**
 * Flatten a run into print order: depth first, every child after its parent.
 *
 * Roots are spans with no parent *in this run*. Anything unreachable from a root -- only
 * possible when parent links form a cycle, which a writer bug could produce -- is appended
 * at depth zero rather than dropped, because a span that recorded is a span that ran.
 */
export function treeRowsOf(run: TraceRun): readonly SpanRow[] {
  const children = childrenOf(run.spans);
  const ids = new Set(run.spans.map((span) => span.span_id));
  const roots = run.spans.filter(
    (span) => span.parent_span_id == null || !ids.has(span.parent_span_id),
  );

  const earliest = Math.min(
    ...run.spans.map((span) => instantOf(span.started_at) ?? Number.POSITIVE_INFINITY),
  );
  const base = Number.isFinite(earliest) ? earliest : undefined;

  const rows: SpanRow[] = [];
  const seen = new Set<string>();

  const walk = (span: TraceSpan, depth: number): void => {
    if (seen.has(span.span_id)) return;
    seen.add(span.span_id);
    const begun = instantOf(span.started_at);
    rows.push({
      span,
      depth,
      ...(base === undefined || begun === undefined ? {} : { offsetMs: begun - base }),
      facts: factsOf(span),
    });
    for (const child of children.get(span.span_id) ?? []) walk(child, depth + 1);
  };

  for (const root of roots) walk(root, 0);
  for (const span of run.spans) walk(span, 0);

  return rows;
}

/**
 * What one span line can say without guessing.
 *
 * The attribute keys stay in this module so a reader never has to know them: `trace`
 * prints usage and cost from the same fields `cost` sums, which is what makes the two
 * commands agree about a run.
 */
export interface SpanFacts {
  readonly durationMs?: number;
  readonly costUsd?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  /** The pinned alias, else the model the provider served. Absent when neither is recorded. */
  readonly model?: string;
  readonly error: boolean;
}

export function factsOf(span: TraceSpan): SpanFacts {
  const attributes = span.attributes ?? {};
  const duration = span.duration_ms;
  const input = numeric(attributes[ATTRIBUTES.inputTokens]);
  const output = numeric(attributes[ATTRIBUTES.outputTokens]);
  const cost = numeric(attributes[ATTRIBUTES.costUsd]);
  const model = modelOf(span);

  return {
    ...(typeof duration === 'number' && Number.isFinite(duration) && duration >= 0
      ? { durationMs: duration }
      : {}),
    ...(cost === undefined ? {} : { costUsd: cost }),
    ...(input === undefined ? {} : { inputTokens: input }),
    ...(output === undefined ? {} : { outputTokens: output }),
    ...(model === UNKNOWN_MODEL ? {} : { model }),
    error: span.status?.code === 'ERROR',
  };
}
