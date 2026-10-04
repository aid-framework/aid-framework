import { describe, expect, it } from 'vitest';

import { CANONICAL_INDENT, canonicalJson, serializeIR } from '../src/index.js';
import { buildFixture, fixtureText } from './helpers.js';

const ir = buildFixture('full.yaml').ir;

describe('canonicalJson', () => {
  it('sorts object keys at every depth and indents by two spaces', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [1, 2] } })).toBe(
      '{\n  "a": {\n    "c": [\n      1,\n      2\n    ],\n    "d": 2\n  },\n  "b": 1\n}',
    );
  });

  it('leaves arrays in declared order, because an array order is meaningful', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[\n  3,\n  1,\n  2\n]');
  });

  it('renders empty containers compactly', () => {
    expect(canonicalJson({})).toBe('{}');
    expect(canonicalJson([])).toBe('[]');
  });

  it('omits undefined-valued keys instead of writing null', () => {
    const text = canonicalJson({ keep: 1, drop: undefined });
    expect(text).toBe('{\n  "keep": 1\n}');
    expect(text).not.toContain('null');
  });

  it('round-trips floats and large numbers', () => {
    for (const value of [0, 0.1, 1.5, 1e21, -1.25e-7, Number.MAX_SAFE_INTEGER]) {
      expect(JSON.parse(canonicalJson({ value }))).toEqual({ value });
    }
    expect(canonicalJson(-0)).toBe('0');
  });

  it('refuses values JSON cannot represent', () => {
    expect(() => canonicalJson({ value: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalJson({ value: Number.POSITIVE_INFINITY })).toThrow(TypeError);
    expect(() => canonicalJson(undefined)).toThrow(TypeError);
    expect(() => canonicalJson({ value: () => 1 })).toThrow(TypeError);
  });

  it('indents with a two-space unit and writes no trailing newline itself', () => {
    expect(CANONICAL_INDENT).toBe('  ');
    expect(canonicalJson({ a: 1 })).toBe('{\n  "a": 1\n}');
  });
});

describe('serializeIR', () => {
  it('ends with exactly one LF and never a CR', () => {
    const text = serializeIR(ir);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
    expect(text).not.toContain('\r');
  });

  it('is byte-identical for the same IR', () => {
    expect(serializeIR(ir)).toBe(serializeIR(ir));
  });

  it('is byte-identical for the same spec text built twice', () => {
    expect(serializeIR(buildFixture('full.yaml').ir)).toBe(
      serializeIR(buildFixture('full.yaml').ir),
    );
  });

  it('is byte-identical for two documents differing only in key order', () => {
    expect(fixtureText('key-order-b.yaml')).not.toBe(fixtureText('key-order-a.yaml'));
    expect(serializeIR(buildFixture('key-order-b.yaml').ir)).toBe(
      serializeIR(buildFixture('key-order-a.yaml').ir),
    );
  });

  it('carries the whole IR with nothing added, lost, or reordered', () => {
    expect(JSON.parse(serializeIR(ir))).toEqual(JSON.parse(JSON.stringify(ir)));
  });
});
