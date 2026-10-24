/**
 * A deterministic provider for tests.
 *
 * This is not a mock in the "returns a canned value" sense. It is a *seeded
 * simulation* of a probabilistic model: given the same seed and the same request it
 * produces byte-identical output, but it deliberately answers correctly only a
 * configurable fraction of the time. That is the whole point -- it lets the eval gate
 * be tested against genuine non-determinism, so a test can prove that run-to-run
 * variation is tolerated while a real regression is caught.
 *
 * ## One documented divergence from the Python runtime
 *
 * The reference implementation draws its accuracy sample from
 * `random.Random("seed:index:prompt").random()`, which is CPython's Mersenne Twister
 * seeded from a string. That seeding is a CPython implementation detail with no
 * portable equivalent, so this runtime draws from a SHA-256 hash of the same triple
 * instead. The properties the gate depends on are preserved:
 *
 * - the draw is a pure function of `(seed, call index, prompt)`, so a recorded
 *   baseline reproduces exactly;
 * - the call index is part of the input, so re-running a dataset re-draws every case
 *   and an N-run sample genuinely varies.
 *
 * What is *not* claimed is that the two runtimes draw the same number. They do not,
 * and no test in either runtime should assert that they do.
 */

import { ProviderError } from '../errors.js';
import { digestPrefix, sha256Hex } from '../internal/json.js';
import {
  type Capability,
  type CompletionRequest,
  CompletionResponse,
  type ModelSpec,
  TokenUsage,
} from '../types.js';
import type { Provider } from './base.js';

/** A responder sees the request and its call index, and returns the model's text. */
export type Responder = (request: CompletionRequest, index: number) => string;

export interface FakeProviderOptions {
  readonly responder?: Responder;
  /** Maps the *user message* to the ideal response. */
  readonly answers?: Readonly<Record<string, string>>;
  readonly accuracy?: number;
  readonly seed?: number;
  readonly name?: string;
  /** One message per successive call; once exhausted the provider behaves normally. */
  readonly failWith?: readonly string[];
  readonly tokensPerChar?: number;
  readonly overheadTokens?: number;
}

/** Deterministic, seedable, and optionally inaccurate. */
export class FakeProvider implements Provider {
  private readonly _responder: Responder | undefined;
  private readonly _answers: ReadonlyMap<string, string>;
  private readonly _accuracy: number;
  private readonly _seed: number;
  private readonly _name: string;
  private readonly _failures: string[];
  private readonly _tokensPerChar: number;
  private readonly _overheadTokens: number;

  /** Every request this provider has seen, in order. */
  readonly calls: CompletionRequest[] = [];

  constructor(options: FakeProviderOptions = {}) {
    const accuracy = options.accuracy ?? 1.0;
    if (!(accuracy >= 0.0 && accuracy <= 1.0)) {
      throw new RangeError('accuracy must be between 0.0 and 1.0');
    }
    this._responder = options.responder;
    this._answers = new Map(Object.entries(options.answers ?? {}));
    this._accuracy = accuracy;
    this._seed = options.seed ?? 0;
    this._name = options.name ?? 'fake';
    this._failures = [...(options.failWith ?? [])];
    this._tokensPerChar = options.tokensPerChar ?? 0.25;
    this._overheadTokens = options.overheadTokens ?? 8;
  }

  get name(): string {
    return this._name;
  }

  get capabilities(): ReadonlySet<Capability> {
    return new Set<Capability>(['tool-calling', 'structured-output', 'streaming', 'long-context']);
  }

  async complete(request: CompletionRequest, model: ModelSpec): Promise<CompletionResponse> {
    this.calls.push(request);
    const index = this.calls.length - 1;

    const failure = this._failures.shift();
    if (failure !== undefined) throw new ProviderError(failure);

    const text = this.respondTo(request, index);
    return new CompletionResponse({
      text,
      model: model.name,
      provider: this._name,
      usage: new TokenUsage({
        inputTokens: this.countTokens(promptText(request)),
        outputTokens: this.countTokens(text),
      }),
      finishReason: 'stop',
    });
  }

  async close(): Promise<void> {
    return;
  }

  private respondTo(request: CompletionRequest, index: number): string {
    if (this._responder !== undefined) return this._responder(request, index);

    const prompt = promptText(request);
    let ideal = this._answers.get(prompt);
    if (ideal === undefined) {
      for (const [key, value] of this._answers) {
        if (prompt.includes(key)) {
          ideal = value;
          break;
        }
      }
    }

    if (ideal === undefined) {
      // No expectation to hit, so accuracy does not apply: echo deterministically.
      return `echo:${digestPrefix(`${this._seed}:${prompt}`)}`;
    }

    if (this._accuracy >= 1.0) return ideal;
    if (this.draw(prompt, index) < this._accuracy) return ideal;
    // A wrong answer must still be deterministic and visibly wrong.
    return `${ideal}#${digestPrefix(`${this._seed + index}:${prompt}`)}`;
  }

  /**
   * A stable pseudo-random draw in `[0, 1)` for this `(seed, index, prompt)` triple.
   *
   * See the module comment: this is a hash, not CPython's PRNG, and the divergence is
   * deliberate and documented.
   */
  private draw(prompt: string, index: number): number {
    const hex = sha256Hex(`${this._seed}:${index}:${prompt}`).slice(0, 16);
    return Number(BigInt(`0x${hex}`)) / 2 ** 64;
  }

  private countTokens(text: string): number {
    return Math.trunc(text.length * this._tokensPerChar) + this._overheadTokens;
  }
}

/** The concatenated message text, which is what a provider keys its answers on. */
export function promptText(request: CompletionRequest): string {
  return request.messages.map((message) => message.content).join('\n');
}

/** Convenience factory used by the eval-gate tests. */
export function withAccuracy(
  accuracy: number,
  options: { readonly seed?: number } = {},
): FakeProvider {
  return new FakeProvider({ accuracy, seed: options.seed ?? 0 });
}
