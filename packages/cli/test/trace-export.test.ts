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
  // `trace export` reads the spec to learn what a trace may carry, so every project needs
  // one. This is the smallest document `aid validate` accepts: no sensitive field, which
  // is what lets an export write the payloads it captured.
  made.setSpec('specVersion: "0.31"\nproject:\n  name: minimal\n');
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

/**
 * A valid `profile: enterprise` document: every control the profile's gates demand, and
 * nothing else, so a test that fails here is about the export rather than the profile.
 */
const ENTERPRISE_SPEC = `specVersion: "0.31"
project:
  name: ledger
  namespace: aid.test
  targets: [py-fastapi]
profile: enterprise
models:
  small:
    provider: openai
    modelId: gpt-4o-mini
    capabilities: [json-schema]
    apiKeyEnv: OPENAI_API_KEY
observability:
  trace: true
  export: otlp
  endpointEnv: OTEL_EXPORTER_OTLP_ENDPOINT
prompts:
  answer:
    version: 1
    model: small
    template: "Answer the request."
    output:
      kind: text
guardrails:
  both:
    engine: bedrock
    stages: [input, output]
    action: block
    onFail:
      message: rejected.
      log: true
deployments:
  api:
    target: container
    cloud: aws
    region: eu-central-1
    secrets: [OPENAI_API_KEY]
    audit:
      sink: cloudwatch
      retentionDays: 400
    approvals:
      require: [platform]
      minApprovers: 1
    identity:
      kind: oidc
      issuer: https://idp.example.com
    network:
      private: true
evals:
  answers:
    target: pipeline:ledger
    dataset:
      source: file
      uri: datasets/ledger.jsonl
    metrics:
      - kind: contains
        field: reply
        value: ok
    gate:
      ci: true
pipelines:
  ledger:
    trigger:
      http:
        method: get
        path: /ledger
    steps:
      - generate:
          prompt: answer
          as: reply
`;

describe('aid trace export: the spec decides what may leave', () => {
  it('refuses when there is no spec to apply, and names --spec', () => {
    // A trace directory without a document is not a project, and the export has no
    // policy to apply -- so the refusal is about the missing document, not the traces.
    const made = scratch();
    made.write('traces/trace-1.jsonl', jsonl([span()]));

    const run = jsonRun(made, exportOf(made));

    expect(run.code).toBe(2);
    expect(diagnosticsOf(run).map((item) => item.code)).toEqual(['cli/trace-export-spec-required']);
    expect(run.stdout).toContain('--spec');
  });

  it('refuses a spec that does not pass its gates, and carries the gate diagnosis', () => {
    const made = withTraces([span()]);
    made.setSpec('specVersion: "99.0"\nproject:\n  name: minimal\n');

    const run = jsonRun(made, exportOf(made));

    expect(run.code).toBe(1);
    const found = diagnosticsOf(run).map((item) => item.code);
    expect(found).toContain('cli/trace-export-spec-invalid');
    // The spec's own diagnostic travels with the refusal, so the operator fixes the
    // document rather than guessing which gate the export meant.
    expect(found.length).toBeGreaterThan(1);
    expect(made.exists('datasets/demo.json')).toBe(false);
  });

  it('exports when the document withholds a field, because recording already removed it', () => {
    // Redaction is applied as the prompt is recorded, so the captured copy this command
    // writes never held `email`. Exporting is the point: a curated dataset is the input
    // to the improvement loop, and refusing here would mean the safer document is the one
    // that cannot improve.
    const made = withTraces([span()]);
    made.setSpec(
      'specVersion: "0.31"\nproject:\n  name: minimal\nobservability:\n  redact: [email]\n',
    );

    const run = jsonRun(made, exportOf(made));

    expect(run.code).toBe(0);
    expect(made.exists('datasets/demo.json')).toBe(true);
    // The set the document withholds, reported so CI can see what was removed rather
    // than trusting that something was.
    expect((JSON.parse(run.stdout) as { withheld: string[] }).withheld).toEqual(['email']);
  });

  it('refuses an enterprise document that withholds nothing', () => {
    // `enterprise` promises that what leaves the deployment can be accounted for. With an
    // empty withheld set the document has said nothing about what may travel, so the
    // export would be an assumption rather than a policy.
    const made = withTraces([span()]);
    made.setSpec(ENTERPRISE_SPEC);

    const run = jsonRun(made, exportOf(made, ['--spec', 'app/app.spec.yaml']));

    expect(run.code).toBe(2);
    expect(diagnosticsOf(run).map((item) => item.code)).toEqual([
      'cli/trace-export-enterprise-capture',
    ]);
    expect(made.exists('datasets/demo.json')).toBe(false);
  });

  it('exports an enterprise document that names what it withholds', () => {
    // The set is the accountability: with it declared, the recorded text was redacted as
    // it was captured and the export carries nothing the document forbade.
    const made = withTraces([span()]);
    made.setSpec(
      ENTERPRISE_SPEC.replace('observability:\n', 'observability:\n  redact: [email]\n'),
    );

    const run = jsonRun(made, exportOf(made, ['--spec', 'app/app.spec.yaml']));

    expect(run.code).toBe(0);
    expect(made.exists('datasets/demo.json')).toBe(true);
    expect((JSON.parse(run.stdout) as { withheld: string[] }).withheld).toEqual(['email']);
  });
});

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
