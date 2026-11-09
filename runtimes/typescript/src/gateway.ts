/**
 * The model gateway: alias resolution, capability negotiation, cost accounting.
 *
 * Three responsibilities, in this order:
 *
 * 1. **Pinning.** An alias resolves to an exact provider model id. Unknown aliases are
 *    an error; there is no fall-through to a provider default, because a provider
 *    default is precisely the floating version a stored eval baseline cannot survive.
 * 2. **Ordered fallback.** A caller may name fallback aliases. They are tried in the
 *    order given, and the aliases actually attempted are reported on the result.
 *    Escalation routing -- "use the strong model if the cheap one is unsure" -- is
 *    *not* implemented: "unsure" needs an agent loop to define.
 * 3. **Budgets and tracing.** Every charged call opens a GenAI span and updates the
 *    ledger.
 */

import type { ConcurrencyLimiter } from './concurrency.js';
import { type Budget, CostLedger, estimatePromptCostUsd, type LedgerEntry } from './cost.js';
import {
  BudgetExceededError,
  CapabilityMismatchError,
  ConfigurationError,
  ProviderError,
  UnknownModelAliasError,
} from './errors.js';
import type { Provider } from './providers/base.js';
import {
  ATTRIBUTES,
  type LlmSpanOptions,
  llmSpan,
  recordCost,
  recordUsage,
  withLlmSpan,
} from './tracing.js';
import {
  type Capability,
  type CompletionRequest,
  type CompletionResponse,
  type FinishReason,
  GenerationResult,
  type ModelSpec,
  PinnedModel,
  TokenUsage,
} from './types.js';

/** Called after every successfully charged call. */
export type CallHook = (entry: LedgerEntry) => void;

/** An alias table entry: a bare spec, or one already pinned to an alias. */
export type AliasEntry = ModelSpec | PinnedModel;

export interface ModelGatewayOptions {
  readonly providers: Readonly<Record<string, Provider>>;
  readonly aliases: Readonly<Record<string, AliasEntry>>;
  readonly ledger?: CostLedger;
  readonly budget?: Budget;
  readonly onCall?: readonly CallHook[];
  readonly tracerName?: string;
  /**
   * The application's single limiter, from `deployments.concurrency`.
   *
   * A gateway constructed without one is unbounded, which keeps plain request/response
   * usage free of concurrency surprises. Sharing the instance with the tool executor is
   * what makes "one limiter, not two" true.
   */
  readonly limiter?: ConcurrencyLimiter;
}

/** Resolves aliases to pinned models and executes calls within a budget. */
export class ModelGateway {
  private readonly _providers: ReadonlyMap<string, Provider>;
  private readonly _aliases: ReadonlyMap<string, ModelSpec>;
  private readonly _ledger: CostLedger;
  private readonly _budget: Budget | undefined;
  private readonly _hooks: readonly CallHook[];
  private readonly _tracerName: string;
  private readonly _limiter: ConcurrencyLimiter | undefined;

  constructor(options: ModelGatewayOptions) {
    const providers = new Map(Object.entries(options.providers));
    const aliases = new Map(Object.entries(options.aliases));
    if (providers.size === 0)
      throw new ConfigurationError('the gateway needs at least one provider');
    if (aliases.size === 0) {
      throw new ConfigurationError('the gateway needs at least one pinned alias');
    }

    const resolved = new Map<string, ModelSpec>();
    for (const [alias, value] of aliases) {
      const spec = value instanceof PinnedModel ? value.model : value;
      if (!providers.has(spec.provider)) {
        const known = [...providers.keys()].sort();
        throw new ConfigurationError(
          `alias ${JSON.stringify(alias)} names provider ${JSON.stringify(spec.provider)}, which is not among ${JSON.stringify(known)}`,
        );
      }
      resolved.set(alias, spec);
    }

    this._providers = providers;
    this._aliases = resolved;
    this._ledger = options.ledger ?? new CostLedger();
    this._budget = options.budget;
    this._hooks = options.onCall ?? [];
    this._tracerName = options.tracerName ?? 'aid_runtime';
    this._limiter = options.limiter;
  }

