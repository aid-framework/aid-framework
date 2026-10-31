/**
 * The build-time gates, run as one report.
 *
 * Error-severity diagnostics fail the build; warnings do not. Suppressed checks are
 * merged alongside the diagnostics so a caller can always see what was *not* enforced.
 *
 * The nine gates Phase 2 L1 adds are named by the id the plan's P5 table gives them,
 * because that id is what appears in mutation evidence and in a reviewer's search for
 * "which gate stopped this". A gate whose name drifts from the plan is a gate nobody
 * can find.
 */

import { hasErrors, sortDiagnostics } from '@aid-framework/spec';
import { deriveRequiredCapabilities } from '../capabilities.js';
import { phase0TargetCapabilities } from '../catalog/index.js';
import type { IrDiagnostic } from '../diagnostics.js';
import type { IR } from '../shapes.js';
import {
  agentsBudgetDegradeGate,
  agentsBudgetGate,
  agentsHandoffGate,
  agentsRefsGate,
} from './agents.js';
import { capabilityGate } from './capability.js';
import type { Gate, GateOptions, GateReporter, GateResult, SuppressedCheck } from './contract.js';
import { costGate } from './cost.js';
import { deployStreamingGate } from './deploy.js';
import { evalCoverageGate } from './eval-coverage.js';
import { guardrailCoverageGate, guardrailPolicyGate } from './guardrails.js';
import { hitlSideEffectGate } from './hitl.js';
import { memoryRefsGate } from './memory.js';
import { normalizeGate } from './normalize.js';
import { orchestrationDeepagentsGate } from './orchestration.js';
import { referentialGate } from './referential.js';
import { securityGate } from './security.js';

export const GATES = {
  referential: referentialGate,
  normalize: normalizeGate,
  capability: capabilityGate,
  cost: costGate,
  security: securityGate,
  'eval-coverage': evalCoverageGate,
  'agents/refs-resolve': agentsRefsGate,
  'agents/handoff-cycles': agentsHandoffGate,
  'agents/budgets': agentsBudgetGate,
  'agents/budget-degrade': agentsBudgetDegradeGate,
  'guardrails/coverage': guardrailCoverageGate,
  'guardrails/policies': guardrailPolicyGate,
  'hitl/side-effects': hitlSideEffectGate,
  'memory/refs': memoryRefsGate,
  'deploy/streaming': deployStreamingGate,
  'orchestration/deepagents': orchestrationDeepagentsGate,
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
  agentsBudgetDegradeGate,
  agentsBudgetGate,
  agentsHandoffGate,
  agentsRefsGate,
  capabilityGate,
  costGate,
  deployStreamingGate,
  evalCoverageGate,
  GATES as GATE_REGISTRY,
  guardrailCoverageGate,
  guardrailPolicyGate,
  hitlSideEffectGate,
  memoryRefsGate,
  normalizeGate,
  orchestrationDeepagentsGate,
  referentialGate,
  securityGate,
};
