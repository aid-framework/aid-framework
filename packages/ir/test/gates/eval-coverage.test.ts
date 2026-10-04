import { describe, expect, it } from 'vitest';

import { buildEvalTarget, IR_DIAGNOSTIC_CODES, runGates } from '../../src/index.js';
import { first, gateFixture, mutateIR, onlyDiagnosticWith } from '../helpers.js';

const GATE = 'eval-coverage';

describe('eval-coverage gate', () => {
  it('passes when a CI-gating eval targets every HTTP-triggered pipeline', () => {
    expect(gateFixture('full.yaml').byGate[GATE].diagnostics).toEqual([]);
  });

  it('warns, once, for a pipeline no CI-gating eval covers', () => {
    const result = gateFixture('eval-uncovered.yaml');
    const { diagnostics } = result.byGate[GATE];

    expect(diagnostics).toHaveLength(1);
    const uncovered = onlyDiagnosticWith(diagnostics, IR_DIAGNOSTIC_CODES.evalUncovered);
    expect(uncovered.path).toEqual(['pipelines', 'uncovered']);
    expect(uncovered.message).toContain('eval-coverage gate flagged this pipeline');
    expect(result.ok).toBe(true);
  });

  it('warns for a pipeline whose only eval is not CI-gating', () => {
    const ir = mutateIR('full.yaml');
    first(ir.evals).gate.ci = false;

    const { diagnostics } = runGates(ir).byGate[GATE];
    expect(diagnostics).toHaveLength(1);
    expect(first(diagnostics).path).toEqual(['pipelines', 'handle_ticket']);
  });

  it('warns when the app declares no evals at all', () => {
    const ir = mutateIR('full.yaml');
    ir.evals = [];
    expect(runGates(ir).byGate[GATE].diagnostics).toHaveLength(1);
  });

  it('does not require coverage of a pipeline HTTP does not serve', () => {
    const ir = mutateIR('full.yaml');
    first(ir.pipelines).trigger = { kind: 'schedule', schedule: '0 * * * *' };
    expect(runGates(ir).byGate[GATE].diagnostics).toEqual([]);
  });

  it('does not count an eval that targets a prompt as covering a pipeline', () => {
    const ir = mutateIR('full.yaml');
    const target = buildEvalTarget('prompt:classify_ticket');
    expect(target.valid).toBe(true);
    expect(target.kind).toBe('prompt');
    first(ir.evals).target = target;

    expect(runGates(ir).byGate[GATE].diagnostics).toHaveLength(1);
  });

  it('never errors: an uncovered pipeline is legitimate, a silent one is not', () => {
    const { byGate } = gateFixture('eval-uncovered.yaml');
    expect(byGate[GATE].diagnostics.every((diagnostic) => diagnostic.severity === 'warning')).toBe(
      true,
    );
    expect(byGate[GATE].suppressed).toEqual([]);
  });
});
