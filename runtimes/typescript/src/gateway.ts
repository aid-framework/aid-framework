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
  FeatureDeferredError,
  ProviderError,
  UnknownModelAliasError,
} from './errors.js';
import type { Provider } from './providers/base.js';
import {
  ATTRIBUTES,
  type LlmSpanOptions,
  recordCost,
  recordUsage,
  withLlmSpan,
} from './tracing.js';
import {
  type Capability,
  type CompletionRequest,
  type CompletionResponse,
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

  /** Declared but not implemented; see the module docstring. */
  async stream(_alias: string, _request: CompletionRequest): Promise<never> {
    throw new FeatureDeferredError(
      'streaming is a declared capability, not an implemented one; ' +
        'Phase 0 serves request/response only',
    );
  }

  async close(): Promise<void> {
    for (const provider of this._providers.values()) {
      await provider.close();
    }
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
   * Refuse a call whose *prompt* alone already breaches the budget.
   *
   * Only the prompt is priced, and deliberately over-estimated, because the response
   * is unknowable before the call. This catches gross overruns early; the post-call
   * charge is what enforces the ceiling exactly.
   */
  private preflight(pinned: PinnedModel, request: CompletionRequest, budget: Budget): void {
    if (budget.maxUsd === undefined) return;
    let projected = this._ledger.costUsd;
    for (const message of request.messages) {
      projected += estimatePromptCostUsd(pinned.model, message.content);
    }
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
