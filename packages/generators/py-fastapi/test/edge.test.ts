/**
 * The `edge` entrypoint: `app/generated/edge.py`.
 *
 * A Lambda@Edge function is not a server. CloudFront hands it one event and takes the
 * response it returns, so this module re-creates what a route gets from FastAPI -- the
 * request model, the status codes, the response shape -- and reads its configuration from
 * Secrets Manager because the platform forbids environment variables. These tests pin
 * that contract: the same pipeline the route runs, addressed by the same method and path,
 * with the statuses the route would have answered.
 *
 * The emitted module is compiled by the generated project's own gates (`ruff`, `mypy`
 * strict), which is why the assertions here name behaviour rather than bytes.
 */

import { describe, expect, it } from 'vitest';

import { EDGE_PATH } from '../src/emit/edge.js';
import { PyFastApiPlanError } from '../src/errors.js';
import { checkPlan, type PlanProblem } from '../src/validate.js';
import { buildForSpecText } from './helpers.js';

/**
 * The smallest spec that serves one HTTP route through CloudFront.
 *
 * The route generates, so the security gate wants an input guardrail before the endpoint
 * is answerable; `intake` is that guardrail. No output guardrail, so the stream check is
 * not what refuses anything here.
 */
const BASE_SPEC = `specVersion: "0.5"

project:
  name: edge-app
  namespace: aid.test.edge
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

guardrails:
  intake:
    stages: [input]
    policies: [prompt-injection]
    action: block
    onFail:
      message: That request was refused.
      log: true

pipelines:
  brief:
    description: Summarise one ticket.
    trigger:
      http:
        method: post
        path: /brief
    steps:
      - generate:
          prompt: draft
          input:
            subject: "{{ event.subject }}"
          as: brief
      - emit:
          event: Reply

deployments:
  cdn:
    target: edge
    streaming: false
    secrets: []
`;

