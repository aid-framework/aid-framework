/**
 * The value types.
 *
 * Nothing here is clever; the point is that the invariants other modules rely on are
 * actually enforced. Two in particular: `TokenUsage.add` is component-wise so a retry
 * chain is arithmetic, and `CompletionRequest.fingerprint` treats an omitted option and
 * an explicit `undefined` as the same request, so a recorded fingerprint does not change
 * because a caller started spelling out the default.
 */

import { describe, expect, it } from 'vitest';

import {
  CompletionRequest,
  CompletionResponse,
  CostProfile,
  GenerationResult,
  Message,
  PinnedModel,
  TokenUsage,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from '../src/index.js';
import { largeSpec, smallSpec, usage } from './support.js';

describe('Message', () => {
  it('builds the three roles', () => {
    expect(Message.system('be terse').toJSON()).toEqual({ role: 'system', content: 'be terse' });
    expect(Message.user('hi').role).toBe('user');
    expect(Message.assistant('hello').content).toBe('hello');
  });
});

describe('TokenUsage', () => {
  it('defaults to zero and totals both components', () => {
    const empty = new TokenUsage();
    expect(empty.inputTokens).toBe(0);
    expect(empty.outputTokens).toBe(0);
    expect(empty.totalTokens).toBe(0);
    expect(usage(10, 5).totalTokens).toBe(15);
  });

  it('adds component-wise rather than by total', () => {
    const merged = usage(10, 5).add(usage(1, 2));
    expect(merged.toJSON()).toEqual({ inputTokens: 11, outputTokens: 7 });
    // The total is derived, so it cannot drift from the components.
    expect(merged.totalTokens).toBe(18);
  });

  it('does not mutate the operand', () => {
    const original = usage(10, 5);
    original.add(usage(100, 100));
    expect(original.toJSON()).toEqual({ inputTokens: 10, outputTokens: 5 });
  });
});

describe('CostProfile', () => {
  it('prices input and output per thousand tokens', () => {
    const price = new CostProfile({ inputPer1kUsd: 0.15, outputPer1kUsd: 0.6 });

    // 1000 in at 0.15 + 500 out at 0.6 per 1k.
    expect(price.costUsd(usage(1000, 500))).toBeCloseTo(0.45, 10);
    expect(price.costUsd(usage(0, 0))).toBe(0);
  });

  it('rounds to six decimals so charges stay stable in a ledger', () => {
    const price = new CostProfile({ inputPer1kUsd: 0.1, outputPer1kUsd: 0.3 });
    const cost = price.costUsd(usage(1, 1));
    expect(cost).toBe(0.0004);
    expect(String(cost).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(6);
  });
});

describe('ModelSpec', () => {
  it('records its declared capabilities as a set', () => {
    const spec = smallSpec();
    expect(spec.name).toBe('fake-small-1');
    expect(spec.provider).toBe('fake');
    expect(spec.capabilities.has('structured-output')).toBe(true);
    expect(spec.capabilities.has('streaming')).toBe(false);
  });

  it('serialises its prices', () => {
    expect(largeSpec().toJSON()).toMatchObject({
      name: 'fake-large-1',
      provider: 'fake',
      contextWindow: 200_000,
      maxOutputTokens: 8192,
    });
  });
});

describe('PinnedModel', () => {
  const pinned = new PinnedModel({ alias: 'small', model: smallSpec() });

  it('requires every requested capability, not just one', () => {
    expect(pinned.supports(['tool-calling'])).toBe(true);
    expect(pinned.supports(['tool-calling', 'structured-output'])).toBe(true);
    expect(pinned.supports([])).toBe(true);
  });

  it('names what is missing so the error can say so', () => {
    expect(pinned.supports(['tool-calling', 'streaming'])).toBe(false);
    expect(pinned.missing(['tool-calling', 'streaming', 'embeddings']).sort()).toEqual([
      'embeddings',
      'streaming',
    ]);
    expect(pinned.missing(['tool-calling'])).toEqual([]);
  });

  it('keeps the alias separate from the model it resolved to', () => {
    expect(pinned.alias).toBe('small');
    expect(pinned.model.name).toBe('fake-small-1');
  });
});

describe('ToolDefinition', () => {
  it('emits the OpenAI tools entry', () => {
    const definition = new ToolDefinition({
      name: 'lookup',
      description: 'Look something up',
      parameters: { type: 'object', properties: { q: { type: 'string' } } },
    });

    expect(definition.asOpenAiTool()).toEqual({
      type: 'function',
      function: {
        name: 'lookup',
        description: 'Look something up',
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
      },
    });
  });

  it('defaults to an unconstrained object schema', () => {
    expect(new ToolDefinition({ name: 'ping' }).parameters).toEqual({
      type: 'object',
      properties: {},
    });
  });
});

describe('ToolCall and ToolResult', () => {
  const call = new ToolCall({ id: 'call-1', name: 'lookup', arguments: { q: 'paris' } });

  it('exposes the arguments under both spellings', () => {
    expect(call.args).toEqual({ q: 'paris' });
    expect(call.arguments).toEqual({ q: 'paris' });
  });

  it('passes a string result through and serialises anything else', () => {
    expect(ToolResult.fromValue(call, 'Paris').content).toBe('Paris');
    expect(ToolResult.fromValue(call, { city: 'Paris' }).content).toBe('{"city":"Paris"}');
    expect(ToolResult.fromValue(call, 'Paris').isError).toBe(false);
  });

  it('marks an error result and keeps the call identity', () => {
    const failure = ToolResult.fromError(call, 'boom');
    expect(failure.isError).toBe(true);
    expect(failure.callId).toBe('call-1');
    expect(failure.name).toBe('lookup');
    expect(failure.toJSON()).toMatchObject({ callId: 'call-1', content: 'boom', isError: true });
  });
});

describe('CompletionRequest', () => {
  it('builds a one-message prompt with an optional system turn', () => {
    const request = CompletionRequest.prompt('hi', 'be terse');
    expect(request.messages.map((message) => message.role)).toEqual(['system', 'user']);
    expect(request.text).toContain('be terse');
    expect(request.text).toContain('hi');
  });

  it('fingerprints identically whether an option is omitted or explicitly undefined', () => {
    const omitted = new CompletionRequest({ messages: [Message.user('hi')] });
    const explicit = new CompletionRequest({
      messages: [Message.user('hi')],
      temperature: undefined,
    });

    expect(omitted.fingerprint()).toBe(explicit.fingerprint());
  });

  it('fingerprints differently when the request actually differs', () => {
    const base = new CompletionRequest({ messages: [Message.user('hi')] });
    const warmer = new CompletionRequest({ messages: [Message.user('hi')], temperature: 0.9 });
    const other = CompletionRequest.prompt('hello');

    expect(warmer.fingerprint()).not.toBe(base.fingerprint());
    expect(other.fingerprint()).not.toBe(base.fingerprint());
  });

  it('fingerprints stably across calls', () => {
    const request = CompletionRequest.prompt('hi');
    expect(request.fingerprint()).toBe(request.fingerprint());
    expect(request.fingerprint()).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('CompletionResponse', () => {
  it('defaults to a stop with no tool calls and no usage', () => {
    const response = new CompletionResponse({ text: 'Paris', model: 'm', provider: 'p' });

    expect(response.finishReason).toBe('stop');
    expect(response.toolCalls).toEqual([]);
    expect(response.usage.totalTokens).toBe(0);
  });
});

describe('GenerationResult', () => {
  const response = new CompletionResponse({
    text: 'Paris',
    model: 'fake-small-1',
    provider: 'fake',
    usage: usage(10, 2),
  });

  it('derives fellBack from the attempt chain', () => {
    expect(new GenerationResult({ response, alias: 'small', costUsd: 0 }).fellBack).toBe(false);
    expect(
      new GenerationResult({
        response,
        alias: 'large',
        costUsd: 0,
        attempts: ['small', 'large'],
      }).fellBack,
    ).toBe(true);
  });

  it('exposes the response parts directly', () => {
    const generated = new GenerationResult({ response, alias: 'small', costUsd: 0.1 });
    expect(generated.text).toBe('Paris');
    expect(generated.usage.totalTokens).toBe(12);
    expect(generated.costUsd).toBe(0.1);
  });
});
