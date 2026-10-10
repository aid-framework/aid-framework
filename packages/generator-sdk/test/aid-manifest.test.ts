import { describe, expect, it } from 'vitest';

import {
  AID_MANIFEST_VERSION,
  type AidManifest,
  type AidManifestProvenance,
  DEFAULT_MANIFEST_FILENAME,
  emptyAidManifest,
  GENERATOR_DIAGNOSTIC_CODES,
  type GeneratedFile,
  managedRoots,
  manifestFor,
  manifestRecordFor,
  PY_FASTAPI_MANIFEST,
  parseAidManifest,
  parseAidManifestJson,
  serializeAidManifest,
  sha256Hex,
} from '../src/index.js';
import { codes, messages } from './helpers.js';

const PROVENANCE: AidManifestProvenance = {
  generator: '@aid/generator-py-fastapi',
  generatorVersion: '0.1.0',
  irVersion: '0.1.0',
};

const APP_ROOTS = managedRoots(PY_FASTAPI_MANIFEST);

function generated(path: string, content = 'x = 1\n'): GeneratedFile {
  return { path, content, owner: 'generated' };
}

function business(path: string, content = '# stub\n'): GeneratedFile {
  return { path, content, owner: 'business' };
}

function appManifest(): AidManifest {
  return manifestFor(
    [generated('app/generated/main.py'), business('app/business/handlers.py')],
    PROVENANCE,
  );
}

describe('emptyAidManifest', () => {
  it('is a versioned manifest with no records', () => {
    expect(emptyAidManifest(PROVENANCE)).toEqual({
      manifestVersion: AID_MANIFEST_VERSION,
      generatedBy: PROVENANCE,
      files: [],
    });
  });

  it('is distinct from a missing manifest', () => {
    expect(parseAidManifest(undefined).manifest).toBeUndefined();
    expect(parseAidManifest(undefined).diagnostics).toHaveLength(1);
  });
});

describe('manifestFor', () => {
  it('records a hash per file and sorts the records by path', () => {
    const manifest = appManifest();
    expect(manifest.files.map((file) => file.path)).toEqual([
      'app/business/handlers.py',
      'app/generated/main.py',
    ]);
    expect(manifestRecordFor(manifest, 'app/generated/main.py')?.sha256).toBe(sha256Hex('x = 1\n'));
    expect(manifestRecordFor(manifest, 'app/business/handlers.py')?.owner).toBe('business');
    expect(manifest.files.every((file) => file.generatorVersion === '0.1.0')).toBe(true);
  });

  it('returns undefined for a path it does not record', () => {
    expect(manifestRecordFor(appManifest(), 'app/generated/other.py')).toBeUndefined();
    expect(manifestRecordFor(undefined, 'app/generated/main.py')).toBeUndefined();
  });
});

describe('serializeAidManifest', () => {
  it('emits canonical JSON with exactly one trailing newline', () => {
    const text = serializeAidManifest(appManifest());
    expect(text.endsWith('}\n')).toBe(true);
    expect(text.endsWith('}\n\n')).toBe(false);
    expect(text.split('\n')[1]).toContain('"files"');
  });

  it('is byte-identical for record sets built in different orders', () => {
    const forward = serializeAidManifest(appManifest());
    const backward = serializeAidManifest(
      manifestFor(
        [business('app/business/handlers.py'), generated('app/generated/main.py')],
        PROVENANCE,
      ),
    );
    expect(backward).toBe(forward);
  });

  it('round-trips through the parser for the Phase 0 app layout', () => {
    const text = serializeAidManifest(appManifest());
    const { manifest, diagnostics } = parseAidManifestJson(text, APP_ROOTS);

    expect(diagnostics).toEqual([]);
    expect(manifest).toEqual(appManifest());
  });

  it('round-trips a manifest that records only business files', () => {
    const manifest = manifestFor([business('app/business/handlers.py')], PROVENANCE);
    const { manifest: reparsed, diagnostics } = parseAidManifestJson(
      serializeAidManifest(manifest),
      APP_ROOTS,
    );
    expect(diagnostics).toEqual([]);
    expect(reparsed).toEqual(manifest);
  });
});

const VALID_RECORD = {
  path: 'app/generated/main.py',
  owner: 'generated',
  sha256: sha256Hex('x = 1\n'),
  generator: '@aid/generator-py-fastapi',
  generatorVersion: '0.1.0',
};

/** A manifest-shaped literal, so each negative case varies exactly one field. */
function baseManifest(
  record: Record<string, unknown> = VALID_RECORD,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    manifestVersion: AID_MANIFEST_VERSION,
    generatedBy: { ...PROVENANCE },
    files: [record],
    ...overrides,
  };
}

