/**
 * An eval metric answered by a `score` decision, as the Python target states it.
 *
 * The cases read the planned modules because that is what ships: a constant or import that
 * drifted between the emitter and the runtime would pass an emitter unit test and leave the
 * generated eval unable to ask. The refusals go through `checkPlan`, so each one is this
 * package's refusal rather than the spec layer's.
 */

import type { IR } from '@aid-framework/ir';
import { describe, expect, it } from 'vitest';

import { checkPlan } from '../src/validate.js';
import { buildForSpecText, fileMap } from './helpers.js';

const BASE_SPEC = `specVersion: "0.8"

project:
  name: scored
  namespace: aid.test.scored
  targets: [py-fastapi]

models:
  fast:
    provider: fake
    modelId: fake-deterministic-1

types:
  Answer:
    kind: struct
    fields:
      text:
        type: string
        required: true

guardrails:
  screening:
    stages: [input]
    policies: [pii-detect]
    action: flag
    onFail:
      message: The screen recorded this payload.
      log: true

prompts:
  ask:
    version: 1
    model: fast
    template: |
      Answer this ticket: {{ subject }}
    variables:
      subject:
        type: string
        required: true
    output:
      kind: text

decisions:
  helpfulness:
    provider: typesafe
    model: jev-1.14.0
    type: score
    instructions: How helpful is this answer
    criteria:
      - unusable
      - partial
      - complete

pipelines:
  handle:
    description: Answer a ticket.
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
          event: Answer
`;

/** The eval block appended last, so the metric list is the only thing a case changes. */
function withEval(evals: string): string {
  return `${BASE_SPEC}\nevals:\n${evals}`;
}

const QUALITY = `  quality:
    target: pipeline:handle
    dataset:
      source: file
      uri: evals/quality.jsonl
    metrics:
      - kind: json-schema
        schema: Answer
      - kind: decision
        decision: helpfulness
    gate:
      maxRegression: 0.05
      samples: 3
`;

const QUALITY_WITH_JUDGE = `  quality:
    target: pipeline:handle
    dataset:
      source: file
      uri: evals/quality.jsonl
    metrics:
      - kind: json-schema
        schema: Answer
      - kind: llm-judge
        rubric: The answer addresses the ticket
        model: fast
      - kind: decision
        decision: helpfulness
    gate:
      maxRegression: 0.05
      samples: 3
`;

/** The plan-problem codes for an IR, in order. */
function codes(ir: IR): string[] {
  return checkPlan(ir).map((problem) => problem.code);
}

/** The generated eval module, or a failure naming the path that vanished. */
function evalModule(plan: { files: Parameters<typeof fileMap>[0] }): string {
  const content = fileMap(plan.files).get('app/generated/evals/quality.py');
  if (content === undefined) throw new Error('the plan emitted no app/generated/evals/quality.py');
  return content;
}

describe('an eval metric answered by a score decision', () => {
  it('hoists the decision and scores the prediction with it', () => {
    const { ir, plan } = buildForSpecText(withEval(QUALITY));

    expect(codes(ir)).toEqual([]);
    const source = evalModule(plan);
    expect(source).toContain('from aid_runtime.agents import DecisionDefinition');
    expect(source).toContain('SCORE_DECISION = DecisionDefinition(');
    expect(source).toContain('id="helpfulness"');
    expect(source).toContain('model="jev-1.14.0"');
    expect(source).toContain('instructions="How helpful is this answer"');
    // The criteria are Python strings, not bare names: a tuple of identifiers would raise
    // NameError as soon as the eval imported the module.
    expect(source).toContain('criteria=("unusable", "partial", "complete")');
    expect(source).toContain('DecisionScore(SCORE_DECISION)');
    expect(source).toContain('from aid_runtime.evals import');
    expect(source).toContain('DecisionScore');
  });

  it('reports the score rather than thresholding on it', () => {
    const { plan } = buildForSpecText(withEval(QUALITY));
    const source = evalModule(plan);

    // The gate refuses a model-produced score, so the metric must not appear among the
    // thresholds -- and `metrics()` has no judge parameter, because no judge is declared.
    expect(source).not.toContain('Threshold(metric="decision"');
    expect(source).not.toContain('judge_call');
    expect(source).toContain('declared.append(DecisionScore(SCORE_DECISION))');
  });

  it('keeps the judge and the score as separate metrics', () => {
    const { ir, plan } = buildForSpecText(withEval(QUALITY_WITH_JUDGE));

    expect(codes(ir)).toEqual([]);
    const source = evalModule(plan);

    // A decision metric is model-backed too, so the judge must be selected by its
    // expression rather than by "the metric that is not deterministic".
    expect(source).toContain('def metrics(');
    expect(source).toContain('judge_call: JudgeCall | None = None');
    expect(source).toContain('declared.append(LlmJudge(judge_call, rubric=');
    expect(source).toContain('declared.append(DecisionScore(SCORE_DECISION))');
  });
});

describe('what the Python target refuses about a score decision', () => {
  /** The base IR with its single metric replaced by a hand-written one. */
  function withMetric(ir: IR, patch: Record<string, unknown>): IR {
    const [evaluation] = ir.evals;
    if (evaluation === undefined) throw new Error('the spec declared no eval');
    const metrics = [patch].map(
      (metric) => metric as unknown as IR['evals'][number]['metrics'][number],
    );
    return {
      ...ir,
      evals: [{ ...evaluation, metrics: [...evaluation.metrics.slice(0, 1), ...metrics] }],
    };
  }

  it('refuses a decision the spec does not declare', () => {
    const { ir } = buildForSpecText(withEval(QUALITY));
    const problems = checkPlan(withMetric(ir, { kind: 'decision', decision: 'absent' }));

    expect(problems.map((problem) => problem.code)).toContain('unresolved-reference');
    expect(problems.map((problem) => problem.message).join('\n')).toContain(
      "decision 'absent' is not declared",
    );
  });

  it('refuses a choice decision, whose labels have no declared order', () => {
    const { ir } = buildForSpecText(withEval(QUALITY));
    const choice: IR = {
      ...ir,
      decisions: ir.decisions.map((decision) => ({
        ...decision,
        type: 'choice',
        criteria: { a: 'A' },
      })),
    };

    expect(codes(withMetric(choice, { kind: 'decision', decision: 'helpfulness' }))).toContain(
      'unsupported-metric',
    );
  });

  it('refuses a score decision with fewer than two levels', () => {
    const { ir } = buildForSpecText(withEval(QUALITY));
    const single: IR = {
      ...ir,
      decisions: ir.decisions.map((decision) => ({ ...decision, criteria: ['only'] })),
    };

    expect(codes(withMetric(single, { kind: 'decision', decision: 'helpfulness' }))).toContain(
      'invalid-gate',
    );
  });
});
