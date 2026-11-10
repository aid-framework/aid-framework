/**
 * `retriever.source`: the s3 and http kinds reach the emitted bindings.
 *
 * This generator refused every source but `file` on the grounds that the runtime's
 * connector could only open one. That stopped being true in spec 0.21, when the s3 and
 * http loaders shipped, and the refusal outlived them -- invisible to every test,
 * because no test declared a remote source.
 *
 * `sourceExpression` in `src/emit/retrieval.ts` already emits `kind` and `uri` literally,
 * so the emitter needed no change; these tests prove that, by planning an s3 source and
 * reading the emitted bindings. The second test keeps the first non-vacuous: it must be
 * able to tell `s3` from `file`, or it would pass just as quietly if the source were
 * emitted nowhere.
 *
 * `db` and `mcp` stay refused, which is the spec layer's refusal rather than this one's:
 * `checkSpecText` rejects them at every version, so a generator never sees them.
 */

import { describe, expect, it } from 'vitest';

import { paths } from '../src/index.js';
import { buildForSpecText, exampleSpecText, fileMap } from './helpers.js';

/** The example spec at a version that has the s3 and http loaders. */
function exampleAt(version: string): string {
  return exampleSpecText().replace('specVersion: "0.2"', `specVersion: "${version}"`);
}

/** The spec at `version` with its handbook retriever reading S3 instead of a directory. */
function s3Example(version = '0.21'): string {
  const text = exampleAt(version).replace(
    '      kind: file\n      uri: ./docs\n',
    '      kind: s3\n      uri: s3://corpus/handbook\n',
  );
  expect(text).toContain('uri: s3://corpus/handbook');
  return text;
}

function bindings(text: string): string {
  return fileMap(buildForSpecText(text).plan.files).get(paths.retrievalBindings) ?? '';
}

describe('a retriever source kind', () => {
  it('accepts s3 at 0.21 and emits it into the bindings', () => {
    const emitted = bindings(s3Example());

    expect(emitted).toContain("kind: 's3'");
    expect(emitted).toContain("uri: 's3://corpus/handbook'");
    // A remote *source* does not make the retriever managed; the source is one field of
    // a local retriever, and the glob still describes the S3 keys.
    expect(emitted).toContain('glob:');
  });

  it('keeps the source kind distinguishable from file in the emitted bindings', () => {
    const fromFile = bindings(exampleAt('0.21'));
    const fromS3 = bindings(s3Example());

    expect(fromFile).toContain("kind: 'file'");
    expect(fromFile).not.toContain("kind: 's3'");
    expect(fromS3).not.toContain("kind: 'file'");
  });

  it('still refuses an s3 source below 0.21', () => {
    expect(() => buildForSpecText(s3Example('0.2'))).toThrow(/0\.21/);
  });
});
