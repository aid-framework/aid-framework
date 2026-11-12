/**
 * The `evals/metrics` gate -- whether a declared trajectory metric can ever fail.
 *
 * A ceiling at or above the agent's own `maxSteps` is reached by the budget first, so the
 * metric can only ever report what the agent's bound already did. An `approval-respected`
 * metric on an agent that can never pause has either no decision to score or a decision
 * that was never asked for. Both are answerable from the IR alone, and both are refused
 * rather than emitted as a check that always passes.
 *
 * The gate is separate from `evals/trajectory` on purpose: that one asks whether the
 * *target* can report a trajectory, this one asks whether the *metric* has anything to
 * score on a target that reports them perfectly well. A spec can fail either without
 * failing the other, so the tests below pin both directions.
 *
 * Every assertion reads `byGate` rather than the merged diagnostics: the fixture is a
 * minimal document, and unrelated gates legitimately object to it (it declares no target
 * capabilities, for one). Asserting on the whole report would make this file break
 * whenever any other gate tightened.
 */

import { buildIR, type IrDiagnostic, runGates } from '@aid-framework/ir';
import { checkSpecText } from '@aid-framework/spec';
import { describe, expect, it } from 'vitest';

import { codesOf, fixtureText } from './helpers.js';

function gateNamed(text: string, gate: 'evals/metrics' | 'evals/trajectory'): IrDiagnostic[] {
  const checked = checkSpecText(text, { file: 'eval-metrics.yaml' });
  if (!checked.ok) {
    throw new Error(checked.diagnostics.map((diagnostic) => diagnostic.code).join(', '));
  }
  const built = buildIR(checked.value, { file: 'eval-metrics.yaml' });
  if (built.diagnostics.length > 0) {
    throw new Error(built.diagnostics.map((diagnostic) => diagnostic.code).join(', '));
  }
  return runGates(built.ir, {}).byGate[gate].diagnostics;
}

const metricsGate = (text: string) => gateNamed(text, 'evals/metrics');
const trajectoryGate = (text: string) => gateNamed(text, 'evals/trajectory');
const REMOVE_HITL = `    humanInTheLoop:\n      when: hasRole("support_agent")\n      channel: slack\n`;

describe('a trajectory metric that can fail', () => {
  it('is accepted with no diagnostic from the metric gate', () => {
    expect(metricsGate(fixtureText('eval-metrics.yaml'))).toEqual([]);
  });

  it('carries all three metrics into the IR', () => {
    const checked = checkSpecText(fixtureText('eval-metrics.yaml'), { file: 'x.yaml' });
    if (!checked.ok) throw new Error('fixture must parse');
    const evaluation = buildIR(checked.value, { file: 'x.yaml' }).ir.evals.find(
      (candidate) => candidate.id === 'trajectory_shape',
    );
    expect(evaluation?.metrics.map((metric) => metric.kind)).toEqual([
      'step-count',
      'forbidden-tool',
      'approval-respected',
    ]);
  });

  it('carries the declared numbers and names verbatim', () => {
    const checked = checkSpecText(fixtureText('eval-metrics.yaml'), { file: 'x.yaml' });
    if (!checked.ok) throw new Error('fixture must parse');
    const evaluation = buildIR(checked.value, { file: 'x.yaml' }).ir.evals.find(
      (candidate) => candidate.id === 'trajectory_shape',
    );
    const stepCount = evaluation?.metrics.find((metric) => metric.kind === 'step-count');
    const forbidden = evaluation?.metrics.find((metric) => metric.kind === 'forbidden-tool');
    if (stepCount?.kind !== 'step-count') throw new Error('no step-count metric');
    if (forbidden?.kind !== 'forbidden-tool') throw new Error('no forbidden-tool metric');
    // The ceiling is a count of model calls, so a coerced or defaulted number here would
    // silently loosen a gate the author wrote precisely.
    expect(stepCount.maxSteps).toBe(2);
    expect(forbidden.forbid).toEqual(['fetch_order']);
  });
});

