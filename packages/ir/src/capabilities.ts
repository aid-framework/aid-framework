/**
 * The capability vocabularies. There are two, and they are deliberately distinct:
 * `RequiredCapability` describes what a *target generator* must support, and
 * `ModelCapability` describes what a *model* supports.
 *
 * `docs/design.md` §8.1 declares `Generator.capabilities: TargetCapability[]` but
 * never defines `TargetCapability`; §7.2 defines the model vocabulary separately.
 * This module is the single normative definition of the target vocabulary, and
 * layer 3 aliases `TargetCapability` to `RequiredCapability` instead of inventing
 * a third spelling. No capability string is a bare literal anywhere else in this
 * package.
 */

import type { IR } from './shapes.js';

/** What a target generator must support. §8.1 spellings win where the two lists collide. */
export const REQUIRED_CAPABILITIES = [
  'http-trigger',
  'json-schema',
  'streaming', // §8.1
  'tool-calling', // §8.1 (the plan's `tool-call-explicit`)
  'cursor-memory', // §8.1
  'otel', // §8.1 (the plan's `otel-genai`)
  'vision',
  'audio',
  'embeddings',
  'rerank',
  'long-context',
  'reasoning',
  'prompt-cache',
  // The two capabilities spec v0.2's shape requires but no Phase 2 layer L1 target
  // emits. They are in the vocabulary so a spec that declares agents is negotiated
  // against every target and rejected *by name*; declaring them on a target before
  // the runtime exists would be exactly the D-1 false declaration this layer removes.
  'agents',
  'guardrails',
] as const;

export type RequiredCapability = (typeof REQUIRED_CAPABILITIES)[number];

/** What a model supports, per §7.2. The spec DSL's `tools` maps onto `tool-calling`. */
export const MODEL_CAPABILITIES = [
  'json-schema',
  'streaming',
  'tool-calling',
  'vision',
  'audio',
  'embeddings',
  'rerank',
  'long-context',
  'reasoning',
  'prompt-cache',
] as const;

export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];

/** The spec DSL's closed `capabilities` enum, in §7.2 spelling. */
export const SPEC_MODEL_CAPABILITY_MAP = {
  'json-schema': 'json-schema',
  streaming: 'streaming',
  tools: 'tool-calling',
  embeddings: 'embeddings',
} as const;

export function isRequiredCapability(value: string): value is RequiredCapability {
  return (REQUIRED_CAPABILITIES as readonly string[]).includes(value);
}

/**
 * Foreign spellings for a capability, mapped to the canonical name. §8.1 and
 * §7.3/§7.4 name the same two capabilities differently; accepting either spelling
 * through one map keeps the vocabulary single-valued without losing the doc's
 * wording.
 */
export const TARGET_CAPABILITY_ALIASES: Record<string, RequiredCapability> = {
  'otel-genai': 'otel',
  'tool-call-explicit': 'tool-calling',
};

/** Resolves a declared capability string to its canonical spelling. */
export function resolveRequiredCapability(value: string): RequiredCapability | undefined {
  if (isRequiredCapability(value)) return value;
  return TARGET_CAPABILITY_ALIASES[value];
}

export function isModelCapability(value: string): value is ModelCapability {
  return (MODEL_CAPABILITIES as readonly string[]).includes(value);
}

/**
 * A capability no target can be required to serve yet, and the layer that will make
 * it derivable. The truthfulness test asserts every vocabulary member is either
 * derivable or listed here, so a capability cannot be added to the vocabulary and
 * quietly never be derived - nor can the list grow by deleting a member.
 */
export interface DeferredCapability {
  readonly reason: string;
  readonly phase: string;
}

export const DEFERRED_CAPABILITIES: Readonly<
  Record<
    'streaming' | 'vision' | 'audio' | 'long-context' | 'reasoning' | 'prompt-cache',
    DeferredCapability
  >
