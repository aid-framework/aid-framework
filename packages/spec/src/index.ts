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
  COMPOSITE_STEP_KINDS,
  DEFERRED_SECTIONS,
  DEFERRED_STEP_KINDS,
  MAX_STEP_DEPTH,
  MODEL_CACHE_MIN_VERSION,
  SECTION_MIN_VERSION,
  type SpecVersion,
  SUPPORTED_SECTIONS,
  SUPPORTED_SPEC_VERSIONS,
  SUPPORTED_STEP_KINDS,
  specJsonSchema,
  specVersionAtLeast,
  type ValidateOptions,
  validateSpec,
} from './validate.js';

import { type Diagnostic, hasErrors, sortDiagnostics } from './diagnostics.js';
import { type ParseOptions, parseSpecDocument } from './parse.js';
import { validateSpec } from './validate.js';

/**
 * The version `aid init` writes and the version every v0.1 fixture stays on. This
 * build also reads 0.2 and 0.3 (`SUPPORTED_SPEC_VERSIONS`); 0.1 documents are
 * byte-identical under all three.
 */
export const SPEC_VERSION = '0.1';

/** The newest version this build reads. Sections above this are rejected, not ignored. */
export const SPEC_VERSION_LATEST = '0.3';

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
