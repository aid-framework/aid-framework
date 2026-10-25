/**
 * `agents/budget-degrade` is the L2 gate for the field L1's shapes left optional.
 *
 * The rule is deliberately narrower than "degrade is allowed": a degrade promise is
 * only truthful when a budget breach has somewhere strictly cheaper to go. These
 * tests invert each half of that promise.
 */

import { describe, expect, it } from 'vitest';

import { IR_DIAGNOSTIC_CODES, runGates } from '../../src/index.js';
import { byId, gateFixture, mutateIR } from '../helpers.js';

const GATE = 'agents/budget-degrade' as const;

describe('agents/budget-degrade', () => {
  it('accepts an agent with a cost ceiling and a strictly cheaper fallback', () => {
    const { byGate } = gateFixture('agents-degrade.yaml');
    expect(byGate[GATE].diagnostics).toEqual([]);
  });

  it('rejects degrade without a cost ceiling, because tokens do not get cheaper', () => {
    const ir = mutateIR('agents-degrade.yaml');
    const agent = byId(ir.agents, 'support');
    delete agent.maxCostBudget;
    agent.maxTokensBudget = 4096;

    const { diagnostics } = runGates(ir).byGate[GATE];
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe(IR_DIAGNOSTIC_CODES.agentsBudgetDegrade);
    expect(diagnostics[0]?.path).toEqual(['agents', 'support', 'onBudgetExhausted']);
    expect(diagnostics[0]?.message).toContain('declares no maxCostBudget');
    expect(diagnostics[0]?.hint).toContain('onBudgetExhausted: fail');
  });

  it('rejects degrade when the model declares no fallbacks', () => {
    const ir = mutateIR('agents-degrade.yaml');
    byId(ir.models, 'strong').fallbacks = [];

    const { diagnostics } = runGates(ir).byGate[GATE];
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain('no fallback alias that is strictly cheaper');
    expect(diagnostics[0]?.hint).toContain('declare at least one cheaper alias');
  });

  it('rejects degrade when every fallback is at least as expensive', () => {
    const ir = mutateIR('agents-degrade.yaml');
    byId(ir.models, 'strong').fallbacks = ['pricey'];
    ir.models.push({
      ...byId(ir.models, 'cheap'),
      id: 'pricey',
      costProfile: { inputPerMTok: 2.5, outputPerMTok: 10 },
    });

    const { diagnostics } = runGates(ir).byGate[GATE];
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.hint).toContain('are not cheaper than');
  });

  it('rejects degrade when no alias has a cost profile to prove it cheaper', () => {
    const ir = mutateIR('agents-degrade.yaml');
    delete byId(ir.models, 'strong').costProfile;
    delete byId(ir.models, 'cheap').costProfile;

    const { diagnostics } = runGates(ir).byGate[GATE];
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.hint).toContain('no costProfile');
  });

  it('leaves an agent that did not ask for degrade alone', () => {
    const ir = mutateIR('agents-degrade.yaml');
    const agent = byId(ir.agents, 'support');
    agent.onBudgetExhausted = 'fail';
    byId(ir.models, 'strong').fallbacks = [];

    expect(runGates(ir).byGate[GATE].diagnostics).toEqual([]);
  });

  it('populates the field only when the spec declares it', () => {
    const degraded = gateFixture('agents-degrade.yaml').ir;
    expect(byId(degraded.agents, 'support').onBudgetExhausted).toBe('degrade');

    const plain = gateFixture('agents.yaml').ir;
    expect(Object.hasOwn(byId(plain.agents, 'support'), 'onBudgetExhausted')).toBe(false);
  });
});
