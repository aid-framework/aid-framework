/**
 * `retriever.refresh`: the runtime reconciles an index in either mode.
 *
 * `incremental` shipped in spec 0.19, implemented by the retrieval runtime and reached
 * through the retriever literal this generator emits. The generation-time table kept
 * refusing every mode but `full`, on the grounds that "the runtime rebuilds the whole
 * index on every ingest" -- true before 0.19, false after it, and invisible to any test
 * because no test declared the mode.
 *
 * These tests bind the claim to code rather than to a comment. The first shows an
 * incremental retriever plans, and shows the mode travelling into the emitted bindings,
 * so accepting the spec and dropping the setting are different failures. The second
 * makes the first non-vacuous: the same binding assertion must tell `full` from
 * `incremental`, or it would pass just as quietly if the mode were emitted nowhere.
 */

import { describe, expect, it } from 'vitest';

import { fileMap, RETRIEVAL_BINDINGS_PATH } from '../src/index.js';
import { buildForSpecText, exampleSpecText } from './helpers.js';

/**
 * The example spec at the newest spec version, so a construct introduced in 0.19 or
 * later is legal here.
 *
 * A later version only ever adds requirements to features the spec already uses, so
 * re-declaring the same document at `0.20` cannot invalidate anything above.
 */
function latestExample(): string {
  return exampleSpecText().replace('specVersion: "0.2"', 'specVersion: "0.20"');
}

describe('a retriever refresh mode', () => {
  it('accepts incremental, and emits the mode into the bindings', () => {
    const text = latestExample().replace(
      'refresh:\n      mode: full',
      'refresh:\n      mode: incremental',
    );
    expect(text).toContain('mode: incremental');

    const { plan } = buildForSpecText(text);
    const bindings = fileMap(plan).get(RETRIEVAL_BINDINGS_PATH) ?? '';
    expect(bindings).toMatch(/"mode":\s*"incremental"/);
  });

  it('keeps the two modes distinguishable in the emitted bindings', () => {
    const bindings = (text: string): string =>
      fileMap(buildForSpecText(text).plan).get(RETRIEVAL_BINDINGS_PATH) ?? '';

    const full = bindings(latestExample());
    const incremental = bindings(
      latestExample().replace('refresh:\n      mode: full', 'refresh:\n      mode: incremental'),
    );

    expect(full).toMatch(/"mode":\s*"full"/);
    expect(full).not.toMatch(/"mode":\s*"incremental"/);
    expect(incremental).not.toMatch(/"mode":\s*"full"/);
  });
});
