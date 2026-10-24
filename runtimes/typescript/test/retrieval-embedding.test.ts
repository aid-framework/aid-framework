import { describe, expect, it } from 'vitest';

import {
  ConfigurationError,
  EmbeddingBatch,
  embedderFor,
  estimateTokens,
  FakeDeterministicEmbedder,
  OpenAICompatibleEmbedder,
  PinnedEmbedding,
  ProviderError,
  ProviderResponseError,
  TokenUsage,
} from '../src/index.js';
import type { FetchLike } from '../src/providers/http.js';
import { at, EMBED_DIMENSIONS, MODEL_ID, pinned } from './support.js';

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** A stub transport that records what it was sent and replays scripted replies. */
function stubFetch(
  replies: readonly (string | Error | { readonly status: number; readonly body: string })[],
): { readonly fetchImpl: FetchLike; readonly calls: Call[] } {
  const calls: Call[] = [];
  let reply = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init.method,
      headers: init.headers,
      body: init.body,
    });
    const scripted = replies[Math.min(reply, replies.length - 1)];
    reply += 1;
    if (scripted === undefined) throw new Error('no scripted reply');
    if (scripted instanceof Error) throw scripted;
    if (typeof scripted === 'string') {
      return { ok: true, status: 200, text: async () => scripted };
    }
    return { ok: scripted.status < 400, status: scripted.status, text: async () => scripted.body };
  };
  return { fetchImpl, calls };
}

const MODEL = pinned();

describe('estimateTokens', () => {
  it('uses four characters per token, rounded up', () => {
    expect(estimateTokens('abc')).toBe(1);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });

  it('is zero for the empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('agrees with the prompt-cost arithmetic so a charge and an estimate cannot differ', () => {
    for (const text of ['', 'a', 'abc', 'a'.repeat(100)]) {
      expect(estimateTokens(text)).toBe(Math.ceil(text.length / 4));
    }
  });
});

describe('EmbeddingBatch', () => {
  it('copies its vectors', () => {
    const vectors = [[1, 2]];

    const batch = new EmbeddingBatch({
      vectors,
      usage: new TokenUsage({ inputTokens: 1, outputTokens: 0 }),
    });

    expect(batch.vectors).toEqual([[1, 2]]);
    expect(batch.vectors[0]).not.toBe(vectors[0]);
  });
});

