/**
 * `retriever.source`: the s3 and http kinds reach the emitted bindings.
 *
 * This generator refused every source but `file` on the grounds that the runtime's
 * connector could only open one. That stopped being true in spec 0.21, when the s3 and
 * http loaders shipped, and the refusal outlived them -- invisible to every test,
 * because no test declared a remote source.
 *
 * Accepting the declaration and emitting a binding the runtime cannot open are two
 * different failures, so these tests bind the acceptance to bytes: the s3 source is
 * planned without problems *and* the source reaches `RETRIEVAL_BINDINGS_PATH`. The
 * second test keeps the first non-vacuous -- it must be able to tell `s3` from `file`,
 * or it would pass just as quietly if the source were emitted nowhere.
 *
 * `db` and `mcp` stay refused, which is the spec layer's refusal rather than this one's:
 * `checkSpecText` rejects them at every version, so a generator never sees them.
 */

import { describe, expect, it } from 'vitest';

import type { SpecVersion } from '@aid-framework/spec';

import { fileMap, RETRIEVAL_BINDINGS_PATH } from '../src/index.js';
import { buildForSpecText, exampleSpecTextAt } from './helpers.js';

/** The example spec at a version that has the s3 and http loaders. */
function exampleAt(version: SpecVersion): string {
  return exampleSpecTextAt(version);
}

/** The spec at `version` with its handbook retriever reading S3 instead of a directory. */
function s3Example(version: SpecVersion = '0.21'): string {
  const text = exampleAt(version).replace(
    '      kind: file\n      uri: ./docs\n',
    '      kind: s3\n      uri: s3://corpus/handbook\n',
  );
  expect(text).toContain('uri: s3://corpus/handbook');
  return text;
}

function bindings(text: string): string {
  return fileMap(buildForSpecText(text).plan).get(RETRIEVAL_BINDINGS_PATH) ?? '';
}

describe('a retriever source kind', () => {
  it('accepts s3 at 0.21 and emits it into the bindings', () => {
    // `planPyFastApi` raises `PyFastApiPlanError` on any problem, so a plan that comes
    // back at all is a plan this generator accepted.
    const { plan } = buildForSpecText(s3Example());

    const emitted = fileMap(plan).get(RETRIEVAL_BINDINGS_PATH) ?? '';
    expect(emitted).toMatch(/"kind":\s*"s3"/);
    expect(emitted).toContain('s3://corpus/handbook');
    // The retriever is still a local one: `kind` at the retriever level is the
    // local-vs-managed dispatch, and a remote *source* does not make it managed.
    expect(emitted).toMatch(/"kind":\s*"local"/);
  });

  it('keeps the source kind distinguishable from file in the emitted bindings', () => {
    const fromFile = bindings(exampleAt('0.21'));
    const fromS3 = bindings(s3Example());

    expect(fromFile).toMatch(/"kind":\s*"file"/);
    expect(fromFile).not.toMatch(/"kind":\s*"s3"/);
    expect(fromS3).not.toMatch(/"kind":\s*"file"/);
  });

  it('still refuses an s3 source below 0.21', () => {
    expect(() => buildForSpecText(s3Example('0.2'))).toThrow(/0\.21/);
  });
});
