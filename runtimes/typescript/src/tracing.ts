/**
 * OpenTelemetry GenAI tracing.
 *
 * The attribute spellings are the GenAI semantic conventions, not house names, so a
 * span this runtime emits lands in an existing dashboard without a translation
 * layer. The three `aid.*` attributes are the additions the conventions have no
 * opinion about: which alias was asked for, what it cost, and how many candidates
 * were tried before one answered.
 *
 * The tracer is resolved from the global provider, so an application that never
 * configures one gets a no-op tracer and no cost. That matters: a runtime that
 * demanded a tracer would make tracing a precondition for calling a model.
 */

import { type Attributes, type Span, SpanStatusCode, trace } from '@opentelemetry/api';

/** The operation name the chat completion span carries. */
export const GEN_AI_OPERATION_CHAT = 'chat';

/** Semantic-convention attribute names, keyed by the option that sets them. */
export const ATTRIBUTES = {
  system: 'gen_ai.system',
  operation: 'gen_ai.operation.name',
  requestModel: 'gen_ai.request.model',
  requestTemperature: 'gen_ai.request.temperature',
  requestMaxTokens: 'gen_ai.request.max_tokens',
  responseModel: 'gen_ai.response.model',
  responseFinishReasons: 'gen_ai.response.finish_reasons',
  inputTokens: 'gen_ai.usage.input_tokens',
  outputTokens: 'gen_ai.usage.output_tokens',
  alias: 'aid.model.alias',
  costUsd: 'aid.cost.usd',
  attempts: 'aid.gateway.attempts',
  toolNames: 'aid.tool.names',
} as const;

/** Everything a chat span may record. Unset members are omitted entirely. */
export interface LlmSpanOptions {
  readonly operation?: string;
  readonly model: string;
  readonly system?: string;
  readonly requestTemperature?: number;
  readonly requestMaxTokens?: number;
  readonly responseModel?: string;
  readonly responseFinishReasons?: readonly string[];
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly alias?: string;
  readonly costUsd?: number;
  readonly attempts?: number;
  readonly toolNames?: readonly string[];
  readonly tracerName?: string;
}

/** The default tracer name, matching the reference runtime. */
export const DEFAULT_TRACER_NAME = 'aid_runtime';

/** Resolve a tracer from the global provider. */
export function getTracer(name = DEFAULT_TRACER_NAME): ReturnType<typeof trace.getTracer> {
  return trace.getTracer(name);
}

/**
 * Turn span options into OTel attributes.
 *
 * An unset option contributes no key at all rather than a defaulted zero: a span
 * that reports `gen_ai.usage.input_tokens = 0` for a call whose usage was never
 * measured is a lie a dashboard will happily average.
 */
export function spanAttributes(options: LlmSpanOptions): Attributes {
  const attributes: Record<string, string | number | string[]> = {};
  const operation = options.operation ?? GEN_AI_OPERATION_CHAT;
  attributes[ATTRIBUTES.operation] = operation;
  attributes[ATTRIBUTES.requestModel] = options.model;
  if (options.system !== undefined) attributes[ATTRIBUTES.system] = options.system;
  if (options.requestTemperature !== undefined) {
    attributes[ATTRIBUTES.requestTemperature] = options.requestTemperature;
  }
  if (options.requestMaxTokens !== undefined) {
    attributes[ATTRIBUTES.requestMaxTokens] = options.requestMaxTokens;
  }
  if (options.responseModel !== undefined) {
    attributes[ATTRIBUTES.responseModel] = options.responseModel;
  }
  if (options.responseFinishReasons !== undefined) {
    attributes[ATTRIBUTES.responseFinishReasons] = [...options.responseFinishReasons];
  }
  if (options.inputTokens !== undefined) attributes[ATTRIBUTES.inputTokens] = options.inputTokens;
  if (options.outputTokens !== undefined)
    attributes[ATTRIBUTES.outputTokens] = options.outputTokens;
  if (options.alias !== undefined) attributes[ATTRIBUTES.alias] = options.alias;
  if (options.costUsd !== undefined) attributes[ATTRIBUTES.costUsd] = options.costUsd;
  if (options.attempts !== undefined) attributes[ATTRIBUTES.attempts] = options.attempts;
  if (options.toolNames !== undefined) attributes[ATTRIBUTES.toolNames] = [...options.toolNames];
  return attributes;
}

