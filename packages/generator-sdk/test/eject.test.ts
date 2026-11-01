/**
 * Ejection: the developer's way out of "generated files are never hand-edited".
 *
 * The properties asserted here are the ones that make the escape hatch safe to offer:
 *
 * 1. The bytes move, and the hash follows them. Ownership is a location, so a manifest
 *    flag without a move would contradict `ownerForPath`.
 * 2. The exclusion is recorded and survives the next `aid gen` — the whole point is that
 *    the generator stops producing the file, forever, not for one run.
 * 3. Nothing developer-owned is ever destroyed. Every refusal here is a case where
 *    proceeding would have overwritten a file the human wrote.
 * 4. Repeating the command is harmless, so a script does not have to ask first.
 */

import { describe, expect, it } from 'vitest';

import {
  type AidManifestProvenance,
  businessPathFor,
  createMemorySink,
  eject,
  GENERATOR_DIAGNOSTIC_CODES,
  type GeneratedFile,
  manifestFor,
  type Plan,
  parseAidManifest,
  planRegeneration,
  regenerate,
  serializeAidManifest,
  sha256Hex,
} from '../src/index.js';
import { hasCode } from './helpers.js';

const PROVENANCE: AidManifestProvenance = {
  generator: '@aid-framework/generator-py-fastapi',
  generatorVersion: '0.1.0',
  irVersion: '0.1.0',
};

/** The example project's roots, which are nested one level below the repo root. */
const ROOTS = { generatedDir: 'app/generated', businessDir: 'app/business' } as const;

const GEN = 'app/generated/prompts/triage.py';
const BIZ = 'app/business/prompts/triage.py';
const CONTENT = 'PROMPT = "triage"\n';

function generated(path: string, content = CONTENT): GeneratedFile {
  return { path, content, owner: 'generated' };
}

function planWith(...paths: readonly string[]): Plan {
  return { files: paths.map((path) => generated(path)) };
}

/** A tree that has been generated once: the file is on disk and in the manifest. */
function generatedTree(...paths: readonly string[]) {
  const plan = planWith(...paths);
  const initial = Object.fromEntries(paths.map((path) => [path, CONTENT]));
  return {
    plan,
    sink: createMemorySink(initial),
    manifest: manifestFor(plan.files, PROVENANCE),
  };
}

describe('businessPathFor', () => {
  it('mirrors the path under the business root', () => {
    expect(businessPathFor(GEN, ROOTS)).toBe(BIZ);
    expect(businessPathFor('app/generated/a.py', ROOTS)).toBe('app/business/a.py');
  });

  it('refuses a path outside the generated root, or the root itself', () => {
    expect(businessPathFor('app/business/a.py', ROOTS)).toBeUndefined();
    expect(businessPathFor('app/generated', ROOTS)).toBeUndefined();
    expect(businessPathFor('../generated/a.py', ROOTS)).toBeUndefined();
  });

  it('normalizes separators, so a Windows path names the same file', () => {
    expect(businessPathFor('app\\generated\\prompts\\triage.py', ROOTS)).toBe(BIZ);
  });
});

describe('eject', () => {
  it('moves the file to the business tier, removes the generated copy, and records the exclusion', () => {
    const { sink, manifest } = generatedTree(GEN);

    const result = eject({ path: GEN, sink, manifest, ...ROOTS });

    expect(result.ok).toBe(true);
    expect(result.status).toBe('ejected');
    expect(result.from).toBe(GEN);
    expect(result.to).toBe(BIZ);
    expect(result.written).toBe(true);
    expect(sink.read(BIZ)).toBe(CONTENT);
    expect(sink.read(GEN)).toBeUndefined();
    expect(result.manifest?.ejected).toEqual([GEN]);
    expect(result.manifest?.files.map((file) => file.path)).toEqual([BIZ]);
    expect(result.manifest?.files[0]?.owner).toBe('business');
    expect(result.manifest?.files[0]?.sha256).toBe(sha256Hex(CONTENT));
  });

  it('writes nothing in a dry run, including the manifest', () => {
    const { sink, manifest } = generatedTree(GEN);

    const result = eject({ path: GEN, sink, manifest, ...ROOTS, dryRun: true });

    expect(result.ok).toBe(true);
    expect(result.status).toBe('ejected');
    expect(result.dryRun).toBe(true);
    expect(sink.read(BIZ)).toBeUndefined();
    expect(sink.read(GEN)).toBe(CONTENT);
    expect(result.manifest?.ejected).toEqual([GEN]);
  });

  it('is idempotent for a path the developer already owns', () => {
    const { sink, manifest } = generatedTree(GEN);
    const first = eject({ path: GEN, sink, manifest, ...ROOTS });
    expect(first.manifest).toBeDefined();

    const second = eject({ path: GEN, sink, manifest: first.manifest, ...ROOTS });

    expect(second.ok).toBe(true);
    expect(second.status).toBe('already-owned');
    expect(second.to).toBeUndefined();
    expect(sink.read(BIZ)).toBe(CONTENT);
  });

  it('treats an unplanned business path as already owned', () => {
    const { sink, manifest } = generatedTree(GEN);

    const result = eject({ path: 'app/business/tools/lookup.py', sink, manifest, ...ROOTS });

    expect(result.ok).toBe(true);
    expect(result.status).toBe('already-owned');
  });

  it('accepts a destination that already holds identical bytes, and removes the generated copy', () => {
    const { sink, manifest } = generatedTree(GEN);
    sink.write(BIZ, CONTENT);

    const result = eject({ path: GEN, sink, manifest, ...ROOTS });

    expect(result.ok).toBe(true);
    expect(result.written).toBe(false);
    expect(sink.read(GEN)).toBeUndefined();
    expect(sink.read(BIZ)).toBe(CONTENT);
  });

  it('refuses to overwrite a business file that differs', () => {
    const { sink, manifest } = generatedTree(GEN);
    sink.write(BIZ, '# mine\n');

    const result = eject({ path: GEN, sink, manifest, ...ROOTS });

    expect(result.ok).toBe(false);
    expect(hasCode(result.diagnostics, GENERATOR_DIAGNOSTIC_CODES.ejectDestinationExists)).toBe(
      true,
    );
    expect(sink.read(BIZ)).toBe('# mine\n');
    expect(sink.read(GEN)).toBe(CONTENT);
  });

  it('refuses a generated path the manifest never recorded', () => {
    const { sink, manifest } = generatedTree(GEN);
    sink.write('app/generated/extra.py', CONTENT);

    const result = eject({ path: 'app/generated/extra.py', sink, manifest, ...ROOTS });

    expect(result.ok).toBe(false);
    expect(hasCode(result.diagnostics, GENERATOR_DIAGNOSTIC_CODES.ejectNotGenerated)).toBe(true);
  });

  it('refuses when the recorded file is missing from the tree', () => {
    const plan = planWith(GEN);
    const sink = createMemorySink();
    const manifest = manifestFor(plan.files, PROVENANCE);

    const result = eject({ path: GEN, sink, manifest, ...ROOTS });

    expect(result.ok).toBe(false);
    expect(hasCode(result.diagnostics, GENERATOR_DIAGNOSTIC_CODES.ejectMissingFile)).toBe(true);
  });

  it('refuses a path outside every managed root', () => {
    const { sink, manifest } = generatedTree(GEN);

    const result = eject({ path: 'app/app.spec.yaml', sink, manifest, ...ROOTS });

    expect(result.ok).toBe(false);
    expect(hasCode(result.diagnostics, GENERATOR_DIAGNOSTIC_CODES.ejectNotGenerated)).toBe(true);
  });
});

