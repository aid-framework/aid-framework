import { describe, expect, it } from 'vitest';
import {
  formatPredicateExpr,
  IR_DIAGNOSTIC_CODES,
  PREDICATE_BUILTINS,
  type PredicateNode,
  parsePredicateExpr,
  predicateIsBoolean,
} from '../src/index.js';

function parse(source: string): PredicateNode {
  const result = parsePredicateExpr(source);
  expect(result.diagnostics).toEqual([]);
  return result.ast;
}

function codes(source: string): string[] {
  return parsePredicateExpr(source).diagnostics.map((diagnostic) => diagnostic.code);
}

describe('PredicateExpr parsing', () => {
  it('reads the three admitted paths', () => {
    expect(parse('prediction == "a"')).toEqual({
      kind: 'comparison',
      op: '==',
      left: { kind: 'path', path: 'prediction' },
      right: { kind: 'string', value: 'a' },
    });
    expect(parse('case.id == "c1"')).toEqual({
      kind: 'comparison',
      op: '==',
      left: { kind: 'path', path: 'case.id' },
      right: { kind: 'string', value: 'c1' },
    });
    expect(parse('case.metadata.locale == "en"')).toEqual({
      kind: 'comparison',
      op: '==',
      left: { kind: 'path', path: 'case.metadata', name: 'locale' },
      right: { kind: 'string', value: 'en' },
    });
  });

  it('binds not tighter than comparison, and comparison tighter than and/or', () => {
    expect(parse('not prediction == "a" and case.metadata.b == "x"')).toEqual({
      kind: 'and',
      left: {
        kind: 'not',
        operand: {
          kind: 'comparison',
          op: '==',
          left: { kind: 'path', path: 'prediction' },
          right: { kind: 'string', value: 'a' },
        },
      },
      right: {
        kind: 'comparison',
        op: '==',
        left: { kind: 'path', path: 'case.metadata', name: 'b' },
        right: { kind: 'string', value: 'x' },
      },
    });
  });

  it('accepts exactly the four builtins at their declared arity', () => {
    for (const name of PREDICATE_BUILTINS) {
      const node = parse(
        name === 'length' ? 'length(prediction) < 4000' : `${name}(prediction, "x")`,
      );
      expect(node).toMatchObject(
        name === 'length'
          ? { kind: 'comparison', left: { kind: 'call', name } }
          : { kind: 'call', name },
      );
    }
    // `length` returns a number, so it is not a predicate on its own...
    expect(codes('length(prediction)')).toEqual([IR_DIAGNOSTIC_CODES.predicateNotBoolean]);
  });

  it('rejects a non-boolean whole expression', () => {
    expect(codes('prediction')).toEqual([IR_DIAGNOSTIC_CODES.predicateNotBoolean]);
    expect(codes('"literal"')).toEqual([IR_DIAGNOSTIC_CODES.predicateNotBoolean]);
    expect(codes('42')).toEqual([IR_DIAGNOSTIC_CODES.predicateNotBoolean]);
    // A bare boolean is a (constant) predicate: it is boolean, so it parses.
    expect(parse('true')).toEqual({ kind: 'boolean', value: true });
  });

  it('rejects a non-boolean in every boolean position, not only at the root', () => {
    // `not` binds looser than a comparison, so a bare path under it is a string in a
    // boolean slot rather than a negated string.
    expect(codes('not prediction')).toEqual([IR_DIAGNOSTIC_CODES.predicateNotBoolean]);
    expect(codes('prediction == "a" and 42')).toEqual([IR_DIAGNOSTIC_CODES.predicateNotBoolean]);
    // Both operands of the `or` are strings, and both are reported.
    expect(codes('case.id or case.id')).toEqual([
      IR_DIAGNOSTIC_CODES.predicateNotBoolean,
      IR_DIAGNOSTIC_CODES.predicateNotBoolean,
    ]);
  });

  it('rejects any path outside the closed set', () => {
    expect(codes('step.counter == 3')).toEqual([IR_DIAGNOSTIC_CODES.predicateUnknownPath]);
    expect(codes('case.expected == "a"')).toEqual([IR_DIAGNOSTIC_CODES.predicateUnknownPath]);
    expect(codes('case.metadata == "a"')).toEqual([IR_DIAGNOSTIC_CODES.predicateUnknownPath]);
    expect(codes('case == "a"')).toEqual([IR_DIAGNOSTIC_CODES.predicateUnknownPath]);
    expect(codes('index == 0')).toEqual([IR_DIAGNOSTIC_CODES.predicateUnknownPath]);
  });

  it('rejects an unknown builtin instead of treating it as false', () => {
    expect(codes('matches(prediction, "^a")')).toEqual([
      IR_DIAGNOSTIC_CODES.predicateUnknownBuiltin,
    ]);
    // A rejected call consumes its own arguments, so one bad builtin is one error.
    expect(parsePredicateExpr('matches(f("g"), 1)').diagnostics).toHaveLength(1);
  });

  it('rejects a wrong argument count', () => {
    expect(codes('contains(prediction)')).toEqual([IR_DIAGNOSTIC_CODES.predicateArity]);
    expect(codes('length()')).toEqual([IR_DIAGNOSTIC_CODES.predicateArity]);
  });

  it('returns an invalid node rather than no node on every failure', () => {
    for (const source of ['', 'prediction ==', '(', 'contains(prediction,', 'length(prediction)']) {
      const result = parsePredicateExpr(source);
      expect(result.ast.kind).toBe('invalid');
      expect(result.diagnostics.length).toBeGreaterThan(0);
    }
  });

  it('reports the specific reason for malformed input', () => {
    expect(codes('prediction == "unterminated')).toEqual([
      IR_DIAGNOSTIC_CODES.predicateUnterminatedString,
    ]);
    expect(codes('(prediction == "a"')).toEqual([IR_DIAGNOSTIC_CODES.predicateUnclosedParen]);
    expect(codes('prediction == "a" prediction')).toEqual([
      IR_DIAGNOSTIC_CODES.predicateTrailingToken,
    ]);
    expect(codes('prediction == "a" $')).toEqual([IR_DIAGNOSTIC_CODES.predicateSyntax]);
    expect(codes('prediction ==')).toEqual([IR_DIAGNOSTIC_CODES.predicateExpected]);
  });

  it('never accepts a construct that would need dynamic evaluation', () => {
    // The two spellings a hand-written evaluator would be tempted to support. Both are
    // refused by the grammar, which is the whole reason it is closed.
    expect(codes('eval("prediction") == "a"')).toEqual([
      IR_DIAGNOSTIC_CODES.predicateUnknownBuiltin,
    ]);
    expect(codes('prediction =~ "a.*"')).toEqual([IR_DIAGNOSTIC_CODES.predicateSyntax]);
  });

  it('round-trips through the formatter', () => {
    for (const source of [
      'prediction == "a" and contains(prediction, "b")',
      'not (case.metadata.locale == "en" or length(prediction) > 3)',
      'case.id != "c1"',
    ]) {
      expect(parse(formatPredicateExpr(parse(source)))).toEqual(parse(source));
    }
  });

  it('classifies which nodes are boolean', () => {
    expect(predicateIsBoolean({ kind: 'boolean', value: false })).toBe(true);
    expect(predicateIsBoolean({ kind: 'number', value: 1 })).toBe(false);
    expect(predicateIsBoolean({ kind: 'path', path: 'prediction' })).toBe(false);
    expect(predicateIsBoolean({ kind: 'call', name: 'length', args: [] })).toBe(false);
    expect(predicateIsBoolean({ kind: 'call', name: 'contains', args: [] })).toBe(true);
  });
});
