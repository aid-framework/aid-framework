/**
 * The Bedrock adapter: Converse, SigV4, and the credential chain.
 *
 * Bedrock differs from every other provider in two ways that cannot be tested
 * behaviourally. Requests are signed rather than keyed, so the test pins a
 * signature computed for a fixed clock; and credentials come from the role
 * rather than a parameter, so the tests drive the environment instead.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { FetchLike } from '../src/index.js';
import {
  BEDROCK_SERVICE,
  BedrockProvider,
  CompletionRequest,
  CostProfile,
  defaultBedrockBaseUrl,
  Message,
  ModelSpec,
  ProviderError,
  ProviderResponseError,
  rfc3986,
  supports,
  ToolCall,
  ToolDefinition,
} from '../src/index.js';
import { at, smallSpec } from './support.js';

const OK_BODY = JSON.stringify({
  output: { message: { content: [{ text: 'Paris' }] } },
  stopReason: 'end_turn',
  usage: { inputTokens: 12, outputTokens: 3 },
});

const MODEL_ID = 'anthropic.claude-3-5-sonnet-20240620-v1:0';

function bedrockSpec(): ModelSpec {
  return new ModelSpec({
    name: MODEL_ID,
    provider: 'bedrock',
    cost: new CostProfile({ inputPer1kUsd: 0.003, outputPer1kUsd: 0.015 }),
    contextWindow: 200_000,
    maxOutputTokens: 4096,
    capabilities: ['tool-calling', 'structured-output'],
  });
}

interface Reply {
  readonly status?: number;
  readonly body: string;
}

/** A `FetchLike` that replays `replies` in order and records what it was sent. */
function stubFetch(replies: readonly Reply[]): {
  readonly fetch: FetchLike;
  readonly calls: {
    url: string;
    method: string;
    body: string;
    headers: Readonly<Record<string, string>>;
  }[];
} {
  const calls: {
    url: string;
    method: string;
    body: string;
    headers: Readonly<Record<string, string>>;
  }[] = [];
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

const STATIC = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
};

