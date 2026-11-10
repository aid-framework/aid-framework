/**
 * `retriever.chunking.strategy`: semantic reaches the emitted bindings.
 *
 * `chunkingExpression` in `src/emit/retrieval.ts` already emits the strategy literally, so
 * the emitter needed no change; these tests prove that, by planning a semantic retriever
 * and reading the emitted bindings. The spec layer refused `semantic` below 0.22, which is
 * what this generator inherits: `checkSpecText` rejects the declaration at an older
 * version, so a below-version spec never reaches the emitter.
 *
 * The second test keeps the first non-vacuous: it must be able to tell `semantic` from
 * `recursive`, or it would pass just as quietly if the strategy were emitted nowhere.
 */

import { describe, expect, it } from 'vitest';

import { paths } from '../src/index.js';
import { buildForSpecText, exampleSpecText, fileMap } from './helpers.js';

/** The example spec at a version that has the semantic strategy. */
function exampleAt(version: string): string {
  return exampleSpecText().replace('specVersion: "0.2"', `specVersion: "${version}"`);
}

/** The spec at `version` with its handbook retriever chunking semantically. */
function semanticExample(version = '0.22'): string {
  const text = exampleAt(version).replace(
    '      strategy: recursive\n',
    '      strategy: semantic\n',
  );
  expect(text).toContain('strategy: semantic');
  return text;
}

function bindings(text: string): string {
  return fileMap(buildForSpecText(text).plan.files).get(paths.retrievalBindings) ?? '';
}

describe('a retriever chunking strategy', () => {
  it('accepts semantic at 0.22 and emits it into the bindings', () => {
    expect(bindings(semanticExample())).toContain("strategy: 'semantic'");
  });

  it('keeps the strategy distinguishable from recursive in the emitted bindings', () => {
    const fromRecursive = bindings(exampleAt('0.22'));
    const fromSemantic = bindings(semanticExample());

    expect(fromRecursive).toContain("strategy: 'recursive'");
    expect(fromRecursive).not.toContain("strategy: 'semantic'");
    expect(fromSemantic).not.toContain("strategy: 'recursive'");
  });

  it('still refuses a semantic retriever below 0.22', () => {
    expect(() => buildForSpecText(semanticExample('0.21'))).toThrow(/0\.22/);
  });
});
