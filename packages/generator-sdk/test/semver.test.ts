import { describe, expect, it } from 'vitest';

import {
  compareVersions,
  formatVersion,
  isValidRange,
  isValidVersion,
  parseRange,
  parseVersion,
  satisfies,
} from '../src/index.js';
import { first } from './helpers.js';

describe('parseVersion', () => {
  it('parses a plain release', () => {
    expect(parseVersion('1.2.3')).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: [],
    });
  });

  it('parses pre-release identifiers as numbers where numeric', () => {
    expect(parseVersion('1.0.0-rc.1')).toEqual({
      major: 1,
      minor: 0,
      patch: 0,
      prerelease: ['rc', 1],
    });
  });

  it('rejects a partial version', () => {
    expect(parseVersion('1.2')).toBeUndefined();
    expect(parseVersion('1')).toBeUndefined();
  });

  it('rejects a leading v', () => {
    expect(parseVersion('v1.2.3')).toBeUndefined();
  });

  it('rejects leading zeroes', () => {
    expect(parseVersion('01.2.3')).toBeUndefined();
  });

  it('accepts and ignores build metadata', () => {
    expect(parseVersion('1.2.3+build.5')).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: [],
    });
  });

  it('validates without parsing', () => {
    expect(isValidVersion('0.1.0')).toBe(true);
    expect(isValidVersion('0.1')).toBe(false);
  });
});

describe('formatVersion', () => {
  it('round-trips', () => {
    const parsed = parseVersion('2.0.0-beta.3');
    expect(parsed).toBeDefined();
    expect(formatVersion(parsed as NonNullable<typeof parsed>)).toBe('2.0.0-beta.3');
  });
});

describe('compareVersions', () => {
  it('orders by major, minor, then patch', () => {
    expect(compareVersions(version('2.0.0'), version('1.9.9'))).toBe(1);
    expect(compareVersions(version('1.2.0'), version('1.10.0'))).toBe(-1);
    expect(compareVersions(version('1.0.0'), version('1.0.1'))).toBe(-1);
  });

  it('ranks a release above its pre-release', () => {
    expect(compareVersions(version('1.0.0'), version('1.0.0-rc.1'))).toBe(1);
  });

  it('ranks numeric identifiers below alphanumeric ones', () => {
    expect(compareVersions(version('1.0.0-1'), version('1.0.0-alpha'))).toBe(-1);
  });

  it('ranks a shorter pre-release below a longer one sharing its prefix', () => {
    expect(compareVersions(version('1.0.0-rc'), version('1.0.0-rc.1'))).toBe(-1);
  });
});

describe('parseRange', () => {
  it('rejects an empty range', () => {
    expect(parseRange('')).toBeUndefined();
    expect(parseRange('   ')).toBeUndefined();
  });

  it('rejects an incomplete alternative', () => {
    expect(parseRange('1.2.3 ||')).toBeUndefined();
  });

  it('rejects hyphen ranges rather than approximating them', () => {
    expect(parseRange('1.2.3 - 2.0.0')).toBeUndefined();
    expect(isValidRange('1.2.3 - 2.0.0')).toBe(false);
  });

  it('rejects an unknown operator', () => {
    expect(parseRange('=>1.2.3')).toBeUndefined();
  });

  it('rejects a bare narrowing operator with no version', () => {
    expect(parseRange('>=')).toBeUndefined();
  });

  it('accepts a blank alternative list as a wildcard', () => {
    const range = parseRange('*');
    expect(range?.any).toBe(true);
  });
});

describe('satisfies', () => {
  it('handles caret ranges inside a major version', () => {
    expect(satisfies('1.2.3', '^1.2.0')).toBe(true);
    expect(satisfies('1.9.9', '^1.2.0')).toBe(true);
    expect(satisfies('2.0.0', '^1.2.0')).toBe(false);
  });

  it('caps a caret range at the minor version for 0.x', () => {
    expect(satisfies('0.1.5', '^0.1.0')).toBe(true);
    expect(satisfies('0.2.0', '^0.1.0')).toBe(false);
  });

  it('handles tilde ranges', () => {
    expect(satisfies('1.2.9', '~1.2.0')).toBe(true);
    expect(satisfies('1.3.0', '~1.2.0')).toBe(false);
  });

  it('handles comparators, partial versions, and wildcards', () => {
    expect(satisfies('1.2.3', '>=1.0.0')).toBe(true);
    expect(satisfies('0.9.0', '>=1.0.0')).toBe(false);
    expect(satisfies('1.4.0', '1.x')).toBe(true);
    expect(satisfies('2.0.0', '1.x')).toBe(false);
    expect(satisfies('1.2.9', '1.2')).toBe(true);
    expect(satisfies('1.3.0', '1.2')).toBe(false);
  });

  it('handles alternatives', () => {
    expect(satisfies('1.4.9', '~1.4.0 || >=1.5.0')).toBe(true);
    expect(satisfies('1.5.0', '~1.4.0 || >=1.5.0')).toBe(true);
    expect(satisfies('1.3.0', '~1.4.0 || >=1.5.0')).toBe(false);
  });

  it('does not let a pre-release satisfy a range that names no pre-release', () => {
    expect(satisfies('1.2.3-rc.1', '^1.2.3')).toBe(false);
  });

  it('lets a pre-release satisfy a range anchored at that pre-release', () => {
    expect(satisfies('1.2.3-rc.2', '>=1.2.3-rc.1 <1.3.0')).toBe(true);
  });

  it('returns false for an unparseable input rather than guessing', () => {
    expect(satisfies('1.2', '^1.0.0')).toBe(false);
    expect(satisfies('1.2.3', 'not-a-range')).toBe(false);
  });

  it('constrains nothing for a range that names no version', () => {
    expect(satisfies('9.9.9', '*')).toBe(true);
    expect(satisfies('9.9.9', 'x')).toBe(true);
    expect(satisfies('9.9.9', '^x.x')).toBe(true);
    expect(satisfies('9.9.9', '>=x')).toBe(true);
  });

  it('treats an exact operator as equality', () => {
    expect(satisfies('1.2.3', '=1.2.3')).toBe(true);
    expect(satisfies('1.2.4', '=1.2.3')).toBe(false);
    // A bare `1.2.3` is `=1.2.3`, not a caret range: only a *partial* version widens.
    expect(satisfies('1.2.3', '1.2.3')).toBe(true);
    expect(satisfies('1.2.4', '1.2.3')).toBe(false);
  });

  it('matches the manifest irRange used by the Phase 0 target', () => {
    expect(satisfies('0.1.0', '^0.1.0')).toBe(true);
    expect(satisfies('0.2.0', '^0.1.0')).toBe(false);
  });

  it('expands multiple comparators in one alternative as a conjunction', () => {
    const range = parseRange('>=1.0.0 <2.0.0');
    expect(range).toBeDefined();
    expect(first(range?.alternatives ?? []).length).toBe(2);
    expect(satisfies('1.5.0', '>=1.0.0 <2.0.0')).toBe(true);
    expect(satisfies('2.0.0', '>=1.0.0 <2.0.0')).toBe(false);
  });
});

function version(text: string) {
  const parsed = parseVersion(text);
  if (parsed === undefined) throw new Error(`bad fixture version: ${text}`);
  return parsed;
}
