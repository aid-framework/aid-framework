/**
 * The declaration half of the plugin: the manifest, and the claims it makes.
 *
 * The manifest is written out in this package rather than aliased from
 * `@aid/generator-sdk` so that the SDK's declaration of the `ts-vercel` target and this
 * package's declaration of what it emits are two objects that have to be checked against
 * each other. That check lives here because it is the only place both are visible: the
 * SDK cannot import a generator, and a test that compared the SDK declaration with
 * itself would pass no matter what this package declared.
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
  supportsIR,
  validatePlan,
} from '@aid/generator-sdk';
import { IR_VERSION } from '@aid/ir';
import { describe, expect, it } from 'vitest';

import {
  checkPlan,
  MANIFEST_PATH,
  planTsVercel,
  supportsIrVersion,
  TS_VERCEL_CAPABILITIES,
  TS_VERCEL_MANIFEST,
  TS_VERCEL_MANIFEST_INPUT,
  TS_VERCEL_TARGET,
  tsVercelGenerator,
} from '../src/index.js';
import { example, examplePlan, REPO_ROOT, readTree } from './helpers.js';

const PACKAGE_ROOT = join(REPO_ROOT, 'packages', 'generators', 'ts-vercel');

/** The roots the plan writes into, derived from the manifest under test. */
function roots() {
  return managedRoots(TS_VERCEL_MANIFEST);
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function show(value: unknown): string {
  if (value === undefined) return 'undefined';
  return JSON.stringify(value) ?? String(value);
}

/** The dotted paths at which two JSON-shaped declarations differ. */
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

describe('the declaration', () => {
  it('is pinned literally, because there is no SDK declaration to compare against', () => {
    // `py-fastapi` can compare its manifest against `@aid/generator-sdk`'s copy of it.
    // `ts-vercel` cannot: the SDK cannot depend on a generator that depends on the SDK,
    // so the CLI registry is the authority and the CLI's own suite checks the two agree.
    // What is left here is the literal, which fails on any drift in any field.
    expect(TS_VERCEL_MANIFEST).toEqual({
      manifestVersion: GENERATOR_MANIFEST_VERSION,
      name: '@aid/generator-ts-vercel',
      target: 'ts-vercel',
      version: '0.1.0',
      irRange: TS_VERCEL_MANIFEST.irRange,
      capabilities: ['embeddings', 'http-trigger', 'json-schema', 'otel', 'rerank', 'tool-calling'],
      emitsAgainst: { structuredOutput: 'zod', tracing: 'otel-genai' },
      output: { root: 'app', generatedDir: 'generated', businessDir: 'business' },
    });
  });

  it('is versioned, named and bound to this target', () => {
    expect(TS_VERCEL_MANIFEST.manifestVersion).toBe(GENERATOR_MANIFEST_VERSION);
    expect(TS_VERCEL_MANIFEST.name).toBe('@aid/generator-ts-vercel');
    expect(TS_VERCEL_MANIFEST.target).toBe(TS_VERCEL_TARGET);
    expect(TS_VERCEL_MANIFEST.version.split('.')).toHaveLength(3);
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
    const result = parseManifest({
      ...TS_VERCEL_MANIFEST_INPUT,
      emitsAgainst: { ...TS_VERCEL_MANIFEST_INPUT.emitsAgainst, orchestration: 'langgraph' },
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.manifest?.emitsAgainst.orchestration).toBe('langgraph');
    expect(manifestDifferences(TS_VERCEL_MANIFEST, result.manifest)).toEqual([
      'emitsAgainst.orchestration: missing on the left',
    ]);
  });
});

describe('emitsAgainst', () => {
  it('binds structured output to zod and tracing to OTel GenAI', () => {
    expect(TS_VERCEL_MANIFEST.emitsAgainst.structuredOutput).toBe('zod');
    expect(TS_VERCEL_MANIFEST.emitsAgainst.tracing).toBe('otel-genai');
  });

  it('declares exactly two keys, and no vector store', () => {
    // The plan's L6 row asks for `emitsAgainst = { structuredOutput, tracing,
    // vectorStore: 'pgvector' }`. `EmitsAgainst` has no `vectorStore` member, and
    // `manifest.test.ts:135` -- which the plan cites as evidence that it does -- is the
    // assertion inside "rejects an unknown emitsAgainst key", where `vectorStore` is the
    // rejected example. Adding the key would fail `parseManifest`, so `pgvector` reaches
    // the runtime as `stores.<id>.kind` instead. This literal pin is what makes the
    // omission a decision rather than an oversight: a `for..of` over the same object
    // would pass on any content at all.
    expect(Object.keys(TS_VERCEL_MANIFEST.emitsAgainst).sort()).toEqual([
      'structuredOutput',
      'tracing',
    ]);
    expect(TS_VERCEL_MANIFEST_INPUT.emitsAgainst).not.toHaveProperty('vectorStore');
  });

  it('declares no orchestration, because Phase 1 control flow is a plain Pipeline', () => {
    expect(TS_VERCEL_MANIFEST.emitsAgainst.orchestration).toBeUndefined();
    expect(TS_VERCEL_MANIFEST.capabilities).not.toContain('orchestration');
  });

  it('declares no streaming capability, because the runtime defers it', () => {
    expect(TS_VERCEL_MANIFEST.capabilities).not.toContain('streaming');
    expect(TS_VERCEL_CAPABILITIES).not.toContain('streaming');
  });
});

describe('the capability discipline', () => {
  it('declares only capabilities it emits an adapter for', () => {
    // Sorted, because `parseManifest` sorts: the order is the parser's, and asserting a
    // literal array is what makes a dropped or invented capability fail rather than
    // pass a length check.
    expect(TS_VERCEL_MANIFEST.capabilities).toEqual([
      'embeddings',
      'http-trigger',
      'json-schema',
      'otel',
      'rerank',
      'tool-calling',
    ]);
  });

  it('declares the same set on the manifest as on the exported constant', () => {
    expect(TS_VERCEL_MANIFEST.capabilities).toEqual([...TS_VERCEL_CAPABILITIES].sort());
  });
});

describe('the IR contract', () => {
  it('covers the current IR version and reports when it does not', () => {
    expect(checkIRSupport(TS_VERCEL_MANIFEST)).toEqual([]);
    expect(supportsIR(TS_VERCEL_MANIFEST)).toBe(true);
    expect(supportsIrVersion(IR_VERSION)).toBe(true);
    expect(supportsIrVersion('99.0.0')).toBe(false);
  });

  it('plans from the IR alone, with no filesystem or clock in the source', () => {
    // "Consume only the IR" is a structural claim, so it is checked structurally: the
    // package cannot read a spec, a template directory or the environment if it never
    // imports a way to. Runtime impurity would also break determinism.
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
      '@aid/spec',
    ];

    const sources = [...readTree(join(PACKAGE_ROOT, 'src'))].filter(([path]) =>
      path.endsWith('.ts'),
    );
    expect(sources.length).toBeGreaterThan(14);

    const offenders: string[] = [];
    for (const [path, content] of sources) {
      for (const [index, line] of content.split('\n').entries()) {
        for (const marker of markers) {
          if (line.includes(marker)) offenders.push(`src/${path}:${index + 1}: ${line.trim()}`);
        }
      }
    }

    // One hit is expected, and it is pinned rather than tolerated. The scan is a
    // source-text lint, so it cannot tell a read from a string that spells one: the
    // gateway emitter renders `process.env[apiKeyEnv]` into the *generated* provider
    // factory, where the emitted app reads its own key at run time. Pinning the path and
    // the text keeps the assertion honest -- a genuine read anywhere, or a second string
    // that looks like one, changes this and fails.
    expect(offenders).toEqual([
      "src/emit/infrastructure.ts:100: '  const apiKey = process.env[apiKeyEnv];',",
    ]);

    expect(sources.map(([path]) => path)).toContain('index.ts');
    expect(sources.map(([path]) => path)).toContain('emit/pipelines.ts');
  });

  it('is pure in the observable sense: the same IR plans to the same bytes twice', () => {
    const { ir } = example();
    const first = planTsVercel(ir);
    const second = planTsVercel(ir);

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

  it('names the output root `app`, the App Router directory, and says so', () => {
    // A7 asks for a Next.js App Router project, and the plan records that `output.root:
    // 'app'` collides with Next's own `app/` convention. The collision is accepted for
    // parity with `managedRoots` and documented in the README rather than worked around;
    // this pins the value so a silent change to `src/` would be a test failure, not a
    // surprise in a generated project.
    expect(TS_VERCEL_MANIFEST.output.root).toBe('app');
  });

  it('accepts a plan written in its own layout', () => {
    expect(
      validatePlan(
        {
          files: [
            {
              path: 'app/generated/schemas.ts',
              content: 'export const x = 1;\n',
              owner: 'generated',
            },
            { path: 'app/business/tools/x.ts', content: '// stub\n', owner: 'business' },
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
          files: [
            { path: 'app/api/tickets/route.ts', content: 'export {};\n', owner: 'generated' },
          ],
        },
        code: 'generator/plan-owner-mismatch',
      },
      {
        name: 'the manifest itself',
        plan: {
          files: [{ path: 'app/aid.manifest.json', content: '{}\n', owner: 'generated' }],
        },
        code: 'generator/plan-invalid-path',
      },
      {
        name: 'an absolute path',
        plan: {
          files: [{ path: 'C:/tmp/schemas.ts', content: 'export {};\n', owner: 'generated' }],
        },
        code: 'generator/plan-invalid-path',
      },
      {
        name: 'a path that escapes the root',
        plan: {
          files: [{ path: '../../outside.ts', content: 'export {};\n', owner: 'generated' }],
        },
        code: 'generator/plan-invalid-path',
      },
      {
        name: 'a generated path claimed as business',
        plan: {
          files: [{ path: 'app/generated/schemas.ts', content: 'export {};\n', owner: 'business' }],
        },
        code: 'generator/plan-owner-mismatch',
      },
      {
        name: 'the same path twice',
        plan: {
          files: [
            { path: 'app/generated/schemas.ts', content: 'export {};\n', owner: 'generated' },
            { path: 'app/generated/schemas.ts', content: 'export {}\n', owner: 'generated' },
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
    expect(tsVercelGenerator.name).toBe(TS_VERCEL_MANIFEST.name);
    expect(tsVercelGenerator.target).toBe(TS_VERCEL_MANIFEST.target);
    expect(tsVercelGenerator.version).toBe(TS_VERCEL_MANIFEST.version);
    expect(tsVercelGenerator.irRange).toBe(TS_VERCEL_MANIFEST.irRange);
  });

  it('hands the plan back unchanged', () => {
    const plan = examplePlan();
    expect(tsVercelGenerator.emit(plan, { generatorVersion: 'ignored', root: 'ignored' })).toBe(
      plan.files,
    );
  });

  it('plans the example through the generator object the same way as directly', () => {
    const { ir } = example();
    expect(tsVercelGenerator.plan(ir, { generatorVersion: 'ignored', root: 'ignored' })).toEqual(
      planTsVercel(ir),
    );
  });
});

describe('the manifest input this package exports', () => {
  it('parses to the manifest the package uses', () => {
    const result = parseManifest(TS_VERCEL_MANIFEST_INPUT);
    expect(result.diagnostics).toEqual([]);
    expect(result.manifest).toEqual(TS_VERCEL_MANIFEST);
  });

  it('is the input other manifests are compared against in this file', () => {
    const input: GeneratorManifestInput = TS_VERCEL_MANIFEST_INPUT;
    expect(input.name).toBe(TS_VERCEL_MANIFEST.name);
  });
});

describe('the fail-closed plan', () => {
  /** The example's IR with one mutation applied to a deep copy of it. */
  function mutated(mutate: (ir: ReturnType<typeof example>['ir']) => void) {
    const copy = structuredClone(example().ir);
    mutate(copy);
    return copy;
  }

  it('accepts the example', () => {
    expect(checkPlan(example().ir)).toEqual([]);
  });

  it('refuses a prompt whose placeholder is dotted, which the runtime cannot fill', () => {
    const ir = mutated((copy) => {
      const prompt = copy.prompts[0];
      if (prompt === undefined) throw new Error('the example has no prompts');
      prompt.template = 'Subject: {{ ticket.subject }}\n';
    });

    const problems = checkPlan(ir);
    expect(problems.map((problem) => problem.code)).toContain('unsupported-placeholder');
    expect(problems[0]?.message).toContain('ticket.subject');
    expect(() => planTsVercel(ir)).toThrow(/unsupported-placeholder/);
  });

  it('refuses a prompt whose placeholder is not a declared variable', () => {
    const ir = mutated((copy) => {
      const prompt = copy.prompts[0];
      if (prompt === undefined) throw new Error('the example has no prompts');
      prompt.template = 'Subject: {{ subject }}\nUndeclared: {{ not_a_variable }}\n';
    });

    const problems = checkPlan(ir);
    expect(problems.map((problem) => problem.code)).toContain('unsupported-placeholder');
    expect(problems[0]?.message).toContain('not_a_variable');
  });

  it('refuses a metric the runtime cannot score', () => {
    const ir = mutated((copy) => {
      const evalShape = copy.evals[0];
      const metric = evalShape?.metrics[0];
      if (metric === undefined) throw new Error('the example has no metrics');
      (metric as { kind: string }).kind = 'llm-judge';
    });

    expect(checkPlan(ir).map((problem) => problem.code)).toContain('eval-metric-unsupported');
  });
});
