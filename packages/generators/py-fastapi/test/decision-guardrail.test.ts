/**
 * A guardrail answered by a decision, as the Python target states it.
 *
 * The cases read the planned modules because that is what ships: a keyword that moved
 * between the emitter and the runtime would pass an emitter unit test and leave the
 * generated app asking nothing. The refusals go through `checkPlan`, so each one is
 * this package's refusal rather than the spec layer's.
 */

import type { IR } from '@aid-framework/ir';
import { describe, expect, it } from 'vitest';

import { checkPlan } from '../src/validate.js';
import { buildForSpecText, fileMap, lowerForSpecText } from './helpers.js';

const BASE_SPEC = `specVersion: "0.7"

project:
  name: decisions
  namespace: aid.test.decisions
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

decisions:
  topical:
    provider: typesafe
    model: jev-1.14.0
    type: choice
    instructions: Is this message about our product
    criteria:
      product: A question about features
      off_topic: Anything unrelated
  unused:
    provider: typesafe
    model: jev-1.14.0
    type: noul
    instructions: Is this message urgent

guardrails:
  relevance:
    stages: [input]
    decision: topical
    onDecision:
      product: allow
      off_topic: block
    minConfidence: 0.6
    onFail:
      message: This request is outside the assistant's scope.
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

/** The guardrail block replaced, with everything above it unchanged. */
function withGuardrail(guardrails: string): string {
  const start = BASE_SPEC.indexOf('guardrails:');
  const end = BASE_SPEC.indexOf('pipelines:');
  return `${BASE_SPEC.slice(0, start)}${guardrails}\n${BASE_SPEC.slice(end)}`;
}

const REDACTING = `guardrails:
  relevance:
    stages: [input]
    policies: [pii-detect]
    action: redact
    redact: [text]
    decision: topical
    onDecision:
      product: allow
      off_topic: block
    onFail:
      message: This request is outside the assistant's scope.
      log: true
`;

const POLICY_ONLY = `guardrails:
  relevance:
    stages: [input]
    policies: [pii-detect]
    action: flag
    onFail:
      message: The screen recorded this payload.
      log: true
`;

/** The plan-problem codes for an IR, in order. */
function codes(ir: IR): string[] {
  return checkPlan(ir).map((problem) => problem.code);
}

/** A module from the plan, or a failure naming the path that vanished. */
function moduleAt(plan: { files: Parameters<typeof fileMap>[0] }, path: string): string {
  const content = fileMap(plan.files).get(path);
  if (content === undefined) throw new Error(`the plan emitted no ${path}`);
  return content;
}

describe('a guardrail answered by a decision', () => {
  it('wires the referenced decision into the engine, in the IR order', () => {
    const { ir, plan } = buildForSpecText(BASE_SPEC);

    expect(codes(ir)).toEqual([]);
    const guardrails = moduleAt(plan, 'app/generated/guardrails.py');
    expect(guardrails).toContain('DecisionDefinition');
    expect(guardrails).toContain('DECISIONS: dict[str, DecisionDefinition] = {');
    expect(guardrails).toContain('"topical": DecisionDefinition(');
    expect(guardrails).toContain('model="jev-1.14.0"');
    expect(guardrails).toContain('criteria=("off_topic", "product")');
    expect(guardrails).toContain('decision="topical"');
    expect(guardrails).toContain('on_decision=(("off_topic", "block"), ("product", "allow"))');
    expect(guardrails).toContain('min_confidence=0.6');
    expect(guardrails).toContain('ENGINE = GuardrailEngine(decisions=DECISIONS)');
  });

  it('does not copy a decision nothing asks into the wiring', () => {
    const { plan } = buildForSpecText(BASE_SPEC);

    expect(moduleAt(plan, 'app/generated/guardrails.py')).not.toContain('"unused"');
  });

  it('asks the asynchronous engine from the pipeline, so the decision is not skipped', () => {
    const { plan } = buildForSpecText(BASE_SPEC);
    const pipeline = moduleAt(plan, 'app/generated/pipelines/handle.py');

    expect(pipeline).toContain('enforce_guardrail(await ENGINE.check_input_async(INPUT_GUARDRAILS');
    expect(pipeline).not.toContain('enforce_guardrail(ENGINE.check_input(');
  });

  it('keeps the synchronous path when the guardrail is policy-only', () => {
    const { plan } = buildForSpecText(withGuardrail(POLICY_ONLY));
    const guardrails = moduleAt(plan, 'app/generated/guardrails.py');
    const pipeline = moduleAt(plan, 'app/generated/pipelines/handle.py');

    expect(guardrails).toContain('ENGINE = GuardrailEngine()');
    expect(guardrails).not.toContain('DecisionDefinition');
    expect(pipeline).toContain('enforce_guardrail(ENGINE.check_input(INPUT_GUARDRAILS');
    expect(pipeline).not.toContain('check_input_async');
  });
});

describe('what the Python target refuses about a decision guardrail', () => {
  it('refuses a guard step, whose check is synchronous', () => {
    const { ir } = buildForSpecText(BASE_SPEC);
    const [pipeline] = ir.pipelines;
    if (pipeline === undefined) throw new Error('the spec declared no pipeline');
    const guarded: IR = {
      ...ir,
      pipelines: [
        {
          ...pipeline,
          steps: [
            { kind: 'guard', guardrail: 'relevance', stage: 'input', text: '{{ event.subject }}' },
            ...pipeline.steps,
          ],
        },
      ],
    };

    expect(codes(guarded)).toContain('unsupported-guardrail');
  });

  it('refuses redact, because a decision returns a verdict rather than a masked payload', () => {
    const problems = checkPlan(lowerForSpecText(withGuardrail(REDACTING)));

    expect(problems.map((problem) => problem.code)).toContain('unsupported-guardrail');
    expect(problems.map((problem) => problem.message).join('\n')).toContain('nothing to rewrite');
  });
});
