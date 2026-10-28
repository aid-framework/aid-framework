/**
 * HITL: a pause that survives the process, and a resume that continues the run.
 *
 * Mirrors `tests/test_agents_hitl.py`. The loop stops *before* the held tool runs, records
 * the question, and continues from the checkpoint when a human answers. Nothing here is a
 * UI; the point is that the pause is real, serialisable state and that the two answers --
 * approve and reject -- are observably different.
 *
 * The span assertions in the Python suite are tracing-only and cannot port: agent spans are
 * decision D-7.
 */

import { describe, expect, it } from 'vitest';
import {
  type AgentCheckpoint,
  ConfigurationError,
  checkpointFromJson,
  checkpointToJson,
  Principal,
  ScriptedTurn,
} from '../src/index.js';
import {
  ADMIN_ONLY,
  agentDef,
  build,
  CHEAP_COST,
  document,
  modelDef,
  promptDef,
  recordingTool,
  solo,
  toolDef,
} from './agent-support.js';

const SOLO_PROMPT = 'You are a helpful assistant.';
const FRONT_PROMPT = 'You triage requests and move them to the right agent.';
const WORKER_PROMPT = 'You answer one question and stop.';
const QUESTION = 'Refund this order.';
/** The observation a rejected call leaves behind. Mirrors the loop's `REJECTED`. */
const REJECTED = 'rejected by the human approver';
const ADMIN = new Principal({ roles: ['admin'] });

/** One agent, one tool, and a policy that asks a human for it. */
function supervised() {
  return solo({
    prompt: SOLO_PROMPT,
    alias: 'cheap',
    models: [modelDef('cheap', { cost: CHEAP_COST })],
    toolSpecs: [toolDef('search', 'search', { sideEffects: 'read' })],
    tools: ['search'],
    hitl: { when: ADMIN_ONLY, channel: 'ops' },
  });
}

/** `front` delegates to a supervised `worker`: a pause with a caller above it. */
function delegating() {
  return document({
    models: [modelDef('cheap', { cost: CHEAP_COST })],
    prompts: [promptDef('front', FRONT_PROMPT), promptDef('worker', WORKER_PROMPT)],
    tools: [toolDef('search', 'search', { sideEffects: 'read' })],
    agents: [
      agentDef('front', { prompt: 'front', delegates: ['worker'], tools: [] }),
      agentDef('worker', {
        prompt: 'worker',
        tools: ['search'],
        hitl: { when: ADMIN_ONLY, channel: 'ops' },
      }),
    ],
  });
}

