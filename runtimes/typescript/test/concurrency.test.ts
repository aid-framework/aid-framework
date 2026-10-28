/**
 * The concurrency limiter, ported from `runtimes/python/tests/test_concurrency.py`.
 *
 * The limiter exists so a deployment's `concurrency` cap is one number for the whole
 * application rather than one per subsystem: the gateway and the tool executor are handed
 * the same instance, so an app cannot exceed its cap by calling a model and a tool at the
 * same time. That is what {@link SHARED} below asserts.
 *
 * ## One test the reference runtime has and this one cannot
 *
 * `test_concurrency.py::test_a_cancelled_call_releases_its_slot` cancels an asyncio task
 * and asserts the slot comes back. A JavaScript promise has no cancellation, so there is
 * no truthful analogue: the property that matters for the limiter -- a call that ends
 * badly still releases -- is covered by the failure case here, and nothing claims to
 * cover cancellation.
 */

import { describe, expect, it } from 'vitest';

import { ConcurrencyLimiter } from '../src/concurrency.js';
import { ConfigurationError, ProviderError } from '../src/errors.js';
import { ModelGateway } from '../src/gateway.js';
import { FakeProvider } from '../src/providers/fake.js';
import { Tool, ToolExecutor } from '../src/tools.js';
import { CompletionRequest, CompletionResponse, type ModelSpec, ToolCall } from '../src/types.js';
import { FAKE_PROVIDER, failure, SMALL_ALIAS, smallSpec } from './support.js';

const SHARED = 'the gateway and the executor share one limiter';

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/**
 * A provider whose calls park until they are released.
 *
 * The gate is what makes overlap observable: without it a call returns in the same tick
 * and a limiter that did nothing would still look correct.
 */
class SlowProvider extends FakeProvider {
  active = 0;
  peak = 0;
  private readonly _gate: Promise<void>;
  private _open!: () => void;
  private readonly _parked: Promise<void>;
  private _park!: () => void;

  constructor(private readonly _parkAt = 1) {
    super({ accuracy: 1.0 });
    this._gate = new Promise<void>((resolve) => {
      this._open = resolve;
    });
    this._parked = new Promise<void>((resolve) => {
      this._park = resolve;
    });
  }

  /** Resolves once `parkAt` calls are in flight at the same time. */
  get parked(): Promise<void> {
    return this._parked;
  }

  release(): void {
    this._open();
  }

  override async complete(
    _request: CompletionRequest,
    model: ModelSpec,
  ): Promise<CompletionResponse> {
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
    if (this.active >= this._parkAt) this._park();
    try {
      await this._gate;
      return new CompletionResponse({ text: 'ok', model: model.name, provider: this.name });
    } finally {
      this.active -= 1;
    }
  }
}

function gatewayFor(provider: FakeProvider, limiter?: ConcurrencyLimiter): ModelGateway {
  return new ModelGateway({
    providers: { [FAKE_PROVIDER]: provider },
    aliases: { [SMALL_ALIAS]: smallSpec() },
    ...(limiter === undefined ? {} : { limiter }),
  });
}

describe('ConcurrencyLimiter', () => {
  it('refuses a cap below one', () => {
    expect(() => new ConcurrencyLimiter(0)).toThrow(ConfigurationError);
    expect(() => new ConcurrencyLimiter(0)).toThrow(/concurrency must be at least 1, got 0/);
    expect(() => new ConcurrencyLimiter(1.5)).toThrow(ConfigurationError);
  });

  it('never runs more calls at once than the cap allows', async () => {
    const provider = new SlowProvider(2);
    const limiter = new ConcurrencyLimiter(2);
    const gateway = gatewayFor(provider, limiter);

    const calls = Array.from({ length: 3 }, () =>
      gateway.generate(SMALL_ALIAS, CompletionRequest.prompt('hi')),
    );
    // The three calls are issued before any awaits, so all three are contending for a slot.
    await provider.parked;
    expect(provider.active).toBe(2);

    provider.release();
    const answered = await Promise.all(calls);

    expect(answered).toHaveLength(3);
    expect(provider.peak).toBe(2);
    expect(limiter.inFlight).toBe(0);
  });

  it('releases the slot when a call fails', async () => {
    const provider = new FakeProvider({ accuracy: 1.0, failWith: ['provider exploded'] });
    const limiter = new ConcurrencyLimiter(1);
    const gateway = gatewayFor(provider, limiter);

    const error = await failure(gateway.generate(SMALL_ALIAS, CompletionRequest.prompt('first')));
    expect(error).toBeInstanceOf(ProviderError);
    expect(limiter.inFlight).toBe(0);

    // The slot came back: a second call reaches the provider instead of deadlocking.
    const answered = await gateway.generate(SMALL_ALIAS, CompletionRequest.prompt('second'));
    expect(answered.text.length).toBeGreaterThan(0);
  });

  it('runs unbounded when no limiter is configured', async () => {
    const provider = new SlowProvider(3);
    const gateway = gatewayFor(provider);

    const calls = Array.from({ length: 3 }, () =>
      gateway.generate(SMALL_ALIAS, CompletionRequest.prompt('hi')),
    );
    await provider.parked;
    expect(provider.active).toBe(3);

    provider.release();
    await Promise.all(calls);
    expect(provider.peak).toBe(3);
  });

  it(`${SHARED}`, async () => {
    const provider = new SlowProvider(1);
    const limiter = new ConcurrencyLimiter(1);
    const gateway = gatewayFor(provider, limiter);
    let ran = false;
    const executor = new ToolExecutor(
      [
        Tool.of({
          name: 'note',
          handler: () => {
            ran = true;
            return 'done';
          },
        }),
      ],
      { limiter },
    );

    const modelCall = gateway.generate(SMALL_ALIAS, CompletionRequest.prompt('hi'));
    await provider.parked;
    const toolCall = executor.execute(new ToolCall({ id: 'call-1', name: 'note' }));

    // The model call holds the only slot, so the tool cannot have run yet.
    await sleep(30);
    expect(ran).toBe(false);

    provider.release();
    await modelCall;
    const result = await toolCall;

    expect(ran).toBe(true);
    expect(result.content).toBe('done');
    expect(limiter.inFlight).toBe(0);
  });
});
