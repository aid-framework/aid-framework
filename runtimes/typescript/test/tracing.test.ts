/**
 * GenAI tracing.
 *
 * The attribute spellings are the OpenTelemetry GenAI semantic conventions, so they are
 * asserted verbatim: a renamed attribute is a dashboard that silently stops working. The
 * "unset means absent" rule is asserted for the same reason -- a span reporting
 * `input_tokens = 0` for an unmeasured call is a lie a dashboard will happily average.
 */

import { SpanStatusCode } from '@opentelemetry/api';
import { describe, expect, it } from 'vitest';
import {
  ATTRIBUTES,
  aidAttributes,
  GEN_AI_OPERATION_CHAT,
  getTracer,
  llmSpan,
  recordCost,
  recordException,
  recordUsage,
} from '../src/index.js';
import { DEFAULT_TRACER_NAME, spanAttributes, spanName, withLlmSpan } from '../src/tracing.js';

/** A span that records what it was told, so no exporter is needed. */
class RecordingSpan {
  readonly attributes: Record<string, string | number | boolean | string[]> = {};
  readonly events: { name: string; attributes?: Record<string, unknown> }[] = [];
  status: { code: number; message?: string } | undefined;
  ended = 0;
  readonly recorded: Error[] = [];

  setAttribute(key: string, value: string | number | boolean | string[]): this {
    this.attributes[key] = value;
    return this;
  }

  addEvent(name: string, attributes?: Record<string, unknown>): this {
    this.events.push(attributes === undefined ? { name } : { name, attributes });
    return this;
  }

  recordException(error: Error): this {
    this.recorded.push(error);
    return this;
  }

  setStatus(status: { code: number; message?: string }): this {
    this.status = status;
    return this;
  }

  end(): void {
    this.ended += 1;
  }
}

function asSpan(span: RecordingSpan) {
  return span as unknown as Parameters<typeof recordUsage>[0];
}

describe('span attributes', () => {
  it('spells every attribute the way the semantic conventions do', () => {
    expect(ATTRIBUTES).toEqual({
      system: 'gen_ai.system',
      operation: 'gen_ai.operation.name',
      requestModel: 'gen_ai.request.model',
      requestTemperature: 'gen_ai.request.temperature',
      requestMaxTokens: 'gen_ai.request.max_tokens',
      responseModel: 'gen_ai.response.model',
      responseFinishReasons: 'gen_ai.response.finish_reasons',
      inputTokens: 'gen_ai.usage.input_tokens',
      outputTokens: 'gen_ai.usage.output_tokens',
      alias: 'aid.model.alias',
      costUsd: 'aid.cost.usd',
      attempts: 'aid.gateway.attempts',
      toolNames: 'aid.tool.names',
    });
    expect(GEN_AI_OPERATION_CHAT).toBe('chat');
    expect(DEFAULT_TRACER_NAME).toBe('aid_runtime');
  });

  it('sets the operation and the request model', () => {
    expect(spanAttributes({ model: 'gpt-4o' })).toEqual({
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.model': 'gpt-4o',
    });
  });

  it('omits an unset option entirely rather than defaulting it to zero', () => {
    const attributes = spanAttributes({ model: 'm', inputTokens: 0 });

    // An explicit zero is recorded; an absent measurement is not.
    expect(attributes['gen_ai.usage.input_tokens']).toBe(0);
    expect(attributes['gen_ai.usage.output_tokens']).toBeUndefined();
    expect(attributes['gen_ai.request.temperature']).toBeUndefined();
    expect(attributes['aid.cost.usd']).toBeUndefined();
  });

  it('carries every aid.* addition the conventions have no opinion about', () => {
    const attributes = spanAttributes({
      model: 'm',
      system: 'openai',
      alias: 'small',
      costUsd: 0.0012,
      attempts: 2,
      toolNames: ['lookup', 'search'],
    });

    expect(attributes['gen_ai.system']).toBe('openai');
    expect(attributes['aid.model.alias']).toBe('small');
    expect(attributes['aid.cost.usd']).toBe(0.0012);
    expect(attributes['aid.gateway.attempts']).toBe(2);
    expect(attributes['aid.tool.names']).toEqual(['lookup', 'search']);
  });

  it('records response members when they are known before the span starts', () => {
    const attributes = spanAttributes({
      model: 'm',
      responseModel: 'm-2024',
      responseFinishReasons: ['stop'],
      outputTokens: 5,
    });

    expect(attributes['gen_ai.response.model']).toBe('m-2024');
    expect(attributes['gen_ai.response.finish_reasons']).toEqual(['stop']);
    expect(attributes['gen_ai.usage.output_tokens']).toBe(5);
  });

  it('honours an explicit operation', () => {
    expect(spanAttributes({ model: 'm', operation: 'embeddings' })['gen_ai.operation.name']).toBe(
      'embeddings',
    );
  });
});