  /** The pinned aliases, sorted. */
  get aliases(): string[] {
    return [...this._aliases.keys()].sort();
  }

  get ledger(): CostLedger {
    return this._ledger;
  }

  get budget(): Budget | undefined {
    return this._budget;
  }

  /** Resolve an alias to its pinned model, or fail loudly. */
  resolve(alias: string): PinnedModel {
    const spec = this._aliases.get(alias);
    if (spec === undefined) throw new UnknownModelAliasError(alias, this.aliases);
    return new PinnedModel({ alias, model: spec });
  }

  /** The adapter that serves `alias`. Raises for an unknown alias. */
  providerFor(alias: string): Provider {
    const provider = this._providers.get(this.resolve(alias).model.provider);
    if (provider === undefined) throw new UnknownModelAliasError(alias, this.aliases);
    return provider;
  }

  /**
   * Assert a pinned model *and* its adapter advertise every capability.
   *
   * Both sides are checked: a model that supports tool calling behind an adapter that
   * does not serialise tool definitions cannot tool-call.
   */
  require(alias: string, capabilities: Iterable<Capability>): PinnedModel {
    const pinned = this.resolve(alias);
    const required = new Set(capabilities);
    const adapter = this._providers.get(pinned.model.provider);
    const missing = new Set<Capability>();
    for (const capability of required) {
      if (!pinned.model.capabilities.has(capability)) missing.add(capability);
      if (adapter === undefined || !adapter.capabilities.has(capability)) missing.add(capability);
    }
    if (missing.size > 0) throw new CapabilityMismatchError(alias, missing);
    return pinned;
  }

  /**
   * Run one call, falling back through `fallbacks` in order.
   *
   * A fallback is only tried for a failure another model could plausibly survive: a
   * provider error or a missing capability. A {@link BudgetExceededError} propagates
   * immediately -- retrying a different model cannot make an exhausted budget
   * affordable.
   */
  async generate(
    alias: string,
    request: CompletionRequest,
    options: { readonly fallbacks?: readonly string[]; readonly budget?: Budget } = {},
  ): Promise<GenerationResult> {
    const chain = [alias, ...(options.fallbacks ?? [])];
    const errors: string[] = [];
    const budget = options.budget ?? this._budget;

    for (const [index, candidate] of chain.entries()) {
      const pinned = this.resolve(candidate);
      try {
        return await this.attempt(pinned, request, budget, chain.slice(0, index + 1));
      } catch (error) {
        if (!(error instanceof ProviderError) && !(error instanceof CapabilityMismatchError)) {
          throw error;
        }
        errors.push(`${candidate}: ${error.message}`);
        if (index === chain.length - 1) {
          throw new ProviderError(
            `every candidate failed (${chain.length} tried): ${errors.join('; ')}`,
          );
        }
      }
    }

    throw new ProviderError(`no candidate produced a response: ${errors.join('; ')}`);
  }

