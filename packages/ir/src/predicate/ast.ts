/**
 * PredicateExpr AST. The eval-time counterpart to `PolicyExpr`: a closed grammar for
 * an `assert` metric's condition, evaluated against one `(case, prediction)` pair.
 *
 * It is deliberately *not* `PolicyExpr`. A policy answers "who is asking?" from a
 * `Principal`; a predicate answers "is this output acceptable?" from a dataset case
 * and a prediction. They share no operand, so reusing the policy grammar would mean
 * leaving three builtins the evaluator could never bind and adding a path production
 * it has no context for -- a grammar that documents two contexts at once.
 *
 *   expression  := or
 *   or          := and ('or' and)*
 *   and         := not ('and' not)*
 *   not         := 'not' not | comparison
 *   comparison  := primary (('==' | '!=' | '<' | '<=' | '>' | '>=') primary)?
 *   primary     := 'true' | 'false' | string | number | path | call | '(' expression ')'
 *   path        := 'prediction' | 'case' '.' 'id' | 'case' '.' 'metadata' '.' NAME
 *   call        := builtin '(' primary (',' primary)* ')'
 *
 * Precedence, tightest first: comparison, `not`, `and`, `or`. `not` is looser than
 * a comparison so that `not prediction == "a"` negates the comparison; tighter and
 * it would negate a string and reach the evaluator as a well-typed-looking tree.
 *
 * The AST is plain JSON so it can be embedded in the IR and interpreted by any
 * target without a second parser.
 */

/**
 * The three things an expression may read.
 *
 * Nothing else: there is no step counter, no loop variable, and no ambient config,
 * because an eval case is the whole of the context at the point a metric scores.
 * Every one of these is statically a string, which is what makes an unbound
 * `case.metadata.<name>` the only dynamic lookup in the language.
 */
export const PREDICATE_PATHS = ['prediction', 'case.id', 'case.metadata'] as const;

export type PredicatePathRoot = (typeof PREDICATE_PATHS)[number];

/** Closed builtin set. No regex, no model call, no I/O: every call is total. */
export const PREDICATE_BUILTINS = ['contains', 'startswith', 'endswith', 'length'] as const;

export type PredicateBuiltin = (typeof PREDICATE_BUILTINS)[number];

/** Arity of each builtin; the parser rejects any other argument count. */
export const PREDICATE_BUILTIN_ARITY: Record<PredicateBuiltin, number> = {
  contains: 2,
  startswith: 2,
  endswith: 2,
  length: 1,
};

export const PREDICATE_OPERATORS = ['==', '!=', '<=', '>=', '<', '>'] as const;

export type PredicateOperator = (typeof PREDICATE_OPERATORS)[number];

/**
 * Operators that order rather than test equality.
 *
 * Numeric-only on purpose. Python compares `str` by code point and JavaScript by
 * UTF-16 code unit, so `<` on strings is the one place a shared grammar would give
 * the two runtimes different answers; refusing it keeps them identical instead of
 * documenting the divergence and hoping nobody hits it.
 */
export const ORDERING_OPERATORS = ['<=', '>=', '<', '>'] as const;

export type OrderingOperator = (typeof ORDERING_OPERATORS)[number];

export interface PredicatePrediction {
  kind: 'path';
  path: 'prediction';
}

export interface PredicateCaseId {
  kind: 'path';
  path: 'case.id';
}

export interface PredicateMetadata {
  kind: 'path';
  path: 'case.metadata';
  name: string;
}

export type PredicatePath = PredicateMetadata | PredicateCaseId | PredicatePrediction;

/** A builtin call. Arguments are nodes; only the builtins above are accepted. */
export interface PredicateCall {
  kind: 'call';
  name: PredicateBuiltin;
  args: PredicateNode[];
}

export interface PredicateComparison {
  kind: 'comparison';
  op: PredicateOperator;
  left: PredicateNode;
  right: PredicateNode;
}

export interface PredicateLogical {
  kind: 'and' | 'or';
  left: PredicateNode;
  right: PredicateNode;
}

export interface PredicateNot {
  kind: 'not';
  operand: PredicateNode;
}

/**
 * A source that could not be parsed.
 *
 * Carried as a node rather than as `undefined` so a parse failure can never be
 * mistaken for "no condition": the caller holds a node either way, and the
 * accompanying diagnostic is what stops the build.
 */
export interface PredicateInvalid {
  kind: 'invalid';
  reason: string;
}

export type PredicateNode =
  | PredicateCall
  | PredicateComparison
  | PredicateInvalid
  | PredicateLogical
  | PredicateNot
  | PredicatePath
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean };

/** A parsed predicate expression; always a node, never the source string. */
export type PredicateExpr = PredicateNode;

export function isPredicateBuiltin(name: string): name is PredicateBuiltin {
  return (PREDICATE_BUILTINS as readonly string[]).includes(name);
}

export function isOrderingOperator(op: PredicateOperator): op is OrderingOperator {
  return (ORDERING_OPERATORS as readonly string[]).includes(op);
}

/**
 * Whether a node is boolean by construction.
 *
 * Checked at build time so a whole expression that evaluates to a string or a
 * number is refused with a parse error instead of surfacing as "not a pass" at
 * eval time. `length(prediction)` is the reachable case: a metric whose score
 * hinges on it is a mistake, not a false assertion.
 */
export function predicateIsBoolean(node: PredicateNode): boolean {
  switch (node.kind) {
    case 'and':
    case 'comparison':
    case 'not':
    case 'or':
      return true;
    case 'boolean':
      return true;
    case 'call':
      return node.name !== 'length';
    case 'invalid':
    case 'number':
    case 'path':
    case 'string':
      return false;
  }
}

/** Renders an AST back to a normalized source form, for diagnostic messages. */
export function formatPredicateExpr(node: PredicateNode): string {
  switch (node.kind) {
    case 'string':
      return JSON.stringify(node.value);
    case 'number':
      return String(node.value);
    case 'boolean':
      return node.value ? 'true' : 'false';
    case 'invalid':
      return `<invalid: ${node.reason}>`;
    case 'path':
      return node.path === 'case.metadata' ? `case.metadata.${node.name}` : node.path;
    case 'call':
      return `${node.name}(${node.args.map(formatPredicateExpr).join(', ')})`;
    case 'comparison':
      return `${formatPredicateExpr(node.left)} ${node.op} ${formatPredicateExpr(node.right)}`;
    case 'and':
    case 'or':
      return `(${formatPredicateExpr(node.left)} ${node.kind} ${formatPredicateExpr(node.right)})`;
    case 'not':
      return `not ${formatPredicateExpr(node.operand)}`;
  }
}
