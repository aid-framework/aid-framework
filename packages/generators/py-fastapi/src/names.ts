/**
 * Naming and vocabulary mapping for the py-fastapi target, as pure functions.
 *
 * Every decision here is a pure string or enum decision with no I/O, which is the
 * only reason the *shape* of the generated tree can be asserted by unit tests
 * rather than by regenerating it and looking at the result.
 *
 * The case conversions are single-pass character loops and deliberately not
 * regular expressions. A pattern such as `/\W+$/` is quadratic on adversarial
 * input (CodeQL `js/polynomial-redos`, `security_severity_level: high`), and layer 3
 * shipped three HIGH alerts from exactly that shape; the SDK's own
 * `stripTrailingSlashes` is an O(N) backward loop for the same reason.
 */

import type { TypeRef } from '@aid/ir';

/**
 * Names a source file cannot use as an identifier. A module named `import` is a
 * syntax error, so it is suffixed rather than silently renamed.
 */
const PYTHON_KEYWORDS: ReadonlySet<string> = new Set([
  'False',
  'None',
  'True',
  'and',
  'as',
  'assert',
  'async',
  'await',
  'break',
  'class',
  'continue',
  'def',
  'del',
  'elif',
  'else',
  'except',
  'finally',
  'for',
  'from',
  'global',
  'if',
  'import',
  'in',
  'is',
  'lambda',
  'nonlocal',
  'not',
  'or',
  'pass',
  'raise',
  'return',
  'try',
  'while',
  'with',
  'yield',
]);

/**
 * Split an arbitrary identifier into lowercase words in one pass.
 *
 * `lookup_customer` -> `[lookup, customer]`, `ticketId` -> `[ticket, id]`,
 * `HTTPStatus` -> `[httpstatus]`. The last case is a known imperfection: splitting
 * an acronym run needs lookahead, and a generator that renames `HTTPStatus` is
 * worse than one that keeps it intact.
 */
export function splitWords(value: string): string[] {
  const words: string[] = [];
  let current = '';
  let previousWasLower = false;

  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    const isUpper = code >= 65 && code <= 90;
    const isLower = code >= 97 && code <= 122;
    const isDigit = code >= 48 && code <= 57;

    if (isUpper && current !== '' && previousWasLower) {
      words.push(current);
      current = '';
    }
    if (isLower) {
      current += char;
    } else if (isUpper) {
      current += char.toLowerCase();
    } else if (isDigit) {
      current += char;
    } else if (current !== '') {
      words.push(current);
      current = '';
    }
    previousWasLower = isLower || isDigit;
  }

  if (current !== '') words.push(current);
  return words;
}

export function toSnakeCase(value: string): string {
  return splitWords(value).join('_');
}

export function toPascalCase(value: string): string {
  return splitWords(value)
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join('');
}

function startsWithDigit(value: string): boolean {
  const code = value.charCodeAt(0);
  return code >= 48 && code <= 57;
}

function guardKeyword(value: string): string {
  return PYTHON_KEYWORDS.has(value) ? `${value}_` : value;
}

/** A module name: snake_case, a legal identifier, never a keyword. */
export function moduleName(id: string): string {
  const base = toSnakeCase(id);
  return base === '' ? 'module' : guardKeyword(base);
}

/** A class name: PascalCase, never starting with a digit. */
export function className(id: string): string {
  const base = toPascalCase(id);
  if (base === '') return 'Model';
  return startsWithDigit(base) ? `M${base}` : base;
}

/** A field or parameter name: snake_case, a legal identifier, never a keyword. */
export function fieldName(id: string): string {
  const base = toSnakeCase(id);
  if (base === '') return 'field';
  const prefixed = startsWithDigit(base) ? `_${base}` : base;
  return guardKeyword(prefixed);
}

/** A module-level constant name: SCREAMING_SNAKE_CASE. */
export function constantName(id: string): string {
  const base = toSnakeCase(id).toUpperCase();
  if (base === '') return 'CONSTANT';
  return startsWithDigit(base) ? `_${base}` : base;
}

