/**
 * The Vertex adapter: `generateContent`, the bearer token chain, and translation.
 *
 * Vertex differs from the keyed providers in two ways worth pinning: the token is
 * resolved from the environment or the metadata server rather than passed at call
 * time, and its request shape is `contents` of `parts` rather than messages.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { FetchLike } from '../src/index.js';
import {
  CompletionRequest,
  CostProfile,
  DEFAULT_VERTEX_LOCATION,
  defaultVertexBaseUrl,
  METADATA_TOKEN_URL,
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

const MODEL_ID = 'gemini-2.0-flash-001';
const PROJECT = 'aid-test';
const LOCATION = 'europe-west4';

const ENV_KEYS = [
  'GOOGLE_ACCESS_TOKEN',
  'VERTEX_ACCESS_TOKEN',
  'GOOGLE_CLOUD_PROJECT',
  'GCLOUD_PROJECT',
  'GOOGLE_CLOUD_REGION',
  'VERTEX_LOCATION',
] as const;

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
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

/** A `FetchLike` that replays `replies` in order and records what it was sent. */
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

function vertexSpec(maxOutputTokens = 4096): ModelSpec {
  return new ModelSpec({
    name: MODEL_ID,
    provider: 'google',
    cost: new CostProfile({ inputPer1kUsd: 0.0001, outputPer1kUsd: 0.0004 }),
    contextWindow: 1_000_000,
    maxOutputTokens,
    capabilities: ['tool-calling', 'structured-output'],
  });
}

function reply(
  parts: readonly Record<string, unknown>[],
  finishReason = 'STOP',
  usage: Record<string, number> = { promptTokenCount: 12, candidatesTokenCount: 3 },
): Reply {
  return {
    body: JSON.stringify({
      candidates: [{ content: { role: 'model', parts }, finishReason }],
      usageMetadata: usage,
    }),
  };
}

function text(value: string): Record<string, unknown> {
  return { text: value };
}

function ask(value: string): CompletionRequest {
  return new CompletionRequest({ messages: [new Message('user', value)] });
}

function provider(fetch: FetchLike, options: Record<string, unknown> = {}): VertexProvider {
  return new VertexProvider({
    project: PROJECT,
    location: LOCATION,
    accessToken: 'token-123',
    fetchImpl: fetch,
    backoffSeconds: 0,
    ...options,
  });
}

/** The fields of the request body these tests assert on. */
interface SentBody {
  readonly systemInstruction?: { readonly parts: readonly { readonly text: string }[] };
  readonly contents?: readonly unknown[];
  readonly generationConfig?: Record<string, unknown>;
  readonly tools?: readonly unknown[];
}

function sent(calls: readonly Call[]): SentBody {
  return JSON.parse(at(calls, 0).body) as SentBody;
}

