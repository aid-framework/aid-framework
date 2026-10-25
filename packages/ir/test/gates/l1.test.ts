import { describe, expect, it } from 'vitest';

import {
  type GateName,
  IR_DIAGNOSTIC_CODES,
  type IrDiagnosticCode,
  phase0TargetCapabilities,
  runGates,
} from '../../src/index.js';
import {
  buildFixture,
  byId,
  codesOf,
  diagnosticAt,
  first,
  gateFixture,
  mutateIR,
  onlyDiagnosticWith,
} from '../helpers.js';

const POSITIVE = 'agents.yaml';

/** `streaming` is in the vocabulary but no target declares it in L1 (defect D-1). */
function withStreaming(): Record<string, readonly string[]> {
  return {
    'py-fastapi': [...(phase0TargetCapabilities()['py-fastapi'] ?? []), 'streaming'],
  };
}

describe('guardrails/coverage', () => {
  it('accepts a side-effecting tool covered at the tool-call stage', () => {
    expect(gateFixture(POSITIVE).byGate['guardrails/coverage'].diagnostics).toEqual([]);
  });

  it('rejects a write tool no declared guardrail covers', () => {
    const { diagnostics } = gateFixture('guardrails-uncovered.yaml').byGate['guardrails/coverage'];
    const uncovered = onlyDiagnosticWith(diagnostics, IR_DIAGNOSTIC_CODES.guardrailCoverage);
    expect(uncovered.severity).toBe('error');
    expect(uncovered.path).toEqual(['tools', 'issue_refund', 'sideEffects']);
    expect(uncovered.message).toContain('no declared guardrail covers it');
    expect(uncovered.hint).toContain('stages: [tool-call]');
  });

  it('treats an empty tools list as covering every tool reaching the stage', () => {
    const ir = mutateIR(POSITIVE);
    byId(ir.guardrails, 'refund_writes').tools = [];
    expect(runGates(ir).byGate['guardrails/coverage'].diagnostics).toEqual([]);
  });

  it('is not satisfied by a tool-call guardrail that names a different tool', () => {
    const ir = mutateIR(POSITIVE);
    byId(ir.guardrails, 'refund_writes').tools = ['fetch_order'];
    expect(codesOf(runGates(ir).byGate['guardrails/coverage'].diagnostics)).toEqual([
      IR_DIAGNOSTIC_CODES.guardrailCoverage,
    ]);
  });

  it('does not police coverage in a spec that declares no guardrail, and says so', () => {
    const { byGate } = gateFixture('full.yaml');
    expect(byGate['guardrails/coverage'].diagnostics).toEqual([]);
    // The deferral must stay visible: an empty guardrail list is not a pass, it is a
    // check this layer deliberately does not impose on a pre-0.2 spec.
    expect(byGate['guardrails/coverage'].suppressed.map((entry) => entry.check)).toEqual([
      'guardrails/coverage-without-declaration',
    ]);
  });

  it('still inspects a destructive tool, not only a write', () => {
    const ir = mutateIR('guardrails-uncovered.yaml');
    first(ir.tools.filter((tool) => tool.id === 'issue_refund')).sideEffects = 'destructive';
    expect(codesOf(runGates(ir).byGate['guardrails/coverage'].diagnostics)).toEqual([
      IR_DIAGNOSTIC_CODES.guardrailCoverage,
    ]);
  });
});

