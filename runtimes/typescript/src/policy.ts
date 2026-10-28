/**
 * Evaluation of the IR's `PolicyExpr` AST.
 *
 * The grammar is the one `packages/ir/src/policy` parses, and the AST is plain JSON
 * precisely so a target does not need a second parser:
 *
 *     expression := or
 *     or         := and ('or' and)*
 *     and        := comparison ('and' comparison)*
 *     comparison := unary (('==' | '!=' | '<' | '<=' | '>' | '>=') unary)?
 *     unary      := 'not' unary | primary
 *     primary    := 'true' | 'false' | string | number | call | '(' expression ')'
 *     call       := builtin '(' (operand (',' operand)*)? ')'
 *
 * The builtins are the closed set `hasRole`, `hasScope`, `isAuthenticated`, so the
 * context this evaluates against is a {@link Principal} -- who is asking -- and not
 * loop state such as a step counter. Anything the evaluator cannot decide raises:
 * for a human-in-the-loop gate, "could not decide" must never degrade into "do not
 * ask".
 *
 * This file mirrors `aid_runtime/agents/policy.py`. The builtin set is duplicated
 * from `packages/ir` rather than imported, because this package has no dependency on
 * the spec toolchain; a test reads the IR source and keeps the two sets equal.
 */

import { PolicyEvaluationError } from './errors.js';
import { repr } from './internal/json.js';

/** One node of a parsed policy. Plain JSON, as the IR carries it. */
export type PolicyNode = Readonly<Record<string, unknown>>;

const COMPARISONS: ReadonlySet<string> = new Set(['==', '!=', '<', '<=', '>', '>=']);
const LOGICAL: ReadonlySet<string> = new Set(['and', 'or']);

/** Builtin policy functions, in the order the IR declares them. */
export const POLICY_BUILTINS = ['hasRole', 'hasScope', 'isAuthenticated'] as const;

/** How many operands each builtin takes. */
export const POLICY_BUILTIN_ARITY: Readonly<Record<string, number>> = {
  hasRole: 1,
  hasScope: 1,
  isAuthenticated: 0,
};

/**
 * Who a policy is evaluated for.
 *
 * Defaults are the anonymous-but-authenticated caller an app with no auth layer has:
 * `isAuthenticated()` is true and both role and scope sets are empty, so
 * `hasRole('admin')` is false rather than undefined.
 */
export class Principal {
  readonly roles: ReadonlySet<string>;
  readonly scopes: ReadonlySet<string>;
  readonly authenticated: boolean;

  constructor(
    init: {
      readonly roles?: Iterable<string>;
      readonly scopes?: Iterable<string>;
      readonly authenticated?: boolean;
    } = {},
  ) {
    this.roles = new Set(init.roles ?? []);
    this.scopes = new Set(init.scopes ?? []);
    this.authenticated = init.authenticated ?? true;
  }
}

/** Evaluate a parsed policy against `principal`. Never returns "maybe". */
export function evaluatePolicy(node: PolicyNode, principal: Principal): boolean {
  const value = evaluateNode(node, principal);
  if (typeof value !== 'boolean') {
    throw new PolicyEvaluationError(
      `policy did not evaluate to a boolean, got ${typeName(value)}: ${policySource(node)}`,
    );
  }
  return value;
}

/** Render an AST back to source, so a trace or error can quote the policy. */
export function policySource(node: PolicyNode): string {
  const kind = node.kind;
  if (kind === 'string' || kind === 'number' || kind === 'boolean') {
    return literalSource(node.value);
  }
  if (kind === 'call') {
    const args = asArray(node.args).map((argument) => policySource(argument));
    return `${String(node.name)}(${args.join(', ')})`;
  }
  if (kind === 'comparison') {
    return `${policySource(asNode(node.left))} ${String(node.op)} ${policySource(
      asNode(node.right),
    )}`;
  }
  if (typeof kind === 'string' && LOGICAL.has(kind)) {
    return `(${policySource(asNode(node.left))} ${kind} ${policySource(asNode(node.right))})`;
  }
  if (kind === 'not') {
    return `not ${policySource(asNode(node.operand))}`;
  }
  throw new PolicyEvaluationError(`unsupported policy node kind ${describe(kind)}`);
}