> = {
  streaming: {
    reason:
      'Neither runtime streams: both gateways raise FeatureDeferredError, so no target declares the capability and nothing may derive a requirement for it.',
    phase: 'L5',
  },
  vision: {
    reason:
      'Spec v0.2 has no image input, so there is no IR content that could derive this requirement and no generator emits vision wiring.',
    phase: 'not scheduled',
  },
  audio: {
    reason:
      'Spec v0.2 has no audio input, so there is no IR content that could derive this requirement and no generator emits audio wiring.',
    phase: 'not scheduled',
  },
  'long-context': {
    reason:
      'Context length is a property of the chosen model, not something the IR declares; deriving it would require a spec-level context budget that does not exist yet.',
    phase: 'not scheduled',
  },
  reasoning: {
    reason:
      'No spec construct selects a reasoning mode; the model catalog records which models reason but the IR cannot require it.',
    phase: 'not scheduled',
  },
  'prompt-cache': {
    reason:
      'No spec construct requests prompt caching, and enabling it belongs with the caching layer rather than with code generation.',
    phase: 'L7',
  },
};

/**
 * One row per capability the IR can derive, so the derivation and the truthfulness
 * test read the same table instead of two hand-kept lists. Order is irrelevant:
 * `deriveRequiredCapabilities` returns vocabulary order.
 */
export const CAPABILITY_DERIVATIONS: ReadonlyArray<{
  readonly capability: RequiredCapability;
  readonly derivedBy: string;
  readonly applies: (ir: IR) => boolean;
}> = [
  {
    capability: 'http-trigger',
    derivedBy: 'a pipeline triggered by HTTP',
    applies: (ir) => ir.pipelines.some((pipeline) => pipeline.trigger.kind === 'http'),
  },
  {
    capability: 'json-schema',
    derivedBy: 'a prompt whose output is structured',
    applies: (ir) => ir.prompts.some((prompt) => prompt.output.kind !== 'text'),
  },
  {
    capability: 'tool-calling',
    derivedBy: 'a tool step in a pipeline',
    applies: (ir) =>
      ir.pipelines.some((pipeline) => pipeline.steps.some((step) => step.kind === 'tool')),
  },
  {
    capability: 'otel',
    derivedBy: 'tracing enabled on the IR or on a pipeline',
    // Tolerant of absent defaults: the normalize gate has to be able to report a missing
    // `observability` rather than crash on the way to reporting it.
    applies: (ir) =>
      ir.observability?.trace === true ||
      ir.pipelines.some((pipeline) => pipeline.observability?.trace === true),
  },
  {
    capability: 'embeddings',
    derivedBy: 'a retriever or an embedding model',
    applies: (ir) => ir.retrievers.length > 0 || ir.embeddings.length > 0,
  },
  {
    // Reranking is a separate requirement from embedding: a target can serve a
    // retriever while it cannot rerank, so `rerank` is derived only from a retriever
    // that actually declares a reranker.
    capability: 'rerank',
    derivedBy: 'a retriever that declares a reranker',
    applies: (ir) => ir.retrievers.some((retriever) => retriever.rerank !== undefined),
  },
  {
    capability: 'cursor-memory',
    derivedBy: 'a declared memory',
    applies: (ir) => ir.memory.length > 0,
  },
  {
    capability: 'agents',
    derivedBy: 'a declared agent',
    applies: (ir) => ir.agents.length > 0,
  },
  {
    capability: 'guardrails',
    derivedBy: 'a declared guardrail',
    applies: (ir) => ir.guardrails.length > 0,
  },
];

/**
 * The capabilities the IR itself needs, derived from what the IR actually uses -
 * never from what a model happens to support, since a capable model is not a
 * requirement. Returned in vocabulary order so the set is order-independent.
 */
export function deriveRequiredCapabilities(ir: IR): RequiredCapability[] {
  const derived = new Set<RequiredCapability>();
  for (const rule of CAPABILITY_DERIVATIONS) {
    if (rule.applies(ir)) derived.add(rule.capability);
  }
  return REQUIRED_CAPABILITIES.filter((capability) => derived.has(capability));
}