  /**
   * Stream one call as Server-Sent Event `data` frames, accounting exactly like
   * {@link generate}.
   *
   * Each frame is `data: <json>\n\n`: one frame per non-empty text delta, so the first
   * bytes reach the wire before the call completes, then a terminal frame carrying
   * `done`, the finish reason, and the served model and provider. Only a model *and*
   * an adapter advertising `streaming` is served; anything else raises a
   * {@link CapabilityMismatchError} rather than silently buffering.
   *
   * There is no fallback chain: a stream that has already emitted a delta cannot be
   * replayed on another model, so a provider failure propagates to the consumer.
   * Abandoning the iteration closes the provider stream and releases the concurrency
   * slot, and an interrupted call is not charged -- the ledger charges once, on
   * completion, with the same `costUsd` {@link generate} would have recorded.
   */
  async *stream(
    alias: string,
    request: CompletionRequest,
    options: { readonly budget?: Budget } = {},
  ): AsyncGenerator<string, void, undefined> {
    const pinned = this.require(alias, ['streaming']);
    const spec = pinned.model;
    const provider = this._providers.get(spec.provider);
    if (provider === undefined) throw new UnknownModelAliasError(alias, this.aliases);
    const open = provider.stream;
    if (open === undefined) {
      // `require` proved the adapter advertises the capability; advertising it without
      // an implementation is an adapter bug, not a negotiation failure.
      throw new ConfigurationError(
        `provider ${JSON.stringify(provider.name)} advertises streaming but implements no stream`,
      );
    }

    const budget = options.budget ?? this._budget;
    if (budget !== undefined) {
      this._ledger.check(budget);
      this.preflight(pinned, request, budget);
    }

    const spanOptions: LlmSpanOptions = {
      model: spec.name,
      system: spec.provider,
      alias: pinned.alias,
      requestTemperature: request.temperature,
      requestMaxTokens: request.maxOutputTokens,
      tracerName: this._tracerName,
    };
    const span = llmSpan(spanOptions);
    const parts: string[] = [];
    let usage = new TokenUsage();
    let finishReason: FinishReason = 'stop';

    try {
      for await (const chunk of this.streamed(() => open.call(provider, request, spec))) {
        if (chunk.delta.length > 0) {
          parts.push(chunk.delta);
          yield sseFrame({ delta: chunk.delta });
        }
        if (chunk.usage !== undefined) usage = chunk.usage;
        if (chunk.finishReason !== undefined) finishReason = chunk.finishReason;
      }

      const text = parts.join('');
      if (usage.totalTokens === 0) usage = estimateStreamUsage(request, text);
      const cost = spec.cost.costUsd(usage);
      span.recordUsage(usage.inputTokens, usage.outputTokens);
      span.recordCost(cost);
      span.span.setAttribute(ATTRIBUTES.responseModel, spec.name);
      span.span.setAttribute(ATTRIBUTES.responseFinishReasons, [finishReason]);

      const entry = {
        alias: pinned.alias,
        model: spec.name,
        provider: spec.provider,
        usage,
        costUsd: cost,
      };
      this._ledger.charge(budget, entry);
      for (const hook of this._hooks) hook(entry);
    } catch (error) {
      span.recordException(error);
      throw error;
    } finally {
      span.end();
    }

    yield sseFrame({
      done: true,
      finish_reason: finishReason,
      model: spec.name,
      provider: spec.provider,
    });
  }

  async close(): Promise<void> {
    for (const provider of this._providers.values()) {
      await provider.close();
    }
  }

  /**
   * What this request's prompt would cost on top of what is already spent.
   *
   * Public because a routing decision needs the same number the preflight enforces: an
   * agent stepping down a price ladder asks whether the *cheaper* alias fits before
   * switching, and a second estimator would let the two disagree about the same ceiling.
   */
  projectedCostUsd(alias: string, request: CompletionRequest): number {
    const pinned = this.resolve(alias);
    let projected = this._ledger.costUsd;
    for (const message of request.messages) {
      projected += estimatePromptCostUsd(pinned.model, message.content);
    }
    return projected;
  }

  /**
   * Whether this request still fits the budget. A question, never a charge.
   *
   * An unset ceiling always fits -- there is nothing to exceed. An *already* exceeded
   * budget does not fit whatever the prompt, which is what makes a degraded agent stop
   * rather than step down for every remaining step.
   */
  fits(alias: string, request: CompletionRequest, budget: Budget | undefined): boolean {
    if (budget === undefined || budget.maxUsd === undefined) return true;
    if (this._ledger.costUsd > budget.maxUsd) return false;
    return this.projectedCostUsd(alias, request) <= budget.maxUsd;
  }

