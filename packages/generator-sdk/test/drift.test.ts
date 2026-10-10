import { describe, expect, it } from 'vitest';

import {
  type AidManifestProvenance,
  checkDrift,
  createMemorySink,
  formatRegenerationSummary,
  GENERATOR_DIAGNOSTIC_CODES,
  type GeneratedFile,
  generatedFiles,
  hasDrift,
  manifestFor,
  manifestRecordFor,
  type Plan,
  planRegeneration,
  regenerate,
  rejectionPath,
  sha256Hex,
  staleGeneratedFiles,
} from '../src/index.js';
import { codes, hasCode } from './helpers.js';

const PROVENANCE: AidManifestProvenance = {
  generator: '@aid/generator-py-fastapi',
  generatorVersion: '0.1.0',
  irVersion: '0.1.0',
};

function generated(path: string, content = 'x = 1\n'): GeneratedFile {
  return { path, content, owner: 'generated' };
}

function business(path: string, content = '# stub\n'): GeneratedFile {
  return { path, content, owner: 'business' };
}

const MAIN = 'app/generated/main.py';

describe('planRegeneration — first generation', () => {
  it('creates every planned file and does not report drift', () => {
    const sink = createMemorySink();
    const plan: Plan = { files: [generated(MAIN), business('app/business/handlers.py')] };
    const report = planRegeneration(plan, { sink });

    expect(report.created.sort()).toEqual(['app/business/handlers.py', MAIN]);
    expect(report.drifted).toEqual([]);
    expect(hasDrift(report)).toBe(false);
    expect(report.diagnostics).toEqual([]);
  });

  it('orders its actions by path so a report is reproducible', () => {
    const sink = createMemorySink();
    const report = planRegeneration(
      { files: [generated('app/generated/z.py'), generated('app/generated/a.py')] },
      { sink },
    );
    expect(report.actions.map((action) => action.path)).toEqual([
      'app/generated/a.py',
      'app/generated/z.py',
    ]);
  });

  it('treats an existing generated file with no manifest record as drift, not as adoptable', () => {
    const sink = createMemorySink({ [MAIN]: 'x = 1\n' });
    const report = planRegeneration({ files: [generated(MAIN)] }, { sink });

    expect(report.drifted).toEqual([{ path: MAIN, actualSha256: sha256Hex('x = 1\n') }]);
    expect(hasCode(report.diagnostics, GENERATOR_DIAGNOSTIC_CODES.generatedDrift)).toBe(true);
  });
});

describe('planRegeneration — steady state', () => {
  it('reports an unchanged file when disk, plan, and manifest agree', () => {
    const plan: Plan = { files: [generated(MAIN)] };
    const sink = createMemorySink({ [MAIN]: 'x = 1\n' });
    const report = planRegeneration(plan, { sink, manifest: manifestFor(plan.files, PROVENANCE) });

    expect(report.unchanged).toEqual([MAIN]);
    expect(report.created).toEqual([]);
    expect(report.diagnostics).toEqual([]);
  });

  it('updates a file when the generator changed and the human did not', () => {
    const before: Plan = { files: [generated(MAIN, 'x = 1\n')] };
    const sink = createMemorySink({ [MAIN]: 'x = 1\n' });
    const report = planRegeneration(
      { files: [generated(MAIN, 'x = 2\n')] },
      { sink, manifest: manifestFor(before.files, PROVENANCE) },
    );

    expect(report.updated).toEqual([MAIN]);
    expect(report.drifted).toEqual([]);
  });
});

