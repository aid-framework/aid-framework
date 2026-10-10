import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MANIFEST_FILENAME,
  escapesRoot,
  isAbsolutePath,
  isBusinessPath,
  isGeneratedPath,
  isRelativePath,
  isReservedPath,
  normalizeRelativePath,
  ownerForPath,
  REJECTION_SUFFIX,
  rejectionPath,
} from '../src/index.js';

describe('normalizeRelativePath', () => {
  it('converts Windows separators to POSIX', () => {
    expect(normalizeRelativePath('app\\generated\\main.py')).toBe('app/generated/main.py');
  });

  it('drops leading ./ and redundant separators', () => {
    expect(normalizeRelativePath('./app//generated/main.py')).toBe('app/generated/main.py');
  });

  it('rejects an empty path', () => {
    expect(normalizeRelativePath('')).toBeUndefined();
    expect(normalizeRelativePath('   ')).toBeUndefined();
    expect(normalizeRelativePath('./')).toBeUndefined();
  });

  it('rejects an absolute path', () => {
    expect(normalizeRelativePath('C:/app/main.py')).toBeUndefined();
  });

  it('rejects a path that climbs out of the root instead of collapsing it', () => {
    expect(normalizeRelativePath('../secrets.txt')).toBeUndefined();
  });
});

describe('escapesRoot', () => {
  it('detects a parent traversal anywhere in the path', () => {
    expect(escapesRoot('app/../../etc/passwd')).toBe(true);
    expect(escapesRoot('app\\generated\\main.py')).toBe(false);
  });
});

describe('isAbsolutePath', () => {
  it('detects drive letters, POSIX roots, and UNC paths', () => {
    expect(isAbsolutePath('C:\\app')).toBe(true);
    expect(isAbsolutePath('/app')).toBe(true);
    expect(isAbsolutePath('\\\\server\\share')).toBe(true);
    expect(isAbsolutePath('app/generated')).toBe(false);
  });
});

describe('isRelativePath', () => {
  it('agrees with normalizeRelativePath', () => {
    expect(isRelativePath('app/main.py')).toBe(true);
    expect(isRelativePath('../main.py')).toBe(false);
  });
});

describe('ownerForPath', () => {
  const options = { generatedDir: 'app/generated', businessDir: 'app/business' };

  it('claims paths under the generated root', () => {
    expect(ownerForPath('app/generated/main.py', options)).toBe('generated');
    expect(isGeneratedPath('app/generated/main.py', options)).toBe(true);
  });

  it('claims paths under the business root', () => {
    expect(ownerForPath('app/business/main.py', options)).toBe('business');
    expect(isBusinessPath('app/business/main.py', options)).toBe(true);
  });

  it('leaves a path outside both roots unowned', () => {
    expect(ownerForPath('app/other/main.py', options)).toBeUndefined();
    expect(ownerForPath('app', options)).toBeUndefined();
  });

  it('falls back to the default directory names', () => {
    expect(ownerForPath('generated/main.py')).toBe('generated');
    expect(ownerForPath('business/main.py')).toBe('business');
  });

  it('is not fooled by a sibling directory sharing a prefix', () => {
    expect(ownerForPath('app/generated-extra/main.py', options)).toBeUndefined();
  });

  it('returns undefined for an unusable path', () => {
    expect(ownerForPath('../generated/main.py', options)).toBeUndefined();
  });

  it('tolerates trailing slashes on the configured roots', () => {
    const slashed = { generatedDir: 'app/generated///', businessDir: 'app/business/' };
    expect(ownerForPath('app/generated/main.py', slashed)).toBe('generated');
    expect(ownerForPath('app/business/main.py', slashed)).toBe('business');
    expect(ownerForPath('app/other/main.py', slashed)).toBeUndefined();
  });
});

describe('rejection sidecars', () => {
  it('places the sidecar alongside the file it could not replace', () => {
    expect(rejectionPath('app/generated/main.py')).toBe(`app/generated/main.py${REJECTION_SUFFIX}`);
    expect(REJECTION_SUFFIX).toBe('.aid-rej');
  });
});

describe('isReservedPath', () => {
  it('reserves the manifest and every rejection sidecar', () => {
    expect(isReservedPath('app/aid.manifest.json', 'app/aid.manifest.json')).toBe(true);
    expect(isReservedPath('app/generated/main.py.aid-rej', DEFAULT_MANIFEST_FILENAME)).toBe(true);
    expect(isReservedPath('app/generated/main.py', DEFAULT_MANIFEST_FILENAME)).toBe(false);
  });
});
