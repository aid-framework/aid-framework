/**
 * The IR seam: refusals, and the resolution the loop depends on.
 *
 * Every test here starts from a *document*, because the seam is the thing under test -- a
 * runtime that only worked on hand-built specs would prove nothing about the documents the
 * compiler emits. The refusals are the load-bearing half: each one is a spec that would
 * otherwise reach the loop as a dangling reference or an unenforceable budget.
 */

import { describe, expect, it } from 'vitest';

import {
  type AgentDefinition,
  ConfigurationError,
  fromIr,
  hasControlTools,
  RuntimeSpec,
  stageGuardrails,
} from '../src/index.js';
import {
  agentDef,
  at,
  document,
  guardrailDef,
  type JsonObject,
  memoryDef,
  modelDef,
  promptDef,
  STRONG_COST,
  solo,
  toolDef,
} from './agent-support.js';

function parse(doc: JsonObject): RuntimeSpec {
  return fromIr(doc as unknown as Record<string, unknown>);
}

function expectRefusal(doc: JsonObject, pattern: RegExp): void {
  expect(() => parse(doc)).toThrow(ConfigurationError);
  expect(() => parse(doc)).toThrow(pattern);
}

describe('fromIr resolves references or refuses the document', () => {
  it('refuses an agent whose prompt the document does not declare', () => {
    const doc = solo();
    at(doc, 'agents').instructions = 'missing';

    expectRefusal(doc, /names prompt 'missing', which the IR does not declare/);
  });

  it('refuses an agent naming a tool the document does not declare', () => {
    expectRefusal(solo({ tools: ['ghost'] }), /names undeclared tools: \['ghost'\]/);
  });

  it('refuses an agent naming memory the document does not declare', () => {
    const doc = document({
      models: [modelDef('cheap')],
      prompts: [promptDef('main', 'be helpful')],
      agents: [agentDef('solo', { memory: ['ghost'] })],
    });

    expectRefusal(doc, /names undeclared memory: \['ghost'\]/);
  });

  it('refuses an agent naming a guardrail the document does not declare', () => {
    const doc = document({
      models: [modelDef('cheap')],
      prompts: [promptDef('main', 'be helpful')],
      agents: [agentDef('solo', { guardrails: ['ghost'] })],
    });

    expectRefusal(doc, /names undeclared guardrails: \['ghost'\]/);
  });

  it('refuses a budget policy outside the closed vocabulary', () => {
    const doc = document({
      models: [modelDef('cheap')],
      prompts: [promptDef('main', 'be helpful')],
      agents: [agentDef('solo', { onBudgetExhausted: 'retry' })],
    });

    expectRefusal(doc, /has onBudgetExhausted 'retry'; expected one of \['degrade', 'fail'\]/);
  });

  it('refuses a maxSteps that could not take one step', () => {
    const doc = document({
      models: [modelDef('cheap')],
      prompts: [promptDef('main', 'be helpful')],
      agents: [agentDef('solo', { maxSteps: 0 })],
    });

    expectRefusal(doc, /needs a positive maxSteps, got 0/);
  });

  it('refuses a guardrail naming an unknown stage', () => {
    const doc = solo({ guardrailSpecs: [guardrailDef('g', { stages: ['sideways'] })] });

    expectRefusal(doc, /names unknown stages \['sideways'\]/);
  });

  it('refuses a guardrail naming an unknown policy', () => {
    const doc = solo({ guardrailSpecs: [guardrailDef('g', { policies: ['vibes'] })] });

    expectRefusal(doc, /names unknown policies \['vibes'\]/);
  });

  it('refuses a guardrail action outside the closed set', () => {
    const doc = solo({ guardrailSpecs: [guardrailDef('g', { action: 'pause' })] });

    expectRefusal(doc, /has action 'pause'; expected one of \[/);
  });

  it('refuses a redact action that names no field', () => {
    const doc = solo({ guardrailSpecs: [guardrailDef('g', { action: 'redact' })] });

    expectRefusal(doc, /uses action 'redact' with no redact fields/);
  });

  it('refuses a guardrail naming an undeclared tool', () => {
    const doc = solo({
      guardrailSpecs: [guardrailDef('g', { stages: ['tool-call'], tools: ['ghost'] })],
    });

    expectRefusal(doc, /names undeclared tools: \['ghost'\]/);
  });

  it('refuses a guardrail with no onFail block', () => {
    const doc = solo({ guardrailSpecs: [guardrailDef('g')] });
    delete at(doc, 'guardrails').onFail;

    expectRefusal(doc, /needs an onFail object/);
  });

  it('refuses a tool side-effect value the runtime cannot classify', () => {
    const doc = solo({ toolSpecs: [toolDef('t', 'search')] });
    at(doc, 'tools').sideEffects = 'sometimes';

    expectRefusal(doc, /has sideEffects 'sometimes'; expected one of \[/);
  });

  it('refuses humanInTheLoop with no channel to ask on', () => {
    const doc = document({
      models: [modelDef('cheap')],
      prompts: [promptDef('main', 'be helpful')],
      agents: [agentDef('solo', { hitl: { when: { kind: 'always' } } })],
    });

    expectRefusal(doc, /declares humanInTheLoop with no channel/);
  });

  it('refuses humanInTheLoop whose when is not a parsed policy', () => {
    const doc = document({
      models: [modelDef('cheap')],
      prompts: [promptDef('main', 'be helpful')],
      agents: [agentDef('solo', { hitl: { channel: 'review', when: 'admin' } })],
    });

    expectRefusal(doc, /humanInTheLoop needs a parsed 'when' policy/);
  });

  it('refuses humanInTheLoop that is not an object', () => {
    const doc = solo();
    at(doc, 'agents').humanInTheLoop = 'yes';

    expectRefusal(doc, /humanInTheLoop must be an object/);
  });

  it('refuses a model with no resolved costProfile', () => {
    const doc = solo({
      models: [
        {
          id: 'cheap',
          modelId: 'cheap-1',
          provider: 'fake',
          capabilities: ['tool-calling'],
          limits: { contextTokens: 1000 },
        },
      ],
    });

    expectRefusal(doc, /has no resolved costProfile/);
  });

  it('refuses a model with no limits', () => {
    const doc = solo({
      models: [
        {
          id: 'cheap',
          modelId: 'cheap-1',
          provider: 'fake',
          capabilities: ['tool-calling'],
          costProfile: { ...STRONG_COST },
        },
      ],
    });

    expectRefusal(doc, /has no limits/);
  });

  it('refuses a model with no positive context window', () => {
    const doc = solo({
      models: [
        {
          id: 'cheap',
          modelId: 'cheap-1',
          provider: 'fake',
          capabilities: ['tool-calling'],
          costProfile: { ...STRONG_COST },
          limits: { contextTokens: 0 },
        },
      ],
    });

    expectRefusal(doc, /has no positive limits\.contextTokens/);
  });

  it('refuses a memory with no positive token budget', () => {
    const doc = solo({ memory: [memoryDef('m')] });
    at(doc, 'memory').tokenBudget = 0;

    expectRefusal(doc, /needs a positive tokenBudget/);
  });

  it('refuses handoff and delegate targets that are not agents', () => {
    const doc = document({
      models: [modelDef('cheap')],
      prompts: [promptDef('main', 'be helpful')],
      agents: [agentDef('main', { handoffs: ['ghost'] })],
    });

    expectRefusal(doc, /handoffs undeclared agents: \['ghost'\]/);
  });

  it('refuses an agent that lists itself as a control target', () => {
    const doc = document({
      models: [modelDef('cheap')],
      prompts: [promptDef('main', 'be helpful')],
      agents: [agentDef('main', { handoffs: ['main'] })],
    });

    expectRefusal(doc, /handoffs itself; a control edge must leave the agent/);
  });

  it('refuses a target listed in both control lists', () => {
    const doc = document({
      models: [modelDef('cheap')],
      prompts: [promptDef('main', 'be helpful')],
      agents: [
        agentDef('main', { handoffs: ['worker'], delegates: ['worker'] }),
        agentDef('worker', { prompt: 'main' }),
      ],
    });

    expectRefusal(doc, /in both handoffs and delegates/);
  });

  it('refuses a collection that is not an array', () => {
    const doc = solo();
    doc.models = 'nope';

    expectRefusal(doc, /IR models must be an array/);
  });

  it('refuses a collection entry that is not an object', () => {
    const doc = solo();
    doc.models = ['nope'];

    expectRefusal(doc, /IR models contains a non-object entry/);
  });

  it('refuses a collection entry with no id', () => {
    const doc = solo();
    doc.models = [{ modelId: 'cheap-1' }];

    expectRefusal(doc, /IR models contains an entry with no id/);
  });
});

describe('RuntimeSpec resolution', () => {
  it('names the declared agents when an id is absent', () => {
    const spec = parse(solo());

    expect(() => spec.agent('ghost')).toThrow(
      /no agent 'ghost' in the IR; declared agents: \['solo'\]/,
    );
  });

  it('names the declared models when an alias is absent', () => {
    const spec = parse(solo());

    expect(() => spec.price('ghost')).toThrow(
      /no model 'ghost' in the IR; declared models: \['cheap'\]/,
    );
  });

  it('refuses a prompt the registry does not hold', () => {
    const base = parse(solo());
    const empty = new RuntimeSpec({
      models: base.models,
      fallbacks: base.fallbacks,
      prompts: new Map(),
      tools: base.tools,
      agents: base.agents,
    });

    expect(() => empty.systemPrompt(base.agent('solo'))).toThrow(
      /names prompt 'main', which the IR does not declare/,
    );
  });

  it('refuses a tool the tool registry does not hold', () => {
    const base = parse(solo());
    const agent: AgentDefinition = { ...base.agent('solo'), tools: ['ghost'] };
    const empty = new RuntimeSpec({
      models: base.models,
      fallbacks: base.fallbacks,
      prompts: base.prompts,
      tools: new Map(),
      agents: base.agents,
    });

    expect(() => empty.toolSpecs(agent)).toThrow(/no tool 'ghost' in the IR/);
  });

  it('steps down one rung, and only to a strictly cheaper alias', () => {
    const ladder = parse(
      solo({
        alias: 'dear',
        models: [modelDef('dear', { cost: STRONG_COST, fallbacks: ['cheap'] }), modelDef('cheap')],
      }),
    );

    expect(ladder.cheaperFallback('dear')).toBe('cheap');
    expect(ladder.cheaperFallback('cheap')).toBeUndefined();
  });

  it('will not call a dearer fallback a rung of the ladder', () => {
    const upwards = parse(
      solo({
        alias: 'cheap',
        models: [
          modelDef('cheap', { fallbacks: ['dear'] }),
          modelDef('dear', { cost: STRONG_COST }),
        ],
      }),
    );

    expect(upwards.cheaperFallback('cheap')).toBeUndefined();
  });

  it('resolves every fallback of every reachable alias', () => {
    const ladder = parse(
      solo({
        alias: 'dear',
        models: [modelDef('dear', { cost: STRONG_COST, fallbacks: ['cheap'] }), modelDef('cheap')],
      }),
    );

    expect([...ladder.models.keys()].sort()).toEqual(['cheap', 'dear']);
    expect([...ladder.fallbacksFor('dear')]).toEqual(['cheap']);
    expect([...ladder.fallbacksFor('cheap')]).toEqual([]);
  });

  it('maps the IR capability vocabulary onto the runtime one', () => {
    const spec = parse(
      solo({
        models: [modelDef('cheap', { capabilities: ['tool-calling', 'json-schema', 'vibes'] })],
      }),
    );

    expect([...(spec.models.get('cheap')?.capabilities ?? [])].sort()).toEqual([
      'structured-output',
      'tool-calling',
    ]);
  });

  it('falls back to the context window when no output ceiling is declared', () => {
    const spec = parse(
      solo({
        models: [
          {
            id: 'cheap',
            modelId: 'cheap-1',
            provider: 'fake',
            capabilities: ['tool-calling'],
            costProfile: { ...STRONG_COST },
            limits: { contextTokens: 1000 },
          },
        ],
      }),
    );

    expect(spec.models.get('cheap')?.contextWindow).toBe(1000);
    expect(spec.models.get('cheap')?.maxOutputTokens).toBe(1000);
  });

  it('reads the concurrency cap as the highest declared limit', () => {
    const doc = solo();
    doc.deployments = [{ concurrency: 4 }, { concurrency: 8 }, { concurrency: 0 }, 'nope'];

    expect(parse(doc).concurrency).toBe(8);
  });

  it('reports no concurrency cap when none is declared', () => {
    expect(parse(solo()).concurrency).toBeUndefined();
  });

  it('knows which agents may move control', () => {
    const doc = document({
      models: [modelDef('cheap')],
      prompts: [promptDef('main', 'be helpful')],
      agents: [agentDef('main', { handoffs: ['worker'] }), agentDef('worker', { prompt: 'main' })],
    });
    const spec = parse(doc);

    expect(hasControlTools(spec.agent('main'))).toBe(true);
    expect(hasControlTools(spec.agent('worker'))).toBe(false);
  });

  it('selects the guardrails declared for one stage', () => {
    const spec = parse(solo({ guardrailSpecs: [guardrailDef('g', { stages: ['output'] })] }));
    const agent = spec.agent('solo');

    expect(stageGuardrails(agent, 'output').map((entry) => entry.id)).toEqual(['g']);
    expect(stageGuardrails(agent, 'input')).toEqual([]);
  });
});
