/**
 * The Phase 0 target declarations, in the shape `@aid-framework/ir`'s capability gate consumes.
 *
 * `@aid-framework/ir` ships a placeholder (`PHASE_0_TARGET_CAPABILITIES`) precisely so the gate
 * can exist before a real generator does; this module is the replacement. It matters
 * that these are *declarations*, not aspirations: a target that claims `streaming`
 * makes every spec requiring streaming pass the capability gate, so the list is the
 * honest answer to "what does the code this generator emits actually do".
 *
 * Two facts are recorded here rather than hidden in prose:
 *
 * - `streaming` is declared since layer P7a. It was absent while both gateways raised
 *   `FeatureDeferredError`; the Python runtime now streams and the generator emits a
 *   route that negotiates `Accept: text/event-stream`, so the declaration is backed by
 *   an emitter, a runtime and a committed example. The TypeScript runtime still defers
 *   streaming (ratified to L6), which is why `@aid-framework/ir`'s derivation and this list are
 *   kept separate concerns.
 * - `agents` and `cursor-memory` are declared since layer P7b, and they are two
 *   declarations rather than one because the IR derives two: `agents` from an `agents`
 *   collection, `cursor-memory` from a `memory` collection (there is no `memory`
 *   capability to declare). Both are backed by emitted code -- `generated/agents.py`
 *   builds the runtime over this app's own gateway and tools and serves the routes --
 *   and by the example's `tests/test_agents.py`, which pauses a run and resumes it. The
 *   TypeScript target declares neither, so `@aid-framework/ir` will route a spec that needs them
 *   to the Python target or refuse it.
 * - the absence of `emitsAgainst.orchestration` — Phase 0 control flow is plain async,
 *   and orchestration frameworks are deferred to Phase 2. An agent loop is not an
 *   orchestration framework: the emitted `build_runtime` calls `AgentRuntime.from_ir`
 *   from the repo's own runtime and depends on nothing outside it.
 */

import { IR_VERSION, type TargetCapabilityDeclarations } from '@aid-framework/ir';
import { formatDiagnostics } from '@aid-framework/spec';

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
  name: '@aid-framework/generator-py-fastapi',
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
    'guardrails',
    'agents',
    'cursor-memory',
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

/** Drop-in replacement for `@aid-framework/ir`'s `phase0TargetCapabilities()`. */
export function phase0TargetCapabilities(): TargetCapabilityDeclarations {
  return targetCapabilityDeclarations(phase0Generators());
}
