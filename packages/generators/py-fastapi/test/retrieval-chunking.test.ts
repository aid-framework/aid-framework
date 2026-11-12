/**
 * `retriever.chunking.strategy`: semantic reaches the emitted bindings.
 *
 * This generator refused `semantic` at every version, mirroring the spec layer, on the
 * grounds that the strategy needed an embedding pass at ingest that Phase 1 did not do.
 * That stopped being true in spec 0.22, when the runtime's semantic chunker shipped, and
 * the refusal would have outlived it -- invisible to every test, because no test
 * declared a semantic retriever.
 *
 * Accepting the declaration and emitting a binding the runtime cannot chunk with are two
 * different failures, so these tests bind the acceptance to bytes: the semantic retriever
 * is planned without problems *and* the strategy reaches `RETRIEVAL_BINDINGS_PATH`. The
 * second test keeps the first non-vacuous -- it must be able to tell `semantic` from
 * `recursive`, or it would pass just as quietly if the strategy were emitted nowhere.
 */

import type { SpecVersion } from '@aid-framework/spec';
import { describe, expect, it } from 'vitest';

import { fileMap, RETRIEVAL_BINDINGS_PATH } from '../src/index.js';
import { buildForSpecText, exampleSpecTextAt } from './helpers.js';

/** The example spec at a version that has the semantic strategy. */
function exampleAt(version: SpecVersion): string {
  return exampleSpecTextAt(version);
}

/** The spec at `version` with its handbook retriever chunking semantically. */
function semanticExample(version: SpecVersion = '0.22'): string {
  const text = exampleAt(version).replace(
    '      strategy: recursive\n',
    '      strategy: semantic\n',
  );
  expect(text).toContain('strategy: semantic');
  return text;
}

function bindings(text: string): string {
  return fileMap(buildForSpecText(text).plan).get(RETRIEVAL_BINDINGS_PATH) ?? '';
}

describe('a retriever chunking strategy', () => {
  it('accepts semantic at 0.22 and emits it into the bindings', () => {
    // `planPyFastApi` raises `PyFastApiPlanError` on any problem, so a plan that comes
    // back at all is a plan this generator accepted.
    const emitted = bindings(semanticExample());

    expect(emitted).toMatch(/"strategy":\s*"semantic"/);
  });

  it('keeps the strategy distinguishable from recursive in the emitted bindings', () => {
    const fromRecursive = bindings(exampleAt('0.22'));
    const fromSemantic = bindings(semanticExample());

    expect(fromRecursive).toMatch(/"strategy":\s*"recursive"/);
    expect(fromRecursive).not.toMatch(/"strategy":\s*"semantic"/);
    expect(fromSemantic).not.toMatch(/"strategy":\s*"recursive"/);
  });

  it('still refuses a semantic retriever below 0.22', () => {
    expect(() => buildForSpecText(semanticExample('0.21'))).toThrow(/0\.22/);
  });
});
