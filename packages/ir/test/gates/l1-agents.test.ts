import { describe, expect, it } from 'vitest';

import { type IR, IR_DIAGNOSTIC_CODES, runGates } from '../../src/index.js';
import {
  byId,
  codesOf,
  first,
  gateFixture,
  messagesOf,
  mutateIR,
  onlyDiagnosticWith,
} from '../helpers.js';

const REFS = 'agents/refs-resolve' as const;
const CYCLES = 'agents/handoff-cycles' as const;
const BUDGETS = 'agents/budgets' as const;

/**
 * The positive fixture is the same spec the other L1 gate tests use: two agents, one
 * handoff, one budgeted loop and one single-step agent. It is rejected by the
 * capability gate (no target declares `agents` in L1) but every agents gate must be
 * clean on it, which is what makes the negative fixtures meaningful.
 */
const POSITIVE = 'agents.yaml';

describe('agents/refs-resolve', () => {
  it('accepts a spec whose every agent reference resolves', () => {
    expect(gateFixture(POSITIVE).byGate[REFS].diagnostics).toEqual([]);
  });

  it('rejects an agent that names a tool the spec does not declare', () => {
    const { diagnostics } = gateFixture('agents-unresolved.yaml').byGate[REFS];
    const unresolved = onlyDiagnosticWith(diagnostics, IR_DIAGNOSTIC_CODES.agentsRefUnresolved);
    expect(unresolved.severity).toBe('error');
    expect(unresolved.path).toEqual(['agents', 'escalation', 'tools']);
    expect(unresolved.message).toContain('"missing_tool"');
    expect(unresolved.message).toContain('not a declared tool');
    expect(unresolved.hint).toContain('fetch_order');
  });

  it('resolves every reference field an agent shape carries', () => {
    const cases: Array<[string, (ir: IR) => void, string]> = [
      [
        'instructions',
        (ir) => {
          byId(ir.agents, 'support').instructions = 'ghost_prompt';
        },
        'not a declared prompt',
      ],
      [
        'model',
        (ir) => {
          byId(ir.agents, 'support').model = 'ghost_model';
        },
        'not a declared model',
      ],
      [
        'memory',
        (ir) => {
          byId(ir.agents, 'support').memory = ['ghost_memory'];
        },
        'not a declared memory',
      ],
      [
        'guardrails',
        (ir) => {
          byId(ir.agents, 'support').guardrails = ['ghost_guardrail'];
        },
        'not a declared guardrail',
      ],
      [
        'handoffs',
        (ir) => {
          byId(ir.agents, 'support').handoffs = ['ghost_agent'];
        },
        'not a declared agent',
      ],
      [
        'delegates',
        (ir) => {
          byId(ir.agents, 'support').delegates = ['ghost_agent'];
        },
        'not a declared agent',
      ],
      [
        'retrievers',
        (ir) => {
          byId(ir.agents, 'support').retrievers = ['ghost_retriever'];
        },
        'not a declared retriever',
      ],
    ];

    // A ref field the gate forgot to walk would leave `diagnostics` empty for that
    // case, so iterating the table is the assertion that no field is silently skipped.
    for (const [field, mutate, expected] of cases) {
      const ir = mutateIR(POSITIVE);
      mutate(ir);
      const diagnostics = runGates(ir).byGate[REFS].diagnostics;
      expect(diagnostics, field).toHaveLength(1);
      expect(first(diagnostics).path, field).toEqual(['agents', 'support', field]);
      expect(messagesOf(diagnostics), field).toContain(expected);
    }
  });

  it('checks the exact member the agent names, not just that a collection exists', () => {
    const ir = mutateIR(POSITIVE);
    byId(ir.agents, 'escalation').handoffs = ['escalation'];
    // A self-handoff resolves; it is `agents/handoff-cycles` that rejects it.
    expect(runGates(ir).byGate[REFS].diagnostics).toEqual([]);
    expect(runGates(ir).byGate[CYCLES].diagnostics).toHaveLength(1);
  });
});

