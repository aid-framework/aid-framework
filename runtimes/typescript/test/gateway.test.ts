/**
 * The model gateway: pinning, capability negotiation, ordered fallback, budgets.
 *
 * The properties worth pinning are the ones that make a stored baseline trustworthy:
 * an alias resolves to one exact model id or fails loudly, a capability the model or its
 * adapter lacks is refused *before* the call, and a budget breach propagates immediately
 * rather than being retried against a different model.
 */

import { describe, expect, it } from 'vitest';
import type { Capability, LedgerEntry, Provider } from '../src/index.js';
import {
  Budget,
  BudgetExceededError,
  CapabilityMismatchError,
  CompletionRequest,
  CompletionResponse,
  ConcurrencyLimiter,
  ConfigurationError,
  CostLedger,
  CostProfile,
  estimateUsage,
  FakeProvider,
  GenerationResult,
  ModelGateway,
  ModelSpec,
  PinnedModel,
  ProviderError,
  ScriptedTurn,
  StreamChunk,
  TokenUsage,
  UnknownModelAliasError,
} from '../src/index.js';
import {
  at,
  DeclaredProvider,
  FAKE_PROVIDER,
  failure,
  LARGE_ALIAS,
  largeSpec,
  SMALL_ALIAS,
  smallSpec,
} from './support.js';

function ask(text = 'hello'): CompletionRequest {
  return CompletionRequest.prompt(text);
}

/** A gateway whose fake answers everything correctly. */
function gateway(options: { readonly budget?: Budget } = {}): ModelGateway {
  return new ModelGateway({
    providers: { [FAKE_PROVIDER]: new FakeProvider({ accuracy: 1.0 }) },
    aliases: { [SMALL_ALIAS]: smallSpec(), [LARGE_ALIAS]: largeSpec() },
    ...options,
  });
}

describe('ModelGateway aliases', () => {
  it('lists its pinned aliases, sorted', () => {
    expect(gateway().aliases).toEqual([LARGE_ALIAS, SMALL_ALIAS]);
  });

  it('resolves an alias to one exact model id', () => {
    const pinned = gateway().resolve(SMALL_ALIAS);

    expect(pinned.alias).toBe(SMALL_ALIAS);
    expect(pinned.model.name).toBe('fake-small-1');
  });

  it('accepts an alias already pinned to another alias', () => {
    const pinned = new ModelGateway({
      providers: { [FAKE_PROVIDER]: new FakeProvider() },
      aliases: {
        primary: smallSpec(),
        backup: new PinnedModel({ alias: 'primary', model: smallSpec() }),
      },
    }).resolve('backup');

    expect(pinned.model.name).toBe('fake-small-1');
  });

  it('refuses an unknown alias instead of falling through to a provider default', () => {
    const error = (() => {
      try {
        gateway().resolve('absent');
        return null;
      } catch (caught) {
        return caught;
      }
    })();

    expect(error).toBeInstanceOf(UnknownModelAliasError);
    expect((error as Error).message).toBe(
      "unknown model alias 'absent'; pinned aliases: large, small",
    );
    expect((error as UnknownModelAliasError).known).toEqual([LARGE_ALIAS, SMALL_ALIAS]);
  });

  it('refuses to be built with nothing to route', () => {
    // Both empty configurations are wiring mistakes, and both are caught at construction
    // rather than on the first call.
    expect(() => new ModelGateway({ providers: {}, aliases: {} })).toThrow(
      /the gateway needs at least one provider/,
    );
    expect(
      () =>
        new ModelGateway({
          providers: { [FAKE_PROVIDER]: new FakeProvider() },
          aliases: {},
        }),
    ).toThrow(/the gateway needs at least one pinned alias/);
  });

  it('finds the adapter that serves an alias', () => {
    const provider = new FakeProvider();
    const client = new ModelGateway({
      providers: { [FAKE_PROVIDER]: provider },
      aliases: { [SMALL_ALIAS]: smallSpec() },
    });

    expect(client.providerFor(SMALL_ALIAS)).toBe(provider);
    expect(() => client.providerFor('absent')).toThrow(UnknownModelAliasError);
  });

  it('refuses at construction an alias whose provider is not registered', () => {
    // The registration is checked when the gateway is built, so a typo in a provider name
    // cannot survive to the first call.
    expect(
      () =>
        new ModelGateway({
          providers: { [FAKE_PROVIDER]: new FakeProvider() },
          aliases: {
            [SMALL_ALIAS]: new ModelSpec({
              name: 'unserved-1',
              provider: 'nobody',
              cost: new CostProfile({ inputPer1kUsd: 1, outputPer1kUsd: 1 }),
              contextWindow: 1024,
              maxOutputTokens: 128,
            }),
          },
        }),
    ).toThrow(/alias "small" names provider "nobody", which is not among \["fake"\]/);
  });
});

