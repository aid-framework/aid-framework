/**
 * The `assert` metric reaches the IR as a parsed predicate, not as source text.
 *
 * Three things are pinned here: the predicate survives the build as an AST, the
 * declared floor survives alongside it, and an unparsable expression is a build
 * failure rather than a metric that quietly scores zero.
 */

import { buildIR } from '@aid-framework/ir';
import { checkSpecText } from '@aid-framework/spec';
import { describe, expect, it } from 'vitest';

import { byId, codesOf, fixtureText } from './helpers.js';

const { ir, diagnostics } = buildIR(
  (() => {
    const checked = checkSpecText(fixtureText('assert-eval.yaml'), { file: 'assert-eval.yaml' });
    if (!checked.ok) {
      throw new Error(checked.diagnostics.map((diagnostic) => diagnostic.code).join(', '));
    }
    return checked.value;
  })(),
  { file: 'assert-eval.yaml' },
);

const asserted = byId(ir.evals, 'answer_shape');

describe('the assert metric in the IR', () => {
  it('builds the fixture without diagnostics', () => {
    expect(diagnostics).toEqual([]);
  });

  it('carries the predicate as an AST, never as the source string', () => {
    const metric = asserted.metrics.find((candidate) => candidate.kind === 'assert');
    expect(metric).toBeDefined();
    if (metric?.kind !== 'assert') throw new Error('no assert metric');
    // A source string here would mean every target re-parses it and can disagree
    // about what it means; the AST is the contract.
    expect(typeof metric.expr).toBe('object');
    expect(metric.expr.kind).toBe('and');
    expect(metric.message).toBe('the answer must mention the refund policy in a short reply');
  });

  it('keeps the message verbatim, including its spaces', () => {
    const metric = asserted.metrics.find((candidate) => candidate.kind === 'assert');
    if (metric?.kind !== 'assert') throw new Error('no assert metric');
    // The message is what a failing case reports, so trimming or re-casing it here
    // would change user-visible output.
    expect(metric.message).toContain('the answer must mention');
    expect(metric.message).not.toBe(metric.message.trim() + ' ');
  });

  it('keeps the declared floor and leaves it unset where the spec declared none', () => {
    expect(asserted.gate.minMean).toBe(1);
    expect(byId(ir.evals, 'triage_quality').gate.minMean).toBeUndefined();
  });

  it('never turns the assert into a pipeline step', () => {
    for (const pipeline of ir.pipelines) {
      expect(JSON.stringify(pipeline)).not.toContain('"assert"');
    }
  });
});

describe('an unparsable assert expression', () => {
  it('is plain text to the schema, so only the IR build can reject it', () => {
    // The expression is a string to the schema, so the *only* layer that can reject a
    // malformed predicate is the IR build. This pins that, so nobody later assumes the
    // schema already covers it and drops the IR check.
    const text = fixtureText('assert-eval.yaml').replace(
      `expr: "prediction != '' and contains(prediction, 'refund') and length(case.metadata.severity) < 8"`,
      'expr: "prediction <"',
    );
    const checked = checkSpecText(text, { file: 'broken.yaml' });
    expect(checked.ok).toBe(true);
  });

  it('produces predicate diagnostics and drops the metric', () => {
    const text = fixtureText('assert-eval.yaml').replace(
      `expr: "prediction != '' and contains(prediction, 'refund') and length(case.metadata.severity) < 8"`,
      `expr: "length(prediction)"`,
    );
    const checked = checkSpecText(text, { file: 'broken.yaml' });
    if (!checked.ok) throw new Error('fixture should pass the schema');
    const built = buildIR(checked.value, { file: 'broken.yaml' });
    expect(codesOf(built.diagnostics).some((code) => code.startsWith('ir/predicate'))).toBe(true);
  });

  it('drops the metric rather than emitting one that always passes', () => {
    const text = fixtureText('assert-eval.yaml').replace(
      `expr: "prediction != '' and contains(prediction, 'refund') and length(case.metadata.severity) < 8"`,
      `expr: "length(prediction)"`,
    );
    const checked = checkSpecText(text, { file: 'broken.yaml' });
    if (!checked.ok) throw new Error('fixture should pass the schema');
    const built = buildIR(checked.value, { file: 'broken.yaml' });
    const evaluation = built.ir.evals.find((candidate) => candidate.id === 'answer_shape');
    expect(evaluation?.metrics.some((metric) => metric.kind === 'assert')).toBe(false);
  });

  it('does not silently keep a metric whose expression it could not read', () => {
    const text = fixtureText('assert-eval.yaml').replace(
      `expr: "prediction != '' and contains(prediction, 'refund') and length(case.metadata.severity) < 8"`,
      `expr: "prediction ==="`,
    );
    const checked = checkSpecText(text, { file: 'broken.yaml' });
    if (!checked.ok) throw new Error('fixture should pass the schema');
    const built = buildIR(checked.value, { file: 'broken.yaml' });
    expect(built.diagnostics.length).toBeGreaterThan(0);
    const evaluation = built.ir.evals.find((candidate) => candidate.id === 'answer_shape');
    expect(evaluation?.metrics.some((metric) => metric.kind === 'assert')).toBe(false);
  });
});
