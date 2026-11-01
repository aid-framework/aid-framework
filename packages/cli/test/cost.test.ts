/**
 * `aid cost` reads the runtime's trace sink back into numbers.
 *
 * The tests fall into two groups for a reason. The pure ones pin the rules a report must
 * obey -- what `--since` accepts, what an unpriced span counts as, which order models
 * print in -- because those are the judgements a reader would otherwise have to trust.
 * The command tests then pin the exit taxonomy: a wrong invocation is `2`, an unreadable
 * trace file is `1`, and everything else is `0` even when the report is empty, because an
 * empty report is a true statement about a directory that has no traces yet.
 */

import { chmodSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import type { TraceSpan } from '../src/index.js';
import { parseSince, parseTraceLines, summariseSpans } from '../src/index.js';
import { aid, diagnosticsOf, emptyProject, type Project, type Run } from './helpers.js';

const created: Project[] = [];

function scratch(): Project {
  const made = emptyProject();
  created.push(made);
  return made;
}

afterAll(() => {
  for (const made of created) made.close();
});

const STARTED = '2026-10-01T10:00:00.000Z';
const LATER = '2026-10-02T00:00:00.000Z';

/** One span exactly as the runtime writes it; fields a test does not care about filled in. */
function span(overrides: Record<string, unknown> = {}): TraceSpan {
  return {
    trace_id: 'trace-1',
    span_id: 'span-1',
    parent_span_id: null,
    name: 'chat gpt-4o-mini',
    kind: 'internal',
    started_at: STARTED,
    ended_at: STARTED,
    duration_ms: 100,
    attributes: {},
    events: [],
    status: { code: 'OK' },
    ...overrides,
  } as unknown as TraceSpan;
}

/** A priced model call. */
function call(
  model: string,
  options: {
    readonly input?: number;
    readonly output?: number;
    readonly cost?: number | undefined;
    readonly duration?: number;
    readonly at?: string;
    readonly trace?: string;
    readonly status?: string;
  } = {},
): TraceSpan {
  const attributes: Record<string, unknown> = {
    'aid.model.alias': model,
    'gen_ai.usage.input_tokens': options.input ?? 100,
    'gen_ai.usage.output_tokens': options.output ?? 50,
  };
  if (options.cost !== undefined) attributes['aid.cost.usd'] = options.cost;
  return span({
    trace_id: options.trace ?? 'trace-1',
    started_at: options.at ?? STARTED,
    duration_ms: options.duration ?? 100,
    attributes,
    status: { code: options.status ?? 'OK' },
  });
}

function jsonl(spans: readonly TraceSpan[]): string {
  return `${spans.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
}

function jsonRun(
  made: Project,
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = {},
): Run {
  return aid(made, [...argv, '--json'], { env });
}

/** Codes from a JSON invocation, so a text-mode assertion and a code assertion can coexist. */
function codes(
  made: Project,
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = {},
): readonly string[] {
  return diagnosticsOf(jsonRun(made, argv, env)).map((diagnostic) => diagnostic.code);
}

function severityOf(
  made: Project,
  argv: readonly string[],
  code: string,
  env: Readonly<Record<string, string | undefined>> = {},
): string | undefined {
  return diagnosticsOf(jsonRun(made, argv, env)).find((diagnostic) => diagnostic.code === code)
    ?.severity;
}

describe('parseSince', () => {
  it('reads a plain day as UTC midnight', () => {
    expect(parseSince('2026-10-01')).toBe('2026-10-01T00:00:00.000Z');
  });

  it('rejects a day that does not exist rather than rolling it forward', () => {
    expect(parseSince('2026-02-31')).toBeUndefined();
    expect(parseSince('2026-13-01')).toBeUndefined();
  });

  it('reads an instant with an offset and normalises it to UTC', () => {
    expect(parseSince('2026-10-01T12:00:00Z')).toBe('2026-10-01T12:00:00.000Z');
    expect(parseSince('2026-10-01T12:00:00+05:30')).toBe('2026-10-01T06:30:00.000Z');
    expect(parseSince('2026-10-01T12:00Z')).toBe('2026-10-01T12:00:00.000Z');
  });

  it('rejects an instant with no offset, which would mean a different moment per machine', () => {
    expect(parseSince('2026-10-01T12:00:00')).toBeUndefined();
  });

  it('rejects words and empty input', () => {
    expect(parseSince('yesterday')).toBeUndefined();
    expect(parseSince('')).toBeUndefined();
  });
});

describe('parseTraceLines', () => {
  it('reads one span per line and tolerates blank lines', () => {
    const parsed = parseTraceLines(`${JSON.stringify(span())}\n\n${JSON.stringify(span())}\n`);
    expect(parsed.spans).toHaveLength(2);
    expect(parsed.skipped).toBe(0);
  });

  it('counts a partial trailing line instead of failing the file', () => {
    const parsed = parseTraceLines(`${JSON.stringify(span())}\n{"trace_id":"tra`);
    expect(parsed.spans).toHaveLength(1);
    expect(parsed.skipped).toBe(1);
  });

  it('counts JSON that is not a span', () => {
    const parsed = parseTraceLines(`${JSON.stringify({ hello: 'world' })}\n`);
    expect(parsed.spans).toHaveLength(0);
    expect(parsed.skipped).toBe(1);
  });
});

