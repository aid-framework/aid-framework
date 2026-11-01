/**
 * `aid trace` reads one run back out of the trace sink.
 *
 * Two groups again. The pure tests pin the shape of a run -- which spans belong to one,
 * what counts as its root, how long it wall-clocked, and the order a tree prints in --
 * because those are judgements a reader cannot check from the output alone. The command
 * tests pin the exit taxonomy: a selector that matches nothing is a wrong invocation
 * (`2`), an unreadable file is `1`, and an empty sink is a true `0` with a warning.
 *
 * The one thing these tests deliberately cannot assert is a replay, because there is
 * none: the sink records no prompts or completions, so `trace` inspects and says so.
 */

import { chmodSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import type { TraceSpan } from '../src/index.js';
import { childrenOf, factsOf, readTraceDir, runsOf, treeRowsOf } from '../src/index.js';
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

/** One span exactly as the runtime writes it; fields a test does not care about filled in. */
function span(overrides: Record<string, unknown> = {}): TraceSpan {
  return {
    trace_id: 'trace-1',
    span_id: 'span-1',
    parent_span_id: null,
    name: 'chat',
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

/** A timed child span, offset by `afterMs` from STARTED. */
function child(
  id: string,
  parent: string,
  options: { readonly after?: number; readonly duration?: number; readonly trace?: string } = {},
): TraceSpan {
  const at = new Date(Date.parse(STARTED) + (options.after ?? 0)).toISOString();
  return span({
    trace_id: options.trace ?? 'trace-1',
    span_id: id,
    parent_span_id: parent,
    started_at: at,
    duration_ms: options.duration ?? 10,
  });
}

function jsonl(spans: readonly TraceSpan[]): string {
  return `${spans.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
}

/** The single run those spans make, refusing to hand a test `undefined` to print. */
function onlyRun(spans: readonly TraceSpan[]) {
  const [run] = runsOf(spans);
  if (run === undefined) throw new Error('expected one run');
  return run;
}

function jsonRun(
  made: Project,
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = {},
): Run {
  return aid(made, [...argv, '--json'], { env });
}

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

describe('runsOf', () => {
  it('groups spans by trace id, newest first', () => {
    const runs = runsOf([
      child('a', 'none', { trace: 'old' }),
      span({ trace_id: 'new', span_id: 'b', started_at: '2026-10-02T00:00:00.000Z' }),
      span({ trace_id: 'old', span_id: 'c', started_at: '2026-10-01T10:00:00.000Z' }),
    ]);

    expect(runs.map((run) => run.traceId)).toEqual(['new', 'old']);
    expect(runs.find((run) => run.traceId === 'old')?.spans).toHaveLength(2);
  });

  it('calls a trace with one top-level span rooted, and does not when there are two', () => {
    const rooted = runsOf([span({ span_id: 'root' }), child('kid', 'root')]);
    expect(rooted[0]?.root?.span_id).toBe('root');

    const split = runsOf([span({ span_id: 'one' }), child('two', 'missing')]);
    expect(split[0]?.root).toBeUndefined();
  });

  it('measures wall time from the earliest start to the latest end, not the span sum', () => {
    const [run] = runsOf([
      span({ span_id: 'root', duration_ms: 300 }),
      child('a', 'root', { after: 0, duration: 100 }),
      child('b', 'root', { after: 100, duration: 100 }),
    ]);

    // 300ms wall, not the 500ms of root + two children.
    expect(run?.durationMs).toBe(300);
  });

  it('carries the error and cost counts summariseSpans computes', () => {
    const [run] = runsOf([
      span({
        span_id: 'a',
        attributes: { 'gen_ai.usage.input_tokens': 10 },
        status: { code: 'ERROR' },
      }),
      span({ span_id: 'b', attributes: { 'aid.cost.usd': 0.5 } }),
    ]);

    expect(run?.errors).toBe(1);
    expect(run?.costUsd).toBe(0.5);
    expect(run?.unpricedSpans).toBe(1);
  });
});

describe('childrenOf and treeRowsOf', () => {
  it('orders children by start, depth first', () => {
    const spans = [
      span({ span_id: 'root', started_at: STARTED }),
      child('late', 'root', { after: 50 }),
      child('early', 'root', { after: 10 }),
      child('grandchild', 'early', { after: 20 }),
    ];

    const children = childrenOf(spans);
    expect(children.get('root')?.map((entry) => entry.span_id)).toEqual(['early', 'late']);

    const rows = treeRowsOf(onlyRun(spans));
    expect(rows.map((row) => [row.span.span_id, row.depth])).toEqual([
      ['root', 0],
      ['early', 1],
      ['grandchild', 2],
      ['late', 1],
    ]);
  });

  it('puts a span whose parent is missing at the top rather than dropping it', () => {
    const rows = treeRowsOf(onlyRun([span({ span_id: 'orphan', parent_span_id: 'gone' })]));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.depth).toBe(0);
  });

  it('keeps every span when parent links form a cycle', () => {
    const rows = treeRowsOf(
      onlyRun([
        span({ span_id: 'a', parent_span_id: 'b' }),
        span({ span_id: 'b', parent_span_id: 'a' }),
      ]),
    );

    expect(rows.map((row) => row.span.span_id).sort()).toEqual(['a', 'b']);
  });

  it('offsets each row from the earliest start, and omits an unreadable timestamp', () => {
    const rows = treeRowsOf(
      onlyRun([
        span({ span_id: 'root', started_at: STARTED }),
        child('later', 'root', { after: 250 }),
        span({ span_id: 'undated', started_at: 'not a date' }),
      ]),
    );

    expect(rows.find((row) => row.span.span_id === 'root')?.offsetMs).toBe(0);
    expect(rows.find((row) => row.span.span_id === 'later')?.offsetMs).toBe(250);
    expect(rows.find((row) => row.span.span_id === 'undated')?.offsetMs).toBeUndefined();
  });
});

describe('factsOf', () => {
  it('reads tokens, cost and the pinned alias', () => {
    const facts = factsOf(
      span({
        duration_ms: 42,
        attributes: {
          'aid.model.alias': 'writer',
          'gen_ai.usage.input_tokens': 120,
          'gen_ai.usage.output_tokens': 30,
          'aid.cost.usd': 0.002,
        },
      }),
    );

    expect(facts).toEqual({
      durationMs: 42,
      costUsd: 0.002,
      inputTokens: 120,
      outputTokens: 30,
      model: 'writer',
      error: false,
    });
  });

  it('falls back to the served model, and reports nothing when no model is recorded', () => {
    expect(factsOf(span({ attributes: { 'gen_ai.response.model': 'gpt-4o' } })).model).toBe(
      'gpt-4o',
    );
    expect(factsOf(span()).model).toBeUndefined();
  });

  it('marks an error span and ignores a negative duration', () => {
    const facts = factsOf(span({ duration_ms: -1, status: { code: 'ERROR', message: 'boom' } }));
    expect(facts.error).toBe(true);
    expect(facts.durationMs).toBeUndefined();
  });
});

describe('readTraceDir', () => {
  it('reads only jsonl files, in name order, counting malformed lines', () => {
    const made = scratch();
    made.write('traces/b.jsonl', jsonl([span({ span_id: 'b' })]));
    made.write('traces/a.jsonl', `${JSON.stringify(span({ span_id: 'a' }))}\n{"trace_id":"trunc`);
    made.write('traces/notes.txt', 'ignore me');

    const read = readTraceDir(join(made.root, 'traces'));

    expect(read.files).toEqual(['a.jsonl', 'b.jsonl']);
    expect(read.spans.map((entry) => entry.span_id)).toEqual(['a', 'b']);
    expect(read.skipped).toBe(1);
    expect(read.unreadable).toBe(0);
  });
});

describe('aid trace', () => {
  it('needs a directory', () => {
    const made = scratch();
    const run = aid(made, ['trace'], { env: {} });

    expect(run.code).toBe(2);
    expect(codes(made, ['trace'])).toEqual(['cli/trace-dir-missing']);
    expect(run.stdout).toContain('aid: no trace directory');
  });

  it('defaults to AID_TRACE_DIR', () => {
    const made = scratch();
    made.write('traces/trace-1.jsonl', jsonl([span()]));

    const run = aid(made, ['trace'], { env: { AID_TRACE_DIR: join(made.root, 'traces') } });

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('1 run(s), newest first');
  });

  it('reports a directory that does not exist, and one that is a file', () => {
    const made = scratch();
    made.write('trace.jsonl', jsonl([span()]));

    expect(aid(made, ['trace', '--dir', 'missing'], { env: {} }).code).toBe(2);
    expect(codes(made, ['trace', '--dir', 'missing'])).toEqual(['cli/trace-dir-not-found']);
    expect(codes(made, ['trace', '--dir', 'trace.jsonl'])).toEqual(['cli/trace-dir-not-found']);
  });

  it('is a successful empty listing when the directory holds no traces', () => {
    const made = scratch();
    made.write('traces/notes.txt', 'not a trace');

    const run = aid(made, ['trace', '--dir', 'traces'], { env: {} });

    expect(run.code).toBe(0);
    expect(codes(made, ['trace', '--dir', 'traces'])).toEqual(['cli/trace-empty']);
    expect(severityOf(made, ['trace', '--dir', 'traces'], 'cli/trace-empty')).toBe('warning');
  });

  it('warns when the files hold no complete span', () => {
    const made = scratch();
    made.write('traces/trace-1.jsonl', '{"trace_id":"trunc');

    const run = aid(made, ['trace', '--dir', 'traces'], { env: {} });

    expect(run.code).toBe(0);
    expect(codes(made, ['trace', '--dir', 'traces'])).toContain('cli/trace-no-runs');
    expect(run.stdout).toContain('no runs recorded.');
  });

  it('lists runs newest first, and repeats them as JSON', () => {
    const made = scratch();
    made.write(
      'traces/traces.jsonl',
      jsonl([
        span({ trace_id: 'older', span_id: 'a', started_at: '2026-10-01T09:00:00.000Z' }),
        span({ trace_id: 'newer', span_id: 'b', started_at: '2026-10-01T11:00:00.000Z' }),
      ]),
    );

    const run = aid(made, ['trace', '--dir', 'traces'], { env: {} });
    expect(run.code).toBe(0);
    expect(run.stdout.indexOf('newer')).toBeLessThan(run.stdout.indexOf('older'));

    const json = jsonRun(made, ['trace', '--dir', 'traces']).json<{
      ok: boolean;
      dir: string;
      files: number;
      spans: number;
      runs: { traceId: string; spans: number; rootName?: string }[];
    }>();
    expect(json.ok).toBe(true);
    expect(json.dir).toBe('traces');
    expect(json.files).toBe(1);
    expect(json.spans).toBe(2);
    expect(json.runs.map((entry) => entry.traceId)).toEqual(['newer', 'older']);
  });

  it('prints the tree for one run, selected by id or an unambiguous prefix', () => {
    const made = scratch();
    made.write(
      'traces/traces.jsonl',
      jsonl([
        span({ trace_id: 'aaaa1111', span_id: 'root', name: 'chat turn' }),
        child('call', 'root', { after: 20, trace: 'aaaa1111' }),
        span({ trace_id: 'bbbb2222', span_id: 'other' }),
      ]),
    );

    const exact = jsonRun(made, ['trace', '--dir', 'traces', 'aaaa1111']);
    expect(exact.code).toBe(0);
    const json = exact.json<{
      run: { traceId: string; spans: number };
      tree: { spanId: string; depth: number; offsetMs?: number; error: boolean }[];
    }>();
    expect(json.run.traceId).toBe('aaaa1111');
    expect(json.tree.map((row) => [row.spanId, row.depth])).toEqual([
      ['root', 0],
      ['call', 1],
    ]);
    expect(json.tree[1]?.offsetMs).toBe(20);

    expect(jsonRun(made, ['trace', '--dir', 'traces', 'aaaa']).code).toBe(0);
  });

  it('refuses an unknown selector, and an ambiguous one', () => {
    const made = scratch();
    made.write(
      'traces/traces.jsonl',
      jsonl([
        span({ trace_id: 'abcd1111', span_id: 'a' }),
        span({ trace_id: 'abcd2222', span_id: 'b' }),
      ]),
    );

    const unknown = aid(made, ['trace', '--dir', 'traces', 'zzzz'], { env: {} });
    expect(unknown.code).toBe(2);
    expect(codes(made, ['trace', '--dir', 'traces', 'zzzz'])).toEqual(['cli/trace-run-not-found']);

    const ambiguous = aid(made, ['trace', '--dir', 'traces', 'abcd'], { env: {} });
    expect(ambiguous.code).toBe(2);
    expect(codes(made, ['trace', '--dir', 'traces', 'abcd'])).toEqual(['cli/trace-run-ambiguous']);
    expect(ambiguous.stdout).toContain('matches 2 runs');
  });

  it('refuses --run together with --all', () => {
    const made = scratch();
    made.write('traces/trace-1.jsonl', jsonl([span()]));

    const run = aid(made, ['trace', '--dir', 'traces', '--all', 'trace-1'], { env: {} });

    expect(run.code).toBe(2);
    expect(codes(made, ['trace', '--dir', 'traces', '--all', 'trace-1'])).toEqual([
      'cli/trace-flags-conflict',
    ]);
  });

  it('prints every run with --all', () => {
    const made = scratch();
    made.write(
      'traces/traces.jsonl',
      jsonl([
        span({ trace_id: 'one', span_id: 'a', name: 'first' }),
        span({ trace_id: 'two', span_id: 'b', name: 'second' }),
      ]),
    );

    const run = aid(made, ['trace', '--dir', 'traces', '--all'], { env: {} });

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('run: one');
    expect(run.stdout).toContain('run: two');
    expect(run.stdout).toContain('first');
    expect(run.stdout).toContain('second');

    const json = jsonRun(made, ['trace', '--dir', 'traces', '--all']).json<{
      runs: { traceId: string; tree: unknown[] }[];
    }>();
    expect(json.runs).toHaveLength(2);
    expect(json.runs[0]?.tree).toHaveLength(1);
  });

  it('reports malformed lines as a warning and still exits 0', () => {
    const made = scratch();
    made.write('traces/trace-1.jsonl', `${JSON.stringify(span())}\n{"trace_id":"trunc`);

    const run = aid(made, ['trace', '--dir', 'traces'], { env: {} });

    expect(run.code).toBe(0);
    expect(codes(made, ['trace', '--dir', 'traces'])).toContain('cli/trace-malformed');
    expect(severityOf(made, ['trace', '--dir', 'traces'], 'cli/trace-malformed')).toBe('warning');
  });

  /**
   * The only exit-1 path. Windows does not honour `chmod` for this, so it runs on the
   * POSIX CI runners; the branch itself is one `catch` the other tests keep honest.
   */
  it.skipIf(process.platform === 'win32')(
    'exits 1 when a trace file cannot be read, still showing the readable rest',
    () => {
      const made = scratch();
      made.write('traces/trace-1.jsonl', jsonl([span({ span_id: 'readable' })]));
      made.write('traces/trace-2.jsonl', jsonl([span({ span_id: 'secret' })]));
      chmodSync(join(made.root, 'traces', 'trace-2.jsonl'), 0o000);

      const run = aid(made, ['trace', '--dir', 'traces'], { env: {} });

      expect(run.code).toBe(1);
      expect(codes(made, ['trace', '--dir', 'traces'])).toContain('cli/trace-unreadable');
      expect(run.stdout).toContain('1 run(s), newest first');
    },
  );
});