describe('ModelGateway capability negotiation', () => {
  it('returns the pinned model when both sides declare the capability', () => {
    const pinned = gateway().require(SMALL_ALIAS, ['tool-calling', 'structured-output']);
    expect(pinned.alias).toBe(SMALL_ALIAS);
  });

  it('names every capability the model lacks, sorted', () => {
    const client = new ModelGateway({
      providers: { [FAKE_PROVIDER]: new DeclaredProvider(['tool-calling']) },
      aliases: {
        [SMALL_ALIAS]: smallSpec(),
        stripped: new ModelSpec({
          name: 'stripped-1',
          provider: FAKE_PROVIDER,
          cost: new CostProfile({ inputPer1kUsd: 1, outputPer1kUsd: 1 }),
          contextWindow: 1024,
          maxOutputTokens: 128,
          capabilities: [],
        }),
      },
    });

    const error = (() => {
      try {
        client.require('stripped', ['structured-output', 'tool-calling']);
        return null;
      } catch (caught) {
        return caught;
      }
    })();

    expect(error).toBeInstanceOf(CapabilityMismatchError);
    expect((error as Error).message).toBe(
      "model alias 'stripped' does not support: structured-output, tool-calling",
    );
    expect((error as CapabilityMismatchError).missing).toEqual([
      'structured-output',
      'tool-calling',
    ]);
  });

  it('refuses a capability the model claims but its adapter does not', () => {
    // A model that supports tool calling behind an adapter that cannot serialise tool
    // definitions cannot tool-call. Both sides are checked.
    const client = new ModelGateway({
      providers: { [FAKE_PROVIDER]: new DeclaredProvider([]) },
      aliases: { [SMALL_ALIAS]: smallSpec() },
    });

    expect(() => client.require(SMALL_ALIAS, ['tool-calling'])).toThrow(
      /does not support: tool-calling/,
    );
  });
});

describe('ModelGateway.generate', () => {
  it('answers, reports which alias served it, and charges the ledger', async () => {
    const provider = new FakeProvider({ answers: { hello: 'hi there' }, accuracy: 1.0 });
    const client = new ModelGateway({
      providers: { [FAKE_PROVIDER]: provider },
      aliases: { [SMALL_ALIAS]: smallSpec() },
    });

    const result = await client.generate(SMALL_ALIAS, ask());

    expect(result).toBeInstanceOf(GenerationResult);
    expect(result.text).toBe('hi there');
    expect(result.alias).toBe(SMALL_ALIAS);
    expect(result.attempts).toEqual([SMALL_ALIAS]);
    expect(result.fellBack).toBe(false);
    expect(result.costUsd).toBeGreaterThan(0);
    expect(client.ledger.entries).toHaveLength(1);
    expect(client.ledger.costUsd).toBe(result.costUsd);
  });

  it('exposes the response usage', async () => {
    const result = await gateway().generate(SMALL_ALIAS, ask());
    expect(result.usage).toBeInstanceOf(TokenUsage);
    expect(result.usage.totalTokens).toBeGreaterThan(0);
  });

  it('prices a call from the pinned model, not from the provider', async () => {
    const client = gateway();
    const small = await client.generate(SMALL_ALIAS, ask());
    const large = await client.generate(LARGE_ALIAS, ask());

    // Same request, same fake usage; the large model simply costs more per token.
    expect(large.costUsd).toBeGreaterThan(small.costUsd);
  });

  it('calls every hook after a charged call', async () => {
    const seen: LedgerEntry[] = [];
    const client = new ModelGateway({
      providers: { [FAKE_PROVIDER]: new FakeProvider() },
      aliases: { [SMALL_ALIAS]: smallSpec() },
      onCall: [(entry) => seen.push(entry)],
    });

    await client.generate(SMALL_ALIAS, ask());

    expect(seen).toHaveLength(1);
    expect(at(seen, 0).alias).toBe(SMALL_ALIAS);
    expect(at(seen, 0).model).toBe('fake-small-1');
  });

  it('records one ledger entry per model', async () => {
    const client = gateway();
    await client.generate(SMALL_ALIAS, ask());
    await client.generate(LARGE_ALIAS, ask());

    expect(Object.keys(client.ledger.summary().byModel)).toEqual(['fake-small-1', 'fake-large-1']);
  });

  it('refuses an unknown alias before calling anything', async () => {
    const provider = new FakeProvider();
    const client = new ModelGateway({
      providers: { [FAKE_PROVIDER]: provider },
      aliases: { [SMALL_ALIAS]: smallSpec() },
    });

    await expect(client.generate('absent', ask())).rejects.toThrow(UnknownModelAliasError);
    expect(provider.calls).toHaveLength(0);
  });

  it('closes every provider, tolerating a repeat', async () => {
    const provider = new FakeProvider();
    const client = new ModelGateway({
      providers: { [FAKE_PROVIDER]: provider },
      aliases: { [SMALL_ALIAS]: smallSpec() },
    });

    await client.close();
    await client.close();
  });
});