describe('summariseSpans', () => {
  it('sums cost and tokens and counts distinct traces', () => {
    const summary = summariseSpans([
      call('gpt-4o-mini', { input: 100, output: 50, cost: 0.0001 }),
      call('gpt-4o-mini', { input: 200, output: 60, cost: 0.0002, trace: 'trace-2' }),
    ]);

    expect(summary.spans).toBe(2);
    expect(summary.traces).toBe(2);
    expect(summary.inputTokens).toBe(300);
    expect(summary.outputTokens).toBe(110);
    expect(summary.costUsd).toBeCloseTo(0.0003, 10);
    expect(summary.unpricedSpans).toBe(0);
  });

  it('counts a span with usage but no recorded cost as unpriced, not as free', () => {
    const summary = summariseSpans([
      call('gpt-4o-mini', { cost: 0.0001 }),
      call('gpt-4o-mini', { input: 10, output: 5 }),
    ]);

    expect(summary.costUsd).toBeCloseTo(0.0001, 10);
    expect(summary.unpricedSpans).toBe(1);
    expect(summary.models[0]?.unpricedCalls).toBe(1);
    expect(summary.models[0]?.calls).toBe(2);
  });

  it('ignores spans with neither usage nor cost, such as retrieval steps', () => {
    const summary = summariseSpans([
      span({ name: 'retrieve', attributes: {} }),
      call('gpt-4o-mini', { cost: 0.0001 }),
    ]);

    expect(summary.spans).toBe(2);
    expect(summary.models).toHaveLength(1);
  });

  it('reports nearest-rank latency over model calls only', () => {
    const summary = summariseSpans([
      call('a', { duration: 400, cost: 0.01 }),
      call('a', { duration: 100, cost: 0.01 }),
      call('a', { duration: 300, cost: 0.01 }),
      call('a', { duration: 200, cost: 0.01 }),
      span({ name: 'retrieve', duration_ms: 9_999, attributes: {} }),
    ]);

    expect(summary.latency).toEqual({ p50: 200, p95: 400, samples: 4 });
  });

  it('omits latency when no span carried usage', () => {
    const summary = summariseSpans([span()]);
    expect(summary.latency).toBeUndefined();
  });

  it('orders models by cost, then calls, then name', () => {
    const summary = summariseSpans([
      call('cheap', { cost: 0.01 }),
      call('pricey', { cost: 0.5 }),
      call('quiet', { cost: 0.01 }),
      call('busy', { cost: 0.01 }),
      call('busy', { cost: 0.01 }),
    ]);

    expect(summary.models.map((model) => model.model)).toEqual([
      'pricey',
      'busy',
      'cheap',
      'quiet',
    ]);
  });

  it('filters on started_at at or after the since instant', () => {
    const summary = summariseSpans(
      [call('old', { at: STARTED, cost: 0.5 }), call('new', { at: LATER, cost: 0.25 })],
      { since: parseSince('2026-10-02') },
    );

    expect(summary.spans).toBe(1);
    expect(summary.costUsd).toBeCloseTo(0.25, 10);
  });

  it('counts error spans by status code', () => {
    const summary = summariseSpans([
      call('a', { status: 'ERROR', cost: 0.01 }),
      call('a', { status: 'OK', cost: 0.01 }),
    ]);
    expect(summary.errors).toBe(1);
  });
});

