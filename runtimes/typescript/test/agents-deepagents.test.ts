/**
 * The opt-in `deepagents` engine, driven from IR documents.
 *
 * Mirrors `tests/test_agents_deep_agents.py`, which is the contract. Every case starts from
 * an emitted document, because the question this file answers is not "does the harness
 * work" but "does an agent that names `engine: deepagents` still go through *our* gateway,
 * guardrails, budget and tool executor".
 *
 * The suite is hermetic. The only provider is `FakeProvider`, so no case can reach a
 * network, and LangSmith tracing is switched off before the harness is imported -- a test
 * that called out to LangSmith would be a defect, not a slow test.
 *
 * Agent-level spans are decision D-7 and cannot port. Model spans can, because the harness
 * generates through `GatewayChatModel` and the gateway opens the span, so the fake tracer
 * provider below records exactly what `getTracer()` was asked to start.
 */

import { type TracerProvider, trace } from '@opentelemetry/api';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  ACTION_BLOCK,
  ACTION_REDACT,
  type AgentDefinition,
  BudgetExceededError,
  checkEngine,
  DEEPAGENTS,
  DEEPAGENTS_EXTRA,
  DEEPAGENTS_PIN,
  DeepAgentsUnavailableError,
  DeepAgentsVersionMismatchError,
  GuardrailBlockedError,
  installedDeepagentsVersion,
  Principal,
  ScriptedTurn,
  ToolPermissionError,
} from '../src/index.js';
import { FakeProvider } from '../src/providers/fake.js';
import {
  agentDef,
  build,
  CHEAP_COST,
  document,
  guardrailDef,
  modelDef,
  PROVIDER,
  promptDef,
  recordingTool,
  solo,
  toolDef,
} from './agent-support.js';

// Set before any import of the harness can read them. `LANGSMITH_TRACING` is the current
// variable; `LANGCHAIN_TRACING_V2` is the older spelling some transitive copies still read.
process.env.LANGSMITH_TRACING = 'false';
process.env.LANGCHAIN_TRACING_V2 = 'false';
process.env.LANGCHAIN_TRACING = 'false';

/** One recorded chat span: the name the gateway asked for, plus the attributes set. */
class RecordingSpan {
  readonly attributes = new Map<string, unknown>();
  ended = false;

  constructor(readonly name: string) {}

  setAttribute(key: string, value: unknown): this {
    this.attributes.set(key, value);
    return this;
  }

  setStatus(): this {
    return this;
  }

  recordException(): void {}

  end(): void {
    this.ended = true;
  }
}

/** No OTel SDK is installed here, so span *starts* are recorded by a fake provider. */
const started: RecordingSpan[] = [];

const provider = {
  getTracer() {
    return {
      startSpan(name: string) {
        const span = new RecordingSpan(name);
        started.push(span);
        return span;
      },
    };
  },
} as unknown as TracerProvider;

trace.setGlobalTracerProvider(provider);

afterAll(() => {
  trace.disable();
});

function spanNamesSince(baseline: number): string[] {
  return started.slice(baseline).map((span) => span.name);
}

const PROMPT = 'You are a helpful assistant.';
const ADMIN = { kind: 'call', name: 'hasRole', args: [{ kind: 'string', value: 'admin' }] };

/** An `AgentDefinition` on its own, for the engine-seam cases that need no document. */
function agentDefinition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: 'triage',
    name: 'Triage',
    instructions: 'triage',
    model: 'cheap',
    tools: [],
    memory: [],
    maxSteps: 4,
    maxTokensBudget: undefined,
    maxCostBudget: undefined,
    onBudgetExhausted: 'fail',
    handoffs: [],
    delegates: [],
    engine: 'native',
    engineVersion: '',
    approval: undefined,
    guardrails: [],
    ...overrides,
  };
}

/** A one-agent document naming the deepagents engine at this runtime's pin. */
function gated(options: Parameters<typeof solo>[0] = {}) {
  return solo({ ...options, engine: DEEPAGENTS, engineVersion: DEEPAGENTS_PIN });
}

