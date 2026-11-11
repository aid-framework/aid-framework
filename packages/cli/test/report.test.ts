/**
 * `aid report` compares many deployments from files alone.
 *
 * The pure tests pin the two rules a reader would otherwise have to trust: a baseline is
 * parsed leniently but never guessed at, and a deployment with no traces is reported as
 * unmeasured rather than free. The command tests then pin the exit taxonomy and the shape
 * of the table, including the one refusal that has a real consequence -- a fleet total
 * over `--budget`, which is the only way this command can fail a CI job for a reason that
 * is about the numbers rather than the files.
 */

import { chmodSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import type { TraceSpan } from '../src/index.js';
import { parseEvalBaseline, readFleetReport } from '../src/index.js';
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

function call(
  model: string,
  options: { readonly cost?: number; readonly duration?: number; readonly trace?: string } = {},
): TraceSpan {
  const attributes: Record<string, unknown> = {
    'aid.model.alias': model,
    'gen_ai.usage.input_tokens': 100,
    'gen_ai.usage.output_tokens': 50,
  };
  if (options.cost !== undefined) attributes['aid.cost.usd'] = options.cost;
  return span({
    trace_id: options.trace ?? 'trace-1',
    duration_ms: options.duration ?? 100,
    attributes,
    status: { code: 'OK' },
  });
}

function jsonl(spans: readonly TraceSpan[]): string {
  return `${spans.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
}

/** A recorded baseline in the shape `aid eval --baseline` writes. */
function baseline(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    dataset: 'support-copilot',
    dataset_version: 3,
    // Two metrics with different magnitudes: a ratio and a per-run dollar cost, so the
    // rendering test covers both ends of what a recorded mean can look like.
    metrics: [
      { metric: 'exact_match', mean: 0.82, stdev: 0.01, runs: 3 },
      { metric: 'cost_usd', mean: 0.0042, stdev: 0.0004, runs: 3 },
    ],
    ...overrides,
  });
}

function codes(made: Project, argv: readonly string[]): readonly string[] {
  return diagnosticsOf(jsonRun(made, argv)).map((diagnostic) => diagnostic.code);
}

function severityOf(made: Project, argv: readonly string[], code: string): string | undefined {
  return diagnosticsOf(jsonRun(made, argv)).find((diagnostic) => diagnostic.code === code)
    ?.severity;
}

function jsonRun(made: Project, argv: readonly string[]): Run {
  return aid(made, [...argv, '--json'], { env: {} });
}

describe('parseEvalBaseline', () => {
  it('reads the dataset, version and metric means a comparison row needs', () => {
    const parsed = parseEvalBaseline('support.baseline.json', JSON.parse(baseline()));

    expect(parsed).toEqual({
      file: 'support.baseline.json',
      dataset: 'support-copilot',
      datasetVersion: '3',
      metrics: [
        { metric: 'exact_match', mean: 0.82 },
        { metric: 'cost_usd', mean: 0.0042 },
      ],
    });
  });

  it('tolerates fields this version does not know, in the file and in a metric', () => {
    const parsed = parseEvalBaseline(
      'b.baseline.json',
      JSON.parse(
        baseline({
          created_at: '2026-10-01T00:00:00.000Z',
          metrics: [{ metric: 'exact_match', mean: 0.5, runs: 3, threshold: 0.4, note: 'ok' }],
        }),
      ),
    );

    expect(parsed?.metrics).toEqual([{ metric: 'exact_match', mean: 0.5 }]);
  });

  it('refuses a file with no dataset rather than showing its scores under a blank name', () => {
    expect(parseEvalBaseline('b.baseline.json', { dataset_version: 1, metrics: [] })).toBe(
      undefined,
    );
  });

  it('refuses a metric whose mean is not a finite number', () => {
    const shape = (mean: unknown): unknown => ({
      dataset: 'support',
      dataset_version: 1,
      metrics: [{ metric: 'exact_match', mean }],
    });

    expect(parseEvalBaseline('b', shape('0.82'))).toBeUndefined();
    expect(parseEvalBaseline('b', shape(null))).toBeUndefined();
    expect(parseEvalBaseline('b', shape(undefined))).toBeUndefined();
  });

  it('refuses a payload that is not an object at all', () => {
    expect(parseEvalBaseline('b', null)).toBeUndefined();
    expect(parseEvalBaseline('b', [])).toBeUndefined();
    expect(parseEvalBaseline('b', 'baseline')).toBeUndefined();
  });

  it('accepts a baseline that recorded no metrics, as an empty list', () => {
    const parsed = parseEvalBaseline('b.baseline.json', JSON.parse(baseline({ metrics: [] })));

    expect(parsed?.metrics).toEqual([]);
  });
});

describe('readFleetReport', () => {
  it('treats each immediate child directory as one deployment, in name order', () => {
    const made = scratch();
    made.write('fleet/zenith/trace-1.jsonl', jsonl([call('a', { cost: 0.02 })]));
    made.write('fleet/acme/trace-1.jsonl', jsonl([call('a', { cost: 0.01 })]));

    const report = readFleetReport(join(made.root, 'fleet'));

    expect(report.deployments.map((entry) => entry.deployment)).toEqual(['acme', 'zenith']);
    expect(report.deployments.map((entry) => entry.summary?.costUsd)).toEqual([0.01, 0.02]);
    expect(report.rootUnreadable).toBe(false);
  });

  it('leaves a deployment with no trace files without a summary, not with a zero cost', () => {
    const made = scratch();
    made.write('fleet/acme/notes.txt', 'nothing has run yet');

    const report = readFleetReport(join(made.root, 'fleet'));

    expect(report.deployments).toHaveLength(1);
    expect(report.deployments[0]?.summary).toBeUndefined();
    expect(report.deployments[0]?.files).toBe(0);
  });

  it('ignores a nested directory instead of attributing its spans to the customer', () => {
    const made = scratch();
    made.write('fleet/acme/archive/old.jsonl', jsonl([call('a', { cost: 9 })]));

    const report = readFleetReport(join(made.root, 'fleet'));

    expect(report.deployments.map((entry) => entry.deployment)).toEqual(['acme']);
    expect(report.deployments[0]?.summary).toBeUndefined();
  });

  it('separates a baseline that is not a recorded baseline from the ones that are', () => {
    const made = scratch();
    made.write('fleet/acme/good.baseline.json', baseline());
    made.write('fleet/acme/broken.baseline.json', '{"metrics": []}');
    made.write('fleet/acme/not-json.baseline.json', 'not json at all');

    const report = readFleetReport(join(made.root, 'fleet'));

    expect(report.deployments[0]?.baselines.map((entry) => entry.file)).toEqual([
      'good.baseline.json',
    ]);
    expect(report.badBaselines.map((entry) => entry.file)).toEqual([
      'broken.baseline.json',
      'not-json.baseline.json',
    ]);
  });

  it('marks the root unreadable rather than throwing when it cannot be listed', () => {
    const report = readFleetReport(join(process.cwd(), 'definitely-not-a-directory-8f2a'));

    expect(report.rootUnreadable).toBe(true);
    expect(report.deployments).toEqual([]);
  });
});

describe('aid report', () => {
  it('refuses to guess which fleet to read', () => {
    const made = scratch();

    const run = aid(made, ['report'], { env: {} });

    expect(run.code).toBe(2);
    expect(codes(made, ['report'])).toEqual(['cli/report-dir-unreadable']);
    expect(diagnosticsOf(jsonRun(made, ['report']))[0]?.message).toContain('needs a directory');
  });

  it('refuses a path that is a file, because that is one trace sink rather than a fleet', () => {
    const made = scratch();
    made.write('trace.jsonl', jsonl([call('a', { cost: 0.01 })]));

    const run = aid(made, ['report', 'trace.jsonl'], { env: {} });

    expect(run.code).toBe(2);
    expect(diagnosticsOf(jsonRun(made, ['report', 'trace.jsonl']))[0]?.code).toBe(
      'cli/report-dir-unreadable',
    );
  });

  it('is a successful empty report when the root holds no deployment directories', () => {
    const made = scratch();
    made.write('fleet/README.md', 'download the trace sinks here');

    const run = aid(made, ['report', 'fleet'], { env: {} });

    expect(run.code).toBe(0);
    expect(severityOf(made, ['report', 'fleet'], 'cli/report-no-deployments')).toBe('warning');
    expect(run.stdout).toContain('dir: fleet');
    expect(run.stdout).toContain('measured: no deployment directories here');
  });

  it('prints one row per deployment and a total, and the same numbers as JSON', () => {
    const made = scratch();
    made.write(
      'fleet/acme/trace-1.jsonl',
      jsonl([call('a', { cost: 0.01, duration: 120 }), call('a', { cost: 0.01, duration: 240 })]),
    );
    made.write('fleet/zenith/trace-1.jsonl', jsonl([call('a', { cost: 0.02, duration: 90 })]));

    const text = aid(made, ['report', 'fleet'], { env: {} });
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('acme');
    expect(text.stdout).toContain('zenith');
    expect(text.stdout).toContain('p95');
    expect(text.stdout).toContain(
      'total: 3 span(s) in 2 trace(s) across 2 of 2 deployment(s), $0.040000',
    );

    const json = jsonRun(made, ['report', 'fleet']).json<{
      ok: boolean;
      dir: string;
      deployments: {
        deployment: string;
        spans: number;
        traces: number;
        costUsd: number;
        p95Ms: number;
        baselines: unknown[];
      }[];
      totals: { deployments: number; measured: number; spans: number; costUsd: number };
    }>();

    expect(json.ok).toBe(true);
    expect(json.dir).toBe('fleet');
    expect(json.deployments.map((entry) => entry.deployment)).toEqual(['acme', 'zenith']);
    expect(json.deployments[0]?.spans).toBe(2);
    expect(json.deployments[0]?.traces).toBe(1);
    expect(json.deployments[0]?.costUsd).toBe(0.02);
    expect(json.deployments[0]?.p95Ms).toBe(240);
    expect(json.deployments[0]?.baselines).toEqual([]);
    expect(json.totals).toEqual({
      deployments: 2,
      measured: 2,
      spans: 3,
      traces: 2,
      costUsd: 0.04,
      errors: 0,
      unpricedSpans: 0,
    });
  });

  it('reports a deployment with no traces as unmeasured rather than free', () => {
    const made = scratch();
    made.write('fleet/acme/trace-1.jsonl', jsonl([call('a', { cost: 0.01 })]));
    made.write('fleet/zenith/README.md', 'sink not wired up yet');

    const text = aid(made, ['report', 'fleet'], { env: {} });
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('1 of 2 deployment(s)');

    const json = jsonRun(made, ['report', 'fleet']).json<{
      deployments: Record<string, unknown>[];
      totals: { measured: number };
    }>();
    const zenith = json.deployments.find((entry) => entry['deployment'] === 'zenith');

    expect(zenith).toBeDefined();
    expect('costUsd' in (zenith as object)).toBe(false);
    expect('p95Ms' in (zenith as object)).toBe(false);
    expect(json.totals.measured).toBe(1);
  });

  it('shows a committed baseline next to the traces it belongs to', () => {
    const made = scratch();
    made.write('fleet/acme/trace-1.jsonl', jsonl([call('a', { cost: 0.01 })]));
    made.write('fleet/acme/support.baseline.json', baseline());

    const text = aid(made, ['report', 'fleet'], { env: {} });

    expect(text.code).toBe(0);
    // Four significant digits, so a ratio and a per-run dollar cost are both readable.
    expect(text.stdout).toContain('1 baseline(s): exact_match 0.82, cost_usd 0.0042');
  });

  it('warns about a baseline it cannot read, and still reports the traces', () => {
    const made = scratch();
    made.write('fleet/acme/trace-1.jsonl', jsonl([call('a', { cost: 0.01 })]));
    made.write('fleet/acme/broken.baseline.json', '{"metrics": []}');

    const run = aid(made, ['report', 'fleet'], { env: {} });

    expect(run.code).toBe(0);
    expect(severityOf(made, ['report', 'fleet'], 'cli/report-baseline-invalid')).toBe('warning');
    expect(run.stdout).toContain('$0.010000');
  });

  it('fails the run when the fleet total is over --budget', () => {
    const made = scratch();
    made.write('fleet/acme/trace-1.jsonl', jsonl([call('a', { cost: 0.02 })]));
    made.write('fleet/zenith/trace-1.jsonl', jsonl([call('a', { cost: 0.02 })]));

    const run = aid(made, ['report', 'fleet', '--budget', '0.03'], { env: {} });

    expect(run.code).toBe(1);
    expect(codes(made, ['report', 'fleet', '--budget', '0.03'])).toContain('cli/cost-over-budget');
    expect(run.stdout).toContain('budget: $0.030000 (over by $0.010000)');
  });

  it('passes when the fleet total is within --budget', () => {
    const made = scratch();
    made.write('fleet/acme/trace-1.jsonl', jsonl([call('a', { cost: 0.01 })]));

    const run = aid(made, ['report', 'fleet', '--budget', '1'], { env: {} });

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('budget: $1.000000 (within)');
  });

  it('rejects a --budget that is not an amount, before reading any traces', () => {
    const made = scratch();
    made.write('fleet/acme/trace-1.jsonl', jsonl([call('a', { cost: 0.01 })]));

    const run = aid(made, ['report', 'fleet', '--budget', 'lots'], { env: {} });

    expect(run.code).toBe(2);
    expect(codes(made, ['report', 'fleet', '--budget', 'lots'])).toEqual([
      'cli/cost-budget-invalid',
    ]);
  });

  it.skipIf(process.platform === 'win32')(
    'exits 1 when a deployment trace file cannot be read, reporting the readable rest',
    () => {
      const made = scratch();
      made.write('fleet/acme/trace-1.jsonl', jsonl([call('a', { cost: 0.01 })]));
      made.write('fleet/acme/trace-2.jsonl', jsonl([call('a', { cost: 0.02 })]));
      chmodSync(join(made.root, 'fleet', 'acme', 'trace-2.jsonl'), 0o000);

      const run = aid(made, ['report', 'fleet'], { env: {} });

      expect(run.code).toBe(1);
      expect(codes(made, ['report', 'fleet'])).toContain('cli/trace-unreadable');
      expect(run.stdout).toContain('$0.010000');
    },
  );
});
