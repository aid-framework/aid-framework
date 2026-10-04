import { describe, expect, it } from 'vitest';

import { IR_DIAGNOSTIC_CODES, runGates } from '../../src/index.js';
import { diagnosticAt, first, gateFixture, mutateIR, onlyDiagnosticWith } from '../helpers.js';

const UNRESOLVED = 'referential-unresolved.yaml';

function referential(name: string) {
  return gateFixture(name).byGate.referential;
}

describe('referential gate', () => {
  it('passes a spec whose every reference resolves to the right kind', () => {
    const result = referential('full.yaml');
    expect(result.diagnostics).toEqual([]);
  });

  it('declares the one check Phase 0 cannot enforce rather than skipping it', () => {
    const result = referential('full.yaml');
    expect(result.suppressed.map((entry) => entry.check)).toEqual([
      'referential/request-input-fields',
    ]);
    expect(first(result.suppressed).reason.length).toBeGreaterThan(0);
  });

  it('reports an unresolved type, a kind mismatch, and two missing ids', () => {
    const { diagnostics } = referential(UNRESOLVED);
    expect(diagnostics).toHaveLength(4);
    expect(new Set(diagnostics.map((diagnostic) => diagnostic.code))).toEqual(
      new Set([
        IR_DIAGNOSTIC_CODES.typeUnresolved,
        IR_DIAGNOSTIC_CODES.refKindMismatch,
        IR_DIAGNOSTIC_CODES.refUnresolved,
      ]),
    );
    expect(diagnostics.map((diagnostic) => diagnostic.path.join('.'))).toEqual([
      'types.Order.fields.0.type',
      'pipelines.summarize_order.steps.0.tool',
      'pipelines.summarize_order.steps.1.prompt',
      'evals.order_suite.target',
    ]);
    expect(diagnostics.every((diagnostic) => diagnostic.severity === 'error')).toBe(true);
  });

  it('names spec-document paths and the gate that rejected the reference', () => {
    const { diagnostics } = referential(UNRESOLVED);
    expect(diagnostics.every((diagnostic) => diagnostic.message.includes('referential gate'))).toBe(
      true,
    );
    expect(diagnosticAt(diagnostics, 'types.Order.fields.0.type').message).toContain(
      'type "MissingType" has no definition',
    );
  });

  it('distinguishes a wrong-kind reference from a missing id', () => {
    const { diagnostics } = referential(UNRESOLVED);
    const mismatch = diagnosticAt(diagnostics, 'pipelines.summarize_order.steps.0.tool');
    expect(mismatch.code).toBe(IR_DIAGNOSTIC_CODES.refKindMismatch);
    expect(mismatch.message).toContain('"summarize" is a prompt, but a tool is required here');

    const missing = diagnosticAt(diagnostics, 'pipelines.summarize_order.steps.1.prompt');
    expect(missing.code).toBe(IR_DIAGNOSTIC_CODES.refUnresolved);
    expect(missing.message).toContain('no prompt named "missing_prompt" exists');
  });

  it('rejects a cycle in the type graph', () => {
    const { diagnostics } = referential('referential-type-cycle.yaml');
    expect(diagnostics).toHaveLength(1);
    const cycle = onlyDiagnosticWith(diagnostics, IR_DIAGNOSTIC_CODES.typeCycle);
    expect(cycle.severity).toBe('error');
    expect(cycle.path).toEqual(['types', 'Owner']);
    expect(cycle.message).toContain('Owner -> Ticket -> Owner');
  });

  it('rejects a cycle in a fallback chain', () => {
    const { diagnostics } = referential('referential-fallback-cycle.yaml');
    const cycle = onlyDiagnosticWith(diagnostics, IR_DIAGNOSTIC_CODES.fallbackCycle);
    expect(cycle.path).toEqual(['models', 'primary', 'fallbacks']);
    expect(cycle.message).toContain('primary -> secondary -> primary');
  });

  it('rejects a placeholder the prompt never declared, and flags an unused variable', () => {
    const { diagnostics } = referential('referential-prompt-vars.yaml');

    const undeclared = onlyDiagnosticWith(
      diagnostics,
      IR_DIAGNOSTIC_CODES.promptVariableUndeclared,
    );
    expect(undeclared.severity).toBe('error');
    expect(undeclared.path).toEqual(['prompts', 'summarise', 'template']);
    expect(undeclared.message).toContain('{{summary}}');

    const unused = diagnostics.filter(
      (diagnostic) => diagnostic.code === IR_DIAGNOSTIC_CODES.promptVariableUnused,
    );
    expect(unused).toHaveLength(2);
    expect(unused.every((diagnostic) => diagnostic.severity === 'warning')).toBe(true);
  });

  it('rejects a binding referenced before the step that defines it', () => {
    const { diagnostics } = referential('referential-binding.yaml');
    const forward = onlyDiagnosticWith(diagnostics, IR_DIAGNOSTIC_CODES.bindingForwardReference);
    expect(forward.path).toEqual(['pipelines', 'order', 'steps', 0, 'input', 'text']);
    expect(forward.message).toContain('"later" is bound by a later step');
  });

  it('rejects a duplicate binding in one pipeline scope after resolution', () => {
    const ir = mutateIR('full.yaml');
    const steps = first(ir.pipelines).steps;
    const second = steps[1];
    if (second?.kind !== 'tool') {
      throw new Error('expected full.yaml to carry a tool step at index 1');
    }
    second.as = 'classification';

    const duplicate = onlyDiagnosticWith(
      runGates(ir).byGate.referential.diagnostics,
      IR_DIAGNOSTIC_CODES.bindingDuplicate,
    );
    expect(duplicate.path).toEqual(['pipelines', 'handle_ticket', 'steps', 1, 'as']);
    expect(duplicate.message).toContain('"classification" is already bound by step 0');
  });

  it('rejects a step that does not supply a required, defaultless prompt variable', () => {
    const ir = mutateIR('full.yaml');
    const step = first(first(ir.pipelines).steps);
    if (step.kind !== 'generate') {
      throw new Error('expected full.yaml to open with a generate step');
    }
    delete step.input.subject;

    const missing = onlyDiagnosticWith(
      runGates(ir).byGate.referential.diagnostics,
      IR_DIAGNOSTIC_CODES.promptInputMissing,
    );
    expect(missing.path).toEqual(['pipelines', 'handle_ticket', 'steps', 0, 'input']);
    expect(missing.message).toContain('requires "subject"');
  });

  it('rejects an eval target that is not a known `kind:id` pair', () => {
    const ir = mutateIR('full.yaml');
    first(ir.evals).target = { kind: 'pipeline', id: 'nope', qualified: 'nope', valid: false };

    const invalid = onlyDiagnosticWith(
      runGates(ir).byGate.referential.diagnostics,
      IR_DIAGNOSTIC_CODES.evalTargetInvalid,
    );
    expect(invalid.severity).toBe('error');
    expect(invalid.path).toEqual(['evals', 'refund_regression', 'target']);
    expect(invalid.message).toContain('"nope" is not a "kind:id" pair');
  });

  it('resolves an eval target to the pipeline it names', () => {
    const { ir } = gateFixture('full.yaml');
    const target = first(ir.evals).target;
    expect(target).toEqual({
      kind: 'pipeline',
      id: 'handle_ticket',
      qualified: 'pipeline:handle_ticket',
      valid: true,
    });
  });
});