describe('human in the loop', () => {
  it('pauses before the held tool runs', async () => {
    const { tool, recorder } = recordingTool();
    const harness = build(supervised(), {
      tools: [tool],
      script: [ScriptedTurn.tool('search', { query: 'order' }), ScriptedTurn.answer('done')],
    });

    const result = await harness.runtime.run('solo', QUESTION, { principal: ADMIN });

    expect(result.status).toBe('paused');
    expect(result.completed).toBe(false);
    expect(result.answer).toBe('');
    expect(result.checkpoint).toBeDefined();
    // The pause is reported as a step that asked for tools, so a reader sees which step
    // was held rather than a run that simply stopped.
    expect(result.steps.map((step) => [step.index, step.kind])).toEqual([[1, 'tools']]);
    expect(recorder.calls).toBe(0);
    expect(result.approval?.channel).toBe('ops');
    expect(result.approval?.calls.map((call) => call.name)).toEqual(['search']);
  });

  it('runs the held tool on approval without replaying the model', async () => {
    const { tool, recorder } = recordingTool();
    const harness = build(supervised(), {
      tools: [tool],
      script: [ScriptedTurn.tool('search', { query: 'order' }), ScriptedTurn.answer('done')],
    });
    const paused = await harness.runtime.run('solo', QUESTION, { principal: ADMIN });
    expect(paused.checkpoint).toBeDefined();
    const callsBefore = harness.provider.calls.length;

    const result = await harness.runtime.resume(paused.checkpoint as AgentCheckpoint, 'approve', {
      principal: ADMIN,
    });

    expect(result.completed).toBe(true);
    expect(result.answer).toBe('done');
    expect(recorder.queries).toEqual(['order']);
    // The whole run is reported, not only the part after the resume.
    expect(result.steps.map((step) => [step.index, step.kind])).toEqual([
      [1, 'tools'],
      [2, 'answer'],
    ]);
    // The model was asked exactly once more: the held step was not re-generated.
    expect(harness.provider.calls.length).toBe(callsBefore + 1);
    const observation = harness.provider.calls[callsBefore]?.messages.find(
      (message) => message.role === 'tool',
    );
    expect(observation?.content).toBe('sunny:order');
  });

  it('turns a rejection into an observation and keeps going', async () => {
    const { tool, recorder } = recordingTool();
    const harness = build(supervised(), {
      tools: [tool],
      script: [
        ScriptedTurn.tool('search', { query: 'order' }),
        ScriptedTurn.answer('I could not check that.'),
      ],
    });
    const paused = await harness.runtime.run('solo', QUESTION, { principal: ADMIN });

    const result = await harness.runtime.resume(paused.checkpoint as AgentCheckpoint, 'reject', {
      principal: ADMIN,
    });

    expect(result.status).toBe('completed');
    expect(result.answer).toBe('I could not check that.');
    // Rejection is neither a crash nor a silent skip: the tool did not run, and the model
    // was told so in the one place it can read.
    expect(recorder.calls).toBe(0);
    const observation = harness.provider.calls[1]?.messages.find(
      (message) => message.role === 'tool',
    );
    expect(observation?.content).toBe(REJECTED);
  });

  it('still resumes a run that pauses twice', async () => {
    const { tool, recorder } = recordingTool();
    const harness = build(supervised(), {
      tools: [tool],
      script: [
        ScriptedTurn.tool('search', { query: 'one' }),
        ScriptedTurn.tool('search', { query: 'two' }),
        ScriptedTurn.answer('done'),
      ],
    });

    const first = await harness.runtime.run('solo', QUESTION, { principal: ADMIN });
    const second = await harness.runtime.resume(first.checkpoint as AgentCheckpoint, 'approve', {
      principal: ADMIN,
    });

    expect(second.status).toBe('paused');
    expect(second.checkpoint?.step).toBe(2);
    expect(recorder.queries).toEqual(['one']);

    const third = await harness.runtime.resume(second.checkpoint as AgentCheckpoint, 'approve', {
      principal: ADMIN,
    });

    expect(third.completed).toBe(true);
    expect(recorder.queries).toEqual(['one', 'two']);
    expect(third.steps.map((step) => step.index)).toEqual([1, 2, 3]);
  });

  it('returns control to the caller when a delegate pauses', async () => {
    const { tool, recorder } = recordingTool('search', { answer: 'sunny' });
    const harness = build(delegating(), {
      tools: [tool],
      script: [
        ScriptedTurn.tool('delegate_to_worker', { message: 'check the order' }),
        ScriptedTurn.tool('search', { query: 'order' }),
        ScriptedTurn.answer('worker answer'),
        ScriptedTurn.answer('front answer'),
      ],
    });

    const paused = await harness.runtime.run('front', QUESTION, { principal: ADMIN });

    expect(paused.status).toBe('paused');
    // The pause happened inside the delegate, so the question names the delegate and the
    // checkpoint carries the link back to the caller waiting for it.
    expect(paused.checkpoint?.agentId).toBe('worker');
    expect(paused.checkpoint?.caller?.agentId).toBe('front');

    const result = await harness.runtime.resume(paused.checkpoint as AgentCheckpoint, 'approve', {
      principal: ADMIN,
    });

    expect(result.completed).toBe(true);
    expect(result.agentId).toBe('front');
    expect(result.answer).toBe('front answer');
    expect(recorder.queries).toEqual(['order']);
    const handedBack = harness.provider.calls
      .at(-1)
      ?.messages.find((message) => message.role === 'tool');
    expect(handedBack?.content).toBe('worker answer');
  });

  it('refuses to resume the caller-side checkpoint', async () => {
    const { tool } = recordingTool();
    const harness = build(delegating(), {
      tools: [tool],
      script: [
        ScriptedTurn.tool('delegate_to_worker', { message: 'check the order' }),
        ScriptedTurn.tool('search', { query: 'order' }),
      ],
    });
    const paused = await harness.runtime.run('front', QUESTION, { principal: ADMIN });
    const caller = paused.checkpoint?.caller;
    expect(caller).toBeDefined();

    await expect(
      harness.runtime.resume(caller as AgentCheckpoint, 'approve', { principal: ADMIN }),
    ).rejects.toThrow(/carries the caller link/);
  });

  it('resumes a checkpoint that crossed a process boundary as JSON', async () => {
    const { tool, recorder } = recordingTool();
    const first = build(supervised(), {
      tools: [tool],
      script: [ScriptedTurn.tool('search', { query: 'order' }), ScriptedTurn.answer('done')],
    });
    const paused = await first.runtime.run('solo', QUESTION, { principal: ADMIN });
    const spent = paused.costUsd;
    expect(spent).toBeGreaterThan(0);

    // Nothing but the serialised checkpoint crosses the boundary.
    const restored = checkpointFromJson(
      JSON.parse(JSON.stringify(checkpointToJson(paused.checkpoint as AgentCheckpoint))),
    );
    const second = build(supervised(), {
      tools: [tool],
      script: [ScriptedTurn.answer('done')],
    });

    const result = await second.runtime.resume(restored, 'approve', { principal: ADMIN });

    expect(result.status).toBe('completed');
    expect(recorder.queries).toEqual(['order']);
    // The paused spend is carried into the new ledger as an auditable entry, so a resumed
    // run does not get a ceiling it has already partly spent.
    expect(second.aliasesCharged()).toEqual(['restored', 'cheap']);
    expect(second.ledger.entries[0]?.costUsd).toBeCloseTo(spent, 10);
    expect(second.ledger.costUsd).toBeCloseTo(spent + result.costUsd, 10);
  });

  it('refuses a resume for an agent the IR does not declare', async () => {
    const { tool } = recordingTool();
    const harness = build(supervised(), {
      tools: [tool],
      script: [ScriptedTurn.tool('search', { query: 'order' })],
    });
    const paused = await harness.runtime.run('solo', QUESTION, { principal: ADMIN });
    const forged: AgentCheckpoint = {
      ...(paused.checkpoint as AgentCheckpoint),
      agentId: 'ghost',
    };

    await expect(harness.runtime.resume(forged, 'approve')).rejects.toThrow(ConfigurationError);
  });
});
