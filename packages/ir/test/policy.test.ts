import { describe, expect, it } from 'vitest';

import {
  COMPARISON_OPERATORS,
  formatPolicyExpr,
  IR_DIAGNOSTIC_CODES,
  isPolicyBuiltin,
  POLICY_BUILTIN_ARITY,
  POLICY_BUILTINS,
  type PolicyNode,
  parsePolicyExpr,
  tokenize,
} from '../src/index.js';
import { codesOf } from './helpers.js';

const CONTEXT = { file: 'policy.yaml', path: ['tools', 'issue_refund', 'auth'] };

function parse(source: string): PolicyNode {
  const result = parsePolicyExpr(source, CONTEXT);
  if (result.ast === undefined) {
    throw new Error(
      `${JSON.stringify(source)} did not parse: ${codesOf(result.diagnostics).join()}`,
    );
  }
  return result.ast;
}

function reject(source: string) {
  const result = parsePolicyExpr(source, CONTEXT);
  return { ast: result.ast, codes: codesOf(result.diagnostics), diagnostics: result.diagnostics };
}

const call = (name: string, args: PolicyNode[] = []) =>
  ({ kind: 'call', name, args }) as PolicyNode;
const str = (value: string) => ({ kind: 'string', value }) as PolicyNode;
const boolean = (value: boolean) => ({ kind: 'boolean', value }) as PolicyNode;

describe('PolicyExpr grammar', () => {
  it('parses literals', () => {
    expect(parse('true')).toEqual(boolean(true));
    expect(parse('false')).toEqual(boolean(false));
    expect(parse('"admin"')).toEqual(str('admin'));
    expect(parse("'admin'")).toEqual(str('admin'));
    expect(parse('42')).toEqual({ kind: 'number', value: 42 });
    expect(parse('4.5')).toEqual({ kind: 'number', value: 4.5 });
  });

  it('parses every comparison operator', () => {
    for (const op of COMPARISON_OPERATORS) {
      expect(parse(`"a" ${op} "b"`)).toEqual({
        kind: 'comparison',
        op,
        left: str('a'),
        right: str('b'),
      });
    }
  });

  it('parses the builtins at their declared arity', () => {
    expect(parse('hasRole("admin")')).toEqual(call('hasRole', [str('admin')]));
    expect(parse('hasScope("tickets:write")')).toEqual(call('hasScope', [str('tickets:write')]));
    expect(parse('isAuthenticated()')).toEqual(call('isAuthenticated'));
    expect(POLICY_BUILTINS).toEqual(['hasRole', 'hasScope', 'isAuthenticated']);
    expect(POLICY_BUILTIN_ARITY).toEqual({ hasRole: 1, hasScope: 1, isAuthenticated: 0 });
  });

  it('parses the boolean connectives', () => {
    expect(parse('isAuthenticated() and hasRole("a")')).toEqual({
      kind: 'and',
      left: call('isAuthenticated'),
      right: call('hasRole', [str('a')]),
    });
    expect(parse('isAuthenticated() or hasRole("a")')).toEqual({
      kind: 'or',
      left: call('isAuthenticated'),
      right: call('hasRole', [str('a')]),
    });
    expect(parse('not isAuthenticated()')).toEqual({
      kind: 'not',
      operand: call('isAuthenticated'),
    });
  });
});

describe('PolicyExpr precedence and associativity', () => {
  it('binds not tighter than comparison', () => {
    expect(parse('not hasRole("a") == true')).toEqual({
      kind: 'comparison',
      op: '==',
      left: { kind: 'not', operand: call('hasRole', [str('a')]) },
      right: boolean(true),
    });
  });

  it('binds comparison tighter than and', () => {
    expect(parse('hasScope("a") == true and isAuthenticated()')).toEqual({
      kind: 'and',
      left: {
        kind: 'comparison',
        op: '==',
        left: call('hasScope', [str('a')]),
        right: boolean(true),
      },
      right: call('isAuthenticated'),
    });
  });

  it('binds and tighter than or', () => {
    expect(parse('true and false or true')).toEqual({
      kind: 'or',
      left: { kind: 'and', left: boolean(true), right: boolean(false) },
      right: boolean(true),
    });
  });

  it('associates left', () => {
    expect(parse('true or false or true')).toEqual({
      kind: 'or',
      left: { kind: 'or', left: boolean(true), right: boolean(false) },
      right: boolean(true),
    });
    expect(parse('true and false and true')).toEqual({
      kind: 'and',
      left: { kind: 'and', left: boolean(true), right: boolean(false) },
      right: boolean(true),
    });
  });

  it('honours nested parentheses, which override precedence', () => {
    expect(parse('(true or false) and true')).toEqual({
      kind: 'and',
      left: { kind: 'or', left: boolean(true), right: boolean(false) },
      right: boolean(true),
    });
    expect(parse('not (hasRole("a") and hasScope("b"))')).toEqual({
      kind: 'not',
      operand: {
        kind: 'and',
        left: call('hasRole', [str('a')]),
        right: call('hasScope', [str('b')]),
      },
    });
  });
});