describe('parseAidManifest', () => {
  it('rejects a non-object', () => {
    expect(codes(parseAidManifest('nope').diagnostics)).toEqual([
      GENERATOR_DIAGNOSTIC_CODES.manifestInvalidField,
    ]);
  });

  it('rejects an unknown top-level key', () => {
    expect(parseAidManifest(baseManifest(VALID_RECORD, { extra: 1 })).manifest).toBeUndefined();
  });

  it('rejects an unsupported manifestVersion', () => {
    const diagnostics = parseAidManifest(
      baseManifest(VALID_RECORD, { manifestVersion: 99 }),
    ).diagnostics;
    expect(codes(diagnostics)).toContain(GENERATOR_DIAGNOSTIC_CODES.manifestVersionUnsupported);
  });

  it('rejects a missing or malformed generatedBy', () => {
    expect(
      codes(parseAidManifest(baseManifest(VALID_RECORD, { generatedBy: undefined })).diagnostics),
    ).toContain(GENERATOR_DIAGNOSTIC_CODES.manifestInvalidField);
    expect(
      codes(
        parseAidManifest(
          baseManifest(VALID_RECORD, {
            generatedBy: { generator: '@aid/g', generatorVersion: '1.0.0' },
          }),
        ).diagnostics,
      ),
    ).toContain(GENERATOR_DIAGNOSTIC_CODES.manifestInvalidField);
  });

  it('rejects an unknown generatedBy key', () => {
    const diagnostics = parseAidManifest(
      baseManifest(VALID_RECORD, { generatedBy: { ...PROVENANCE, branch: 'main' } }),
    ).diagnostics;
    expect(messages(diagnostics).join(' ')).toContain('Unknown generatedBy key');
  });

  it('rejects a missing files array', () => {
    const diagnostics = parseAidManifest(
      baseManifest(VALID_RECORD, { files: undefined }),
    ).diagnostics;
    expect(messages(diagnostics).join(' ')).toContain('needs a `files` array');
  });

  it('rejects a non-object file entry', () => {
    const diagnostics = parseAidManifest(baseManifest(VALID_RECORD, { files: [7] })).diagnostics;
    expect(messages(diagnostics).join(' ')).toContain('files[0] must be an object');
  });

  it('rejects an unknown file key', () => {
    const diagnostics = parseAidManifest(
      baseManifest({ ...VALID_RECORD, lineCount: 3 }),
    ).diagnostics;
    expect(messages(diagnostics).join(' ')).toContain('Unknown files[0] key');
  });

  it('rejects a file path that is not relative', () => {
    const diagnostics = parseAidManifest(
      baseManifest({ ...VALID_RECORD, path: 'D:/app/generated/main.py' }),
    ).diagnostics;
    expect(messages(diagnostics).join(' ')).toContain('.path must be a relative path');
  });

  it('rejects an unknown owner', () => {
    const diagnostics = parseAidManifest(
      baseManifest({ ...VALID_RECORD, owner: 'vendor' }),
    ).diagnostics;
    expect(messages(diagnostics).join(' ')).toContain('must be "generated" or "business"');
  });

  it('rejects an owner that contradicts where the file lives', () => {
    const diagnostics = parseAidManifest(
      baseManifest({ ...VALID_RECORD, path: 'app/business/main.py', owner: 'generated' }),
      APP_ROOTS,
    ).diagnostics;
    expect(messages(diagnostics).join(' ')).toContain('is a business path');
  });

  it('rejects a malformed digest', () => {
    const diagnostics = parseAidManifest(
      baseManifest({ ...VALID_RECORD, sha256: 'NOT-A-DIGEST' }),
      APP_ROOTS,
    ).diagnostics;
    expect(messages(diagnostics).join(' ')).toContain('64-character hex');
  });

  it('rejects a missing per-file generator', () => {
    const diagnostics = parseAidManifest(
      baseManifest({
        path: 'app/generated/main.py',
        owner: 'generated',
        sha256: VALID_RECORD.sha256,
      }),
      APP_ROOTS,
    ).diagnostics;
    expect(messages(diagnostics).join(' ')).toContain('generatorVersion must be strings');
  });

  it('rejects the same path recorded twice', () => {
    const diagnostics = parseAidManifest(
      baseManifest(VALID_RECORD, { files: [VALID_RECORD, VALID_RECORD] }),
      APP_ROOTS,
    ).diagnostics;
    expect(messages(diagnostics).join(' ')).toContain('is recorded twice');
  });

  it('reports every problem in a record in one pass', () => {
    const diagnostics = parseAidManifest(
      baseManifest({ path: 'app/generated/main.py', owner: 'generated', sha256: 'NOT-A-DIGEST' }),
      APP_ROOTS,
    ).diagnostics;
    expect(messages(diagnostics).join(' ')).toContain('64-character hex');
    expect(messages(diagnostics).join(' ')).toContain('generatorVersion must be strings');
  });

  it('sorts records on the way in', () => {
    const manifest = appManifest();
    const reversed = [...manifest.files].reverse();
    const { manifest: parsed } = parseAidManifest({ ...manifest, files: reversed }, APP_ROOTS);
    expect(parsed?.files.map((file) => file.path)).toEqual(manifest.files.map((file) => file.path));
  });

  it('reports warnings without discarding the manifest', () => {
    const result = parseAidManifest(appManifest(), APP_ROOTS);
    expect(result.manifest).toBeDefined();
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
  });
});

describe('parseAidManifestJson', () => {
  it('reports invalid JSON', () => {
    expect(codes(parseAidManifestJson('{').diagnostics)).toEqual([
      GENERATOR_DIAGNOSTIC_CODES.manifestParseFailed,
    ]);
  });

  it('defaults to the repository-root layout when no roots are supplied', () => {
    const manifest = manifestFor([generated('generated/main.py')], PROVENANCE);
    const { manifest: parsed, diagnostics } = parseAidManifestJson(serializeAidManifest(manifest));
    expect(diagnostics).toEqual([]);
    expect(parsed).toEqual(manifest);
  });
});

describe('DEFAULT_MANIFEST_FILENAME', () => {
  it('is re-exported for callers that only import this module', () => {
    expect(DEFAULT_MANIFEST_FILENAME).toBe('aid.manifest.json');
  });
});
