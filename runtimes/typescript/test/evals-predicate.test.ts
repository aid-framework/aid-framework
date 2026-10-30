/**
 * The TypeScript mirror of `runtimes/python/tests/test_evals_predicate.py`.
 *
 * The two files are deliberately the same rows in the same order: a predicate that
 * decides or refuses differently in one runtime is the failure this whole design
 * exists to prevent, and the only way to notice it is to ask both the same questions.
 */

import { describe, expect, it } from 'vitest';
import { evaluatePredicate, type PredicateNode } from '../src/evals/predicate.js';
import {
  AssertMetric,
  defaultMetrics,
  EvalCase,
  EvalError as RuntimeEvalError,
} from '../src/index.js';

const entry = new EvalCase({
  id: 'refund-1',
  input: 'where is my refund?',
  metadata: { severity: 'low' },
});

const passing: PredicateNode = {
  kind: 'and',
  left: {
    kind: 'comparison',
    op: '!=',
    left: { kind: 'path', path: 'prediction' },
    right: { kind: 'string', value: '' },
  },
  right: {
    kind: 'call',
    name: 'contains',
    args: [
      { kind: 'path', path: 'prediction' },
      { kind: 'string', value: 'refund' },
    ],
  },
};

function evaluate(node: PredicateNode, prediction = 'your refund is on its way'): boolean {
  return evaluatePredicate(node, { entry, prediction });
}

const str = (value: string): PredicateNode => ({ kind: 'string', value });
const num = (value: number): PredicateNode => ({ kind: 'number', value });
const bool = (value: boolean): PredicateNode => ({ kind: 'boolean', value });
const eq = (left: PredicateNode, right: PredicateNode): PredicateNode => ({
  kind: 'comparison',
  op: '==',
  left,
  right,
});
const call = (name: string, ...args: PredicateNode[]): PredicateNode => ({
  kind: 'call',
  name,
  args,
});
const metadata = (name: string): PredicateNode => ({
  kind: 'path',
  path: 'case.metadata',
  name,
});

describe('predicate paths', () => {
  it('reads the prediction', () => {
    expect(evaluate(eq({ kind: 'path', path: 'prediction' }, str('abc')), 'abc')).toBe(true);
  });

  it('reads the case id', () => {
    expect(evaluate(eq({ kind: 'path', path: 'case.id' }, str('refund-1')))).toBe(true);
  });

  it('reads declared metadata', () => {
    expect(evaluate(eq(metadata('severity'), str('low')))).toBe(true);
  });

  it('raises on an absent metadata key rather than reading it as empty', () => {
    expect(() => evaluate(eq(metadata('sevverity'), str('low')))).toThrow(/sevverity/);
  });

  it('never evaluates an absent metadata key to false', () => {
    expect(() => evaluate(eq(metadata('missing'), str('low')))).toThrow(RuntimeEvalError);
  });

  it('refuses a bare path as the whole expression', () => {
    expect(() => evaluate({ kind: 'path', path: 'prediction' })).toThrow(/expected a boolean/);
  });
});

describe('predicate operators', () => {
  it('compares strings for equality', () => {
    expect(evaluate(eq({ kind: 'path', path: 'case.id' }, str('refund-1')))).toBe(true);
  });

  it('compares strings for inequality', () => {
    expect(
      evaluate({
        kind: 'comparison',
        op: '!=',
        left: { kind: 'path', path: 'case.id' },
        right: str('refund-2'),
      }),
    ).toBe(true);
  });

  it('orders numbers', () => {
    expect(evaluate({ kind: 'comparison', op: '<', left: num(2), right: num(3) })).toBe(true);
  });

  it('refuses to order strings', () => {
    // Python orders `str` by code point and JavaScript by code unit, so admitting this
    // would give the two runtimes different answers on the same spec.
    expect(() =>
      evaluate({ kind: 'comparison', op: '<', left: str('a'), right: str('b') }),
    ).toThrow(RuntimeEvalError);
  });

  it('refuses to order across types', () => {
    expect(() => evaluate({ kind: 'comparison', op: '<', left: num(2), right: str('3') })).toThrow(
      RuntimeEvalError,
    );
  });

  it('refuses equality across types', () => {
    expect(() => evaluate(eq(num(2), str('2')))).toThrow(/type mismatch/);
  });
});

