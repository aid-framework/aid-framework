import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import {
  checkSpecText,
  DEFERRED_STEP_KINDS,
  SUPPORTED_STEP_KINDS,
  specJsonSchema,
} from '../src/index.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Every file under a directory, recursively, as absolute paths. */
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return entry.isFile() ? [path] : [];
  });
}

function walkTypeScript(dir: string): string[] {
  return walk(dir).filter((path) => path.endsWith('.ts'));
}

/**
 * The `oneOf` arms of `$defs.step`, as the single required key each arm declares.
 *
 * Read from the shipped schema rather than from a constant, because the criterion is
 * about the schema the validator hands the compiler, not about a list we maintain.
 */
function stepSchemaDiscriminators(): string[] {
  const schema = specJsonSchema() as {
    $defs: { step: { oneOf: { required?: string[] }[] } };
  };
  return schema.$defs.step.oneOf.map((arm) => {
    const [kind] = arm.required ?? [];
    if (kind === undefined || arm.required?.length !== 1) {
      throw new Error(`a step arm must require exactly one discriminator, got ${arm.required}`);
    }
    return kind;
  });
}

describe('phase exit: nothing is deferred', () => {
  it('leaves DEFERRED_STEP_KINDS empty', () => {
    // The phase-exit criterion is mechanical: this list being empty *is* the exit.
    // Re-adding any kind here -- and `assert` in particular, which now has a metric arm
    // and a refusal for the step spelling -- fails this line.
    expect([...DEFERRED_STEP_KINDS]).toEqual([]);
  });

  it('gives every supported step kind a schema variant', () => {
    expect(stepSchemaDiscriminators().sort()).toEqual([...SUPPORTED_STEP_KINDS].sort());
  });

  it('does not accept a pipeline step spelled `assert`', () => {
    // `assert` resolves in the eval surface only. Widening `$defs.step` with one would
    // pass the leg above only after `SUPPORTED_STEP_KINDS` grew, so pin the absence here
    // too: the construct must have exactly one spelling.
    expect(stepSchemaDiscriminators()).not.toContain('assert');
    const result = checkSpecText(
      [
        'specVersion: "0.1"',
        'project:',
        '  name: p',
        'pipelines:',
        '  p:',
        '    trigger:',
        '      http:',
        '        method: post',
        '        path: /p',
        '    steps:',
        '      - assert:',
        '          expr: "prediction != \'\'"',
        '          message: empty',
        '',
      ].join('\n'),
    );
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });
});

describe('phase exit: every supported kind reaches both generators', () => {
  /**
   * True when `source` names `kind` as a step kind it handles.
   *
   * Generator `validate.ts` files are excluded on purpose: they *reject* unsupported
   * shapes, so a hit there would say nothing about emission. A kind has a generator
   * path when an emitter switches on it, which in both generators is spelled as a
   * `case '<kind>'` label or a `step.kind === '<kind>'` comparison.
   */
  function handlesKind(source: string, kind: string): boolean {
    return [`case '${kind}'`, `step.kind === '${kind}'`, `'${kind}' === step.kind`].some((needle) =>
      source.includes(needle),
    );
  }

  const generators = [
    ['py-fastapi', join(ROOT, 'packages/generators/py-fastapi/src')],
    ['ts-vercel', join(ROOT, 'packages/generators/ts-vercel/src')],
  ] as const;

  it.each(generators)('%s has an emission site for every supported step kind', (name, dir) => {
    const source = walkTypeScript(dir)
      .filter((path) => !path.endsWith('validate.ts'))
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n');
    expect(SUPPORTED_STEP_KINDS.filter((kind) => !handlesKind(source, kind))).toEqual([]);
    expect(name).toBeTruthy();
  });
});

describe('phase exit: the conformance corpus covers every supported kind', () => {
  it('covers every supported kind with a `steps.<kind>` case', () => {
    const corpus = JSON.parse(readFileSync(join(ROOT, 'conformance/corpus.json'), 'utf8')) as {
      cases: { op: string }[];
    };
    const ops = new Set(corpus.cases.map((entry) => entry.op));
    const missing = SUPPORTED_STEP_KINDS.filter((kind) => !ops.has(`steps.${kind}`));
    // Sorted and exact, with no exception list behind it: a kind without a case is the
    // whole failure, so this criterion cannot be reopened by adding a named exemption.
    expect([...missing].sort()).toEqual([]);
  });
});

describe('phase exit: shipped examples validate', () => {
  it('accepts every shipped spec fixture', () => {
    const examples = join(ROOT, 'examples');
    const specs = walk(examples).filter((path) => path.endsWith('.spec.yaml'));
    expect(specs.length).toBeGreaterThan(0);
    const failures = specs.flatMap((path) =>
      checkSpecText(readFileSync(path, 'utf8'), { file: path }).diagnostics.map(
        (diagnostic) => `${path}: ${diagnostic.code} ${diagnostic.message}`,
      ),
    );
    expect(failures).toEqual([]);
  });
});
