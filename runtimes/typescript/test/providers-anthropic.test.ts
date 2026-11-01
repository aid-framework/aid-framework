/**
 * The Anthropic adapter: the Messages API, which diverges from the OpenAI shape.
 *
 * These tests are wire-level rather than behavioural because the interesting risks
 * are all translation risks: the system prompt is not a message role, `max_tokens` is
 * mandatory, tool results are user turns, and 529 is overload rather than a client
 * error. Each would produce a request the API rejects, so each gets an assertion.
 */

import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../src/index.js';
import {
  ANTHROPIC_VERSION,
  AnthropicProvider,
  CompletionRequest,
  DEFAULT_ANTHROPIC_BASE_URL,
  Message,
  ProviderError,
  ProviderResponseError,
  supports,
  ToolCall,
  ToolDefinition,
} from '../src/index.js';
import { at, smallSpec } from './support.js';

const OK_BODY = JSON.stringify({
  content: [{ type: 'text', text: 'Paris' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 12, output_tokens: 3 },
});

interface Reply {
  readonly status?: number;
  readonly body: string;
}

/** A `FetchLike` that replays `replies` in order and records what it was sent. */
function stubFetch(replies: readonly Reply[]): {
  readonly fetch: FetchLike;
  readonly calls: { url: string; body: string; headers: Readonly<Record<string, string>> }[];
} {
  const calls: { url: string; body: string; headers: Readonly<Record<string, string>> }[] = [];
  let index = 0;
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, body: init.body, headers: init.headers });
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;
    if (reply === undefined) throw new Error('no reply queued');
    return Promise.resolve({
      ok: (reply.status ?? 200) >= 200 && (reply.status ?? 200) < 300,
      status: reply.status ?? 200,
      text: () => Promise.resolve(reply.body),
    });
  };
  return { fetch, calls };
}

function provider(fetch: FetchLike, options: Record<string, unknown> = {}): AnthropicProvider {
  return new AnthropicProvider({
    apiKey: 'test-key',
    fetchImpl: fetch,
    backoffSeconds: 0,
    ...options,
  });
}

function ask(text: string): CompletionRequest {
  return CompletionRequest.prompt(text);
}

function sentBody(body: string): Record<string, unknown> {
  return JSON.parse(body) as Record<string, unknown>;
}

