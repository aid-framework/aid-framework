/**
 * Filter expressions over a chunk's identity and metadata.
 *
 * The IR carries `filters` as strings, because both hosted knowledge bases take
 * strings and a structured shape would have to be translated twice. This module
 * pins the grammar the *local* pipeline reads, and pins it narrowly: five
 * comparison operators, ANDed, no boolean algebra, no regular expressions.
 *
 * The restriction is deliberate. A filter is a security boundary -- a tenant or
 * classification selector -- so it must be impossible to express one that
 * silently matches more than it says. Regex would make `*=` a denial-of-service
 * surface and would not port to either hosted engine.
 *
 * A mature library was considered and rejected. JMESPath is the closest fit and
 * exists in both runtimes, but its `!=` on an absent field is true, which is the
 * fail-open behaviour this module exists to prevent, and its grammar is far
 * larger than the five operators documented here.
 *
 * Grammar:
 *
 *     filter  := field op value
 *     op      := "==" | "!=" | "^=" (prefix) | "$=" (suffix) | "*=" (contains)
 *     field   := "doc_id" | "uri" | metadata key
 *     value   := bare token, or "..." / '...' quoted
 *
 * Every entry in the list is ANDed. Evaluation is per chunk: a field the chunk
 * does not carry matches nothing, *including* under `!=` -- absence is not a
 * value, and treating it as one would widen a selector instead of narrowing it.
 */

import { ConfigurationError } from '../errors.js';
import type { Chunk } from './types.js';

/** The operators the grammar admits, in the order a diagnostic lists them. */
export const FILTER_OPERATORS: readonly string[] = ['==', '!=', '^=', '$=', '*='];

const FIELD = '[A-Za-z0-9_.\\-]+';
const OPERATOR = '==|!=|\\^=|\\$=|\\*=';
const EXPRESSION = new RegExp(`^\\s*(${FIELD})\\s*(${OPERATOR})\\s*([\\s\\S]*)`);

/** Fields resolved from the chunk itself, never from `chunk.metadata`. */
const RESERVED_FIELDS: ReadonlySet<string> = new Set(['doc_id', 'uri']);

/** One parsed comparison. `value` is already unquoted. */
export class Filter {
  readonly field: string;
  readonly operator: string;
  readonly value: string;

  constructor(init: { readonly field: string; readonly operator: string; readonly value: string }) {
    this.field = init.field;
    this.operator = init.operator;
    this.value = init.value;
  }
}

/**
 * Parse one expression, or explain precisely what is wrong with it.
 *
 * An unsupported operator is reported against the operator itself rather than as
 * a generic "invalid expression": the five spellings are short enough to list,
 * and a user who wrote `=` instead of `==` should be told so.
 */
export function parseFilter(expression: unknown): Filter {
  if (typeof expression !== 'string') {
    throw new ConfigurationError(`a filter expression must be a string, not ${typeof expression}`);
  }
  const match = EXPRESSION.exec(expression);
  if (match === null) {
    throw new ConfigurationError(
      `filter expression ${JSON.stringify(expression)} is not '<field> <op> <value>'; ` +
        `the operators are ${FILTER_OPERATORS.join(', ')}`,
    );
  }
  const [, field, operator, raw] = match;
  const value = unquote((raw ?? '').trim(), expression);
  if (value === '') {
    throw new ConfigurationError(
      `filter expression ${JSON.stringify(expression)} names field ` +
        `${JSON.stringify(field)} with an empty value`,
    );
  }
  return new Filter({ field: field ?? '', operator: operator ?? '', value });
}

/** Strip one matching pair of quotes, and nothing else. */
function unquote(raw: string, expression: string): string {
  const first = raw.slice(0, 1);
  if (raw.length >= 2 && first === raw.slice(-1) && (first === '"' || first === "'")) {
    return raw.slice(1, -1);
  }
  if (first === '"' || first === "'") {
    throw new ConfigurationError(
      `filter expression ${JSON.stringify(expression)} starts a quoted value but does not ` +
        'close it',
    );
  }
  return raw;
}

/** Parse every expression once, at a point where a mistake is still local. */
export function compileFilters(expressions: readonly string[]): readonly Filter[] {
  return expressions.map((expression) => parseFilter(expression));
}

/**
 * The metadata keys `expressions` read, in declaration order, without repeats.
 *
 * A chunk only carries the metadata `chunking.keepMetadata` names, so a filter on
 * a key that is not kept would match nothing. The binder unions this into
 * `keepMetadata` rather than asking a user to remember the same key twice.
 */
export function metadataFields(expressions: readonly string[]): readonly string[] {
  const fields: string[] = [];
  for (const parsed of compileFilters(expressions)) {
    if (!RESERVED_FIELDS.has(parsed.field) && !fields.includes(parsed.field)) {
      fields.push(parsed.field);
    }
  }
  return fields;
}

/**
 * Whether `chunk` satisfies one comparison.
 *
 * A missing field is a non-match for every operator. `!=` therefore means "this
 * field is present and differs", not "this field is absent or differs".
 */
export function matches(chunk: Chunk, condition: Filter): boolean {
  let actual: string | undefined;
  if (condition.field === 'doc_id') {
    actual = chunk.docId;
  } else if (condition.field === 'uri') {
    actual = chunk.uri;
  } else {
    actual = chunk.metadata[condition.field];
  }
  if (actual === undefined) {
    return false;
  }
  if (condition.operator === '==') {
    return actual === condition.value;
  }
  if (condition.operator === '!=') {
    return actual !== condition.value;
  }
  if (condition.operator === '^=') {
    return actual.startsWith(condition.value);
  }
  if (condition.operator === '$=') {
    return actual.endsWith(condition.value);
  }
  return actual.includes(condition.value);
}

/** Whether `chunk` satisfies every filter. An empty list admits everything. */
export function matchesAll(chunk: Chunk, filters: readonly Filter[]): boolean {
  return filters.every((condition) => matches(chunk, condition));
}