/** The name a chat span carries: `"{operation} {model}"`. */
export function spanName(options: LlmSpanOptions): string {
  return `${options.operation ?? GEN_AI_OPERATION_CHAT} ${options.model}`;
}

/** A started chat span plus the operations that end it. */
export interface LlmSpanHandle {
  readonly span: Span;
  /** Record usage on an already-started span. */
  recordUsage(inputTokens: number, outputTokens: number): void;
  /** Record cost. Does not touch the alias attribute. */
  recordCost(costUsd: number): void;
  /** Record an exception once, and mark the span failed. */
  recordException(error: unknown): void;
  /** End the span. Idempotent. */
  end(): void;
}

/** Start a chat span with the standard attributes applied. */
export function llmSpan(options: LlmSpanOptions): LlmSpanHandle {
  const tracer = getTracer(options.tracerName ?? DEFAULT_TRACER_NAME);
  const span = tracer.startSpan(spanName(options), { attributes: spanAttributes(options) });
  let ended = false;
  return {
    span,
    recordUsage(inputTokens, outputTokens) {
      span.setAttribute(ATTRIBUTES.inputTokens, inputTokens);
      span.setAttribute(ATTRIBUTES.outputTokens, outputTokens);
    },
    recordCost(costUsd) {
      span.setAttribute(ATTRIBUTES.costUsd, costUsd);
    },
    recordException(error) {
      recordException(span, error);
    },
    end() {
      if (ended) return;
      ended = true;
      span.end();
    },
  };
}

/**
 * Run `body` inside a chat span, recording an exception and marking it failed on
 * throw.
 *
 * Automatic exception recording is off (`record_exception: false` /
 * `set_status_on_exception: false` in the reference runtime) so the exception is
 * recorded exactly once, by this function, rather than once by the SDK and once by
 * the caller's wrapper.
 */
export async function withLlmSpan<T>(
  options: LlmSpanOptions,
  body: (handle: LlmSpanHandle) => Promise<T>,
): Promise<T> {
  const handle = llmSpan(options);
  try {
    return await body(handle);
  } catch (error) {
    handle.recordException(error);
    throw error;
  } finally {
    handle.end();
  }
}

/** Record usage on an existing span. */
export function recordUsage(span: Span, inputTokens: number, outputTokens: number): void {
  span.setAttribute(ATTRIBUTES.inputTokens, inputTokens);
  span.setAttribute(ATTRIBUTES.outputTokens, outputTokens);
}

/** Record cost on an existing span. Deliberately leaves the alias attribute alone. */
export function recordCost(span: Span, costUsd: number): void {
  span.setAttribute(ATTRIBUTES.costUsd, costUsd);
}

/**
 * Record an exception once and mark the span failed.
 *
 * `error` is `unknown` because a caught value in TypeScript is not guaranteed to be
 * an `Error`, and a runtime that assumed otherwise would throw while reporting a
 * failure.
 */
export function recordException(span: Span, error: unknown): void {
  const asError =
    error instanceof Error ? error : new Error(typeof error === 'string' ? error : String(error));
  span.recordException(asError);
  span.setStatus({ code: SpanStatusCode.ERROR, message: asError.message });
}

/** Build an attribute bag from arbitrary named values, passing unknown keys through. */
export function aidAttributes(values: Readonly<Record<string, string | number | boolean>>): {
  [key: string]: string | number | boolean;
} {
  return { ...values };
}
