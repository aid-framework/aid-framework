/**
 * The declaration half of the plugin: the manifest, and the claims it makes.
 *
 * The manifest is written out in this package rather than aliased from
 * `@aid/generator-sdk`, so that the SDK's declaration of the `py-fastapi` target and
 * this package's declaration of what it emits are two objects that have to be checked
 * against each other. That check lives here because it is the only place both are
 * visible: the SDK cannot import a generator, and a test that compared the SDK
 * declaration with itself would pass no matter what this package declared.
 *
 * Every block below ends with something that has been shown to fail, because a check
 * that cannot fail is not a check.
 */

import { join } from 'node:path';
import {
  checkIRSupport,
  GENERATOR_MANIFEST_VERSION,
  type GeneratorManifestInput,
  managedRoots,
  parseManifest,
  PY_FASTAPI_MANIFEST as SDK_DECLARATION,
  supportsIR,
  validatePlan,
} from '@aid/generator-sdk';

import { IR_VERSION } from '@aid/ir';
import { describe, expect, it } from 'vitest';

import {
  MANIFEST_PATH,
  PY_FASTAPI_MANIFEST,
  PY_FASTAPI_MANIFEST_INPUT,
  PY_FASTAPI_TARGET,
  planPyFastApi,
  pyFastApiGenerator,
  supportsIrVersion,
} from '../src/index.js';
import { example, examplePlan, REPO_ROOT, readTree } from './helpers.js';

const PACKAGE_ROOT = join(REPO_ROOT, 'packages', 'generators', 'py-fastapi');

/** The roots the plan writes into, derived from the manifest under test. */
function roots() {
  return managedRoots(PY_FASTAPI_MANIFEST);
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function show(value: unknown): string {
  if (value === undefined) return 'undefined';
  return JSON.stringify(value) ?? String(value);
}

/**
 * The dotted paths at which two JSON-shaped declarations differ.
 *
 * `toEqual` on two manifests reports both whole objects, which buries the one field
 * that drifted. This names it instead, and being pure it is testable from literals:
 * a key on one side only, a changed scalar, a different array length, a changed
 * element.
 */
function manifestDifferences(left: unknown, right: unknown, path = ''): string[] {
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) {
      return [`${path}: length ${left.length} != ${right.length}`];
    }
    return left.flatMap((entry, index) =>
      manifestDifferences(entry, right[index], `${path}[${index}]`),
    );
  }

  if (isMapping(left) && isMapping(right)) {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    return keys.flatMap((key) => {
      const child = path === '' ? key : `${path}.${key}`;
      if (!(key in left)) return [`${child}: missing on the left`];
      if (!(key in right)) return [`${child}: missing on the right`];
      return manifestDifferences(left[key], right[key], child);
    });
  }

  return Object.is(left, right) ? [] : [`${path}: ${show(left)} != ${show(right)}`];
}