describe('ModelGateway.stream', () => {
  const TEXT = 'hello streaming world';
  const STREAM_ALIAS = 'stream';

  function streamingSpec(
    capabilities: readonly Capability[] = ['streaming'],
    name = 'fake-stream-1',
  ): ModelSpec {
    return new ModelSpec({
      name,
      provider: FAKE_PROVIDER,
      cost: new CostProfile({ inputPer1kUsd: 0.15, outputPer1kUsd: 0.6 }),
      contextWindow: 128_000,
      maxOutputTokens: 4096,
      capabilities,
    });
  }

  function streamingGateway(
    options: {
      readonly spec?: ModelSpec;
      readonly provider?: Provider;
      readonly limiter?: ConcurrencyLimiter;
      readonly budget?: Budget;
    } = {},
  ): ModelGateway {
    return new ModelGateway({
      providers: {
        [FAKE_PROVIDER]:
          options.provider ??
          new FakeProvider({ accuracy: 1.0, script: [ScriptedTurn.answer(TEXT)] }),
      },
      aliases: { [STREAM_ALIAS]: options.spec ?? streamingSpec() },
      ...(options.limiter === undefined ? {} : { limiter: options.limiter }),
      ...(options.budget === undefined ? {} : { budget: options.budget }),
    });
  }

  async function collect(stream: AsyncIterable<string>): Promise<string[]> {
    const frames: string[] = [];
    for await (const frame of stream) frames.push(frame);
    return frames;
  }

  /** Decode one SSE `data` frame into its JSON payload. */
  function payload(frame: string): Record<string, unknown> {
    if (!frame.startsWith('data: ') || !frame.endsWith('\n\n')) {
      throw new Error(`not an SSE frame: ${JSON.stringify(frame)}`);
    }
    return JSON.parse(frame.slice('data: '.length, -2)) as Record<string, unknown>;
  }

  /** Holds a delta back so a consumer can abandon the stream mid-flight. */
  class SlowStreamProvider implements Provider {
    readonly name = FAKE_PROVIDER;
    readonly capabilities: ReadonlySet<Capability> = new Set<Capability>(['streaming']);
    closed = false;

    async complete(): Promise<CompletionResponse> {
      throw new Error('this fixture only streams');
    }

    async close(): Promise<void> {}

    async *stream(): AsyncGenerator<StreamChunk, void, undefined> {
      try {
        for (let start = 0; start < TEXT.length; start += 4) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          yield new StreamChunk({ delta: TEXT.slice(start, start + 4) });
        }
        yield new StreamChunk({
          finishReason: 'stop',
          usage: new TokenUsage({ inputTokens: 1, outputTokens: 1 }),
        });
      } finally {
        this.closed = true;
      }
    }
  }

  /** Streams deltas but reports no usage, as some endpoints do. */
  class NoUsageProvider implements Provider {
    readonly name = FAKE_PROVIDER;
    readonly capabilities: ReadonlySet<Capability> = new Set<Capability>(['streaming']);

    async complete(): Promise<CompletionResponse> {
      throw new Error('this fixture only streams');
    }

    async close(): Promise<void> {}

    async *stream(): AsyncGenerator<StreamChunk, void, undefined> {
      yield new StreamChunk({ delta: 'abcdefgh' });
      yield new StreamChunk({ finishReason: 'length' });
    }
  }

  it('emits one SSE frame per delta and a terminal frame', async () => {
    const frames = await collect(streamingGateway().stream(STREAM_ALIAS, ask('hi')));

    expect(frames.length).toBeGreaterThan(1);
    expect(payload(at(frames, 0))).toEqual({ delta: TEXT.slice(0, 4) });
    expect(payload(at(frames, frames.length - 1))).toEqual({
      done: true,
      finish_reason: 'stop',
      model: 'fake-stream-1',
      provider: FAKE_PROVIDER,
    });
  });

  it('delivers every delta in order', async () => {
    const frames = await collect(streamingGateway().stream(STREAM_ALIAS, ask('hi')));
    const deltas = frames.slice(0, -1).map((frame) => payload(frame).delta as string);

    expect(deltas.join('')).toBe(TEXT);
  });

  it('charges a streamed call exactly what generate would have charged', async () => {
    const spec = streamingSpec();
    const generated = await new ModelGateway({
      providers: {
        [FAKE_PROVIDER]: new FakeProvider({ script: [ScriptedTurn.answer(TEXT)] }),
      },
      aliases: { [STREAM_ALIAS]: spec },
    }).generate(STREAM_ALIAS, ask('hi'));

    const client = streamingGateway({ spec });
    await collect(client.stream(STREAM_ALIAS, ask('hi')));

    const entry = at(client.ledger.entries, 0);
    expect(client.ledger.summary().calls).toBe(1);
    expect(entry.alias).toBe(STREAM_ALIAS);
    expect(entry.model).toBe(spec.name);
    expect(entry.usage.toJSON()).toEqual(generated.usage.toJSON());
    expect(entry.costUsd).toBe(spec.cost.costUsd(entry.usage));
    expect(entry.costUsd).toBe(generated.costUsd);
  });

  it('estimates usage only when the endpoint reports none', async () => {
    const client = streamingGateway({ provider: new NoUsageProvider() });
    const frames = await collect(client.stream(STREAM_ALIAS, ask('hi')));

    // 'hi' is one token at four characters per token; eight served characters are two.
    expect(at(client.ledger.entries, 0).usage.toJSON()).toEqual({
      inputTokens: 1,
      outputTokens: 2,
    });
    expect(payload(at(frames, frames.length - 1)).finish_reason).toBe('length');
  });

  it('refuses a model without the streaming capability, before calling it', async () => {
    const provider = new FakeProvider({ script: [ScriptedTurn.answer(TEXT)] });
    const client = streamingGateway({ spec: streamingSpec([]), provider });

    await expect(collect(client.stream(STREAM_ALIAS, ask('hi')))).rejects.toThrow(
      CapabilityMismatchError,
    );
    expect(provider.calls).toHaveLength(0);
  });

  it('refuses an adapter that advertises streaming without implementing it', async () => {
    const client = streamingGateway({ provider: new DeclaredProvider(['streaming']) });

    await expect(collect(client.stream(STREAM_ALIAS, ask('hi')))).rejects.toThrow(
      ConfigurationError,
    );
  });

  it('refuses a prompt that alone breaches the budget, before calling it', async () => {
    const provider = new FakeProvider({ script: [ScriptedTurn.answer(TEXT)] });
    const client = streamingGateway({
      provider,
      budget: new Budget({ maxUsd: 0.0000001 }),
    });

    await expect(collect(client.stream(STREAM_ALIAS, ask('hi')))).rejects.toThrow(
      BudgetExceededError,
    );
    expect(provider.calls).toHaveLength(0);
  });

  it('propagates a mid-stream failure without charging the ledger', async () => {
    class FailingProvider implements Provider {
      readonly name = FAKE_PROVIDER;
      readonly capabilities: ReadonlySet<Capability> = new Set<Capability>(['streaming']);

      async complete(): Promise<CompletionResponse> {
        throw new Error('this fixture only streams');
      }

      async close(): Promise<void> {}

      async *stream(): AsyncGenerator<StreamChunk, void, undefined> {
        yield new StreamChunk({ delta: 'partial' });
        throw new ProviderError('connection reset');
      }
    }

    const client = streamingGateway({ provider: new FailingProvider() });

    await expect(collect(client.stream(STREAM_ALIAS, ask('hi')))).rejects.toThrow(
      /connection reset/,
    );
    expect(client.ledger.summary().calls).toBe(0);
  });

  it('releases the concurrency slot when the consumer abandons the stream', async () => {
    const limiter = new ConcurrencyLimiter(1);
    const provider = new SlowStreamProvider();
    const frames = streamingGateway({ provider, limiter }).stream(STREAM_ALIAS, ask('hi'));
    const iterator = frames[Symbol.asyncIterator]();

    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(limiter.inFlight).toBe(1);

    await iterator.return?.();

    expect(limiter.inFlight).toBe(0);
    expect(provider.closed).toBe(true);
  });
});

