/**
 * The refusals that decide whether an agent may act, and the pause paths around them.
 *
 * `agents-loop.test.ts` proves the loop drives a conversation; this suite pins the two
 * places where it says *no*: tool authorization (deny by default, in three steps) and a
 * guardrail that blocks, redacts or escalates a call. Both are contract, not coverage: a
 * regression here is an agent doing something it was not granted, or a blocked call
 * reaching its handler.
 *
 * The resume cases at the end are the other half of the pause contract: an approved
 * output-stage escalation must be released without re-generating the answer a person
 * already read, and a checkpoint whose caller link has no pending call must be refused
 * rather than resumed into nothing.
 */

import { describe, expect, it } from 'vitest';
import {
  type AgentCheckpoint,
  ConfigurationError,
  GuardrailBlockedError,
  Principal,
  ScriptedTurn,
  ToolPermissionError,
} from '../src/index.js';
import {
  ADMIN_ONLY,
  agentDef,
  at,
  build,
  document,
  guardrailDef,
  modelDef,
  promptDef,
  recordingTool,
  solo,
  toolDef,
} from './agent-support.js';

const QUESTION = 'Refund this order.';
const ADDRESS = 'ada@example.com';
const TOXIC = 'you should die';
const ADMIN = new Principal({ roles: ['admin'] });
const VIEWER = new Principal({ roles: ['viewer'] });

/**
 * Await a run that must not complete.
 *
 * A scripted provider serves each turn once, so a second `run` on the same harness would
 * measure an exhausted script rather than the refusal under test. Capture the one run.
 */
