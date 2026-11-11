import { describe, expect, it } from 'vitest';

import { evalSubject, IR_DIAGNOSTIC_CODES, runGates } from '../../src/index.js';
import { buildFixture, codesOf, gateFixture, mutateIR, onlyDiagnosticWith } from '../helpers.js';

const OTLP = 'v27-observability.yaml';
const TRAJECTORY = 'eval-trajectory.yaml';
const LEGACY = 'full.yaml';

function exportsGate(ir: ReturnType<typeof mutateIR>) {
  return runGates(ir).byGate['observability/export'];
}

function trajectoryGate(ir: ReturnType<typeof mutateIR>) {
  return runGates(ir).byGate['evals/trajectory'];
}

describe('observability export', () => {
  it('accepts an enterprise document that exports to a collector', () => {
    expect(gateFixture(OTLP).byGate['observability/export'].diagnostics).toEqual([]);
  });

  it('reads the declared export and destination variable into the IR', () => {
    const { observability } = buildFixture(OTLP).ir;
    expect(observability.export).toBe('otlp');
    expect(observability.endpointEnv).toBe('OTEL_EXPORTER_OTLP_ENDPOINT');
  });

  it('keeps the destination on the process and off every pipeline', () => {
    // A pipeline inside the process does not ship spans, so carrying the destination
    // down would claim a decision each pipeline never made.
    const { ir } = buildFixture(OTLP);
    expect(ir.observability.export).toBe('otlp');
    for (const pipeline of ir.pipelines) {
      expect(pipeline.observability.export).toBeUndefined();
      expect(pipeline.observability.endpointEnv).toBeUndefined();
    }
  });

  it('refuses an export while tracing is switched off', () => {
    const ir = mutateIR(OTLP);
    ir.observability.trace = false;
    const diagnostic = onlyDiagnosticWith(
      exportsGate(ir).diagnostics,
      IR_DIAGNOSTIC_CODES.observabilityExport,
    );
    expect(diagnostic.path).toEqual(['observability', 'export']);
    expect(diagnostic.message).toContain('there is nothing to export');
    expect(diagnostic.hint).toContain('`export: none`');
  });

  it('refuses an enterprise deployment that exports nothing', () => {
    const ir = mutateIR(OTLP);
    ir.observability.export = 'none';
    const diagnostic = onlyDiagnosticWith(
      exportsGate(ir).diagnostics,
      IR_DIAGNOSTIC_CODES.observabilityExport,
    );
    expect(diagnostic.path).toEqual(['observability', 'export']);
    expect(diagnostic.message).toContain('promises an audit trail');
    expect(diagnostic.hint).toContain('export: otlp');
  });

  it('refuses an enterprise deployment that declares no observability section at all', () => {
    const ir = mutateIR(OTLP);
    delete ir.observability.export;
    delete ir.observability.endpointEnv;
    const diagnostic = onlyDiagnosticWith(
      exportsGate(ir).diagnostics,
      IR_DIAGNOSTIC_CODES.observabilityExport,
    );
    expect(diagnostic.message).toContain('exports nothing');
  });

  it('accepts an in-process-only export on the standard profile', () => {
    const ir = mutateIR(OTLP);
    ir.profile = 'standard';
    ir.observability.export = 'none';
    delete ir.observability.endpointEnv;
    expect(exportsGate(ir).diagnostics).toEqual([]);
  });

  it('leaves a document from before 0.27 untouched', () => {
    // No `observability` key existed to satisfy the enterprise rule with, so the gate
    // has to stay out of the way rather than fail an upgrade for a rule it invented.
    const ir = mutateIR(LEGACY);
    expect(ir.observability.export).toBeUndefined();
    expect(exportsGate(ir).diagnostics).toEqual([]);
  });

  it('skips the enterprise rule on a document from before 0.27', () => {
    // A 0.26 document has no `observability` section to satisfy the rule with, so
    // demanding one would make the upgrade unsatisfiable. Moving to 0.27 is what turns
    // the control on, and the migration note says so.
    const ir = mutateIR(LEGACY);
    ir.specVersion = '0.26';
    ir.profile = 'enterprise';
    ir.observability.export = 'none';
    expect(exportsGate(ir).diagnostics).toEqual([]);
  });
});

