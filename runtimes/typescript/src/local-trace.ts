/**
 * A local JSONL trace sink, enabled by `AID_TRACE_DIR`.
 *
 * The OpenTelemetry path is unchanged: with no provider installed the runtime gets a
 * no-op tracer and tracing costs nothing. This module exists for the other case -- the
 * CLI needs trace data on disk without the application installing an exporter, an SDK
 * or a collector. Setting `AID_TRACE_DIR` is that explicit request, and nothing here
 * runs otherwise.
 *
 * It is deliberately not an OpenTelemetry `SpanExporter`: that would require the SDK,
 * and the runtime deliberately depends only on the API so it never decides a host
 * application's telemetry. Instead it mirrors the span surface the runtime uses and
 * writes one JSON line per span.
 *
 * Writing must never fail a request, so every failure to record is swallowed.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Attributes, Span, SpanStatus, TimeInput } from '@opentelemetry/api';

/** The environment variable that turns the sink on. */
export const TRACE_DIR_ENV = 'AID_TRACE_DIR';

interface OpenSpan {
  readonly spanId: string;
  readonly traceId: string;
}

interface LocalEvent {
  readonly name: string;
  readonly at: string;
  readonly attributes: Record<string, unknown>;
}

interface LocalTraceRecord {
  readonly trace_id: string;
  readonly span_id: string;
  readonly parent_span_id: string | null;
  readonly name: string;
  readonly kind: string;
  readonly started_at: string;
  readonly ended_at: string;
  readonly duration_ms: number;
  readonly attributes: Record<string, unknown>;
  readonly events: readonly LocalEvent[];
  readonly status: { readonly code: string; readonly message: string | null } | null;
}

const open = new AsyncLocalStorage<readonly OpenSpan[]>();

let sink: { readonly dir: string; readonly path: string } | undefined;

/** Whether `AID_TRACE_DIR` names a directory to write to. */
export function localTraceEnabled(): boolean {
  return configuredDir() !== '';
}

function configuredDir(): string {
  return process.env[TRACE_DIR_ENV]?.trim() ?? '';
}

/** A timestamp may be a number, a Date or an `HrTime` tuple; only a plain object is attributes. */
function isAttributes(value: unknown): value is Attributes {
  return (
    typeof value === 'object' && value !== null && !(value instanceof Date) && !Array.isArray(value)
  );
}

function now(): string {
  return new Date().toISOString();
}

/** Coerce an attribute value to something `JSON.stringify` always accepts. */
function jsonable(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.map(jsonable);
  return String(value);
}

/**
 * The file for this process, created on first use.
 *
 * Cached per configured directory so one process writes one file, while a test that
 * points `AID_TRACE_DIR` elsewhere still gets a fresh file.
 */
function sinkPath(): string | undefined {
  const dir = configuredDir();
  if (dir === '') return undefined;
  if (sink?.dir === dir) return sink.path;
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // The write below fails too, and `write` swallows it: a lost trace is not a
    // failed request.
  }
  const stamp = new Date().toISOString().replace(/[-:.]/g, '');
  const path = join(dir, `trace-${stamp}-${process.pid}.jsonl`);
  sink = { dir, path };
  return path;
}

function write(record: LocalTraceRecord): void {
  const path = sinkPath();
  if (path === undefined) return;
  try {
    appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
  } catch {
    // Deliberate: see the module comment.
  }
}

/** The name an OTel `SpanStatus` code carries in the JSONL record. */
const STATUS_NAMES: Record<number, string> = { 0: 'UNSET', 1: 'OK', 2: 'ERROR' };

/**
 * A span that mirrors what the runtime does to it, then writes one JSON line.
 *
 * Everything not mirrored delegates to the wrapped span, so code that reaches for a
 * method this class does not know about keeps working and keeps its normal meaning.
 */
