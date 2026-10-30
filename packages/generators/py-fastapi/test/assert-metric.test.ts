/**
 * The `assert` metric as this target emits it.
 *
 * The generated eval hoists the parsed predicate to a module constant and floors the
 * assert threshold, because a 0/1 metric compared against a sampling allowance is
 * exactly the case that allowance cannot protect. What is pinned here is the artifact:
 * the constant, the `AssertMetric(...)` call, the import, and the floor on the right
 * threshold and on no other.
 *
 * The spec is the committed example with one metric injected, so the eval under test is
 * a real one -- a real target, dataset and prompt -- rather than a hand-built document
 * that could pass while the example's shape stays broken.
 */

import { describe, expect, it } from 'vitest';

import { buildForSpecText, exampleSpecText } from './helpers.js';

const MESSAGE = 'must mention the refund';

function injected(): string {
  const text = exampleSpecText()
    .replace(
      '      - kind: json-schema\n        schema: Answer\n',
      '      - kind: json-schema\n        schema: Answer\n' +
        '      - kind: assert\n' +
        `        expr: "prediction != '' and contains(prediction, 'refund')"\n` +
        `        message: ${MESSAGE}\n`,
    )
    .replace(
      '      maxRegression: 0.05\n      samples: 5\n',
      '      maxRegression: 0.05\n      samples: 5\n      minMean: 1\n',
    );

  // A silent no-op replacement would leave the eval without an assert metric and make
  // half the assertions below vacuous.
  if (!text.includes('kind: assert') || !text.includes('minMean: 1')) {
    throw new Error('the injection did not land');
  }
  return text;
}

function evalSource(id: string, text = injected()): string {
  const { plan } = buildForSpecText(text);
  const file = plan.files.find((candidate) => candidate.path.endsWith(`evals/${id}.py`));
  if (file === undefined) {
    throw new Error(
      `no eval module for ${id}; the plan has:\n${plan.files.map((f) => f.path).join('\n')}`,
    );
  }
  return file.content;
}

function lineWith(source: string, needle: string): string {
  const found = source.split('\n').find((line) => line.includes(needle));
  if (found === undefined) throw new Error(`no line containing ${needle} in:\n${source}`);
  return found;
}

/** The JSON object literal assigned to `name`, parsed. */
function parsedConstant(source: string, name: string): unknown {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`${name} = {`));
  if (start === -1) throw new Error(`no \`${name} = {\` in:\n${source}`);

  const end = lines.findIndex((line, index) => index > start && line === '}');
  if (end === -1) throw new Error(`the literal for ${name} is not closed at column 0`);

  // Joined as written, so a literal the module could not import fails here rather than
  // in the consumer's app. Trailing commas are Python-legal and JSON-illegal, and the
  // emitter writes them, so they are dropped rather than treated as a defect.
  const literal = lines
    .slice(start, end + 1)
    .join('\n')
    .slice(`${name} = `.length)
    .replace(/,(\s*[\]}])/g, '$1');

  return JSON.parse(literal);
}

describe('the emitted assert metric', () => {
  it('hoists the parsed predicate to a module constant', () => {
    const source = evalSource('classify_quality');

    // The AST, not the source text. Emitting the string would mean the generated module
    // re-parses it at import time, and a parser on that side could disagree with the one
    // that decided at build time whether the predicate was well formed.
    expect(parsedConstant(source, 'ASSERT_EXPR')).toEqual({
      kind: 'and',
      left: {
        kind: 'comparison',
        left: { kind: 'path', path: 'prediction' },
        op: '!=',
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
    });
    expect(source).not.toContain("prediction != ''");
  });

  it('names the metric assert and carries the declared message verbatim', () => {
    expect(evalSource('classify_quality')).toContain(
      `AssertMetric(expr=ASSERT_EXPR, message="${MESSAGE}")`,
    );
  });

  it('imports AssertMetric from the runtime package', () => {
    const source = evalSource('classify_quality');
    // The import is a parenthesized block, so the name lives on its own line rather than
    // on the `from` line.
    expect(source).toContain('from aid_runtime.evals import (\n    AssertMetric,\n');
  });

  it('floors the assert threshold and only the assert threshold', () => {
    const source = evalSource('classify_quality');
    const assertThreshold = lineWith(source, 'metric="assert"');
    expect(assertThreshold).toContain('min_mean=1');
    expect(assertThreshold).toContain('max_regression=MAX_REGRESSION');

    const other = lineWith(source, 'metric="json-valid"');
    expect(other).not.toContain('min_mean=');
  });

  it('emits nothing assert-shaped for an eval that declares no assert', () => {
    const source = evalSource('handbook_quality');
    expect(source).not.toContain('ASSERT_EXPR');
    expect(source).not.toContain('AssertMetric');
    expect(source).not.toContain('min_mean=');
  });

  it('leaves the uninjected example byte-identical to what it ships', () => {
    // The floor is opt-in: an eval without an assert, planned from the example as
    // authored, must still emit exactly the bytes the golden test compares. This is the
    // local form of that guarantee, stated where the assert work could break it.
    const { plan } = buildForSpecText(exampleSpecText());
    const file = plan.files.find((candidate) =>
      candidate.path.endsWith('evals/classify_quality.py'),
    );
    expect(file?.content).not.toContain('ASSERT_EXPR');
    expect(file?.content).not.toContain('min_mean=');
    expect(file?.content).toContain(
      'Threshold(metric="json-valid", max_regression=MAX_REGRESSION)',
    );
  });

  it('keeps every emitted line inside the formatter width', () => {
    // The fold ruff would apply is applied here, so `ruff format --check` stays clean in
    // the consumer's project instead of being a thing they have to fix. The hoisted AST
    // is the one construct whose literal is long enough to matter.
    for (const id of ['classify_quality', 'handbook_quality']) {
      for (const line of evalSource(id).split('\n')) {
        expect(line.length, `${id}: ${line}`).toBeLessThanOrEqual(100);
      }
    }
  });
});
