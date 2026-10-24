/**
 * Cost accounting and budget enforcement.
 *
 * A budget is only real if it is checked after the spend is recorded, so the test that
 * matters most here is the one asserting the ledger still tells the truth *after* it
 * threw: a caller that catches `BudgetExceededError` must be able to report what was
 * actually spent, not what it hoped to spend.
 */

import { describe, expect, it } from 'vitest';

import {
  Budget,
  BudgetExceededError,
  CostLedger,
  estimateCostUsd,
  estimatePromptCostUsd,
  LedgerEntry,
} from '../src/index.js';
import { largeSpec, smallSpec, usage } from './support.js';

function entry(costUsd: number, tokens = usage(100, 50), model = 'fake-small-1'): LedgerEntry {
  return new LedgerEntry({
    alias: 'small',
    model,
    provider: 'fake',
    usage: tokens,
    costUsd,
  });
}

describe('Budget', () => {
  it('defaults its scope to the run', () => {
    expect(new Budget({ maxUsd: 1 }).scope).toBe('run');
    expect(new Budget({ maxUsd: 1, scope: 'nightly' }).scope).toBe('nightly');
  });

  it('refuses a budget with nothing to enforce', () => {
    expect(() => new Budget({})).toThrow(/must set maxUsd, maxTotalTokens, or both/);
  });

  it('refuses a negative or non-finite dollar ceiling', () => {
    expect(() => new Budget({ maxUsd: -1 })).toThrow(/maxUsd must be a non-negative number/);
    expect(() => new Budget({ maxUsd: Number.POSITIVE_INFINITY })).toThrow(
      /maxUsd must be a non-negative number/,
    );
  });

  it('refuses a token ceiling that is not a positive integer', () => {
    expect(() => new Budget({ maxTotalTokens: 0 })).toThrow(/maxTotalTokens must be a positive/);
    expect(() => new Budget({ maxTotalTokens: 1.5 })).toThrow(/maxTotalTokens must be a positive/);
  });
});

describe('estimateCostUsd', () => {
  it('prices against the pinned model, not a global table', () => {
    expect(estimateCostUsd(smallSpec(), usage(1000, 1000))).toBeCloseTo(0.75, 10);
    expect(estimateCostUsd(largeSpec(), usage(1000, 1000))).toBeCloseTo(12.5, 10);
  });
});

describe('estimatePromptCostUsd', () => {
  it('charges four characters per token, as the retrieval estimator does', () => {
    const text = 'x'.repeat(400);
    // 400 characters is 100 tokens: 0.15 per 1k on the fake small model.
    expect(estimatePromptCostUsd(smallSpec(), text)).toBeCloseTo(0.015, 10);
  });

  it('prices the empty prompt at zero', () => {
    expect(estimatePromptCostUsd(smallSpec(), '')).toBe(0);
  });
});

describe('CostLedger', () => {
  it('starts empty', () => {
    const ledger = new CostLedger();
    expect(ledger.costUsd).toBe(0);
    expect(ledger.totalTokens).toBe(0);
    expect(ledger.entries).toEqual([]);
  });

  it('accumulates cost and tokens across calls', () => {
    const ledger = new CostLedger();
    ledger.charge(undefined, entry(0.25));
    ledger.charge(undefined, entry(0.5, usage(10, 20)));

    expect(ledger.costUsd).toBe(0.75);
    expect(ledger.totalTokens).toBe(150 + 30);
    expect(ledger.entries).toHaveLength(2);
  });

  it('summarises by model so a log line can attribute spend', () => {
    const ledger = new CostLedger();
    ledger.charge(undefined, entry(0.25));
    ledger.charge(undefined, entry(0.5, usage(10, 20), 'fake-large-1'));

    const summary = ledger.summary();
    expect(summary.calls).toBe(2);
    expect(summary.costUsd).toBe(0.75);
    expect(summary.totalTokens).toBe(180);
    expect(summary.byModel).toEqual({ 'fake-small-1': 0.25, 'fake-large-1': 0.5 });
  });

  it('allows spending exactly up to the ceiling', () => {
    const ledger = new CostLedger();
    const budget = new Budget({ maxUsd: 0.5 });

    expect(() => ledger.charge(budget, entry(0.5))).not.toThrow();
    expect(ledger.costUsd).toBe(0.5);
  });

  it('refuses to cross the dollar ceiling', () => {
    const ledger = new CostLedger();
    const budget = new Budget({ maxUsd: 0.5, scope: 'run' });

    ledger.charge(budget, entry(0.3));
    // The entry lands first: truthful accounting beats a clean pre-check.
    expect(() => ledger.charge(budget, entry(0.3))).toThrow(BudgetExceededError);
    expect(ledger.costUsd).toBe(0.6);
  });

  it('says what it spent, what it was allowed and by how much it went over', () => {
    const ledger = new CostLedger();
    const budget = new Budget({ maxUsd: 0.5, scope: 'run' });
    ledger.charge(budget, entry(0.3));

    expect(() => ledger.charge(budget, entry(0.3))).toThrow(
      /budget 'run' exceeded: limit \$0\.500000, spent \$0\.600000 \(over by \$0\.100000\)/,
    );
  });

  it('refuses to cross a token ceiling, in tokens', () => {
    const ledger = new CostLedger();
    const budget = new Budget({ maxTotalTokens: 100 });

    expect(() => ledger.charge(budget, entry(0.01, usage(80, 30)))).toThrow(
      /limit 100 tokens, spent 110 tokens/,
    );
  });

  it('rechecks the current total rather than only the new call', () => {
    const ledger = new CostLedger();
    const budget = new Budget({ maxUsd: 1 });
    ledger.charge(budget, entry(0.9));

    // Nothing about this call is over a dollar; the running total is.
    expect(() => ledger.check(budget)).not.toThrow();
    expect(() => ledger.charge(budget, entry(0.2))).toThrow(BudgetExceededError);
  });
});
