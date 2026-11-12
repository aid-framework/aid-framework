/**
 * `aid trace export` turns traced runs into a dataset file an eval can read.
 *
 * Three things are worth pinning, and only the third is obvious:
 *
 * - **The bytes.** A dataset has one canonical form -- Python's
 *   `json.dumps(sort_keys=True, indent=2)` plus a trailing newline -- and two writers that
 *   disagree produce a diff on every regeneration, which is exactly the noise the
 *   canonical form exists to stop. So one test asserts the file literally, character for
 *   character, rather than parsing it back and checking fields.
 * - **The refusals.** The interesting one is not "the directory is empty" but "the runs
 *   recorded no payloads", because that is what the sink does by default and the message
 *   has to name `AID_TRACE_CONTENT` or the operator is left guessing.
 * - **The honesty tag.** Every exported case is `unreviewed`, because `expected` is what a
 *   run happened to output. A test that only checked the tag existed would pass on a
 *   future version that started claiming the cases were curated, so the assertion is on
 *   the exact tag list.
 */

import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import type { TraceSpan } from '../src/index.js';
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

/** The attributes a captured model call carries: model, usage, cost, and both payloads. */
const PAYLOAD: Readonly<Record<string, unknown>> = {
  'gen_ai.request.model': 'gpt-x',
  'gen_ai.usage.input_tokens': 10,
  'gen_ai.usage.output_tokens': 5,
  'aid.cost.usd': 0.25,
  'aid.input.text': 'hello',
  'aid.output.text': 'world',
};

/** One span as the runtime writes it, with the payloads `AID_TRACE_CONTENT=1` adds. */
function span(overrides: Record<string, unknown> = {}): TraceSpan {
  return {
    trace_id: 'trace-1',
    span_id: 'span-1',
    parent_span_id: null,
    name: 'chat',
    kind: 'CLIENT',
    started_at: STARTED,
    ended_at: STARTED,
    duration_ms: 100,
    attributes: PAYLOAD,
    events: [],
    status: { code: 'OK' },
    ...overrides,
  } as unknown as TraceSpan;
}