describe('guardrails/policies', () => {
  it('accepts the closed vocabulary the fixture declares', () => {
    expect(gateFixture(POSITIVE).byGate['guardrails/policies'].diagnostics).toEqual([]);
  });

  it('rejects a redact action that names nothing to redact', () => {
    const { diagnostics } = gateFixture('guardrails-policies.yaml').byGate['guardrails/policies'];
    expect(diagnosticAt(diagnostics, 'guardrails.inbound.redact').message).toContain(
      'names no field to redact',
    );
  });

  it('rejects a guardrail covering a tool that does not exist', () => {
    const { diagnostics } = gateFixture('guardrails-policies.yaml').byGate['guardrails/policies'];
    const unresolved = diagnosticAt(diagnostics, 'guardrails.refund_writes.tools.1');
    expect(unresolved.message).toContain('"missing_tool"');
    expect(unresolved.hint).toContain('issue_refund');
  });

  it('rejects a fallback prompt that is not declared', () => {
    const { diagnostics } = gateFixture('guardrails-policies.yaml').byGate['guardrails/policies'];
    expect(
      diagnosticAt(diagnostics, 'guardrails.refund_writes.onFail.fallbackPrompt').message,
    ).toContain('"missing_prompt"');
  });

  it('reports exactly the three defects the fixture carries', () => {
    const { diagnostics } = gateFixture('guardrails-policies.yaml').byGate['guardrails/policies'];
    expect(diagnostics).toHaveLength(3);
    expect(codesOf(diagnostics)).toEqual([
      IR_DIAGNOSTIC_CODES.guardrailPolicy,
      IR_DIAGNOSTIC_CODES.guardrailPolicy,
      IR_DIAGNOSTIC_CODES.guardrailPolicy,
    ]);
  });

  it('re-checks the closed policy vocabulary for hand-written IR', () => {
    const ir = mutateIR(POSITIVE);
    (byId(ir.guardrails, 'inbound') as unknown as { policies: string[] }).policies = [
      'teleportation',
    ];
    const unknown = onlyDiagnosticWith(
      runGates(ir).byGate['guardrails/policies'].diagnostics,
      IR_DIAGNOSTIC_CODES.guardrailPolicy,
    );
    expect(unknown.path).toEqual(['guardrails', 'inbound', 'policies', 0]);
    expect(unknown.message).toContain('not in the closed vocabulary');
  });

  it('rejects a guardrail no stage could ever invoke', () => {
    const ir = mutateIR(POSITIVE);
    byId(ir.guardrails, 'inbound').stages = [];
    expect(
      diagnosticAt(
        runGates(ir).byGate['guardrails/policies'].diagnostics,
        'guardrails.inbound.stages',
      ).message,
    ).toContain('no runtime could ever invoke it');
  });

  it('rejects a guardrail with no policy to evaluate', () => {
    const ir = mutateIR(POSITIVE);
    byId(ir.guardrails, 'inbound').policies = [];
    const empty = onlyDiagnosticWith(
      runGates(ir).byGate['guardrails/policies'].diagnostics,
      IR_DIAGNOSTIC_CODES.policyEmpty,
    );
    expect(empty.path).toEqual(['guardrails', 'inbound', 'policies']);
  });
});

describe('hitl/side-effects', () => {
  it('accepts an agent whose side-effecting tool path declares human review', () => {
    expect(gateFixture(POSITIVE).byGate['hitl/side-effects'].diagnostics).toEqual([]);
  });

  it('rejects an agent that can write with neither a policy nor a confirmation', () => {
    const { diagnostics } = gateFixture('hitl-missing.yaml').byGate['hitl/side-effects'];
    const missing = onlyDiagnosticWith(diagnostics, IR_DIAGNOSTIC_CODES.hitlSideEffect);
    expect(missing.severity).toBe('error');
    expect(missing.path).toEqual(['agents', 'support', 'humanInTheLoop']);
    expect(missing.message).toContain('"issue_refund"');
    expect(missing.message).toContain('humanInTheLoop');
  });

  it('accepts the tool-level grant of a confirmation prompt', () => {
    const ir = mutateIR('hitl-missing.yaml');
    first(ir.tools.filter((tool) => tool.id === 'issue_refund')).requiresConfirmation = true;
    expect(runGates(ir).byGate['hitl/side-effects'].diagnostics).toEqual([]);
  });

  it('does not demand human review for an agent that cannot write', () => {
    const ir = mutateIR('hitl-missing.yaml');
    byId(ir.agents, 'support').tools = ['fetch_order'];
    expect(runGates(ir).byGate['hitl/side-effects'].diagnostics).toEqual([]);
  });

  it('reaches a destructive tool through the same rule', () => {
    const ir = mutateIR('hitl-missing.yaml');
    const refund = first(ir.tools.filter((tool) => tool.id === 'issue_refund'));
    refund.sideEffects = 'destructive';
    refund.requiresConfirmation = false;
    expect(codesOf(runGates(ir).byGate['hitl/side-effects'].diagnostics)).toEqual([
      IR_DIAGNOSTIC_CODES.hitlSideEffect,
    ]);
  });
});

