/**
 * The `batch` entrypoint: `app/generated/batch.py`.
 *
 * A job is a pipeline entered once, so these tests are about the three things a route gets
 * for free and a job has to do itself: validate the body, build the answer from the emit
 * step's fields, and say in its exit status whether the run produced an answer. A fourth
 * property is peculiar to a job -- the platform may name which pipeline to run -- and it
 * only exists when more than one pipeline is deployed.
 *
 * The emitted module is compiled by the generated project's own gates (`ruff`, `mypy`
 * strict), which is why the assertions here name behaviour rather than bytes.
 */

import { describe, expect, it } from 'vitest';

import { BATCH_PATH } from '../src/emit/batch.js';
import { emitRequests, REQUESTS_PATH } from '../src/emit/pipelines.js';
import { buildForSpecText, examplePlan, exampleSpecText } from './helpers.js';

/** The smallest spec that deploys one pipeline as a job. No guardrail, so nothing refuses. */
const BASE_SPEC = `specVersion: "0.5"

project:
  name: nightly
  namespace: aid.test.nightly
  targets: [py-fastapi]

types:
  Reply:
    kind: struct
    fields:
      summary:
        type: string
        required: true

models:
  fast:
    provider: fake
    modelId: fake-deterministic-1
    capabilities: [json-schema]

prompts:
  draft:
    version: 1
    model: fast
    template: |
      Summarise this ticket: {{ subject }}
    variables:
      subject:
        type: string
        required: true
    output:
      kind: structured
      schema: Reply

pipelines:
  brief:
    description: Summarise one ticket.
    trigger:
      manual: true
    steps:
      - generate:
          prompt: draft
          input:
            subject: "{{ event.subject }}"
          as: brief
      - emit:
          event: Reply

deployments:
  nightly:
    target: batch
    pipeline: brief
    secrets: []
`;

/** The base spec with a second job over a second pipeline. */
const TWO_JOBS_SPEC = `${BASE_SPEC.replace(
  'deployments:\n',
  `  digest:
    description: Summarise a whole day.
    trigger:
      manual: true
    steps:
      - generate:
          prompt: draft
          input:
            subject: "{{ event.subject }}"
          as: digest
      - emit:
          event: Reply

deployments:
`,
)}  weekly:
    target: batch
    pipeline: digest
    secrets: []
`;

/**
 * The example, retriggered: its own rich pipeline, entered as a job instead of as a route.
 * It is also the one fixture here that declares guardrails.
 */
function specWithGuardedJob(): string {
  return exampleSpecText()
    .replace('specVersion: "0.2"', 'specVersion: "0.5"')
    .replace(
      '    trigger:\n      http:\n        method: post\n        path: /tickets/answer',
      '    trigger:\n      manual: true',
    )
    .replace(
      '    target: container\n    streaming: true',
      '    target: batch\n    pipeline: answer_ticket',
    );
}

function batchFor(specText: string): string {
  return (
    buildForSpecText(specText, 'app.spec.yaml').plan.files.find((file) => file.path === BATCH_PATH)
      ?.content ?? ''
  );
}

describe('a spec that deploys no job', () => {
  it('plans no batch entrypoint, because nothing would run it', () => {
    expect(examplePlan().files.map((file) => file.path)).not.toContain(BATCH_PATH);
  });
});

describe('a spec that deploys one job', () => {
  it('plans the entrypoint as a generated file', () => {
    const { plan } = buildForSpecText(BASE_SPEC, 'app.spec.yaml');
    const entrypoint = plan.files.find((file) => file.path === BATCH_PATH);

    expect(entrypoint?.owner).toBe('generated');
  });

  it('validates stdin into the pipeline request model and prints the emit fields', () => {
    const content = batchFor(BASE_SPEC);

    expect(content).toContain('async def run_brief(deps: Deps, payload: object) -> str:');
    expect(content).toContain('event = BriefRequest.model_validate(payload)');
    // The same expression the route returns, so the job's JSON is the route's body.
    expect(content).toContain('summary=context.require("brief").summary');
  });

  it('runs the only pipeline when the platform names none', () => {
    const content = batchFor(BASE_SPEC);

    expect(content).toContain('PIPELINES = ("brief",)');
    expect(content).toContain('name = args.pipeline or PIPELINES[0]');
  });

  it('has no refusal to report when no guardrail can refuse', () => {
    const content = batchFor(BASE_SPEC);

    expect(content).not.toContain('EXIT_REFUSED');
    expect(content).not.toContain('guardrail_block');
    expect(content).not.toContain('guardrails');
  });

  it('describes the request model as the job input, not as a route body', () => {
    const { ir } = buildForSpecText(BASE_SPEC, 'app.spec.yaml');
    const requests = emitRequests(ir).content;

    expect(emitRequests(ir).path).toBe(REQUESTS_PATH);
    expect(requests).toContain('read from stdin by the `batch` job that runs it');
    expect(requests).not.toContain('The request body of');
  });

  it('is plain LF text with one trailing newline and no tabs', () => {
    const content = batchFor(BASE_SPEC);

    expect(content).not.toContain('\r');
    expect(content).not.toContain('\t');
    expect(content.endsWith('\n')).toBe(true);
    expect(content.endsWith('\n\n')).toBe(false);
  });

  it('is byte-identical on a second plan', () => {
    const { ir } = buildForSpecText(BASE_SPEC, 'app.spec.yaml');
    expect(batchFor(BASE_SPEC)).toBe(batchFor(BASE_SPEC));
    expect(ir.deployments[0]?.pipeline).toBe('brief');
  });
});

describe('a spec that deploys several jobs', () => {
  it('names each pipeline once, in declared order', () => {
    expect(batchFor(TWO_JOBS_SPEC)).toContain('PIPELINES = ("brief", "digest")');
  });

  it('refuses to guess which pipeline to run', () => {
    const content = batchFor(TWO_JOBS_SPEC);

    expect(content).toContain('name = args.pipeline');
    expect(content).toContain('if name is None:');
    expect(content).toContain('this build deploys several pipelines; name the one to run');
    expect(content).not.toContain('or PIPELINES[0]');
  });

  it('keeps the runners map keyed by the same names', () => {
    const content = batchFor(TWO_JOBS_SPEC);

    expect(content).toMatch(/"brief": run_brief,/);
    expect(content).toMatch(/"digest": run_digest,/);
  });
});

describe('a job over a guarded pipeline', () => {
  it('digs the refusal out of the failure and exits 2', () => {
    const content = batchFor(specWithGuardedJob());

    expect(content).toContain('EXIT_REFUSED = 2');
    expect(content).toContain('from .guardrails import guardrail_block');
    expect(content).toContain('refused = guardrail_block(exc)');
    expect(content).toContain('if refused is not None:');
    expect(content).toContain('return EXIT_REFUSED');
  });

  it('keeps the request and response shapes the route uses', () => {
    const content = batchFor(specWithGuardedJob());

    expect(content).toContain('event = AnswerTicketRequest.model_validate(payload)');
    expect(content).toContain('category=context.require("answer").category');
    expect(content).toContain('PIPELINES = ("answer_ticket",)');
  });
});
