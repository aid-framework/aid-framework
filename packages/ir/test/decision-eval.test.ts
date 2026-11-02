/**
 * A `decision` metric reaches the IR as a reference to a declared decision.
 *
 * The metric carries no threshold, because the runtime refuses to gate on a value a
 * model produced. Pinning the exact shape keeps a knob from creeping back in.
 */

import { buildIR } from '@aid-framework/ir';
import { checkSpecText } from '@aid-framework/spec';
import { describe, expect, it } from 'vitest';

import { byId, fixtureText } from './helpers.js';

const checked = checkSpecText(fixtureText('decision-metric.yaml'), {
  file: 'decision-metric.yaml',
});
if (!checked.ok) {
  throw new Error(checked.diagnostics.map((diagnostic) => diagnostic.code).join(', '));
}

const { ir, diagnostics } = buildIR(checked.value, { file: 'decision-metric.yaml' });

describe('the decision metric in the IR', () => {
  it('builds the fixture without diagnostics', () => {
    expect(diagnostics).toEqual([]);
  });

  it('carries the declared decision by id', () => {
    const metric = byId(ir.evals, 'answer_quality').metrics.find(
      (candidate) => candidate.kind === 'decision',
    );
    expect(metric).toEqual({ kind: 'decision', decision: 'helpfulness' });
  });

  it('references a decision the IR declares', () => {
    const metric = byId(ir.evals, 'answer_quality').metrics.find(
      (candidate) => candidate.kind === 'decision',
    );
    if (metric?.kind !== 'decision') throw new Error('no decision metric');
    expect(ir.decisions.map((decision) => decision.id)).toContain(metric.decision);
  });
});