describe('memory/refs', () => {
  it('accepts a window tier with no backing store', () => {
    expect(gateFixture(POSITIVE).byGate['memory/refs'].diagnostics).toEqual([]);
  });

  it('rejects a store that is not declared', () => {
    const { diagnostics } = gateFixture('memory-unresolved.yaml').byGate['memory/refs'];
    const unresolved = onlyDiagnosticWith(diagnostics, IR_DIAGNOSTIC_CODES.memoryRef);
    expect(unresolved.severity).toBe('error');
    expect(unresolved.path).toEqual(['memory', 'conversation', 'store']);
    expect(unresolved.message).toContain('"vectors"');
  });

  it('accepts the in-process backend and rejects anything else undeclared', () => {
    const inProcess = mutateIR(POSITIVE);
    byId(inProcess.memory, 'conversation').backend = 'in-process';
    expect(runGates(inProcess).byGate['memory/refs'].diagnostics).toEqual([]);

    const elsewhere = mutateIR(POSITIVE);
    byId(elsewhere.memory, 'conversation').backend = 'redis';
    expect(
      diagnosticAt(
        runGates(elsewhere).byGate['memory/refs'].diagnostics,
        'memory.conversation.backend',
      ).message,
    ).toContain('neither a declared store nor "in-process"');
  });

  it('rejects a summary tier with no model to summarize with', () => {
    const ir = mutateIR(POSITIVE);
    byId(ir.memory, 'conversation').kind = 'summary';
    expect(
      diagnosticAt(
        runGates(ir).byGate['memory/refs'].diagnostics,
        'memory.conversation.summarizeModel',
      ).message,
    ).toContain('nothing can produce the summary');
  });

  it('accepts a summary tier that names a declared model', () => {
    const ir = mutateIR(POSITIVE);
    const memory = byId(ir.memory, 'conversation');
    memory.kind = 'summary';
    memory.summarizeModel = 'triage';
    expect(runGates(ir).byGate['memory/refs'].diagnostics).toEqual([]);
  });

  it('rejects a tier that outlives the run with nowhere to live', () => {
    const ir = mutateIR(POSITIVE);
    byId(ir.memory, 'conversation').kind = 'semantic';
    expect(
      diagnosticAt(runGates(ir).byGate['memory/refs'].diagnostics, 'memory.conversation.store')
        .message,
    ).toContain('neither a store nor an external backend');
  });
});

describe('deploy/streaming', () => {
  it('accepts a deployment that does not request streaming', () => {
    expect(gateFixture(POSITIVE).byGate['deploy/streaming'].diagnostics).toEqual([]);
  });

  it('rejects a deployment that requests what no target implements', () => {
    const { diagnostics } = gateFixture('deploy-streaming.yaml').byGate['deploy/streaming'];
    const deferred = onlyDiagnosticWith(diagnostics, IR_DIAGNOSTIC_CODES.deployStreaming);
    expect(deferred.severity).toBe('error');
    expect(deferred.path).toEqual(['deployments', 'prod', 'streaming']);
    expect(deferred.message).toContain('"py-fastapi"');
    expect(deferred.message).toContain('"streaming" capability');
  });

  it('passes the moment a target declares streaming, so the rule is not a stub', () => {
    const { byGate } = gateFixture('deploy-streaming.yaml', {
      targetCapabilities: withStreaming(),
    });
    expect(byGate['deploy/streaming'].diagnostics).toEqual([]);
  });

  it('does nothing when the spec declares no deployment', () => {
    const ir = mutateIR(POSITIVE);
    ir.deployments = [];
    expect(runGates(ir).byGate['deploy/streaming'].diagnostics).toEqual([]);
  });
});

describe('orchestration/deepagents', () => {
  it('accepts the native engine', () => {
    expect(gateFixture(POSITIVE).byGate['orchestration/deepagents'].diagnostics).toEqual([]);
  });

  it('rejects deepagents with no pinned version and a model that cannot call tools', () => {
    const { diagnostics } = gateFixture('orchestration-deepagents.yaml').byGate[
      'orchestration/deepagents'
    ];
    expect(diagnostics).toHaveLength(2);
    expect(diagnosticAt(diagnostics, 'agents.support.engineVersion').message).toContain(
      'no engineVersion is pinned',
    );
    expect(diagnosticAt(diagnostics, 'agents.support.model').message).toContain(
      'does not declare the "tool-calling" capability',
    );
  });

  it('accepts deepagents once the version is pinned and the model can call tools', () => {
    const ir = mutateIR('orchestration-deepagents.yaml');
    const support = byId(ir.agents, 'support');
    support.engineVersion = 'deepagents==0.2.1';
    byId(ir.models, 'triage').capabilities = [
      ...byId(ir.models, 'triage').capabilities,
      'tool-calling',
    ];
    expect(runGates(ir).byGate['orchestration/deepagents'].diagnostics).toEqual([]);
  });

  it('leaves an unresolved model to the refs gate instead of double-reporting', () => {
    const ir = mutateIR('orchestration-deepagents.yaml');
    const support = byId(ir.agents, 'support');
    support.engineVersion = 'deepagents==0.2.1';
    support.model = 'ghost_model';
    const { byGate } = runGates(ir);
    expect(byGate['orchestration/deepagents'].diagnostics).toEqual([]);
    expect(codesOf(byGate['agents/refs-resolve'].diagnostics)).toEqual([
      IR_DIAGNOSTIC_CODES.agentsRefUnresolved,
    ]);
  });
});