function jsonl(spans: readonly TraceSpan[]): string {
  return `${spans.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
}

/** A project whose trace directory holds `spans`, and no environment to confuse it. */
function withTraces(spans: readonly TraceSpan[]): Project {
  const made = scratch();
  made.write('traces/trace-1.jsonl', jsonl(spans));
  return made;
}

function jsonRun(made: Project, argv: readonly string[]): Run {
  return aid(made, [...argv, '--json']);
}

function codes(made: Project, argv: readonly string[]): readonly string[] {
  return diagnosticsOf(jsonRun(made, argv)).map((diagnostic) => diagnostic.code);
}

/** The export invocation every test starts from: a named dataset over `traces/`. */
function exportOf(made: Project, extra: readonly string[] = []): readonly string[] {
  return ['trace', 'export', '--dataset', 'demo', '--from', join(made.root, 'traces'), ...extra];
}

describe('aid trace export', () => {
  it('writes the canonical dataset form, byte for byte', () => {
    const made = withTraces([
      span({ attributes: { ...PAYLOAD, 'aid.agent.id': 'greeter', 'aid.tool.names': 'lookup' } }),
    ]);

    const run = aid(made, exportOf(made));

    expect(run.code).toBe(0);
    // Python writes `json.dumps(model_dump(mode="json"), indent=2, sort_keys=True) + "\n"`.
    // Sorted keys recurse into `metadata`, and the trailing newline is part of the file.
    expect(made.read('datasets/demo.json')).toBe(
      `{
  "cases": [
    {
      "expected": "world",
      "id": "trace-1",
      "input": "hello",
      "metadata": {
        "agent": "greeter",
        "calls": "1",
        "cost_usd": "0.25",
        "duration_ms": "100",
        "model": "gpt-x",
        "started_at": "${STARTED}",
        "tools": "lookup",
        "trace_id": "trace-1"
      },
      "tags": [
        "trace-export",
        "unreviewed"
      ]
    }
  ],
  "name": "demo",
  "version": "1"
}
`,
    );
  });

  it('refuses when the runs recorded no payloads, and names the variable that fixes it', () => {
    // The sink keeps no prompt or completion text by default, so this is the ordinary
    // failure: money was spent, spans exist, and there is still no `input` to build a case on.
    const made = withTraces([
      span({
        attributes: {
          'gen_ai.request.model': 'gpt-x',
          'gen_ai.usage.input_tokens': 10,
          'aid.cost.usd': 0.25,
        },
      }),
    ]);

    const run = jsonRun(made, exportOf(made));

    expect(run.code).toBe(2);
    expect(codes(made, exportOf(made))).toEqual(['cli/trace-export-no-cases']);
    expect(run.stdout).toContain('AID_TRACE_CONTENT=1');
    expect(made.exists('datasets/demo.json')).toBe(false);
  });

  it('still exports a run whose first call recorded no answer, using a later one', () => {
    const made = withTraces([
      span({ span_id: 'a', attributes: { 'aid.input.text': 'hello' }, status: { code: 'ERROR' } }),
      span({
        span_id: 'b',
        parent_span_id: 'a',
        started_at: '2026-10-01T10:00:01.000Z',
        attributes: { 'aid.input.text': 'retry', 'aid.output.text': 'world' },
      }),
    ]);

    const run = aid(made, exportOf(made));

    expect(run.code).toBe(0);
    const written = JSON.parse(made.read('datasets/demo.json')) as {
      cases: { input: string; expected: string }[];
    };
    // The prompt is the *first* recorded input; the answer is the last recorded output.
    expect(written.cases.map((item) => [item.input, item.expected])).toEqual([['hello', 'world']]);
  });

  it('refuses --filter that is not agent=<id>', () => {
    const made = withTraces([span()]);

    expect(codes(made, exportOf(made, ['--filter', 'model=gpt-x']))).toEqual([
      'cli/trace-export-filter-invalid',
    ]);
  });

  it('refuses a filter that matches no run, and exports every run without one', () => {
    const made = withTraces([span({ attributes: { ...PAYLOAD, 'aid.agent.id': 'greeter' } })]);

    const refused = jsonRun(made, exportOf(made, ['--filter', 'agent=someone-else']));

    expect(refused.code).toBe(2);
    expect(diagnosticsOf(refused).map((item) => item.code)).toEqual([
      'cli/trace-export-filter-no-match',
    ]);

    // The matching filter writes the same file an unfiltered export would.
    expect(aid(made, exportOf(made, ['--filter', 'agent=greeter'])).code).toBe(0);
    expect(made.exists('datasets/demo.json')).toBe(true);
  });

  it('refuses to overwrite an existing dataset without --force', () => {
    const made = withTraces([span()]);
    made.write('datasets/demo.json', 'curated by hand\n');

    const refused = jsonRun(made, exportOf(made));

    expect(refused.code).toBe(2);
    expect(diagnosticsOf(refused).map((item) => item.code)).toEqual([
      'cli/trace-export-would-overwrite',
    ]);
    expect(made.read('datasets/demo.json')).toBe('curated by hand\n');

    expect(aid(made, exportOf(made, ['--force'])).code).toBe(0);
    expect(made.read('datasets/demo.json')).toContain('"name": "demo"');
  });

  it('requires --dataset', () => {
    const made = withTraces([span()]);

    expect(codes(made, ['trace', 'export', '--from', join(made.root, 'traces')])).toEqual([
      'cli/trace-export-dataset-required',
    ]);
  });

  it('honours --out and --version, and tags every case unreviewed', () => {
    const made = withTraces([span()]);

    const out = join(made.root, 'evals', 'cases.json');
    const run = aid(made, exportOf(made, ['--out', out, '--version', '2']));

    expect(run.code).toBe(0);
    const written = JSON.parse(made.read('evals/cases.json')) as {
      version: string;
      cases: { tags: string[] }[];
    };
    expect(written.version).toBe('2');
    // The exact list, not a containment check: `expected` is what the run produced, so
    // nothing may quietly drop the tag that says a human has not looked at it.
    expect(written.cases.every((item) => item.tags.join(',') === 'trace-export,unreviewed')).toBe(
      true,
    );
  });
});
