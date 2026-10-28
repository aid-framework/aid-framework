/**
 * The checkpoint wire codec.
 *
 * A resumed run is the one thing in this runtime that leaves the process, so the codec has
 * to carry every field a pause needs -- including the guardrail records and the escalation
 * that explain *why* it paused. `agents-hitl.test.ts` proves a real pause resumes across
 * JSON; this suite proves the codec is lossless in the parts that run cannot reach, by
 * comparing the restored value to the original rather than to the JSON it just wrote.
 */

import { describe, expect, it } from 'vitest';

import {
  type AgentCheckpoint,
  checkpointFromJson,
  checkpointsEqual,
  checkpointToJson,
  type GuardrailEscalation,
  type GuardrailRecord,
  Message,
  pendingApprovalFrom,
  ToolCall,
} from '../src/index.js';

const ANSWER_STEP = {
  index: 0,
  agentId: 'solo',
  kind: 'answer',
  alias: 'cheap',
  model: 'cheap-1',
  costUsd: 0.01,
  totalTokens: 12,
  toolNames: [],
  target: undefined,
  degradedFrom: undefined,
} as const;

function checkpoint(overrides: Partial<AgentCheckpoint> = {}): AgentCheckpoint {
  return {
    agentId: 'solo',
    step: 2,
    messages: [Message.system('sys'), Message.user('hi'), Message.assistant('hello')],
    steps: [ANSWER_STEP],
    calls: [],
    channel: '',
    when: {},
    resumeKind: 'approve',
    costAnchorUsd: 0,
    tokenAnchor: 0,
    spentUsd: 0.01,
    spentTokens: 12,
    degraded: false,
    alias: 'cheap',
    path: ['solo'],
    memoryKey: 'solo',
    caller: undefined,
    escalation: undefined,
    guardrails: [],
    ...overrides,
  };
}

const RECORD: GuardrailRecord = {
  guardrail: 'pii',
  stage: 'output',
  action: 'escalate',
  policies: ['pii-detect'],
  message: 'an address needs a human',
};

const ESCALATION: GuardrailEscalation = {
  guardrail: 'pii',
  stage: 'output',
  message: 'an address needs a human',
  channel: 'review',
  text: 'mail me at ada@example.com',
};

describe('checkpoint codec', () => {
  it('round-trips a checkpoint without losing a field', () => {
    const original = checkpoint();
    const restored = checkpointFromJson(checkpointToJson(original) as never);

    expect(checkpointsEqual(original, restored)).toBe(true);
    expect(restored.step).toBe(2);
    expect(restored.steps[0]?.agentId).toBe('solo');
    expect(restored.path).toEqual(['solo']);
  });

  it('restores messages and calls as instances, not plain objects', () => {
    const call = new ToolCall({ id: 'call-1', name: 'search', arguments: { query: 'hours' } });
    const original = checkpoint({
      messages: [
        Message.system('sys'),
        Message.assistantToolCalls('', [call]),
        Message.tool('call-1', 'sunny', { name: 'search' }),
      ],
      calls: [call],
    });

    const restored = checkpointFromJson(checkpointToJson(original) as never);

    expect(restored.messages.every((message) => message instanceof Message)).toBe(true);
    expect(restored.messages[1]?.toolCalls[0]).toBeInstanceOf(ToolCall);
    expect(restored.messages[2]?.toolCallId).toBe('call-1');
    expect(restored.calls[0]).toBeInstanceOf(ToolCall);
    expect(restored.calls[0]?.arguments).toEqual({ query: 'hours' });
    expect(checkpointsEqual(original, restored)).toBe(true);
  });

  it('round-trips the guardrail records and the escalation that explain the pause', () => {
    const original = checkpoint({ guardrails: [RECORD], escalation: ESCALATION });

    const restored = checkpointFromJson(checkpointToJson(original) as never);

    expect(restored.guardrails).toEqual([RECORD]);
    expect(restored.escalation).toEqual(ESCALATION);
    expect(checkpointsEqual(original, restored)).toBe(true);
  });

  it('round-trips a delegate checkpoint through its caller link', () => {
    const original = checkpoint({
      resumeKind: 'delegate',
      agentId: 'worker',
      caller: checkpoint({ agentId: 'main', calls: [new ToolCall({ id: 'd1', name: 'ask' })] }),
    });

    const restored = checkpointFromJson(checkpointToJson(original) as never);

    expect(restored.caller?.agentId).toBe('main');
    expect(restored.caller?.calls[0]).toBeInstanceOf(ToolCall);
    expect(checkpointsEqual(original, restored)).toBe(true);
  });

  it('projects the pending question out of a checkpoint', () => {
    const original = checkpoint({ channel: 'review', escalation: ESCALATION });
    const approval = pendingApprovalFrom(original);

    expect(approval.agentId).toBe('solo');
    expect(approval.channel).toBe('review');
    expect(approval.step).toBe(2);
    expect(approval.escalation).toEqual(ESCALATION);
    expect(approval.path).toEqual(['solo']);
  });
});

describe('checkpointsEqual', () => {
  it('accepts a value compared with itself', () => {
    const value = checkpoint();

    expect(checkpointsEqual(value, value)).toBe(true);
  });

  it('reports a single changed field as different', () => {
    expect(checkpointsEqual(checkpoint(), checkpoint({ step: 3 }))).toBe(false);
    expect(checkpointsEqual(checkpoint(), checkpoint({ spentUsd: 0.02 }))).toBe(false);
  });

  it('reports a different collection length as different', () => {
    const call = new ToolCall({ id: 'c1', name: 'search', arguments: {} });
    expect(checkpointsEqual(checkpoint(), checkpoint({ messages: [Message.user('hi')] }))).toBe(
      false,
    );
    expect(checkpointsEqual(checkpoint(), checkpoint({ steps: [] }))).toBe(false);
    expect(checkpointsEqual(checkpoint({ calls: [call] }), checkpoint())).toBe(false);
    expect(checkpointsEqual(checkpoint({ guardrails: [RECORD] }), checkpoint())).toBe(false);
  });

  it('refuses equality when a message did not come back as a Message', () => {
    const plain = { role: 'user', content: 'hi' } as unknown as Message;

    expect(
      checkpointsEqual(checkpoint({ messages: [plain] }), checkpoint({ messages: [plain] })),
    ).toBe(false);
  });

  it('refuses equality when a call did not come back as a ToolCall', () => {
    const plain = { id: 'c1', name: 'search', args: {} } as unknown as ToolCall;

    expect(checkpointsEqual(checkpoint({ calls: [plain] }), checkpoint({ calls: [plain] }))).toBe(
      false,
    );
  });

  it('compares nested values rather than only key names', () => {
    const nested = (when: Record<string, unknown>) => checkpoint({ when });

    expect(checkpointsEqual(nested({ a: { b: 1 } }), nested({ a: { b: 1 } }))).toBe(true);
    expect(checkpointsEqual(nested({ a: { b: 1 } }), nested({ a: { b: 2 } }))).toBe(false);
    expect(checkpointsEqual(nested({ a: 1 }), nested({}))).toBe(false);
    expect(checkpointsEqual(nested({ a: null }), nested({ a: 1 }))).toBe(false);
    expect(checkpointsEqual(nested({ a: 1 }), nested({ a: '1' }))).toBe(false);
    expect(checkpointsEqual(nested({ a: [1] }), nested({ a: [1, 2] }))).toBe(false);
    expect(checkpointsEqual(nested({ a: [1] }), nested({ a: { 0: 1 } }))).toBe(false);
  });
});
