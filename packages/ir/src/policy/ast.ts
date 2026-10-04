/**
 * PolicyExpr AST. Phase 0 supports exactly this grammar and anything else is a
 * validation error, never a silent pass. The AST is plain JSON so it can be
 * embedded in the IR and interpreted by any target without a second parser.
 *
 *   expression  := or
 *   or          := and ('or' and)*
 *   and         := comparison ('and' comparison)*
 *   comparison  := unary (('==' | '!=' | '<' | '<=' | '>' | '>=') unary)?
 *   unary       := 'not' unary | primary
 *   primary     := 'true' | 'false' | string | number | call | '(' expression ')'
 *   call        := builtin '(' (operand (',' operand)*)? ')'
 *   operand     := primary
 *
 * Precedence, tightest first: `not`, comparison, `and`, `or`.
 */

export const POLICY_BUILTINS = ['hasRole', 'hasScope', 'isAuthenticated'] as const;

export type PolicyBuiltin = (typeof POLICY_BUILTINS)[number];

export const COMPARISON_OPERATORS = ['==', '!=', '<=', '>=', '<', '>'] as const;

export type ComparisonOperator = (typeof COMPARISON_OPERATORS)[number];

/** A state predicate call. Arguments are nodes; only the builtins above are accepted. */
export interface PolicyCall {
  kind: 'call';
  name: PolicyBuiltin;
  args: PolicyNode[];
}

export interface PolicyComparison {
  kind: 'comparison';
  op: ComparisonOperator;
  left: PolicyNode;
  right: PolicyNode;
}

export interface PolicyLogical {
  kind: 'and' | 'or';
  left: PolicyNode;
  right: PolicyNode;
}

export interface PolicyNot {
  kind: 'not';
  operand: PolicyNode;
}

export type PolicyNode =
  | PolicyCall
  | PolicyComparison
  | PolicyLogical
  | PolicyNot
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean };

/** An argument position: any node, including a nested call. */
export type PolicyOperand = PolicyNode;

/** A parsed policy expression; always a node, never the source string. */
export type PolicyExpr = PolicyNode;

/** Arity of each builtin; the parser rejects any other argument count. */
export const POLICY_BUILTIN_ARITY: Record<PolicyBuiltin, number> = {
  hasRole: 1,
  hasScope: 1,
  isAuthenticated: 0,
};

export function isPolicyBuiltin(name: string): name is PolicyBuiltin {
  return (POLICY_BUILTINS as readonly string[]).includes(name);
}

/** Renders an AST back to a normalized source form, for diagnostic messages. */
export function formatPolicyExpr(node: PolicyNode): string {
  switch (node.kind) {
    case 'string':
      return JSON.stringify(node.value);
    case 'number':
      return String(node.value);
    case 'boolean':
      return node.value ? 'true' : 'false';
    case 'call':
      return `${node.name}(${node.args.map(formatPolicyExpr).join(', ')})`;
    case 'comparison':
      return `${formatPolicyExpr(node.left)} ${node.op} ${formatPolicyExpr(node.right)}`;
    case 'and':
    case 'or':
      return `(${formatPolicyExpr(node.left)} ${node.kind} ${formatPolicyExpr(node.right)})`;
    case 'not':
      return `not ${formatPolicyExpr(node.operand)}`;
  }
}
