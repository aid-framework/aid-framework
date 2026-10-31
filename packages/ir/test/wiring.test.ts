/**
 * The three wiring step kinds end to end at layer 1: spec acceptance, the IR shape each
 * one occupies, and the references the gate refuses. All three are leaves that point at
 * something already declared -- a retrieval binding, a guardrail, an agent -- so what the
 * gate owes them is resolution, not recursion.
 */

import { checkSpecText } from '@aid-framework/spec';
import { describe, expect, it } from 'vitest';

import {
  type AgentStep,
  COMPOSITE_STEP_KINDS,
  type GuardStep,
  IR_DIAGNOSTIC_CODES,
  isCompositeStep,
  type RerankStep,
  runGates,
  type StepShape,
} from '../src/index.js';
import { buildFixture, byId, codesOf, diagnosticAt, fixtureText, mutateIR } from './helpers.js';

const SPEC = 'wiring.yaml';

/**
 * A target that genuinely serves all three wiring kinds. Declaring the capabilities is
 * what makes the gate's silence mean something: with a partial declaration the positive
 * case would pass for the wrong reason.
 */
const FULL_TARGET = {
  'py-fastapi': [
    'http-trigger',
    'json-schema',
    'otel',
    'tool-calling',
    'embeddings',
    'rerank',
    'guardrails',
    'agents',
  ],
};

/** The one step of `kind`, or a failure naming the kinds that were present. */
function stepOf(steps: readonly StepShape[], kind: StepShape['kind']): StepShape {
  const found = steps.find((step) => step.kind === kind);
  if (found === undefined) {
    throw new Error(`no ${kind} step, only [${steps.map((step) => step.kind).join(', ')}]`);
  }
  return found;
}

describe('wiring surface, spec to IR to gates', () => {
  it('accepts the wiring spec at the spec layer', () => {
    const checked = checkSpecText(fixtureText(SPEC), { file: SPEC });

    expect(checked.ok).toBe(true);
    expect(checked.diagnostics).toEqual([]);
  });

  it('builds a rerank that names both operands', () => {
    const { ir } = buildFixture(SPEC);
    const step = stepOf(byId(ir.pipelines, 'answer_question').steps, 'rerank') as RerankStep;

    // The runtime's interface is `rerank(query, items, *, top_n)`, so the design's single
    // `input` could not have supplied both halves.
    expect(step).toEqual({
      kind: 'rerank',
      over: 'passages',
      query: '{{event.question}}',
      model: 'lexical',
      topN: 3,
      as: 'context',
    });
  });

  it('builds a guard that binds nothing', () => {
    const { ir } = buildFixture(SPEC);
    const steps = byId(ir.pipelines, 'answer_question').steps;
    const guards = steps.filter((step) => step.kind === 'guard') as GuardStep[];

    expect(guards.map((guard) => [guard.guardrail, guard.stage])).toEqual([
      ['request_pii', 'input'],
      ['passage_pii', 'retrieval'],
      ['answer_pii', 'output'],
    ]);
    // A guard's two changing actions are refused, so `flag` observes and nothing is
    // written back: no name escapes it, and no downstream step can read one.
    expect(guards.every((guard) => !('as' in guard))).toBe(true);
  });

  it('builds an agent step whose text is the user turn', () => {
    const { ir } = buildFixture(SPEC);
    const step = stepOf(byId(ir.pipelines, 'answer_question').steps, 'agent') as AgentStep;

    expect(step).toEqual({
      kind: 'agent',
      agent: 'triage_agent',
      text: '{{ answer.text }}',
      as: 'triage',
    });
  });

  it('passes every gate for a target that serves all three kinds', () => {
    // The positive half: the three refusals below are only evidence of a gate that reads
    // the references if the same fixture is silent when the target declares the
    // capabilities and the references resolve.
    const { ir } = buildFixture(SPEC);
    const result = runGates(ir, { targetCapabilities: FULL_TARGET });

    expect(codesOf(result.diagnostics)).toEqual([]);
  });

  it('treats all three as leaves rather than composites', () => {
    // `COMPOSITE_STEP_KINDS` bounds recursion, and every one of these has no body to
    // recurse into. The pinned list is what makes adding one a visible change.
    expect(COMPOSITE_STEP_KINDS).toEqual(['branch', 'parallel', 'map', 'reduce']);

    const { ir } = buildFixture(SPEC);
    const steps = byId(ir.pipelines, 'answer_question').steps;
    for (const kind of ['rerank', 'guard', 'agent'] as const) {
      expect(isCompositeStep(stepOf(steps, kind))).toBe(false);
    }
  });
});

describe('wiring references the gate refuses', () => {
  const PIPELINE = 0;

  it('rejects a rerank whose over names no binding', () => {
    const ir = mutateIR(SPEC);
    const pipeline = ir.pipelines[PIPELINE];
    if (pipeline === undefined) throw new Error('fixture has no pipeline');
    const step = pipeline.steps[2];
    if (step?.kind !== 'rerank') throw new Error('the third step is not a rerank');
    step.over = 'nowhere';

    const result = runGates(ir);

    expect(codesOf(result.diagnostics)).toContain(IR_DIAGNOSTIC_CODES.refUnresolved);
    expect(
      diagnosticAt(result.diagnostics, 'pipelines.answer_question.steps.2.rerank.over').message,
    ).toContain('no retrieved items to reorder');
  });

  it('rejects a guard naming an undeclared guardrail', () => {
    const ir = mutateIR(SPEC);
    const pipeline = ir.pipelines[PIPELINE];
    if (pipeline === undefined) throw new Error('fixture has no pipeline');
    const step = pipeline.steps[3];
    if (step?.kind !== 'guard') throw new Error('the fourth step is not a guard');
    step.guardrail = 'undeclared';

    const result = runGates(ir);

    expect(
      diagnosticAt(result.diagnostics, 'pipelines.answer_question.steps.3.guardrail').message,
    ).toContain('undeclared');
  });

  it('rejects an agent step naming an undeclared agent', () => {
    const ir = mutateIR(SPEC);
    const pipeline = ir.pipelines[PIPELINE];
    if (pipeline === undefined) throw new Error('fixture has no pipeline');
    const step = pipeline.steps[6];
    if (step?.kind !== 'agent') throw new Error('the seventh step is not an agent');
    step.agent = 'undeclared';

    const result = runGates(ir);

    expect(
      diagnosticAt(result.diagnostics, 'pipelines.answer_question.steps.6.agent').message,
    ).toContain('undeclared');
  });
});
