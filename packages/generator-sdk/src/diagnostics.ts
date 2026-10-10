/**
 * Diagnostics for the generator layer. Reuses `@aid/spec`'s `Diagnostic` shape so the
 * parser, the IR gates, and this layer print one report, while this layer keeps its own
 * closed code union (`generator/*`) for typo checking. Codes are part of the public
 * contract; renaming one is a breaking change.
 *
 * `@aid/spec` locates a diagnostic by a path *inside* a document. This layer's failures
 * are mostly about a whole file — a drifted `generated/` file, an unplanned path — so the
 * helpers here take a flat string: either a repo-relative file path or a dotted location
 * such as `output.generatedDir`. It is passed through as a single path segment, which
 * renders identically and keeps this layer from inventing index arithmetic it does not have.
 */

import type { Diagnostic } from '@aid/spec';
import { errorDiagnostic, warningDiagnostic } from '@aid/spec';

export const GENERATOR_DIAGNOSTIC_CODES = {
  manifestNotAMapping: 'generator/manifest-not-a-mapping',
  manifestMissingField: 'generator/manifest-missing-field',
  manifestInvalidField: 'generator/manifest-invalid-field',
  manifestUnknownKey: 'generator/manifest-unknown-key',
  manifestCapabilityUnknown: 'generator/manifest-capability-unknown',
  manifestCapabilityDuplicate: 'generator/manifest-capability-duplicate',
  manifestEmitsAgainstUnknown: 'generator/manifest-emits-against-unknown',
  manifestUnsupportedIr: 'generator/manifest-unsupported-ir',
  manifestNotRelative: 'generator/manifest-not-relative',
  manifestEscapingRoot: 'generator/manifest-escaping-root',
  manifestDuplicateGenerator: 'generator/manifest-duplicate-generator',
  planNotAMapping: 'generator/plan-not-a-mapping',
  planInvalidPath: 'generator/plan-invalid-path',
  planDuplicatePath: 'generator/plan-duplicate-path',
  planOwnerMismatch: 'generator/plan-owner-mismatch',
  planEmpty: 'generator/plan-empty',
  manifestParseFailed: 'generator/manifest-parse-failed',
  manifestVersionUnsupported: 'generator/manifest-version-unsupported',
  determinismViolation: 'generator/determinism-violation',
  generatedDrift: 'generator/generated-drift',
} as const;

export type GeneratorDiagnosticCode =
  (typeof GENERATOR_DIAGNOSTIC_CODES)[keyof typeof GENERATOR_DIAGNOSTIC_CODES];

export type GeneratorDiagnostic = Diagnostic<GeneratorDiagnosticCode>;

export interface GeneratorDiagnosticInit {
  code: GeneratorDiagnosticCode;
  message: string;
  /** A repo-relative file path, or a dotted location such as `output.root`. */
  path?: string;
  hint?: string;
}

function toDiagnosticPath(path: string | undefined): readonly string[] {
  return path === undefined || path === '' ? [] : [path];
}

export function generatorError(init: GeneratorDiagnosticInit): GeneratorDiagnostic {
  return errorDiagnostic({
    code: init.code,
    message: init.message,
    path: toDiagnosticPath(init.path),
    ...(init.hint === undefined ? {} : { hint: init.hint }),
  });
}

export function generatorWarning(init: GeneratorDiagnosticInit): GeneratorDiagnostic {
  return warningDiagnostic({
    code: init.code,
    message: init.message,
    path: toDiagnosticPath(init.path),
    ...(init.hint === undefined ? {} : { hint: init.hint }),
  });
}

/** Binds the generated app's spec file into every diagnostic a generator emits. */
export function withFile(
  diagnostic: GeneratorDiagnostic,
  file: string | undefined,
): GeneratorDiagnostic {
  return file === undefined ? diagnostic : { ...diagnostic, file };
}