/** Whether `value` is a legal, non-keyword Python identifier. */
export function isUsableIdentifier(value: string): boolean {
  if (value === '' || PYTHON_KEYWORDS.has(value)) return false;
  if (startsWithDigit(value)) return false;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    const isUpper = code >= 65 && code <= 90;
    const isLower = code >= 97 && code <= 122;
    const isDigit = code >= 48 && code <= 57;
    if (!(isUpper || isLower || isDigit) && char !== '_') return false;
  }
  return true;
}

const PRIMITIVE_ANNOTATIONS: Readonly<Record<string, string>> = {
  string: 'str',
  number: 'float',
  integer: 'int',
  boolean: 'bool',
};

/** The Python annotation for a primitive IR type. `Any` for an unknown spelling. */
export function primitiveAnnotation(name: string): string {
  return PRIMITIVE_ANNOTATIONS[name] ?? 'Any';
}

/**
 * The Python annotation for a resolved `TypeRef`.
 *
 * A named ref becomes the declared class. An unresolved ref cannot be annotated
 * at all -- emitting the name would produce an import-time `NameError` in the
 * generated app -- so the caller rejects it before the plan is built, and `Any`
 * here is only the transport that keeps a rejected plan from yielding broken
 * Python.
 */
export function annotationFor(ref: TypeRef, optional: boolean): string {
  const base = ref.kind === 'primitive' ? primitiveAnnotation(ref.name) : className(ref.name);
  const shaped = ref.list ? `list[${base}]` : base;
  return optional ? `${shaped} | None` : shaped;
}

/**
 * The model name a declared reranker resolves to.
 *
 * The runtime's `reranker_for` matches the name it is handed, not the spec's alias, so
 * the resolution happens exactly once here and both the emitted binding and the
 * validator that refuses a name the runtime cannot honour read the same answer. A name
 * that is not the alias of a declared model is already the model name.
 */
/**
 * The IR's model capability vocabulary mapped onto the runtime's `Capability`
 * enum.
 *
 * The two vocabularies are deliberately different sizes: `@aid/ir` says what a model
 * supports (`vision`, `audio`, `rerank`, ...) and the runtime names only what it can
 * act on. A declared capability with no counterpart is therefore not an error -- the
 * pinned spec advertises the intersection -- but it is *recorded* rather than
 * silently forgotten, because a pinned model that advertises less than the IR
 * declares would make every later capability negotiation quietly wrong.
 */
const MODEL_CAPABILITY_MEMBERS: Readonly<Record<string, string>> = {
  'json-schema': 'Capability.STRUCTURED_OUTPUT',
  'tool-calling': 'Capability.TOOL_CALLING',
  'long-context': 'Capability.LONG_CONTEXT',
  embeddings: 'Capability.EMBEDDINGS',
  streaming: 'Capability.STREAMING',
};

/**
 * Target capabilities the emitted wiring itself satisfies, and the wiring that does it.
 *
 * `embeddings` and `rerank` are here for the same reason `http-trigger` is: they are
 * promises about what *this target emits*. `embeddings` is also a model-side capability
 * -- an embedding model advertises `Capability.EMBEDDINGS` -- but the retriever that
 * consumes it is wired by the generated bindings module and the generated `retrieve`
 * step, and a target that stopped emitting them would have to stop declaring it.
 * `rerank` is target-side only: the runtime names `Capability.RERANK`, but no provider
 * serves reranking in Phase 1 -- the one reranker is the runtime's own `LexicalReranker`
 * -- so a model that declares it is recorded as unrepresentable rather than advertised.
 *
 * `streaming` and `guardrails` are here because both are promises about generated code
 * rather than about a model: `streaming` is the `Accept: text/event-stream` branch the
 * route emitter writes, and `guardrails` is the `GuardrailEngine` call the generate
 * step and the tool adapter emit. `streaming` is *also* a model-side capability -- the
 * runtime's `ModelGateway.stream` requires `Capability.STREAMING` on the pinned spec
 * and on the adapter -- which is why it appears in both tables. The two are independent
 * on purpose: a capability can be satisfied model-side, target-side, or (the D-1 shape)
 * neither.
 */