describe('eval targets', () => {
  it('resolves an agent target into the agents namespace', () => {
    const { ir } = buildFixture(TRAJECTORY);
    const target = ir.evals.find((entry) => entry.id === 'agent_tool_calls')?.target;
    expect(target?.kind).toBe('agent');
    expect(target?.id).toBe('support');
    expect(target?.valid).toBe(true);
  });

  it('reports an agent target as an agent, never as an undeclared pipeline', () => {
    // The gate refuses the target before a generator is entered, so this branch is
    // unreachable through `aid gen`; it exists so a caller that builds an IR directly
    // cannot be told an agent it just read is missing.
    const { ir } = buildFixture(TRAJECTORY);
    const evaluation = ir.evals.find((entry) => entry.id === 'agent_tool_calls');
    if (evaluation === undefined) throw new Error('fixture lost agent_tool_calls');
    const subject = evalSubject(ir, evaluation);
    expect(subject.ok).toBe(false);
    if (subject.ok) return;
    expect(subject.code).toBe('unsupported-eval-target');
    expect(subject.message).not.toContain('is not declared');
    expect(subject.message).toContain('trajectory');
  });

  it('reports an agent target naming no declared agent', () => {
    const ir = mutateIR(TRAJECTORY);
    for (const entry of ir.evals) {
      if (entry.target.kind === 'agent') entry.target.id = 'nowhere';
    }
    const diagnostics = runGates(ir).byGate.referential.diagnostics;
    expect(codesOf(diagnostics)).toContain(IR_DIAGNOSTIC_CODES.refUnresolved);
  });
});

describe('trajectory metrics', () => {
  it('refuses a tool trace on a target that has no tool calls to trace', () => {
    const ir = mutateIR(TRAJECTORY);
    const diagnostics = trajectoryGate(ir).diagnostics.filter((entry) =>
      entry.message.includes('pipeline_tool_calls'),
    );
    const diagnostic = onlyDiagnosticWith(diagnostics, IR_DIAGNOSTIC_CODES.evalTrajectory);
    expect(diagnostic.path).toEqual(['evals', 'pipeline_tool_calls', 'metrics', 0]);
    expect(diagnostic.message).toContain('no tool calls to compare');
    expect(diagnostic.hint).toContain('no metric in this build inspects a trajectory');
  });

  it('refuses the agent target once, at the target, and the tool trace on a pipeline', () => {
    const diagnostics = trajectoryGate(mutateIR(TRAJECTORY)).diagnostics;
    expect(diagnostics.map((entry) => entry.path.join('.'))).toEqual([
      'evals.agent_tool_calls.target',
      'evals.pipeline_tool_calls.metrics.0',
    ]);
    for (const diagnostic of diagnostics) {
      expect(diagnostic.code).toBe(IR_DIAGNOSTIC_CODES.evalTrajectory);
    }
  });

  it('refuses an agent target with the reason it is refused, not as undeclared', () => {
    const ir = mutateIR(TRAJECTORY);
    const diagnostic = onlyDiagnosticWith(
      trajectoryGate(ir).diagnostics.filter((entry) => entry.message.includes('agent_tool_calls')),
      IR_DIAGNOSTIC_CODES.evalTrajectory,
    );
    expect(diagnostic.path).toEqual(['evals', 'agent_tool_calls', 'target']);
    expect(diagnostic.message).toContain('emits evals over a prompt, not over an agent run');
    // The agent *is* declared; saying otherwise would send the author looking for a typo
    // in a name that is spelled correctly.
    expect(diagnostic.message).not.toContain('is not declared');
    expect(diagnostic.hint).toContain('target: pipeline:<id>');
  });

  it('accepts a cost or latency ceiling, which set a budget this build honours', () => {
    // The eval runner cannot score either ceiling, but both survive as declared
    // budgets: the cost gate checks `costBudget` against a static estimate and the
    // deploy plan carries `latencyBudgetP95Ms`. Refusing them would delete a working
    // check, so they stay accepted here and are still refused at generation.
    const ir = mutateIR(TRAJECTORY);
    const paths = trajectoryGate(ir).diagnostics.map((entry) => entry.path.join('.'));
    expect(paths).not.toContain('evals.pipeline_cost.metrics.0');
    expect(paths).not.toContain('evals.pipeline_latency.metrics.0');
    const cost = ir.evals.find((entry) => entry.id === 'pipeline_cost');
    const latency = ir.evals.find((entry) => entry.id === 'pipeline_latency');
    expect(cost?.costBudget).toBe(0.25);
    expect(latency?.latencyBudgetP95Ms).toBe(4000);
  });

  it('refuses only the agent target in a 0.27 document, leaving its pipeline eval alone', () => {
    const diagnostics = trajectoryGate(mutateIR(OTLP)).diagnostics;
    expect(diagnostics.map((entry) => entry.path.join('.'))).toEqual([
      'evals.adjudicator_exact.target',
    ]);
  });
});