describe('AnthropicProvider', () => {
  it('posts to /messages and parses the answer', async () => {
    const stub = stubFetch([{ body: OK_BODY }]);
    const response = await provider(stub.fetch).complete(ask('capital?'), smallSpec());

    expect(response.text).toBe('Paris');
    expect(response.model).toBe('fake-small-1');
    expect(response.provider).toBe('anthropic');
    expect(response.usage.toJSON()).toEqual({ inputTokens: 12, outputTokens: 3 });
    expect(at(stub.calls, 0).url).toBe('https://api.anthropic.com/v1/messages');
    expect(DEFAULT_ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com/v1');
  });

  it('moves the system prompt to a top-level field and joins adjacent systems', async () => {
    const stub = stubFetch([{ body: OK_BODY }]);
    const request = new CompletionRequest({
      messages: [Message.system('be terse'), Message.system('cite sources'), Message.user('x')],
    });
    await provider(stub.fetch).complete(request, smallSpec());

    const sent = sentBody(at(stub.calls, 0).body);
    expect(sent.system).toBe('be terse\n\ncite sources');
    expect(sent.messages).toEqual([{ role: 'user', content: 'x' }]);
  });

  it('omits the system field when there is no system prompt', async () => {
    const stub = stubFetch([{ body: OK_BODY }]);
    await provider(stub.fetch).complete(ask('x'), smallSpec());

    expect(sentBody(at(stub.calls, 0).body)).not.toHaveProperty('system');
  });

  it('always sends max_tokens, clamped to the model ceiling', async () => {
    const stub = stubFetch([{ body: OK_BODY }]);
    await provider(stub.fetch).complete(ask('x'), smallSpec());

    // A missing max_tokens is a 400 from the API, so it is not optional here.
    expect(sentBody(at(stub.calls, 0).body).max_tokens).toBe(4096);
  });

  it('clamps an oversized requested max_tokens', async () => {
    const stub = stubFetch([{ body: OK_BODY }]);
    const request = new CompletionRequest({
      messages: [Message.user('x')],
      maxOutputTokens: 999_999,
    });
    await provider(stub.fetch).complete(request, smallSpec());

    expect(sentBody(at(stub.calls, 0).body).max_tokens).toBe(4096);
  });

  it('sends tools with input_schema, temperature and stop sequences', async () => {
    const stub = stubFetch([{ body: OK_BODY }]);
    const request = new CompletionRequest({
      messages: [Message.user('x')],
      temperature: 0.2,
      stop: ['\n\n'],
      tools: [
        new ToolDefinition({ name: 'lookup', description: 'd', parameters: { type: 'object' } }),
      ],
    });
    await provider(stub.fetch).complete(request, smallSpec());

    const sent = sentBody(at(stub.calls, 0).body);
    expect(sent.temperature).toBe(0.2);
    expect(sent.stop_sequences).toEqual(['\n\n']);
    expect(sent.tools).toEqual([
      { name: 'lookup', description: 'd', input_schema: { type: 'object' } },
    ]);
  });

  it('serialises an assistant tool-call turn as tool_use blocks', async () => {
    const stub = stubFetch([{ body: OK_BODY }]);
    const call = new ToolCall({ id: 'call_1', name: 'lookup', arguments: { q: 'x' } });
    const request = new CompletionRequest({
      messages: [Message.user('go'), Message.assistantToolCalls('thinking', [call])],
    });
    await provider(stub.fetch).complete(request, smallSpec());

    expect(sentBody(at(stub.calls, 0).body).messages).toEqual([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'thinking' },
          { type: 'tool_use', id: 'call_1', name: 'lookup', input: { q: 'x' } },
        ],
      },
    ]);
  });

  it('merges adjacent tool results into a single user turn', async () => {
    // Splitting them into one user turn per result is rejected by the API, so the
    // merge is the behaviour, not an optimisation.
    const stub = stubFetch([{ body: OK_BODY }]);
    const request = new CompletionRequest({
      messages: [
        Message.user('go'),
        Message.assistantToolCalls('', [
          new ToolCall({ id: 'a', name: 'one', arguments: {} }),
          new ToolCall({ id: 'b', name: 'two', arguments: {} }),
        ]),
        Message.tool('a', 'first'),
        Message.tool('b', 'second'),
      ],
    });
    await provider(stub.fetch).complete(request, smallSpec());

    const messages = sentBody(at(stub.calls, 0).body).messages as unknown[];
    expect(messages).toHaveLength(3);
    expect(at(messages, 2)).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'a', content: 'first' },
        { type: 'tool_result', tool_use_id: 'b', content: 'second' },
      ],
    });
  });

  it('skips an assistant turn with neither text nor calls', async () => {
    // `content: []` is refused by the API, and the turn carries no information.
    const stub = stubFetch([{ body: OK_BODY }]);
    const request = new CompletionRequest({
      messages: [Message.user('go'), Message.assistant('')],
    });
    await provider(stub.fetch).complete(request, smallSpec());

    expect(sentBody(at(stub.calls, 0).body).messages).toEqual([{ role: 'user', content: 'go' }]);
  });

  it('refuses a tool result that has no call id to attribute it to', async () => {
    const stub = stubFetch([{ body: OK_BODY }]);
    const request = new CompletionRequest({
      messages: [new Message('tool', 'orphan')],
    });

    await expect(provider(stub.fetch).complete(request, smallSpec())).rejects.toThrow(
      /tool_call_id/,
    );
    expect(stub.calls).toEqual([]);
  });

  it('authenticates with x-api-key and a pinned version, never a bearer token', async () => {
    const stub = stubFetch([{ body: OK_BODY }]);
    await provider(stub.fetch).complete(ask('x'), smallSpec());

    const headers = at(stub.calls, 0).headers;
    expect(headers['x-api-key']).toBe('test-key');
    expect(headers['anthropic-version']).toBe(ANTHROPIC_VERSION);
    expect(ANTHROPIC_VERSION).toBe('2023-06-01');
    expect(headers).not.toHaveProperty('authorization');
    expect(headers['content-type']).toBe('application/json');
  });

  it('omits x-api-key when no key is configured', async () => {
    const stub = stubFetch([{ body: OK_BODY }]);
    await new AnthropicProvider({ fetchImpl: stub.fetch, backoffSeconds: 0 }).complete(
      ask('x'),
      smallSpec(),
    );

    expect(at(stub.calls, 0).headers).not.toHaveProperty('x-api-key');
  });

  it('passes extra headers through', async () => {
    const stub = stubFetch([{ body: OK_BODY }]);
    await provider(stub.fetch, { extraHeaders: { 'anthropic-beta': 'tools-2024' } }).complete(
      ask('x'),
      smallSpec(),
    );

    expect(at(stub.calls, 0).headers['anthropic-beta']).toBe('tools-2024');
  });

  it('honours a custom base URL and strips trailing slashes', async () => {
    const stub = stubFetch([{ body: OK_BODY }]);
    await provider(stub.fetch, { baseUrl: 'https://example.test/v1/' }).complete(
      ask('x'),
      smallSpec(),
    );

    expect(at(stub.calls, 0).url).toBe('https://example.test/v1/messages');
  });

  it('refuses a base URL that is not absolute http(s)', () => {
    expect(() => new AnthropicProvider({ baseUrl: 'not-a-url' })).toThrow(/absolute http/);
  });

  it('refuses a non-positive max_attempts', () => {
    expect(() => new AnthropicProvider({ maxAttempts: 0 })).toThrow(/at least 1/);
  });

  it('retries 529, which means overloaded and is not a standard HTTP status', async () => {
    const stub = stubFetch([{ status: 529, body: 'overloaded' }, { body: OK_BODY }]);
    const response = await provider(stub.fetch, { maxAttempts: 2 }).complete(ask('x'), smallSpec());

    expect(response.text).toBe('Paris');
    expect(stub.calls).toHaveLength(2);
  });

  it('retries 429 and 500 and 503', async () => {
    for (const status of [429, 500, 503]) {
      const stub = stubFetch([{ status, body: 'busy' }, { body: OK_BODY }]);
      const response = await provider(stub.fetch, { maxAttempts: 2 }).complete(
        ask('x'),
        smallSpec(),
      );
      expect(response.text).toBe('Paris');
    }
  });

  it('does not retry a 400, which is a permanent client error', async () => {
    const stub = stubFetch([{ status: 400, body: 'bad request' }]);

    await expect(
      provider(stub.fetch, { maxAttempts: 3 }).complete(ask('x'), smallSpec()),
    ).rejects.toThrow(/returned 400/);
    expect(stub.calls).toHaveLength(1);
  });

  it('reports the last failure after exhausting its attempts', async () => {
    const stub = stubFetch([{ status: 500, body: 'down' }]);

    await expect(
      provider(stub.fetch, { maxAttempts: 2 }).complete(ask('x'), smallSpec()),
    ).rejects.toThrow(ProviderError);
    expect(stub.calls).toHaveLength(2);
  });

  it('rejects a body that is not JSON', async () => {
    const stub = stubFetch([{ body: '{not json' }]);

    await expect(provider(stub.fetch).complete(ask('x'), smallSpec())).rejects.toThrow(
      ProviderResponseError,
    );
  });

  it('rejects a body that is not an object', async () => {
    const stub = stubFetch([{ body: '[]' }]);

    await expect(provider(stub.fetch).complete(ask('x'), smallSpec())).rejects.toThrow(
      /not an object/,
    );
  });

  it('rejects a body with no content array', async () => {
    const stub = stubFetch([{ body: JSON.stringify({ stop_reason: 'end_turn' }) }]);

    await expect(provider(stub.fetch).complete(ask('x'), smallSpec())).rejects.toThrow(
      /no content blocks/,
    );
  });

  it('parses tool_use blocks into tool calls and reports tool-calls', async () => {
    const stub = stubFetch([
      {
        body: JSON.stringify({
          content: [
            { type: 'text', text: 'let me look' },
            { type: 'tool_use', id: 'call_9', name: 'lookup', input: { q: 'x' } },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 1, output_tokens: 2 },
        }),
      },
    ]);
    const response = await provider(stub.fetch).complete(ask('x'), smallSpec());

    expect(response.text).toBe('let me look');
    expect(response.toolCalls).toHaveLength(1);
    expect(at(response.toolCalls, 0).id).toBe('call_9');
    expect(at(response.toolCalls, 0).name).toBe('lookup');
    expect(at(response.toolCalls, 0).args).toEqual({ q: 'x' });
    expect(response.finishReason).toBe('tool-calls');
  });

  it('defaults a non-object tool input to an empty object', async () => {
    const stub = stubFetch([
      {
        body: JSON.stringify({
          content: [{ type: 'tool_use', id: 'c', name: 'n', input: 'not-an-object' }],
          stop_reason: 'tool_use',
        }),
      },
    ]);
    const response = await provider(stub.fetch).complete(ask('x'), smallSpec());

    expect(at(response.toolCalls, 0).args).toEqual({});
  });

  it('maps every documented stop_reason', async () => {
    const cases: readonly [string, string][] = [
      ['end_turn', 'stop'],
      ['stop_sequence', 'stop'],
      ['max_tokens', 'length'],
      ['tool_use', 'tool-calls'],
      ['refusal', 'content-filter'],
    ];
    for (const [wire, expected] of cases) {
      const stub = stubFetch([
        { body: JSON.stringify({ content: [{ type: 'text', text: '' }], stop_reason: wire }) },
      ]);
      const response = await provider(stub.fetch).complete(ask('x'), smallSpec());
      expect(response.finishReason).toBe(expected);
    }
  });

  it('falls back to stop for an unknown stop_reason', async () => {
    const stub = stubFetch([
      {
        body: JSON.stringify({ content: [{ type: 'text', text: '' }], stop_reason: 'pause_turn' }),
      },
    ]);
    const response = await provider(stub.fetch).complete(ask('x'), smallSpec());

    expect(response.finishReason).toBe('stop');
  });

  it('claims tool-calling and structured-output but not embeddings', () => {
    // The Messages API has no embeddings endpoint; claiming one would let a spec bind
    // a model that can only fail when it is finally called.
    const subject = new AnthropicProvider();
    expect(supports(subject, 'tool-calling')).toBe(true);
    expect(supports(subject, 'structured-output')).toBe(true);
    expect(supports(subject, 'embeddings')).toBe(false);
  });

  it('names itself anthropic by default and honours a custom name', () => {
    expect(new AnthropicProvider().name).toBe('anthropic');
    expect(new AnthropicProvider({ name: 'stub' }).name).toBe('stub');
  });

  it('refuses to complete once closed', async () => {
    const subject = new AnthropicProvider({ fetchImpl: stubFetch([{ body: OK_BODY }]).fetch });

    await subject.close();
    await expect(subject.complete(ask('x'), smallSpec())).rejects.toThrow(/closed/);
  });

  it('closes idempotently', async () => {
    const subject = new AnthropicProvider();

    await subject.close();
    await subject.close();
  });
});