export const TARGET_WIRED_CAPABILITIES: Readonly<Record<string, string>> = {
  'http-trigger': 'the FastAPI route generated in app/generated/app.py',
  'json-schema': 'the Pydantic models generated in app/generated/schemas.py',
  otel: "the runtime's tracer, named by the generated entrypoint",
  embeddings: 'the retriever bindings generated in app/generated/retrieval/bindings.py',
  rerank: 'the reranker each generated binding resolves through the runtime',
  streaming:
    'the `Accept: text/event-stream` branch of each generated route, which returns ' +
    'StreamingResponse over the runtime gateway',
  guardrails:
    'the generated guardrail module and the GuardrailEngine calls the generate step, ' +
    'the tool adapter and the retriever bindings emit',
  agents:
    'the agent runtime and router generated in app/generated/agents.py, which ' +
    'AgentRuntime.from_ir resolves from the emitted document',
  'cursor-memory':
    'the memory tiers in the emitted document, served by the runtime memory store the ' +
    'agent runtime is built over',
};

/** A target-capability declaration read three ways, so no promise goes unaccounted for. */
export interface CapabilityReport {
  /** Every declared capability, deduplicated and sorted. */
  readonly declared: string[];
  /** `Capability` member expressions the declaration lands in, sorted. */
  readonly modelWired: string[];
  /** Capability names satisfied by generated wiring, sorted. */
  readonly targetWired: string[];
  /** Capability names Phase 0 wires nowhere, sorted; empty for this generator. */
  readonly unwired: string[];
}

export function capabilityReport(capabilities: readonly string[]): CapabilityReport {
  const declared = [...new Set(capabilities)].sort();
  const modelWired = new Set<string>();
  const targetWired = new Set<string>();
  const unwired = new Set<string>();
  for (const capability of declared) {
    const member = MODEL_CAPABILITY_MEMBERS[capability];
    const target = TARGET_WIRED_CAPABILITIES[capability];
    if (member !== undefined) modelWired.add(member);
    if (target !== undefined) targetWired.add(capability);
    if (member === undefined && target === undefined) unwired.add(capability);
  }
  return {
    declared,
    modelWired: [...modelWired].sort(),
    targetWired: [...targetWired].sort(),
    unwired: [...unwired].sort(),
  };
}

export type ProviderAdapter = 'OpenAICompatibleProvider' | 'FakeProvider';

/** What each provider adapter can do at all, as `Capability` member expressions. */
export const ADAPTER_CAPABILITIES: Readonly<Record<ProviderAdapter, readonly string[]>> = {
  FakeProvider: [
    'Capability.EMBEDDINGS',
    'Capability.LONG_CONTEXT',
    'Capability.STREAMING',
    'Capability.STRUCTURED_OUTPUT',
    'Capability.TOOL_CALLING',
  ],
  OpenAICompatibleProvider: [
    'Capability.EMBEDDINGS',
    'Capability.STREAMING',
    'Capability.STRUCTURED_OUTPUT',
    'Capability.TOOL_CALLING',
  ],
};

/** What a pinned model advertises, and which declared capabilities that left out. */
export interface ModelCapabilities {
  /** `Capability` member expressions, deduplicated and sorted for stable output. */
  readonly advertised: string[];
  /** Declared capability names neither the runtime nor the adapter can express. */
  readonly dropped: string[];
}

export function modelCapabilities(
  adapter: ProviderAdapter,
  declared: readonly string[],
): ModelCapabilities {
  const supported = new Set(ADAPTER_CAPABILITIES[adapter]);
  const advertised = new Set<string>();
  const dropped = new Set<string>();
  for (const capability of declared ?? []) {
    const member = MODEL_CAPABILITY_MEMBERS[capability];
    if (member === undefined || !supported.has(member)) dropped.add(capability);
    else advertised.add(member);
  }
  return { advertised: [...advertised].sort(), dropped: [...dropped].sort() };
}

/**
 * The provider adapter for an IR provider, or `undefined` when Phase 0 ships none.
 *
 * Provider breadth is a ratified deferral, so an adapter is never guessed: a spec
 * asking for `anthropic` fails the plan with a readable message instead of
 * emitting an app that cannot start.
 */
export function providerAdapter(provider: string): ProviderAdapter | undefined {
  if (provider === 'fake') return 'FakeProvider';
  if (provider === 'openai' || provider === 'openai-compatible') {
    return 'OpenAICompatibleProvider';
  }
  return undefined;
}