describe('the engine seam', () => {
  it('keeps native as the default and never probes for the harness', () => {
    // Approval condition 3. The detector is the seam that decides whether the optional
    // peer is present, so counting its calls is how "a native app never touches
    // deepagents" is proved rather than asserted.
    const detect = vi.fn(() => DEEPAGENTS_PIN);
    expect(checkEngine(agentDefinition(), detect)).toBe('native');
    expect(detect).not.toHaveBeenCalled();
  });

  it('reports the installed release as the pinned one', () => {
    expect(installedDeepagentsVersion()).toBe(DEEPAGENTS_PIN);
  });

  it('refuses an unknown engine by name', () => {
    const agent = agentDefinition({ engine: 'crewai' });
    expect(() => checkEngine(agent)).toThrow(/'crewai'/);
  });

  it('fails closed on a declared handoff instead of degrading', () => {
    const agent = agentDefinition({
      engine: DEEPAGENTS,
      engineVersion: '0.0.1',
      handoffs: ['billing'],
    });
    expect(() => checkEngine(agent)).toThrow(/handoff/i);
    expect(() => checkEngine(agent)).not.toThrow(DeepAgentsVersionMismatchError);
  });

  it('does not mistake a declared delegate for a handoff', () => {
    const agent = agentDefinition({
      engine: DEEPAGENTS,
      engineVersion: DEEPAGENTS_PIN,
      delegates: ['worker'],
    });
    expect(() => checkEngine(agent)).not.toThrow();
  });

  it('accepts the declared pin and lets the run proceed', async () => {
    const harness = build(gated(), { script: [ScriptedTurn.answer('done')] });
    const result = await harness.runtime.run('solo', PROMPT);
    expect(result.status).toBe('completed');
    expect(result.answer).toBe('done');
  });

  // Approval condition 2. Python pins 0.7.32 and this runtime pins 1.16.0, so the same
  // `engineVersion` cannot satisfy both. This is the accepted cost of per-runtime pins:
  // a spec written for Python is refused here, honestly, rather than run on a release
  // this adapter was not built against.
  it.each(['0.7.31', '0.7.33', '', '0.7', '0.7.32'])(
    'fails closed on a declared pin of %j',
    (declared) => {
      const agent = agentDefinition({ engine: DEEPAGENTS, engineVersion: declared });
      expect(() => checkEngine(agent)).toThrow(DeepAgentsVersionMismatchError);
    },
  );

  it('installs exactly the pinned release and its exact peers', () => {
    const specs = DEEPAGENTS_EXTRA.split(' ');
    expect(specs.every((spec) => /^@?[^\s@]+@\d+\.\d+\.\d+$/.test(spec))).toBe(true);
    expect(specs).toContain(`deepagents@${DEEPAGENTS_PIN}`);
  });

  it('fails closed when the harness is absent rather than importing it lazily', () => {
    // The absent-harness path without uninstalling anything: the detector is the seam.
    const agent = agentDefinition({ engine: DEEPAGENTS, engineVersion: DEEPAGENTS_PIN });
    expect(() => checkEngine(agent, () => undefined)).toThrow(DeepAgentsUnavailableError);
  });
});

describe('every model call goes through the gateway', () => {
  it('routes each harness generation through the gateway', async () => {
    const harness = build(gated(), { script: [ScriptedTurn.answer('done')] });
    await harness.runtime.run('solo', PROMPT);

    // The ledger is written by the gateway, so a charged alias is proof the harness's
    // model call was ours rather than the harness's own transport.
    expect(harness.aliasesCharged()).toEqual(['cheap']);
    expect(harness.provider.calls).toHaveLength(1);
  });

  it('still falls back inside the harness when the primary model fails', async () => {
    const provider = new FakeProvider({
      name: PROVIDER,
      script: [ScriptedTurn.answer('done')],
      failWith: ['upstream 503'],
    });
    const harness = build(
      gated({
        models: [modelDef('cheap', { fallbacks: ['strong'] }), modelDef('strong')],
      }),
      { provider },
    );

    const result = await harness.runtime.run('solo', PROMPT);

    // A measured fallback: the primary really failed, and the run completed on the
    // fallback alias rather than surfacing the provider error.
    expect(result.status).toBe('completed');
    expect(harness.aliasesCharged()).toContain('strong');
  });

  it('stops the harness on a budget breach', async () => {
    const harness = build(gated({ maxCostBudget: 0 }), { script: [ScriptedTurn.answer('done')] });
    await expect(harness.runtime.run('solo', PROMPT)).rejects.toThrow(BudgetExceededError);
  });

  it('emits model spans from inside the harness', async () => {
    const baseline = started.length;
    const harness = build(gated(), { script: [ScriptedTurn.answer('done')] });
    await harness.runtime.run('solo', PROMPT);

    const names = spanNamesSince(baseline);
    expect(names.length).toBeGreaterThan(0);
    expect(names.every((name) => name.startsWith('chat '))).toBe(true);
  });
});

