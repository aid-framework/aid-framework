/**
 * The canonical IR for the full fixture is committed and compared byte for byte.
 * The test never rewrites the file: a regenerating comparison would pass whatever the
 * builder happened to produce, which is the opposite of a golden test.
 */

import { describe, expect, it } from 'vitest';

import { serializeIR } from '../src/index.js';
import { buildFixture, goldenText } from './helpers.js';

const GOLDEN = 'full.ir.json';

describe('canonical IR golden', () => {
  it('matches the committed golden byte for byte', () => {
    const actual = serializeIR(buildFixture('full.yaml').ir);
    expect(actual).toBe(goldenText(GOLDEN));
  });

  it('is already canonical on disk: LF endings and exactly one trailing newline', () => {
    const golden = goldenText(GOLDEN);
    expect(golden).not.toContain('\r');
    expect(golden.endsWith('\n')).toBe(true);
    expect(golden.endsWith('\n\n')).toBe(false);
  });

  it('is byte-identical across two builds of the same spec', () => {
    expect(serializeIR(buildFixture('full.yaml').ir)).toBe(
      serializeIR(buildFixture('full.yaml').ir),
    );
  });
});
