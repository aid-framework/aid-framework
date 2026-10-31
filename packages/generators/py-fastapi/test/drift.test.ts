/**
 * Regeneration safety, driven against the real artefact.
 *
 * The fixture is the example's committed tree and the example's committed manifest, so
 * these tests exercise the algorithm on the exact bytes a developer would have on disk
 * -- including the one business file the example actually implements, which is the case
 * that matters: it differs from the seed the generator wrote, and it has to survive.
 *
 * The in-memory sink keeps the runs offline and lets a test assert on the tree after a
 * run without touching the working copy.
 */

import {
  type AidManifest,
  checkDrift,
  createMemorySink,
  formatRegenerationSummary,
  GENERATOR_DIAGNOSTIC_CODES,
  generatedFiles,
  hasDrift,
  manifestFor,
  ownerForPath,
  regenerate,
  rejectionPath,
  sha256Hex,
  staleGeneratedFiles,
} from '@aid-framework/generator-sdk';
import { describe, expect, it } from 'vitest';

import {
  example,
  examplePlan,
  provenanceFor,
  shippedManagedTree,
  shippedManifest,
} from './helpers.js';

/** The example app's tiers, repo-relative to the app root the plan is keyed against. */
const MANAGED_LAYOUT = { generatedDir: 'app/generated', businessDir: 'app/business' };

const CONTRACTS_INIT = 'app/generated/contracts/__init__.py';
const TOOL_PATH = 'app/business/tools/lookup_customer.py';

function buildSink(): ReturnType<typeof createMemorySink> {
  return createMemorySink(Object.fromEntries(shippedManagedTree()));
}

function read(sink: ReturnType<typeof createMemorySink>, path: string): string {
  const content = sink.files.get(path);
  if (content === undefined) throw new Error(`${path} is not in the sink`);
  return content;
}

/** A local edit to a generated file, of the kind `aid eject` exists for. */
function handEdit(
  sink: ReturnType<typeof createMemorySink>,
  path: string,
  line = 'LOCAL_FIX = 1\n',
) {
  sink.files.set(path, read(sink, path) + line);
}

function seedsByPath(): Map<string, string> {
  return new Map(examplePlan().files.map((file) => [file.path, file.content]));
}

