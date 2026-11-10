import { describe, expect, it } from 'vitest';

import {
  type BranchStep,
  buildIR,
  type IR,
  IR_DIAGNOSTIC_CODES,
  runGates,
  type StepShape,
  type ToolStep,
} from '../../src/index.js';
import {
  buildFixture,
  codesOf,
  first,
  gateFixture,
  mutateIR,
  onlyDiagnosticWith,
} from '../helpers.js';

const CONTROLS = 'v26-controls.yaml';

function state(ir: IR) {
  return runGates(ir).byGate.state;
}

function approvals(ir: IR) {
  return runGates(ir).byGate.approvals;
}

function theToolStep(ir: IR): ToolStep {
  const step = first(first(ir.pipelines).steps);
  if (step.kind !== 'tool') throw new Error(`expected a tool step, got ${step.kind}`);
  return step;
}

describe('the durable run store', () => {
  it('accepts an enterprise agent that reaches a write tool through a declared store', () => {
    const result = gateFixture(CONTROLS);
    expect(result.byGate.state.diagnostics).toEqual([]);
    expect(result.byGate.approvals.diagnostics).toEqual([]);
  });

  it('carries the document store and the agent override into the IR', () => {
    const ir = buildFixture(CONTROLS).ir;

    expect(ir.state).toEqual({ kind: 'postgres', urlEnv: 'DATABASE_URL', ttlHours: 168 });
    expect(first(ir.agents).state).toEqual({
      kind: 'postgres',
      urlEnv: 'DATABASE_URL',
      ttlHours: 24,
    });
  });

  it('gives an agent with no store of its own the document store', () => {
    // Two stores under one document would be a store whose kind and connection string
    // disagree, so the agent inherits the document's store rather than merging with it.
    const built = buildIR({
      specVersion: '0.26',
      project: { name: 'p' },
      state: { kind: 'postgres', urlEnv: 'DATABASE_URL', ttlHours: 168 },
      agents: { writer: { model: 'm', instructions: 'write', tools: ['t'], maxSteps: 3 } },
    });

    expect(first(built.ir.agents).state).toEqual({
      kind: 'postgres',
      urlEnv: 'DATABASE_URL',
      ttlHours: 168,
    });
  });

  it('refuses an enterprise agent that can write and declares no store anywhere', () => {
    const ir = mutateIR(CONTROLS);
    delete ir.state;
    delete first(ir.agents).state;

    const diagnostic = onlyDiagnosticWith(
      state(ir).diagnostics,
      IR_DIAGNOSTIC_CODES.agentsStateStore,
    );
    expect(diagnostic.path).toEqual(['agents', 'claims_adjudicator', 'state']);
    expect(diagnostic.message).toContain('it can call "issue_refund" (write)');
    expect(diagnostic.message).toContain('cannot outlive the process');
    expect(diagnostic.hint).toContain('state: { kind: postgres');
  });

  it('names every writing tool the agent can reach', () => {
    const ir = mutateIR(CONTROLS);
    delete ir.state;
    delete first(ir.agents).state;
    ir.tools = [
      first(ir.tools),
      { ...first(ir.tools), id: 'purge_claim', sideEffects: 'destructive' },
    ];
    first(ir.agents).tools = ['issue_refund', 'purge_claim'];

    const diagnostic = onlyDiagnosticWith(
      state(ir).diagnostics,
      IR_DIAGNOSTIC_CODES.agentsStateStore,
    );
    expect(diagnostic.message).toContain('"issue_refund" (write), "purge_claim" (destructive)');
    expect(diagnostic.message).toContain('which have side effects');
  });

  it('requires no store of an agent that can only read', () => {
    const ir = mutateIR(CONTROLS);
    delete ir.state;
    delete first(ir.agents).state;
    first(ir.tools).sideEffects = 'read';

    expect(state(ir).diagnostics).toEqual([]);
  });

  it('requires nothing of the standard profile, which runs without a database', () => {
    const ir = mutateIR(CONTROLS);
    ir.profile = 'standard';
    delete ir.state;
    delete first(ir.agents).state;

    expect(state(ir).diagnostics).toEqual([]);
  });

  it('does not hold a 0.25 document to a store it could not declare', () => {
    // `state` is a 0.26 key: enforcing the requirement on 0.25 would make every existing
    // enterprise document unsatisfiable and break the additive-only promise.
    const ir = mutateIR(CONTROLS);
    ir.specVersion = '0.25';
    delete ir.state;
    delete first(ir.agents).state;

    expect(state(ir).diagnostics).toEqual([]);
  });
});