describe('a step ceiling the budget reaches first', () => {
  it('is refused when it equals the agent maxSteps', () => {
    expect(
      codesOf(metricsGate(fixtureText('eval-metrics.yaml').replace('maxSteps: 2', 'maxSteps: 4'))),
    ).toEqual(['ir/eval-metric-vacuous']);
  });

  it('is refused when it exceeds the agent maxSteps', () => {
    expect(
      codesOf(metricsGate(fixtureText('eval-metrics.yaml').replace('maxSteps: 2', 'maxSteps: 9'))),
    ).toEqual(['ir/eval-metric-vacuous']);
  });

  it('names both numbers and the one to change', () => {
    const [diagnostic] = metricsGate(
      fixtureText('eval-metrics.yaml').replace('maxSteps: 2', 'maxSteps: 4'),
    );
    // A refusal that does not say what to change, and to which number, is a wall rather
    // than a gate.
    expect(diagnostic?.message).toContain('allows 4 steps');
    expect(diagnostic?.message).toContain('maxSteps is 4');
    expect(diagnostic?.hint).toContain('below 4');
  });

  it('points at the metric, not at the agent', () => {
    const [diagnostic] = metricsGate(
      fixtureText('eval-metrics.yaml').replace('maxSteps: 2', 'maxSteps: 4'),
    );
    expect(diagnostic?.path).toEqual(['evals', 'trajectory_shape', 'metrics', 0, 'maxSteps']);
  });
});

describe('approval-respected on an agent that cannot pause', () => {
  it('is refused when nothing can ask for approval', () => {
    expect(codesOf(metricsGate(fixtureText('eval-metrics.yaml').replace(REMOVE_HITL, '')))).toEqual(
      ['ir/eval-metric-vacuous'],
    );
  });

  it('says which two declarations would make it reachable', () => {
    const [diagnostic] = metricsGate(fixtureText('eval-metrics.yaml').replace(REMOVE_HITL, ''));
    expect(diagnostic?.message).toContain('no humanInTheLoop policy');
    expect(diagnostic?.hint).toContain('requiresConfirmation');
  });

  it('is accepted while the agent declares humanInTheLoop', () => {
    // The base fixture declares it, so this pins that the gate reads the policy rather than
    // refusing every approval metric that has no tool-level confirmation.
    expect(codesOf(metricsGate(fixtureText('eval-metrics.yaml')))).not.toContain(
      'ir/eval-metric-vacuous',
    );
  });
});

describe('a trajectory metric on a target that cannot report one', () => {
  const pipelineTarget = `${fixtureText('eval-metrics.yaml').replace(
    'target: agent:support',
    'target: pipeline:handle_ticket',
  )}
pipelines:
  handle_ticket:
    trigger:
      http:
        method: get
        path: /tickets
    steps:
      - emit:
          event: Order
`;

  it('is refused per metric by the trajectory gate', () => {
    // Three metrics across three kinds, each refused on its own: a reader is told every
    // metric that cannot be measured, not just the first.
    expect(
      codesOf(trajectoryGate(pipelineTarget)).filter((code) => code === 'ir/eval-trajectory'),
    ).toHaveLength(3);
  });

  it('is not the metric gate to say so', () => {
    // The two gates answer different questions, and a spec that fails one should not
    // produce a duplicate explanation from the other.
    expect(codesOf(metricsGate(pipelineTarget))).toEqual([]);
  });

  it('is a version error below spec 0.31, not an IR one', () => {
    // The kinds are additive to the language, so an older document that declares one is
    // refused at parse time with a version diagnostic -- the upgrade path is a version
    // bump, not a hunt through IR errors.
    const checked = checkSpecText(
      fixtureText('eval-metrics.yaml').replace('specVersion: "0.31"', 'specVersion: "0.30"'),
      { file: 'eval-metrics.yaml' },
    );
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(codesOf(checked.diagnostics)).toContain('spec/not-supported');
  });
});