describe('regenerating over the committed example', () => {
  it('is a no-op when the spec has not changed', () => {
    const sink = buildSink();
    const { report } = regenerate(examplePlan(), {
      sink,
      manifest: shippedManifest(),
      provenance: provenanceFor(example().ir),
    });

    expect(report.created).toEqual([]);
    expect(report.updated).toEqual([]);
    expect(report.unchanged).toHaveLength(35);
    expect(report.kept).toHaveLength(5);
    expect(report.drifted).toEqual([]);
    expect(report.stale).toEqual([]);
    expect(report.pruned).toEqual([]);
    expect(report.diagnostics).toEqual([]);
    expect(hasDrift(report)).toBe(false);
    expect(formatRegenerationSummary(report)).toBe('0 created, 0 updated, 35 unchanged, 5 kept');
  });

  it('leaves every file of both tiers byte for byte as it was', () => {
    const before = shippedManagedTree();
    const sink = buildSink();
    regenerate(examplePlan(), {
      sink,
      manifest: shippedManifest(),
      provenance: provenanceFor(example().ir),
    });

    expect([...sink.files.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [path, content] of before) {
      expect(sink.files.get(path), path).toBe(content);
    }
  });

  it('recomputes the generated records and leaves the developer-owned content alone', () => {
    const sink = buildSink();
    const { manifest } = regenerate(examplePlan(), {
      sink,
      manifest: shippedManifest(),
      provenance: provenanceFor(example().ir),
    });

    const fresh = manifestFor(examplePlan().files, provenanceFor(example().ir));
    expect(manifest.generatedBy).toEqual(fresh.generatedBy);
    expect(manifest.files.filter((file) => file.owner === 'generated')).toEqual(
      fresh.files.filter((file) => file.owner === 'generated'),
    );

    // The one implemented business file is still the developer's, not the seed's.
    const seed = seedsByPath().get(TOOL_PATH);
    expect(read(sink, TOOL_PATH)).not.toBe(seed);
  });

  it('derives every file owner from the path alone', () => {
    const misplaced = examplePlan()
      .files.filter((file) => ownerForPath(file.path, MANAGED_LAYOUT) !== file.owner)
      .map((file) => file.path);
    expect(misplaced).toEqual([]);
  });
});

describe('drift', () => {
  it('refuses to overwrite a hand-edited generated file, and sets the new content aside', () => {
    const sink = buildSink();
    const original = read(sink, CONTRACTS_INIT);
    handEdit(sink, CONTRACTS_INIT, 'LOCAL_FIX = 1\n');
    const edited = read(sink, CONTRACTS_INIT);

    const { report, manifest } = regenerate(examplePlan(), {
      sink,
      manifest: shippedManifest(),
      provenance: provenanceFor(example().ir),
    });

    expect(report.drifted).toEqual([
      {
        path: CONTRACTS_INIT,
        recordedSha256: sha256Hex(original),
        actualSha256: sha256Hex(edited),
      },
    ]);
    expect(hasDrift(report)).toBe(true);
    expect(formatRegenerationSummary(report)).toContain('1 conflicts');

    // The edit survives, and the bytes the generator wanted are beside it, not over it.
    expect(read(sink, CONTRACTS_INIT)).toBe(edited);
    expect(read(sink, rejectionPath(CONTRACTS_INIT))).toBe(seedsByPath().get(CONTRACTS_INIT));

    // A caller cannot mistake this for a success.
    expect(report.diagnostics).toHaveLength(1);
    expect(report.diagnostics[0]).toMatchObject({
      severity: 'error',
      code: GENERATOR_DIAGNOSTIC_CODES.generatedDrift,
      path: [CONTRACTS_INIT],
    });
    expect(report.diagnostics[0]?.hint).toContain(`aid eject ${CONTRACTS_INIT}`);
    expect(report.diagnostics[0]?.hint).toContain(rejectionPath(CONTRACTS_INIT));

    // A refused file keeps its previous record, so the drift is still visible next run.
    const record = manifest.files.find((file) => file.path === CONTRACTS_INIT);
    expect(record?.sha256).toBe(sha256Hex(original));
    expect(record?.sha256).not.toBe(sha256Hex(edited));
  });

  it('rewrites the file and clears the sidecar when the caller forces it', () => {
    const sink = buildSink();
    handEdit(sink, CONTRACTS_INIT, 'LOCAL_FIX = 1\n');

    const { report, manifest } = regenerate(examplePlan(), {
      sink,
      manifest: shippedManifest(),
      provenance: provenanceFor(example().ir),
      force: true,
    });

    expect(read(sink, CONTRACTS_INIT)).toBe(seedsByPath().get(CONTRACTS_INIT));
    expect(sink.files.has(rejectionPath(CONTRACTS_INIT))).toBe(false);
    expect(report.drifted).toHaveLength(1);
    expect(report.diagnostics[0]?.severity).toBe('warning');
    expect(report.diagnostics[0]?.hint).toContain('--force discards');

    const record = manifest.files.find((file) => file.path === CONTRACTS_INIT);
    expect(record?.sha256).toBe(sha256Hex(seedsByPath().get(CONTRACTS_INIT) ?? ''));
  });

  it('treats an unrecorded file under the generated root as drift, not as adoptable', () => {
    const committed = shippedManifest();
    const stripped: AidManifest = {
      ...committed,
      files: committed.files.filter((file) => file.path !== CONTRACTS_INIT),
    };

    const sink = buildSink();
    const { report } = regenerate(examplePlan(), {
      sink,
      manifest: stripped,
      provenance: provenanceFor(example().ir),
    });

    expect(report.drifted).toHaveLength(1);
    expect(report.drifted[0]).toMatchObject({
      path: CONTRACTS_INIT,
      actualSha256: sha256Hex(read(sink, CONTRACTS_INIT)),
    });
    expect(report.drifted[0]?.recordedSha256).toBeUndefined();
    expect(report.diagnostics[0]?.message).toContain('not recorded in the manifest');
    expect(report.unchanged).toHaveLength(34);
  });

  it('can check for drift without writing anything', () => {
    const sink = buildSink();
    handEdit(sink, CONTRACTS_INIT, 'LOCAL_FIX = 1\n');
    const sizeBefore = sink.files.size;

    const diagnostics = checkDrift(examplePlan(), { sink, manifest: shippedManifest() });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      severity: 'error',
      code: GENERATOR_DIAGNOSTIC_CODES.generatedDrift,
      path: [CONTRACTS_INIT],
    });
    expect(sink.files.size).toBe(sizeBefore);
    expect(sink.files.has(rejectionPath(CONTRACTS_INIT))).toBe(false);
  });
});

