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

  it('resolves an agent target to the agent it names, so a caller is never told it is missing', () => {
    // `evalSubject` resolves the name; whether a *target* can measure it is the trajectory
    // gate's question, decided by the `agent-evals` capability and answered below. This one
    // exists so a caller that builds an IR directly cannot be told an agent it just read is
    // undeclared.
    const { ir } = buildFixture(TRAJECTORY);
    const evaluation = ir.evals.find((entry) => entry.id === 'agent_tool_calls');
    if (evaluation === undefined) throw new Error('fixture lost agent_tool_calls');
    const subject = evalSubject(ir, evaluation);
    expect(subject.ok).toBe(true);
    if (!subject.ok) return;
    expect(subject.subject.kind).toBe('agent');
    if (subject.subject.kind !== 'agent') return;
    expect(subject.subject.agent.id).toBe('support');
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
    // The hint has to name the target that *can* compare calls, because a prompt eval with a
    // tool trace is not a smaller version of this one -- it is a different subject.
    expect(diagnostic.hint).toContain('target: agent:<id>');
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

  it('refuses an agent target by the capability it lacks, not as undeclared', () => {
    const ir = mutateIR(TRAJECTORY);
    const diagnostic = onlyDiagnosticWith(
      trajectoryGate(ir).diagnostics.filter((entry) => entry.message.includes('agent_tool_calls')),
      IR_DIAGNOSTIC_CODES.evalTrajectory,
    );
    expect(diagnostic.path).toEqual(['evals', 'agent_tool_calls', 'target']);
    expect(diagnostic.message).toContain('does not declare the "agent-evals" capability');
    // The agent *is* declared; saying otherwise would send the author looking for a typo
    // in a name that is spelled correctly.
    expect(diagnostic.message).not.toContain('is not declared');
    expect(diagnostic.hint).toContain('offline agent evaluator');
  });

  it('accepts an agent target once its generator declares it can measure a run', () => {
    // `runGates` falls back to a placeholder vocabulary when a caller supplies none, which
    // is why every test above sees the refusal. This is the other half: the capability is
    // the only thing standing between the eval and a gate pass.
    const ir = mutateIR(TRAJECTORY);
    const targetCapabilities = Object.fromEntries(
      ir.project.targets.map((target) => [target, ['agent-evals']]),
    );
    const gate = runGates(ir, { targetCapabilities }).byGate['evals/trajectory'];

    // The pipeline eval's tool trace is still refused: a generator that can measure an
    // agent run says nothing about a pipeline, which returns one response.
    expect(gate.diagnostics.map((entry) => entry.path.join('.'))).toEqual([
      'evals.pipeline_tool_calls.metrics.0',
    ]);
  });

  it('accepts a cost or latency ceiling, which this build measures per case', () => {
    // Both are scored by the harness around every case (`CostCeiling`, `LatencyCeiling`), and
    // both also survive as declared budgets: the cost gate checks `costBudget` against a
    // static estimate and the deploy plan carries `latencyBudgetP95Ms`. The trajectory gate
    // has nothing to say about them, which is what this pins.
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