describe('eject — effect on regeneration', () => {
  it('stops the generator from recreating the file, and carries the ledger forward', () => {
    const { plan, sink, manifest } = generatedTree(GEN);
    const ejected = eject({ path: GEN, sink, manifest, ...ROOTS });
    expect(ejected.manifest).toBeDefined();

    const report = planRegeneration(plan, { sink, manifest: ejected.manifest });
    expect(report.created).toEqual([]);
    expect(report.ejected).toEqual([GEN]);
    expect(report.stale).toEqual([]);
    expect(report.diagnostics).toEqual([]);

    const applied = regenerate(plan, {
      sink,
      manifest: ejected.manifest,
      provenance: PROVENANCE,
    });
    expect(applied.report.ejected).toEqual([GEN]);
    expect(applied.manifest.ejected).toEqual([GEN]);
    expect(sink.read(GEN)).toBeUndefined();
    expect(sink.read(BIZ)).toBe(CONTENT);
  });

  it('survives a manifest round trip, so the exclusion is not lost between runs', () => {
    const { sink, manifest } = generatedTree(GEN);
    const ejected = eject({ path: GEN, sink, manifest, ...ROOTS });
    if (ejected.manifest === undefined) throw new Error('eject refused a valid request');

    const reparsed = parseAidManifest(JSON.parse(serializeAidManifest(ejected.manifest)), ROOTS);

    expect(reparsed.diagnostics).toEqual([]);
    expect(reparsed.manifest?.ejected).toEqual([GEN]);
  });

  it('omits the key when nothing was ever ejected, so old manifests keep their bytes', () => {
    const manifest = manifestFor(planWith(GEN).files, PROVENANCE);

    expect(serializeAidManifest(manifest)).not.toContain('"ejected"');
    expect(
      parseAidManifest(JSON.parse(serializeAidManifest(manifest)), ROOTS).manifest?.ejected,
    ).toEqual([]);
  });
});

describe('manifest — the ejection ledger is validated', () => {
  function parseEjected(ejected: unknown) {
    return parseAidManifest(
      {
        manifestVersion: 1,
        generatedBy: { generator: 'g', generatorVersion: '0.1.0', irVersion: '0.1.0' },
        files: [],
        ejected,
      },
      ROOTS,
    );
  }

  it('rejects a duplicate entry rather than silently de-duplicating', () => {
    const result = parseEjected([GEN, GEN]);
    expect(result.manifest).toBeUndefined();
    expect(result.diagnostics.some((d) => d.message.includes('listed twice'))).toBe(true);
  });

  it('rejects a business path, which could never have been generated', () => {
    const result = parseEjected([BIZ]);
    expect(result.manifest).toBeUndefined();
    expect(result.diagnostics.some((d) => d.message.includes('generated root'))).toBe(true);
  });

  it('rejects a path that is both recorded as generated and ejected', () => {
    const result = parseAidManifest(
      {
        manifestVersion: 1,
        generatedBy: { generator: 'g', generatorVersion: '0.1.0', irVersion: '0.1.0' },
        files: [
          {
            path: GEN,
            owner: 'generated',
            sha256: sha256Hex(CONTENT),
            generator: 'g',
            generatorVersion: '0.1.0',
          },
        ],
        ejected: [GEN],
      },
      ROOTS,
    );
    expect(result.manifest).toBeUndefined();
    expect(result.diagnostics.some((d) => d.message.includes('cannot be both'))).toBe(true);
  });
});
