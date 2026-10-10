import { describe, expect, it } from 'vitest';

import {
  checkDeterminism,
  compareIds,
  DETERMINISM_PATTERNS,
  ensureTrailingNewline,
  GENERATED_BANNER_MARKER,
  type GeneratedFile,
  generatedBanner,
  normalizeNewlines,
  normalizeText,
  scanForNonDeterminism,
  sha256Hex,
  sortById,
  sortByPath,
  stableId,
  stableSortBy,
} from '../src/index.js';
import { first } from './helpers.js';

describe('normalizeNewlines', () => {
  it('converts CRLF and lone CR to LF', () => {
    expect(normalizeNewlines('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
  });
});

describe('ensureTrailingNewline', () => {
  it('adds a missing newline', () => {
    expect(ensureTrailingNewline('a')).toBe('a\n');
  });

  it('collapses trailing blank lines', () => {
    expect(ensureTrailingNewline('a\n\n\n')).toBe('a\n');
  });

  it('collapses the empty and all-newline inputs', () => {
    expect(ensureTrailingNewline('')).toBe('\n');
    expect(ensureTrailingNewline('\n\n')).toBe('\n');
  });

  it('collapses a long trailing run without backtracking', () => {
    // A `/\n+$/` strip is quadratic on a run that large, so the test timeout is the
    // guard against reintroducing one.
    expect(ensureTrailingNewline(`x${'\n'.repeat(200_000)}`)).toBe('x\n');
  });
});

describe('normalizeText', () => {
  it('produces canonical bytes regardless of the input line endings', () => {
    expect(normalizeText('a\r\nb\r\n')).toBe('a\nb\n');
    expect(normalizeText('a\nb\n\n')).toBe('a\nb\n');
  });
});

describe('sha256Hex', () => {
  it('matches the published vector for the empty string', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('matches the published vector for "abc"', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('is stable across calls', () => {
    expect(sha256Hex('x')).toBe(sha256Hex('x'));
    expect(sha256Hex('x')).not.toBe(sha256Hex('y'));
  });
});

describe('ordering helpers', () => {
  it('orders strings by code unit', () => {
    expect(compareIds('a', 'b')).toBe(-1);
    expect(compareIds('b', 'a')).toBe(1);
    expect(compareIds('a', 'a')).toBe(0);
  });

  it('orders by a derived key', () => {
    const items = [{ id: 'b' }, { id: 'a' }, { id: 'c' }];
    expect(sortById(items).map((item) => item.id)).toEqual(['a', 'b', 'c']);
  });

  it('orders by path', () => {
    const items = [{ path: 'z' }, { path: 'a' }];
    expect(sortByPath(items).map((item) => item.path)).toEqual(['a', 'z']);
  });

  it('keeps input order for equal keys, so ordering is a function of identity alone', () => {
    const items = [
      { id: 'a', tag: 1 },
      { id: 'a', tag: 2 },
      { id: 'a', tag: 3 },
    ];
    expect(stableSortBy(items, (item) => item.id).map((item) => item.tag)).toEqual([1, 2, 3]);
  });
});

describe('stableId', () => {
  it('is deterministic', () => {
    expect(stableId('prompt', 'triage')).toBe(stableId('prompt', 'triage'));
  });

  it('differs for different values and namespaces', () => {
    expect(stableId('prompt', 'a')).not.toBe(stableId('prompt', 'b'));
    expect(stableId('prompt', 'a')).not.toBe(stableId('agent', 'a'));
  });

  it('is filesystem- and identifier-safe', () => {
    expect(stableId('prompt', 'triage')).toMatch(/^prompt-[0-9a-f]{12}$/);
  });
});

describe('generatedBanner', () => {
  it('names the generator and version but no time', () => {
    const banner = generatedBanner({ generator: '@aid/generator-py-fastapi', version: '0.1.0' });
    expect(banner).toContain(GENERATED_BANNER_MARKER);
    expect(banner).toContain('@aid/generator-py-fastapi');
    expect(banner).toContain('v0.1.0');
    expect(scanForNonDeterminism('banner.py', banner)).toEqual([]);
  });

  it('honours a language comment prefix', () => {
    const banner = generatedBanner({ generator: 'g', version: '1.0.0', comment: '#' });
    expect(first(banner.split('\n')).startsWith('# ')).toBe(true);
  });
});

describe('scanForNonDeterminism', () => {
  it('detects an absolute Windows path', () => {
    const found = scanForNonDeterminism('a.py', 'root = "C:/Users/dev/app"');
    expect(found.map((violation) => violation.pattern)).toContain('absolute-path-windows');
  });

  it('detects an absolute Unix path and a host directory', () => {
    expect(scanForNonDeterminism('a.py', 'root = "/home/dev/app"').map((v) => v.pattern)).toContain(
      'absolute-path-unix',
    );
    expect(scanForNonDeterminism('a.py', 'tmp = "/tmp/x"').map((v) => v.pattern)).toContain(
      'absolute-path-unix',
    );
  });

  it('detects a timestamp and a generated-on phrase', () => {
    expect(scanForNonDeterminism('a.py', '# 2026-01-02T03:04:05Z').map((v) => v.pattern)).toContain(
      'timestamp',
    );
    expect(
      scanForNonDeterminism('a.py', '# generated at build time').map((v) => v.pattern),
    ).toContain('generated-at-phrase');
  });

  it('detects generation-time randomness and a host name', () => {
    expect(
      scanForNonDeterminism('a.ts', 'const id = crypto.randomUUID();').map((v) => v.pattern),
    ).toContain('runtime-randomness');
    expect(scanForNonDeterminism('a.yml', 'hostname: buildbox-7').map((v) => v.pattern)).toContain(
      'hostname',
    );
  });

  it('reports the line number and trims the text', () => {
    const found = scanForNonDeterminism('a.py', 'ok = 1\n  bad = "C:/x"');
    expect(first(found).line).toBe(2);
    expect(first(found).text).toBe('bad = "C:/x"');
  });

  it('accepts a repo-relative path', () => {
    expect(scanForNonDeterminism('a.py', 'from app.generated import schema')).toEqual([]);
  });

  it('documents every pattern it can raise', () => {
    expect(DETERMINISM_PATTERNS.length).toBeGreaterThan(0);
    for (const candidate of DETERMINISM_PATTERNS) {
      expect(candidate.reason).not.toBe('');
      expect(typeof candidate.pattern.test).toBe('function');
    }
  });
});

describe('checkDeterminism', () => {
  it('aggregates violations across a file set, ordered by path', () => {
    const files: GeneratedFile[] = [
      { path: 'app/generated/b.py', content: 'x = "C:\\tmp\\a"\n', owner: 'generated' },
      { path: 'app/generated/a.py', content: 'y = "C:\\tmp\\b"\n', owner: 'generated' },
    ];
    const violations = checkDeterminism(files);
    expect(violations.map((violation) => violation.path)).toEqual([
      'app/generated/a.py',
      'app/generated/b.py',
    ]);
    expect(violations.map((violation) => violation.pattern)).toEqual([
      'absolute-path-windows',
      'absolute-path-windows',
    ]);
  });

  it('passes for canonical content', () => {
    const files: GeneratedFile[] = [
      { path: 'app/generated/a.py', content: normalizeText('y = 1\r\n'), owner: 'generated' },
    ];
    expect(checkDeterminism(files)).toEqual([]);
  });
});
