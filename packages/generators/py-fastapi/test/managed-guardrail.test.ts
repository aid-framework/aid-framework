/**
 * A guardrail evaluated by a managed service, as the Python target states it.
 *
 * The managed engine reaches the service over HTTP, so every call site has to await it:
 * a synchronous `check_input` would skip the round trip and pass the payload on. The
 * cases below read the planned modules for exactly that, and for the wiring that makes a
 * missing resource id fail at import rather than at the first request that needs a check.
 */

import { describe, expect, it } from 'vitest';

import { checkPlan } from '../src/validate.js';
import { buildForSpecText, fileMap } from './helpers.js';

const BASE_SPEC = `specVersion: "0.11"

project:
  name: managed
  namespace: aid.test.managed
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
  ask:
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
  personal:
    stages: [input, output]
    engine: bedrock
    action: redact
    bedrock:
      pii: [email, phone]
    onFail:
      message: The payload could not be screened.
      log: true

pipelines:
  handle:
    description: Summarise a ticket.
    trigger:
      http:
        method: post
        path: /handle
    steps:
      - generate:
          prompt: ask
          input:
            subject: "{{ event.subject }}"
          as: answer
      - emit:
          event: Reply
`;

/** The pipeline block replaced, with everything above it unchanged. */
function withPipeline(spec: string, pipeline: string): string {
  const start = spec.indexOf('pipelines:');
  return `${spec.slice(0, start)}${pipeline}\n`;
}

/** The same document with a blocking policy, which a guard step can carry. */
const BLOCKING = BASE_SPEC.replace(
  `    action: redact
    bedrock:
      pii: [email, phone]`,
  `    action: block
    bedrock:
      content:
        hate: high`,
);

/** A guard step in front of the generate step, so the step path is covered too. */
const GUARD_STEP = `pipelines:
  handle:
    description: Summarise a ticket.
    trigger:
      http:
        method: post
        path: /handle
    steps:
      - guard:
          guardrail: personal
          stage: input
          text: "{{ event.subject }}"
      - generate:
          prompt: ask
          input:
            subject: "{{ event.subject }}"
          as: answer
      - emit:
          event: Reply
`;

/** The whole planned tree, as a path-to-text map. */
function moduleAt(plan: { files: Parameters<typeof fileMap>[0] }, path: string): string {
  const content = fileMap(plan.files).get(path);
  if (content === undefined) throw new Error(`the plan emitted no ${path}`);
  return content;
}

describe('a guardrail evaluated by a managed service', () => {
  it('emits the policy, the engine override and the resource wiring', () => {
    const { ir, plan } = buildForSpecText(BASE_SPEC);

    expect(checkPlan(ir).map((problem) => problem.code)).toEqual([]);
    const guardrails = moduleAt(plan, 'app/generated/guardrails.py');
    expect(guardrails).toContain('BedrockGuardrailPolicy,');
    expect(guardrails).toContain('BedrockGuardrailClient,');
    expect(guardrails).toContain('managed_guardrail_settings,');
    expect(guardrails).toContain('engine="bedrock"');
    expect(guardrails).toContain('BedrockGuardrailPolicy(');
    expect(guardrails).toContain('"email"');
    expect(guardrails).toContain('"phone"');
    expect(guardrails).toContain('redact=("text",)');
    expect(guardrails).toContain('_MANAGED_SETTINGS = managed_guardrail_settings()');
    expect(guardrails).toContain('ENGINE = GuardrailEngine(');
    expect(guardrails).toContain('guardrail_client_factory=lambda: BedrockGuardrailClient(');
    expect(guardrails).toContain('settings=_MANAGED_SETTINGS),');
  });

  it('awaits the managed check at both stages of the generate route', () => {
    const { plan } = buildForSpecText(BASE_SPEC);
    const pipeline = moduleAt(plan, 'app/generated/pipelines/handle.py');

    expect(pipeline).toContain('check_input_async(INPUT_GUARDRAILS, _rendered.text)');
    expect(pipeline).toContain('check_output_async(OUTPUT_GUARDRAILS, _response.text)');
    expect(pipeline).toContain('await');
    expect(pipeline).not.toContain('ENGINE.check_input(INPUT_GUARDRAILS');
    expect(pipeline).not.toContain('ENGINE.check_output(OUTPUT_GUARDRAILS');
  });

  it('awaits a guard step, whose emission is otherwise synchronous', () => {
    const { plan } = buildForSpecText(withPipeline(BLOCKING, GUARD_STEP));
    const pipeline = moduleAt(plan, 'app/generated/pipelines/handle.py');

    expect(pipeline).toContain('await ENGINE.check_input_async(');
    expect(pipeline).not.toContain('ENGINE.check_input(');
  });

  it('declares the redaction the runtime performs, not the policy that implies it', () => {
    const { plan } = buildForSpecText(BASE_SPEC);
    const guardrails = moduleAt(plan, 'app/generated/guardrails.py');

    expect(guardrails).toContain('pii=("email", "phone")');
    expect(guardrails).toContain('redact=("text",)');
  });
});
