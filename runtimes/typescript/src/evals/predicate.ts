/**
 * The PredicateExpr evaluator an `assert` metric runs.
 *
 * The AST is data, not code: the IR parses and validates it, the generator emits it
 * as a plain object literal, and this module walks it. There is no `eval` and no
 * `new Function` anywhere on that path, so a predicate can only ever do what this
 * file implements -- read the prediction, the case id and one metadata key, call
 * four total string builtins, and compare. Anything else is a node kind this walker
 * does not know, and an unknown node throws rather than passing.
 *
 * Throwing matters more than it looks. A false assertion and an *undecidable* one
 * are different outcomes: `false` is a legitimate result the gate must see, while a
 * missing metadata key or a string where a number belongs means the eval itself is
 * misconfigured. Returning `false` for either would report a broken eval as a
 * failing candidate, and returning `true` would hide it, so both throw `EvalError`.
 *
 * Both sides of `and`/`or` are always evaluated. Short-circuiting would let
 * `case.metadata.missing == "x" or true` pass silently, which is the one failure
 * mode this whole design exists to prevent.
 */

// biome-ignore lint/suspicious/noShadowRestrictedNames: the framework's own error name, matching the Python runtime's public surface
import { EvalError } from '../errors.js';
import type { EvalCase } from './dataset.js';

/**
 * A value a predicate can carry.
 *
 * Numbers are a single `number` here; Python normalizes its `int` and `float` to
 * `float` so a JSON literal `3` and `length(...)` compare equal in both. Booleans
 * are kept apart from numbers on purpose, because `1 == true` is false here and a
 * grammar that answered differently in each language would be worse than no grammar.
 */
export type PredicateValue = boolean | number | string;

/** The node shapes the IR emits. Structural, because the runtime owns no IR types. */
export type PredicateNode =
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'invalid'; readonly reason: string }
  | { readonly kind: 'path'; readonly path: string; readonly name?: string }
  | { readonly kind: 'call'; readonly name: string; readonly args: readonly PredicateNode[] }
  | {
      readonly kind: 'comparison';
      readonly op: string;
      readonly left: PredicateNode;
      readonly right: PredicateNode;
    }
  | { readonly kind: 'not'; readonly operand: PredicateNode }
  | { readonly kind: 'and' | 'or'; readonly left: PredicateNode; readonly right: PredicateNode };

const ORDERING = new Set(['<', '<=', '>', '>=']);

/** The name a diagnostic uses for a value's type. */
export function typeName(value: PredicateValue): string {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  return 'string';
}

/**
 * Evaluate `node` against one case and prediction, or throw if it cannot be.
 *
 * A non-boolean result is an error rather than a truthiness test: the expression's
 * type is fixed at build time, so a non-boolean here means the AST and the walker
 * disagree, and guessing which one is right is exactly the kind of guess that makes
 * a gate untrustworthy.
 */
export function evaluatePredicate(
  node: PredicateNode | undefined,
  context: { readonly entry: EvalCase; readonly prediction: string },
): boolean {
  const value = evaluateValue(node, context);
  if (typeof value !== 'boolean') {
    throw new EvalError(`predicate expected a boolean, got ${typeName(value)}`);
  }
  return value;
}

interface Context {
  readonly entry: EvalCase;
  readonly prediction: string;
}

function evaluateValue(node: PredicateNode | undefined, context: Context): PredicateValue {
  if (node === undefined || node === null || typeof node !== 'object') {
    throw new EvalError('predicate node must be an object');
  }
  switch (node.kind) {
    case 'string':
      return literalString(node);
    case 'number':
      return literalNumber(node);
    case 'boolean':
      return literalBoolean(node);
    case 'invalid':
      // Unreachable through a built metric -- the build drops an invalid
      // expression -- but a hand-written AST must not become a silent pass.
      throw new EvalError(`invalid predicate: ${node.reason || 'unknown reason'}`);
    case 'path':
      return path(node, context);
    case 'call':
      return call(node, context);
    case 'comparison':
      return compare(node, context);
    case 'not':
      return !booleanAt(node.operand, context);
    case 'and': {
      const left = booleanAt(node.left, context);
      const right = booleanAt(node.right, context);
      return left && right;
    }
    case 'or': {
      const left = booleanAt(node.left, context);
      const right = booleanAt(node.right, context);
      return left || right;
    }
    default:
      throw new EvalError(`unknown predicate node '${String((node as { kind?: unknown }).kind)}'`);
  }
}