describe('the Vertex adapter', () => {
  it('posts to the location-scoped generateContent endpoint', async () => {
    const { fetch, calls } = stubFetch([reply([text('Paris')])]);
    const response = await provider(fetch).complete(ask('capital?'), vertexSpec());

    expect(at(calls, 0).url).toBe(
      `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT}` +
        `/locations/${LOCATION}/publishers/google/models/${MODEL_ID}:generateContent`,
    );
    expect(at(calls, 0).method).toBe('POST');
    expect(at(calls, 0).headers.authorization).toBe('Bearer token-123');
    expect(response.text).toBe('Paris');
    expect(response.provider).toBe('google');
    expect(response.model).toBe(MODEL_ID);
    expect(response.usage.inputTokens).toBe(12);
    expect(response.usage.outputTokens).toBe(3);
    expect(response.finishReason).toBe('stop');
  });

  it('advertises tool calling and structured output, not streaming', () => {
    const instance = provider(stubFetch([]).fetch);
    expect(supports(instance, 'tool-calling')).toBe(true);
    expect(supports(instance, 'structured-output')).toBe(true);
    expect(supports(instance, 'streaming')).toBe(false);
  });

  it('defaults the location and reads project and location from the environment', async () => {
    const first = stubFetch([reply([text('ok')])]);
    await provider(first.fetch, { location: undefined }).complete(ask('hi'), vertexSpec());
    expect(at(first.calls, 0).url).toContain(
      `${DEFAULT_VERTEX_LOCATION}-aiplatform.googleapis.com`,
    );

    process.env.GOOGLE_CLOUD_PROJECT = 'from-env';
    process.env.GOOGLE_CLOUD_REGION = 'asia-northeast1';
    const second = stubFetch([reply([text('ok')])]);
    await provider(second.fetch, { project: undefined, location: undefined }).complete(
      ask('hi'),
      vertexSpec(),
    );
    expect(at(second.calls, 0).url).toContain('/projects/from-env/locations/asia-northeast1/');
  });

  it('requires a project rather than guessing one', async () => {
    await expect(
      provider(stubFetch([]).fetch, { project: undefined }).complete(ask('hi'), vertexSpec()),
    ).rejects.toThrow(/GOOGLE_CLOUD_PROJECT/);
  });

  it('reads the bearer token from the environment', async () => {
    process.env.GOOGLE_ACCESS_TOKEN = 'env-token';
    const { fetch, calls } = stubFetch([reply([text('ok')])]);
    await provider(fetch, { accessToken: undefined }).complete(ask('hi'), vertexSpec());
    expect(at(calls, 0).headers.authorization).toBe('Bearer env-token');
  });

  it('mints a token from the metadata server and caches it', async () => {
    const { fetch, calls } = stubFetch([
      { body: JSON.stringify({ access_token: 'minted', expires_in: 3600 }) },
      reply([text('one')]),
      reply([text('two')]),
    ]);
    const instance = provider(fetch, { accessToken: undefined, now: () => 1_000_000 });
    await instance.complete(ask('hi'), vertexSpec());
    await instance.complete(ask('hi'), vertexSpec());

    const metadata = calls.filter((call) => call.url === METADATA_TOKEN_URL);
    expect(metadata).toHaveLength(1);
    expect(at(metadata, 0).headers['metadata-flavor']).toBe('Google');
    expect(at(calls, 1).headers.authorization).toBe('Bearer minted');
    expect(at(calls, 2).headers.authorization).toBe('Bearer minted');
  });

  it('reports a missing metadata server as missing credentials', async () => {
    const failing: FetchLike = () => Promise.reject(new Error('no metadata server'));
    await expect(
      provider(failing, { accessToken: undefined }).complete(ask('hi'), vertexSpec()),
    ).rejects.toThrow(/GOOGLE_ACCESS_TOKEN/);
  });

  it('uses an injected token provider', async () => {
    const { fetch, calls } = stubFetch([reply([text('ok')])]);
    await provider(fetch, {
      accessToken: undefined,
      tokenProvider: () => Promise.resolve('injected'),
    }).complete(ask('hi'), vertexSpec());
    expect(at(calls, 0).headers.authorization).toBe('Bearer injected');
  });

  it('moves system turns into systemInstruction and joins them', async () => {
    const { fetch, calls } = stubFetch([reply([text('ok')])]);
    const request = new CompletionRequest({
      messages: [
        new Message('system', 'be terse'),
        new Message('system', 'answer in French'),
        new Message('user', 'capital?'),
      ],
    });
    await provider(fetch).complete(request, vertexSpec());

    const body = sent(calls);
    expect(body.systemInstruction).toEqual({
      parts: [{ text: 'be terse\n\nanswer in French' }],
    });
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'capital?' }] }]);
  });

  it('omits systemInstruction when there is no system turn', async () => {
    const { fetch, calls } = stubFetch([reply([text('ok')])]);
    await provider(fetch).complete(ask('hi'), vertexSpec());
    expect(sent(calls).systemInstruction).toBeUndefined();
  });

  it('sends temperature, stop sequences, and a clamped output ceiling', async () => {
    const { fetch, calls } = stubFetch([reply([text('ok')])]);
    const request = new CompletionRequest({
      messages: [new Message('user', 'hi')],
      maxOutputTokens: 99_999,
      temperature: 0.2,
      stop: ['END'],
    });
    await provider(fetch).complete(request, vertexSpec(2048));
    expect(sent(calls).generationConfig).toEqual({
      maxOutputTokens: 2048,
      temperature: 0.2,
      stopSequences: ['END'],
    });
  });

  it('sends tools as function declarations', async () => {
    const { fetch, calls } = stubFetch([reply([text('ok')])]);
    const request = new CompletionRequest({
      messages: [new Message('user', 'hi')],
      tools: [
        new ToolDefinition({
          name: 'weather',
          description: 'look it up',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        }),
      ],
    });
    await provider(fetch).complete(request, vertexSpec());
    expect(sent(calls).tools).toEqual([
      {
        functionDeclarations: [
          {
            name: 'weather',
            description: 'look it up',
            parameters: { type: 'object', properties: { city: { type: 'string' } } },
          },
        ],
      },
    ]);
  });

  it('parses a function call into a tool call', async () => {
    const { fetch } = stubFetch([
      reply([{ functionCall: { name: 'weather', args: { city: 'Paris' } } }]),
    ]);
    const response = await provider(fetch).complete(ask('weather?'), vertexSpec());
    expect(response.text).toBe('');
    expect(response.toolCalls).toEqual([
      new ToolCall({ id: `${MODEL_ID}-call-0`, name: 'weather', arguments: { city: 'Paris' } }),
    ]);
    expect(response.finishReason).toBe('tool-calls');
  });

  it('replays an assistant tool call and its result as Gemini parts', async () => {
    const { fetch, calls } = stubFetch([reply([text('sunny')])]);
    const request = new CompletionRequest({
      messages: [
        new Message('user', 'weather?'),
        new Message('assistant', '', {
          toolCalls: [new ToolCall({ id: 'c1', name: 'weather', arguments: { city: 'Paris' } })],
        }),
        new Message('tool', '22C', { toolCallId: 'c1', name: 'weather' }),
      ],
    });
    await provider(fetch).complete(request, vertexSpec());
    expect(sent(calls).contents).toEqual([
      { role: 'user', parts: [{ text: 'weather?' }] },
      { role: 'model', parts: [{ functionCall: { name: 'weather', args: { city: 'Paris' } } }] },
      {
        role: 'user',
        parts: [{ functionResponse: { name: 'weather', response: { content: '22C' } } }],
      },
    ]);
  });

  it('maps provider finish reasons to the runtime vocabulary', async () => {
    const cases: readonly (readonly [string, string])[] = [
      ['MAX_TOKENS', 'length'],
      ['SAFETY', 'content-filter'],
      ['RECITATION', 'content-filter'],
      ['MALFORMED_FUNCTION_CALL', 'error'],
    ];
    for (const [raw, expected] of cases) {
      const { fetch } = stubFetch([reply([text('x')], raw)]);
      const response = await provider(fetch).complete(ask('hi'), vertexSpec());
      expect(response.finishReason).toBe(expected);
    }
  });

  it('retries a retryable status then succeeds', async () => {
    const { fetch, calls } = stubFetch([{ status: 429, body: 'slow down' }, reply([text('ok')])]);
    const response = await provider(fetch).complete(ask('hi'), vertexSpec());
    expect(response.text).toBe('ok');
    expect(calls).toHaveLength(2);
  });

  it('raises with the provider detail on a client error', async () => {
    await expect(
      provider(stubFetch([{ status: 400, body: 'bad request' }]).fetch).complete(
        ask('hi'),
        vertexSpec(),
      ),
    ).rejects.toThrow(/400/);
  });

  it('reports a non-JSON body and a body with no candidates', async () => {
    await expect(
      provider(stubFetch([{ body: 'not json' }]).fetch).complete(ask('hi'), vertexSpec()),
    ).rejects.toBeInstanceOf(ProviderResponseError);

    await expect(
      provider(stubFetch([{ body: JSON.stringify({ candidates: [] }) }]).fetch).complete(
        ask('hi'),
        vertexSpec(),
      ),
    ).rejects.toThrow(/no candidates/);
  });

  it('refuses to complete after close', async () => {
    const instance = provider(stubFetch([]).fetch);
    await instance.close();
    await expect(instance.complete(ask('hi'), vertexSpec())).rejects.toBeInstanceOf(ProviderError);
  });

  it('builds a location-scoped default base URL', () => {
    expect(defaultVertexBaseUrl('us-central1')).toBe(
      'https://us-central1-aiplatform.googleapis.com',
    );
  });
});
