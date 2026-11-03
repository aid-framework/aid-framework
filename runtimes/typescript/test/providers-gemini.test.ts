/**
 * The public Gemini API adapter: the key header, the fixed host, and the retry rule.
 *
 * The wire is Vertex's -- `providers/gemini-wire.ts` -- so the parity test at the end
 * builds one request through both adapters and asserts the bodies are byte-identical.
 * What is pinned here is everything Vertex does not have, including the `400` that a
 * bad key produces and that must not be retried.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { FetchLike } from '../src/index.js';
import {
  CompletionRequest,
  CostProfile,
  DEFAULT_GEMINI_BASE_URL,
  GEMINI_API_KEY_ENV,
  GeminiProvider,
  Message,
  ModelSpec,
  ProviderError,
  ProviderResponseError,
  supports,
  ToolCall,
  ToolDefinition,
  VertexProvider,
} from '../src/index.js';
import { at } from './support.js';

const MODEL_ID = 'gemini-2.5-flash';

afterEach(() => {
  delete process.env[GEMINI_API_KEY_ENV];
});

interface Reply {
  readonly status?: number;
  readonly body: string;
}

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
}

function stubFetch(replies: readonly Reply[]): {
  readonly fetch: FetchLike;
  readonly calls: Call[];
} {
  const calls: Call[] = [];
  let index = 0;
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, method: init.method, body: init.body ?? '', headers: init.headers });
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

function geminiSpec(provider = 'gemini'): ModelSpec {
  return new ModelSpec({
    name: MODEL_ID,
    provider,
    cost: new CostProfile({ inputPer1kUsd: 0.0001, outputPer1kUsd: 0.0004 }),
    contextWindow: 1_000_000,
    maxOutputTokens: 4096,
    capabilities: ['tool-calling', 'structured-output'],
  });
}

function reply(parts: readonly Record<string, unknown>[], finishReason = 'STOP'): Reply {
  return {
    body: JSON.stringify({
      candidates: [{ content: { role: 'model', parts }, finishReason }],
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3 },
    }),
  };
}

function text(value: string): Record<string, unknown> {
  return { text: value };
}

function ask(value: string): CompletionRequest {
  return new CompletionRequest({ messages: [new Message('user', value)] });
}

function provider(fetchImpl: FetchLike, options: Record<string, unknown> = {}): GeminiProvider {
  return new GeminiProvider({
    apiKey: 'key-123',
    fetchImpl,
    backoffSeconds: 0,
    ...options,
  });
}

describe('the Gemini adapter', () => {
  it('posts to the v1beta endpoint with the key header and no bearer token', async () => {
    const { fetch: fetchImpl, calls } = stubFetch([reply([text('Paris')])]);
    const response = await provider(fetchImpl).complete(ask('capital?'), geminiSpec());

    const call = at(calls, 0);
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`${DEFAULT_GEMINI_BASE_URL}/v1beta/models/${MODEL_ID}:generateContent`);
    expect(call.headers['x-goog-api-key']).toBe('key-123');
    expect(call.headers.authorization).toBeUndefined();
    expect(response.text).toBe('Paris');
    expect(response.provider).toBe('gemini');
    expect(response.usage.inputTokens).toBe(12);
    expect(response.finishReason).toBe('stop');
  });

  it('reads the key from the environment', async () => {
    process.env[GEMINI_API_KEY_ENV] = 'from-env';
    const { fetch: fetchImpl, calls } = stubFetch([reply([text('ok')])]);
    await provider(fetchImpl, { apiKey: undefined }).complete(ask('x'), geminiSpec());

    expect(at(calls, 0).headers['x-goog-api-key']).toBe('from-env');
  });

  it('reports a missing key without sending a request', async () => {
    const { fetch: fetchImpl, calls } = stubFetch([reply([text('ok')])]);
    await expect(
      provider(fetchImpl, { apiKey: undefined }).complete(ask('x'), geminiSpec()),
    ).rejects.toThrow(GEMINI_API_KEY_ENV);
    expect(calls).toHaveLength(0);
  });

  it('advertises tool calling and structured output, not streaming', () => {
    const instance = new GeminiProvider({ apiKey: 'k' });
    expect(supports(instance, 'tool-calling')).toBe(true);
    expect(supports(instance, 'structured-output')).toBe(true);
    expect(supports(instance, 'streaming')).toBe(false);
  });

  it('overrides the host for a stub', async () => {
    const { fetch: fetchImpl, calls } = stubFetch([reply([text('ok')])]);
    await provider(fetchImpl, { baseUrl: 'http://stub/' }).complete(ask('x'), geminiSpec());
    expect(at(calls, 0).url).toBe(`http://stub/v1beta/models/${MODEL_ID}:generateContent`);
  });

  it('does not retry a bad key', async () => {
    const { fetch: fetchImpl, calls } = stubFetch([
      { status: 400, body: JSON.stringify({ error: { status: 'FAILED_PRECONDITION' } }) },
      reply([text('unreachable')]),
    ]);
    await expect(provider(fetchImpl).complete(ask('x'), geminiSpec())).rejects.toThrow('400');
    expect(calls).toHaveLength(1);
  });

  it('retries a retryable status then succeeds with the same body', async () => {
    const { fetch: fetchImpl, calls } = stubFetch([
      { status: 429, body: 'slow down' },
      reply([text('Paris')]),
    ]);
    const response = await provider(fetchImpl).complete(ask('x'), geminiSpec());

    expect(calls).toHaveLength(2);
    expect(at(calls, 0).body).toBe(at(calls, 1).body);
    expect(response.text).toBe('Paris');
  });

  it('maps safety and length finish reasons', async () => {
    const cases: readonly [string, string][] = [
      ['SAFETY', 'content-filter'],
      ['MAX_TOKENS', 'length'],
    ];
    for (const [raw, expected] of cases) {
      const { fetch: fetchImpl } = stubFetch([reply([text('')], raw)]);
      const response = await provider(fetchImpl).complete(ask('x'), geminiSpec());
      expect(response.finishReason).toBe(expected);
    }
  });

  it('parses a function call into a tool call', async () => {
    const { fetch: fetchImpl } = stubFetch([
      reply([{ functionCall: { name: 'lookup', args: { city: 'Paris' } } }]),
    ]);
    const response = await provider(fetchImpl).complete(ask('x'), geminiSpec());

    expect(response.finishReason).toBe('tool-calls');
    expect(response.toolCalls).toHaveLength(1);
    expect(at(response.toolCalls, 0).name).toBe('lookup');
    expect(at(response.toolCalls, 0).arguments).toEqual({ city: 'Paris' });
  });

  it('reports a non-JSON body and a body with no candidates', async () => {
    const first = stubFetch([{ body: 'not json' }]);
    await expect(provider(first.fetch).complete(ask('x'), geminiSpec())).rejects.toThrow(
      ProviderResponseError,
    );

    const second = stubFetch([{ body: JSON.stringify({ candidates: [] }) }]);
    await expect(provider(second.fetch).complete(ask('x'), geminiSpec())).rejects.toBeInstanceOf(
      ProviderResponseError,
    );
  });

  it('refuses to complete after close', async () => {
    const { fetch: fetchImpl } = stubFetch([reply([text('ok')])]);
    const adapter = provider(fetchImpl);
    await adapter.close();
    await expect(adapter.complete(ask('x'), geminiSpec())).rejects.toBeInstanceOf(ProviderError);
  });

  it('serialises the same request identically to Vertex', async () => {
    const request = new CompletionRequest({
      messages: [
        new Message('system', 'be terse'),
        new Message('user', 'capital?'),
        new Message('assistant', '', {
          toolCalls: [new ToolCall({ id: 'c1', name: 'lookup', arguments: { city: 'Paris' } })],
        }),
        new Message('tool', '{"answer": "Paris"}', { toolCallId: 'c1', name: 'lookup' }),
      ],
      tools: [
        new ToolDefinition({
          name: 'lookup',
          description: 'look a city up',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        }),
      ],
      temperature: 0.2,
      maxOutputTokens: 256,
      stop: ['END'],
    });

    const gemini = stubFetch([reply([text('ok')])]);
    await provider(gemini.fetch).complete(request, geminiSpec('gemini'));

    const vertex = stubFetch([reply([text('ok')])]);
    await new VertexProvider({
      project: 'aid-test',
      location: 'us-central1',
      accessToken: 'token',
      fetchImpl: vertex.fetch,
      backoffSeconds: 0,
    }).complete(request, geminiSpec('google'));

    expect(at(gemini.calls, 0).body).toBe(at(vertex.calls, 0).body);
  });
});