/** The base spec with a second route, so the handler's table has two entries. */
const TWO_ROUTES_SPEC = BASE_SPEC.replace(
  'deployments:\n',
  `  digest:
    description: Summarise a whole day.
    trigger:
      http:
        method: post
        path: /digest
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
);

/** The edge module of a build, or `undefined` when the plan does not emit one. */
function edgeModule(text: string): string | undefined {
  const build = buildForSpecText(text);
  return build.plan.files.find((file) => file.path === EDGE_PATH)?.content;
}

/** The edge module, asserting the plan emits exactly one. */
function edgeOf(text: string): string {
  const build = buildForSpecText(text);
  const files = build.plan.files.filter((file) => file.path === EDGE_PATH);
  expect(files).toHaveLength(1);
  return files[0]?.content ?? '';
}

/** The refusal codes a spec produces; a refused plan throws instead of returning one. */
function codes(text: string): readonly string[] {
  try {
    return checkPlan(buildForSpecText(text).ir).map((entry) => entry.code);
  } catch (error) {
    if (error instanceof PyFastApiPlanError) return error.codes;
    throw error;
  }
}

/** The problems a refused plan reports. */
function problems(text: string): readonly PlanProblem[] {
  try {
    buildForSpecText(text);
  } catch (error) {
    if (error instanceof PyFastApiPlanError) return error.problems;
    throw error;
  }
  throw new Error('the spec planned without a problem');
}

describe('the edge entrypoint', () => {
  it('is emitted for an edge deployment and only for one', () => {
    expect(edgeModule(BASE_SPEC)).toBeDefined();
    expect(edgeModule(BASE_SPEC.replace('target: edge', 'target: serverless'))).toBeUndefined();
  });

  it('is emitted once however many deployments point at CloudFront', () => {
    const two = `${BASE_SPEC}  eu:
    target: edge
    streaming: false
    secrets: []
`;
    expect(buildForSpecText(two).plan.files.filter((file) => file.path === EDGE_PATH)).toHaveLength(
      1,
    );
  });

  it('enters the pipeline the route enters, from the same request model', () => {
    const content = edgeOf(BASE_SPEC);
    expect(content).toContain('from .pipelines.brief import brief_pipeline');
    expect(content).toContain('from .requests import BriefRequest');
    expect(content).toContain('event = BriefRequest.model_validate(payload)');
    expect(content).toContain('context = await brief_pipeline().run(');
    expect(content).toContain('summary=context.require("brief").summary');
    expect(content).toContain('.model_dump(mode="json")');
  });

  it('addresses the pipeline by the route path and method', () => {
    const content = edgeOf(BASE_SPEC);
    expect(content).toContain('"POST": _brief,');
    expect(content).toContain('"/brief": {');
  });

  it('lists every route, grouped by path, in declared order', () => {
    const content = edgeOf(TWO_ROUTES_SPEC);
    expect(content.indexOf('"/brief"')).toBeLessThan(content.indexOf('"/digest"'));
    expect(content).toContain('"POST": _digest,');
  });

  it('answers with the statuses the route answers with', () => {
    const content = edgeOf(BASE_SPEC);
    expect(content).toContain('return "422", {"detail": json.loads(exc.json(include_url=False))}');
    expect(content).toContain('return "502", {"detail": str(exc)}');
    expect(content).toContain('return "200", Reply(');
    expect(content).toContain('return _response("404", {"detail": f"no route for {uri}"})');
    expect(content).toContain('"405", {"detail": f"{method} is not allowed for {uri}"}');
  });

  it('turns a guardrail refusal into a 400 rather than a failed step', () => {
    const content = edgeOf(BASE_SPEC);
    expect(content).toContain('from .guardrails import guardrail_block');
    expect(content).toContain('_blocked = guardrail_block(exc)');
    expect(content).toContain('return "400", {"detail": str(_blocked)}');
  });

  it('reads its configuration from a secret, since Lambda@Edge forbids variables', () => {
    const content = edgeOf(BASE_SPEC);
    expect(content).toContain('CONFIG_REGION = "us-east-1"');
    expect(content).toContain('os.environ.get("AID_EDGE_SECRET") or os.environ.get(');
    expect(content).toContain('"AWS_LAMBDA_FUNCTION_NAME"');
    expect(content).toContain('get_secret_value(SecretId=secret_id)');
    expect(content).toContain('os.environ.setdefault(name, str(value))');
  });

  it('returns a CloudFront response rather than a bare body', () => {
    const content = edgeOf(BASE_SPEC);
    expect(content).toContain('"status": status,');
    expect(content).toContain('"statusDescription": _REASONS[status],');
    expect(content).toContain('"bodyEncoding": "base64",');
    expect(content).toContain('"cache-control": [{"key": "Cache-Control", "value": "no-store"}],');
  });

  it('says that agent routes are not part of this entrypoint', () => {
    expect(edgeOf(BASE_SPEC)).toContain('Agent routes live in');
    expect(edgeOf(BASE_SPEC)).toContain('`app.main:app`');
  });

  it('is deterministic and free of transport damage', () => {
    const first = edgeOf(BASE_SPEC);
    const second = edgeOf(BASE_SPEC);
    expect(second).toBe(first);
    expect(first).not.toContain('\r');
    expect(first).not.toContain('\t');
    expect(first.endsWith('\n')).toBe(true);
    expect(first.endsWith('\n\n')).toBe(false);
  });
});

describe('the edge target refusals', () => {
  it('refuses a stream, because CloudFront returns one complete body', () => {
    const text = BASE_SPEC.replace('streaming: false', 'streaming: true');
    expect(codes(text)).toContain('unsupported-streaming');
    expect(
      problems(text).find((entry) => entry.code === 'unsupported-streaming')?.message,
    ).toContain('complete body');
  });

  it('refuses an edge deployment with no HTTP route to serve', () => {
    const text = BASE_SPEC.replace(
      `    trigger:
      http:
        method: post
        path: /brief`,
      `    trigger:
      manual: true`,
    );
    expect(codes(text)).toContain('unsupported-target');
  });

  it('accepts the base spec, so the refusals above are the only ones', () => {
    expect(codes(BASE_SPEC)).toEqual([]);
  });
});
