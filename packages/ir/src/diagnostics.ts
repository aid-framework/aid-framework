/**
 * The IR layer's diagnostic codes and factories. Codes are namespaced `ir/<slug>`
 * and are part of the public contract, exactly like the spec layer's `spec/*`.
 */

import {
  type Diagnostic,
  type DiagnosticInit,
  errorDiagnostic,
  warningDiagnostic,
} from '@aid/spec';

/** Every diagnostic code this package emits. */
export const IR_DIAGNOSTIC_CODES = {
  typeUnresolved: 'ir/type-unresolved',
  typeCycle: 'ir/type-cycle',
  refUnresolved: 'ir/ref-unresolved',
  refKindMismatch: 'ir/ref-kind-mismatch',
  evalTargetInvalid: 'ir/eval-target-invalid',
  fallbackCycle: 'ir/fallback-cycle',
  metricToolUnresolved: 'ir/metric-tool-unresolved',
  promptVariableUndeclared: 'ir/prompt-variable-undeclared',
  promptVariableUnused: 'ir/prompt-variable-unused',
  promptInputMissing: 'ir/prompt-input-missing',
  bindingDuplicate: 'ir/binding-duplicate',
  bindingForwardReference: 'ir/binding-forward-reference',
  normalizationIncomplete: 'ir/normalization-incomplete',
  paramExceedsLimit: 'ir/param-exceeds-limit',
  providerUnsupported: 'ir/provider-unsupported',
  targetUnknown: 'ir/target-unknown',
  capabilityUnknown: 'ir/capability-unknown',
  capabilityMissing: 'ir/capability-missing',
  modelCapabilityMissing: 'ir/model-capability-missing',
  costProfileUnknown: 'ir/cost-profile-unknown',
  costBudgetExceeded: 'ir/cost-budget-exceeded',
  securityMissingAuth: 'ir/security-missing-auth',
  securityMissingConfirmation: 'ir/security-missing-confirmation',
  securityRedactionIncomplete: 'ir/security-redaction-incomplete',
  securityUnauthenticatedPath: 'ir/security-unauthenticated-path',
  evalUncovered: 'ir/eval-uncovered',
  gateFailed: 'ir/gate-failed',
  policyEmpty: 'ir/policy-empty',
  policySyntax: 'ir/policy-syntax',
  policyUnknownBuiltin: 'ir/policy-unknown-builtin',
  policyUnknownIdentifier: 'ir/policy-unknown-identifier',
  policyUnterminatedString: 'ir/policy-unterminated-string',
  policyUnclosedParen: 'ir/policy-unclosed-paren',
  policyTrailingToken: 'ir/policy-trailing-token',
  policyArity: 'ir/policy-arity',
  policyArgumentType: 'ir/policy-argument-type',
  policyExpected: 'ir/policy-expected',
} as const;

export type IrDiagnosticCode = (typeof IR_DIAGNOSTIC_CODES)[keyof typeof IR_DIAGNOSTIC_CODES];

/** The diagnostic carrier this layer emits: the shared shape, the IR's own codes. */
export type IrDiagnostic = Diagnostic<IrDiagnosticCode>;

/** `C` infers from the `code` field, so call sites need no explicit type argument. */
export function irError(init: DiagnosticInit<IrDiagnosticCode>): IrDiagnostic {
  return errorDiagnostic(init);
}

export function irWarning(init: DiagnosticInit<IrDiagnosticCode>): IrDiagnostic {
  return warningDiagnostic(init);
}

/**
 * The shared init carries only what a factory needs, so the source position a
 * policy error points at is attached to the finished diagnostic instead.
 */
export function withPosition(
  diagnostic: IrDiagnostic,
  position: { file?: string; line?: number; column?: number },
): IrDiagnostic {
  const located: IrDiagnostic = { ...diagnostic };
  if (position.file !== undefined) located.file = position.file;
  if (position.line !== undefined) located.line = position.line;
  if (position.column !== undefined) located.column = position.column;
  return located;
}

/** 1-based line/column of a 0-based offset, for position-bearing policy errors. */
export function offsetPosition(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < offset && index < source.length; index += 1) {
    if (source[index] === '\n') {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}