/**
 * The no-vacuous-green guard for this suite: every gate the plan names must have a
 * fixture that its own gate actually rejects. A suite that lost a fixture, or a gate
 * that a refactor turned into a no-op, fails here even though every `describe` above
 * would still pass vacuously.
 */
const L1_GATES: { gate: GateName; fixture: string; code: IrDiagnosticCode }[] = [
  {
    gate: 'agents/refs-resolve',
    fixture: 'agents-unresolved.yaml',
    code: IR_DIAGNOSTIC_CODES.agentsRefUnresolved,
  },
  {
    gate: 'agents/handoff-cycles',
    fixture: 'agents-handoff-cycle.yaml',
    code: IR_DIAGNOSTIC_CODES.agentsHandoffCycle,
  },
  {
    gate: 'agents/budgets',
    fixture: 'agents-unbounded.yaml',
    code: IR_DIAGNOSTIC_CODES.agentsBudget,
  },
  {
    gate: 'guardrails/coverage',
    fixture: 'guardrails-uncovered.yaml',
    code: IR_DIAGNOSTIC_CODES.guardrailCoverage,
  },
  {
    gate: 'guardrails/policies',
    fixture: 'guardrails-policies.yaml',
    code: IR_DIAGNOSTIC_CODES.guardrailPolicy,
  },
  {
    gate: 'hitl/side-effects',
    fixture: 'hitl-missing.yaml',
    code: IR_DIAGNOSTIC_CODES.hitlSideEffect,
  },
  { gate: 'memory/refs', fixture: 'memory-unresolved.yaml', code: IR_DIAGNOSTIC_CODES.memoryRef },
  {
    gate: 'deploy/streaming',
    fixture: 'deploy-streaming.yaml',
    code: IR_DIAGNOSTIC_CODES.deployStreaming,
  },
  {
    gate: 'orchestration/deepagents',
    fixture: 'orchestration-deepagents.yaml',
    code: IR_DIAGNOSTIC_CODES.orchestrationDeepagents,
  },
];

describe('L1 gate coverage', () => {
  it('covers all nine plan-named gates', () => {
    expect(L1_GATES.map((entry) => entry.gate)).toEqual([
      'agents/refs-resolve',
      'agents/handoff-cycles',
      'agents/budgets',
      'guardrails/coverage',
      'guardrails/policies',
      'hitl/side-effects',
      'memory/refs',
      'deploy/streaming',
      'orchestration/deepagents',
    ]);
  });

  it('has one negative fixture per gate that the gate itself rejects', () => {
    for (const { gate, fixture, code } of L1_GATES) {
      const diagnostics = gateFixture(fixture).byGate[gate].diagnostics;
      expect(diagnostics, gate).not.toHaveLength(0);
      expect(codesOf(diagnostics), gate).toContain(code);
    }
  });

  it('has a positive fixture every gate accepts', () => {
    const { byGate } = gateFixture(POSITIVE);
    for (const { gate } of L1_GATES) {
      expect(byGate[gate].diagnostics, gate).toEqual([]);
    }
    // …and the same spec is still rejected by the capability gate, which is the L1
    // claim: the sections validate, then no target can take them.
    expect(byGate.capability.diagnostics.length).toBeGreaterThan(0);
  });

  it('leaves every negative fixture otherwise well-formed', () => {
    // A fixture rejected by the spec layer would never reach a gate, so this asserts
    // each one builds IR with no build-time error of its own.
    for (const { fixture } of L1_GATES) {
      expect(buildFixture(fixture).diagnostics, fixture).toEqual([]);
    }
  });
});