describe('planRegeneration — generated drift (the load-bearing rule)', () => {
  it('refuses to regenerate a generated file a human edited', () => {
    const plan: Plan = { files: [generated(MAIN, 'x = 1\n')] };
    const sink = createMemorySink({ [MAIN]: 'x = 1\nEDITED\n' });
    const report = planRegeneration(plan, { sink, manifest: manifestFor(plan.files, PROVENANCE) });

    expect(report.drifted).toEqual([
      {
        path: MAIN,
        recordedSha256: sha256Hex('x = 1\n'),
        actualSha256: sha256Hex('x = 1\nEDITED\n'),
      },
    ]);
    expect(report.updated).toEqual([]);
    expect(report.unchanged).toEqual([]);
    expect(hasDrift(report)).toBe(true);
  });

  it('reports drift as an error, and names both escapes', () => {
    const plan: Plan = { files: [generated(MAIN, 'x = 1\n')] };
    const sink = createMemorySink({ [MAIN]: 'edited\n' });
    const report = planRegeneration(plan, { sink, manifest: manifestFor(plan.files, PROVENANCE) });

    const drift = report.diagnostics.find(
      (diagnostic) => diagnostic.code === GENERATOR_DIAGNOSTIC_CODES.generatedDrift,
    );
    expect(drift?.severity).toBe('error');
    expect(drift?.hint).toContain('aid eject');
    expect(drift?.hint).toContain('--force');
    expect(drift?.hint).toContain(rejectionPath(MAIN));
  });

  it('leaves the edited bytes alone and puts the new content in a rejection sidecar', () => {
    const plan: Plan = { files: [generated(MAIN, 'x = 2\n')] };
    const sink = createMemorySink({ [MAIN]: 'x = 1\nEDITED\n' });

    const { report, manifest } = regenerate(plan, {
      sink,
      manifest: manifestFor([generated(MAIN, 'x = 1\n')], PROVENANCE),
      provenance: PROVENANCE,
    });

    expect(report.drifted).toHaveLength(1);
    expect(sink.read(MAIN)).toBe('x = 1\nEDITED\n');
    expect(sink.read(rejectionPath(MAIN))).toBe('x = 2\n');

    // The record still describes the human's bytes' ancestor, not the new content, so
    // the next run reports the same drift instead of silently erasing it.
    expect(manifestRecordFor(manifest, MAIN)?.sha256).toBe(sha256Hex('x = 1\n'));
  });

  it('does not write a manifest record for an unrecorded drifting file', () => {
    const sink = createMemorySink({ [MAIN]: 'mystery\n' });
    const { manifest } = regenerate({ files: [generated(MAIN)] }, { sink, provenance: PROVENANCE });

    expect(manifestRecordFor(manifest, MAIN)).toBeUndefined();
  });

  it('discards the edits only when forced, and clears the sidecar', () => {
    const plan: Plan = { files: [generated(MAIN, 'x = 2\n')] };
    const sink = createMemorySink({
      [MAIN]: 'x = 1\nEDITED\n',
      [rejectionPath(MAIN)]: 'stale rejection\n',
    });

    const { report, manifest } = regenerate(plan, {
      sink,
      manifest: manifestFor([generated(MAIN, 'x = 1\n')], PROVENANCE),
      provenance: PROVENANCE,
      force: true,
    });

    expect(report.drifted).toHaveLength(1);
    expect(sink.read(MAIN)).toBe('x = 2\n');
    expect(sink.read(rejectionPath(MAIN))).toBeUndefined();
    expect(manifestRecordFor(manifest, MAIN)?.sha256).toBe(sha256Hex('x = 2\n'));
    expect(report.diagnostics.every((diagnostic) => diagnostic.severity === 'warning')).toBe(true);
  });
});

describe('planRegeneration — business files', () => {
  it('creates a business file once and never overwrites it afterwards', () => {
    const path = 'app/business/handlers.py';
    const plan: Plan = { files: [business(path, '# stub\n')] };
    const sink = createMemorySink();

    const first = regenerate(plan, { sink, provenance: PROVENANCE });
    expect(first.report.created).toEqual([path]);
    expect(sink.read(path)).toBe('# stub\n');

    sink.write(path, '# implemented by the developer\n');
    const second = regenerate(plan, { sink, manifest: first.manifest, provenance: PROVENANCE });

    expect(second.report.kept).toEqual([path]);
    expect(sink.read(path)).toBe('# implemented by the developer\n');
    expect(second.report.drifted).toEqual([]);
  });

  it('records the bytes actually on disk for a business file it creates', () => {
    const sink = createMemorySink();
    const { manifest } = regenerate(
      { files: [business('app/business/new.py', '# new\n')] },
      {
        sink,
        provenance: PROVENANCE,
      },
    );
    expect(manifestRecordFor(manifest, 'app/business/new.py')?.sha256).toBe(sha256Hex('# new\n'));
    expect(manifestRecordFor(manifest, 'app/business/new.py')?.owner).toBe('business');
  });
});

