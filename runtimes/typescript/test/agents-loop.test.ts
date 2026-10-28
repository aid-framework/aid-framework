/**
 * The agent loop, driven from IR documents.
 *
 * Mirrors `tests/test_agents_loop.py`. Every case starts from an emitted document rather
 * than a hand-built `RuntimeSpec`, so the seam the compiler depends on is exercised too.
 */

import { describe, expect, it } from 'vitest';
import {
  AgentTransferCycleError,
  CapabilityMismatchError,
  ConfigurationError,
  DEEPAGENTS_PIN,
  FakeProvider,
  IMPLEMENTED_MEMORY_KINDS,
  Principal,
  ScriptedTurn,
  Tool,
} from '../src/index.js';
import {
  ADMIN_ONLY,
  agentDef,
  build,
  CHEAP_COST,
  document,
  modelDef,
  PROVIDER,
  promptDef,
  recordingTool,
  solo,
  toolDef,
} from './agent-support.js';

describe('AgentRuntime', () => {
  it('ends the run on an answer, charging one step', async () => {
    const harness = build(solo(), { script: [ScriptedTurn.answer('hello')] });
    const result = await harness.runtime.run('solo', 'hi');
    expect(result.status).toBe('completed');
    expect(result.completed).toBe(true);
    expect(result.answer).toBe('hello');
    expect(result.agentId).toBe('solo');
    expect(result.path).toEqual(['solo']);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.kind).toBe('answer');
    expect(result.steps[0]?.alias).toBe('cheap');
    expect(result.totalTokens).toBeGreaterThan(0);
  });

  it('replays the tool call and the observation it produced', async () => {
    const { tool, recorder } = recordingTool();
    const doc = solo({ toolSpecs: [toolDef('search', 'search')], tools: ['search'] });
    const harness = build(doc, {
      tools: [tool],
      script: [ScriptedTurn.tool('search', { query: 'weather' }), ScriptedTurn.answer('sunny')],
    });

    const result = await harness.runtime.run('solo', 'what is the weather');

    expect(result.answer).toBe('sunny');
    expect(recorder.queries).toEqual(['weather']);
    expect(result.steps.map((step) => step.kind)).toEqual(['tools', 'answer']);
    expect(result.steps[0]?.toolNames).toEqual(['search']);

    // The second request must carry the assistant turn that asked, and the observation
    // threaded to that call's id -- otherwise a model sees a tool result it cannot place.
    const replay = harness.provider.calls[1]?.messages ?? [];
    const asked = replay.find((message) => message.toolCalls.length > 0);
    const observed = replay.find((message) => message.role === 'tool');
    expect(asked?.toolCalls[0]?.name).toBe('search');
    expect(observed?.toolCallId).toBe('call_0_0');
    expect(observed?.content).toContain('sunny:weather');
  });

  it('bounds model calls by maxSteps exactly', async () => {
    const { tool } = recordingTool();
    const doc = solo({
      toolSpecs: [toolDef('search', 'search')],
      tools: ['search'],
      maxSteps: 2,
    });
    const harness = build(doc, {
      tools: [tool],
      script: [
        ScriptedTurn.tool('search', { query: 'a' }),
        ScriptedTurn.tool('search', { query: 'b' }),
        ScriptedTurn.answer('never reached'),
      ],
    });

    const result = await harness.runtime.run('solo', 'go');

    expect(result.status).toBe('max-steps');
    expect(result.completed).toBe(false);
    expect(harness.provider.calls).toHaveLength(2);
  });

  it('answers a hallucinated tool with an observation instead of failing', async () => {
    const harness = build(solo(), {
      script: [ScriptedTurn.tool('ghost', {}), ScriptedTurn.answer('sorry')],
    });

    const result = await harness.runtime.run('solo', 'go');

    expect(result.answer).toBe('sorry');
    const observed = harness.provider.calls[1]?.messages.find((message) => message.role === 'tool');
    expect(observed?.content).toContain('no tool named "ghost"');
  });

  it('refuses a declared tool that is not registered on the runtime', () => {
    const doc = solo({ toolSpecs: [toolDef('search', 'search')], tools: ['search'] });
    expect(() => build(doc)).toThrow(/not registered on this runtime/);
  });

  it('refuses a tool named like a control tool', () => {
    const doc = document({
      models: [modelDef('cheap')],
      prompts: [promptDef('main', 'front')],
      tools: [toolDef('sneaky', 'transfer_to_worker')],
      agents: [agentDef('front', { handoffs: ['worker'], tools: ['sneaky'] }), agentDef('worker')],
    });
    expect(() =>
      build(doc, { tools: [Tool.of({ name: 'transfer_to_worker', handler: () => '' })] }),
    ).toThrow(/named like a control tool/);
  });

  it('moves control on a transfer', async () => {
    const doc = document({
      models: [modelDef('cheap')],
      prompts: [promptDef('main', 'front')],
      agents: [agentDef('front', { handoffs: ['worker'] }), agentDef('worker')],
    });
    const harness = build(doc, {
      script: [ScriptedTurn.tool('transfer_to_worker'), ScriptedTurn.answer('worker here')],
    });

    const result = await harness.runtime.run('front', 'go');

    expect(result.path).toEqual(['front', 'worker']);
    expect(result.agentId).toBe('worker');
    expect(result.answer).toBe('worker here');
    expect(result.steps[0]?.kind).toBe('transfer');
    expect(result.steps[0]?.target).toBe('worker');
  });

  it('returns control to the caller after a delegate', async () => {
    const doc = document({
      models: [modelDef('cheap')],
      prompts: [promptDef('main', 'front')],
      agents: [agentDef('front', { delegates: ['worker'] }), agentDef('worker')],
    });
    const harness = build(doc, {
      script: [
        ScriptedTurn.tool('delegate_to_worker'),
        ScriptedTurn.answer('inner answer'),
        ScriptedTurn.answer('outer answer'),
      ],
    });

    const result = await harness.runtime.run('front', 'go');

    expect(result.path).toEqual(['front']);
    expect(result.agentId).toBe('front');
    expect(result.answer).toBe('outer answer');
    // The delegate's own answer reaches the caller as the control call's observation.
    const observed = harness.provider.calls[2]?.messages.find((message) => message.role === 'tool');
    expect(observed?.content).toBe('inner answer');
    expect(result.steps.filter((step) => step.kind === 'delegate')).toHaveLength(1);
  });

  it('refuses a control call that shares its step', async () => {
    const doc = document({
      models: [modelDef('cheap')],
      prompts: [promptDef('main', 'front')],
      agents: [agentDef('front', { handoffs: ['worker'] }), agentDef('worker')],
    });
    const harness = build(doc, {
      script: [ScriptedTurn.tools(['transfer_to_worker', {}], ['search', {}])],
    });

    await expect(harness.runtime.run('front', 'go')).rejects.toThrow(/only call in its step/);
  });

  it('refuses an undeclared control target', async () => {
    const harness = build(solo(), { script: [ScriptedTurn.tool('transfer_to_stranger')] });
    await expect(harness.runtime.run('solo', 'go')).rejects.toThrow(
      /does not declare it; declared handoffs/,
    );
  });

  it('refuses a transfer cycle, naming the whole path', async () => {
    const doc = document({
      models: [modelDef('cheap')],
      prompts: [promptDef('main', 'a')],
      agents: [agentDef('a', { handoffs: ['b'] }), agentDef('b', { handoffs: ['a'] })],
    });
    const harness = build(doc, {
      script: [ScriptedTurn.tool('transfer_to_b'), ScriptedTurn.tool('transfer_to_a')],
    });

    const error = await harness.runtime.run('a', 'go').catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(AgentTransferCycleError);
    expect((error as AgentTransferCycleError).message).toBe('transfer cycle: a -> b -> a');
    expect((error as AgentTransferCycleError).path).toEqual(['a', 'b', 'a']);
  });

  it('refuses a fallback that cannot call tools rather than answering from memory', async () => {
    const doc = solo({
      models: [
        modelDef('cheap', { fallbacks: ['weak'], capabilities: ['tool-calling'] }),
        modelDef('weak', { cost: CHEAP_COST, capabilities: ['structured-output'] }),
      ],
      toolSpecs: [toolDef('search', 'search')],
      tools: ['search'],
    });
    const { tool } = recordingTool();
    const harness = build(doc, {
      tools: [tool],
      provider: new FakeProvider({ name: PROVIDER, failWith: ['primary exploded'] }),
    });

    await expect(harness.runtime.run('solo', 'go')).rejects.toThrow(CapabilityMismatchError);
  });

  it('never falls back to native for a deepagents agent', async () => {
    const provider = new FakeProvider({ name: PROVIDER, script: [ScriptedTurn.answer('nope')] });
    const harness = build(solo({ engine: 'deepagents', engineVersion: DEEPAGENTS_PIN }), {
      provider,
    });

    await expect(harness.runtime.run('solo', 'go')).rejects.toThrow(/deepagents/i);
    expect(provider.calls).toHaveLength(0);
  });

  it('consults the principal before asking for approval', async () => {
    const doc = solo({
      toolSpecs: [toolDef('search', 'search', { sideEffects: 'read' })],
      tools: ['search'],
      hitl: { when: ADMIN_ONLY, channel: 'ops' },
    });
    const { tool } = recordingTool();
    const harness = build(doc, {
      tools: [tool],
      script: [ScriptedTurn.tool('search', { query: 'q' }), ScriptedTurn.answer('done')],
    });

    // An authenticated non-admin does not satisfy `hasRole("admin")`, so the read-only tool
    // runs without a pause -- the policy, not the tool, decides.
    const result = await harness.runtime.run('solo', 'go', {
      principal: new Principal({ roles: ['reader'] }),
    });

    expect(result.status).toBe('completed');
    expect(result.approval).toBeUndefined();
    expect(harness.provider.calls).toHaveLength(2);
  });

  it('pauses for a principal the policy admits', async () => {
    const doc = solo({
      toolSpecs: [toolDef('search', 'search', { sideEffects: 'read' })],
      tools: ['search'],
      hitl: { when: ADMIN_ONLY, channel: 'ops' },
    });
    const { tool } = recordingTool();
    const harness = build(doc, {
      tools: [tool],
      script: [ScriptedTurn.tool('search', { query: 'q' })],
    });

    const result = await harness.runtime.run('solo', 'go', {
      principal: new Principal({ roles: ['admin'] }),
    });

    expect(result.status).toBe('paused');
    expect(result.answer).toBe('');
    expect(result.checkpoint).toBeDefined();
    expect(result.approval?.channel).toBe('ops');
    expect(result.approval?.calls.map((call) => call.name)).toEqual(['search']);
  });

  it('implements exactly the two thread memory kinds', () => {
    expect(IMPLEMENTED_MEMORY_KINDS).toEqual(['buffer', 'window']);
  });

  it('reports the spend of the run it just finished', async () => {
    const harness = build(solo(), { script: [ScriptedTurn.answer('hi')] });
    const result = await harness.runtime.run('solo', 'hi');
    expect(result.costUsd).toBeGreaterThan(0);
    expect(result.costUsd).toBeCloseTo(harness.ledger.costUsd, 10);
    expect(harness.aliasesCharged()).toEqual(['cheap']);
  });

  it('refuses a run for an agent the IR does not declare', async () => {
    const harness = build(solo(), { script: [ScriptedTurn.answer('hi')] });
    await expect(harness.runtime.run('ghost', 'hi')).rejects.toThrow(ConfigurationError);
  });
});