describe('spanName', () => {
  it('is the operation and the model', () => {
    expect(spanName({ model: 'gpt-4o' })).toBe('chat gpt-4o');
    expect(spanName({ model: 'x', operation: 'embeddings' })).toBe('embeddings x');
  });
});

describe('span recording', () => {
  it('records usage on an already-started span', () => {
    const span = new RecordingSpan();
    recordUsage(asSpan(span), 11, 7);

    expect(span.attributes['gen_ai.usage.input_tokens']).toBe(11);
    expect(span.attributes['gen_ai.usage.output_tokens']).toBe(7);
  });

  it('records cost without touching the alias', () => {
    const span = new RecordingSpan();
    span.setAttribute('aid.model.alias', 'small');
    recordCost(asSpan(span), 0.5);

    expect(span.attributes['aid.cost.usd']).toBe(0.5);
    expect(span.attributes['aid.model.alias']).toBe('small');
  });

  it('records an exception once and marks the span failed', () => {
    const span = new RecordingSpan();
    recordException(asSpan(span), new Error('kaboom'));

    expect(span.recorded).toHaveLength(1);
    expect(span.recorded[0]?.message).toBe('kaboom');
    expect(span.status?.code).toBe(SpanStatusCode.ERROR);
    expect(span.status?.message).toBe('kaboom');
  });

  it('survives a thrown value that is not an Error', () => {
    const span = new RecordingSpan();
    expect(() => recordException(asSpan(span), 'a bare string')).not.toThrow();
    expect(span.recorded).toHaveLength(1);
    expect(span.recorded[0]?.message).toBe('a bare string');
  });

  it('stringifies a thrown value that is neither an Error nor a string', () => {
    const span = new RecordingSpan();
    recordException(asSpan(span), 42);

    expect(span.recorded[0]?.message).toBe('42');
  });
});

describe('llmSpan', () => {
  it('starts a span that can be ended exactly once', () => {
    const handle = llmSpan({ model: 'm', alias: 'small' });

    handle.recordUsage(1, 2);
    handle.recordCost(0);
    handle.end();
    handle.end();

    expect(handle.span).toBeDefined();
  });

  it('records an exception and ends the span', () => {
    const handle = llmSpan({ model: 'm' });
    handle.recordException(new Error('nope'));
    handle.end();
    expect(handle.span).toBeDefined();
  });
});

describe('withLlmSpan', () => {
  it('returns the body result', async () => {
    const value = await withLlmSpan({ model: 'm' }, () => Promise.resolve('answer'));
    expect(value).toBe('answer');
  });

  it('passes a usable handle to the body', async () => {
    const value = await withLlmSpan({ model: 'm' }, (handle) => {
      handle.recordUsage(3, 4);
      handle.recordCost(0.25);
      return Promise.resolve(handle.span !== undefined);
    });

    expect(value).toBe(true);
  });

  it('propagates a failure from the body', async () => {
    await expect(
      withLlmSpan({ model: 'm' }, () => Promise.reject(new Error('provider exploded'))),
    ).rejects.toThrow(/provider exploded/);
  });

  it('works with the no-op tracer a bare application gets', () => {
    // Tracing must not be a precondition for calling a model.
    expect(getTracer().startSpan('x')).toBeDefined();
    expect(getTracer('custom')).toBeDefined();
  });
});

describe('aidAttributes', () => {
  it('passes arbitrary named values through', () => {
    expect(aidAttributes({ 'aid.dataset': 'capitals', 'aid.cases': 4, 'aid.gate': true })).toEqual({
      'aid.dataset': 'capitals',
      'aid.cases': 4,
      'aid.gate': true,
    });
  });

  it('is empty for no values', () => {
    expect(aidAttributes({})).toEqual({});
  });
});
