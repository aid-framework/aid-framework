/**
 * Budget behaviour, driven from IR documents.
 *
 * Mirrors `tests/test_agents_budget.py` (decision D1). The span-attribute assertions in that
 * suite are tracing-only and cannot port: agent spans are decision D-7.
 *
 * Ceilings are placed using the gateway's own projection rather than by multiplying prices
 * by token counts, so a test that fails does so because the runtime disagreed, not because
 * the arithmetic here drifted. `projectedCostUsd` includes what the ledger already spent, so
 * every projection below is taken from a fresh harness.
 */

import { describe, expect, it } from 'vitest';
import {
  AgentBudgetDegradedError,
  BudgetExceededError,
  CompletionRequest,
  Message,
  ScriptedTurn,
  type ScriptedTurn as ScriptedTurnType,
  ToolCall,
} from '../src/index.js';
import {
  agentDef,
  build,
  CHEAP_COST,
  document,
  type Harness,
  type JsonObject,
  modelDef,
  promptDef,
  type Recorder,
  recordingTool,
  STRONG_COST,
  solo,
  toolDef,
} from './agent-support.js';

const SYSTEM = 'You are a helpful assistant.';
const TEXT = 'go';

interface ExpensiveOptions {
  readonly maxCostBudget?: number;
  readonly maxTokensBudget?: number;
  readonly onBudgetExhausted?: string;
  readonly longAnswer?: boolean;
}

/**
 * A one-agent document whose alias is `strong`, with `cheap` as its cheaper fallback.
 *
 * The ladder is what `onBudgetExhausted: degrade` steps down, so both aliases must exist
 * before a degrade case can prove anything. The tool is declared because the
 * degrade-then-fail case needs an observation large enough to move the projection.
 */
function expensiveDocument(options: ExpensiveOptions): JsonObject {
  return solo({
    alias: 'strong',
    models: [
      modelDef('strong', { cost: STRONG_COST, fallbacks: ['cheap'] }),
      modelDef('cheap', { cost: CHEAP_COST }),
    ],
    tools: ['search'],
    toolSpecs: [toolDef('search', 'search', { sideEffects: 'read' })],
    maxSteps: 3,
    ...options,
  }) as unknown as JsonObject;
}

function buildExpensive(
  options: ExpensiveOptions,
  script: readonly ScriptedTurnType[],
): { harness: Harness; recorder: Recorder } {
  const { tool, recorder } = recordingTool('search', {
    ...(options.longAnswer === true ? { answer: 'y'.repeat(20_000) } : {}),
  });
  const harness = build(expensiveDocument(options), { tools: [tool], script });
  return { harness, recorder };
}

/** A ceiling `strong` cannot afford and `cheap` can. */
function midpointCeiling(harness: Harness): number {
  const projections = harness.projections({ prompt: SYSTEM, text: TEXT });
  return ((projections.strong ?? Number.NaN) + (projections.cheap ?? Number.NaN)) / 2;
}

describe('agent budgets', () => {
  it('fails hard on a breach by default, charging nothing', async () => {
    const { harness: probe } = buildExpensive({}, []);
    const ceiling = midpointCeiling(probe);

    const { harness } = buildExpensive({ maxCostBudget: ceiling }, [ScriptedTurn.answer('hi')]);

    await expect(harness.runtime.run('solo', TEXT)).rejects.toThrow(BudgetExceededError);
    expect(harness.ledger.entries).toHaveLength(0);
    expect(harness.provider.calls).toHaveLength(0);
  });

  it('makes the same ceiling affordable when the agent degrades', async () => {
    const { harness: probe } = buildExpensive({}, []);
    const ceiling = midpointCeiling(probe);

    const { harness } = buildExpensive({ maxCostBudget: ceiling, onBudgetExhausted: 'degrade' }, [
      ScriptedTurn.answer('hi'),
    ]);
    const result = await harness.runtime.run('solo', TEXT);

    expect(result.status).toBe('completed');
    expect(result.degraded).toEqual([['strong', 'cheap']]);
    expect(harness.aliasesCharged()).toEqual(['cheap']);
  });

  it('steps down once, then fails when even the cheaper alias does not fit', async () => {
    const longText = 'y'.repeat(20_000);
    const short = new CompletionRequest({
      messages: [Message.system(SYSTEM), Message.user(TEXT)],
    });
    const long = new CompletionRequest({
      messages: [
        Message.system(SYSTEM),
        Message.user(TEXT),
        Message.assistantToolCalls('', [
          new ToolCall({ id: 'call_0_0', name: 'search', arguments: { query: 'q' } }),
        ]),
        Message.tool('call_0_0', longText),
      ],
    });

    const { harness: probe } = buildExpensive({ longAnswer: true }, []);
    const cheapShort = probe.gateway.projectedCostUsd('cheap', short);
    const cheapLong = probe.gateway.projectedCostUsd('cheap', long);
    const strongShort = probe.gateway.projectedCostUsd('strong', short);
    // `strong`'s first call must not fit (so the agent steps down), `cheap`'s first call
    // must fit (so the step-down is allowed), and `cheap`'s second call must not.
    const ceiling = cheapShort + (Math.min(strongShort, cheapLong) - cheapShort) / 2;

    const { harness, recorder } = buildExpensive(
      { maxCostBudget: ceiling, onBudgetExhausted: 'degrade', longAnswer: true },
      [ScriptedTurn.tool('search', { query: 'q' }), ScriptedTurn.answer('done')],
    );

    await expect(harness.runtime.run('solo', TEXT)).rejects.toThrow(BudgetExceededError);
    // The tool ran once, on the degraded alias, and the *second* model call is what fails.
    expect(recorder.calls).toBe(1);
    expect(harness.aliasesCharged()).toEqual(['cheap']);
  });

  it('enforces a token ceiling with the charge, not the projection', async () => {
    const { harness } = buildExpensive({ maxTokensBudget: 1 }, [ScriptedTurn.answer('hi')]);

    await expect(harness.runtime.run('solo', TEXT)).rejects.toThrow(BudgetExceededError);
    // A token ceiling cannot be known from the prompt, so the honest accounting is one
    // recorded charge and then the refusal -- the ledger stays truthful about the spend.
    expect(harness.ledger.entries).toHaveLength(1);
  });

  it('never degrades on a token-only ceiling', async () => {
    const { harness } = buildExpensive({ maxTokensBudget: 1, onBudgetExhausted: 'degrade' }, [
      ScriptedTurn.answer('hi'),
    ]);

    await expect(harness.runtime.run('solo', TEXT)).rejects.toThrow(BudgetExceededError);
    // A token ceiling is not a price ladder: switching alias cannot make the call
    // affordable, so the pinned alias is the one that was charged.
    expect(harness.aliasesCharged()).toEqual(['strong']);
  });

  it('refuses to degrade when the alias has nowhere to step', async () => {
    const doc = document({
      models: [modelDef('cheap')],
      prompts: [promptDef('main', SYSTEM)],
      agents: [
        agentDef('solo', { model: 'cheap', maxCostBudget: 0, onBudgetExhausted: 'degrade' }),
      ],
    });
    const harness = build(doc, { script: [ScriptedTurn.answer('hi')] });

    const error = await harness.runtime.run('solo', TEXT).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(AgentBudgetDegradedError);
    expect((error as AgentBudgetDegradedError).message).toContain('ir/agents-budget-degrade');
  });
});