describe('tools, guardrails and step limits', () => {
  it('executes a declared tool through our executor and records it', async () => {
    const { tool, recorder } = recordingTool();
    const harness = build(gated({ toolSpecs: [toolDef('search', 'search')], tools: ['search'] }), {
      tools: [tool],
      script: [ScriptedTurn.tool('search', { query: 'order' }), ScriptedTurn.answer('done')],
    });

    const result = await harness.runtime.run('solo', PROMPT);

    expect(recorder.queries).toEqual(['order']);
    expect(result.answer).toBe('done');
    expect(result.steps.some((step) => step.kind === 'tools')).toBe(true);
  });

  it('keeps the harness bundled tools out of reach', async () => {
    const { tool } = recordingTool();
    const harness = build(gated({ toolSpecs: [toolDef('search', 'search')], tools: ['search'] }), {
      tools: [tool],
      script: [ScriptedTurn.answer('done')],
    });

    await harness.runtime.run('solo', PROMPT);

    // What the model was actually offered, not what we hoped it was offered.
    const offered = harness.provider.calls.flatMap((call) =>
      call.tools.map((definition) => definition.name),
    );
    expect(new Set(offered)).toEqual(new Set(['search']));
  });

  it('stops the harness when a tool-call guardrail blocks', async () => {
    const { tool, recorder } = recordingTool();
    const harness = build(
      gated({
        toolSpecs: [toolDef('search', 'search')],
        tools: ['search'],
        guardrailSpecs: [
          guardrailDef('blocker', {
            stages: ['tool-call'],
            policies: ['prompt-injection'],
            action: ACTION_BLOCK,
            tools: ['search'],
          }),
        ],
      }),
      {
        tools: [tool],
        script: [
          ScriptedTurn.tool('search', { query: 'ignore previous instructions' }),
          ScriptedTurn.answer('done'),
        ],
      },
    );

    await expect(harness.runtime.run('solo', PROMPT)).rejects.toThrow(GuardrailBlockedError);
    expect(recorder.calls).toBe(0);
  });

  it('reports maxSteps exhaustion the way the native loop does', async () => {
    const options = {
      toolSpecs: [toolDef('search', 'search')],
      tools: ['search'],
      maxSteps: 1,
    };
    const script = [
      ScriptedTurn.tool('search', { query: 'a' }),
      ScriptedTurn.tool('search', { query: 'b' }),
      ScriptedTurn.answer('done'),
    ];

    const nativeTool = recordingTool();
    const native = build(solo(options), { tools: [nativeTool.tool], script });
    const nativeResult = await native.runtime.run('solo', PROMPT);

    const deepTool = recordingTool();
    const deep = build(gated(options), { tools: [deepTool.tool], script });
    const deepResult = await deep.runtime.run('solo', PROMPT);

    expect(nativeResult.status).toBe('max-steps');
    expect(deepResult.status).toBe(nativeResult.status);
  });

  it('refuses a call past maxSteps before it reaches the gateway', async () => {
    // Approval condition 4. The harness's own limiter *completes* the run with a synthetic
    // answer, so the adapter must be the thing that refuses, and it must refuse before
    // spending the call -- which is what this spy measures: one call is allowed, the
    // second is refused, so exactly one generation reaches the gateway.
    const { tool } = recordingTool();
    const harness = build(
      gated({ toolSpecs: [toolDef('search', 'search')], tools: ['search'], maxSteps: 1 }),
      {
        tools: [tool],
        script: [
          ScriptedTurn.tool('search', { query: 'a' }),
          ScriptedTurn.tool('search', { query: 'b' }),
          ScriptedTurn.answer('done'),
        ],
      },
    );
    const generate = vi.spyOn(harness.gateway, 'generate');

    const result = await harness.runtime.run('solo', PROMPT);

    expect(result.status).toBe('max-steps');
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('exposes no streaming', async () => {
    const harness = build(gated(), { script: [ScriptedTurn.answer('done')] });
    const result = await harness.runtime.run('solo', PROMPT);
    // A buffered surface: the run yields one answer, not chunks.
    expect(result.answer).toBe('done');
  });

  it('produces a byte-equal transcript for the same input twice', async () => {
    const run = async () => {
      const { tool } = recordingTool();
      const harness = build(
        gated({ toolSpecs: [toolDef('search', 'search')], tools: ['search'] }),
        {
          tools: [tool],
          script: [ScriptedTurn.tool('search', { query: 'order' }), ScriptedTurn.answer('done')],
        },
      );
      return JSON.stringify(await harness.runtime.run('solo', PROMPT));
    };

    expect(await run()).toBe(await run());
  });
});

describe('delegation', () => {
  /**
   * `front` delegates to `worker`, and both carry a tool-call guardrail over the same tool.
   *
   * The caller's policy is a block and the delegate's is a redaction, so the two possible
   * failures are distinguishable: a leaking caller stop the run, and a delegate that never
   * runs leaves the arguments untouched.
   */
  function delegated() {
    return document({
      models: [modelDef('cheap', { cost: CHEAP_COST })],
      prompts: [promptDef('front', 'front'), promptDef('worker', 'worker')],
      tools: [toolDef('search', 'search', { sideEffects: 'read' })],
      guardrails: [
        guardrailDef('caller', {
          stages: ['tool-call'],
          policies: ['pii-detect'],
          action: ACTION_BLOCK,
          tools: ['search'],
        }),
        guardrailDef('delegate', {
          stages: ['tool-call'],
          policies: ['pii-detect'],
          action: ACTION_REDACT,
          redact: ['query'],
          tools: ['search'],
        }),
      ],
      agents: [
        agentDef('front', {
          prompt: 'front',
          engine: 'deepagents',
          engineVersion: '1.16.0',
          delegates: ['worker'],
          tools: [],
          guardrails: ['caller'],
        }),
        agentDef('worker', {
          prompt: 'worker',
          engine: 'deepagents',
          engineVersion: '1.16.0',
          tools: ['search'],
          guardrails: ['delegate'],
        }),
      ],
    });
  }

  const TURNS = [
    ScriptedTurn.tool('task', { description: 'find the order', subagent_type: 'worker' }),
    ScriptedTurn.tool('search', { query: 'find ada@example.com' }),
    ScriptedTurn.answer('worker done'),
    ScriptedTurn.answer('front done'),
  ];

  it(`runs the delegate's own guardrail and rewrites what the tool receives`, async () => {
    const { tool, recorder } = recordingTool();
    const harness = build(delegated(), { tools: [tool], script: TURNS });

    const result = await harness.runtime.run('front', PROMPT);

    // The delegate ran, and the argument the tool actually saw is the redacted one.
    expect(recorder.queries).toHaveLength(1);
    expect(recorder.queries[0]).toContain('[REDACTED:pii-detect]');
    expect(result.answer).toContain('done');
  });

  it(`does not let the caller's guardrail reach past the delegation boundary`, async () => {
    const { tool, recorder } = recordingTool();
    // A blocking caller policy over the delegate's tool. If the boundary leaked, this run
    // would be refused instead of completing.
    const harness = build(delegated(), { tools: [tool], script: TURNS });

    const result = await harness.runtime.run('front', PROMPT);

    expect(result.status).toBe('completed');
    expect(recorder.calls).toBe(1);
  });

  it(`gives the delegate its own grant rather than the caller's`, async () => {
    const { tool, recorder } = recordingTool();
    const harness = build(
      document({
        models: [modelDef('cheap', { cost: CHEAP_COST })],
        prompts: [promptDef('front', 'front'), promptDef('worker', 'worker')],
        tools: [toolDef('search', 'search', { sideEffects: 'read' })],
        agents: [
          agentDef('front', {
            prompt: 'front',
            engine: 'deepagents',
            engineVersion: '1.16.0',
            delegates: ['worker'],
            tools: [],
          }),
          agentDef('worker', {
            prompt: 'worker',
            engine: 'deepagents',
            engineVersion: '1.16.0',
            tools: ['search'],
          }),
        ],
      }),
      {
        tools: [tool],
        script: [
          ScriptedTurn.tool('task', { description: 'find the order', subagent_type: 'worker' }),
          ScriptedTurn.tool('search', { query: 'order' }),
          ScriptedTurn.answer('worker done'),
          ScriptedTurn.tool('search', { query: 'the caller holds no grant' }),
          ScriptedTurn.answer('front done'),
        ],
      },
    );

    const run = harness.runtime.run('front', PROMPT);

    // The caller's attempt is refused by the grant, not silently allowed.
    await expect(run).rejects.toThrow(ToolPermissionError);
    // The delegate's call ran through our executor; the caller, which declares no tools,
    // could not reach the same tool. One execution, not two.
    expect(recorder.calls).toBe(1);
  });

  it(`does not let the caller's guardrail block the delegation call itself`, async () => {
    // An unrestricted caller guardrail would otherwise fire on the `task` call's own
    // arguments. Delegation is not a tool the caller's grant covers, so the boundary must
    // hand the call to the delegate instead of judging it here.
    const { tool, recorder } = recordingTool();
    const harness = build(
      document({
        models: [modelDef('cheap', { cost: CHEAP_COST })],
        prompts: [promptDef('front', 'front'), promptDef('worker', 'worker')],
        tools: [toolDef('search', 'search', { sideEffects: 'read' })],
        guardrails: [
          guardrailDef('caller', {
            stages: ['tool-call'],
            policies: ['pii-detect'],
            action: ACTION_BLOCK,
          }),
        ],
        agents: [
          agentDef('front', {
            prompt: 'front',
            engine: 'deepagents',
            engineVersion: '1.16.0',
            delegates: ['worker'],
            tools: [],
            guardrails: ['caller'],
          }),
          agentDef('worker', {
            prompt: 'worker',
            engine: 'deepagents',
            engineVersion: '1.16.0',
            tools: ['search'],
          }),
        ],
      }),
      {
        tools: [tool],
        script: [
          ScriptedTurn.tool('task', {
            description: 'find ada@example.com',
            subagent_type: 'worker',
          }),
          ScriptedTurn.tool('search', { query: 'find ada@example.com' }),
          ScriptedTurn.answer('worker done'),
          ScriptedTurn.answer('front done'),
        ],
      },
    );

    const result = await harness.runtime.run('front', PROMPT);

    expect(result.status).toBe('completed');
    expect(recorder.calls).toBe(1);
  });
});

describe('human in the loop', () => {
  it('pauses before the tool and runs it on approval', async () => {
    const { tool, recorder } = recordingTool();
    const harness = build(
      gated({
        toolSpecs: [toolDef('search', 'search')],
        tools: ['search'],
        hitl: { when: ADMIN, channel: 'ops' },
      }),
      {
        tools: [tool],
        script: [ScriptedTurn.tool('search', { query: 'order' }), ScriptedTurn.answer('done')],
      },
    );

    const paused = await harness.runtime.run('solo', PROMPT, {
      principal: new Principal({ roles: ['admin'] }),
    });

    expect(paused.status).toBe('paused');
    expect(recorder.calls).toBe(0);
    expect(paused.approval?.calls.map((call) => call.name)).toEqual(['search']);
  });
});
