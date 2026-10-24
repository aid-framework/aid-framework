/**
 * The provider seam: the deterministic fake and the OpenAI-compatible adapter.
 *
 * The fake is a *seeded simulation*, not a canned-response mock, because the eval gate
 * needs genuine run-to-run variation to be tested at all. The properties asserted here
 * are the ones the gate depends on: same triple gives the same answer, the call index
 * participates so re-runs re-draw, and accuracy is honoured statistically.
 *
 * The HTTP adapter is exercised through an injected `FetchLike`, so these tests make no
 * network connection and still cover the wire payload, retries, and every malformed-body
 * path.
 */

import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../src/index.js';
import {
  CompletionRequest,
  DEFAULT_BASE_URL,
  FakeProvider,
  Message,
  OpenAICompatibleProvider,
  ProviderError,
  ProviderResponseError,
  supports,
  ToolDefinition,
} from '../src/index.js';
import { promptText, withAccuracy } from '../src/providers/fake.js';
import { at, smallSpec } from './support.js';

const PARIS = { 'What is the capital of France?': 'Paris' };

function ask(text: string): CompletionRequest {
  return CompletionRequest.prompt(text);
}

describe('FakeProvider', () => {
  it('answers from its answer table when it is being accurate', async () => {
    const provider = new FakeProvider({ answers: PARIS, accuracy: 1.0 });
    const response = await provider.complete(ask('What is the capital of France?'), smallSpec());

    expect(response.text).toBe('Paris');
    expect(response.finishReason).toBe('stop');
    expect(response.provider).toBe('fake');
  });

  it('is byte-identical for the same seed, index and prompt', async () => {
    const first = new FakeProvider({ answers: PARIS, accuracy: 0.5, seed: 7 });
    const second = new FakeProvider({ answers: PARIS, accuracy: 0.5, seed: 7 });

    const question = ask('What is the capital of France?');
    const a = await first.complete(question, smallSpec());
    const b = await second.complete(question, smallSpec());

    expect(a.text).toBe(b.text);
  });

  it('changes the draw with the call index, which is what makes an N-run sample vary', async () => {
    const provider = new FakeProvider({
      answers: { 'pick one': 'yes' },
      accuracy: 0.5,
      seed: 1,
    });

    const answers = new Set<string>();
    for (let run = 0; run < 64; run += 1) {
      answers.add((await provider.complete(ask('pick one'), smallSpec())).text);
    }

    // With 64 independent draws at accuracy 0.5, seeing only one outcome is a
    // one-in-2^63 event; anything else means the index is not participating.
    expect(answers.size).toBeGreaterThan(1);
  });

  it('changes the draw with the seed', async () => {
    const draws = new Set<string>();
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const provider = new FakeProvider({ answers: { 'pick one': 'yes' }, accuracy: 0.5, seed });
      draws.add((await provider.complete(ask('pick one'), smallSpec())).text);
    }
    expect(draws.size).toBeGreaterThan(1);
  });

  it('answers correctly at approximately its declared accuracy', async () => {
    const provider = new FakeProvider({ answers: { q: 'ideal' }, accuracy: 0.6, seed: 3 });
    let correct = 0;
    const runs = 400;
    for (let run = 0; run < runs; run += 1) {
      if ((await provider.complete(ask('q'), smallSpec())).text === 'ideal') correct += 1;
    }
    // A binomial(400, 0.6) mean has sd ~9.8, so +/- 8% is over four sigma.
    const rate = correct / runs;
    expect(rate).toBeGreaterThan(0.5);
    expect(rate).toBeLessThan(0.7);
  });

  it('treats an unanswerable prompt as wrong rather than crashing', async () => {
    const provider = new FakeProvider({ answers: PARIS, accuracy: 1.0 });
    const response = await provider.complete(ask('unmapped question'), smallSpec());
    expect(response.text.length).toBeGreaterThan(0);
    expect(response.text).not.toBe('Paris');
  });

  it('lets a responder take over completely', async () => {
    const provider = new FakeProvider({ responder: (request) => `echo:${request.text}` });
    expect((await provider.complete(ask('hello'), smallSpec())).text).toBe('echo:hello');
  });

  it('fails the configured number of times first, for fallback tests', async () => {
    const provider = new FakeProvider({ answers: PARIS, failWith: ['boom', 'again'] });

    await expect(provider.complete(ask('x'), smallSpec())).rejects.toThrow(/boom/);
    await expect(provider.complete(ask('x'), smallSpec())).rejects.toThrow(/again/);
    // Exhausted: it now behaves normally.
    await expect(provider.complete(ask('x'), smallSpec())).resolves.toBeDefined();
  });

  it('records every request it saw, in order', async () => {
    const provider = new FakeProvider({ answers: PARIS });
    await provider.complete(ask('first'), smallSpec());
    await provider.complete(ask('second'), smallSpec());

    expect(provider.calls.map((request) => request.text)).toEqual(['first', 'second']);
  });

  it('reports usage proportional to the request and response', async () => {
    const provider = new FakeProvider({ answers: PARIS });
    const response = await provider.complete(ask('What is the capital of France?'), smallSpec());

    expect(response.usage.inputTokens).toBeGreaterThan(0);
    expect(response.usage.outputTokens).toBeGreaterThan(0);
  });

  it('declares the capabilities the gateway negotiates on', () => {
    const provider = new FakeProvider();
    // The simulation can claim anything: there is no wire protocol to contradict it.
    expect([...provider.capabilities].sort()).toEqual([
      'long-context',
      'streaming',
      'structured-output',
      'tool-calling',
    ]);
    expect(supports(provider, 'tool-calling')).toBe(true);
    expect(supports(provider, 'long-context')).toBe(true);
  });

  it('names itself, and can be renamed', () => {
    expect(new FakeProvider().name).toBe('fake');
    expect(new FakeProvider({ name: 'stub' }).name).toBe('stub');
  });

  it('closes harmlessly', async () => {
    const provider = withAccuracy(1.0);
    await provider.close();
    await provider.close();
  });

  it('keys answers on the message text joined by newlines', () => {
    const request = CompletionRequest.prompt('hi', 'be terse');
    expect(promptText(request)).toBe('be terse\nhi');
    expect(
      promptText(new CompletionRequest({ messages: [Message.user('a'), Message.user('b')] })),
    ).toBe('a\nb');
  });
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

const OK_BODY = JSON.stringify({
  choices: [{ message: { content: 'Paris' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 12, completion_tokens: 3 },
});

function provider(fetch: FetchLike, options: Record<string, unknown> = {}) {
  return new OpenAICompatibleProvider({
    apiKey: 'test-key',
    fetchImpl: fetch,
    backoffSeconds: 0,
    ...options,
  });
}

describe('OpenAICompatibleProvider', () => {
  it('posts to /chat/completions and parses the answer', async () => {
    const stub = stubFetch([{ body: OK_BODY }]);
    const response = await provider(stub.fetch).complete(ask('capital?'), smallSpec());

    expect(response.text).toBe('Paris');
    expect(response.model).toBe('fake-small-1');
    expect(response.usage.toJSON()).toEqual({ inputTokens: 12, outputTokens: 3 });
    expect(at(stub.calls, 0).url).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('strips a long trailing run of slashes from the base URL', async () => {
    // The slash run is configuration input. A regex anchored on it is polynomial in the
    // number of slashes, so this asserts the resolved URL for a run long enough that a
    // quadratic strip would be visible rather than merely slow.
    const slashes = '/'.repeat(65_536);
    const stub = stubFetch([{ body: OK_BODY }]);
    await provider(stub.fetch, { baseUrl: `https://api.test/v1${slashes}` }).complete(
      ask('capital?'),
      smallSpec(),
    );

    expect(at(stub.calls, 0).url).toBe('https://api.test/v1/chat/completions');
  });

  it('strips every slash, not just the trailing run, exactly as the reference does', async () => {
    // `https://` has no non-slash after the scheme, so the strip leaves `https:` and the
    // absolute-URL check rejects it. The message is the assertion: it names the stripped
    // value, which pins the strip semantics rather than just the rejection.
    const stub = stubFetch([{ body: OK_BODY }]);

    expect(() => provider(stub.fetch, { baseUrl: 'https://' })).toThrow(/got "https:"/);
    expect(stub.calls).toEqual([]);
  });

  it('sends the model, the messages and no unset option', async () => {
    const stub = stubFetch([{ body: OK_BODY }]);
    await provider(stub.fetch).complete(ask('capital?'), smallSpec());

    const sent = JSON.parse(at(stub.calls, 0).body) as Record<string, unknown>;
    expect(sent.model).toBe('fake-small-1');
    expect(sent.messages).toEqual([{ role: 'user', content: 'capital?' }]);
    expect(sent).not.toHaveProperty('temperature');
    expect(sent).not.toHaveProperty('stop');
    expect(sent).not.toHaveProperty('tools');
    // max_tokens always goes out, clamped to what the model can emit.
    expect(sent.max_tokens).toBe(4096);
  });

  it('clamps a requested max_tokens to the model ceiling', async () => {
    const stub = stubFetch([{ body: OK_BODY }]);
    const request = new CompletionRequest({
      messages: [Message.user('x')],
      maxOutputTokens: 999_999,
    });
    await provider(stub.fetch).complete(request, smallSpec());

    expect((JSON.parse(at(stub.calls, 0).body) as Record<string, unknown>).max_tokens).toBe(4096);
  });

  it('carries tools, stop sequences and temperature when set', async () => {
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

    const sent = JSON.parse(at(stub.calls, 0).body) as Record<string, unknown>;
    expect(sent.temperature).toBe(0.2);
    expect(sent.stop).toEqual(['\n\n']);
    expect(sent.tools).toEqual([
      {
        type: 'function',
        function: { name: 'lookup', description: 'd', parameters: { type: 'object' } },
      },
    ]);
  });

  it('authenticates with a bearer token', async () => {
    const stub = stubFetch([{ body: OK_BODY }]);
    await provider(stub.fetch).complete(ask('x'), smallSpec());

    expect(at(stub.calls, 0).headers.authorization).toMatch(/^Bearer ./);
    expect(at(stub.calls, 0).headers['content-type']).toBe('application/json');
  });

  it('omits authorization when no key is configured', async () => {
    const stub = stubFetch([{ body: OK_BODY }]);
    await new OpenAICompatibleProvider({ fetchImpl: stub.fetch, backoffSeconds: 0 }).complete(
      ask('x'),
      smallSpec(),
    );

    expect(at(stub.calls, 0).headers).not.toHaveProperty('authorization');
  });

  it('passes extra headers through', async () => {
    const stub = stubFetch([{ body: OK_BODY }]);
    await provider(stub.fetch, { extraHeaders: { 'api-key': 'azure-style' } }).complete(
      ask('x'),
      smallSpec(),
    );

    expect(at(stub.calls, 0).headers['api-key']).toBe('azure-style');
  });

  it('honours a custom base URL and strips trailing slashes', async () => {
    const stub = stubFetch([{ body: OK_BODY }]);
    await provider(stub.fetch, { baseUrl: 'https://example.test/v1/' }).complete(
      ask('x'),
      smallSpec(),
    );

    expect(at(stub.calls, 0).url).toBe('https://example.test/v1/chat/completions');
  });

  it('refuses a base URL that is not absolute http(s)', () => {
    expect(() => new OpenAICompatibleProvider({ baseUrl: 'not-a-url' })).toThrow(/absolute http/);
    expect(() => new OpenAICompatibleProvider({ maxAttempts: 0 })).toThrow(/max_attempts/);
  });

  it('retries a retryable status and then succeeds', async () => {
    const stub = stubFetch([{ status: 503, body: 'try later' }, { body: OK_BODY }]);
    const response = await provider(stub.fetch).complete(ask('x'), smallSpec());

    expect(response.text).toBe('Paris');
    expect(stub.calls).toHaveLength(2);
  });

  it('does not retry a status that will not change', async () => {
    const stub = stubFetch([{ status: 400, body: 'bad request' }]);

    await expect(provider(stub.fetch).complete(ask('x'), smallSpec())).rejects.toThrow(
      /returned 400: bad request/,
    );
    expect(stub.calls).toHaveLength(1);
  });

  it('reports the last status failure once it runs out of attempts', async () => {
    const stub = stubFetch([{ status: 429, body: 'slow down' }]);

    await expect(
      provider(stub.fetch, { maxAttempts: 2 }).complete(ask('x'), smallSpec()),
    ).rejects.toThrow(/returned 429: slow down/);
    expect(stub.calls).toHaveLength(2);
  });

  it('retries a transport failure', async () => {
    let attempts = 0;
    const fetch: FetchLike = () => {
      attempts += 1;
      if (attempts === 1) return Promise.reject(new Error('ECONNRESET'));
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(OK_BODY) });
    };

    const response = await provider(fetch).complete(ask('x'), smallSpec());
    expect(response.text).toBe('Paris');
    expect(attempts).toBe(2);
  });

  it('reports a transport failure it could not retry away', async () => {
    const fetch: FetchLike = () => Promise.reject(new Error('ECONNRESET'));
    await expect(
      provider(fetch, { maxAttempts: 1 }).complete(ask('x'), smallSpec()),
    ).rejects.toThrow(/request failed: ECONNRESET/);
  });

  it('refuses a body that is not JSON', async () => {
    const stub = stubFetch([{ body: '<html>nope</html>' }]);
    await expect(provider(stub.fetch).complete(ask('x'), smallSpec())).rejects.toThrow(
      ProviderResponseError,
    );
  });

  it('refuses a JSON body that is not an object', async () => {
    const stub = stubFetch([{ body: '[1,2]' }]);
    await expect(provider(stub.fetch).complete(ask('x'), smallSpec())).rejects.toThrow(
      /not an object/,
    );
  });

  it('refuses a body with no choices', async () => {
    const stub = stubFetch([{ body: JSON.stringify({ choices: [] }) }]);
    await expect(provider(stub.fetch).complete(ask('x'), smallSpec())).rejects.toThrow(
      /no choices/,
    );
  });

  it('refuses a choice with no message, and non-string content', async () => {
    const noMessage = stubFetch([{ body: JSON.stringify({ choices: [{}] }) }]);
    await expect(provider(noMessage.fetch).complete(ask('x'), smallSpec())).rejects.toThrow(
      /without a message/,
    );

    const badContent = stubFetch([
      { body: JSON.stringify({ choices: [{ message: { content: 42 } }] }) },
    ]);
    await expect(provider(badContent.fetch).complete(ask('x'), smallSpec())).rejects.toThrow(
      /non-string content/,
    );
  });

  it('treats null content as an empty answer, for tool-call turns', async () => {
    const stub = stubFetch([
      {
        body: JSON.stringify({
          choices: [{ message: { content: null }, finish_reason: 'tool_calls' }],
        }),
      },
    ]);
    const response = await provider(stub.fetch).complete(ask('x'), smallSpec());

    expect(response.text).toBe('');
    expect(response.finishReason).toBe('tool-calls');
  });

  it('maps every finish reason onto the runtime vocabulary', async () => {
    const reasons: [string, string][] = [
      ['stop', 'stop'],
      ['length', 'length'],
      ['tool_calls', 'tool-calls'],
      ['content_filter', 'content-filter'],
      ['error', 'error'],
      ['something-new', 'stop'],
    ];

    for (const [wire, expected] of reasons) {
      const stub = stubFetch([
        { body: JSON.stringify({ choices: [{ message: { content: 'x' }, finish_reason: wire }] }) },
      ]);
      const response = await provider(stub.fetch).complete(ask('x'), smallSpec());
      expect(response.finishReason).toBe(expected);
    }
  });

  it('parses tool calls, including a JSON-string argument', async () => {
    const stub = stubFetch([
      {
        body: JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  { id: 'call_9', function: { name: 'lookup', arguments: '{"q":"Paris"}' } },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }),
      },
    ]);
    const response = await provider(stub.fetch).complete(ask('x'), smallSpec());

    expect(response.toolCalls).toHaveLength(1);
    expect(at(response.toolCalls, 0).id).toBe('call_9');
    expect(at(response.toolCalls, 0).args).toEqual({ q: 'Paris' });
  });

  it('survives a tool call it cannot parse instead of losing the whole answer', async () => {
    const stub = stubFetch([
      {
        body: JSON.stringify({
          choices: [
            {
              message: {
                content: 'thinking',
                tool_calls: [
                  { function: { name: 'broken', arguments: 'not json' } },
                  { function: { arguments: '{}' } },
                ],
              },
            },
          ],
        }),
      },
    ]);
    const response = await provider(stub.fetch).complete(ask('x'), smallSpec());

    expect(response.text).toBe('thinking');
    // The unnamed entry is dropped; the unparseable one keeps empty arguments.
    expect(response.toolCalls).toHaveLength(1);
    expect(at(response.toolCalls, 0).name).toBe('broken');
    expect(at(response.toolCalls, 0).args).toEqual({});
    expect(at(response.toolCalls, 0).id).toBe('call_0');
  });

  it('reports zero usage when the endpoint omits it', async () => {
    const stub = stubFetch([
      { body: JSON.stringify({ choices: [{ message: { content: 'x' } }] }) },
    ]);
    const response = await provider(stub.fetch).complete(ask('x'), smallSpec());

    expect(response.usage.totalTokens).toBe(0);
  });

  it('refuses to be used after close', async () => {
    const stub = stubFetch([{ body: OK_BODY }]);
    const client = provider(stub.fetch);
    await client.close();

    await expect(client.complete(ask('x'), smallSpec())).rejects.toThrow(ProviderError);
    await expect(client.complete(ask('x'), smallSpec())).rejects.toThrow(/is closed/);
  });

  it('declares the capabilities the wire protocol can carry', () => {
    const client = provider(stubFetch([{ body: OK_BODY }]).fetch);
    expect(supports(client, 'tool-calling')).toBe(true);
    expect(supports(client, 'structured-output')).toBe(true);
    // Whether a deployment has a large window is not a property of the protocol.
    expect(supports(client, 'long-context')).toBe(false);
  });

  it('exposes its configured name and the public default base URL', async () => {
    const stub = stubFetch([{ body: OK_BODY }]);
    expect(provider(stub.fetch).name).toBe('openai-compatible');
    expect(DEFAULT_BASE_URL).toBe('https://api.openai.com/v1');

    await new OpenAICompatibleProvider({
      baseUrl: 'https://example.test/v1',
      fetchImpl: stub.fetch,
      backoffSeconds: 0,
    })
      .complete(ask('x'), smallSpec())
      .catch(() => undefined);
    expect(
      new OpenAICompatibleProvider({ name: 'azure', baseUrl: 'https://example.test' }).name,
    ).toBe('azure');
  });
});