describe('predicate builtins', () => {
  it('evaluates contains, startswith and endswith', () => {
    expect(evaluate(eq(call('contains', str('abc'), str('b')), bool(true)))).toBe(true);
    expect(evaluate(eq(call('startswith', str('abc'), str('ab')), bool(true)))).toBe(true);
    expect(evaluate(eq(call('endswith', str('abc'), str('bc')), bool(true)))).toBe(true);
  });

  it('can be false for each builtin', () => {
    for (const name of ['contains', 'startswith', 'endswith']) {
      expect(evaluate(call(name, str('abc'), str('z')))).toBe(false);
    }
  });

  it('measures length', () => {
    expect(evaluate(eq(call('length', str('abcd')), num(4)))).toBe(true);
  });

  it('refuses a non-string argument', () => {
    expect(() => evaluate(call('contains', num(1), str('1')))).toThrow(RuntimeEvalError);
  });

  it('refuses an unknown builtin', () => {
    expect(() => evaluate(call('matches', str('a'), str('b')))).toThrow(RuntimeEvalError);
  });
});

describe('undecidable predicates', () => {
  it('raises on an unknown node kind', () => {
    expect(() => evaluate({ kind: 'lambda', body: [] } as unknown as PredicateNode)).toThrow(
      RuntimeEvalError,
    );
  });

  it('raises on an unknown path', () => {
    expect(() => evaluate({ kind: 'path', path: 'case.input' })).toThrow(RuntimeEvalError);
  });

  it('raises on an invalid node', () => {
    // The IR carries a parse failure as a node so it can never be mistaken for
    // "no condition"; the evaluator has to honour that by refusing it.
    expect(() => evaluate({ kind: 'invalid', reason: 'unterminated string' })).toThrow(
      RuntimeEvalError,
    );
  });

  it('raises on a non-boolean in a boolean slot', () => {
    expect(() => evaluate({ kind: 'and', left: str('yes'), right: bool(true) })).toThrow(
      /expected a boolean/,
    );
  });
});

describe('boolean logic', () => {
  it('evaluates and, or and not', () => {
    expect(evaluate({ kind: 'and', left: bool(true), right: bool(true) })).toBe(true);
    expect(evaluate({ kind: 'and', left: bool(true), right: bool(false) })).toBe(false);
    expect(evaluate({ kind: 'or', left: bool(false), right: bool(true) })).toBe(true);
    expect(evaluate({ kind: 'not', operand: bool(false) })).toBe(true);
  });

  it('evaluates both sides of and', () => {
    // No short-circuit: `prediction != "" and case.metadata.typo` must raise, not pass
    // because the left side was already false.
    expect(() => evaluate({ kind: 'and', left: bool(false), right: metadata('typo') })).toThrow(
      RuntimeEvalError,
    );
  });

  it('evaluates both sides of or', () => {
    expect(() => evaluate({ kind: 'or', left: bool(true), right: metadata('typo') })).toThrow(
      RuntimeEvalError,
    );
  });
});

describe('AssertMetric', () => {
  it('scores one and names itself when the predicate holds', async () => {
    const metric = new AssertMetric({ expr: passing, message: 'must mention the refund' });
    const result = await metric.score(entry, 'your refund is on its way');
    expect(result.metric).toBe('assert');
    expect(result.score).toBe(1);
  });

  it('has no detail when the predicate holds', async () => {
    const metric = new AssertMetric({ expr: passing, message: 'must mention the refund' });
    const result = await metric.score(entry, 'your refund is on its way');
    expect(result.passed).toBe(true);
    expect(result.detail).toBe('');
  });

  it('scores zero with the declared message when the predicate is false', async () => {
    const metric = new AssertMetric({ expr: passing, message: 'must mention the refund' });
    const result = await metric.score(entry, 'we cannot help with that');
    expect(result.score).toBe(0);
    expect(result.passed).toBe(false);
    // Verbatim: the point of letting the author write the message is that a failing
    // run quotes them.
    expect(result.detail).toBe('must mention the refund');
  });

  it('reports the message, not a rendered expression', async () => {
    const metric = new AssertMetric({ expr: passing, message: 'must mention the refund' });
    const result = await metric.score(entry, 'we cannot help with that');
    expect(result.detail).toBe('must mention the refund');
    expect(result.detail).not.toContain('contains');
  });

  it('raises instead of scoring zero on an undecidable predicate', async () => {
    const metric = new AssertMetric({ expr: metadata('missing'), message: 'unreachable' });
    await expect(metric.score(entry, 'anything')).rejects.toThrow(RuntimeEvalError);
  });

  it('is deterministic and named', () => {
    const metric = new AssertMetric({ expr: passing, message: 'm' });
    expect(metric.deterministic).toBe(true);
    expect(metric.name).toBe('assert');
  });

  it('is not in the default set', () => {
    // A default metric applies to every eval; an assertion is always authored.
    expect(defaultMetrics().map((metric) => metric.name)).not.toContain('assert');
  });
});
