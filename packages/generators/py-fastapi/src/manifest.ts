/**
 * This generator's own manifest declaration.
 *
 * The declaration is written out here rather than re-exported from
 * `@aid/generator-sdk`'s `targets.ts`, because the two are checked against each other:
 * the SDK ships the target declarations the IR's capability gate consumes, and this
 * package ships the one it actually emits. A test asserts the two are deeply equal, so
 * either side drifting is a failing check rather than a silent divergence. If this
 * declaration were an alias of the SDK's, that check would be vacuous.
 *
 * `emitsAgainst` is part of the shape for the same reason: it is what keeps
 * orchestration swappable. Phase 0 has no orchestration key at all, which is the
 * declaration that the emitted code is plain async.
 */

import {
  type GeneratorManifest,
  type GeneratorManifestInput,
  parseManifest,
  supportsIR,
} from '@aid/generator-sdk';
import { IR_VERSION } from '@aid/ir';
import { formatDiagnostics } from '@aid/spec';

export const PY_FASTAPI_TARGET = 'py-fastapi';

export const PY_FASTAPI_MANIFEST_INPUT: GeneratorManifestInput = {
  manifestVersion: 1,
  name: '@aid/generator-py-fastapi',
  target: PY_FASTAPI_TARGET,
  version: '0.1.0',
  irRange: `^${IR_VERSION}`,
  capabilities: [
    'http-trigger',
    'json-schema',
    'streaming',
    'tool-calling',
    'otel',
    'embeddings',
    'rerank',
  ],
  emitsAgainst: {
    structuredOutput: 'pydantic',
    tracing: 'otel-genai',
  },
  output: {
    root: 'app',
    generatedDir: 'generated',
    businessDir: 'business',
  },
};

/**
 * A manifest that does not parse is a programming error in this package rather than
 * user input, so it throws at module load rather than returning diagnostics no caller
 * is in a position to act on.
 */
function requireValidManifest(input: GeneratorManifestInput): GeneratorManifest {
  const { manifest, diagnostics } = parseManifest(input);
  if (manifest === undefined) {
    throw new Error(
      `${input.name} is not a valid generator manifest:\n${formatDiagnostics(diagnostics)}`,
    );
  }
  return manifest;
}

export const PY_FASTAPI_MANIFEST: GeneratorManifest =
  requireValidManifest(PY_FASTAPI_MANIFEST_INPUT);

/**
 * The generator identity, derived from the manifest so the ownership banner can never
 * disagree with the manifest a loader reads.
 */
export const GENERATOR_NAME = PY_FASTAPI_MANIFEST.name;
export const GENERATOR_VERSION = PY_FASTAPI_MANIFEST.version;

/** Whether this generator's `irRange` covers `irVersion`. */
export function supportsIrVersion(irVersion: string): boolean {
  return supportsIR(PY_FASTAPI_MANIFEST, irVersion);
}