describe('aid cost', () => {
  it('refuses to guess a directory when none is given', () => {
    const made = scratch();
    const run = aid(made, ['cost'], { env: {} });

    expect(run.code).toBe(2);
    expect(codes(made, ['cost'])).toEqual(['cli/trace-dir-missing']);
    expect(run.stdout).toContain('aid: no trace directory');
  });

  it('defaults to AID_TRACE_DIR', () => {
    const made = scratch();
    made.write('traces/trace-1.jsonl', jsonl([call('gpt-4o-mini', { cost: 0.0001 })]));

    const run = aid(made, ['cost'], { env: { AID_TRACE_DIR: join(made.root, 'traces') } });

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('spans: 1 in 1 trace(s)');
  });

  it('treats an empty AID_TRACE_DIR as unset', () => {
    const made = scratch();
    const run = aid(made, ['cost'], { env: { AID_TRACE_DIR: '   ' } });

    expect(run.code).toBe(2);
    expect(codes(made, ['cost'], { AID_TRACE_DIR: '   ' })).toEqual(['cli/trace-dir-missing']);
  });

  it('rejects an unparseable --since before touching the disk', () => {
    const made = scratch();
    const run = aid(made, ['cost', 'traces', '--since', 'last tuesday'], { env: {} });

    expect(run.code).toBe(2);
    expect(codes(made, ['cost', 'traces', '--since', 'last tuesday'])).toEqual([
      'cli/trace-since-invalid',
    ]);
  });

  it('reports a directory that does not exist', () => {
    const made = scratch();
    const run = aid(made, ['cost', 'missing'], { env: {} });

    expect(run.code).toBe(2);
    expect(codes(made, ['cost', 'missing'])).toEqual(['cli/trace-dir-not-found']);
    expect(run.stdout).toContain('aid: "missing" is not a directory.');
  });

  it('reports a path that is a file, not a directory', () => {
    const made = scratch();
    made.write('trace.jsonl', jsonl([call('a', { cost: 0.01 })]));

    const run = aid(made, ['cost', 'trace.jsonl'], { env: {} });
    expect(run.code).toBe(2);
    expect(codes(made, ['cost', 'trace.jsonl'])).toEqual(['cli/trace-dir-not-found']);
  });

  it('is a successful empty report when the directory holds no traces', () => {
    const made = scratch();
    made.write('traces/notes.txt', 'not a trace');

    const run = aid(made, ['cost', 'traces'], { env: {} });

    expect(run.code).toBe(0);
    expect(codes(made, ['cost', 'traces'])).toEqual(['cli/trace-empty']);
    expect(severityOf(made, ['cost', 'traces'], 'cli/trace-empty')).toBe('warning');
    expect(run.stdout).toContain('spans: 0 in 0 trace(s)');
    expect(run.stdout).toContain('cost: $0.000000');
  });

  it('prints a report and the same numbers as JSON', () => {
    const made = scratch();
    made.write(
      'traces/trace-1.jsonl',
      jsonl([
        call('gpt-4o-mini', { input: 100, output: 50, cost: 0.00012, duration: 120 }),
        call('gpt-4o-mini', { input: 200, output: 60, duration: 240, status: 'ERROR' }),
        span({ trace_id: 'trace-2', name: 'retrieve', duration_ms: 10 }),
      ]),
    );

    const run = aid(made, ['cost', 'traces'], { env: {} });
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('dir: traces');
    expect(run.stdout).toContain('spans: 3 in 2 trace(s)');
    expect(run.stdout).toContain('cost: $0.000120 (1 unpriced span(s) not included)');
    expect(run.stdout).toContain('tokens: 300 input, 110 output');
    expect(run.stdout).toContain('latency: p50 120ms, p95 240ms over 2 model call(s)');
    expect(run.stdout).toContain('errors: 1 span(s)');
    expect(run.stdout).toContain('by model:');

    const report = aid(made, ['cost', 'traces', '--json'], { env: {} });
    const json = report.json<{
      ok: boolean;
      dir: string;
      files: number;
      spans: number;
      traces: number;
      errors: number;
      inputTokens: number;
      outputTokens: number;
      costUsd: number;
      unpricedSpans: number;
      latencyMs: { p50: number; p95: number };
      models: { model: string; calls: number; unpricedCalls: number }[];
    }>();

    expect(json.ok).toBe(true);
    expect(json.dir).toBe('traces');
    expect(json.files).toBe(1);
    expect(json.spans).toBe(3);
    expect(json.traces).toBe(2);
    expect(json.errors).toBe(1);
    expect(json.inputTokens).toBe(300);
    expect(json.outputTokens).toBe(110);
    expect(json.costUsd).toBeCloseTo(0.00012, 10);
    expect(json.unpricedSpans).toBe(1);
    expect(json.latencyMs).toEqual({ p50: 120, p95: 240 });
    expect(json.models).toHaveLength(1);
    expect(json.models[0]).toMatchObject({ model: 'gpt-4o-mini', calls: 2, unpricedCalls: 1 });
  });

  it('counts traces across files and ignores non-jsonl entries', () => {
    const made = scratch();
    made.write('traces/trace-a.jsonl', jsonl([call('a', { cost: 0.01, trace: 't1' })]));
    made.write('traces/trace-b.jsonl', jsonl([call('a', { cost: 0.02, trace: 't2' })]));
    made.write('traces/README.md', 'ignore me');

    const run = aid(made, ['cost', 'traces', '--json'], { env: {} });
    const json = run.json<{ files: number; traces: number; costUsd: number }>();

    expect(json.files).toBe(2);
    expect(json.traces).toBe(2);
    expect(json.costUsd).toBeCloseTo(0.03, 10);
  });

  it('reports malformed lines as a warning and still exits 0', () => {
    const made = scratch();
    made.write(
      'traces/trace-1.jsonl',
      `${JSON.stringify(call('a', { cost: 0.01 }))}\n{"trace_id":"trunc`,
    );

    const run = aid(made, ['cost', 'traces'], { env: {} });

    expect(run.code).toBe(0);
    expect(codes(made, ['cost', 'traces'])).toContain('cli/trace-malformed');
    expect(severityOf(made, ['cost', 'traces'], 'cli/trace-malformed')).toBe('warning');
    expect(run.stdout).toContain('spans: 1 in 1 trace(s)');
  });

  it('applies --since to the report and echoes the normalised instant', () => {
    const made = scratch();
    made.write(
      'traces/trace-1.jsonl',
      jsonl([
        call('a', { at: STARTED, cost: 0.5 }),
        call('a', { at: LATER, cost: 0.25, trace: 'trace-2' }),
      ]),
    );

    const run = aid(made, ['cost', 'traces', '--since', '2026-10-02', '--json'], { env: {} });
    const json = run.json<{ spans: number; costUsd: number; since: string }>();

    expect(json.spans).toBe(1);
    expect(json.costUsd).toBeCloseTo(0.25, 10);
    expect(json.since).toBe('2026-10-02T00:00:00.000Z');
  });

  /**
   * The one exit-1 path. Making a file unreadable is a permission change, and Windows
   * does not honour `chmod` for it, so this is exercised on the POSIX CI runners; the
   * branch is still a single `catch` that the other tests keep honest.
   */
  it.skipIf(process.platform === 'win32')(
    'exits 1 when a trace file cannot be read, reporting the readable rest',
    () => {
      const made = scratch();
      made.write('traces/trace-1.jsonl', jsonl([call('a', { cost: 0.01 })]));
      made.write('traces/trace-2.jsonl', jsonl([call('a', { cost: 0.02 })]));
      chmodSync(join(made.root, 'traces', 'trace-2.jsonl'), 0o000);

      const run = aid(made, ['cost', 'traces'], { env: {} });

      expect(run.code).toBe(1);
      expect(codes(made, ['cost', 'traces'])).toContain('cli/trace-unreadable');
      expect(run.stdout).toContain('spans: 1 in 1 trace(s)');
    },
  );
});