describe('ModelGateway fallback', () => {
  /** A provider that fails the first N calls with a provider error. */
  function failing(failures: number): FakeProvider {
    return new FakeProvider({
      answers: { hello: 'answered' },
      accuracy: 1.0,
      failWith: Array.from({ length: failures }, (_unused, index) => `down-${index}`),
    });
  }

  it('tries fallbacks in order and reports the alias that answered', async () => {
    const client = new ModelGateway({
      providers: { [FAKE_PROVIDER]: failing(1) },
      aliases: { [SMALL_ALIAS]: smallSpec(), [LARGE_ALIAS]: largeSpec() },
    });

    const result = await client.generate(SMALL_ALIAS, ask(), { fallbacks: [LARGE_ALIAS] });

    expect(result.alias).toBe(LARGE_ALIAS);
    expect(result.attempts).toEqual([SMALL_ALIAS, LARGE_ALIAS]);
    expect(result.fellBack).toBe(true);
    expect(result.text).toBe('answered');
  });

  it('reports every candidate that was tried when all of them fail', async () => {
    const client = new ModelGateway({
      providers: { [FAKE_PROVIDER]: failing(2) },
      aliases: { [SMALL_ALIAS]: smallSpec(), [LARGE_ALIAS]: largeSpec() },
    });

    await expect(client.generate(SMALL_ALIAS, ask(), { fallbacks: [LARGE_ALIAS] })).rejects.toThrow(
      /every candidate failed \(2 tried\)/,
    );
  });

  it('names each failed candidate in the error', async () => {
    const client = new ModelGateway({
      providers: { [FAKE_PROVIDER]: failing(2) },
      aliases: { [SMALL_ALIAS]: smallSpec(), [LARGE_ALIAS]: largeSpec() },
    });

    const error = await failure(client.generate(SMALL_ALIAS, ask(), { fallbacks: [LARGE_ALIAS] }));

    expect(error).toBeInstanceOf(ProviderError);
    expect(error.message).toContain('small: down-0');
    expect(error.message).toContain('large: down-1');
  });

  it('does not fall back for an error another model could not survive', async () => {
    const provider = new FakeProvider();
    const client = new ModelGateway({
      providers: { [FAKE_PROVIDER]: provider },
      aliases: { [SMALL_ALIAS]: smallSpec(), [LARGE_ALIAS]: largeSpec() },
    });

    // An unknown alias is a wiring mistake; a second candidate cannot fix it.
    await expect(client.generate('absent', ask(), { fallbacks: [SMALL_ALIAS] })).rejects.toThrow(
      UnknownModelAliasError,
    );
    expect(provider.calls).toHaveLength(0);
  });

  it('does not fall back on an exhausted budget', async () => {
    const provider = new FakeProvider();
    const client = new ModelGateway({
      providers: { [FAKE_PROVIDER]: provider },
      aliases: { [SMALL_ALIAS]: smallSpec(), [LARGE_ALIAS]: largeSpec() },
      budget: new Budget({ maxUsd: 0.0000001 }),
    });

    await expect(client.generate(SMALL_ALIAS, ask(), { fallbacks: [LARGE_ALIAS] })).rejects.toThrow(
      BudgetExceededError,
    );
    expect(provider.calls).toHaveLength(0);
  });
});

