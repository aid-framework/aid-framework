/**
 * The committed example is the golden fixture.
 *
 * Rather than keep a second copy of the output under `__fixtures__`, these tests plan
 * the example's own spec and compare the result with the example's own committed tree.
 * The tree already has to exist -- it is what the example runs -- so there is nothing
 * extra to keep in sync, and a reviewer reading `examples/support-copilot` is reading
 * exactly the bytes asserted here.
 *
 * The last block is the falsifier: it takes the real shipped tree, changes one thing,
 * and shows the comparison reports it. A fixture test that has never been shown to
 * notice a difference is a test that may be asserting nothing at all.
 */

import {
  checkDeterminism,
  GENERATED_BANNER_MARKER,
  manifestFor,
  scanForNonDeterminism,
  serializeAidManifest,
  sha256Hex,
} from '@aid/generator-sdk';
import { describe, expect, it } from 'vitest';

import {
  buildForSpecText,
  diffTree,
  example,
  examplePlan,
  exampleSpecText,
  fileMap,
  firstDifference,
  formatMismatches,
  planFilesByOwner,
  provenanceFor,
  shippedGeneratedTree,
  shippedManagedTree,
  shippedManifest,
  without,
  withRewrite,
} from './helpers.js';

const CONTRACTS_INIT = 'app/generated/contracts/__init__.py';

function generated(): { path: string; content: string; owner: string }[] {
  return planFilesByOwner('generated');
}

describe('the committed example', () => {
  it('is the plan, byte for byte', () => {
    const shipped = shippedManagedTree();
    const mismatches = diffTree(examplePlan().files, shipped);
    expect(mismatches.length, formatMismatches(mismatches, shipped)).toBe(0);
  });

  it('holds the whole of both managed tiers, and only those', () => {
    const shipped = shippedManagedTree();
    // 27 rather than 25 since P7a: an input guardrail adds `generated/guardrails.py`,
    // and a `streaming: true` deployment adds `generated/sse.py`.
    expect(generated().length).toBe(27);
    expect(planFilesByOwner('business').length).toBe(4);
    expect(shipped.size).toBe(31);
  });

  it('records every generated file in aid.manifest.json at the hash of its bytes', () => {
    const manifest = shippedManifest();
    const wrong: string[] = [];

    for (const file of generated()) {
      const record = manifest.files.find((entry) => entry.path === file.path);
      if (record === undefined) {
        wrong.push(`${file.path}: not recorded`);
        continue;
      }
      if (record.owner !== 'generated') wrong.push(`${file.path}: owner ${record.owner}`);
      if (record.sha256 !== sha256Hex(file.content)) wrong.push(`${file.path}: sha256 mismatch`);
    }

    expect(wrong).toEqual([]);
  });

  it('records the developer-owned files as business, without a hash claim on them', () => {
    const manifest = shippedManifest();
    for (const file of planFilesByOwner('business')) {
      const record = manifest.files.find((entry) => entry.path === file.path);
      expect(record?.owner, file.path).toBe('business');
    }
  });

  it('records no files beyond the plan', () => {
    const manifest = shippedManifest();
    const planned = new Set(examplePlan().files.map((file) => file.path));
    expect(manifest.files.filter((file) => !planned.has(file.path)).map((f) => f.path)).toEqual([]);
  });

  it('records the generator, version and IR version that produced it', () => {
    expect(shippedManifest().generatedBy).toEqual(provenanceFor(example().ir));
  });

  it('agrees with the manifest on who owns each path', () => {
    const manifest = shippedManifest();
    const disagreements: string[] = [];
    for (const file of examplePlan().files) {
      const record = manifest.files.find((entry) => entry.path === file.path);
      if (record?.owner !== file.owner) {
        disagreements.push(`${file.path}: plan says ${file.owner}, manifest says ${record?.owner}`);
      }
    }
    expect(disagreements).toEqual([]);
  });
});

describe('the ownership banner', () => {
  it('tells the reader of a generated file not to edit it', () => {
    for (const file of generated()) {
      expect(file.content.startsWith(`# ${GENERATED_BANNER_MARKER}`), file.path).toBe(true);
    }
  });

  it('tells the reader of a business file that it is theirs, and never claims ownership', () => {
    for (const file of planFilesByOwner('business')) {
      const head = file.content.split('\n').slice(0, 2).join('\n');
      expect(head, file.path).toContain('Edit freely');
      expect(head, file.path).not.toContain('DO NOT EDIT');
      expect(head, file.path).not.toContain(GENERATED_BANNER_MARKER);
    }
  });
});

