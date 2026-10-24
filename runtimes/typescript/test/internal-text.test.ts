/**
 * The string helpers that replaced quantifier-anchored regexes.
 *
 * These take arbitrary-length input, so the regression that matters is a long run of
 * the character being stripped. Each case asserts the returned *value*; a helper that
 * merely returned something would pass while stripping the wrong number of characters.
 */

import { describe, expect, it } from 'vitest';

import { stripTrailingSlashes } from '../src/internal/text.js';

describe('stripTrailingSlashes', () => {
  it('drops a single trailing slash', () => {
    expect(stripTrailingSlashes('https://api.test/v1/')).toBe('https://api.test/v1');
  });

  it('drops every trailing slash, not just one', () => {
    expect(stripTrailingSlashes('https://api.test/v1///')).toBe('https://api.test/v1');
  });

  it('drops a long trailing run in one backward scan', () => {
    expect(stripTrailingSlashes(`https://api.test/v1${'/'.repeat(200_000)}`)).toBe(
      'https://api.test/v1',
    );
  });

  it('leaves a value with no trailing slash untouched', () => {
    expect(stripTrailingSlashes('https://api.test/v1')).toBe('https://api.test/v1');
    expect(stripTrailingSlashes('')).toBe('');
  });

  it('does not touch slashes that are not trailing', () => {
    expect(stripTrailingSlashes('/a/b/c')).toBe('/a/b/c');
    expect(stripTrailingSlashes('/a/b/')).toBe('/a/b');
  });

  it('strips unconditionally, so a bare scheme loses its // as the regex did', () => {
    // `/\/+$/` has no notion of a scheme: it takes both slashes and leaves the colon.
    expect(stripTrailingSlashes('https://')).toBe('https:');
    expect(stripTrailingSlashes('/')).toBe('');
    expect(stripTrailingSlashes('///')).toBe('');
  });
});