function literalSource(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return `"${value}"`;
  return String(value);
}

function evaluateNode(node: PolicyNode, principal: Principal): unknown {
  const kind = node.kind;
  if (kind === 'string' || kind === 'number' || kind === 'boolean') {
    return node.value;
  }
  if (kind === 'call') return call(node, principal);
  if (kind === 'comparison') return compare(node, principal);
  if (typeof kind === 'string' && LOGICAL.has(kind)) return logic(kind, node, principal);
  if (kind === 'not') {
    return !asBoolean(evaluateNode(asNode(node.operand), principal), node);
  }
  throw new PolicyEvaluationError(`unsupported policy node kind ${describe(kind)}`);
}

function call(node: PolicyNode, principal: Principal): boolean {
  const name = node.name;
  const args = asArray(node.args).map((argument) => evaluateNode(argument, principal));
  if (name === 'isAuthenticated') {
    if (args.length > 0) throw new PolicyEvaluationError('isAuthenticated() takes no arguments');
    return principal.authenticated;
  }
  if (name === 'hasRole') return membership(String(name), args, principal.roles);
  if (name === 'hasScope') return membership(String(name), args, principal.scopes);
  throw new PolicyEvaluationError(`unknown policy builtin ${describe(name)}`);
}

function membership(name: string, args: readonly unknown[], held: ReadonlySet<string>): boolean {
  if (args.length !== 1) {
    throw new PolicyEvaluationError(`${name}() takes exactly one argument`);
  }
  const [wanted] = args;
  if (typeof wanted !== 'string') {
    throw new PolicyEvaluationError(`${name}() argument must be a string, got ${describe(wanted)}`);
  }
  return held.has(wanted);
}

function compare(node: PolicyNode, principal: Principal): boolean {
  const operator = node.op;
  if (typeof operator !== 'string' || !COMPARISONS.has(operator)) {
    throw new PolicyEvaluationError(`unknown comparison operator ${describe(operator)}`);
  }
  const left = evaluateNode(asNode(node.left), principal);
  const right = evaluateNode(asNode(node.right), principal);
  if (operator === '==') return left === right;
  if (operator === '!=') return left !== right;
  const comparable =
    (typeof left === 'number' && typeof right === 'number') ||
    (typeof left === 'string' && typeof right === 'string');
  if (!comparable) {
    throw new PolicyEvaluationError(
      `cannot compare ${typeName(left)} ${operator} ${typeName(right)}: ${policySource(node)}`,
    );
  }
  const a = left as number | string;
  const b = right as number | string;
  switch (operator) {
    case '<':
      return a < b;
    case '<=':
      return a <= b;
    case '>':
      return a > b;
    default:
      return a >= b;
  }
}

function logic(kind: string, node: PolicyNode, principal: Principal): boolean {
  const left = asBoolean(evaluateNode(asNode(node.left), principal), node);
  // `and`/`or` short-circuit on the left operand's truth value.
  if (kind === 'and' && !left) return false;
  if (kind === 'or' && left) return true;
  return asBoolean(evaluateNode(asNode(node.right), principal), node);
}

function asBoolean(value: unknown, node: PolicyNode): boolean {
  if (typeof value !== 'boolean') {
    throw new PolicyEvaluationError(
      `expected a boolean operand in ${policySource(node)}, got ${describe(value)}`,
    );
  }
  return value;
}

function asNode(value: unknown): PolicyNode {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PolicyEvaluationError(`policy operand is not a node: ${describe(value)}`);
  }
  return value as PolicyNode;
}

function asArray(value: unknown): readonly PolicyNode[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new PolicyEvaluationError(`policy operands are not a list: ${describe(value)}`);
  }
  return value.map((entry) => asNode(entry));
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const kind = typeof value;
  return kind === 'object' ? 'object' : kind;
}

function describe(value: unknown): string {
  return typeof value === 'string' ? repr(value) : String(value);
}
