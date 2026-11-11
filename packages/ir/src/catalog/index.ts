/**
 * The offline model catalog and the Phase 0 target capability declarations.
 * Lookups are deterministic and never touch the network, so a build is
 * reproducible on a machine with no egress.
 */

import type { RequiredCapability } from '../capabilities.js';
import type { CostProfile, ModelLimits } from '../shapes.js';
import modelsCatalog from './models.json' with { type: 'json' };

export interface CatalogModel {
  provider: string;
  limits?: ModelLimits;
  /** Candidate `costProfiles` keys, most specific first. */
  costProfiles?: string[];
  /** Vector width, for an embedding model. The normalization gate reads it. */
  dimensions?: number;
}

export const CATALOG_VERSION: string = modelsCatalog.version;

const COST_PROFILES: Record<string, CostProfile> = modelsCatalog.costProfiles;
const MODELS: Record<string, CatalogModel> = modelsCatalog.models;
const KNOWLEDGE_BASES: Record<string, CatalogKnowledgeBaseCost> = modelsCatalog.knowledgeBases;

export function catalogCostProfiles(): Record<string, CostProfile> {
  return COST_PROFILES;
}

export function catalogModel(modelId: string): CatalogModel | undefined {
  return MODELS[modelId];
}

/** A managed knowledge base's per-query price. A null rate means unverified, not free. */
export interface CatalogKnowledgeBaseCost {
  retrievePerQueryUsd: number | null;
  note?: string;
}

export function catalogKnowledgeBaseCost(engine: string): CatalogKnowledgeBaseCost | undefined {
  return KNOWLEDGE_BASES[engine];
}

/**
 * Resolves a cost profile by explicit catalog key, else by the model's first
 * candidate key. Returns `undefined` when the model is unpriced — the cost gate
 * distinguishes unknown-differs-from-free.
 */
export function catalogCostProfile(
  modelId: string,
  costProfileId?: string,
): { id: string; profile: CostProfile } | undefined {
  if (costProfileId !== undefined) {
    const profile = COST_PROFILES[costProfileId];
    return profile === undefined ? undefined : { id: costProfileId, profile };
  }
  const model = MODELS[modelId];
  const candidate = model?.costProfiles?.[0];
  if (candidate === undefined) return undefined;
  const profile = COST_PROFILES[candidate];
  return profile === undefined ? undefined : { id: candidate, profile };
}

/** Target capability declarations, keyed by target id. */
export type TargetCapabilityDeclarations = Record<string, readonly string[]>;

/**
 * The Phase 0 reference declaration. Layer 3 replaces this with real generator
 * declarations; nothing else about the capability gate changes.
 *
 * `metrics` belongs here because the gate that refuses an alarm over an unrecorded series
 * reads this list when no real declaration is injected: without it the reference target
 * would look like it records nothing, and every document with alarms would be refused.
 */
export const PHASE_0_TARGET_CAPABILITIES: Record<string, readonly RequiredCapability[]> = {
  'py-fastapi': ['http-trigger', 'json-schema', 'metrics', 'otel', 'tool-calling'],
};

export function phase0TargetCapabilities(): TargetCapabilityDeclarations {
  return PHASE_0_TARGET_CAPABILITIES;
}