function provider(fetch: FetchLike, options: Record<string, unknown> = {}): BedrockProvider {
  return new BedrockProvider({
    region: 'us-east-1',
    ...STATIC,
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

const ENV_KEYS = [
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
] as const;

const saved = new Map<string, string | undefined>();
for (const key of ENV_KEYS) saved.set(key, process.env[key]);

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function clearCredentials(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

describe('BedrockProvider', () => {
  it('posts to the converse endpoint of the encoded model id and parses the answer', async () => {
    const stub = stubFetch([{ body: OK_BODY }]);
    const response = await provider(stub.fetch).complete(ask('capital?'), bedrockSpec());

    expect(response.text).toBe('Paris');
    expect(response.model).toBe(MODEL_ID);
    expect(response.provider).toBe('bedrock');
    expect(response.usage.toJSON()).toEqual({ inputTokens: 12, outputTokens: 3 });
    expect(at(stub.calls, 0).url).toBe(
      `https://bedrock-runtime.us-east-1.amazonaws.com/model/${rfc3986(MODEL_ID)}/converse`,
    );
  });

  it('percent-encodes the model id, because the wire id contains a colon', async () => {
    const stub = stubFetch([{ body: OK_BODY }]);
    await provider(stub.fetch).complete(ask('x'), bedrockSpec());

    const url = at(stub.calls, 0).url;
    expect(url).toContain('v1%3A0');
    expect(url).not.toContain('v1:0');
    expect(rfc3986("a!b*c'd(e)f")).toBe('a%21b%2Ac%27d%28e%29f');
  });

  it('signs a request with SigV4 for a fixed clock', async () => {
    // Recomputed independently from the canonical request; any change to the
    // canonical headers, scope or payload hash changes this string.
    const stub = stubFetch([{ body: OK_BODY }]);
    await provider(stub.fetch, { now: () => new Date('2026-11-02T05:17:11.000Z') }).complete(
      ask('hi'),
      bedrockSpec(),
    );

    const sent = at(stub.calls, 0);
    expect(sent.headers['x-amz-date']).toBe('20261102T051711Z');
    expect(sent.headers['content-type']).toBe('application/json');
    expect(sent.headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261102/us-east-1/bedrock/aws4_request, ' +
        'SignedHeaders=content-type;host;x-amz-date, ' +
        'Signature=4eaa3e075c1b4bce21a021fff3a031f6caa14511c1912c5bdc902246662767af',
    );
    expect(BEDROCK_SERVICE).toBe('bedrock');
  });

  it('signs the session token as a header when temporary credentials are used', async () => {
    const stub = stubFetch([{ body: OK_BODY }]);
    await provider(stub.fetch, {
      sessionToken: 'token-1',
      now: () => new Date('2026-11-02T05:17:11.000Z'),
    }).complete(ask('hi'), bedrockSpec());

    const sent = at(stub.calls, 0);
    expect(sent.headers['x-amz-security-token']).toBe('token-1');
    expect(sent.headers.authorization).toContain(
      'SignedHeaders=content-type;host;x-amz-date;x-amz-security-token',
    );
    expect(sent.headers.authorization).not.toContain(
      'Signature=4eaa3e075c1b4bce21a021fff3a031f6caa14511c1912c5bdc902246662767af',
    );
  });

  it('passes the system prompt as a top-level array and joins adjacent systems', async () => {
    const stub = stubFetch([{ body: OK_BODY }]);
    const request = new CompletionRequest({
      messages: [Message.system('be terse'), Message.system('cite sources'), Message.user('x')],
    });
    await provider(stub.fetch).complete(request, bedrockSpec());

    const sent = sentBody(at(stub.calls, 0).body);
    expect(sent.system).toEqual([{ text: 'be terse\n\ncite sources' }]);
    expect(sent.messages).toEqual([{ role: 'user', content: [{ text: 'x' }] }]);
  });

  it('omits system when there is no system prompt', async () => {
    const stub = stubFetch([{ body: OK_BODY }]);
    await provider(stub.fetch).complete(ask('x'), bedrockSpec());

    expect(sentBody(at(stub.calls, 0).body)).not.toHaveProperty('system');
  });

  it('always sends inferenceConfig.maxTokens, clamped to the model ceiling', async () => {
    const stub = stubFetch([{ body: OK_BODY }]);
    await provider(stub.fetch).complete(ask('x'), bedrockSpec());

    // Converse rejects a request without maxTokens, so it is not optional.
    expect(sentBody(at(stub.calls, 0).body).inferenceConfig).toEqual({ maxTokens: 4096 });
  });

  it('clamps an oversized requested maxTokens', async () => {
    const stub = stubFetch([{ body: OK_BODY }]);
    const request = new CompletionRequest({
      messages: [Message.user('x')],
      maxOutputTokens: 999_999,
    });
    await provider(stub.fetch).complete(request, bedrockSpec());

    const sent = sentBody(at(stub.calls, 0).body).inferenceConfig as Record<string, unknown>;
    expect(sent.maxTokens).toBe(4096);
  });

  it('sends tools as toolSpec blocks with a JSON input schema', async () => {
    const stub = stubFetch([{ body: OK_BODY }]);
    const request = new CompletionRequest({
      messages: [Message.user('x')],
      temperature: 0.2,
      stop: ['\n\n'],
      tools: [
        new ToolDefinition({ name: 'lookup', description: 'd', parameters: { type: 'object' } }),
      ],
    });
    await provider(stub.fetch).complete(request, bedrockSpec());

    const sent = sentBody(at(stub.calls, 0).body);
    expect(sent.inferenceConfig).toEqual({
      maxTokens: 4096,
      temperature: 0.2,
      stopSequences: ['\n\n'],
    });
    expect(sent.toolConfig).toEqual({
      tools: [
        {
          toolSpec: {
            name: 'lookup',
            description: 'd',
            inputSchema: { json: { type: 'object' } },
          },
        },
      ],
    });
  });

  it('serialises an assistant tool-call turn as toolUse blocks', async () => {
    const stub = stubFetch([{ body: OK_BODY }]);
    const call = new ToolCall({ id: 'call_1', name: 'lookup', arguments: { q: 'x' } });
    const request = new CompletionRequest({
      messages: [Message.user('go'), Message.assistantToolCalls('thinking', [call])],
    });
    await provider(stub.fetch).complete(request, bedrockSpec());

    expect(sentBody(at(stub.calls, 0).body).messages).toEqual([
      { role: 'user', content: [{ text: 'go' }] },
      {
        role: 'assistant',
        content: [
          { text: 'thinking' },
          { toolUse: { toolUseId: 'call_1', name: 'lookup', input: { q: 'x' } } },
        ],
      },
    ]);
  });

  it('merges adjacent tool results into a single user turn', async () => {
    // Converse requires alternating roles, so a second consecutive user turn of
    // tool results would be a validation error rather than a variant spelling.
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
    await provider(stub.fetch).complete(request, bedrockSpec());

    const messages = sentBody(at(stub.calls, 0).body).messages as unknown[];
    expect(messages).toHaveLength(3);
    expect(at(messages, 2)).toEqual({
      role: 'user',
      content: [
        { toolResult: { toolUseId: 'a', content: [{ text: 'first' }] } },
        { toolResult: { toolUseId: 'b', content: [{ text: 'second' }] } },
      ],
    });
  });

  it('drops an empty turn, which Converse would reject', async () => {
    const stub = stubFetch([{ body: OK_BODY }]);
    const request = new CompletionRequest({
      messages: [Message.user('go'), Message.assistant('')],
    });
    await provider(stub.fetch).complete(request, bedrockSpec());

    expect(sentBody(at(stub.calls, 0).body).messages).toEqual([
      { role: 'user', content: [{ text: 'go' }] },
    ]);
  });

  it('refuses a tool result that has no call id to attribute it to', async () => {
    const stub = stubFetch([{ body: OK_BODY }]);
    const request = new CompletionRequest({ messages: [new Message('tool', 'orphan')] });

    await expect(provider(stub.fetch).complete(request, bedrockSpec())).rejects.toThrow(
      /tool_call_id/,
    );
    expect(stub.calls).toEqual([]);
  });

  it('parses toolUse blocks into tool calls and reports tool-calls', async () => {
    const stub = stubFetch([
      {
        body: JSON.stringify({
          output: {
            message: {
              content: [
                { text: 'let me look' },
                { toolUse: { toolUseId: 'call_9', name: 'lookup', input: { q: 'x' } } },
              ],
            },
          },
          stopReason: 'tool_use',
          usage: { inputTokens: 1, outputTokens: 2 },
        }),
      },
    ]);
    const response = await provider(stub.fetch).complete(ask('x'), bedrockSpec());

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
          output: {
            message: { content: [{ toolUse: { toolUseId: 'c', name: 'n', input: 'x' } }] },
          },
          stopReason: 'tool_use',
        }),
      },
    ]);
    const response = await provider(stub.fetch).complete(ask('x'), bedrockSpec());

    expect(at(response.toolCalls, 0).args).toEqual({});
  });

  it('maps every documented stopReason', async () => {
    const cases: readonly [string, string][] = [
      ['end_turn', 'stop'],
      ['stop_sequence', 'stop'],
      ['max_tokens', 'length'],
      ['tool_use', 'tool-calls'],
      ['guardrail_intervened', 'content-filter'],
      ['content_filtered', 'content-filter'],
    ];
    for (const [wire, expected] of cases) {
      const stub = stubFetch([
        {
          body: JSON.stringify({
            output: { message: { content: [{ text: '' }] } },
            stopReason: wire,
          }),
        },
      ]);
      const response = await provider(stub.fetch).complete(ask('x'), bedrockSpec());
      expect(response.finishReason).toBe(expected);
    }
  });

  it('falls back to stop for an unknown stopReason', async () => {
    const stub = stubFetch([
      {
        body: JSON.stringify({
          output: { message: { content: [{ text: '' }] } },
          stopReason: 'model_context_window_exceeded',
        }),
      },
    ]);
    const response = await provider(stub.fetch).complete(ask('x'), bedrockSpec());

    expect(response.finishReason).toBe('stop');
  });

  it('retries 424, which is Bedrock-specific and not a standard client error', async () => {
    const stub = stubFetch([{ status: 424, body: 'dependency failed' }, { body: OK_BODY }]);
    const response = await provider(stub.fetch, { maxAttempts: 2 }).complete(
      ask('x'),
      bedrockSpec(),
    );

    expect(response.text).toBe('Paris');
    expect(stub.calls).toHaveLength(2);
  });

  it('retries 429 and 503', async () => {
    for (const status of [429, 503]) {
      const stub = stubFetch([{ status, body: 'busy' }, { body: OK_BODY }]);
      const response = await provider(stub.fetch, { maxAttempts: 2 }).complete(
        ask('x'),
        bedrockSpec(),
      );
      expect(response.text).toBe('Paris');
    }
  });

  it('does not retry a 403, which is a permission problem', async () => {
    const stub = stubFetch([{ status: 403, body: 'denied' }]);

    await expect(
      provider(stub.fetch, { maxAttempts: 3 }).complete(ask('x'), bedrockSpec()),
    ).rejects.toThrow(/returned 403/);
    expect(stub.calls).toHaveLength(1);
  });

  it('reports the last failure after exhausting its attempts', async () => {
    const stub = stubFetch([{ status: 500, body: 'down' }]);

    await expect(
      provider(stub.fetch, { maxAttempts: 2 }).complete(ask('x'), bedrockSpec()),
    ).rejects.toThrow(ProviderError);
    expect(stub.calls).toHaveLength(2);
  });

  it('needs a region, because model ids are regional', async () => {
    clearCredentials();
    const stub = stubFetch([{ body: OK_BODY }]);
    const subject = new BedrockProvider({ ...STATIC, fetchImpl: stub.fetch, backoffSeconds: 0 });

    await expect(subject.complete(ask('x'), bedrockSpec())).rejects.toThrow(/needs a region/);
    expect(stub.calls).toEqual([]);
  });

  it('falls back to AWS_REGION and then AWS_DEFAULT_REGION', async () => {
    clearCredentials();
    process.env.AWS_REGION = 'eu-west-1';
    const stub = stubFetch([{ body: OK_BODY }]);
    await new BedrockProvider({
      ...STATIC,
      fetchImpl: stub.fetch,
      backoffSeconds: 0,
    }).complete(ask('x'), bedrockSpec());
    expect(at(stub.calls, 0).url).toContain('bedrock-runtime.eu-west-1.amazonaws.com');

    clearCredentials();
    process.env.AWS_DEFAULT_REGION = 'ap-south-1';
    const other = stubFetch([{ body: OK_BODY }]);
    await new BedrockProvider({
      ...STATIC,
      fetchImpl: other.fetch,
      backoffSeconds: 0,
    }).complete(ask('x'), bedrockSpec());
    expect(at(other.calls, 0).url).toContain('bedrock-runtime.ap-south-1.amazonaws.com');
  });

  it('reads credentials from the environment when none are passed', async () => {
    clearCredentials();
    process.env.AWS_ACCESS_KEY_ID = 'ENVKEY';
    process.env.AWS_SECRET_ACCESS_KEY = 'envsecret';
    process.env.AWS_SESSION_TOKEN = 'envtoken';
    const stub = stubFetch([{ body: OK_BODY }]);
    await new BedrockProvider({
      region: 'us-east-1',
      fetchImpl: stub.fetch,
      backoffSeconds: 0,
    }).complete(ask('x'), bedrockSpec());

    const sent = at(stub.calls, 0);
    expect(sent.headers.authorization).toContain('Credential=ENVKEY/');
    expect(sent.headers['x-amz-security-token']).toBe('envtoken');
  });

  it('refuses to sign with no credentials anywhere', async () => {
    clearCredentials();
    const stub = stubFetch([{ body: OK_BODY }]);

    await expect(
      new BedrockProvider({
        region: 'us-east-1',
        fetchImpl: stub.fetch,
        backoffSeconds: 0,
      }).complete(ask('x'), bedrockSpec()),
    ).rejects.toThrow(/no credentials/);
    expect(stub.calls).toEqual([]);
  });

  it('uses the ECS container credentials endpoint and caches the result', async () => {
    clearCredentials();
    process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = '/v2/credentials/abc';
    const stub = stubFetch([
      {
        body: JSON.stringify({
          AccessKeyId: 'TASKKEY',
          SecretAccessKey: 'tasksecret',
          Token: 'tasktoken',
          Expiration: '2099-01-01T00:00:00Z',
        }),
      },
      { body: OK_BODY },
      { body: OK_BODY },
    ]);
    const subject = new BedrockProvider({
      region: 'us-east-1',
      fetchImpl: stub.fetch,
      backoffSeconds: 0,
    });

    await subject.complete(ask('x'), bedrockSpec());
    await subject.complete(ask('x'), bedrockSpec());

    // One credential fetch for both completions: a per-request STS round trip
    // would double the latency of every call.
    expect(stub.calls).toHaveLength(3);
    expect(at(stub.calls, 0).url).toBe('http://169.254.170.2/v2/credentials/abc');
    expect(at(stub.calls, 1).headers.authorization).toContain('Credential=TASKKEY/');
    expect(at(stub.calls, 1).headers['x-amz-security-token']).toBe('tasktoken');
  });

  it('honours AWS_CONTAINER_CREDENTIALS_FULL_URI', async () => {
    clearCredentials();
    process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI = 'http://127.0.0.1:9911/creds';
    const stub = stubFetch([
      { body: JSON.stringify({ AccessKeyId: 'K', SecretAccessKey: 'S' }) },
      { body: OK_BODY },
    ]);
    await new BedrockProvider({
      region: 'us-east-1',
      fetchImpl: stub.fetch,
      backoffSeconds: 0,
    }).complete(ask('x'), bedrockSpec());

    expect(at(stub.calls, 0).url).toBe('http://127.0.0.1:9911/creds');
    expect(at(stub.calls, 1).headers).not.toHaveProperty('x-amz-security-token');
  });

  it('refuses a credentials endpoint that returns no key pair', async () => {
    clearCredentials();
    process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = '/v2/credentials/abc';
    const stub = stubFetch([{ body: JSON.stringify({ Token: 'x' }) }]);

    await expect(
      new BedrockProvider({
        region: 'us-east-1',
        fetchImpl: stub.fetch,
        backoffSeconds: 0,
      }).complete(ask('x'), bedrockSpec()),
    ).rejects.toThrow(/no AccessKeyId/);
  });

  it('reports a credentials endpoint that is not reachable', async () => {
    clearCredentials();
    process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = '/v2/credentials/abc';
    const fetch: FetchLike = () => Promise.reject(new Error('ECONNREFUSED'));

    await expect(
      new BedrockProvider({ region: 'us-east-1', fetchImpl: fetch, backoffSeconds: 0 }).complete(
        ask('x'),
        bedrockSpec(),
      ),
    ).rejects.toThrow(/could not reach the container credentials endpoint: ECONNREFUSED/);
  });

  it('honours a custom base URL and strips trailing slashes', async () => {
    const stub = stubFetch([{ body: OK_BODY }]);
    await provider(stub.fetch, { baseUrl: 'https://example.test/' }).complete(
      ask('x'),
      bedrockSpec(),
    );

    expect(at(stub.calls, 0).url).toBe(`https://example.test/model/${rfc3986(MODEL_ID)}/converse`);
  });

  it('builds the regional host from the region', () => {
    expect(defaultBedrockBaseUrl('us-west-2')).toBe(
      'https://bedrock-runtime.us-west-2.amazonaws.com',
    );
  });

  it('refuses a non-positive max_attempts', () => {
    expect(() => new BedrockProvider({ maxAttempts: 0 })).toThrow(/at least 1/);
  });

  it('rejects a body that is not JSON', async () => {
    const stub = stubFetch([{ body: '{not json' }]);

    await expect(provider(stub.fetch).complete(ask('x'), bedrockSpec())).rejects.toThrow(
      ProviderResponseError,
    );
  });

  it('rejects a body that is not an object', async () => {
    const stub = stubFetch([{ body: '[]' }]);

    await expect(provider(stub.fetch).complete(ask('x'), bedrockSpec())).rejects.toThrow(
      /not an object/,
    );
  });

  it('rejects a body with no content blocks', async () => {
    const stub = stubFetch([{ body: JSON.stringify({ stopReason: 'end_turn' }) }]);

    await expect(provider(stub.fetch).complete(ask('x'), bedrockSpec())).rejects.toThrow(
      /no content blocks/,
    );
  });

  it('claims tool-calling, structured-output and embeddings but not streaming', () => {
    // Embeddings are served by InvokeModel, which this adapter signs with the
    // same identity as Converse. /converse-stream is a binary event stream this
    // adapter cannot read, so streaming stays unclaimed.
    const subject = new BedrockProvider();
    expect(supports(subject, 'tool-calling')).toBe(true);
    expect(supports(subject, 'structured-output')).toBe(true);
    expect(supports(subject, 'embeddings')).toBe(true);
    expect(supports(subject, 'streaming')).toBe(false);
  });

  it('names itself bedrock by default and honours a custom name', () => {
    expect(new BedrockProvider().name).toBe('bedrock');
    expect(new BedrockProvider({ name: 'stub' }).name).toBe('stub');
  });

  it('refuses to complete once closed', async () => {
    const subject = new BedrockProvider({
      region: 'us-east-1',
      ...STATIC,
      fetchImpl: stubFetch([{ body: OK_BODY }]).fetch,
    });

    await subject.close();
    await expect(subject.complete(ask('x'), bedrockSpec())).rejects.toThrow(/closed/);
  });

  it('closes idempotently', async () => {
    const subject = new BedrockProvider();

    await subject.close();
    await subject.close();
  });

  it('uses the small fixture for a non-Bedrock model without changing the wire id', async () => {
    // `ModelSpec.name` is the wire id on Bedrock, so the model name is what is
    // invoked and what is echoed back; there is no separate alias mapping.
    const stub = stubFetch([{ body: OK_BODY }]);
    const response = await provider(stub.fetch).complete(ask('x'), smallSpec());

    expect(at(stub.calls, 0).url).toContain('/model/fake-small-1/converse');
    expect(response.model).toBe('fake-small-1');
  });
});