describe('manifest parity with the SDK', () => {
  it('declares exactly what the SDK ships for this target', () => {
    expect(manifestDifferences(SDK_DECLARATION, PY_FASTAPI_MANIFEST)).toEqual([]);
  });

  it('is versioned, named and bound to this target', () => {
    expect(PY_FASTAPI_MANIFEST.manifestVersion).toBe(GENERATOR_MANIFEST_VERSION);
    expect(PY_FASTAPI_MANIFEST.name).toBe('@aid/generator-py-fastapi');
    expect(PY_FASTAPI_MANIFEST.target).toBe(PY_FASTAPI_TARGET);
    expect(PY_FASTAPI_MANIFEST.version.split('.')).toHaveLength(3);
  });

  it('reports differences, and at the path that differs', () => {
    expect(manifestDifferences({ a: 1 }, { a: 1 })).toEqual([]);
    expect(manifestDifferences({ a: 1 }, { a: 2 })).toEqual(['a: 1 != 2']);
    expect(manifestDifferences({ a: 1, b: 2 }, { a: 1 })).toEqual(['b: missing on the right']);
    expect(manifestDifferences({ a: 1 }, { a: 1, b: 2 })).toEqual(['b: missing on the left']);
    expect(manifestDifferences({ a: { b: 1 } }, { a: { b: 2 } })).toEqual(['a.b: 1 != 2']);
    expect(manifestDifferences({ a: [1] }, { a: [1, 2] })).toEqual(['a: length 1 != 2']);
    expect(manifestDifferences({ a: [1, 2] }, { a: [1, 3] })).toEqual(['a[1]: 2 != 3']);
    expect(manifestDifferences({ a: 1 }, { a: '1' })).toEqual(['a: 1 != "1"']);
    expect(manifestDifferences({ a: 'x' }, {})).toEqual(['a: missing on the right']);
  });

  it('would notice this package declaring an orchestration framework', () => {
    // The parity check above is only worth running if the thing it compares can move.
    // This is the same comparison with one field changed, through the real parser.
    const result = parseManifest({
      ...PY_FASTAPI_MANIFEST_INPUT,
      emitsAgainst: { ...PY_FASTAPI_MANIFEST_INPUT.emitsAgainst, orchestration: 'langgraph' },
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.manifest?.emitsAgainst.orchestration).toBe('langgraph');
    expect(manifestDifferences(SDK_DECLARATION, result.manifest)).toEqual([
      'emitsAgainst.orchestration: missing on the left',
    ]);
  });
});

describe('emitsAgainst', () => {
  it('binds structured output to Pydantic and tracing to OTel GenAI', () => {
    expect(PY_FASTAPI_MANIFEST.emitsAgainst.structuredOutput).toBe('pydantic');
    expect(PY_FASTAPI_MANIFEST.emitsAgainst.tracing).toBe('otel-genai');
  });

  it('declares no orchestration, because Phase 0 control flow is plain async', () => {
    expect(PY_FASTAPI_MANIFEST.emitsAgainst.orchestration).toBeUndefined();
    expect(PY_FASTAPI_MANIFEST_INPUT.emitsAgainst?.orchestration).toBeUndefined();
    expect(Object.keys(PY_FASTAPI_MANIFEST.emitsAgainst).sort()).toEqual([
      'structuredOutput',
      'tracing',
    ]);
    expect(PY_FASTAPI_MANIFEST.capabilities).not.toContain('orchestration');
  });
});

describe('the IR contract', () => {
  it('covers the current IR version and reports when it does not', () => {
    expect(checkIRSupport(PY_FASTAPI_MANIFEST)).toEqual([]);
    expect(supportsIR(PY_FASTAPI_MANIFEST)).toBe(true);
    expect(supportsIrVersion(IR_VERSION)).toBe(true);
    expect(supportsIrVersion('99.0.0')).toBe(false);
  });

  it('plans from the IR alone, with no filesystem or clock in the source', () => {
    // "Consume only the IR" is a structural claim, so it is checked structurally:
    // the package cannot read a spec, a template directory or the environment if it
    // never imports a way to. Runtime impurity would also break determinism, which is
    // why these markers rather than imports alone.
    const markers = [
      'node:fs',
      "from 'fs'",
      'node:child_process',
      'node:os',
      'process.env',
      'process.cwd',
      'process.platform',
      'Date.now',
      'new Date(',
      'Math.random',
      'crypto.randomUUID',
    ];

    const sources = [...readTree(join(PACKAGE_ROOT, 'src'))].filter(([path]) =>
      path.endsWith('.ts'),
    );
    expect(sources.length).toBeGreaterThan(15);

    const offenders: string[] = [];
    for (const [path, content] of sources) {
      for (const [index, line] of content.split('\n').entries()) {
        for (const marker of markers) {
          if (line.includes(marker)) offenders.push(`src/${path}:${index + 1}: ${line.trim()}`);
        }
      }
    }

    expect(offenders).toEqual([]);
    expect(sources.map(([path]) => path)).toContain('index.ts');
    expect(sources.map(([path]) => path)).toContain('emit/pipelines.ts');
  });

  it('is pure in the observable sense: the same IR plans to the same bytes twice', () => {
    const { ir } = example();
    const first = planPyFastApi(ir);
    const second = planPyFastApi(ir);

    expect(second.files).not.toBe(first.files);
    expect(second.files).toEqual(first.files);
  });
});

describe('the layout', () => {
  it('puts both managed tiers under one root, with the manifest beside them', () => {
    expect(roots()).toEqual({
      generatedDir: 'app/generated',
      businessDir: 'app/business',
      manifestFilename: MANIFEST_PATH,
    });
  });

  it('accepts a plan written in its own layout', () => {
    expect(
      validatePlan(
        {
          files: [
            { path: 'app/generated/main.py', content: 'x = 1\n', owner: 'generated' },
            { path: 'app/business/handlers.py', content: '# stub\n', owner: 'business' },
          ],
        },
        roots(),
      ),
    ).toEqual([]);
  });

  it('rejects, naming the file, anything the plan may not write', () => {
    const cases: { name: string; plan: unknown; code: string }[] = [
      {
        name: 'a path outside both managed roots',
        plan: {
          files: [{ path: 'app/other/handwritten.py', content: 'x = 1\n', owner: 'generated' }],
        },
        code: 'generator/plan-owner-mismatch',
      },
      {
        name: 'the manifest itself',
        plan: { files: [{ path: 'app/aid.manifest.json', content: '{}\n', owner: 'generated' }] },
        code: 'generator/plan-invalid-path',
      },
      {
        name: 'an absolute path',
        plan: { files: [{ path: 'C:/tmp/main.py', content: 'x = 1\n', owner: 'generated' }] },
        code: 'generator/plan-invalid-path',
      },
      {
        name: 'a path that escapes the root',
        plan: { files: [{ path: '../../outside.py', content: 'x = 1\n', owner: 'generated' }] },
        code: 'generator/plan-invalid-path',
      },
      {
        name: 'a generated path claimed as business',
        plan: { files: [{ path: 'app/generated/main.py', content: 'x = 1\n', owner: 'business' }] },
        code: 'generator/plan-owner-mismatch',
      },
      {
        name: 'the same path twice',
        plan: {
          files: [
            { path: 'app/generated/main.py', content: 'x = 1\n', owner: 'generated' },
            { path: 'app/generated/main.py', content: 'x = 2\n', owner: 'generated' },
          ],
        },
        code: 'generator/plan-duplicate-path',
      },
      { name: 'an empty plan', plan: { files: [] }, code: 'generator/plan-empty' },
    ];

    for (const { name, plan, code } of cases) {
      const diagnostics = validatePlan(plan, roots());
      expect(diagnostics.length, name).toBeGreaterThan(0);
      expect(diagnostics[0]?.code, name).toBe(code);
      expect(diagnostics[0]?.severity, name).toBe('error');
    }
  });
});

describe('the generator object', () => {
  it('takes every identity field off the manifest', () => {
    expect(pyFastApiGenerator.name).toBe(PY_FASTAPI_MANIFEST.name);
    expect(pyFastApiGenerator.target).toBe(PY_FASTAPI_MANIFEST.target);
    expect(pyFastApiGenerator.version).toBe(PY_FASTAPI_MANIFEST.version);
    expect(pyFastApiGenerator.irRange).toBe(PY_FASTAPI_MANIFEST.irRange);
  });

  it('hands the plan back unchanged', () => {
    const plan = examplePlan();
    expect(pyFastApiGenerator.emit(plan, { generatorVersion: 'ignored', root: 'ignored' })).toBe(
      plan.files,
    );
  });

  it('plans the example through the generator object the same way as directly', () => {
    const { ir } = example();
    expect(pyFastApiGenerator.plan(ir, { generatorVersion: 'ignored', root: 'ignored' })).toEqual(
      planPyFastApi(ir),
    );
  });
});

describe('the manifest input this package exports', () => {
  it('parses to the manifest the package uses', () => {
    const result = parseManifest(PY_FASTAPI_MANIFEST_INPUT);
    expect(result.diagnostics).toEqual([]);
    expect(result.manifest).toEqual(PY_FASTAPI_MANIFEST);
  });

  it('is the input other manifests are compared against in this file', () => {
    // Guards against the parity test above being fed a hand-built object.
    const input: GeneratorManifestInput = PY_FASTAPI_MANIFEST_INPUT;
    expect(input.name).toBe(PY_FASTAPI_MANIFEST.name);
  });
});
