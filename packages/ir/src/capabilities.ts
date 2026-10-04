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
 * The capabilities the IR itself needs, derived from what the IR actually uses -
 * never from what a model happens to support, since a capable model is not a
 * requirement. Returned in vocabulary order so the set is order-independent.
 */
export function deriveRequiredCapabilities(ir: IR): RequiredCapability[] {
  const derived = new Set<RequiredCapability>();
  if (ir.pipelines.some((pipeline) => pipeline.trigger.kind === 'http')) {
    derived.add('http-trigger');
  }
  if (ir.prompts.some((prompt) => prompt.output.kind !== 'text')) {
    derived.add('json-schema');
  }
  if (ir.pipelines.some((pipeline) => pipeline.steps.some((step) => step.kind === 'tool'))) {
    derived.add('tool-calling');
  }
  // Tolerant of absent defaults: the normalize gate has to be able to report a missing
  // `observability` rather than crash on the way to reporting it.
  const tracing =
    ir.observability?.trace === true ||
    ir.pipelines.some((pipeline) => pipeline.observability?.trace === true);
  if (tracing) {
    derived.add('otel');
  }
  if (ir.retrievers.length > 0 || ir.embeddings.length > 0) {
    derived.add('embeddings');
  }
  if (ir.memory.length > 0) {
    derived.add('cursor-memory');
  }
  return REQUIRED_CAPABILITIES.filter((capability) => derived.has(capability));
}
