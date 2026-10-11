/**
 * The canonical IR for the full fixture is committed and compared byte for byte.
 * The test never rewrites the file: a regenerating comparison would pass whatever the
 * builder happened to produce, which is the opposite of a golden test.
 */

import { describe, expect, it } from 'vitest';

import { serializeIR } from '../src/index.js';
import { buildFixture, goldenText } from './helpers.js';

const GOLDENS = [
  { golden: 'full.ir.json', spec: 'full.yaml' },
  { golden: 'retrieval.ir.json', spec: 'retrieval.yaml' },
] as const;

describe.each(GOLDENS)('canonical IR golden: $golden', ({ golden, spec }) => {
  it('matches the committed golden byte for byte', () => {
    expect(serializeIR(buildFixture(spec).ir)).toBe(goldenText(golden));
  });

  it('is already canonical on disk: LF endings and exactly one trailing newline', () => {
    const text = goldenText(golden);
    expect(text).not.toContain('\r');
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
  });

  it('is byte-identical across two builds of the same spec', () => {
    expect(serializeIR(buildFixture(spec).ir)).toBe(serializeIR(buildFixture(spec).ir));
  });
});