describe('step approval', () => {
  it('accepts a pause in front of a write when the run has a store', () => {
    const ir = mutateIR(CONTROLS);
    expect(theToolStep(ir).requiresApproval).toBe(true);
    expect(approvals(ir).diagnostics).toEqual([]);
  });

  it('refuses a pause in front of a read', () => {
    const ir = mutateIR(CONTROLS);
    first(ir.tools).sideEffects = 'read';

    const diagnostic = onlyDiagnosticWith(
      approvals(ir).diagnostics,
      IR_DIAGNOSTIC_CODES.approvalStepTool,
    );
    expect(diagnostic.path).toEqual([
      'pipelines',
      'refund',
      'steps',
      0,
      'tool',
      'requiresApproval',
    ]);
    expect(diagnostic.message).toContain('the pause asks a human to approve a read');
    expect(diagnostic.message).toContain('has no side effects');
    expect(diagnostic.hint).toContain('sideEffects is write or destructive');
  });

  it('refuses a pause in a document with no store to hold it', () => {
    const ir = mutateIR(CONTROLS);
    delete ir.state;

    const diagnostic = onlyDiagnosticWith(
      approvals(ir).diagnostics,
      IR_DIAGNOSTIC_CODES.approvalStepTool,
    );
    expect(diagnostic.path).toEqual(['state']);
    expect(diagnostic.message).toContain('has nowhere to wait');
    expect(diagnostic.hint).toContain('top-level `state:');
  });

  it('reports both faults when the pause is inert and unholdable', () => {
    const ir = mutateIR(CONTROLS);
    delete ir.state;
    first(ir.tools).sideEffects = 'read';

    expect(codesOf(approvals(ir).diagnostics)).toEqual([
      IR_DIAGNOSTIC_CODES.approvalStepTool,
      IR_DIAGNOSTIC_CODES.approvalStepTool,
    ]);
  });

  it('finds a pause however deeply it is nested', () => {
    const ir = mutateIR(CONTROLS);
    first(ir.tools).sideEffects = 'read';

    const composite = buildFixture('composite.yaml').ir;
    const branch = first(first(composite.pipelines).steps.filter(isBranch));
    const pause = theToolStep(ir);
    const steps: StepShape[] = [
      // biome-ignore lint/suspicious/noThenProperty: `then` is the IR's own branch arm name.
      { kind: 'branch', when: branch.when, then: [pause], else: [] },
      { kind: 'parallel', branches: [[pause]] },
      { kind: 'map', over: 'items', as: 'out', step: pause },
      { kind: 'route', decision: 'topic', input: 'x', on: { product: [pause] } },
    ];
    first(ir.pipelines).steps = steps;

    expect(approvals(ir).diagnostics.map((diagnostic) => diagnostic.path)).toEqual([
      ['pipelines', 'refund', 'steps', 0, 'then', 0, 'tool', 'requiresApproval'],
      ['pipelines', 'refund', 'steps', 1, 'branches', 0, 0, 'tool', 'requiresApproval'],
      ['pipelines', 'refund', 'steps', 2, 'step', 'tool', 'requiresApproval'],
      ['pipelines', 'refund', 'steps', 3, 'on', 'product', 0, 'tool', 'requiresApproval'],
    ]);
  });

  it('says nothing about a step that does not ask for approval', () => {
    const ir = mutateIR(CONTROLS);
    delete ir.state;
    delete theToolStep(ir).requiresApproval;

    expect(approvals(ir).diagnostics).toEqual([]);
  });
});

function isBranch(step: StepShape): step is BranchStep {
  return step.kind === 'branch';
}
