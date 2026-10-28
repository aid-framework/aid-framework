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

/**
 * A policy could not be evaluated to a boolean.
 *
 * Separate from {@link PipelineError} because it is raised from the evaluator, not from
 * a step's wiring: an unknown builtin or a non-boolean operand is a malformed policy,
 * and for a human-in-the-loop gate "could not decide" must never degrade into "do not
 * ask".
 */
export class PolicyEvaluationError extends AidRuntimeError {}

/**
 * A guardrail stopped the run before (or after) the guarded effect.
 *
 * Raised by the `block` action, and by any guardrail the engine cannot evaluate. An
 * undecidable policy is a block, never an allow: the failure mode this class exists to
 * prevent is a check that quietly returns "no violation" because its input did not
 * match what it expected.
 */
export class GuardrailBlockedError extends AidRuntimeError {
  readonly guardrail: string;
  readonly stage: string;
  readonly reason: string;

  constructor(guardrail: string, stage: string, reason: string) {
    super(`guardrail ${repr(guardrail)} blocked the ${stage} stage: ${reason}`);
    this.guardrail = guardrail;
    this.stage = stage;
    this.reason = reason;
  }
}

/**
 * An agent asked for a tool it was not granted, or one its auth policy denies.
 *
 * Raised before the handler body runs. The check is deliberately not a tool result: a
 * model can repair a bad argument, but it cannot repair a missing grant, so the caller
 * is the party that has to fix this.
 */
export class ToolPermissionError extends AidRuntimeError {
  readonly agent: string;
  readonly tool: string;
  readonly reason: string;

  constructor(agent: string, tool: string, reason: string) {
    super(`agent ${repr(agent)} may not call tool ${repr(tool)}: ${reason}`);
    this.agent = agent;
    this.tool = tool;
    this.reason = reason;
  }
}

/**
 * A transfer chain revisited an agent that already held control.
 *
 * `agents/handoff-cycles` rejects this at build time; the runtime refuses it again
 * rather than trusting that every caller came through the gate.
 */
export class AgentTransferCycleError extends AidRuntimeError {
  readonly path: readonly string[];

  constructor(path: readonly string[]) {
    super(`transfer cycle: ${path.join(' -> ')}`);
    this.path = [...path];
  }
}

/**
 * A budget was crossed and there is no cheaper alias left to route to.
 *
 * `ir/agents-budget-degrade` rejects this at build time for declared specs; this is
 * the run-time counterpart for a hand-built IR.
 */
export class AgentBudgetDegradedError extends AidRuntimeError {}

/**
 * An agent asked for `handoffs` on an engine that has no transfer primitive.
 *
 * Deep Agents has `subagents` -- delegation that *returns* -- and no transfer: control
 * never moves, the caller always resumes and always authors the final answer. Emulating
 * transfer with a delegate would change who answers, so the engine refuses instead of
 * silently degrading `handoffs` into a delegate.
 */
/**
 * `['a', 'b']`, the shape Python's `{list(...)}` puts in a message. `repr` from
 * `internal/json` quotes one string; a diagnostic that names a set of targets needs the
 * bracket as well.
 */
function listRepr(values: readonly string[]): string {
  return `[${values.map((value) => repr(value)).join(', ')}]`;
}

export class AgentHandoffUnsupportedError extends AidRuntimeError {
  readonly agent: string;
  readonly targets: readonly string[];
  readonly engine: string;

  constructor(agent: string, targets: readonly string[], engine: string) {
    super(
      `agent ${repr(agent)} declares handoffs ${listRepr([...targets])} but runs on the ` +
        `${repr(engine)} engine, which has no transfer primitive; transfer is native-only, ` +
        'and delegation (delegates) is the deepagents equivalent',
    );
    this.agent = agent;
    this.targets = [...targets];
    this.engine = engine;
  }
}

/** Base for the refusals that belong to the optional `deepagents` backend. */
export class DeepAgentsEngineError extends AidRuntimeError {}

/**
 * `engineVersion` does not match the release this runtime is pinned to.
 *
 * The mismatch fires in both directions -- a declared version this runtime is not built
 * for, and a runtime that cannot find the declaration at all.
 */
export class DeepAgentsVersionMismatchError extends DeepAgentsEngineError {
  readonly agent: string;
  readonly declared: string;
  readonly pinned: string;

  constructor(agent: string, declared: string, pinned: string) {
    const detail =
      declared === ''
        ? 'the IR declares no engineVersion'
        : `the IR declares engineVersion ${repr(declared)}`;
    super(
      `agent ${repr(agent)}: ${detail}, but this runtime is pinned to deepagents==${pinned}; ` +
        `set engineVersion to ${repr(pinned)} or install the runtime that matches`,
    );
    this.agent = agent;
    this.declared = declared;
    this.pinned = pinned;
  }
}

/**
 * The `deepagents` optional extra is not installed.
 *
 * A named error rather than an import failure because the fix is an install
 * instruction the caller can act on, and because an agent silently falling back to the
 * native loop would leave `engine` in the IR meaning nothing.
 */
export class DeepAgentsUnavailableError extends DeepAgentsEngineError {
  readonly extra: string;
  readonly distribution: string;

  constructor(extra: string, distribution: string) {
    super(
      "this agent runs on the 'deepagents' engine, but the " +
        `${repr(distribution)} package is not installed; install the extra with: ` +
        `pip install '${extra}'`,
    );
    this.extra = extra;
    this.distribution = distribution;
  }
}

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