describe('stale generated files', () => {
  const LEGACY = 'app/generated/legacy.py';

  function manifestWithLegacy(): AidManifest {
    const committed = shippedManifest();
    const provenance = committed.generatedBy;
    return {
      ...committed,
      files: [
        ...committed.files,
        {
          path: LEGACY,
          owner: 'generated',
          sha256: sha256Hex('LEGACY = True\n'),
          generator: provenance.generator,
          generatorVersion: provenance.generatorVersion,
        },
      ],
    };
  }

  it('reports a recorded file the plan no longer produces', () => {
    const sink = buildSink();
    sink.files.set(LEGACY, 'LEGACY = True\n');

    const { report } = regenerate(examplePlan(), {
      sink,
      manifest: manifestWithLegacy(),
      provenance: provenanceFor(example().ir),
    });

    expect(staleGeneratedFiles(examplePlan(), manifestWithLegacy())).toEqual([LEGACY]);
    expect(report.stale).toEqual([LEGACY]);
    expect(report.pruned).toEqual([]);
    expect(formatRegenerationSummary(report)).toContain('1 stale');
    expect(report.diagnostics).toHaveLength(1);
    expect(report.diagnostics[0]).toMatchObject({
      severity: 'warning',
      code: GENERATOR_DIAGNOSTIC_CODES.generatedDrift,
      path: [LEGACY],
    });
    expect(report.diagnostics[0]?.message).toContain('no longer planned');

    // Reported, not removed: deleting is opt-in.
    expect(sink.files.get(LEGACY)).toBe('LEGACY = True\n');
  });

  it('deletes it only when the caller asks to prune', () => {
    const sink = buildSink();
    sink.files.set(LEGACY, 'LEGACY = True\n');

    const { report, manifest } = regenerate(examplePlan(), {
      sink,
      manifest: manifestWithLegacy(),
      provenance: provenanceFor(example().ir),
      prune: true,
    });

    expect(report.stale).toEqual([LEGACY]);
    expect(report.pruned).toEqual([LEGACY]);
    expect(sink.files.has(LEGACY)).toBe(false);
    expect(manifest.files.map((file) => file.path)).not.toContain(LEGACY);
    expect(report.updated).toEqual([]);
    expect(report.kept).toHaveLength(5);
  });
});

describe('business files', () => {
  it('creates a missing developer-owned file from the seed and reports it as created', () => {
    const tree = shippedManagedTree();
    tree.delete(TOOL_PATH);
    const sink = createMemorySink(Object.fromEntries(tree));

    const { report } = regenerate(examplePlan(), {
      sink,
      manifest: shippedManifest(),
      provenance: provenanceFor(example().ir),
    });

    expect(report.created).toEqual([TOOL_PATH]);
    expect(report.kept).toHaveLength(4);
    expect(report.updated).toEqual([]);
    expect(report.diagnostics).toEqual([]);
    expect(sink.files.get(TOOL_PATH)).toBe(seedsByPath().get(TOOL_PATH));
  });

  it('never overwrites one that already exists, however different it is', () => {
    const sink = buildSink();
    sink.files.set(TOOL_PATH, '# rewritten from scratch by hand\n');

    const { report } = regenerate(examplePlan(), {
      sink,
      manifest: shippedManifest(),
      provenance: provenanceFor(example().ir),
    });

    expect(sink.files.get(TOOL_PATH)).toBe('# rewritten from scratch by hand\n');
    expect(report.kept).toContain(TOOL_PATH);
    expect(report.created).not.toContain(TOOL_PATH);
    expect(report.updated).not.toContain(TOOL_PATH);
    expect(report.drifted).toEqual([]);
    expect(report.diagnostics).toEqual([]);

    // And it stays out of the generated tier's hash accounting entirely.
    expect(generatedFiles(examplePlan().files).map((file) => file.path)).not.toContain(TOOL_PATH);
  });
});
