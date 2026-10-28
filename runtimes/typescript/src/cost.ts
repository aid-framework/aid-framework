/**
 * Cost accounting and budget enforcement.
 *
 * Cost is the budget this runtime enforces. A latency p95 budget is deliberately
 * absent: it is only meaningful next to a dashboard, and a gate nobody reads is not
 * a gate.
 */

import { BudgetExceededError } from './errors.js';
import { roundTo } from './internal/json.js';
import { type ModelSpec, TokenUsage } from './types.js';

/**
 * Prices are quoted per 1k tokens, so a call costs fractions of a cent. Six
 * decimals keeps a single call representable without letting float error accumulate
 * visibly over a long run.
 */
const USD_PRECISION = 6;

/** A spending ceiling for one scope (a run, a request, a nightly job). */
export class Budget {
  readonly maxUsd: number | undefined;
  readonly maxTotalTokens: number | undefined;
  readonly scope: string;

  constructor(init: {
    readonly maxUsd?: number;
    readonly maxTotalTokens?: number;
    readonly scope?: string;
  }) {
    if (init.maxUsd === undefined && init.maxTotalTokens === undefined) {
      throw new RangeError('a budget must set maxUsd, maxTotalTokens, or both');
    }
    if (init.maxUsd !== undefined && (!Number.isFinite(init.maxUsd) || init.maxUsd < 0)) {
      throw new RangeError('maxUsd must be a non-negative number');
    }
    if (
      init.maxTotalTokens !== undefined &&
      (!Number.isInteger(init.maxTotalTokens) || init.maxTotalTokens <= 0)
    ) {
      throw new RangeError('maxTotalTokens must be a positive integer');
    }
    this.maxUsd = init.maxUsd;
    this.maxTotalTokens = init.maxTotalTokens;
    this.scope = init.scope ?? 'run';
  }
}

/** One charged model call. */
export class LedgerEntry {
  readonly alias: string;
  readonly model: string;
  readonly provider: string;
  readonly usage: TokenUsage;
  readonly costUsd: number;

  constructor(init: {
    readonly alias: string;
    readonly model: string;
    readonly provider: string;
    readonly usage: TokenUsage;
    readonly costUsd: number;
  }) {
    this.alias = init.alias;
    this.model = init.model;
    this.provider = init.provider;
    this.usage = init.usage;
    this.costUsd = init.costUsd;
  }
}

/** Aggregate spend, suitable for a log line or an OTel span attribute. */
export class SpendSummary {
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly byModel: Readonly<Record<string, number>>;

  constructor(init: {
    readonly calls: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly costUsd: number;
    readonly byModel?: Record<string, number>;
  }) {
    this.calls = init.calls;
    this.inputTokens = init.inputTokens;
    this.outputTokens = init.outputTokens;
    this.costUsd = init.costUsd;
    this.byModel = init.byModel ?? {};
  }

  get totalTokens(): number {
    return this.inputTokens + this.outputTokens;
  }
}

/** Price a call against a pinned model's published cost. */
export function estimateCostUsd(spec: ModelSpec, usage: TokenUsage): number {
  return spec.cost.costUsd(usage);
}

/**
 * The runtime's token estimate for a text: four characters per token.
 *
 * The same approximation `estimatePromptCostUsd` uses, exposed because agent memory has to
 * agree with it: a transcript trimmed against one estimate and priced against another would
 * report a budget it did not honour.
 */
export function estimateTokens(text: string): number {
  return (text.length + 3) >> 2;
}

/**
 * Rough pre-flight price for a prompt, used to fail before spending.
 *
 * Four characters per token is the usual English approximation. It is deliberately
 * an approximation, and the same one `estimate_tokens` uses in retrieval, so an
 * offline estimate and an offline charge cannot disagree about what a text costs.
 */
export function estimatePromptCostUsd(spec: ModelSpec, text: string): number {
  return spec.cost.costUsd(new TokenUsage({ inputTokens: estimateTokens(text) }));
}

/**
 * Accumulates spend and refuses to let a budget be crossed.
 *
 * The ledger is intentionally not concurrency-safe: a gateway owns one ledger per
 * logical run, and sharing one across concurrent runs would make "spent so far"
 * meaningless.
 */
export class CostLedger {
  private readonly _entries: LedgerEntry[] = [];

  get entries(): readonly LedgerEntry[] {
    return this._entries;
  }

  get costUsd(): number {
    return roundTo(
      this._entries.reduce((total, entry) => total + entry.costUsd, 0),
      USD_PRECISION,
    );
  }

  get totalTokens(): number {
    return this._entries.reduce((total, entry) => total + entry.usage.totalTokens, 0);
  }

  /** Raise if current spend already violates `budget`. */
  check(budget: Budget): void {
    this.checkUsd(budget);
    this.checkTokens(budget);
  }

  /**
   * Record a call, throwing {@link BudgetExceededError} if it overshoots.
   *
   * The entry is recorded before the check so the ledger reflects what was actually
   * spent when the error propagates: a caller that catches the error still sees
   * truthful accounting.
   */
  charge(budget: Budget | undefined, entry: LedgerEntry): void {
    this._entries.push(entry);
    if (budget === undefined) return;
    this.check(budget);
  }

  summary(): SpendSummary {
    const byModel: Record<string, number> = {};
    for (const entry of this._entries) {
      byModel[entry.model] = roundTo((byModel[entry.model] ?? 0) + entry.costUsd, USD_PRECISION);
    }
    return new SpendSummary({
      calls: this._entries.length,
      inputTokens: this._entries.reduce((total, entry) => total + entry.usage.inputTokens, 0),
      outputTokens: this._entries.reduce((total, entry) => total + entry.usage.outputTokens, 0),
      costUsd: this.costUsd,
      byModel,
    });
  }

  private checkUsd(budget: Budget): void {
    if (budget.maxUsd === undefined) return;
    const spent = this.costUsd;
    if (spent > budget.maxUsd) {
      throw new BudgetExceededError(budget.scope, budget.maxUsd, spent);
    }
  }

  private checkTokens(budget: Budget): void {
    if (budget.maxTotalTokens === undefined) return;
    const spentTokens = this.totalTokens;
    if (spentTokens > budget.maxTotalTokens) {
      throw new BudgetExceededError(budget.scope, budget.maxTotalTokens, spentTokens, 'tokens');
    }
  }
}
