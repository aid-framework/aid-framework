/**
 * This generator's own manifest declaration.
 *
 * The declaration is written out here rather than re-exported from
 * `@aid-framework/generator-sdk`'s `targets.ts`, because the two are checked against each other:
 * the SDK ships the target declarations the IR's capability gate consumes, and this
 * package ships the one it actually emits. A test asserts the two are deeply equal, so
 * either side drifting is a failing check rather than a silent divergence. If this
 * declaration were an alias of the SDK's, that check would be vacuous.
 *
 * `emitsAgainst` is part of the shape for the same reason: it is what keeps
 * orchestration swappable. Phase 0 has no orchestration key at all, which is the
 * declaration that the emitted code is plain async.
 *
 * `streaming` and `guardrails` are declared since layer P7a, and the declaration is
 * the same promise as every other row here: there is an emitter, both runtimes
 * implement it, and the committed example exercises it. P7a is what changed the
 * facts — `stream` negotiates `Accept: text/event-stream` on the existing pipeline
 * route, and `guardrails` runs the runtime's `GuardrailEngine` on the stages a route
 * can reach. Before P7a this line said the opposite, because `stream()` raised
 * `FeatureDeferredError` and no guardrail was ever evaluated; a declaration is only
 * worth the code behind it, so the prose moves with the code rather than ahead of it.
 *
 * `agents` and `cursor-memory` are declared since layer P7b, and the declaration carries
 * the same promise as the rows above: there is an emitter (`./emit/agents.ts`), the
 * Python runtime implements the agent loop, and the committed example exercises it end to
 * end. `cursor-memory` is the IR's capability for a declared memory tier -- there is no
 * `memory` capability in `REQUIRED_CAPABILITIES` -- so a spec that declares memory derives
 * `cursor-memory`, and declaring it here is the statement that this target serves it.
 *
 * Before P7b this block said both were unsupported and `./validate.ts` rejected a spec
 * mentioning either. It still does reject the parts of each collection the runtime cannot
 * honour (`agents[].retrievers`, `agents[].structuredOutput`, four memory kinds, `ttl`,
 * `redact`), so a declaration here is not a claim that every field is expressible.
 */

import {
  type GeneratorManifest,
  type GeneratorManifestInput,
  parseManifest,
  supportsIR,
} from '@aid-framework/generator-sdk';
import { IR_VERSION } from '@aid-framework/ir';
import { formatDiagnostics } from '@aid-framework/spec';

export const PY_FASTAPI_TARGET = 'py-fastapi';

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