describe('determinism', () => {
  it('plans byte-identical files when the same spec is planned again', () => {
    const first = examplePlan();
    const second = buildForSpecText(exampleSpecText()).plan;

    expect(first.files).not.toBe(second.files);
    const left = fileMap(first.files);
    const right = fileMap(second.files);
    expect([...left.keys()]).toEqual([...right.keys()]);

    const differing = [...left.keys()].filter((path) => left.get(path) !== right.get(path));
    expect(differing).toEqual([]);
  });

  it('serializes the same manifest twice to the same bytes', () => {
    const { ir, plan } = example();
    const provenance = provenanceFor(ir);
    const once = serializeAidManifest(manifestFor(plan.files, provenance));
    const twice = serializeAidManifest(manifestFor(plan.files, provenance));
    expect(once).toBe(twice);
  });

  it('emits nothing that identifies the machine that ran the generator', () => {
    const violations = checkDeterminism(examplePlan().files);

    // One false positive is expected, and it is pinned rather than tolerated.
    //
    // The scan is a source-text lint on merged layer-3 code, and its Windows pattern is
    // `/[A-Za-z]:[\\/]/` -- any letter, a colon, a backslash. The prompt body ends a
    // line with `...three fields:\n`, and the `s:\` of `fields:\` matches. Pinning the
    // path and the offending text keeps the assertion honest: a genuine leaked path
    // anywhere, or a second false positive, changes the count and fails the test.
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      path: 'app/generated/prompts/classify_ticket.py',
      pattern: 'absolute-path-windows',
    });
    expect(violations[0]?.text).toContain('fields:');
  });

  it('orders the plan by path, so a diff is stable', () => {
    const paths = examplePlan().files.map((file) => file.path);
    expect(paths).toEqual([...paths].sort());
  });

  it('uses LF endings and exactly one trailing newline per file', () => {
    for (const file of examplePlan().files) {
      expect(file.content.includes('\r'), file.path).toBe(false);
      expect(file.content.endsWith('\n'), file.path).toBe(true);
      expect(file.content.endsWith('\n\n'), file.path).toBe(false);
      expect(file.content, file.path).not.toBe('');
    }
  });

  it('carries no tab characters, so indentation is never ambiguous', () => {
    for (const file of examplePlan().files) {
      expect(file.content.includes('\t'), file.path).toBe(false);
    }
  });
});

describe('the determinism scan can fail', () => {
  it('reports a timestamp and an absolute path leaked into a real emitted file', () => {
    const leaked = withRewrite(shippedGeneratedTree(), CONTRACTS_INIT, (content) =>
      [
        content,
        '# Generated at 2024-01-02T03:04:05',
        'ROOT = "C:\\\\builds\\\\aid"',
        'HOST = "/home/runner/work"',
        'VENV = "/tmp/.venv/bin/python"',
        '',
        'def jitter():',
        '    return uuid4()',
      ].join('\n'),
    );

    const scanned = scanForNonDeterminism(CONTRACTS_INIT, leaked.get(CONTRACTS_INIT) ?? '');

    expect([...new Set(scanned.map((violation) => violation.pattern))].sort()).toEqual([
      'absolute-path-unix',
      'absolute-path-windows',
      'generated-at-phrase',
      'host-directory',
      'runtime-randomness',
      'timestamp',
    ]);
    expect(scanned.length).toBeGreaterThan(0);
    for (const [index, violation] of scanned.entries()) {
      const previous = scanned[index - 1];
      expect(previous === undefined || previous.line <= violation.line).toBe(true);
      expect(violation.line).toBeGreaterThan(0);
      expect(violation.text.length).toBeGreaterThan(0);
    }
  });

  it('reports nothing for the committed tree it is pointed at', () => {
    expect(
      scanForNonDeterminism(CONTRACTS_INIT, shippedGeneratedTree().get(CONTRACTS_INIT) ?? ''),
    ).toEqual([]);
  });
});

describe('the golden comparison can fail', () => {
  it('catches a single changed byte in a generated file', () => {
    const shipped = shippedManagedTree();
    const mutated = withRewrite(shipped, CONTRACTS_INIT, (content) =>
      content.replace('DO NOT EDIT', 'DO NOT TOUCH'),
    );

    expect(diffTree(examplePlan().files, mutated)).toEqual([
      { kind: 'content', path: CONTRACTS_INIT },
    ]);
  });

  it('names the first line that differs', () => {
    const plan = examplePlan();
    const expected = plan.files.find((file) => file.path === CONTRACTS_INIT)?.content ?? '';
    const actual = expected.replace('DO NOT EDIT', 'DO NOT TOUCH');

    expect(firstDifference(expected, actual)).toContain('line 1:');
    expect(firstDifference(expected, actual)).toContain('DO NOT TOUCH');
  });

  it('catches a deleted generated file', () => {
    const mutated = without(shippedManagedTree(), CONTRACTS_INIT);
    expect(diffTree(examplePlan().files, mutated)).toEqual([
      { kind: 'missing', path: CONTRACTS_INIT },
    ]);
  });

  it('catches a file under a managed tier that the plan does not own', () => {
    const mutated = new Map(shippedManagedTree());
    mutated.set('app/generated/handwritten.py', 'x = 1\n');
    expect(diffTree(examplePlan().files, mutated)).toEqual([
      { kind: 'extra', path: 'app/generated/handwritten.py' },
    ]);
  });

  it('wants a developer-owned file to exist, but does not compare its bytes', () => {
    const tool = 'app/business/tools/lookup_customer.py';
    const shipped = shippedManagedTree();
    const seed = examplePlan().files.find((file) => file.path === tool);

    // The example implements the tool, so its bytes already differ from the seed. That
    // must not be a mismatch -- it is the whole point of the business tier.
    expect(shipped.get(tool)).not.toBe(seed?.content);
    expect(diffTree(examplePlan().files, shipped)).toEqual([]);

    expect(diffTree(examplePlan().files, without(shipped, tool))).toEqual([
      { kind: 'missing', path: tool },
    ]);
  });
});