describe('planRegeneration — stale files', () => {
  it('reports a recorded generated file the plan dropped, but does not delete it', () => {
    const sink = createMemorySink();
    const first = regenerate(
      { files: [generated(MAIN), generated('app/generated/old.py')] },
      { sink, provenance: PROVENANCE },
    );
    const report = planRegeneration(
      { files: [generated(MAIN)] },
      { sink, manifest: first.manifest },
    );

    expect(report.stale).toEqual(['app/generated/old.py']);
    expect(report.pruned).toEqual([]);
    expect(sink.read('app/generated/old.py')).toBeDefined();
    expect(report.diagnostics.some((diagnostic) => diagnostic.severity === 'warning')).toBe(true);
  });

  it('deletes stale files only when pruning is requested explicitly', () => {
    const sink = createMemorySink();
    const first = regenerate(
      { files: [generated(MAIN), generated('app/generated/old.py')] },
      { sink, provenance: PROVENANCE },
    );
    const report = regenerate(
      { files: [generated(MAIN)] },
      { sink, manifest: first.manifest, provenance: PROVENANCE, prune: true },
    );

    expect(report.report.pruned).toEqual(['app/generated/old.py']);
    expect(sink.read('app/generated/old.py')).toBeUndefined();
    expect(report.manifest.files.map((file) => file.path)).toEqual([MAIN]);
  });

  it('never flags a business record as stale', () => {
    const files = [business('app/business/handlers.py')];
    const manifest = manifestFor(files, PROVENANCE);
    expect(staleGeneratedFiles({ files: [] }, manifest)).toEqual([]);
  });

  it('reports nothing stale when there is no manifest to compare against', () => {
    expect(staleGeneratedFiles({ files: [generated(MAIN)] }, undefined)).toEqual([]);
  });
});

describe('checkDrift', () => {
  it('reports the same conflict without writing anything', () => {
    const sink = createMemorySink({ [MAIN]: 'x = 2\n' });
    const diagnostics = checkDrift(
      { files: [generated(MAIN, 'x = 3\n')] },
      { sink, manifest: manifestFor([generated(MAIN, 'x = 1\n')], PROVENANCE) },
    );

    expect(codes(diagnostics)).toContain(GENERATOR_DIAGNOSTIC_CODES.generatedDrift);
    expect(sink.files.size).toBe(1);
    expect(sink.read(MAIN)).toBe('x = 2\n');
  });

  it('is silent when the tree matches the manifest', () => {
    const sink = createMemorySink({ [MAIN]: 'x = 1\n' });
    const diagnostics = checkDrift(
      { files: [generated(MAIN)] },
      { sink, manifest: manifestFor([generated(MAIN)], PROVENANCE) },
    );
    expect(diagnostics).toEqual([]);
  });
});

describe('regeneration reporting', () => {
  it('summarizes a clean run without mentioning conflicts', () => {
    const sink = createMemorySink();
    const report = planRegeneration({ files: [generated(MAIN)] }, { sink });
    expect(formatRegenerationSummary(report)).toBe('1 created, 0 updated, 0 unchanged, 0 kept');
  });

  it('summarizes conflicts and stale files when present', () => {
    const report = planRegeneration(
      { files: [generated(MAIN)] },
      {
        sink: createMemorySink({ [MAIN]: 'edited\n' }),
        manifest: manifestFor(
          [generated(MAIN, 'x = 1\n'), generated('app/generated/old.py')],
          PROVENANCE,
        ),
      },
    );
    expect(formatRegenerationSummary(report)).toBe(
      '0 created, 0 updated, 0 unchanged, 0 kept, 1 conflicts, 1 stale',
    );
  });

  it('filters a file set down to the generated tier, ordered by path', () => {
    const files = [
      business('app/business/handlers.py'),
      generated('app/generated/z.py'),
      generated('app/generated/a.py'),
    ];
    expect(generatedFiles(files).map((file) => file.path)).toEqual([
      'app/generated/a.py',
      'app/generated/z.py',
    ]);
  });
});

describe('regeneration is idempotent', () => {
  it('reaches a fixed point: a second run changes nothing', () => {
    const plan: Plan = {
      files: [
        generated(MAIN, 'x = 1\n'),
        generated('app/generated/schema.py', 'y = 2\n'),
        business('app/business/handlers.py', '# stub\n'),
      ],
    };
    const sink = createMemorySink();

    const first = regenerate(plan, { sink, provenance: PROVENANCE });
    const snapshot = new Map(sink.files);

    const second = regenerate(plan, { sink, manifest: first.manifest, provenance: PROVENANCE });

    expect(second.report.created).toEqual([]);
    expect(second.report.updated).toEqual([]);
    expect(second.report.drifted).toEqual([]);
    expect(second.report.unchanged).toEqual([MAIN, 'app/generated/schema.py']);
    expect(second.report.kept).toEqual(['app/business/handlers.py']);
    expect(sink.files).toEqual(snapshot);
  });
});
