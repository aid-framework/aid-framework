import type { GeneratorDiagnostic } from '../src/index.js';

export function codes(diagnostics: readonly GeneratorDiagnostic[]): string[] {
  return diagnostics.map((diagnostic) => diagnostic.code);
}

export function hasCode(diagnostics: readonly GeneratorDiagnostic[], code: string): boolean {
  return codes(diagnostics).includes(code);
}

export function errors(diagnostics: readonly GeneratorDiagnostic[]): GeneratorDiagnostic[] {
  return diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
}

export function messages(diagnostics: readonly GeneratorDiagnostic[]): string[] {
  return diagnostics.map((diagnostic) => diagnostic.message);
}

/**
 * `noUncheckedIndexedAccess` is on repo-wide, so array indexing yields `T | undefined`.
 * Tests that index a known-non-empty array use this instead of a non-null assertion.
 */
export function first<T>(items: readonly T[]): T {
  const value = items[0];
  if (value === undefined) throw new Error('expected at least one element');
  return value;
}
