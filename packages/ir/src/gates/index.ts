/**
 * The six build-time gates, run as one report.
 *
 * Error-severity diagnostics fail the build; warnings do not. Suppressed checks are
 * merged alongside the diagnostics so a caller can always see what was *not* enforced.
 */

import { hasErrors, sortDiagnostics } from '@aid/spec';
import { deriveRequiredCapabilities } from '../capabilities.js';
import { phase0TargetCapabilities } from '../catalog/index.js';
import type { IrDiagnostic } from '../diagnostics.js';
import type { IR } from '../shapes.js';
import { capabilityGate } from './capability.js';
import type { Gate, GateOptions, GateReporter, GateResult, SuppressedCheck } from './contract.js';
import { costGate } from './cost.js';
import { evalCoverageGate } from './eval-coverage.js';
import { normalizeGate } from './normalize.js';
import { referentialGate } from './referential.js';
import { securityGate } from './security.js';

export const GATES = {
  referential: referentialGate,
  normalize: normalizeGate,
  capability: capabilityGate,
  cost: costGate,
  security: securityGate,
  'eval-coverage': evalCoverageGate,
} as const satisfies Record<string, Gate>;

export type GateName = keyof typeof GATES;

export interface GateRunResult {
  /** False when any gate emitted an error-severity diagnostic. */
  ok: boolean;
  diagnostics: IrDiagnostic[];
  suppressed: SuppressedCheck[];
  byGate: Record<GateName, GateResult>;
}

/**
 * Runs every gate against the IR. The capability set the gates check is derived here
 * from the IR's own content, so the value a generator consumes is the value that was
 * checked rather than whatever the caller happened to pass in.
 */
export function runGates(ir: IR, options: Partial<GateOptions> = {}): GateRunResult {
  const checked: IR = { ...ir, requiredCapabilities: deriveRequiredCapabilities(ir) };
  const resolved: GateOptions = {
    targetCapabilities: options.targetCapabilities ?? phase0TargetCapabilities(),
    file: options.file,
  };

  const byGate = {} as Record<GateName, GateResult>;
  const diagnostics: IrDiagnostic[] = [];
  const suppressed: SuppressedCheck[] = [];

  for (const name of Object.keys(GATES) as GateName[]) {
    const result = GATES[name](checked, resolved);
    byGate[name] = result;
    diagnostics.push(...result.diagnostics);
    suppressed.push(...result.suppressed);
  }

  return {
    ok: !hasErrors(diagnostics),
    diagnostics: sortDiagnostics(diagnostics),
    suppressed,
    byGate,
  };
}

export { reporter } from './contract.js';
export type { EvalCostEstimate, ModelCostEstimate } from './cost.js';
export { estimateEvalCost } from './cost.js';
export { diffPaths, isNormalized, normalize } from './normalize.js';
export { policyAuthenticates } from './security.js';
export type { Gate, GateName as GateId, GateOptions, GateReporter, GateResult, SuppressedCheck };
export {
  capabilityGate,
  costGate,
  evalCoverageGate,
  GATES as GATE_REGISTRY,
  normalizeGate,
  referentialGate,
  securityGate,
};
