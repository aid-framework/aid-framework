/**
 * Identifier and vocabulary renderings for the TypeScript target.
 *
 * Every function here is total and deterministic: given the same string it returns the
 * same string, with no locale-sensitive calls and no regex with a backtracking risk.
 * `splitWords` is a single codepoint loop for that reason — the analogous Python helper
 * carries the same note, because a regex over user-controlled spec text is a
 * CodeQL `js/polynomial-redos` finding waiting to happen.
 */

import type { ModelCapability, PrimitiveType } from '@aid/ir';

/**
 * The runtime's `Capability` union, restated locally. The generator depends on
 * `@aid/generator-sdk` and `@aid/ir` only, and a type import from the runtime would
 * add a dependency edge to the emitted-code package for no behavioural gain.
 */
export type Capability =
  | 'tool-calling'
  | 'structured-output'
  | 'streaming'
  | 'long-context'
  | 'embeddings'
  | 'rerank';

/** TypeScript keywords, plus the ones a module name must not collide with. */
const RESERVED = new Set([
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'new',
  'null',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
]);

const ACRONYMS = new Set(['http', 'url', 'id', 'api', 'json', 'llm', 'mcp']);

/** Split on any run of non-alphanumeric characters and on lower-to-upper boundaries. */
export function splitWords(value: string): string[] {
  const words: string[] = [];
  let current = '';
  let previous = '';
  for (const character of value) {
    const isUpper = character >= 'A' && character <= 'Z';
    const previousIsLower = previous >= 'a' && previous <= 'z';
    const alphanumeric =
      (character >= 'a' && character <= 'z') || isUpper || (character >= '0' && character <= '9');
    if (!alphanumeric) {
      if (current.length > 0) words.push(current);
      current = '';
      previous = character;
      continue;
    }
    if (isUpper && previousIsLower && current.length > 0) {
      words.push(current);
      current = character;
    } else {
      current += character;
    }
    previous = character;
  }
  if (current.length > 0) words.push(current);
  return words.map((word) => word.toLowerCase());
}

export function toSnakeCase(value: string): string {
  return splitWords(value).join('_');
}

export function toCamelCase(value: string): string {
  const words = splitWords(value);
  return words.map((word, index) => (index === 0 ? word : capitalise(word))).join('');
}

export function toPascalCase(value: string): string {
  return splitWords(value).map(capitalise).join('');
}

function capitalise(word: string): string {
  if (ACRONYMS.has(word)) return word.toUpperCase();
  return `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
}

/** A module identifier that is not a reserved word. */
export function moduleName(value: string): string {
  const snake = toSnakeCase(value);
  const safe = snake.length === 0 ? 'generated_module' : snake;
  if (safe.length > 0 && safe.charAt(0) >= '0' && safe.charAt(0) <= '9') return `m_${safe}`;
  return RESERVED.has(safe) ? `${safe}_module` : safe;
}

/** A class or type identifier. A digit-leading name is prefixed rather than dropped. */
export function className(value: string): string {
  const pascal = toPascalCase(value);
  const safe = pascal.length === 0 ? 'GeneratedType' : pascal;
  if (safe.length > 0 && safe.charAt(0) >= '0' && safe.charAt(0) <= '9') return `T${safe}`;
  return RESERVED.has(safe) ? `${safe}Type` : safe;
}

/** A property name safe to write unquoted in an object literal or interface. */
export function fieldName(value: string): boolean {
  if (value.length === 0) return false;
  const first = value.charAt(0);
  if (!((first >= 'a' && first <= 'z') || (first >= 'A' && first <= 'Z') || first === '_')) {
    return false;
  }
  for (const character of value) {
    const ok =
      (character >= 'a' && character <= 'z') ||
      (character >= 'A' && character <= 'Z') ||
      (character >= '0' && character <= '9') ||
      character === '_';
    if (!ok) return false;
  }
  return !RESERVED.has(value);
}

/**
 * A single-quoted string literal, which is the house style.
 *
 * The quote character follows the same rule the formatter applies: prefer single
 * quotes, and switch to double quotes when that needs fewer escapes.
 */
export function stringLiteral(value: string): string {
  const single = count(value, "'");
  const double = count(value, '"');
  return single > double ? quote(value, '"') : quote(value, "'");
}

function count(value: string, character: string): number {
  let total = 0;
  for (const candidate of value) if (candidate === character) total += 1;
  return total;
}

function quote(value: string, delimiter: "'" | '"'): string {
  const parts: string[] = [delimiter];
  for (const character of value) {
    if (character === '\\') parts.push('\\\\');
    else if (character === delimiter) parts.push(`\\${delimiter}`);
    else if (character === '\n') parts.push('\\n');
    else if (character === '\r') parts.push('\\r');
    else if (character === '\t') parts.push('\\t');
    else if (character < ' ') {
      parts.push(`\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
    } else parts.push(character);
  }
  parts.push(delimiter);
  return parts.join('');
}