function literalString(node: { readonly kind: 'string'; readonly value: string }): string {
  if (typeof node.value !== 'string') {
    throw new EvalError(`predicate string literal must be a string, got ${typeName(node.value)}`);
  }
  return node.value;
}

function literalNumber(node: { readonly kind: 'number'; readonly value: number }): number {
  if (typeof node.value !== 'number') {
    throw new EvalError(`predicate number literal must be a number, got ${typeName(node.value)}`);
  }
  return node.value;
}

function literalBoolean(node: { readonly kind: 'boolean'; readonly value: boolean }): boolean {
  if (typeof node.value !== 'boolean') {
    throw new EvalError(`predicate boolean literal must be a boolean, got ${typeName(node.value)}`);
  }
  return node.value;
}

function path(
  node: { readonly kind: 'path'; readonly path: string; readonly name?: string },
  context: Context,
): string {
  if (node.path === 'prediction') return context.prediction;
  if (node.path === 'case.id') return context.entry.id;
  if (node.path === 'case.metadata') {
    if (typeof node.name !== 'string') {
      throw new EvalError('case.metadata path must name a key');
    }
    if (!(node.name in context.entry.metadata)) {
      throw new EvalError(`unbound case.metadata key '${node.name}'`);
    }
    return context.entry.metadata[node.name] as string;
  }
  throw new EvalError(`unknown predicate path '${node.path}'`);
}

function call(
  node: { readonly kind: 'call'; readonly name: string; readonly args: readonly PredicateNode[] },
  context: Context,
): PredicateValue {
  const values = node.args.map((arg) => evaluateValue(arg, context));
  if (node.name === 'length') {
    arity(node.name, values, 1);
    return stringFor(node.name, values[0] as PredicateValue).length;
  }
  if (node.name === 'contains' || node.name === 'startswith' || node.name === 'endswith') {
    arity(node.name, values, 2);
    const text = stringFor(node.name, values[0] as PredicateValue);
    const needle = stringFor(node.name, values[1] as PredicateValue);
    if (node.name === 'contains') return text.includes(needle);
    if (node.name === 'startswith') return text.startsWith(needle);
    return text.endsWith(needle);
  }
  throw new EvalError(`unknown predicate builtin '${node.name}'`);
}

function arity(name: string, values: readonly PredicateValue[], wanted: number): void {
  if (values.length !== wanted) {
    throw new EvalError(`${name}() takes ${wanted} argument(s), got ${values.length}`);
  }
}

function stringFor(name: string, value: PredicateValue): string {
  if (typeof value !== 'string') {
    throw new EvalError(`${name}() requires strings, got ${typeName(value)}`);
  }
  return value;
}

function compare(
  node: {
    readonly kind: 'comparison';
    readonly op: string;
    readonly left: PredicateNode;
    readonly right: PredicateNode;
  },
  context: Context,
): boolean {
  const left = evaluateValue(node.left, context);
  const right = evaluateValue(node.right, context);
  if (ORDERING.has(node.op)) {
    if (typeof left !== 'number' || typeof right !== 'number') {
      throw new EvalError(
        `ordering comparison '${node.op}' requires two numbers, got ${typeName(left)} and ${typeName(right)}`,
      );
    }
    if (node.op === '<') return left < right;
    if (node.op === '<=') return left <= right;
    if (node.op === '>') return left > right;
    return left >= right;
  }
  if (node.op !== '==' && node.op !== '!=') {
    throw new EvalError(`unknown predicate operator '${node.op}'`);
  }
  if (typeName(left) !== typeName(right)) {
    throw new EvalError(
      `type mismatch: cannot apply '${node.op}' to ${typeName(left)} and ${typeName(right)}`,
    );
  }
  const equal = left === right;
  return node.op === '==' ? equal : !equal;
}

function booleanAt(node: PredicateNode | undefined, context: Context): boolean {
  const value = evaluateValue(node, context);
  if (typeof value !== 'boolean') {
    throw new EvalError(`predicate expected a boolean, got ${typeName(value)}`);
  }
  return value;
}
