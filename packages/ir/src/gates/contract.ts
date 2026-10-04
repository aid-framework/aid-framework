/**
 * The contract every build-time gate honours.
 *
 * A gate returns diagnostics and never throws for a user-recoverable condition.
 * A check Phase 0 genuinely cannot enforce is reported in `suppressed` with a
 * stated reason, because a silently-skipped check is indistinguishable from a
 * passing one — that is how an unpublished rule becomes a false sense of safety.
 */

import type { DiagnosticInit } from '@aid/spec';
import type { TargetCapabilityDeclarations } from '../catalog/index.js';
import {
  type IrDiagnostic,
  type IrDiagnosticCode,
  irError,
  irWarning,
  withPosition,
} from '../diagnostics.js';
import type { IR } from '../shapes.js';

/** A check that is not enforceable yet, and why. Never silent. */
export interface SuppressedCheck {
  check: string;
  reason: string;
}

export interface GateResult {
  diagnostics: IrDiagnostic[];
  suppressed: SuppressedCheck[];
}

export interface GateOptions {
  /** Target capability declarations, injected so this layer never imports the SDK. */
  targetCapabilities: TargetCapabilityDeclarations;
  file?: string;
}

export type Gate = (ir: IR, options: GateOptions) => GateResult;

export interface GateReporter {
  error(init: DiagnosticInit<IrDiagnosticCode>): IrDiagnostic;
  warn(init: DiagnosticInit<IrDiagnosticCode>): IrDiagnostic;
}

/** Binds the source file into every diagnostic a gate emits. */
export function reporter(options: GateOptions): GateReporter {
  const file = options.file;
  return {
    error: (init) => withPosition(irError(init), { file }),
    warn: (init) => withPosition(irWarning(init), { file }),
  };
}

export const NO_SUPPRESSIONS: SuppressedCheck[] = [];