describe('agents/handoff-cycles', () => {
  it('accepts an acyclic handoff chain', () => {
    expect(gateFixture(POSITIVE).byGate[CYCLES].diagnostics).toEqual([]);
  });

  it('rejects a two-agent handoff cycle and names the path', () => {
    const { diagnostics } = gateFixture('agents-handoff-cycle.yaml').byGate[CYCLES];
    const cycle = onlyDiagnosticWith(diagnostics, IR_DIAGNOSTIC_CODES.agentsHandoffCycle);
    expect(cycle.severity).toBe('error');
    expect(cycle.message).toContain('escalation -> support -> escalation');
    expect(cycle.message).toContain('never returns');
    expect(cycle.path.slice(0, 2)).toEqual(['agents', 'escalation']);
  });

  it('rejects a self-handoff', () => {
    const ir = mutateIR(POSITIVE);
    byId(ir.agents, 'support').handoffs = ['support'];
    const cycle = onlyDiagnosticWith(
      runGates(ir).byGate[CYCLES].diagnostics,
      IR_DIAGNOSTIC_CODES.agentsHandoffCycle,
    );
    expect(cycle.message).toContain('support -> support');
  });

  it('reports one cycle in a three-agent loop once, not once per entry point', () => {
    const ir = mutateIR(POSITIVE);
    byId(ir.agents, 'escalation').handoffs = ['support'];
    byId(ir.agents, 'support').handoffs = ['escalation'];
    // Both agents are entry points into the same cycle; the walk must not report it
    // twice, or a reviewer cannot tell one defect from two.
    expect(runGates(ir).byGate[CYCLES].diagnostics).toHaveLength(1);
  });

  it('reports two disjoint cycles separately', () => {
    const ir = mutateIR(POSITIVE);
    const escalation = byId(ir.agents, 'escalation');
    escalation.handoffs = ['escalation'];
    byId(ir.agents, 'support').handoffs = ['support'];
    expect(codesOf(runGates(ir).byGate[CYCLES].diagnostics)).toEqual([
      IR_DIAGNOSTIC_CODES.agentsHandoffCycle,
      IR_DIAGNOSTIC_CODES.agentsHandoffCycle,
    ]);
  });
});

describe('agents/budgets', () => {
  it('accepts a loop bounded by a token budget and a single-step agent with none', () => {
    const { byGate, ir } = gateFixture(POSITIVE);
    expect(byGate[BUDGETS].diagnostics).toEqual([]);
    // The single-step agent is the reason the rule is "maxSteps > 1", and asserting
    // its shape keeps that distinction from being lost if the fixture is edited.
    expect(byId(ir.agents, 'escalation').maxSteps).toBe(1);
    expect(byId(ir.agents, 'escalation').maxTokensBudget).toBeUndefined();
  });

  it('rejects a multi-step agent with no budget at all', () => {
    const { diagnostics } = gateFixture('agents-unbounded.yaml').byGate[BUDGETS];
    const unbounded = onlyDiagnosticWith(diagnostics, IR_DIAGNOSTIC_CODES.agentsBudget);
    expect(unbounded.severity).toBe('error');
    expect(unbounded.path).toEqual(['agents', 'support', 'maxTokensBudget']);
    expect(unbounded.message).toContain('neither maxTokensBudget nor maxCostBudget');
  });

  it('accepts a cost budget in place of a token budget', () => {
    const ir = mutateIR(POSITIVE);
    const support = byId(ir.agents, 'support');
    support.maxTokensBudget = undefined;
    support.maxCostBudget = 0.5;
    expect(runGates(ir).byGate[BUDGETS].diagnostics).toEqual([]);
  });

  it('rejects a budget that is not a usable bound', () => {
    const cases: Array<[string, (ir: IR) => void]> = [
      [
        'maxSteps 0',
        (ir) => {
          byId(ir.agents, 'support').maxSteps = 0;
        },
      ],
      [
        'maxSteps fractional',
        (ir) => {
          byId(ir.agents, 'support').maxSteps = 2.5;
        },
      ],
      [
        'maxTokensBudget 0',
        (ir) => {
          byId(ir.agents, 'support').maxTokensBudget = 0;
        },
      ],
      [
        'maxCostBudget 0',
        (ir) => {
          byId(ir.agents, 'support').maxTokensBudget = undefined;
          byId(ir.agents, 'support').maxCostBudget = 0;
        },
      ],
      [
        'maxCostBudget negative',
        (ir) => {
          byId(ir.agents, 'support').maxTokensBudget = undefined;
          byId(ir.agents, 'support').maxCostBudget = -1;
        },
      ],
    ];

    for (const [label, mutate] of cases) {
      const ir = mutateIR(POSITIVE);
      mutate(ir);
      const diagnostics = runGates(ir).byGate[BUDGETS].diagnostics;
      expect(diagnostics, label).toHaveLength(1);
      expect(codesOf(diagnostics), label).toEqual([IR_DIAGNOSTIC_CODES.agentsBudget]);
    }
  });

  it('does not demand a budget from an agent that cannot loop', () => {
    const ir = mutateIR(POSITIVE);
    const support = byId(ir.agents, 'support');
    support.maxSteps = 1;
    support.maxTokensBudget = undefined;
    support.maxCostBudget = undefined;
    expect(runGates(ir).byGate[BUDGETS].diagnostics).toEqual([]);
  });
});
