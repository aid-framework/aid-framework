/**
 * The `cost` and `latency` eval metrics as this target emits them.
 *
 * Both are budgets over a number the harness already measures around each case -- the
 * gateway ledger delta and the elapsed time of the runner call -- so the generator maps
 * them onto real runtime metrics instead of refusing them. What is pinned here is the
 * artifact: the declared budget reaches the ceiling constructor, and `checkPlan` no
 * longer reports either kind as unmeasurable.
 *
 * The spec is the committed example with two metrics injected, so the eval under test is
 * a real one -- a real target, dataset and prompt -- rather than a hand-built document
 * that could pass while the example's shape stays broken.
 */

import { describe, expect, it } from 'vitest';

import { checkPlan } from '../src/validate.js';
import { buildForSpecText, exampleSpecText } from './helpers.js';

const COST_USD = 0.05;
const LATENCY_MS = 1200;

function injected(): string {
  const text = exampleSpecText().replace(
    '      - kind: json-schema\n        schema: Answer\n',
    '      - kind: json-schema\n        schema: Answer\n' +
      '      - kind: cost\n' +
      `        max: ${COST_USD}\n` +
      '      - kind: latency\n' +
      `        maxMs: ${LATENCY_MS}\n`,
  );

  // A silent no-op replacement would leave the eval without either metric and make every
  // assertion below vacuous.
  if (!text.includes('kind: cost') || !text.includes('kind: latency')) {
    throw new Error('the injection did not land');
  }
  return text;
}

function source(id: string, text = injected()): string {
  const { plan } = buildForSpecText(text);
  const file = plan.files.find((candidate) => candidate.path.endsWith(`evals/${id}.py`));
  if (file === undefined) {
    throw new Error(
      `no eval module for ${id}; the plan has:\n${plan.files.map((f) => f.path).join('\n')}`,
    );
  }
  return file.content;
}

describe('the emitted cost and latency metrics', () => {
  it('constructs each ceiling from the budget the spec declared', () => {
    const text = source('classify_quality');

    // The literal, not a hoisted constant: a ceiling has no structure worth naming, and a
    // constant would let the emitted value drift from the spec without the plan noticing.
    expect(text).toContain(`CostCeiling(max_usd=${COST_USD})`);
    expect(text).toContain(`LatencyCeiling(max_ms=${LATENCY_MS})`);
  });

  it('imports both classes from the package that defines them', () => {
    const text = source('classify_quality');
    const start = text.indexOf('from aid_runtime.evals import');
    if (start === -1) throw new Error('the module imports nothing from aid_runtime.evals');

    // The import is parenthesised once it has more than a couple of names, so the block is
    // read to its closing paren rather than to the end of the first line.
    const end = text.indexOf('\n)', start);
    if (end === -1) throw new Error('the aid_runtime.evals import is not closed');
    const block = text.slice(start, end);

    expect(block).toContain('CostCeiling');
    expect(block).toContain('LatencyCeiling');
  });

  it('no longer reports either kind as unmeasurable', () => {
    const { ir } = buildForSpecText(injected());
    const codes = checkPlan(ir).map((problem) => problem.code);

    expect(codes).not.toContain('unsupported-metric');
  });
});