describe('FakeDeterministicEmbedder', () => {
  it('defaults its name to fake-embedder', () => {
    expect(new FakeDeterministicEmbedder().name).toBe('fake-embedder');
  });

  it('accepts an explicit name', () => {
    expect(new FakeDeterministicEmbedder({ name: 'stub' }).name).toBe('stub');
  });

  it('produces one vector of the pinned width per text', async () => {
    const batch = await new FakeDeterministicEmbedder().embed(['a', 'b'], { model: MODEL });

    expect(batch.vectors).toHaveLength(2);
    expect(at(batch.vectors, 0)).toHaveLength(EMBED_DIMENSIONS);
  });

  it('is byte-identical for the same text and pin', async () => {
    const embedder = new FakeDeterministicEmbedder();

    const first = await embedder.embed(['hello'], { model: MODEL });
    const second = await embedder.embed(['hello'], { model: MODEL });

    expect(first.vectors).toEqual(second.vectors);
  });

  it('embeds identical text identically for a fresh instance, so a re-index reproduces the store', async () => {
    const one = await new FakeDeterministicEmbedder().embed(['hello'], { model: MODEL });
    const two = await new FakeDeterministicEmbedder().embed(['hello'], { model: MODEL });

    expect(one.vectors).toEqual(two.vectors);
  });

  it('embeds different texts differently', async () => {
    const batch = await new FakeDeterministicEmbedder().embed(['hello', 'world'], { model: MODEL });

    expect(at(batch.vectors, 0)).not.toEqual(at(batch.vectors, 1));
  });

  it('leaves vectors unchanged when only the alias changes, because the alias is attribution', async () => {
    const renamed = pinned({ alias: 'renamed' });

    const batch = await new FakeDeterministicEmbedder().embed(['hello'], { model: renamed });
    const baseline = await new FakeDeterministicEmbedder().embed(['hello'], { model: MODEL });

    expect(at(batch.vectors, 0)).toEqual(at(baseline.vectors, 0));
  });

  it('embeds the same text differently under a different pinned model id', async () => {
    const moved = new PinnedEmbedding({
      alias: MODEL.alias,
      provider: MODEL.provider,
      modelId: 'text-embedding-3-large',
      dimensions: EMBED_DIMENSIONS,
      cost: MODEL.cost,
    });

    const batch = await new FakeDeterministicEmbedder().embed(['hello'], { model: moved });
    const baseline = await new FakeDeterministicEmbedder().embed(['hello'], { model: MODEL });

    // The pinned model id is part of the hash input, so a changed pin invalidates
    // stored vectors instead of mixing two vector spaces in one table.
    expect(at(batch.vectors, 0)).not.toEqual(at(baseline.vectors, 0));
  });

  it('embeds the same text differently at a different pinned width', async () => {
    const narrow = pinned({ dimensions: 8 });

    const wide8 = await new FakeDeterministicEmbedder().embed(['hello'], { model: narrow });
    const full = await new FakeDeterministicEmbedder().embed(['hello'], { model: MODEL });

    expect(at(wide8.vectors, 0)).toHaveLength(8);
    expect(at(wide8.vectors, 0)).not.toEqual(at(full.vectors, 0).slice(0, 8));
  });

  it('normalises each vector to unit length', async () => {
    const batch = await new FakeDeterministicEmbedder().embed(['hello'], { model: MODEL });
    const norm = Math.sqrt(at(batch.vectors, 0).reduce((total, value) => total + value * value, 0));

    expect(norm).toBeCloseTo(1, 9);
  });

  it('keeps every element inside [-1, 1]', async () => {
    const batch = await new FakeDeterministicEmbedder().embed(['hello', ''], { model: MODEL });

    for (const vector of batch.vectors) {
      for (const value of vector) {
        expect(value).toBeGreaterThanOrEqual(-1);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });

  it('prices usage by the offline estimate and reports no output tokens', async () => {
    const batch = await new FakeDeterministicEmbedder().embed(['abcd', 'abcdefgh'], {
      model: MODEL,
    });

    expect(batch.usage.inputTokens).toBe(1 + 2);
    expect(batch.usage.outputTokens).toBe(0);
  });

  it('embeds an empty batch to nothing', async () => {
    const batch = await new FakeDeterministicEmbedder().embed([], { model: MODEL });

    expect(batch.vectors).toEqual([]);
    expect(batch.usage.inputTokens).toBe(0);
  });

  it('closes without complaint, twice', async () => {
    const embedder = new FakeDeterministicEmbedder();

    await expect(embedder.close()).resolves.toBeUndefined();
    await expect(embedder.close()).resolves.toBeUndefined();
  });
});

describe('OpenAICompatibleEmbedder construction', () => {
  it('defaults its name to openai-compatible-embedder', () => {
    expect(new OpenAICompatibleEmbedder().name).toBe('openai-compatible-embedder');
  });

  it('accepts an explicit name', () => {
    expect(new OpenAICompatibleEmbedder({ name: 'stub' }).name).toBe('stub');
  });

  it('refuses a relative base url', () => {
    expect(() => new OpenAICompatibleEmbedder({ baseUrl: 'api.example.com' })).toThrow(
      ConfigurationError,
    );
  });

  it('refuses a non-http scheme', () => {
    expect(() => new OpenAICompatibleEmbedder({ baseUrl: 'ftp://example.com' })).toThrow(
      /base_url must be an absolute http\(s\) URL/,
    );
  });

  it('refuses max_attempts below one', () => {
    expect(() => new OpenAICompatibleEmbedder({ maxAttempts: 0 })).toThrow(
      'max_attempts must be at least 1',
    );
  });
});

describe('OpenAICompatibleEmbedder embed', () => {
  function body(vectors: readonly (readonly number[])[], extra = ''): string {
    const data = vectors.map((vector, index) => ({ index, embedding: vector }));
    return `{"data":${JSON.stringify(data)},"usage":{"prompt_tokens":7}${extra}}`;
  }

  function vector(fill: number): number[] {
    return Array.from({ length: EMBED_DIMENSIONS }, () => fill);
  }

  it('posts to /embeddings with the pinned model id and the texts', async () => {
    const { fetchImpl, calls } = stubFetch([body([vector(1)])]);

    await new OpenAICompatibleEmbedder({ baseUrl: 'https://api.test/v1', fetchImpl }).embed(
      ['hello'],
      { model: MODEL },
    );

    const call = at(calls, 0);
    expect(call.url).toBe('https://api.test/v1/embeddings');
    expect(call.method).toBe('POST');
    expect(JSON.parse(call.body)).toEqual({ model: MODEL_ID, input: ['hello'] });
  });

  it('strips trailing slashes from the base url', async () => {
    const { fetchImpl, calls } = stubFetch([body([vector(1)])]);

    await new OpenAICompatibleEmbedder({ baseUrl: 'https://api.test/v1///', fetchImpl }).embed(
      ['hello'],
      { model: MODEL },
    );

    expect(at(calls, 0).url).toBe('https://api.test/v1/embeddings');
  });

  it('sends a bearer token only when an api key is set', async () => {
    const withKey = stubFetch([body([vector(1)])]);
    const withoutKey = stubFetch([body([vector(1)])]);

    await new OpenAICompatibleEmbedder({ apiKey: 'sk-test', fetchImpl: withKey.fetchImpl }).embed(
      ['hello'],
      { model: MODEL },
    );
    await new OpenAICompatibleEmbedder({ fetchImpl: withoutKey.fetchImpl }).embed(['hello'], {
      model: MODEL,
    });

    expect(at(withKey.calls, 0).headers.authorization).toBe('Bearer sk-test');
    expect(at(withoutKey.calls, 0).headers.authorization).toBeUndefined();
  });

  it('sends extra headers alongside the content type', async () => {
    const { fetchImpl, calls } = stubFetch([body([vector(1)])]);

    await new OpenAICompatibleEmbedder({
      extraHeaders: { 'x-trace': 'abc' },
      fetchImpl,
    }).embed(['hello'], { model: MODEL });

    expect(at(calls, 0).headers['content-type']).toBe('application/json');
    expect(at(calls, 0).headers['x-trace']).toBe('abc');
  });

  it('returns the vectors and the reported prompt tokens', async () => {
    const { fetchImpl } = stubFetch([body([vector(0.5)])]);

    const batch = await new OpenAICompatibleEmbedder({ fetchImpl }).embed(['hello'], {
      model: MODEL,
    });

    expect(at(batch.vectors, 0)).toHaveLength(EMBED_DIMENSIONS);
    expect(batch.usage.inputTokens).toBe(7);
    expect(batch.usage.outputTokens).toBe(0);
  });

  it('reports zero usage when the body has none', async () => {
    const { fetchImpl } = stubFetch([
      `{"data":[{"index":0,"embedding":${JSON.stringify(vector(1))}}]}`,
    ]);

    const batch = await new OpenAICompatibleEmbedder({ fetchImpl }).embed(['hello'], {
      model: MODEL,
    });

    expect(batch.usage.inputTokens).toBe(0);
  });

  it('sorts the entries by their reported index', async () => {
    const first = vector(1);
    const second = vector(2);
    const outOfOrder =
      `{"data":[{"index":1,"embedding":${JSON.stringify(second)}},` +
      `{"index":0,"embedding":${JSON.stringify(first)}}]}`;
    const { fetchImpl } = stubFetch([outOfOrder]);

    const batch = await new OpenAICompatibleEmbedder({ fetchImpl }).embed(['a', 'b'], {
      model: MODEL,
    });

    expect(at(batch.vectors, 0)).toEqual(first);
    expect(at(batch.vectors, 1)).toEqual(second);
  });

  it('falls back to the array position when an entry reports no index', async () => {
    const first = vector(1);
    const second = vector(2);
    const noIndex =
      `{"data":[{"embedding":${JSON.stringify(first)}},` +
      `{"embedding":${JSON.stringify(second)}}]}`;
    const { fetchImpl } = stubFetch([noIndex]);

    const batch = await new OpenAICompatibleEmbedder({ fetchImpl }).embed(['a', 'b'], {
      model: MODEL,
    });

    expect(at(batch.vectors, 0)).toEqual(first);
  });

  it('refuses a body with no embeddings', async () => {
    const { fetchImpl } = stubFetch(['{"data":[]}']);

    await expect(
      new OpenAICompatibleEmbedder({ fetchImpl }).embed(['a'], { model: MODEL }),
    ).rejects.toThrow('openai-compatible-embedder returned no embeddings');
  });

  it('refuses a non-object entry', async () => {
    const { fetchImpl } = stubFetch(['{"data":[42]}']);

    await expect(
      new OpenAICompatibleEmbedder({ fetchImpl }).embed(['a'], { model: MODEL }),
    ).rejects.toThrow('returned a non-object embedding entry');
  });

  it('refuses a non-integer index', async () => {
    const { fetchImpl } = stubFetch(['{"data":[{"index":1.5,"embedding":[]}]}']);

    await expect(
      new OpenAICompatibleEmbedder({ fetchImpl }).embed(['a'], { model: MODEL }),
    ).rejects.toThrow('returned a non-integer embedding index');
  });

  it('refuses a non-list embedding', async () => {
    const { fetchImpl } = stubFetch(['{"data":[{"index":0,"embedding":"abc"}]}']);

    await expect(
      new OpenAICompatibleEmbedder({ fetchImpl }).embed(['a'], { model: MODEL }),
    ).rejects.toThrow('returned a non-list embedding');
  });

  it('refuses a non-numeric element', async () => {
    const { fetchImpl } = stubFetch(['{"data":[{"index":0,"embedding":["abc"]}]}']);

    await expect(
      new OpenAICompatibleEmbedder({ fetchImpl }).embed(['a'], { model: MODEL }),
    ).rejects.toThrow('returned a non-numeric embedding');
  });

  it('refuses a width the pin does not agree with', async () => {
    const { fetchImpl } = stubFetch([body([[1, 2, 3]])]);

    await expect(
      new OpenAICompatibleEmbedder({ fetchImpl }).embed(['a'], { model: MODEL }),
    ).rejects.toThrow(
      new ProviderResponseError(
        `openai-compatible-embedder returned 3 dimensions for '${MODEL_ID}' but ` +
          `${EMBED_DIMENSIONS} are pinned; the pin and the response must agree`,
      ),
    );
  });

  it('refuses a body that is not JSON', async () => {
    const { fetchImpl } = stubFetch(['not json']);

    await expect(
      new OpenAICompatibleEmbedder({ fetchImpl }).embed(['a'], { model: MODEL }),
    ).rejects.toThrow('returned a body that is not JSON');
  });

  it('refuses a JSON body that is not an object', async () => {
    const { fetchImpl } = stubFetch(['[1,2]']);

    await expect(
      new OpenAICompatibleEmbedder({ fetchImpl }).embed(['a'], { model: MODEL }),
    ).rejects.toThrow('returned a JSON body that is not an object');
  });

  it('does not retry a non-retryable status', async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 400, body: 'bad request' }]);

    await expect(
      new OpenAICompatibleEmbedder({ fetchImpl }).embed(['a'], { model: MODEL }),
    ).rejects.toThrow('openai-compatible-embedder returned HTTP 400: bad request');
    expect(calls).toHaveLength(1);
  });

  it('retries a retryable status and succeeds on the next attempt', async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 429, body: 'slow down' }, body([vector(1)])]);

    const batch = await new OpenAICompatibleEmbedder({
      fetchImpl,
      backoffSeconds: 0,
    }).embed(['a'], { model: MODEL });

    expect(calls).toHaveLength(2);
    expect(at(batch.vectors, 0)).toHaveLength(EMBED_DIMENSIONS);
  });

  it('reports the last failure after exhausting its attempts', async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 503, body: 'unavailable' }]);

    await expect(
      new OpenAICompatibleEmbedder({ fetchImpl, maxAttempts: 2, backoffSeconds: 0 }).embed(['a'], {
        model: MODEL,
      }),
    ).rejects.toThrow(
      new ProviderError(
        'openai-compatible-embedder failed after 2 attempt(s): ' +
          'openai-compatible-embedder returned HTTP 503: unavailable',
      ),
    );
    expect(calls).toHaveLength(2);
  });

  it('retries a transport failure', async () => {
    const { fetchImpl, calls } = stubFetch([new Error('socket closed'), body([vector(1)])]);

    await new OpenAICompatibleEmbedder({ fetchImpl, backoffSeconds: 0 }).embed(['a'], {
      model: MODEL,
    });

    expect(calls).toHaveLength(2);
  });

  it('truncates a long error body', async () => {
    const long = 'x'.repeat(500);
    const { fetchImpl } = stubFetch([{ status: 400, body: long }]);

    await expect(
      new OpenAICompatibleEmbedder({ fetchImpl }).embed(['a'], { model: MODEL }),
    ).rejects.toThrow(new RegExp(`HTTP 400: ${'x'.repeat(200)}$`));
  });

  it('closes without complaint, twice, with an injected transport', async () => {
    const { fetchImpl } = stubFetch([body([vector(1)])]);
    const embedder = new OpenAICompatibleEmbedder({ fetchImpl });

    await expect(embedder.close()).resolves.toBeUndefined();
    await expect(embedder.close()).resolves.toBeUndefined();
  });
});

describe('embedderFor', () => {
  it('picks the fake for the fake provider so a gate runs offline', () => {
    expect(embedderFor(MODEL)).toBeInstanceOf(FakeDeterministicEmbedder);
  });

  it('picks the HTTP adapter for any other provider', () => {
    const remote = new PinnedEmbedding({
      alias: 'prod',
      provider: 'openai',
      modelId: MODEL_ID,
      dimensions: EMBED_DIMENSIONS,
      cost: MODEL.cost,
    });

    expect(embedderFor(remote)).toBeInstanceOf(OpenAICompatibleEmbedder);
  });
});