class LocalSpan {
  readonly #span: Span;
  #name: string;
  readonly #kind: string;
  readonly #attributes: Record<string, unknown>;
  readonly #events: LocalEvent[] = [];
  #status: LocalTraceRecord['status'] = null;
  readonly #startedAt = now();
  readonly #startedMonoMs = Date.now();
  readonly #traceId: string;
  readonly #spanId: string;
  readonly #parentSpanId: string | null;
  readonly #previous: readonly OpenSpan[];
  #ended = false;

  constructor(span: Span, name: string, kind: string, attributes: Attributes) {
    this.#span = span;
    this.#name = name;
    this.#kind = kind;
    this.#attributes = Object.fromEntries(
      Object.entries(attributes).map(([key, value]) => [key, jsonable(value)]),
    );

    const stack = open.getStore() ?? [];
    const parent = stack.at(-1);
    this.#traceId = parent?.traceId ?? randomBytes(16).toString('hex');
    this.#spanId = randomBytes(8).toString('hex');
    this.#parentSpanId = parent?.spanId ?? null;
    this.#previous = stack;
    open.enterWith([...stack, { spanId: this.#spanId, traceId: this.#traceId }]);
  }

  spanContext(): ReturnType<Span['spanContext']> {
    return this.#span.spanContext();
  }

  setAttribute(key: string, value: unknown): this {
    this.#attributes[key] = jsonable(value);
    this.#span.setAttribute(key, value as Attributes[string]);
    return this;
  }

  setAttributes(attributes: Attributes): this {
    for (const [key, value] of Object.entries(attributes)) this.setAttribute(key, value);
    return this;
  }

  addEvent(
    name: string,
    attributesOrStartTime?: Attributes | TimeInput,
    startTime?: TimeInput,
  ): this {
    const attributes = isAttributes(attributesOrStartTime) ? attributesOrStartTime : undefined;
    this.#events.push({
      name,
      at: now(),
      attributes: Object.fromEntries(
        Object.entries(attributes ?? {}).map(([key, value]) => [key, jsonable(value)]),
      ),
    });
    this.#span.addEvent(name, attributesOrStartTime as Attributes | TimeInput, startTime);
    return this;
  }

  addLink(link: Parameters<Span['addLink']>[0]): this {
    this.#span.addLink(link);
    return this;
  }

  addLinks(links: Parameters<Span['addLinks']>[0]): this {
    this.#span.addLinks(links);
    return this;
  }

  setStatus(status: SpanStatus): this {
    this.#status = {
      code: STATUS_NAMES[status.code] ?? String(status.code),
      message: status.message ?? null,
    };
    this.#span.setStatus(status);
    return this;
  }

  updateName(name: string): this {
    this.#name = name;
    this.#span.updateName(name);
    return this;
  }

  isRecording(): boolean {
    return this.#span.isRecording();
  }

  recordException(exception: Parameters<Span['recordException']>[0], time?: TimeInput): void {
    const asError = exception instanceof Error ? exception : new Error(String(exception));
    this.#events.push({
      name: 'exception',
      at: now(),
      attributes: {
        'exception.type': `${asError.name}`,
        'exception.message': asError.message,
      },
    });
    this.#span.recordException(exception, time);
  }

  end(endTime?: TimeInput): void {
    if (this.#ended) return;
    this.#ended = true;
    const current = open.getStore() ?? [];
    if (current.at(-1)?.spanId === this.#spanId) open.enterWith(this.#previous);
    this.#span.end(endTime);
    write({
      trace_id: this.#traceId,
      span_id: this.#spanId,
      parent_span_id: this.#parentSpanId,
      name: this.#name,
      kind: this.#kind,
      started_at: this.#startedAt,
      ended_at: now(),
      duration_ms: Date.now() - this.#startedMonoMs,
      attributes: this.#attributes,
      events: this.#events,
      status: this.#status,
    });
  }
}

/** Return `span` itself unless a local trace is requested, else a recording proxy. */
export function wrapSpan(
  span: Span,
  options: { readonly name: string; readonly kind: string; readonly attributes?: Attributes },
): Span {
  if (!localTraceEnabled()) return span;
  return new LocalSpan(span, options.name, options.kind, options.attributes ?? {}) as Span;
}
