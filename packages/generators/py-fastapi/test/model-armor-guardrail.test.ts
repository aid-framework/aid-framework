/**
 * A guardrail evaluated by Vertex AI Model Armor, as the Python target states it.
 *
 * The template is operator-owned, so the declaration carries no policy at all: the
 * module must name the engine, read `MODEL_ARMOR_TEMPLATE` once at import, and build a
 * `ModelArmorGuardrailClient`. The absence of the Bedrock policy class is asserted too,
 * because a stray `BedrockGuardrailPolicy(...)` would read `BEDROCK_GUARDRAIL_ID` and
 * fail the deployment that named a Model Armor template instead.
 */

import { describe, expect, it } from 'vitest';

import { checkPlan } from '../src/validate.js';
import { buildForSpecText, fileMap } from './helpers.js';

const BASE_SPEC = `specVersion: "0.14"

project:
  name: armor
  namespace: aid.test.armor
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
    engine: model-armor
    action: block
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

/** The whole planned tree, as a path-to-text map. */
function moduleAt(plan: { files: Parameters<typeof fileMap>[0] }, path: string): string {
  const content = fileMap(plan.files).get(path);
  if (content === undefined) throw new Error(`the plan emitted no ${path}`);
  return content;
}

describe('a guardrail evaluated by Model Armor', () => {
  it('names the engine and the template wiring, and no Bedrock policy', () => {
    const { ir, plan } = buildForSpecText(BASE_SPEC);

    expect(checkPlan(ir).map((problem) => problem.code)).toEqual([]);
    const guardrails = moduleAt(plan, 'app/generated/guardrails.py');
    expect(guardrails).toContain('engine="model-armor"');
    expect(guardrails).toContain('ModelArmorGuardrailClient,');
    expect(guardrails).toContain('model_armor_settings,');
    expect(guardrails).toContain('_MODEL_ARMOR_SETTINGS = model_armor_settings()');
    expect(guardrails).toContain(
      'guardrail_client_factory=lambda: ModelArmorGuardrailClient(settings=_MODEL_ARMOR_SETTINGS),',
    );
    expect(guardrails).not.toContain('BedrockGuardrailPolicy');
    expect(guardrails).not.toContain('_MANAGED_SETTINGS');
    expect(guardrails).not.toContain('bedrock=');
  });

  it('awaits the managed check at both stages of the generate route', () => {
    const { plan } = buildForSpecText(BASE_SPEC);
    const pipeline = moduleAt(plan, 'app/generated/pipelines/handle.py');

    expect(pipeline).toContain('check_input_async(INPUT_GUARDRAILS, _rendered.text)');
    expect(pipeline).toContain('check_output_async(OUTPUT_GUARDRAILS, _response.text)');
    expect(pipeline).not.toContain('ENGINE.check_input(INPUT_GUARDRAILS');
    expect(pipeline).not.toContain('ENGINE.check_output(OUTPUT_GUARDRAILS');
  });
});
