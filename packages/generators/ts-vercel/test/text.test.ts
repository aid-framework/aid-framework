/**
 * The byte-level helpers, and the edge trim the emitters depend on.
 *
 * `sections` used to trim its edges with `/\n+$/`, which is unanchored on the left: the
 * engine retries "one-or-more newlines, then end of input" at every position, so a body
 * carrying many newlines cost time quadratic in its length. CodeQL flagged that shape on
 * spec-derived input (`js/polynomial-redos`), and the fix is a scan. These cases pin the
 * behaviour the emitters rely on, on inputs large enough that a quadratic trim would not
 * return promptly.
 */

import { describe, expect, it } from 'vitest';

import { lines, sections } from '../src/emit/text.js';

describe('sections', () => {
  it('joins parts with exactly one blank line', () => {
    expect(sections('one', 'two', 'three')).toBe('one\n\ntwo\n\nthree');
  });

  it('drops parts that are empty or only newlines', () => {
    expect(sections('', '\n\n', 'body', '\n')).toBe('body');
  });

  it('trims the blank edges but keeps blank lines inside a part', () => {
    expect(sections('\n\nhead\n\nbody\n\n')).toBe('head\n\nbody');
  });

  it('returns an empty string when every part is blank', () => {
    expect(sections('\n', '', '\n\n')).toBe('');
  });

  it('handles a long run of newlines as an edge, not as content', () => {
    const run = '\n'.repeat(100_000);
    expect(sections(`${run}body${run}`, run, 'tail')).toBe('body\n\ntail');
  });
});

describe('lines', () => {
  it('omits only the unset fragments, so blank lines survive', () => {
    expect(lines('a', false, '', undefined, ['b', 'c'])).toEqual(['a', '', 'b', 'c']);
  });
});
