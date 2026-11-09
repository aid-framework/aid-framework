/**
 * A guardrail answered by a decision, as the TypeScript target states it.
 *
 * The cases read the planned modules because that is what ships: a keyword that moved
 * between the emitter and the runtime would pass an emitter unit test and leave the
 * generated app asking nothing. The refusals go through `checkPlan`, so each one is this
 * package's refusal rather than the spec layer's.
 */

import type { Plan } from '@aid-framework/generator-sdk';
import type { IR } from '@aid-framework/ir';
import { describe, expect, it } from 'vitest';

import { checkPlan } from '../src/validate.js';
import { buildForSpecText, exampleSpecText, fileMap, irForSpecText } from './helpers.js';

/** The example spec, bumped to the version that wires a guardrail to a decision. */
function specText(guardrails: string): string {
  const text = exampleSpecText().replace('specVersion: "0.2"', 'specVersion: "0.7"');
  const start = text.indexOf('guardrails:');
  const end = text.indexOf('memory:');
  const decisions = `decisions:
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

`;
  return `${text.slice(0, start)}${decisions}${guardrails}\n${text.slice(end)}`;
}

const DECIDING = `guardrails:
  inbound:
    stages: [input, output]
    policies: [pii-detect]
    action: block
    onFail:
      message: The request was refused by a guardrail.
      log: true
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
`;

const POLICY_ONLY = `guardrails:
  inbound:
    stages: [input, output]
    policies: [pii-detect]
    action: block
    onFail:
      message: The request was refused by a guardrail.
      log: true
`;

const REDACTING = `guardrails:
  inbound:
    stages: [input, output]
    policies: [pii-detect]
    action: block
    onFail:
      message: The request was refused by a guardrail.
      log: true
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

/** The plan-problem codes for an IR, in order. */
function codes(ir: IR): string[] {
  return checkPlan(ir).map((problem) => problem.code);
}

/** A module from the plan, or a failure naming the path that vanished. */
function moduleAt(plan: Plan, path: string): string {
  const content = fileMap(plan.files).get(path);
  if (content === undefined) throw new Error(`the plan emitted no ${path}`);
  return content;
}

describe('a guardrail answered by a decision', () => {
  it('wires the referenced decision into the engine, in the IR order', () => {
    const { ir, plan } = buildForSpecText(specText(DECIDING));

    expect(codes(ir)).toEqual([]);
    const guardrails = moduleAt(plan, 'app/generated/guardrails.ts');
    expect(guardrails).toContain('DecisionDefinition');
    expect(guardrails).toContain(
      'export const DECISIONS: ReadonlyMap<string, DecisionDefinition> = new Map([',
    );
    expect(guardrails).toContain("id: 'topical'");
    expect(guardrails).toContain("model: 'jev-1.14.0'");
    expect(guardrails).toContain("criteria: ['off_topic', 'product']");
    expect(guardrails).toContain("decision: 'topical'");
    expect(guardrails).toContain("'off_topic': 'block'");
    expect(guardrails).toContain('minConfidence: 0.6');
    expect(guardrails).toContain(
      'export const ENGINE = new GuardrailEngine(BY_ID, { decisions: DECISIONS });',
    );
  });

  it('does not copy a decision nothing asks into the wiring', () => {
    const { plan } = buildForSpecText(specText(DECIDING));

    expect(moduleAt(plan, 'app/generated/guardrails.ts')).not.toContain("id: 'unused'");
  });

  it('asks the asynchronous engine from the pipeline, so the decision is not skipped', () => {
    const { plan } = buildForSpecText(specText(DECIDING));
    const pipeline = moduleAt(plan, 'app/generated/pipelines/answer_ticket.ts');

    expect(pipeline).toContain('await ENGINE.checkInputAsync(INPUT_GUARDRAILS');
    expect(pipeline).not.toContain('ENGINE.checkInput(INPUT_GUARDRAILS');
  });

  it('keeps the synchronous path when the guardrail is policy-only', () => {
    const { plan } = buildForSpecText(specText(POLICY_ONLY));
    const guardrails = moduleAt(plan, 'app/generated/guardrails.ts');
    const pipeline = moduleAt(plan, 'app/generated/pipelines/answer_ticket.ts');

    expect(guardrails).toContain('export const ENGINE = new GuardrailEngine(BY_ID);');
    expect(guardrails).not.toContain('DecisionDefinition');
    expect(pipeline).toContain('ENGINE.checkInput(INPUT_GUARDRAILS');
    expect(pipeline).not.toContain('checkInputAsync');
  });
});

describe('what the TypeScript target refuses about a decision guardrail', () => {
  it('refuses a guard step, whose check is synchronous', () => {
    const ir = irForSpecText(specText(DECIDING));
    const pipeline = ir.pipelines.find((candidate) => candidate.id === 'answer_ticket');
    if (pipeline === undefined) throw new Error('the spec declared no answer_ticket pipeline');
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

    expect(codes(guarded)).toContain('guardrail-unsupported');
  });

  it('refuses redact, because a decision returns a verdict rather than a masked payload', () => {
    const problems = checkPlan(irForSpecText(specText(REDACTING)));

    expect(problems.map((problem) => problem.code)).toContain('guardrail-unsupported');
    expect(problems.map((problem) => problem.message).join('\n')).toContain('nothing to rewrite');
  });
});
