/**
 * The Phase 0 target declarations, in the shape `@aid/ir`'s capability gate consumes.
 *
 * `@aid/ir` ships a placeholder (`PHASE_0_TARGET_CAPABILITIES`) precisely so the gate
 * can exist before a real generator does; this module is the replacement. It matters
 * that these are *declarations*, not aspirations: a target that claims `streaming`
 * makes every spec requiring streaming pass the capability gate, so the list is the
 * honest answer to "what does the code this generator emits actually do".
 *
 * Two things are declared but deliberately not implemented in Phase 0, and both are
 * recorded here rather than hidden in prose:
 *
 * - `streaming` — the runtime is request/response only; the capability is declared so
 *   the IR vocabulary is exercised end to end.
 * - the absence of `emitsAgainst.orchestration` — Phase 0 control flow is plain async,
 *   and orchestration frameworks are deferred to Phase 2.
 */

import { IR_VERSION, type TargetCapabilityDeclarations } from '@aid/ir';
import { formatDiagnostics } from '@aid/spec';

import {
  type GeneratorManifest,
  type GeneratorManifestInput,
  parseManifest,
  targetCapabilityDeclarations,
} from './manifest.js';

export const PY_FASTAPI_TARGET = 'py-fastapi';

/**
 * The FastAPI + Pydantic target. `emitsAgainst` says the emitted code binds to
 * Pydantic for structured output and OpenTelemetry GenAI for tracing, and to no
 * orchestration framework at all.
 */
export const PY_FASTAPI_MANIFEST_INPUT: GeneratorManifestInput = {
  manifestVersion: 1,
  name: '@aid/generator-py-fastapi',
  target: PY_FASTAPI_TARGET,
  version: '0.1.0',
  irRange: `^${IR_VERSION}`,
  capabilities: ['http-trigger', 'json-schema', 'streaming', 'tool-calling', 'otel'],
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
 * The generator set is validated at module load. A manifest that does not parse is a
 * programming error in this package, not user input, so it throws rather than returning
 * diagnostics no caller is in a position to act on.
 */
function requireValidManifest(label: string, input: GeneratorManifestInput): GeneratorManifest {
  const { manifest, diagnostics } = parseManifest(input);
  if (manifest === undefined) {
    throw new Error(
      `${label} is not a valid generator manifest:\n${formatDiagnostics(diagnostics)}`,
    );
  }
  return manifest;
}

export const PY_FASTAPI_MANIFEST: GeneratorManifest = requireValidManifest(
  PY_FASTAPI_MANIFEST_INPUT.name,
  PY_FASTAPI_MANIFEST_INPUT,
);

export function phase0Generators(): GeneratorManifest[] {
  return [PY_FASTAPI_MANIFEST];
}

/** Drop-in replacement for `@aid/ir`'s `phase0TargetCapabilities()`. */
export function phase0TargetCapabilities(): TargetCapabilityDeclarations {
  return targetCapabilityDeclarations(phase0Generators());
}