describe('PolicyExpr AST', () => {
  it('round-trips a canonical rendering', () => {
    const ast = parse('not (hasRole("a") and hasScope("b"))');
    expect(formatPolicyExpr(ast)).toBe('not (hasRole("a") and hasScope("b"))');
    expect(parse(formatPolicyExpr(ast))).toEqual(ast);
  });

  it('is plain JSON, so any target can consume it without a second parser', () => {
    const ast = parse('isAuthenticated() and hasRole("a")');
    expect(JSON.parse(JSON.stringify(ast))).toEqual(ast);
  });

  it('recognizes only its own builtins', () => {
    expect(isPolicyBuiltin('hasRole')).toBe(true);
    expect(isPolicyBuiltin('canApprove')).toBe(false);
  });

  it('tokenizes with offsets, so an error can point at the offending span', () => {
    const lexed = tokenize('hasRole("a") and true', CONTEXT);
    expect(lexed.diagnostics).toEqual([]);
    expect(lexed.tokens.map((token) => token.type)).toEqual([
      'identifier',
      'lparen',
      'string',
      'rparen',
      'operator',
      'boolean',
      'eof',
    ]);
    expect(lexed.tokens[0]?.start).toBe(0);
    expect(lexed.tokens[2]?.start).toBe(8);
  });
});

describe('PolicyExpr fails closed', () => {
  it('rejects empty input rather than implying an allow', () => {
    const result = reject('   ');
    expect(result.ast).toBeUndefined();
    expect(result.codes).toEqual([IR_DIAGNOSTIC_CODES.policyEmpty]);
  });

  it('rejects an unknown builtin instead of treating it as true', () => {
    const result = reject('canApprove("x")');
    expect(result.ast).toBeUndefined();
    expect(result.codes).toEqual([IR_DIAGNOSTIC_CODES.policyUnknownBuiltin]);
    expect(result.diagnostics[0]?.message).toContain('canApprove');
  });

  it('rejects a bare identifier', () => {
    expect(reject('foo').codes).toEqual([IR_DIAGNOSTIC_CODES.policyUnknownIdentifier]);
  });

  it('rejects an unterminated string, unclosed paren, and unclosed argument list', () => {
    expect(reject('"abc').codes).toContain(IR_DIAGNOSTIC_CODES.policyUnterminatedString);
    expect(reject('(true').codes).toEqual([IR_DIAGNOSTIC_CODES.policyUnclosedParen]);
    expect(reject('hasRole("a"').codes).toEqual([IR_DIAGNOSTIC_CODES.policyUnclosedParen]);
  });

  it('rejects trailing tokens after a complete expression', () => {
    expect(reject('true false').codes).toEqual([IR_DIAGNOSTIC_CODES.policyTrailingToken]);
  });

  it('rejects the wrong arity', () => {
    expect(reject('hasRole()').codes).toEqual([IR_DIAGNOSTIC_CODES.policyArity]);
    expect(reject('isAuthenticated("x")').codes).toEqual([IR_DIAGNOSTIC_CODES.policyArity]);
  });

  it('rejects a non-string builtin argument', () => {
    expect(reject('hasRole(1)').codes).toEqual([IR_DIAGNOSTIC_CODES.policyArgumentType]);
  });

  it('rejects an unexpected character and an unexpected token', () => {
    expect(reject('@').codes).toContain(IR_DIAGNOSTIC_CODES.policySyntax);
    expect(reject('()').codes).toEqual([IR_DIAGNOSTIC_CODES.policyExpected]);
    expect(reject('true and').codes).toEqual([IR_DIAGNOSTIC_CODES.policyExpected]);
  });

  it('never lets an exception escape to the caller', () => {
    for (const source of ['', '   ', 'hasRole(', '((((', 'not', '==', '1 ==']) {
      const result = parsePolicyExpr(source, CONTEXT);
      expect(result.diagnostics.length).toBeGreaterThan(0);
      expect(result.ast).toBeUndefined();
    }
  });
});

describe('PolicyExpr error positions', () => {
  it('points at the offending span, not the start of the expression', () => {
    const result = reject('  canApprove("x")');
    const diagnostic = result.diagnostics[0];
    expect(diagnostic?.line).toBe(1);
    expect(diagnostic?.column).toBe(3);
    expect(diagnostic?.file).toBe('policy.yaml');
    expect(diagnostic?.path).toEqual(['tools', 'issue_refund', 'auth']);
  });

  it('counts lines across a multi-line expression', () => {
    const result = reject('true\n  canApprove("x")');
    expect(result.diagnostics[0]?.line).toBe(2);
    expect(result.diagnostics[0]?.column).toBe(3);
  });
});
