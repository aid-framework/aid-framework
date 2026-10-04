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
}

export const CATALOG_VERSION: string = modelsCatalog.version;

const COST_PROFILES: Record<string, CostProfile> = modelsCatalog.costProfiles;
const MODELS: Record<string, CatalogModel> = modelsCatalog.models;

export function catalogCostProfiles(): Record<string, CostProfile> {
  return COST_PROFILES;
}

export function catalogModel(modelId: string): CatalogModel | undefined {
  return MODELS[modelId];
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
 */
export const PHASE_0_TARGET_CAPABILITIES: Record<string, readonly RequiredCapability[]> = {
  'py-fastapi': ['http-trigger', 'json-schema', 'otel', 'tool-calling'],
};

export function phase0TargetCapabilities(): TargetCapabilityDeclarations {
  return PHASE_0_TARGET_CAPABILITIES;
}