describe('ModelGateway budgets', () => {
  it('refuses a call whose prompt alone already breaches the budget', async () => {
    const provider = new FakeProvider();
    const client = new ModelGateway({
      providers: { [FAKE_PROVIDER]: provider },
      aliases: { [LARGE_ALIAS]: largeSpec() },
      budget: new Budget({ maxUsd: 0.1 }),
    });

    // 400 chars is 100 tokens at the estimator's four-characters-per-token rule; the
    // large model charges $2.50 per 1k input tokens, so the prompt alone is $0.25.
    await expect(client.generate(LARGE_ALIAS, ask('x'.repeat(400)))).rejects.toThrow(
      /budget 'run' exceeded: limit \$0\.100000, spent \$0\.250000/,
    );
    expect(provider.calls).toHaveLength(0);
  });

  it('lets an affordable call through and then charges it', async () => {
    const client = gateway({ budget: new Budget({ maxUsd: 1.0 }) });
    const result = await client.generate(SMALL_ALIAS, ask());

    expect(result.costUsd).toBeGreaterThan(0);
    expect(client.ledger.costUsd).toBeLessThan(1.0);
  });

  it('accepts a per-call budget that overrides the gateway default', async () => {
    const client = gateway({ budget: new Budget({ maxUsd: 0.0000001 }) });
    const result = await client.generate(SMALL_ALIAS, ask(), {
      budget: new Budget({ maxUsd: 100 }),
    });

    expect(result.text.length).toBeGreaterThan(0);
  });

  it('charges a token budget as well as a dollar one', async () => {
    const client = gateway({ budget: new Budget({ maxTotalTokens: 1 }) });

    await expect(client.generate(SMALL_ALIAS, ask())).rejects.toThrow(/budget 'run' exceeded/);
  });
});

