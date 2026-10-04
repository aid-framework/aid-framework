import { describe, expect, it } from 'vitest';

import { catalogCostProfile, estimateEvalCost, IR_DIAGNOSTIC_CODES } from '../../src/index.js';
import { diagnosticAt, first, gateFixture, onlyDiagnosticWith } from '../helpers.js';

const UNKNOWN_PROFILE = 'cost-unknown-profile.yaml';

describe('cost gate', () => {
  it('is silent when the model is priced and no budget is declared', () => {
    expect(gateFixture('full.yaml').byGate.cost.diagnostics).toEqual([]);
  });

  it('warns when a priced run is estimated above a declared budget', () => {
    const { diagnostics } = gateFixture('cost-budget.yaml').byGate.cost;
    expect(diagnostics).toHaveLength(1);
    const over = onlyDiagnosticWith(diagnostics, IR_DIAGNOSTIC_CODES.costBudgetExceeded);
    expect(over.severity).toBe('warning');
    expect(over.path).toEqual(['evals', 'over_budget', 'metrics']);
    expect(over.message).toContain('cost gate flagged this eval');
  });

  it('compares each eval against its own budget', () => {
    const { ir } = gateFixture('cost-budget.yaml');
    const over = estimateEvalCost(
      ir,
      first(ir.evals.filter((entry) => entry.id === 'over_budget')),
    );
    const within = estimateEvalCost(
      ir,
      first(ir.evals.filter((entry) => entry.id === 'within_budget')),
    );

    expect(over.budget).toBe(0.0000001);
    expect(within.budget).toBe(100);
    expect(first(over.models).model).toBe('fast');
    expect(first(over.models).cost).toBeGreaterThan(0);
    expect(over.cost).toBe(within.cost);

    const cost = over.cost;
    const budget = over.budget;
    if (cost === undefined || budget === undefined) {
      throw new Error('expected a priced estimate with a budget');
    }
    expect(cost).toBeGreaterThan(budget);
  });

  it('fails closed: an unpriced model with a declared budget is an error', () => {
    const { diagnostics } = gateFixture(UNKNOWN_PROFILE).byGate.cost;
    const rejected = diagnosticAt(diagnostics, 'evals.budgeted.metrics');
    expect(rejected.code).toBe(IR_DIAGNOSTIC_CODES.costProfileUnknown);
    expect(rejected.severity).toBe('error');
    expect(rejected.message).toContain('cost gate rejected this eval');
    expect(rejected.message).toContain('cannot be enforced');
  });

  it('warns rather than fails when an unpriced model has no budget to violate', () => {
    const { diagnostics } = gateFixture(UNKNOWN_PROFILE).byGate.cost;
    const warned = diagnosticAt(diagnostics, 'evals.unbudgeted.target');
    expect(warned.code).toBe(IR_DIAGNOSTIC_CODES.costProfileUnknown);
    expect(warned.severity).toBe('warning');
    expect(warned.message).toContain('cost gate could not price this eval');
  });

  it('keeps the fail-closed and fail-open cases apart', () => {
    const { diagnostics } = gateFixture(UNKNOWN_PROFILE).byGate.cost;
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.map((diagnostic) => diagnostic.severity)).toEqual(['error', 'warning']);
  });

  it('prices from the offline catalogue, so a lookup is deterministic', () => {
    expect(catalogCostProfile('gpt-4o-mini')).toBeDefined();
    expect(catalogCostProfile('gpt-4o-mini')).toEqual(catalogCostProfile('gpt-4o-mini'));
    expect(catalogCostProfile('ghost-unlisted-1')).toBeUndefined();
  });
});
