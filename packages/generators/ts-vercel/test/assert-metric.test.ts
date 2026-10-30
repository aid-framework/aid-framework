/**
 * The `assert` metric as this target emits it.
 *
 * Mirror of the py-fastapi suite's `assert-metric.test.ts`, over the same injected
 * example spec: the constant, the `AssertMetric(...)` call, the import, and the floor
 * on the right threshold and on no other. The spec is the committed example with one
 * metric injected, so the eval under test is a real one rather than a hand-built
 * document that could pass while the example's shape stays broken.
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
  const file = plan.files.find((candidate) => candidate.path.endsWith(`evals/${id}.ts`));
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

/**
 * The object literal a `const NAME = { ... };` introduces, as the text between its
 * braces. Sliced by brace depth rather than by a regex, so a nested object closes the
 * outer one only when every inner brace has closed.
 */
function literalText(source: string, name: string): string {
  const start = source.indexOf(`const ${name} = {`);
  if (start === -1) throw new Error(`no \`const ${name} = {\` in:\n${source}`);

  let depth = 0;
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`the literal for ${name} is not closed`);
}

describe('the emitted assert metric', () => {
  it('hoists the parsed predicate to a module constant', () => {
    const source = evalSource('classify_quality');
    const literal = literalText(source, 'ASSERT_EXPR');

    // The AST, not the source text. Emitting the string would mean the generated module
    // re-parses it at import time, and a parser on that side could disagree with the one
    // that decided at build time whether the predicate was well formed.
    expect(literal).toContain("kind: 'and'");
    expect(literal).toContain("name: 'contains'");
    expect(literal).toContain("path: 'prediction'");
    expect(literal).toContain("value: 'refund'");
    expect(source).not.toContain("prediction != ''");
  });

  it('names the metric assert and carries the declared message verbatim', () => {
    expect(evalSource('classify_quality')).toContain(
      `new AssertMetric({ name: 'assert', expr: ASSERT_EXPR, message: '${MESSAGE}' })`,
    );
  });

  it('imports AssertMetric from the runtime package', () => {
    expect(evalSource('classify_quality')).toContain('  AssertMetric,\n');
  });

  it('floors the assert threshold and only the assert threshold', () => {
    const source = evalSource('classify_quality');
    expect(lineWith(source, 'const floors')).toContain('{ assert: 1 }');
    // `floors[metric]` is the only source of a floor, and the runtime treats an
    // undefined floor as unset -- so the metric the spec did not floor stays unfloored.
    expect(lineWith(source, 'maxRegression: 0.05, minMean')).toContain('minMean: floors[metric]');
  });

  it('declares the floor once', () => {
    // A second `const floors` in the same block is a TypeScript duplicate declaration:
    // the module would not compile, which a substring search for the floor would miss.
    const source = evalSource('classify_quality');
    const declarations = source.split('\n').filter((line) => line.includes('const floors'));
    expect(declarations).toHaveLength(1);
  });

  it('emits nothing assert-shaped for an eval that declares no assert', () => {
    const source = evalSource('handbook_quality');
    expect(source).not.toContain('ASSERT_EXPR');
    expect(source).not.toContain('AssertMetric');
    expect(source).not.toContain('minMean: floors');
    expect(source).not.toContain('const floors');
  });

  it('leaves the uninjected example byte-identical to what it ships', () => {
    // The floor is opt-in: an eval without an assert, planned from the example as
    // authored, must still emit exactly the bytes the golden test compares.
    const { plan } = buildForSpecText(exampleSpecText());
    const file = plan.files.find((candidate) =>
      candidate.path.endsWith('evals/classify_quality.ts'),
    );
    expect(file?.content).not.toContain('ASSERT_EXPR');
    // The prose says `minMean` stays unset, so the check is on the code that would set
    // one rather than on the whole module.
    expect(file?.content).not.toContain('minMean: floors');
    expect(file?.content).not.toContain('const floors');
    expect(file?.content).toContain(
      "const thresholds = ['json-schema'].map(\n    (metric) => new Threshold({ metric, maxRegression: 0.05 }),\n  );",
    );
  });

  it('keeps every emitted line inside the formatter width', () => {
    // The line the assert adds is the one long enough to matter; biome's lineWidth is
    // 100, and an over-long line would fail `biome ci` in the consumer's project.
    for (const id of ['classify_quality', 'handbook_quality']) {
      for (const line of evalSource(id).split('\n')) {
        expect(line.length, `${id}: ${line}`).toBeLessThanOrEqual(100);
      }
    }
  });
});