  private async attempt(
    pinned: PinnedModel,
    request: CompletionRequest,
    budget: Budget | undefined,
    attempted: readonly string[],
  ): Promise<GenerationResult> {
    if (budget !== undefined) {
      this._ledger.check(budget);
      this.preflight(pinned, request, budget);
    }

    const spec = pinned.model;
    const provider = this._providers.get(spec.provider);
    if (provider === undefined) {
      throw new UnknownModelAliasError(pinned.alias, this.aliases);
    }

    const spanOptions: LlmSpanOptions = {
      model: spec.name,
      system: spec.provider,
      alias: pinned.alias,
      requestTemperature: request.temperature,
      requestMaxTokens: request.maxOutputTokens,
      tracerName: this._tracerName,
    };

    const { response, cost } = await this.limit(() =>
      withLlmSpan(spanOptions, async (handle) => {
        const answered = await provider.complete(request, spec);
        const priced = spec.cost.costUsd(answered.usage);
        recordUsage(handle.span, answered.usage.inputTokens, answered.usage.outputTokens);
        recordCost(handle.span, priced);
        handle.span.setAttribute(ATTRIBUTES.responseModel, answered.model);
        handle.span.setAttribute(ATTRIBUTES.responseFinishReasons, [answered.finishReason]);
        if (attempted.length > 1) {
          handle.span.setAttribute(ATTRIBUTES.attempts, [...attempted]);
        }
        return { response: answered, cost: priced };
      }),
    );

    const entry = {
      alias: pinned.alias,
      model: response.model,
      provider: response.provider,
      usage: response.usage,
      costUsd: cost,
    };
    this._ledger.charge(budget, entry);
    for (const hook of this._hooks) hook(entry);

    return new GenerationResult({
      response,
      alias: pinned.alias,
      costUsd: cost,
      attempts: [...attempted],
    });
  }

  /**
   * Acquire the shared concurrency slot around one provider call.
   *
   * The slot wraps the call, not the surrounding bookkeeping, so a cache hit or a
   * refused call never consumes one, and the slot is released on completion and on
   * failure alike.
   */
  private async limit<T>(body: () => Promise<T>): Promise<T> {
    if (this._limiter === undefined) return body();
    return this._limiter.run(body);
  }

  /**
   * Hold the concurrency slot for a whole stream rather than for one await.
   *
   * The slot must span every delta, so the stream owns it from first read to
   * exhaustion, error, or abandonment.
   */
  private streamed<T>(body: () => AsyncIterable<T>): AsyncIterable<T> {
    if (this._limiter === undefined) return body();
    return this._limiter.runStream(body);
  }

  /**
   * Refuse a call whose *prompt* alone already breaches the budget.
   *
   * Only the prompt is priced, and deliberately over-estimated, because the response
   * is unknowable before the call. This catches gross overruns early; the post-call
   * charge is what enforces the ceiling exactly.
   */
  private preflight(pinned: PinnedModel, request: CompletionRequest, budget: Budget): void {
    if (budget.maxUsd === undefined) return;
    const projected = this.projectedCostUsd(pinned.alias, request);
    if (projected > budget.maxUsd) {
      throw new BudgetExceededError(budget.scope, budget.maxUsd, projected);
    }
  }
}

/** Token estimate for a set of strings, at the usual four characters per token. */
export function estimateUsage(texts: string | readonly string[]): TokenUsage {
  const list = typeof texts === 'string' ? [texts] : texts;
  let input = 0;
  for (const text of list) input += (text.length + 3) >> 2;
  return new TokenUsage({ inputTokens: input, outputTokens: 0 });
}

/** Re-exported so callers naming a response type do not reach across modules. */
export type { CompletionResponse };

/**
 * One Server-Sent Event frame.
 *
 * `ensure_ascii` escaping matches Python's `json.dumps`, so a delta containing
 * non-ASCII text produces the same bytes on both runtimes.
 */
function sseFrame(payload: Record<string, unknown>): string {
  const raw = JSON.stringify(payload);
  let escaped = '';
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index);
    escaped +=
      code >= 0x20 && code <= 0x7e ? raw.charAt(index) : `\\u${code.toString(16).padStart(4, '0')}`;
  }
  return `data: ${escaped}\n\n`;
}

/**
 * Token estimate for a stream whose provider reported no usage.
 *
 * Same four-characters-per-token rule as {@link estimateUsage}, with the output
 * counted from the deltas actually served.
 */
function estimateStreamUsage(request: CompletionRequest, text: string): TokenUsage {
  const prompt = estimateUsage(request.messages.map((message) => message.content));
  return new TokenUsage({
    inputTokens: prompt.inputTokens,
    outputTokens: (text.length + 3) >> 2,
  });
}
