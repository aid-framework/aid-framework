/**
 * `@aid/spec` - the AID Framework specification language: the JSON Schema, a
 * position-aware YAML parser, and the local structural rules.
 *
 * It performs no cross-section validation - those are IR build-time gates. The
 * layering is `spec <- ir <- generator-sdk <- generators <- cli`.
 */

export {
  countBySeverity,
  DIAGNOSTIC_CODES,
  type Diagnostic,
  type DiagnosticCode,
  type DiagnosticInit,
  type DiagnosticPath,
  errorDiagnostic,
  formatDiagnostic,
  formatDiagnostics,
  formatPath,
  hasErrors,
  type PathSegment,
  SEVERITIES,
  type Severity,
  type SourcePosition,
  sortDiagnostics,
  warningDiagnostic,
} from './diagnostics.js';
export {
  findMalformedTemplate,
  type ParseOptions,
  type ParseResult,
  parseSpecDocument,
} from './parse.js';
export { SourceDocument } from './source-document.js';

export {
  DEFERRED_SECTIONS,
  DEFERRED_STEP_KINDS,
  SUPPORTED_SECTIONS,
  SUPPORTED_STEP_KINDS,
  specJsonSchema,
  type ValidateOptions,
  validateSpec,
} from './validate.js';

import { type Diagnostic, hasErrors, sortDiagnostics } from './diagnostics.js';
import { type ParseOptions, parseSpecDocument } from './parse.js';
import { validateSpec } from './validate.js';

/** The spec language version this package implements. */
export const SPEC_VERSION = '0.1';

export interface SpecCheckResult {
  /** True when no diagnostic has `error` severity. Warnings do not fail a check. */
  ok: boolean;
  /** The parsed value, or `undefined` when the YAML itself could not be parsed. */
  value: unknown;
  /** Sorted, positioned, ready to print. */
  diagnostics: Diagnostic[];
}

/**
 * Parses and validates spec source in one step - the entry point the CLI and the
 * test suite both use. Syntax errors short-circuit semantic validation on purpose.
 */
export function checkSpecText(text: string, options: ParseOptions = {}): SpecCheckResult {
  const parsed = parseSpecDocument(text, options);

  if (hasErrors(parsed.diagnostics)) {
    return {
      ok: false,
      value: parsed.value,
      diagnostics: sortDiagnostics(parsed.diagnostics),
    };
  }

  const diagnostics = sortDiagnostics([
    ...parsed.diagnostics,
    ...validateSpec(parsed.value, { document: parsed.document, file: options.file }),
  ]);

  return { ok: !hasErrors(diagnostics), value: parsed.value, diagnostics };
}