/** An object key, quoted only when it is not a bare identifier. */
export function propertyKey(value: string): string {
  return fieldName(value) ? value : stringLiteral(value);
}

/** A member access that is a bare `.name` whenever the key allows it. */
export function memberAccess(value: string): string {
  return fieldName(value) ? `.${value}` : `[${stringLiteral(value)}]`;
}

/** Render a literal value as TypeScript source. */
export function literal(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return stringLiteral(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'null';
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return `[${value.map(literal).join(', ')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    if (entries.length === 0) return '{}';
    return `{ ${entries.map(([key, item]) => `${propertyKey(key)}: ${literal(item)}`).join(', ')} }`;
  }
  return 'null';
}

/** The zod expression for one primitive type. */
export function zodPrimitive(name: PrimitiveType): string {
  switch (name) {
    case 'string':
      return 'z.string()';
    case 'number':
      return 'z.number()';
    case 'integer':
      return 'z.number().int()';
    case 'boolean':
      return 'z.boolean()';
    default:
      return 'z.unknown()';
  }
}

/** The TypeScript type for one primitive, used by hand-written signatures. */
export function tsPrimitive(name: PrimitiveType): string {
  switch (name) {
    case 'string':
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    default:
      return 'unknown';
  }
}

/**
 * The runtime `Capability` a model capability maps onto, or `undefined` when the
 * runtime cannot express it. `json-schema` maps to `structured-output`, which is the
 * runtime's spelling for the same guarantee.
 */
const MODEL_CAPABILITY_MEMBERS: Readonly<Record<ModelCapability, Capability | undefined>> = {
  'json-schema': 'structured-output',
  'tool-calling': 'tool-calling',
  streaming: 'streaming',
  'long-context': 'long-context',
  embeddings: 'embeddings',
  rerank: 'rerank',
  vision: undefined,
  audio: undefined,
  reasoning: undefined,
  'prompt-cache': undefined,
};

export function modelCapabilityMember(name: ModelCapability): Capability | undefined {
  return MODEL_CAPABILITY_MEMBERS[name];
}

/** Split a model's declared capabilities into what the runtime can be told and what it cannot. */
export function modelCapabilities(declared: readonly ModelCapability[]): {
  advertised: Capability[];
  dropped: ModelCapability[];
} {
  const advertised: Capability[] = [];
  const dropped: ModelCapability[] = [];
  for (const name of declared) {
    const member = modelCapabilityMember(name);
    if (member === undefined) {
      dropped.push(name);
    } else if (!advertised.includes(member)) {
      advertised.push(member);
    }
  }
  return { advertised, dropped };
}

/** The provider adapter class a provider spelling maps onto, or `undefined`. */
export function providerAdapter(
  provider: string,
): 'FakeProvider' | 'OpenAICompatibleProvider' | undefined {
  if (provider === 'fake') return 'FakeProvider';
  if (provider === 'openai' || provider === 'openai-compatible') return 'OpenAICompatibleProvider';
  return undefined;
}

/** Capabilities this target wires to a runtime surface. Kept beside the emitters. */
export const TARGET_WIRED_CAPABILITIES = [
  'http-trigger',
  'json-schema',
  'tool-calling',
  'otel',
  'embeddings',
  'rerank',
] as const;

/** Every alias a pipeline step or prompt can name. */
export function sortStrings(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
