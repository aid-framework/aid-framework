/**
 * Error hierarchy for the AID TypeScript runtime.
 *
 * Every error this library raises derives from {@link AidRuntimeError}, so an
 * application can distinguish "the framework refused to proceed" from "the network
 * was flaky" with a single `instanceof` check.
 */

import { repr } from './internal/json.js';

/** Base class for every error raised by this library. */
export class AidRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The runtime was configured with something it cannot use. */
export class ConfigurationError extends AidRuntimeError {}

/**
 * An alias was requested that the gateway has no pinned model for.
 *
 * Model pinning means the alias table is closed: an unknown alias is a
 * configuration error, never a silent pass-through to a provider default.
 */
export class UnknownModelAliasError extends ConfigurationError {
  readonly alias: string;
  readonly known: readonly string[];

  constructor(alias: string, known: Iterable<string>) {
    const sorted = [...known].sort();
    const listed = sorted.join(', ') || '<none>';
    super(`unknown model alias ${repr(alias)}; pinned aliases: ${listed}`);
    this.alias = alias;
    this.known = sorted;
  }
}

/** A pinned model does not declare a capability the caller requires. */
export class CapabilityMismatchError extends ConfigurationError {
  readonly alias: string;
  readonly missing: readonly string[];

  constructor(alias: string, missing: Iterable<string>) {
    const sorted = [...missing].sort();
    super(`model alias ${repr(alias)} does not support: ${sorted.join(', ')}`);
    this.alias = alias;
    this.missing = sorted;
  }
}

/**
 * A cost or token budget was crossed.
 *
 * Raised after a call is charged, so the ledger it reports has already recorded
 * the spend that crossed the line: a caller that catches this still sees truthful
 * accounting rather than a pre-call estimate.
 */
export class BudgetExceededError extends AidRuntimeError {
  readonly scope: string;
  readonly limit: number;
  readonly spent: number;
  readonly unit: string;

  constructor(scope: string, limit: number, spent: number, unit = 'usd') {
    const asUsd = unit === 'usd';
    const format = (value: number): string =>
      asUsd ? `$${value.toFixed(6)}` : `${value.toFixed(0)} ${unit}`;
    super(
      `budget ${repr(scope)} exceeded: limit ${format(limit)}, spent ${format(spent)} ` +
        `(over by ${format(spent - limit)})`,
    );
    this.scope = scope;
    this.limit = limit;
    this.spent = spent;
    this.unit = unit;
  }
}

/**
 * A capability is declared for the IR contract but not implemented yet.
 *
 * Streaming is the motivating case: the runtime is request/response only, no target
 * declares the `streaming` capability, and this error is what `stream()` raises
 * instead of returning a silently non-streaming "stream". Phase 2 layer L5 implements
 * streaming and restores the declaration.
 */
export class FeatureDeferredError extends AidRuntimeError {}

/** A provider call failed after exhausting retries. */
export class ProviderError extends AidRuntimeError {}

/** The provider answered with a body we could not interpret. */
export class ProviderResponseError extends ProviderError {
  readonly body: string | undefined;

  constructor(message: string, body?: string) {
    super(body === undefined ? message : `${message}: ${body.slice(0, 500)}`);
    this.body = body;
  }
}

/** No prompt is registered under the requested name and version. */
export class PromptNotFoundError extends AidRuntimeError {
  readonly promptName: string;
  readonly version: string | undefined;

  constructor(name: string, version: string | undefined, known: Iterable<string>) {
    const suffix = version === undefined ? ' (latest)' : ` version ${repr(version)}`;
    const listed = [...known].sort().join(', ') || '<none>';
    super(`no prompt ${repr(name)}${suffix}; registered: ${listed}`);
    this.promptName = name;
    this.version = version;
  }
}

/** A prompt template could not be rendered from the supplied variables. */
export class PromptRenderError extends AidRuntimeError {}

/** A model response could not be coerced into the requested output type. */
export class StructuredOutputError extends AidRuntimeError {
  readonly attempts: number;
  readonly problems: readonly string[];

  constructor(
    message: string,
    options: { readonly attempts: number; readonly problems?: readonly string[] },
  ) {
    const problems = options.problems ?? [];
    let detail = ` after ${options.attempts} attempt(s)`;
    if (problems.length > 0) detail += `: ${problems.join('; ')}`;
    super(message + detail);
    this.attempts = options.attempts;
    this.problems = [...problems];
  }
}

/** A tool call named a tool the executor does not have. */
export class ToolNotFoundError extends AidRuntimeError {
  readonly toolName: string;

  constructor(name: string, known: Iterable<string>) {
    const listed = [...known].sort().join(', ') || '<none>';
    super(`unknown tool ${repr(name)}; registered: ${listed}`);
    this.toolName = name;
  }
}

/** Tool call arguments failed schema validation. */
export class ToolArgumentError extends AidRuntimeError {
  readonly tool: string;
  readonly problems: readonly string[];

  constructor(tool: string, problems: readonly string[]) {
    super(`invalid arguments for tool ${repr(tool)}: ${problems.join('; ')}`);
    this.tool = tool;
    this.problems = [...problems];
  }
}

/** A tool handler threw. */
export class ToolExecutionError extends AidRuntimeError {}

/** A pipeline step failed or the pipeline was wired incorrectly. */
export class PipelineError extends AidRuntimeError {}

/** An eval run could not be completed. */
// biome-ignore lint/suspicious/noShadowRestrictedNames: the framework's own error name, matching the Python runtime's public surface
export class EvalError extends AidRuntimeError {}

/**
 * The gate was configured in a way that cannot be trusted as a CI signal.
 *
 * The load-bearing case: a threshold that references a metric whose result is
 * itself produced by a model. Gating on one source of non-determinism using
 * another is not a gate.
 */
export class GateConfigurationError extends EvalError {}