describe('ModelGateway ledger accounting', () => {
  it('starts empty and reports its own budget', () => {
    const budget = new Budget({ maxUsd: 5 });
    const client = gateway({ budget });

    expect(client.budget).toBe(budget);
    expect(client.ledger.entries).toEqual([]);
    expect(client.ledger.costUsd).toBe(0);
  });

  it('shares a supplied ledger rather than replacing it', async () => {
    const ledger = new CostLedger();
    const client = new ModelGateway({
      providers: { [FAKE_PROVIDER]: new FakeProvider() },
      aliases: { [SMALL_ALIAS]: smallSpec() },
      ledger,
    });

    await client.generate(SMALL_ALIAS, ask());

    expect(client.ledger).toBe(ledger);
    expect(ledger.entries).toHaveLength(1);
  });

  it('accumulates across calls', async () => {
    const client = gateway();
    await client.generate(SMALL_ALIAS, ask());
    const afterOne = client.ledger.costUsd;
    await client.generate(SMALL_ALIAS, ask());

    expect(client.ledger.costUsd).toBeCloseTo(afterOne * 2, 12);
  });
});

describe('estimateUsage', () => {
  it('estimates four characters per token, rounded up', () => {
    expect(estimateUsage('').toJSON()).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(estimateUsage('abc').inputTokens).toBe(1);
    expect(estimateUsage('abcd').inputTokens).toBe(1);
    expect(estimateUsage('abcde').inputTokens).toBe(2);
  });

  it('sums a list of strings', () => {
    expect(estimateUsage(['abcd', 'abcd', 'abcd']).inputTokens).toBe(3);
    expect(estimateUsage([]).inputTokens).toBe(0);
  });

  it('never claims output tokens it cannot know', () => {
    expect(estimateUsage('x'.repeat(4000)).outputTokens).toBe(0);
  });
});

describe('GenerationResult', () => {
  it('starts with no attempted aliases, like the reference runtime', () => {
    const result = new GenerationResult({
      response: new CompletionResponse({
        text: 'x',
        model: 'm',
        provider: 'p',
        usage: new TokenUsage({ inputTokens: 1, outputTokens: 1 }),
      }),
      alias: SMALL_ALIAS,
      costUsd: 0,
    });

    expect(result.attempts).toEqual([]);
    expect(result.fellBack).toBe(false);
  });

  it('treats a single attempted alias as no fallback', () => {
    const result = new GenerationResult({
      response: new CompletionResponse({
        text: 'x',
        model: 'm',
        provider: 'p',
        usage: new TokenUsage({ inputTokens: 1, outputTokens: 1 }),
      }),
      alias: SMALL_ALIAS,
      costUsd: 0,
      attempts: [SMALL_ALIAS],
    });

    expect(result.fellBack).toBe(false);
  });

  it('treats more than one attempted alias as a fallback', () => {
    const result = new GenerationResult({
      response: new CompletionResponse({
        text: 'x',
        model: 'm',
        provider: 'p',
        usage: new TokenUsage({ inputTokens: 1, outputTokens: 1 }),
        finishReason: 'length',
      }),
      alias: LARGE_ALIAS,
      costUsd: 0.5,
      attempts: [SMALL_ALIAS, LARGE_ALIAS],
    });

    expect(result.fellBack).toBe(true);
    expect(result.response.finishReason).toBe('length');
    expect(result.costUsd).toBe(0.5);
  });
});
