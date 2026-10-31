/**
 * This generator's own manifest declaration.
 *
 * Written out here rather than aliased from `@aid-framework/generator-sdk` for the same reason
 * `py-fastapi` does it: the SDK's declaration is what the IR's capability gate
 * consumes, this one is what the package emits from, and a test compares them. An
 * alias would make that comparison vacuous.
 *
 * Two deliberate omissions, both recorded in the README:
 *
 * - `emitsAgainst.vectorStore` does not exist in the SDK's vocabulary. Declaring an
 *   unknown `emitsAgainst` key is a hard manifest error (`manifestEmitsAgainstUnknown`),
 *   so `pgvector` is expressed as the emitted vector-store kind instead: the IR's
 *   `stores.<id>.kind` selects the runtime store, and this target supports `pgvector`.
 * - `streaming` is not declared, because the emitted code does not honour it. Calling
 *   `ModelGateway.stream` raises `FeatureDeferredError`, so declaring the capability
 *   would be exactly the fail-open the capability discipline forbids.
 */

import {
  type GeneratorManifest,
  type GeneratorManifestInput,
  parseManifest,
  supportsIR,
} from '@aid-framework/generator-sdk';
import { IR_VERSION } from '@aid-framework/ir';

export const TS_VERCEL_TARGET = 'ts-vercel';

/**
 * The capabilities this generator honours end to end. Each one has an emitter that
 * binds it to a runtime surface: HTTP triggers become route handlers, `json-schema`
 * becomes zod schemas, `tool-calling` becomes `Tool`/`ToolExecutor`, `otel` becomes
 * traced gateway calls, `embeddings`/`rerank` become retriever bindings, `guardrails`
 * becomes `GuardrailEngine` calls on the stages a route can reach, and `agents`/
 * `cursor-memory` become the `AgentRuntime` loop and its memory tiers.
 *
 * `guardrails`, `agents` and `cursor-memory` are declared since L6d, and the
 * declaration carries the same promise as the rows above: there is an emitter
 * (`./emit/guardrails.ts`, `./emit/agents.ts`), the TypeScript runtime implements the
 * engine and the loop, and the committed example exercises all three end to end.
 * `cursor-memory` is the IR's capability for a declared memory tier -- there is no
 * `memory` capability -- so a spec that declares memory derives `cursor-memory`.
 *
 * Before L6d this list stopped at `rerank` and `./validate.ts` rejected any spec that
 * mentioned the three collections. It still rejects the parts of each collection the
 * runtime cannot honour (four memory kinds, `ttl`, `redact`, a non-`in-process`
 * backend, three guardrail policies with no detector, a non-native engine), so a
 * declaration here is not a claim that every field is expressible.
 */
export const TS_VERCEL_CAPABILITIES = [
  'http-trigger',
  'json-schema',
  'tool-calling',
  'otel',
  'embeddings',
  'rerank',
  'guardrails',
  'agents',
  'cursor-memory',
] as const;

export const TS_VERCEL_MANIFEST_INPUT: GeneratorManifestInput = {
  manifestVersion: 1,
  name: '@aid-framework/generator-ts-vercel',
  target: TS_VERCEL_TARGET,
  version: '0.1.0',
  irRange: `^${IR_VERSION}`,
  capabilities: [...TS_VERCEL_CAPABILITIES],
  emitsAgainst: {
    structuredOutput: 'zod',
    tracing: 'otel-genai',
  },
  output: {
    // A7: `app` collides with Next's own `app/` convention. The plan accepts the
    // collision for parity with the SDK's `managedRoots` and flags it for review;
    // it is accepted here and stated in the README rather than worked around.
    root: 'app',
    generatedDir: 'generated',
    businessDir: 'business',
  },
};

function requireValidManifest(input: GeneratorManifestInput): GeneratorManifest {
  const { manifest, diagnostics } = parseManifest(input);
  if (manifest === undefined) {
    const rendered = diagnostics.map((d) => `  - ${d.code} at ${d.path}: ${d.message}`).join('\n');
    throw new Error(`${input.name} is not a valid generator manifest:\n${rendered}`);
  }
  return manifest;
}

export const TS_VERCEL_MANIFEST: GeneratorManifest = requireValidManifest(TS_VERCEL_MANIFEST_INPUT);

export const GENERATOR_NAME = TS_VERCEL_MANIFEST.name;
export const GENERATOR_VERSION = TS_VERCEL_MANIFEST.version;

export function supportsIrVersion(irVersion: string): boolean {
  return supportsIR(TS_VERCEL_MANIFEST, irVersion);
}