async function refusal(run: Promise<unknown>): Promise<Error> {
  try {
    await run;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the run to be refused, but it completed');
}

/** One agent, one read-only tool it is granted. */

describe('tool authorization', () => {
  it('refuses a registered tool the agent does not declare', async () => {
    const { tool, recorder } = recordingTool('write_file');
    const harness = build(solo({ toolSpecs: [], tools: [] }), {
      tools: [tool],
      script: [ScriptedTurn.tool('write_file', { path: '/etc/passwd' })],
    });

    const error = await refusal(harness.runtime.run('solo', QUESTION, { principal: ADMIN }));

    expect(error).toBeInstanceOf(ToolPermissionError);
    expect(error.message).toMatch(/the agent does not declare it/);
    expect(recorder.calls).toBe(0);
  });

  it('refuses a side-effecting tool that declares no authorization', async () => {
    const doc = solo({
      toolSpecs: [toolDef('wiper', 'wiper', { sideEffects: 'write' })],
      tools: ['wiper'],
    });
    // The compiler requires an `auth` on a mutating tool; this document was not compiled,
    // so the runtime is the last line of defence and must hold on its own.
    delete at(doc, 'tools').auth;
    const { tool, recorder } = recordingTool('wiper');
    const harness = build(doc, { tools: [tool], script: [ScriptedTurn.tool('wiper', {})] });

    const error = await refusal(harness.runtime.run('solo', QUESTION, { principal: ADMIN }));

    expect(error).toBeInstanceOf(ToolPermissionError);
    expect(error.message).toMatch(/declares no auth policy/);
    expect(recorder.calls).toBe(0);
  });

  it('denies a call the auth policy refuses for this principal', async () => {
    const doc = solo({
      toolSpecs: [toolDef('manage', 'manage', { sideEffects: 'read', auth: ADMIN_ONLY })],
      tools: ['manage'],
    });
    const { tool, recorder } = recordingTool('manage');
    const harness = build(doc, { tools: [tool], script: [ScriptedTurn.tool('manage', {})] });

    const error = await refusal(harness.runtime.run('solo', QUESTION, { principal: VIEWER }));

    expect(error).toBeInstanceOf(ToolPermissionError);
    expect(error.message).toMatch(/denies this principal/);
    expect(recorder.calls).toBe(0);
  });

  it('treats a policy it cannot decide as a denial, not as an allow', async () => {
    const doc = solo({
      toolSpecs: [
        toolDef('manage', 'manage', {
          sideEffects: 'read',
          auth: { kind: 'call', name: 'vibes', args: [] },
        }),
      ],
      tools: ['manage'],
    });
    const { tool, recorder } = recordingTool('manage');
    const harness = build(doc, { tools: [tool], script: [ScriptedTurn.tool('manage', {})] });

    const error = await refusal(harness.runtime.run('solo', QUESTION, { principal: ADMIN }));

    expect(error).toBeInstanceOf(ToolPermissionError);
    expect(error.message).toMatch(/could not be decided/);
    expect(recorder.calls).toBe(0);
  });

  it('runs a declared tool whose policy admits this principal', async () => {
    const doc = solo({
      toolSpecs: [toolDef('manage', 'manage', { sideEffects: 'read', auth: ADMIN_ONLY })],
      tools: ['manage'],
    });
    const { tool, recorder } = recordingTool('manage');
    const harness = build(doc, {
      tools: [tool],
      script: [ScriptedTurn.tool('manage', { query: 'order' }), ScriptedTurn.answer('done')],
    });

    const result = await harness.runtime.run('solo', QUESTION, { principal: ADMIN });

    expect(result.status).toBe('completed');
    expect(result.answer).toBe('done');
    expect(recorder.queries).toEqual(['order']);
  });
});

describe('guardrails inside the loop', () => {
  it('blocks a tool call before the handler runs', async () => {
    const doc = solo({
      toolSpecs: [toolDef('search', 'search', { sideEffects: 'read' })],
      tools: ['search'],
      guardrailSpecs: [
        guardrailDef('walled', {
          stages: ['tool-call'],
          tools: ['search'],
          policies: ['pii-detect'],
        }),
      ],
    });
    const { tool, recorder } = recordingTool();
    const harness = build(doc, {
      tools: [tool],
      script: [ScriptedTurn.tool('search', { query: ADDRESS })],
    });

    const error = await refusal(harness.runtime.run('solo', QUESTION, { principal: ADMIN }));

    expect(error).toBeInstanceOf(GuardrailBlockedError);
    expect(error.message).toMatch(/guardrail 'walled' blocked the tool-call stage/);
    expect(recorder.calls).toBe(0);
  });

  it('redacts the argument the handler receives', async () => {
    const doc = solo({
      toolSpecs: [toolDef('search', 'search', { sideEffects: 'read' })],
      tools: ['search'],
      guardrailSpecs: [
        guardrailDef('scrub', {
          stages: ['tool-call'],
          tools: ['search'],
          policies: ['pii-detect'],
          action: 'redact',
          redact: ['query'],
        }),
      ],
    });
    const { tool, recorder } = recordingTool();
    const harness = build(doc, {
      tools: [tool],
      script: [
        ScriptedTurn.tool('search', { query: `find ${ADDRESS}` }),
        ScriptedTurn.answer('done'),
      ],
    });

    const result = await harness.runtime.run('solo', QUESTION, { principal: ADMIN });

    expect(result.status).toBe('completed');
    expect(recorder.queries).toEqual(['find [REDACTED:pii-detect]']);
    expect(result.guardrails.map((record) => record.action)).toEqual(['redact']);
  });

  it('blocks an answer the output stage refuses, after the model wrote it', async () => {
    const doc = solo({
      guardrailSpecs: [guardrailDef('g-out', { stages: ['output'], policies: ['toxicity'] })],
    });
    const harness = build(doc, { script: [ScriptedTurn.answer(TOXIC)] });

    const error = await refusal(harness.runtime.run('solo', QUESTION, { principal: ADMIN }));

    expect(error).toBeInstanceOf(GuardrailBlockedError);
    expect(error.message).toMatch(/guardrail 'g-out' blocked the output stage/);
    // The model was asked exactly once. "Raised" alone would also pass for a check that
    // ran before the completion call, which would block a prompt instead of an answer.
    expect(harness.provider.calls.length).toBe(1);
  });

  it('pauses on an escalating tool call and runs it on approval', async () => {
    const doc = solo({
      toolSpecs: [toolDef('search', 'search', { sideEffects: 'read' })],
      tools: ['search'],
      guardrailSpecs: [
        guardrailDef('ask', {
          stages: ['tool-call'],
          tools: ['search'],
          policies: ['pii-detect'],
          action: 'escalate',
        }),
      ],
    });
    const { tool, recorder } = recordingTool();
    const harness = build(doc, {
      tools: [tool],
      script: [ScriptedTurn.tool('search', { query: ADDRESS }), ScriptedTurn.answer('done')],
    });

    const paused = await harness.runtime.run('solo', QUESTION, { principal: ADMIN });

    expect(paused.status).toBe('paused');
    expect(paused.checkpoint?.escalation?.stage).toBe('tool-call');
    expect(recorder.calls).toBe(0);

    const result = await harness.runtime.resume(paused.checkpoint as AgentCheckpoint, 'approve', {
      principal: ADMIN,
    });

    expect(result.status).toBe('completed');
    expect(recorder.queries).toEqual([ADDRESS]);
  });

  it('releases an approved output-stage escalation without re-generating it', async () => {
    const doc = solo({
      guardrailSpecs: [
        guardrailDef('reviewed', {
          stages: ['output'],
          policies: ['pii-detect'],
          action: 'escalate',
          message: 'an address needs a human',
        }),
      ],
    });
    const harness = build(doc, { script: [ScriptedTurn.answer(`mail ${ADDRESS}`)] });

    const paused = await harness.runtime.run('solo', QUESTION, { principal: ADMIN });

    expect(paused.status).toBe('paused');
    expect(paused.checkpoint?.escalation?.stage).toBe('output');
    const asked = harness.provider.calls.length;

    const result = await harness.runtime.resume(paused.checkpoint as AgentCheckpoint, 'approve', {
      principal: ADMIN,
    });

    expect(result.status).toBe('completed');
    expect(result.answer).toBe(`mail ${ADDRESS}`);
    // The model already produced this answer and a person released it; asking again would
    // spend tokens and could produce an answer nobody approved.
    expect(harness.provider.calls.length).toBe(asked);
  });

  it('stops a rejected output-stage escalation with the guardrail message', async () => {
    const doc = solo({
      guardrailSpecs: [
        guardrailDef('reviewed', {
          stages: ['output'],
          policies: ['pii-detect'],
          action: 'escalate',
          message: 'an address needs a human',
        }),
      ],
    });
    const harness = build(doc, { script: [ScriptedTurn.answer(`mail ${ADDRESS}`)] });
    const paused = await harness.runtime.run('solo', QUESTION, { principal: ADMIN });
    const asked = harness.provider.calls.length;

    const result = await harness.runtime.resume(paused.checkpoint as AgentCheckpoint, 'reject', {
      principal: ADMIN,
    });

    expect(result.status).toBe('blocked');
    expect(result.answer).toBe('an address needs a human');
    expect(harness.provider.calls.length).toBe(asked);
  });
});

describe('a forged checkpoint', () => {
  it('is refused when its caller link holds no pending call', async () => {
    const doc = document({
      models: [modelDef('cheap')],
      prompts: [promptDef('front', 'front'), promptDef('worker', 'worker')],
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
    const { tool } = recordingTool();
    const harness = build(doc, {
      tools: [tool],
      script: [
        ScriptedTurn.tool('delegate_to_worker', { message: 'check the order' }),
        ScriptedTurn.tool('search', { query: 'order' }),
      ],
    });
    const paused = await harness.runtime.run('front', QUESTION, { principal: ADMIN });
    const caller = paused.checkpoint?.caller;
    expect(caller).toBeDefined();
    const forged: AgentCheckpoint = {
      ...(paused.checkpoint as AgentCheckpoint),
      caller: { ...(caller as AgentCheckpoint), calls: [] },
    };

    const error = await refusal(harness.runtime.resume(forged, 'approve', { principal: ADMIN }));

    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error.message).toMatch(/holds no pending call/);
  });
});
